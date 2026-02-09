// animation_controller.js
//
// Hybrid Animation Driver for VRM.
// Supports:
// 1. Normalized Retargeting (Mixamo/Generic)
// 2. Native Retargeting (J_Bip)
//
// RELATIVE ROTATION MODE (BIND POSE FIX):
// To fix "Pretzel" without "T-Posed Idle", we use the GLTF Scene's Rest Pose
// as the "Zero" reference, rather than Frame 0 of the animation.
//
// Logic:
// Q_rest = Node.quaternion (from GLTF Scene Graph)
// Q_anim = Track.value
// Q_delta = Inv(Q_rest) * Q_anim
// Target = Q_delta
//

import * as THREE from "https://esm.sh/three@0.152.2";
import { GLTFLoader } from "https://esm.sh/three@0.152.2/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "https://esm.sh/three@0.152.2/examples/jsm/loaders/FBXLoader.js";

const IDLE_LOOP_BASE = "./animations/idle/loop/";
const IDLE_ONESHOT_BASE = "./animations/idle/oneshot/";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- URL helpers ----------

function coerceGlbUrl(url) {
  if (!url) return url;
  const raw = String(url);
  // Allow .fbx to pass through
  if (raw.toLowerCase().endsWith(".fbx")) return raw;
  if (looksLikeUrlOrPath(raw)) return raw.toLowerCase().endsWith(".glb") ? raw : raw + ".glb";
  return ensureTrailingSlash(IDLE_LOOP_BASE) + (raw.toLowerCase().endsWith(".glb") ? raw : raw + ".glb");
}

function ensureTrailingSlash(p) {
  return p.endsWith("/") ? p : (p + "/");
}

function looksLikeUrlOrPath(s) {
  return typeof s === "string" && (s.includes("/") || s.startsWith("http://") || s.startsWith("https://") || s.startsWith("./") || s.startsWith("../"));
}

function resolveIdleUrl(baseDir, nameOrUrl) {
  if (!nameOrUrl) return null;
  const raw = String(nameOrUrl);
  // Allow .fbx to pass through
  if (raw.toLowerCase().endsWith(".fbx")) return looksLikeUrlOrPath(raw) ? raw : ensureTrailingSlash(baseDir) + raw;
  if (looksLikeUrlOrPath(raw)) return raw.toLowerCase().endsWith(".glb") ? raw : (raw + ".glb");
  const base = ensureTrailingSlash(baseDir);
  const withExt = raw.toLowerCase().endsWith(".glb") ? raw : (raw + ".glb");
  return base + withExt;
}

// ---------- Manual Driver Implementation ----------

