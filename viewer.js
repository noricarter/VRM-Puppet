// viewer.js (Layered Control Update - Fix)
import * as THREE from "https://esm.sh/three@0.152.2";
import { GLTFLoader } from "https://esm.sh/three@0.152.2/examples/jsm/loaders/GLTFLoader.js";
import { VRMHumanBoneName, VRMLoaderPlugin } from "https://esm.sh/@pixiv/three-vrm@2.0.7?deps=three@0.152.2";
import { createAnimationController } from "./animation_controller.js";

let renderer, scene, camera;
let clock;
let currentVrm = null;

let neckNode = null;
let neckRestQuat = null; // Still good for reset

let viewportEl = null;

// Root container so we can move character independently of centering offsets
let characterRoot = null;

// Animation playback controller (idle animations, etc.)
let animController = null;

// --- Manual Control State ---
const manualNeckQuat = new THREE.Quaternion(); // Identity by default

// LookAt Target must be an Object3D in the scene for correct world transforms
const lookAtTargetObj = new THREE.Object3D();
lookAtTargetObj.name = "LookAtTarget";
// Default position (Forward +Z relative to origin)
lookAtTargetObj.position.set(0, 1.5, 2.0);

// Debug hooks (safe)
window.__VRM = window.__VRM || {};
window.__VRM.getScene = () => scene;
window.__VRM.getCharacterRoot = () => characterRoot;
window.__VRM.getVrm = () => currentVrm;
window.__VRM.getAnim = () => animController;
window.__VRM.getLookAtTarget = () => lookAtTargetObj;

// Count skinned meshes in the scene
window.__VRM.countSkins = () => {
  let skinned = 0;
  scene.traverse(o => { if (o.isSkinnedMesh) skinned++; });
  console.log("SkinnedMesh count:", skinned);
  return skinned;
};

function forceResize() {
  const rect = viewportEl.getBoundingClientRect();
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

function ensureInit(viewportId = "viewport") {
  if (renderer) return;

  viewportEl = document.getElementById(viewportId);
  if (!viewportEl) throw new Error(`#${viewportId} not found`);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1523);

  // Add LookAt Target to scene so its world matrix updates automatically
  scene.add(lookAtTargetObj);

  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
  camera.position.set(0, 1.4, 2.2);
  camera.lookAt(0, 1.35, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const canvas = renderer.domElement;
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  viewportEl.prepend(canvas);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(2, 4, 2);
  scene.add(dir);

  clock = new THREE.Clock();

  // Animation controller targets the currentVrm.scene when present.
  animController = createAnimationController({
    getTargetObject: () => currentVrm?.scene ?? null,
    resetPose,
    getVRM: () => currentVrm
  });

  window.addEventListener("resize", () => forceResize());
  forceResize();
  setTimeout(forceResize, 0);

  const tick = () => {
    requestAnimationFrame(tick);
    const dt = clock.getDelta();

    // 1. BASE LAYER: Animation Controller
    // This writes the "Animation Pose" to the bones.
    animController?.update(dt);

    // 2. MANUAL LAYER: Additive offsets
    // We apply this *on top* of the animation pose.
    if (currentVrm && currentVrm.humanoid) {
      const neck = currentVrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Neck);
      if (neck) {
        // Multiply applies local rotation.
        // Result = AnimRot * ManualRot
        neck.quaternion.multiply(manualNeckQuat);
      }

      // 3. GAZE LAYER:
      // We ensure the target object is assigned (done in loadVRMFromUrl)
      // Its position is updated by setGaze()
    }

    // 4. SOLVER LAYER: VRM Update
    // HYBRID MODE Logic from Animation Controller
    const needsSolver = animController?.getRequiresVrmUpdate?.() ?? true;

    if (currentVrm) {
      if (needsSolver) {
        currentVrm.update(dt);
        // Ensure Gaze target is respected if update() handles it
        // (VRM lookAt usually reads .target inside update)
      } else {
        // Manual subsystem update (Physics + LookAt)
        // because vrm.update() is skipped
        currentVrm.springBoneManager?.update(dt);
        currentVrm.lookAt?.update(dt);
      }
    }

    renderer.render(scene, camera);
  };

  tick();
}

