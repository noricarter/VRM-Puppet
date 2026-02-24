// face_animation_controller.js
import * as THREE from "three";

/**
 * Handles subtle micro-animations for the face and head to give the character 'life'.
 * This includes natural blinking, head drifting, and micro-gaze shifting.
 */
export function createFaceAnimationController(options = {}) {
    const { getVRM } = options;

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
            blinkInterval: 4.0,
            switchChance: 0.1
        },
        'content': {
            // Pleasant neutral (Gentle smile)
            morphs: ['Fcl_EYE_Joy'],
            weights: [0.3],
            blinkInterval: 4.0,
            switchChance: 0.2
        },
        'happy': {
            // Custom blend to avoid "excessive open mouth" of preset
            morphs: ['Fcl_BRW_Joy', 'Fcl_EYE_Joy', 'Fcl_MTH_Fun'],
            weights: [0.4, 0.5, 0.4],
            blinkInterval: 3.5,
            switchChance: 0.3
        },
        'relaxed': {
            // Preset: Relaxed (capped at 0.4)
            morphs: ['relaxed'],
            weights: [0.4],
            blinkInterval: 6.0,
            switchChance: 0.2
        },
        'focused': {
            // Preset: Angry (capped at 0.2)
            // Mapping "focused" mood to "angry" preset for intensity
            morphs: ['angry'],
            weights: [0.2],
            blinkInterval: 2.0,
            switchChance: 0.2
        },
        'fun': {
            // Keeping component blend
            morphs: ['Fcl_ALL_Fun', 'Fcl_BRW_Fun', 'Fcl_EYE_Fun', 'Fcl_MTH_Fun'],
            weights: [0.3, 0.3, 0.3, 0.2],
            blinkInterval: 3.0,
            switchChance: 0.2
        },
        'sad': {
            // Preset: Sad (capped at 0.4)
            morphs: ['sad'],
            weights: [0.4],
            blinkInterval: 5.0,
            switchChance: 0.15
        }
    };

    const moodState = {
        current: 'neutral',
        timer: 0,
        nextSwitch: 10, // Seconds until next mood check

        // Morph Blending
        activeMorphs: {}, // { name: { target: 0.4, current: 0.0 } },

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

    function updateMicroExpressions(dt, vrm) {
        if (!vrm.expressionManager) return;

        // 1. Mood Switching Logic
        moodState.timer += dt;
        if (moodState.timer >= moodState.nextSwitch) {
            moodState.timer = 0;
            moodState.nextSwitch = Math.random() * 20 + 10; // 10-30s persistence

            // Pick new mood?
            const keys = Object.keys(MOODS).filter(k => k !== 'surprised');
            const nextMood = keys[Math.floor(Math.random() * keys.length)];

            // Bias towards remaining in current mood or neutral
            if (Math.random() < 0.4) {
                moodState.current = 'neutral';
            } else {
                moodState.current = nextMood;
            }

            state.currentMood = moodState.current; // Expose for debug

            // Set targets for this mood
            const config = MOODS[moodState.current];

            // Reset old targets not in new mood
            for (const k of Object.keys(moodState.activeMorphs)) {
                if (!config.morphs.includes(k)) {
                    moodState.activeMorphs[k].target = 0.0;
                }
            }

            // Set new targets
            config.morphs.forEach((m, i) => {
                // Random intensity variation per cycle
                const weight = config.weights[i] || 0.2;
                const variation = (Math.random() * 0.2) - 0.1;
                const finalWeight = Math.max(0, weight + variation);

                if (!moodState.activeMorphs[m]) {
                    moodState.activeMorphs[m] = { current: 0.0, target: finalWeight };
                } else {
                    moodState.activeMorphs[m].target = finalWeight;
                }
            });
        }

        // 2. Animate Morphs (Lerp)
        const lerpSpeed = 2.0; // Faster response

        for (const [name, data] of Object.entries(moodState.activeMorphs)) {
            // Converge
            const diff = data.target - data.current;
            if (Math.abs(diff) < 0.001) {
                data.current = data.target;
            } else {
                data.current += diff * lerpSpeed * dt;
            }

            // Apply using robust helper
            applyMorphTarget(vrm, name, data.current);

            // Cleanup if 0 and target is 0
            if (data.target === 0 && data.current === 0) {
                delete moodState.activeMorphs[name];
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

    const lateUpdate = (dt) => {
        const vrm = getVRM?.();
        if (!vrm) return;
        updateMicroExpressions(dt, vrm);
    };

    return {
        update,
        lateUpdate,
        getState: () => state,
    };
}
