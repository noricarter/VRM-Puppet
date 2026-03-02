// face_animation_controller.js
import * as THREE from "three";

/**
 * Handles subtle micro-animations for the face and head to give the character 'life'.
 * This includes natural blinking, head drifting, and micro-gaze shifting.
 */
export function createFaceAnimationController(options = {}) {
    const { getVRM } = options;
    const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

    let blinkTimer = 0;
    let nextBlinkTime = Math.random() * 3 + 2;
    let blinkPhase = 0; // 0=open, 1=closing, 2=opening

    let driftTime = Math.random() * 100;
    let gazeTime = Math.random() * 100;

    // Internal state for external access (e.g. by viewer loop)
    const state = {
        blinkValue: 0,
        headYaw: 0,
        headPitch: 0,
        headRoll: 0,
        gazeX: 0,
        gazeY: 0,

        // Debug
        currentMood: "neutral"
    };

    const update = (dt) => {
        const vrm = getVRM?.();
        if (!vrm) return;

        // --- 1. NATURAL BLINKING ---
        blinkTimer += dt;
        if (blinkTimer >= nextBlinkTime && blinkPhase === 0) {
            blinkPhase = 1;
            blinkTimer = 0;
        }

        if (blinkPhase === 1) { // Closing
            state.blinkValue += dt * 12; // Fast close
            if (state.blinkValue >= 1) {
                state.blinkValue = 1;
                blinkPhase = 2;
            }
        } else if (blinkPhase === 2) { // Opening
            state.blinkValue -= dt * 8; // Slower open
            if (state.blinkValue <= 0) {
                state.blinkValue = 0;
                blinkPhase = 0;
                // Mood-based blink rate
                const mood = MOODS[moodState.current] || MOODS['neutral'];
                const base = mood.blinkInterval || 3;
                nextBlinkTime = Math.random() * (base * 1.5) + base;
            }
        }

        // Apply blink to expression manager
        if (vrm.expressionManager) {
            vrm.expressionManager.setValue('blink', state.blinkValue);
        }

        // --- 2. SUBTLE HEAD DRIFT ---
        // We use overlapping sine waves to create non-repeating subtle movement.
        driftTime += dt;
        // Yaw (Left/Right)
        state.headYaw = (Math.sin(driftTime * 0.45) * 0.04) + (Math.sin(driftTime * 1.1) * 0.015);
        // Pitch (Up/Down)
        state.headPitch = (Math.cos(driftTime * 0.35) * 0.03) + (Math.sin(driftTime * 0.9) * 0.01);
        // Roll (Tilting)
        state.headRoll = (Math.sin(driftTime * 0.25) * 0.02);

        // --- 3. MICRO GAZE SHIFTS ---
        updateSaccades(dt);

        // Combine Smooth Drift + Saccade Offset
        // Gaze should be slightly more 'darting' than the head.
        gazeTime += dt;
        const driftX = (Math.sin(gazeTime * 0.6) * 0.15) + (Math.sin(gazeTime * 2.3) * 0.05);
        const driftY = (Math.cos(gazeTime * 0.5) * 0.1) + (Math.sin(gazeTime * 1.9) * 0.03);

        state.gazeX = driftX + moodState.saccadeX;
        state.gazeY = driftY + moodState.saccadeY;

        // --- 4. MICRO-EXPRESSIONS (Subtle Life) ---
        // Randomly activate small morphs to simulate thought/emotion
        // updateMicroExpressions(dt, vrm); // Moved to lateUpdate to prevent overwrite
    };

    // --- MOOD SYSTEM CONFIG ---
    const MOODS = {
        'neutral': {
            morphs: [],
            weights: [],
            ranges: [],
            blinkInterval: 4.0
        },
        'happy': {
            // Use MTH_Fun as the happy mouth driver (targeting ~0.5-0.8 at full variation).
            morphs: ['Fcl_BRW_Joy', 'Fcl_EYE_Joy', 'Fcl_MTH_Fun', 'Fcl_ALL_Joy'],
            weights: [0.30, 0.36, 0.65, 0.08],
            ranges: [0.03, 0.04, 0.15, 0.02],
            blinkInterval: 3.3
        },
        // Tuned for shy/embarrassed shape (color blush handled separately).
        'embarrassed': {
            morphs: [
                'Fcl_BRW_Sorrow',
                'Fcl_BRW_Joy',
                'Fcl_EYE_Sorrow',
                'Fcl_EYE_Spread',
                'Fcl_MTH_Close',
                'Fcl_MTH_Small',
                'Fcl_MTH_O',
                'Fcl_MTH_Down',
                'Fcl_ALL_Sorrow'
            ],
            // Keep lips mostly closed; tiny openness only for subtle uncertainty.
            weights: [0.34, 0.08, 0.22, 0.10, 0.24, 0.06, 0.02, 0.06, 0.10],
            // +/- range per morph to prevent frozen face.
            ranges: [0.04, 0.02, 0.04, 0.03, 0.03, 0.03, 0.01, 0.02, 0.03],
            blinkInterval: 4.8
        },
        // Sad base: keep corners pulled down via MTH_Angry as requested.
        'sad': {
            morphs: [
                'Fcl_BRW_Sorrow',
                'Fcl_EYE_Sorrow',
                'Fcl_MTH_Angry',
                'Fcl_MTH_Large',
                'Fcl_MTH_Close',
                'Fcl_ALL_Sorrow'
            ],
            weights: [0.32, 0.24, 0.40, 0.40, 0.10, 0.10],
            ranges: [0.04, 0.04, 0.04, 0.04, 0.02, 0.03],
            blinkInterval: 5.0
        },
        // Based on your mixer payload pass for "anger".
        'angry': {
            morphs: [
                'Fcl_BRW_Angry',
                'Fcl_BRW_Fun',
                'Fcl_BRW_Sorrow',
                'Fcl_EYE_Angry',
                'Fcl_EYE_Fun',
                'Fcl_EYE_Sorrow',
                'Fcl_EYE_Surprised',
                'Fcl_MTH_Angry',
                'Fcl_MTH_Large',
                'Fcl_MTH_Up'
            ],
            weights: [0.49, 0.10, 0.18, 0.12, 1.00, 0.80, 0.29, 0.40, 0.41, 0.21],
            ranges: [0.05, 0.02, 0.03, 0.03, 0.06, 0.06, 0.04, 0.04, 0.04, 0.03],
            blinkInterval: 2.2
        }
    };

    // Backward compatibility for any upstream mood labels.
    const MOOD_ALIASES = {
        content: 'neutral',
        relaxed: 'neutral',
        focused: 'neutral',
        fun: 'happy',
        sad: 'embarrassed',
        positive: 'happy',
        negative: 'embarrassed',
        negative_sad: 'sad',
        negative_embarrassed: 'embarrassed',
        negative_sad_embarrassed: 'sad',
        negative_anger: 'angry'
    };

    const moodState = {
        current: 'neutral',
        intensity: 1.0,
        autoExpressionsEnabled: true,
        variationScale: 1.0,
        expressionTime: Math.random() * 100.0,

        // Morph Blending
        activeMorphs: {}, // { name: { target: 0.4, current: 0.0 } },
        appliedMorphNames: new Set(),
        morphDynamics: {}, // { name: { phase, speed } }

        // Saccades (previously in microState)
        saccadeTimer: 0,
        nextSaccadeTime: 2,
        saccadeX: 0,
        saccadeY: 0
    };

    // Helper: Apply morphs robustly (Expression Manager -> Raw Blendshapes)
    function applyMorphTarget(vrm, name, value) {
        if (!vrm) return;

        // 1. Try Expression Manager (VRM 0.0 / 1.0)
        if (vrm.expressionManager) {
            try {
                // If it's a known expression, this works
                if (vrm.expressionManager.getExpressionTrackName(name)) {
                    vrm.expressionManager.setValue(name, value);
                    return;
                }
            } catch (e) { }
        }

        // 2. Fallback: Raw Mesh Traversal (for Fcl_BRW_Joy, etc.)
        // This mirrors viewer.js setMorphTarget logic
        vrm.scene.traverse((obj) => {
            if (!obj.isMesh) return;
            const dict = obj.morphTargetDictionary;
            const infl = obj.morphTargetInfluences;
            if (!dict || !infl) return;

            const idx = dict[name];
            if (idx !== undefined) {
                infl[idx] = value;
            }
        });
    }

    function clearAutoMorphs(vrm) {
        for (const name of moodState.appliedMorphNames) {
            applyMorphTarget(vrm, name, 0.0);
        }
        moodState.appliedMorphNames.clear();
        moodState.activeMorphs = {};
    }

    function isMouthMorph(name) {
        if (typeof name !== "string") return false;
        return name.startsWith("Fcl_MTH_");
    }

    function updateMicroExpressions(dt, vrm, runtime = {}) {
        if (!moodState.autoExpressionsEnabled) return;
        const speaking = !!runtime.speaking;
        moodState.expressionTime += dt;

        const config = MOODS[moodState.current] || MOODS['neutral'];
        state.currentMood = moodState.current;

        // Keep only morphs needed for the current mood.
        const desired = new Set(config.morphs);
        for (const name of Object.keys(moodState.activeMorphs)) {
            if (!desired.has(name)) moodState.activeMorphs[name].target = 0.0;
        }

        // Set current mood targets.
        config.morphs.forEach((name, i) => {
            const baseWeight = clamp01(config.weights[i] || 0.0) * clamp01(moodState.intensity);
            const range = clamp01(config.ranges?.[i] || 0.0) * clamp01(moodState.variationScale);
            if (!moodState.morphDynamics[name]) {
                moodState.morphDynamics[name] = {
                    phase: Math.random() * Math.PI * 2,
                    speed: 0.35 + (Math.random() * 0.55)
                };
            }
            const dyn = moodState.morphDynamics[name];
            const drift = range > 0 ? Math.sin((moodState.expressionTime * dyn.speed) + dyn.phase) * range : 0.0;
            const dynamicWeight = clamp01(baseWeight + drift);
            const targetWeight = speaking && isMouthMorph(name) ? 0.0 : dynamicWeight;
            moodState.appliedMorphNames.add(name);
            if (!moodState.activeMorphs[name]) {
                moodState.activeMorphs[name] = { current: 0.0, target: targetWeight };
            } else {
                moodState.activeMorphs[name].target = targetWeight;
            }
        });

        // Animate Morphs (Lerp)
        const lerpSpeed = 2.0; // Faster response

        for (const [name, data] of Object.entries(moodState.activeMorphs)) {
            // Converge
            const diff = data.target - data.current;
            if (Math.abs(diff) < 0.001) {
                data.current = data.target;
            } else {
                data.current += diff * lerpSpeed * dt;
            }

            // While speaking, mouth-shape mood morphs must not interfere with visemes.
            if (speaking && isMouthMorph(name)) {
                data.current = 0.0;
                data.target = 0.0;
                applyMorphTarget(vrm, name, 0.0);
            } else {
                // Apply using robust helper
                applyMorphTarget(vrm, name, data.current);
            }

            // Cleanup if 0 and target is 0
            if (data.target === 0 && data.current === 0) {
                delete moodState.activeMorphs[name];
                moodState.appliedMorphNames.delete(name);
            }
        }
    }

    function updateSaccades(dt) {
        moodState.saccadeTimer += dt;
        if (moodState.saccadeTimer >= moodState.nextSaccadeTime) {
            moodState.saccadeTimer = 0;
            // 0.5 - 4.0 seconds between saccades
            moodState.nextSaccadeTime = Math.random() * 3.5 + 0.5;

            // Random tiny jump
            const range = 0.05;
            moodState.saccadeX = (Math.random() - 0.5) * range;
            moodState.saccadeY = (Math.random() - 0.5) * range;
        }
    }

    const lateUpdate = (dt, runtime = {}) => {
        const vrm = getVRM?.();
        if (!vrm) return;

        if (!moodState.autoExpressionsEnabled) {
            clearAutoMorphs(vrm);
            return;
        }

        updateMicroExpressions(dt, vrm, runtime);
    };

    const setMood = (moodName, intensity = 1.0) => {
        const raw = (typeof moodName === "string" ? moodName.trim().toLowerCase() : "") || "neutral";
        const canonical = MOOD_ALIASES[raw] || raw;
        moodState.current = MOODS[canonical] ? canonical : "neutral";
        moodState.intensity = clamp01(intensity);
        state.currentMood = moodState.current;
    };

    const setAutoExpressionsEnabled = (enabled) => {
        moodState.autoExpressionsEnabled = !!enabled;
    };

    const setMoodVariationScale = (scale = 1.0) => {
        moodState.variationScale = clamp01(scale);
    };

    return {
        update,
        lateUpdate,
        setMood,
        setAutoExpressionsEnabled,
        setMoodVariationScale,
        getState: () => state,
    };
}