function frameAndCenterModel(modelScene) {
  const box = new THREE.Box3().setFromObject(modelScene);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  // Center inside its parent root
  modelScene.position.sub(center);
  modelScene.position.y += size.y * 0.5;

  // Camera fit
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const fitDist = (maxDim / (2 * Math.tan(fov / 2))) * 1.2;

  camera.position.set(0, size.y * 0.9, fitDist);
  camera.lookAt(0, size.y * 0.75, 0);
  forceResize();

  return { size };
}

/* ---------------------------
   DIAGNOSTIC DUMP FUNCTIONS
---------------------------- */

function dumpVRMExpressions(vrm = currentVrm) {
  if (!vrm?.expressionManager) {
    console.warn("No vrm.expressionManager found.");
    return { presetKeys: [], allKeys: [], notes: "No expressionManager" };
  }

  const em = vrm.expressionManager;

  // The most reliable: enumerate keys that actually resolve via getExpression
  const presetCandidates = [
    "neutral", "happy", "angry", "sad", "surprised", "relaxed",
    "blink", "blinkLeft", "blinkRight",
    "aa", "ih", "ou", "ee", "oh",
    "lookUp", "lookDown", "lookLeft", "lookRight"
  ];

  const presentPresets = [];
  for (const k of presetCandidates) {
    try {
      if (em.getExpression?.(k)) presentPresets.push(k);
    } catch { }
  }

  // Try to enumerate all expressions if the structure supports it
  let allKeys = [];
  try {
    // Many builds expose expressionMap / presetExpressionMap
    if (em.expressionMap) allKeys = Object.keys(em.expressionMap);
    else if (em._expressionMap) allKeys = Object.keys(em._expressionMap);
  } catch { }

  allKeys = Array.from(new Set([...allKeys, ...presentPresets])).sort();

  const result = { presetKeys: presentPresets.sort(), allKeys };
  console.log("VRM Expression dump:", result);
  return result;
}

function dumpMorphTargets(vrm = currentVrm) {
  if (!vrm?.scene) {
    console.warn("No vrm.scene found.");
    return { meshCount: 0, targets: {}, notes: "No vrm.scene" };
  }

  const targetsByMesh = {};
  let meshCount = 0;

  vrm.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    meshCount++;

    const dict = obj.morphTargetDictionary;
    if (!dict) return;

    // dict: name -> index
    const names = Object.keys(dict).sort();
    if (names.length) {
      targetsByMesh[obj.name || `mesh_${meshCount}`] = names;
    }
  });

  const result = { meshCount, targets: targetsByMesh };
  console.log("MorphTarget dump:", result);
  return result;
}

function dumpVRMDebug(vrm = currentVrm) {
  return {
    expressions: dumpVRMExpressions(vrm),
    morphTargets: dumpMorphTargets(vrm),
  };
}

function getRigReport(vrm = currentVrm) {
  const expressions = dumpVRMExpressions(vrm);   // { presetKeys, allKeys }
  const morphTargets = dumpMorphTargets(vrm);    // { meshCount, targets: {meshName:[...]} }

  // Add a small bit of structure/meta so we can build tabs cleanly
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    expressions,
    morphTargets,
  };
}

/* ---------------------------
   LOAD + CONTROLS
---------------------------- */

