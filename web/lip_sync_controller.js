// lip_sync_controller.js

/**
 * Handles playing back viseme data on a VRM character.
 */
export function createLipSyncController(options = {}) {
    const { getVRM } = options;

    let currentVisemes = null;
    let audioPlayer = null;
    let isPlaying = false;
    let startTime = 0;

    // Rhubarb Viseme to VRM Expression Mapping
    const VISEME_MAP = {
        'A': {},                   // Closed
        'B': { 'ih': 1.0 },        // Slightly open
        'C': { 'aa': 1.0 },        // Open
        'D': { 'aa': 1.0 },        // Wide open
        'E': { 'ee': 1.0 },        // Mid open
        'F': { 'ou': 1.0 },        // Rounded
        'G': { 'oh': 1.0 },        // Rounded
        'H': { 'ih': 0.5 },        // Pressing
        'X': {}                    // Idle
    };

    /**
     * Loads viseme JSON and audio file to prepare for playback.
     */
    async function load(audioUrl, visemesJsonUrl) {
        stop(); // Ensure previous audio is stopped before loading new

        const response = await fetch(visemesJsonUrl);
        currentVisemes = await response.json();

        audioPlayer = new Audio(audioUrl);
        return true;
    }

    function stop() {
        if (audioPlayer) {
            audioPlayer.pause();
            audioPlayer.currentTime = 0;
        }
        isPlaying = false;
        resetMouth();
    }

    /**
     * Starts playback of the audio and synchronized visemes.
     * Returns a Promise that resolves when the audio finishes.
     */
    function play() {
        return new Promise((resolve) => {
            if (!audioPlayer || !currentVisemes) {
                resolve();
                return;
            }

            isPlaying = true;
            startTime = performance.now() / 1000;

            // Resolve previous promise if exists? (Simple for now: one at a time)

            audioPlayer.onended = () => {
                isPlaying = false;
                resetMouth();
                resolve();
            };

            audioPlayer.play().catch(e => {
                console.error("Audio play failed", e);
                isPlaying = false;
                resolve();
            });
        });
    }

    function resetMouth() {
        const vrm = getVRM();
        if (!vrm?.expressionManager) return;

        ['aa', 'ih', 'ou', 'ee', 'oh'].forEach(key => {
            vrm.expressionManager.setValue(key, 0);
        });
    }

    /**
     * Called every frame in the main loop to update morph targets.
     */
    function update() {
        const vrm = getVRM();
        if (!vrm?.expressionManager) return;

        // 1. Determine Target Morphs
        const targetMorphs = { 'aa': 0, 'ih': 0, 'ou': 0, 'ee': 0, 'oh': 0 };

        if (isPlaying && currentVisemes?.mouthCues) {
            const currentTime = (performance.now() / 1000) - startTime;

            let activeCue = currentVisemes.mouthCues[0];
            for (const cue of currentVisemes.mouthCues) {
                if (currentTime >= cue.start) {
                    activeCue = cue;
                } else {
                    break;
                }
            }

            if (activeCue) {
                const morphs = VISEME_MAP[activeCue.value] || {};
                for (const [key, value] of Object.entries(morphs)) {
                    targetMorphs[key] = value;
                }
            }
        }

        // 2. Smoothly Lerp toward Targets
        // Smoothness factor (0.1 = very slow/smooth, 0.4 = fast/snappy)
        const lerpFactor = 0.25;

        ['aa', 'ih', 'ou', 'ee', 'oh'].forEach(key => {
            const current = vrm.expressionManager.getValue(key) || 0;
            const target = targetMorphs[key];

            // Simple Linear Interpolation
            const nextValue = current + (target - current) * lerpFactor;
            vrm.expressionManager.setValue(key, nextValue);
        });
    }

    return {
        load,
        play,
        stop,
        update,
        isPlaying: () => isPlaying
    };
}
