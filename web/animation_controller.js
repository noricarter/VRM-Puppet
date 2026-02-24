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

import * as THREE from "three";
import { VRMHumanBoneName } from "@pixiv/three-vrm";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

const IDLE_LOOP_BASE = "../assets/animations/idle/loop/";
const IDLE_ONESHOT_BASE = "../assets/animations/idle/oneshot/";

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

  // Blending State
  let priorClip = null;
  let priorClipTime = 0;
  let transitionTime = 0;
  let transitionDuration = 0.5; // Default fade time

  // --- Core Update Loop ---
  function update(dt) {
    if (!enabled) return;

    const vrm = getVRM?.();
    if (!vrm || !vrm.humanoid) return;

    const hum = vrm.humanoid;
    requiresVrmUpdate = true;

    // --- RESET BASELINE ---
    // Critical Fix: We must reset all humanoid bones to their baseline orientation
    // so that additive layers (drift, manual) in the main loop don't accumulate and spin.
    // In three-vrm 2.x, the normalized bones have Identity at the T-Pose.
    for (const boneName of Object.values(VRMHumanBoneName)) {
      const node = hum.getNormalizedBoneNode(boneName);
      if (node) node.quaternion.identity();
    }

    if (!activeClip) return;

    // Advance Time
    clipTime += dt;
    if (clipTime > activeClip.duration) {
      if (isLooping) {
        clipTime %= activeClip.duration;
      } else {
        clipTime = activeClip.duration;
        // Animation finished and not looping.
        // If we were in manual mode, auto-revert to random idle.
        if (idleMode === "manual") {
          console.log("[AnimController] One-shot finished, reverting to random idle.");
          startRandomIdle();
        }
      }
    }

    // --- BLENDING LOGIC ---
    let blendAlpha = 1.0;
    if (transitionTime < transitionDuration) {
      transitionTime += dt;
      blendAlpha = transitionTime / transitionDuration;
      if (blendAlpha > 1.0) blendAlpha = 1.0;
    } else {
      priorClip = null; // Fade complete
    }

    // Capture Active Pose
    const activePose = sampleClip(activeClip, clipTime, hum);

    // Capture Prior Pose (if blending)
    let priorPose = null;
    if (priorClip) {
      priorClipTime += dt;
      // Loop prior clip if needed? Usually for crossfade we just continue play
      if (isLooping) priorClipTime %= priorClip.duration;
      else priorClipTime = Math.min(priorClipTime, priorClip.duration);

      priorPose = sampleClip(priorClip, priorClipTime, hum);
    }

    // Apply (Blend)
    applyPose(activePose, priorPose, blendAlpha, hum);
  }

  function sampleClip(clip, time, hum) {
    const pose = { rot: {}, pos: {} };

    for (const [boneName, track] of Object.entries(clip.tracks)) {
      const { times, values, type } = track;

      let i = 0;
      while (i < times.length - 1 && times[i + 1] < time) {
        i++;
      }

      const t0 = times[i];
      const t1 = times[i + 1] ?? t0;
      const alpha = (t1 === t0) ? 0 : (time - t0) / (t1 - t0);
      const stride = (type === 'pos') ? 3 : 4;
      const idx0 = i * stride;
      const idx1 = (i + 1) * stride;

      if (type === 'rot') { // Quaternion
        const q0 = new THREE.Quaternion().fromArray(values, idx0);
        if (t1 !== t0) {
          const q1 = new THREE.Quaternion().fromArray(values, idx1);
          q0.slerp(q1, alpha);
        }

        // Retarget Logic
        const { qGlobalRest, invLocalRest } = track;
        if (qGlobalRest && invLocalRest) {
          const qLocalDelta = invLocalRest.clone().multiply(q0);
          const qCharacterMotion = qGlobalRest.clone()
            .multiply(qLocalDelta)
            .multiply(qGlobalRest.clone().invert());
          pose.rot[boneName] = qCharacterMotion;
        } else {
          pose.rot[boneName] = q0;
        }

      } else if (type === 'pos' && boneName === 'hips') { // Position (Hips only)
        const v0 = new THREE.Vector3().fromArray(values, idx0);
        if (t1 !== t0) {
          const v1 = new THREE.Vector3().fromArray(values, idx1);
          v0.lerp(v1, alpha);
        }
        const posScale = clip.sourceScale || 1.0;
        v0.multiplyScalar(posScale);
        pose.pos[boneName] = v0;
      }
    }
    return pose;
  }

  function applyPose(active, prior, alpha, hum) {
    // Loop through all active bones
    for (const [boneName, qTarget] of Object.entries(active.rot)) {
      const node = hum.getNormalizedBoneNode(boneName);
      if (!node) continue;

      if (prior && prior.rot[boneName] && alpha < 1.0) {
        // Blend
        const qPrior = prior.rot[boneName];
        node.quaternion.copy(qPrior).slerp(qTarget, alpha);
      } else {
        node.quaternion.copy(qTarget);
      }
    }

    // Hips position
    if (active.pos['hips']) {
      const node = hum.getNormalizedBoneNode('hips');
      if (node) {
        const vTarget = active.pos['hips'];
        if (prior && prior.pos['hips'] && alpha < 1.0) {
          const vPrior = prior.pos['hips'];
          node.position.copy(vPrior).lerp(vTarget, alpha);
        } else {
          node.position.copy(vTarget);
        }
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

  async function playUrl(url, { loop = true, fadeIn = 0.5 } = {}) {
    if (!enabled) return { ok: false };

    url = coerceGlbUrl(url);
    const currentVrm = getVRM?.();

    try {
      const nextClip = await loadAndParseClip(url, currentVrm);

      // Setup Crossfade
      if (activeClip) {
        priorClip = activeClip;
        priorClipTime = clipTime;
        transitionTime = 0;
        transitionDuration = fadeIn;
      } else {
        priorClip = null;
      }

      activeClip = nextClip;
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
    if (!idleLoopUrls.length) {
      console.warn("No idle loops available for random mode.");
      return;
    }

    // Initial random start
    await playUrl(pick(idleLoopUrls), { loop: true, fadeIn: 1.0 });

    while (enabled && idleMode === "random" && token === randomTaskToken) {
      // Wait for a random duration
      const duration = (Math.random() * (loopSwitchMaxSec - loopSwitchMinSec)) + loopSwitchMinSec;
      await sleep(duration * 1000);

      if (!enabled || idleMode !== "random" || token !== randomTaskToken) break;

      // Switch to a new random loop (different from current if possible)
      // For now just pick random
      const nextUrl = pick(idleLoopUrls);
      console.log(`[AnimController] Switching idle loop: ${nextUrl}`);
      // Crossfade to new loop
      await playUrl(nextUrl, { loop: true, fadeIn: 1.5 });
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
    getEnabled: () => enabled,
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