async function loadVRMFromUrl(url) {
  ensureInit();

  // Stop animations when swapping characters
  try {
    animController?.setEnabled(false);
  } catch { }

  // cleanup
  if (characterRoot) {
    scene.remove(characterRoot);
    characterRoot = null;
  }
  currentVrm = null;
  neckNode = null;
  neckRestQuat = null;
  manualNeckQuat.identity(); // Reset manual controls

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });

  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error("VRMLoaderPlugin did not attach vrm to gltf.userData.vrm");

  characterRoot = new THREE.Group();
  scene.add(characterRoot);

  characterRoot.add(vrm.scene);
  currentVrm = vrm;

  // Assign the lookAt target (must be an Object3D)
  if (currentVrm.lookAt) {
    currentVrm.lookAt.target = lookAtTargetObj;
  }

  const { size } = frameAndCenterModel(vrm.scene);

  neckNode = vrm.humanoid?.getNormalizedBoneNode?.(VRMHumanBoneName.Neck) ?? null;
  if (neckNode) neckRestQuat = neckNode.quaternion.clone();

  // ✅ Expose to console for truth-finding
  window.__vrm = vrm;
  window.dumpVRMExpressions = () => dumpVRMExpressions(vrm);
  window.dumpMorphTargets = () => dumpMorphTargets(vrm);
  window.dumpVRMDebug = () => dumpVRMDebug(vrm);

  console.log("VRM loaded. Use dumpVRMDebug(), dumpVRMExpressions(), dumpMorphTargets().");

  return {
    hasNeck: !!neckNode,
    approxHeight: size.y,
  };
}

function dumpBoneNames() {
  if (!characterRoot) return;
  console.log("--- DUMP SCENE BONES ---");
  const names = [];
  characterRoot.traverse((o) => {
    if (o.isBone || o.type === "Bone") names.push(o.name);
  });
  console.log("Bones found:", names.length, names);
  console.log("------------------------");
}

window.dumpBoneNames = dumpBoneNames; // helper


function setScenePosition(x, y, z) {
  if (!characterRoot) return;
  characterRoot.position.set(Number(x), Number(y), Number(z));
}

function setCameraSpherical(targetX, targetY, targetZ, distance, yaw, pitch) {
  const t = new THREE.Vector3(Number(targetX), Number(targetY), Number(targetZ));

  const r = Math.max(0.25, Number(distance));
  const yawRad = Number(yaw);
  const pitchRad = Number(pitch);

  const cx = t.x + r * Math.sin(yawRad) * Math.cos(pitchRad);
  const cy = t.y + r * Math.sin(pitchRad);
  const cz = t.z + r * Math.cos(yawRad) * Math.cos(pitchRad);

  camera.position.set(cx, cy, cz);
  camera.lookAt(t);
  forceResize();
}

function setExpression(name, value) {
  const mgr = currentVrm?.expressionManager;
  if (!mgr) return false;

  const v = Math.max(0, Math.min(1, Number(value)));
  try {
    mgr.setValue(name, v);
    return true;
  } catch {
    return false;
  }
}

function setNeckYawPitch(yaw, pitch) {
  // Instead of touching neckNode directly, we update the manual state quat.
  // The ticks loop blends this additively with the animation.
  const maxYaw = Math.PI / 3;
  const maxPitch = Math.PI / 4;

  const y = Math.max(-1, Math.min(1, Number(yaw))) * maxYaw;
  const p = Math.max(-1, Math.min(1, Number(pitch))) * maxPitch;

  manualNeckQuat.setFromEuler(new THREE.Euler(p, y, 0, "YXZ"));
}

function setGaze(x, y) {
  if (!currentVrm) return;

  // Project 2D input (-1..1) to 3D target relative to head position
  const lookDistance = 2.0;
  const rangeX = 1.0;
  const rangeY = 1.0;

  // Approximate head position
  const headPos = new THREE.Vector3(0, 1.4, 0);
  const headNode = currentVrm.humanoid?.getNormalizedBoneNode(VRMHumanBoneName.Head);
  if (headNode) {
    headNode.getWorldPosition(headPos);
  }

  // Update the Object3D position in the scene
  // This allows getWorldPosition to return correct coordinates
  lookAtTargetObj.position.set(
    headPos.x + (x * rangeX),
    headPos.y + (y * rangeY),
    headPos.z + lookDistance // Assuming head faces +Z, checking T-Pose behavior needed?
    // Actually VRM specs usually have +Z as forward for models.
    // Camera is backing up looking at origin.
  );

  // Force matrix update since we change position manually
  lookAtTargetObj.updateMatrixWorld();
}