export function createAnimationController({ getTargetObject, resetPose, getVRM }) {
  const gltfLoader = new GLTFLoader();
  const fbxLoader = new FBXLoader();

  // State
  let enabled = false;
  let activeClip = null;
  let clipTime = 0;
  let isLooping = true;
  let requiresVrmUpdate = true;

  const clipCache = new Map();

  let idleMode = "off";
  let idleLoopUrls = [];
  let idleOneShotUrls = [];
  let randomTaskToken = 0;

  // --- Core Update Loop ---
  function update(dt) {
    if (!enabled || !activeClip) return;

    const vrm = getVRM?.();
    if (!vrm || !vrm.humanoid) return;

    // Advance Time
    clipTime += dt;
    if (clipTime > activeClip.duration) {
      if (isLooping) {
        clipTime %= activeClip.duration;
      } else {
        clipTime = activeClip.duration;
      }
    }

    const hum = vrm.humanoid;
    requiresVrmUpdate = true;


    for (const [boneName, track] of Object.entries(activeClip.tracks)) {
      const node = hum.getNormalizedBoneNode(boneName);
      if (!node) continue;

      // Sample Track
      const { times, values, type, baseWithInv } = track;

      let i = 0;
      while (i < times.length - 1 && times[i + 1] < clipTime) {
        i++;
      }

      const t0 = times[i];
      const t1 = times[i + 1] ?? t0;
      const alpha = (t1 === t0) ? 0 : (clipTime - t0) / (t1 - t0);

      const stride = (type === 'pos') ? 3 : 4;
      const idx0 = i * stride;
      const idx1 = (i + 1) * stride;

      if (type === 'rot') {
        const qAnim = new THREE.Quaternion(values[idx0], values[idx0 + 1], values[idx0 + 2], values[idx0 + 3]);
        if (t1 !== t0) {
          const qNext = new THREE.Quaternion(values[idx1], values[idx1 + 1], values[idx1 + 2], values[idx1 + 3]);
          qAnim.slerp(qNext, alpha);
        }

        // --- RESURRECTION VII: BIND-POSE SYNTHESIS ---
        // Maps Local Motion Delta (relative to the Rig's PHYSICAL T-POSE) into Character Space.
        // Result = GlobalRest * (Inv(LocalBind) * LocalAnim) * Inv(GlobalRest)

        const { qGlobalRest, invLocalRest } = track;

        if (qGlobalRest && invLocalRest) {
          // 1. Calculate the Delta from the original Bind Pose (T-Pose) to the current Animation Frame.
          // This ensures that "Arms Down" in the animation results in "Arms Down" in the puppet.
          const qLocalDelta = invLocalRest.clone().multiply(qAnim);

          // 2. Conjugate by the physical Global Rest Basis to align the axes.
          const qCharacterMotion = qGlobalRest.clone()
            .multiply(qLocalDelta)
            .multiply(qGlobalRest.clone().invert());

          // 3. Apply to VRM Normalized Bone (World-Aligned)
          node.quaternion.copy(qCharacterMotion);
        } else {
          node.quaternion.copy(qAnim);
        }
      } else if (type === 'pos' && boneName === 'hips') {
        const vCurrent = new THREE.Vector3(values[idx0], values[idx0 + 1], values[idx0 + 2]);
        if (t1 !== t0) {
          const vNext = new THREE.Vector3(values[idx1], values[idx1 + 1], values[idx1 + 2]);
          vCurrent.lerp(vNext, alpha);
        }

        const posScale = activeClip.sourceScale || 1.0;
        node.position.copy(vCurrent).multiplyScalar(posScale);
      }
    }
  }

  // --- Loading & Parsing ---
  async function loadAndParseClip(url, vrm) {
    if (clipCache.has(url)) return clipCache.get(url);

    let rawClip = null;
    let modelRoot = null;

    try {
      if (typeof url === 'string' && url.toLowerCase().endsWith(".fbx")) {
        const fbx = await fbxLoader.loadAsync(url);
        rawClip = fbx.animations?.[0];
        modelRoot = fbx;
      } else {
        const gltf = await gltfLoader.loadAsync(url);
        rawClip = gltf.animations?.[0];
        modelRoot = gltf.scene;
      }
    } catch (e) {
      throw new Error(`Failed to load animation ${url}: ${e}`);
    }

    if (!rawClip) throw new Error(`No animation in ${url}`);

    // Extract Rest Poses from GLTF Scene Graph
    // Map<Index | Name, Quaternion>
    // Since tracks refer to nodes by Name (usually), let's map Name -> RestQuat
    const restPoses = new Map();
    const fbxNodes = new Map(); // Store full node objects for Math Retargeting

    if (modelRoot) {
      modelRoot.traverse((node) => {
        if (node.isBone || node.type === 'Bone' || node.isObject3D) {
          restPoses.set(node.name, node.quaternion.clone());
          fbxNodes.set(node.name, node);
        }
      });
    }

    // Bone Map
    const boneMap = {
      // Body
      "hips": "hips", "j_bip_c_hips": "hips",
      "spine": "spine", "j_bip_c_spine": "spine",
      "spine1": "chest", "j_bip_c_chest": "chest",
      "spine2": "upperChest", "j_bip_c_upperchest": "upperChest",
      "neck": "neck", "j_bip_c_neck": "neck",
      "head": "head", "j_bip_c_head": "head",
      "lefteye": "leftEye", "j_bip_l_eye": "leftEye",
      "righteye": "rightEye", "j_bip_r_eye": "rightEye",

      // Legs
      "leftupleg": "leftUpperLeg", "j_bip_l_upperleg": "leftUpperLeg",
      "leftleg": "leftLowerLeg", "j_bip_l_lowerleg": "leftLowerLeg",
      "leftfoot": "leftFoot", "j_bip_l_foot": "leftFoot",
      "lefttoebase": "leftToes", "j_bip_l_toebase": "leftToes",

      "rightupleg": "rightUpperLeg", "j_bip_r_upperleg": "rightUpperLeg",
      "rightleg": "rightLowerLeg", "j_bip_r_lowerleg": "rightLowerLeg",
      "rightfoot": "rightFoot", "j_bip_r_foot": "rightFoot",
      "righttoebase": "rightToes", "j_bip_r_toebase": "rightToes",

      // Arms
      "leftshoulder": "leftShoulder", "j_bip_l_shoulder": "leftShoulder",
      "leftarm": "leftUpperArm", "j_bip_l_upperarm": "leftUpperArm",
      "leftforearm": "leftLowerArm", "j_bip_l_lowerarm": "leftLowerArm",
      "lefthand": "leftHand", "j_bip_l_hand": "leftHand",

      "rightshoulder": "rightShoulder", "j_bip_r_shoulder": "rightShoulder",
      "rightarm": "rightUpperArm", "j_bip_r_upperarm": "rightUpperArm",
      "rightforearm": "rightLowerArm", "j_bip_r_lowerarm": "rightLowerArm",
      "righthand": "rightHand", "j_bip_r_hand": "rightHand",

      // Fingers
      "lefthandthumb1": "leftThumbProximal", "j_bip_l_thumb1": "leftThumbProximal",
      "lefthandthumb2": "leftThumbIntermediate", "j_bip_l_thumb2": "leftThumbIntermediate",
      "lefthandthumb3": "leftThumbDistal", "j_bip_l_thumb3": "leftThumbDistal",
      "lefthandindex1": "leftIndexProximal", "j_bip_l_index1": "leftIndexProximal",
      "lefthandindex2": "leftIndexIntermediate", "j_bip_l_index2": "leftIndexIntermediate",
      "lefthandindex3": "leftIndexDistal", "j_bip_l_index3": "leftIndexDistal",
      "lefthandmiddle1": "leftMiddleProximal", "j_bip_l_middle1": "leftMiddleProximal",
      "lefthandmiddle2": "leftMiddleIntermediate", "j_bip_l_middle2": "leftMiddleIntermediate",
      "lefthandmiddle3": "leftMiddleDistal", "j_bip_l_middle3": "leftMiddleDistal",
      "lefthandring1": "leftRingProximal", "j_bip_l_ring1": "leftRingProximal",
      "lefthandring2": "leftRingIntermediate", "j_bip_l_ring2": "leftRingIntermediate",
      "lefthandring3": "leftRingDistal", "j_bip_l_ring3": "leftRingDistal",
      "lefthandpinky1": "leftLittleProximal", "j_bip_l_little1": "leftLittleProximal",
      "lefthandpinky2": "leftLittleIntermediate", "j_bip_l_little2": "leftLittleIntermediate",
      "lefthandpinky3": "leftLittleDistal", "j_bip_l_little3": "leftLittleDistal",

      "righthandthumb1": "rightThumbProximal", "j_bip_r_thumb1": "rightThumbProximal",
      "righthandthumb2": "rightThumbIntermediate", "j_bip_r_thumb2": "rightThumbIntermediate",
      "righthandthumb3": "rightThumbDistal", "j_bip_r_thumb3": "rightThumbDistal",
      "righthandindex1": "rightIndexProximal", "j_bip_r_index1": "rightIndexProximal",
      "righthandindex2": "rightIndexIntermediate", "j_bip_r_index2": "rightIndexIntermediate",
      "righthandindex3": "rightIndexDistal", "j_bip_r_index3": "rightIndexDistal",
      "righthandmiddle1": "rightMiddleProximal", "j_bip_r_middle1": "rightMiddleProximal",
      "righthandmiddle2": "rightMiddleIntermediate", "j_bip_r_middle2": "rightMiddleIntermediate",
      "righthandmiddle3": "rightMiddleDistal", "j_bip_r_middle3": "rightMiddleDistal",
      "righthandring1": "rightRingProximal", "j_bip_r_ring1": "rightRingProximal",
      "righthandring2": "rightRingIntermediate", "j_bip_r_ring2": "rightRingIntermediate",
      "righthandring3": "rightRingDistal", "j_bip_r_ring3": "rightRingDistal",
      "righthandpinky1": "rightLittleProximal", "j_bip_r_little1": "rightLittleProximal",
      "righthandpinky2": "rightLittleIntermediate", "j_bip_r_little2": "rightLittleIntermediate",
      "righthandpinky3": "rightLittleDistal",
    };

    // SYSTEMATIC RETARGETING RULES
    // Maps standard Mixamo Twist/Rotation axes to VRM Swing/Lift axes.
    // srcIndex: 0=x, 1=y, 2=z
    // sign: Multiplier for value
    // targetAxis: Implicitly Z (for now, as logic assumes Z-swing for arms)
    const MIXAMO_VRM_RETARGET_MAP = {
      "leftUpperArm": { srcIndex: 0, sign: -1 }, // X -> -Z (Down)
      "rightUpperArm": { srcIndex: 0, sign: 1 }, // X -> +Z (Down? Based on Step 1209 Success)
    };

    // Auto-detect isMixamo (for scale)
    let isMixamo = false;
    if (typeof url === 'string' && url.toLowerCase().endsWith(".fbx")) isMixamo = true;
    rawClip.tracks.forEach(t => {
      if (t.name.toLowerCase().includes("mixamo")) isMixamo = true;
    });

    const sourceScale = isMixamo ? 0.01 : 1.0;

    const parsed = {
      duration: rawClip.duration,
      type: 'relative',
      sourceScale: sourceScale,
      tracks: {}
    };

    rawClip.tracks.forEach(t => {
      if (t.name.endsWith(".scale")) return;

      const dotIndex = t.name.lastIndexOf(".");
      let rawNodeName = t.name.substring(0, dotIndex).replace(/^.*[|\/]/, "");
      const cleanName = rawNodeName.replace("mixamorig:", "").replace("mixamorig", "").toLowerCase();
      const prop = t.name.substring(dotIndex);

      const vrmName = boneMap[cleanName];
      if (vrmName) {
        if (prop === ".position" && vrmName !== "hips") return;

        // --- EXTRACT PHYSICAL BIND POSE BASIS ---
        let invLocalRest = null;
        let qGlobalRest = null;

        if (prop === ".quaternion") {
          const fbxNode = fbxNodes.get(rawNodeName);
          if (fbxNode) {
            // Local Rest: The skeleton's physical bind orientation (NOT first frame of anim)
            const qLocalBind = fbxNode.quaternion.clone();
            invLocalRest = qLocalBind.invert();

            // Global Rest: Accumulate hierarchy to get world-aligned orientation in FBX scene
            qGlobalRest = new THREE.Quaternion();
            let curr = fbxNode;
            while (curr) {
              qGlobalRest.premultiply(curr.quaternion);
              curr = curr.parent;
              if (!curr || curr.type === 'Scene' || curr === rawClip) break;
            }
          }
        }

        parsed.tracks[vrmName] = {
          times: t.times,
          values: t.values,
          type: prop === ".position" ? 'pos' : 'rot',
          invLocalRest: invLocalRest,
          qGlobalRest: qGlobalRest
        };
      }
    });

    console.log(`[AnimController] Parsed ${url}. Tracks: ${Object.keys(parsed.tracks).length}. Mode=GLOBAL-REST`);
    clipCache.set(url, parsed);
    return parsed;
  }

  // --- Control API ---

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) {
      activeClip = null;
      requiresVrmUpdate = true;
      resetPose?.();
      idleMode = "off";
      randomTaskToken++;
    }
  }

  async function playUrl(url, { loop = true, fadeIn = 0.2, fadeOut = 0.2 } = {}) {
    if (!enabled) return { ok: false };

    url = coerceGlbUrl(url);
    const currentVrm = getVRM?.();

    try {
      const clip = await loadAndParseClip(url, currentVrm);
      activeClip = clip;
      clipTime = 0;
      isLooping = loop;
      requiresVrmUpdate = true;
      return { ok: true };
    } catch (e) {
      console.error("Play failed", e);
      return { ok: false, error: e };
    }
  }

  function stop({ toTPose = false } = {}) {
    activeClip = null;
    requiresVrmUpdate = true;
    if (toTPose) resetPose?.();
  }

  function getRequiresVrmUpdate() {
    return requiresVrmUpdate;
  }

  function setIdleAnimationPools(loops, oneShots) {
    idleLoopUrls = loops.map(u => resolveIdleUrl(IDLE_LOOP_BASE, u));
    idleOneShotUrls = oneShots.map(u => resolveIdleUrl(IDLE_ONESHOT_BASE, u));
  }

  async function startRandomIdle(options = {}) {
    const { loopSwitchMinSec = 10, loopSwitchMaxSec = 20, oneShotChance = 0.3 } = options;
    idleMode = "random";
    const token = ++randomTaskToken;
    if (!idleLoopUrls.length) return;

    await playUrl(pick(idleLoopUrls), { loop: true });

    while (enabled && idleMode === "random" && token === randomTaskToken) {
      await sleep(2000);
    }
  }

  async function playManualIdle(url, opts) {
    idleMode = "manual";
    randomTaskToken++;
    await playUrl(url, opts);
  }

  return {
    update,
    setEnabled,
    playUrl,
    stop,
    getRequiresVrmUpdate,
    setIdleAnimationPools,
    startRandomIdle,
    playManualIdle
  };
}

function pick(arr) {
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}