function resetPose() {
  if (!currentVrm) return;
  // Also reset all morph target influences to 0
  currentVrm?.scene?.traverse((obj) => {
    if (!obj.isMesh) return;
    const infl = obj.morphTargetInfluences;
    if (!infl) return;
    for (let i = 0; i < infl.length; i++) infl[i] = 0;
  });

  const mgr = currentVrm.expressionManager;
  if (mgr) {
    try {
      mgr.resetValues?.();
    } catch { }
  }

  // Reset manual offsets
  manualNeckQuat.identity();
  // Reset gaze target
  lookAtTargetObj.position.set(0, 1.5, 2.0);
  lookAtTargetObj.updateMatrixWorld();

  if (neckNode && neckRestQuat) neckNode.quaternion.copy(neckRestQuat);
}

function setMorphTarget(targetName, value) {
  if (!currentVrm?.scene) return false;
  const v = Math.max(0, Math.min(1, Number(value)));

  let applied = false;

  currentVrm.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    const dict = obj.morphTargetDictionary;
    const infl = obj.morphTargetInfluences;
    if (!dict || !infl) return;

    const idx = dict[targetName];
    if (idx === undefined) return;

    infl[idx] = v;
    applied = true;
  });

  return applied;
}

// ---------------------------
// ANIMATION (idle clips, etc.)
// ---------------------------

function setAnimationsEnabled(on) {
  if (!animController) return false;
  animController.setEnabled(!!on);
  return true;
}

function setIdleAnimationPools({ loopUrls = [], oneShotUrls = [] } = {}) {
  if (!animController) return false;
  // NOTE: api changed in controller
  animController.setIdleAnimationPools(loopUrls, oneShotUrls);
  return true;
}

async function playIdleAnimation(url, { loop = true } = {}) {
  if (!animController) return { ok: false, reason: "no_controller" };
  // Manual play stops random mode.
  await animController.playManualIdle(url, { forceLoop: !!loop });
  return { ok: true };
}

async function startRandomIdle(options = {}) {
  if (!animController) return { ok: false, reason: "no_controller" };
  await animController.startRandomIdle(options);
  return { ok: true };
}

function stopAnimations({ toTPose = false } = {}) {
  if (!animController) return false;
  animController.stop({ toTPose });
  return true;
}


// Force arms to a natural A-Pose (downward)
// This is used when we filter out arm animations to prevent twisting.
function forceNeutralArms() {
  if (!currentVrm?.humanoid) return;

  const hum = currentVrm.humanoid;
  const lArm = hum.getNormalizedBoneNode("leftUpperArm");
  const rArm = hum.getNormalizedBoneNode("rightUpperArm");

  // Rotate 70 degrees down (approx 1.2 radians)
  const zRot = 1.2;

  if (lArm) {
    // Reset and apply down rotation
    lArm.quaternion.set(0, 0, 0, 1);
  }
  if (rArm) {
    // Mirror for right arm
    rArm.quaternion.set(0, 0, 0, 1);
  }
}

export const viewer = {
  ensureInit,
  loadVRMFromUrl,
  setScenePosition,
  setCameraSpherical,
  setExpression,
  setNeckYawPitch,
  setGaze, // New API
  resetPose,
  setMorphTarget,
  getRigReport,
  // animations
  setAnimationsEnabled,
  setIdleAnimationPools,
  playIdleAnimation,
  startRandomIdle,
  stopAnimations,
  forceNeutralArms, // export for debug
};