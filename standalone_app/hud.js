// Import existing viewer.js (Server root is project root)
import { viewer } from "../web/viewer.js";

// --- Config ---
const BRIDGE_URL = "http://127.0.0.1:8001";
const DEFAULT_ACTOR = "Laura_Stevens"; // Match folder name

// --- State ---
const state = {
    menuOpen: false,
    hudVisible: true,
    chatVisible: false,
    mindVisible: false,
    isStreaming: false,
    isListening: false,
    handsFreeActive: false,
    attachedImage: null,    // Base64 string of the attached image
    pendingMessage: null,   // Queued message to send after current stream finishes
    pendingImage: null,     // Queued image to send after current stream finishes
    activeContext: null,    // Context for observer mode
    inputMode: 'text'       // 'text' or 'voice'
};

// --- DOM Elements ---
const sideMenu = document.getElementById("side-menu");
const menuToggle = document.getElementById("menu-toggle");
const settingsModal = document.getElementById("settings-modal");
const settingsForm = document.getElementById("settings-form");
const profileSelector = document.getElementById("profile-selector");
const chatModal = document.getElementById("chat-modal");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatMessages = document.getElementById("chat-messages");
const mindModal = document.getElementById("mind-modal");
const mindLog = document.getElementById("mind-log");

const formFields = {
    actorId: document.getElementById("actor-id"),
    actorDisplay: document.getElementById("current-actor-display"),
    vrmPath: document.getElementById("vrm-path"),
    llmModel: document.getElementById("llm-model"),
    persona: document.getElementById("persona"),
    voiceDesc: document.getElementById("voice-desc"),
    voiceRef: document.getElementById("voice-ref"),
    faceCamera: document.getElementById("face-camera"),
    observerMode: document.getElementById("observer-mode")
};

// --- Initialization ---
async function initHUD() {
    console.log("[HUD] Initializing Viewport with Transparency...");

    // 1. Initialize character viewer
    viewer.ensureInit("viewport", { transparent: true });
    viewer.setAnimationsEnabled(true);

    // 2. Load available profiles from DB
    await refreshProfiles();
    await refreshVRMList();
    await refreshModelList();

    // 3. Setup Draggable
    setupDraggable(chatModal, document.getElementById("chat-handle"));
    setupDraggable(mindModal, document.getElementById("mind-handle"));

    // 4. Setup Chat Form
    chatForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        const text = chatInput.value.trim();
        // Allow sending if there's an image even without text
        if (!text && !state.attachedImage) return;

        // If already streaming, queue this message for after the current response
        if (state.isStreaming) {
            state.pendingMessage = text;
            state.pendingImage = state.attachedImage;
            chatInput.value = "";
            window.clearAttachedImage();
            addChatMessage("system", "⏳ Queued — will send after current response.");
            return;
        }

        addChatMessage("user", text, state.attachedImage);
        chatInput.value = "";

        const imageToSend = state.attachedImage;
        window.clearAttachedImage(); // Clear preview after sending

        await handleCharacterChat(text, imageToSend);
    });

    // 4.1 Setup Microphone (STT) - PYTHON BRIDGE VERSION
    const micBtn = document.getElementById("mic-button");
    if (micBtn) {
        micBtn.onclick = async () => {
            if (state.isListening) return;

            state.isListening = true;
            micBtn.textContent = "🔴";
            micBtn.style.backgroundColor = "rgba(255, 0, 0, 0.4)";

            try {
                console.log("[HUD] Requesting Python STT...");
                const transcript = await window.pywebview.api.listen_to_mic();
                console.log("[HUD] Python STT Result:", transcript);

                if (transcript && !transcript.startsWith("Error:")) {
                    chatInput.value = transcript;
                } else if (transcript.startsWith("Error:")) {
                    console.error(transcript);
                    micBtn.textContent = "⚠️";
                    setTimeout(() => { micBtn.textContent = "🎤"; }, 2000);
                }
            } catch (e) {
                console.error("[HUD] Bridge STT Error:", e);
                micBtn.textContent = "⚠️";
            } finally {
                state.isListening = false;
                micBtn.textContent = "🎤";
                micBtn.style.backgroundColor = "";
            }
        };

        // --- Hands-Free Toggle Logic ---
        const handsFreeBtn = document.createElement("button");
        handsFreeBtn.type = "button";
        handsFreeBtn.id = "hands-free-toggle";
        handsFreeBtn.textContent = "🎧"; // Headphone icon for hands-free
        handsFreeBtn.title = "Hands-Free Mode (Always Listening)";
        handsFreeBtn.style.background = "transparent";
        handsFreeBtn.style.border = "none";
        handsFreeBtn.style.fontSize = "16px";
        handsFreeBtn.style.opacity = "0.5";
        handsFreeBtn.style.cursor = "pointer";

        // Find chat-form to insert before mic-button
        micBtn.parentNode.insertBefore(handsFreeBtn, micBtn);

        handsFreeBtn.onclick = async () => {
            const newState = !state.handsFreeActive;
            state.handsFreeActive = newState;

            if (newState) {
                handsFreeBtn.style.opacity = "1";
                handsFreeBtn.style.color = "var(--accent)";
                handsFreeBtn.textContent = "🔊"; // Active icon
            } else {
                handsFreeBtn.style.opacity = "0.5";
                handsFreeBtn.style.color = "";
                handsFreeBtn.textContent = "🎧";
            }

            await window.pywebview.api.toggle_hands_free(newState);
        };
    }

    // --- Image Handling Setup ---
    const imageUpload = document.getElementById("image-upload");
    imageUpload.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) onImageSelect(file);
    });

    // Drag and Drop
    chatModal.addEventListener("dragover", (e) => {
        e.preventDefault();
        chatModal.classList.add("drag-over");
    });

    chatModal.addEventListener("dragleave", () => {
        chatModal.classList.remove("drag-over");
    });

    chatModal.addEventListener("drop", (e) => {
        e.preventDefault();
        chatModal.classList.remove("drag-over");
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith("image/")) {
            onImageSelect(file);
        }
    });

    // 5. Setup Settings Form
    settingsForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        await saveCurrentProfile();
    });

    // --- Global Observer Pulse ---
    window.triggerObserverPulse = (b64Vision, systemTranscript) => {
        if (state.isStreaming) return; // Don't interrupt if already talking

        console.log("[HUD][Observer] Received Pulse. Vision Attached: " + (b64Vision ? "YES" : "NO"));

        const activeRole = formFields.observerMode.value;

        let message = `[OBSERVER_PULSE] (Current Role: ${activeRole})`;
        if (systemTranscript && systemTranscript.trim().length > 0) {
            message += "\n\nTranscript:\n\"" + systemTranscript + "\"";
        }

        // Attach the screenshot to the global state so it gets sent
        state.attachedImage = b64Vision;
        state.activeContext = activeRole; // Store context for the chat bridge

        // Auto-submit
        chatInput.value = message;
        // The chat handle will consume message and state.attachedImage
        chatForm.dispatchEvent(new Event('submit'));
    };

    // --- Activity Tracking ---
    const resetPythonIdle = () => {
        if (window.pywebview && window.pywebview.api) {
            window.pywebview.api.notify_activity();
        }
    };

    chatInput.addEventListener('input', resetPythonIdle);
    document.addEventListener('mousedown', resetPythonIdle);
    document.addEventListener('keydown', resetPythonIdle);

    formFields.observerMode.addEventListener("change", (e) => {
        const role = e.target.value;
        console.log("[HUD][Observer] UI Role Changed:", role);
        window.pywebview.api.set_observer_role(role);
    });

    // --- Global STT Auto-Submit ---
    window.autoSubmitTranscription = (text) => {
        if (!text) return;
        if (state.isStreaming) {
            // Queue it — don't silently drop hands-free speech during a response.
            // Preserve any screenshot that's already attached so they stay bundled.
            state.pendingMessage = text;
            state.pendingImage = state.attachedImage;
            if (state.attachedImage) window.clearAttachedImage();
            addChatMessage("system", "⏳ Queued — will send after current response.");
            return;
        }
        chatInput.value = text;
        chatForm.dispatchEvent(new Event('submit'));
    };

    formFields.faceCamera.addEventListener("change", (e) => {
        viewer.setFaceCamera(e.target.checked);
    });

    // 6. Load default character (or last used?)
    const defaultActorId = "Laura_Stevens";
    const defaultVrm = "/assets/vrms/Laura_Stevens/Laura.vrm";

    // Check if we already have this actor in DB
    const actors = await window.pywebview.api.get_actors();
    const existing = actors.find(a => a.actor_id === defaultActorId);

    if (existing) {
        await window.loadCharacterProfile(existing);
    } else {
        // Fallback for fresh DB
        await viewer.loadVRMFromUrl(defaultVrm);
        formFields.actorId.value = defaultActorId;
        formFields.actorDisplay.textContent = defaultActorId;
        formFields.vrmPath.value = defaultVrm;
        viewer.startRandomIdle();
    }
}

// --- Position Handling ---
window.applyPositionDelta = (axis, amount) => {
    const current = viewer.getCharacterPosition();
    current[axis] += amount;
    viewer.setScenePosition(current.x, current.y, current.z);
    console.log(`[HUD] Moved ${axis}: ${current[axis].toFixed(2)}`);
};

// --- Profile & Settings Logic ---

async function refreshVRMList() {
    const vrms = await window.pywebview.api.get_available_vrms();
    const vrmSelect = formFields.vrmPath;
    vrmSelect.innerHTML = '<option value="">-- Select VRM --</option>';
    vrms.forEach(path => {
        const opt = document.createElement("option");
        opt.value = path;
        opt.textContent = path.split('/').pop(); // Show filename
        vrmSelect.appendChild(opt);
    });
}

async function refreshModelList() {
    const models = await window.pywebview.api.get_available_models();
    const modelSelect = formFields.llmModel;
    modelSelect.innerHTML = '<option value="">-- Select Model --</option>';
    models.forEach(model => {
        const opt = document.createElement("option");
        opt.value = model;
        opt.textContent = model;
        modelSelect.appendChild(opt);
    });
}

window.onVRMChange = () => {
    const path = formFields.vrmPath.value;
    if (!path) {
        formFields.actorId.value = "";
        formFields.actorDisplay.textContent = "--";
        return;
    }
    // Expected path: /assets/vrms/FOLDER_NAME/FILE.vrm
    const parts = path.split("/");
    // folder name is the 2nd to last part
    const folderName = parts[parts.length - 2];
    formFields.actorId.value = folderName;
    formFields.actorDisplay.textContent = folderName;
};

async function refreshProfiles() {
    const actors = await window.pywebview.api.get_actors();
    profileSelector.innerHTML = '<option value="">-- New Profile --</option>';
    actors.forEach(actor => {
        const opt = document.createElement("option");
        opt.value = actor.actor_id;
        opt.textContent = actor.actor_id;
        profileSelector.appendChild(opt);
    });
}

window.loadSelectedProfile = async () => {
    const actorId = profileSelector.value;
    if (!actorId) return;
    await window.pywebview.api.load_actor(actorId);
};

window.loadCharacterProfile = async (actor) => {
    console.log("[HUD] Loading Profile Data:", actor);

    // Ensure lists are populated so values match options
    await refreshVRMList();
    await refreshModelList();

    const manifest = actor.manifest_data || {};

    // Fill Form
    const vrmPath = actor.vrm_path ? (actor.vrm_path.startsWith("/") ? actor.vrm_path : "/" + actor.vrm_path) : "";

    formFields.actorId.value = actor.actor_id || "";
    formFields.actorDisplay.textContent = actor.actor_id || "Unknown";
    formFields.vrmPath.value = vrmPath;
    formFields.llmModel.value = manifest.llm_model || "";
    formFields.persona.value = manifest.persona || "";
    formFields.voiceDesc.value = manifest.voice_description || "";
    formFields.voiceRef.value = manifest.voice_reference_audio || "";
    const isFaceCamEnabled = (manifest.face_camera !== undefined) ? !!manifest.face_camera : true;
    formFields.faceCamera.checked = isFaceCamEnabled;

    const observerRole = manifest.observer_role || "off";
    formFields.observerMode.value = observerRole;

    // Apply Orientation & Observer State
    viewer.setFaceCamera(isFaceCamEnabled);
    window.pywebview.api.set_observer_role(observerRole);

    // Load VRM
    try {
        if (!vrmPath) throw new Error("No VRM path provided in profile");
        await viewer.loadVRMFromUrl(vrmPath);

        // Restore Position if saved
        if (manifest.pos_x !== undefined) {
            viewer.setScenePosition(manifest.pos_x, manifest.pos_y, manifest.pos_z);
        }

        viewer.setIdleAnimationPools({
            loopUrls: [
                "/assets/animations/idle/loop/fbx/loop1.fbx",
                "/assets/animations/idle/loop/fbx/loop2.fbx",
                "/assets/animations/idle/loop/fbx/loop3.fbx",
                "/assets/animations/idle/loop/fbx/loop4.fbx",
                "/assets/animations/idle/loop/fbx/loop5.fbx"
            ],
            oneShotUrls: [
                "/assets/animations/idle/oneshot/fbx/bored.fbx",
                "/assets/animations/idle/oneshot/fbx/checkingNails.fbx",
                "/assets/animations/idle/oneshot/fbx/thinking.fbx",
                "/assets/animations/idle/oneshot/fbx/thoughtful.fbx"
            ]
        });

        viewer.startRandomIdle();
    } catch (e) {
        console.error("[HUD] Failed to swap character:", e);
    }
};

async function saveCurrentProfile() {
    const actorId = formFields.actorId.value;
    const vrmPath = formFields.vrmPath.value;

    if (!actorId || !vrmPath) {
        console.error("[HUD] Cannot save: Actor ID or VRM Path is missing.");
        alert("Please select a VRM character first.");
        return;
    }

    const pos = viewer.getCharacterPosition();
    const manifest = {
        llm_model: formFields.llmModel.value,
        persona: formFields.persona.value,
        voice_description: formFields.voiceDesc.value,
        voice_reference_audio: formFields.voiceRef.value,
        face_camera: formFields.faceCamera.checked,
        observer_role: formFields.observerMode.value,
        pos_x: pos.x,
        pos_y: pos.y,
        pos_z: pos.z
    };

    try {
        const success = await window.pywebview.api.save_actor_profile(actorId, vrmPath, manifest);

        if (success) {
            console.log("[HUD] Profile Saved:", actorId);
            await refreshProfiles();
            profileSelector.value = actorId;
        }
    } catch (err) {
        console.error("[HUD] Save Failed:", err);
    }
}

// --- Draggable Utility ---
function setupDraggable(el, handle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

    handle.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
        e.preventDefault();
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        el.style.top = (el.offsetTop - pos2) + "px";
        el.style.left = (el.offsetLeft - pos1) + "px";
        el.style.bottom = "auto";
        el.style.right = "auto";
    }

    function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
    }
}

// --- Mind Monitor ---
window.toggleMindModal = (force) => {
    const show = (force !== undefined) ? force : !state.mindVisible;
    state.mindVisible = show;
    mindModal.classList.toggle('modal-hidden', !show);
};

function addMindEntry(type, text) {
    const entry = document.createElement('div');
    entry.className = `mind-entry ${type}`;
    entry.textContent = text;
    mindLog.appendChild(entry);
    mindLog.scrollTop = mindLog.scrollHeight;
    // Keep log to last 200 entries to avoid memory creep
    while (mindLog.children.length > 200) {
        mindLog.removeChild(mindLog.firstChild);
    }
}

// --- Chat Communication (Mixer Bridge Logic) ---

// Flush any pending message queued while a stream was active
function _flushPendingMessage() {
    if (state.pendingMessage !== null || state.pendingImage !== null) {
        const msg = state.pendingMessage;
        const img = state.pendingImage;
        state.pendingMessage = null;
        state.pendingImage = null;
        if (msg || img) {
            addChatMessage("user", msg || "", img);
            handleCharacterChat(msg || "", img);
        }
    }
}

async function handleCharacterChat(text, imageJson) {
    if (!text && !imageJson) return;
    console.log("[HUD] Chatting with Bridge. Image attached:", !!imageJson);
    state.isStreaming = true;

    try {
        const currentModel = formFields.llmModel.value; // Let the bridge use DB value if empty
        const currentActorId = formFields.actorId.value || DEFAULT_ACTOR;

        // 1. Send Request with Retry
        let resp = null;
        for (let i = 0; i < 3; i++) {
            try {
                resp = await fetch(`${BRIDGE_URL}/chat`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    mode: "cors",
                    body: JSON.stringify({
                        message: text,
                        actor_id: currentActorId,
                        model: currentModel,
                        images: imageJson ? [imageJson] : [],
                        active_context: state.activeContext || null
                    })
                });
                if (resp.ok) break;
            } catch (e) {
                console.warn(`[HUD] Chat Fetch Retry ${i + 1}/3...`);
                if (i === 2) throw e;
                await new Promise(r => setTimeout(r, 500));
            }
        }

        if (!resp || !resp.ok) throw new Error("Bridge connection failed");

        const result = await resp.json();
        console.log("[HUD] Chat status:", result.status);

        // 2. Listen for Response Stream (SSE)
        const eventSource = new EventSource(`${BRIDGE_URL}/stream_audio`);

        // Safety Watchdog: Reset streaming state if hanging for 15s without activity
        let watchdog = setTimeout(() => {
            console.warn("[HUD] SSE Watchdog Triggered: Stream hanging...");
            eventSource.close();
            state.isStreaming = false;
            _flushPendingMessage();
            state.activeContext = null; // Clear context after sending
        }, 15000);

        const resetWatchdog = () => {
            clearTimeout(watchdog);
            watchdog = setTimeout(() => {
                console.warn("[HUD] SSE Watchdog Triggered: Stream hanging...");
                eventSource.close();
                state.isStreaming = false;
                state.activeContext = null; // Clear context after sending
            }, 10000); // 10s between chunks
        };

        // 2.5 Audio Queue for sequential playback
        let audioQueue = Promise.resolve();

        eventSource.onmessage = async (event) => {
            resetWatchdog();
            const msg = JSON.parse(event.data);
            console.log("[HUD] SSE Event:", msg.type);

            switch (msg.type) {
                case "reasoning":
                    addMindEntry("reasoning", "💭 " + msg.data.thought);
                    break;
                case "thinking":
                    // Absorb mode: she processed but didn't speak
                    addChatMessage("thinking", msg.data.note);
                    addMindEntry("thinking", "🔇 " + msg.data.note);
                    // Fire thinking animation so her body reacts
                    viewer.playIdleAnimation("/assets/animations/idle/oneshot/fbx/thinking.fbx", { loop: false });
                    break;
                case "kg_write":
                    addMindEntry("kg_write", "✅ KG: " + msg.data.text);
                    break;
                case "system_warn":
                    addMindEntry("system_warn", "⚠️ " + msg.data.text);
                    break;
                case "action":
                    console.log("[HUD] Playing Action:", msg.data.url);
                    const actionUrl = msg.data.url.startsWith("/") ? msg.data.url : "/" + msg.data.url;
                    viewer.playIdleAnimation(actionUrl, { loop: false });
                    break;
                case "audio":
                    addChatMessage("assistant", msg.data.text);
                    const audioUrl = msg.data.audioUrl.replace("./", "/web/");
                    const visemeUrl = msg.data.visemeUrl.replace("./", "/web/");

                    // Enqueue the playback so she doesn't talk over herself
                    audioQueue = audioQueue.then(async () => {
                        // Mute hands-free mic while she speaks (prevents feedback loop)
                        if (window.pywebview?.api?.set_speaking) {
                            window.pywebview.api.set_speaking(true);
                        }
                        try {
                            await viewer.playTestLipSync(audioUrl, visemeUrl);
                        } finally {
                            // Always re-enable mic even if playback errors
                            if (window.pywebview?.api?.set_speaking) {
                                // Small delay so the audio buffer fully clears before listening resumes
                                setTimeout(() => window.pywebview.api.set_speaking(false), 500);
                            }
                        }
                    }).catch(e => console.error("[HUD] Audio Queue Error:", e));
                    break;
                case "done":
                    clearTimeout(watchdog);
                    eventSource.close();
                    state.isStreaming = false;
                    _flushPendingMessage();
                    state.activeContext = null; // Clear context after sending
                    break;
                case "error":
                    console.error("[HUD] Stream Error:", msg.data);
                    addChatMessage("system", "Error: " + msg.data);
                    clearTimeout(watchdog);
                    eventSource.close();
                    state.isStreaming = false;
                    _flushPendingMessage();
                    state.activeContext = null; // Clear context after sending
                    break;
            }
        };

        eventSource.onerror = (e) => {
            console.error("[HUD] SSE Failed:", e);
            clearTimeout(watchdog);
            eventSource.close();
            state.isStreaming = false;
            _flushPendingMessage();
            state.activeContext = null; // Clear context after sending
        };

    } catch (err) {
        console.error("[HUD] Chat Error:", err);
        addChatMessage("system", `Error: ${err.message}`);
        state.isStreaming = false;
        state.activeContext = null; // Clear context after sending
    }
}

// --- UI Helpers ---

function onImageSelect(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const base64 = e.target.result.split(',')[1];
        state.attachedImage = base64;

        const container = document.getElementById("image-preview-container");
        const img = document.getElementById("image-preview");
        img.src = e.target.result;
        container.classList.remove("preview-hidden");
        console.log("[HUD] Image selected and converted to base64");
    };
    reader.readAsDataURL(file);
}

window.clearAttachedImage = () => {
    state.attachedImage = null;
    document.getElementById("image-upload").value = "";
    document.getElementById("image-preview-container").classList.add("preview-hidden");
    document.getElementById("image-preview").src = "";
};

// --- Screenshot Hotkey Handler (called from Python via Ctrl+Shift+S) ---
window.injectScreenshot = (b64) => {
    if (!b64) return;
    console.log("[HUD][Hotkey] Injecting screenshot into chat...");

    // Attach the image to state (same as drag-and-drop)
    state.attachedImage = b64;
    const container = document.getElementById("image-preview-container");
    const img = document.getElementById("image-preview");
    img.src = `data:image/jpeg;base64,${b64}`;
    container.classList.remove("preview-hidden");

    // Ensure chat is open
    if (!state.chatVisible) {
        window.toggleChatModal(true);
    }

    // In hands-free mode: don't auto-submit yet — the screenshot stays attached
    // and will be bundled with the next voice transcription automatically.
    // (chatForm submit reads state.attachedImage, so it combines text + image.)
    if (state.handsFreeActive) {
        console.log("[HUD][Hotkey] Hands-free: screenshot attached, waiting for voice to bundle.");
    }
    // In manual mode: preview is shown, user adds text and presses Enter.
};

function addChatMessage(role, text, imageBase64) {
    const div = document.createElement("div");
    div.className = `message ${role}`;

    // Thought-bubble style for absorbed memories
    if (role === "thinking") {
        const icon = document.createElement("span");
        icon.textContent = "💭 ";
        div.appendChild(icon);
    }


    if (imageBase64) {
        const img = document.createElement("img");
        img.src = `data:image/jpeg;base64,${imageBase64}`;
        img.style.maxWidth = "100%";
        img.style.borderRadius = "8px";
        img.style.marginBottom = "8px";
        img.style.display = "block";
        div.appendChild(img);
    }

    if (text) {
        const textSpan = document.createElement("span");
        textSpan.textContent = text;
        div.appendChild(textSpan);
    }

    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

window.toggleChatModal = (force) => {
    state.chatVisible = (force !== undefined) ? force : !state.chatVisible;
    if (state.chatVisible) {
        chatModal.classList.remove("modal-hidden");
        chatInput.focus();
    } else {
        chatModal.classList.add("modal-hidden");
    }
};

window.toggleHUDVisibility = (visible) => {
    const root = document.querySelector(".transparent-root");
    root.style.opacity = visible ? "1" : "0";
    state.hudVisible = visible;
};

window.showSettingsModal = async () => {
    await refreshVRMList();
    await refreshModelList();
    settingsModal.classList.remove("modal-hidden");
};

window.hideSettingsModal = () => {
    settingsModal.classList.add("modal-hidden");
};

// --- Menu Logic ---
menuToggle.addEventListener("click", () => {
    state.menuOpen = !state.menuOpen;
    if (state.menuOpen) {
        sideMenu.classList.remove("menu-hidden");
        menuToggle.textContent = "✖";
    } else {
        sideMenu.classList.add("menu-hidden");
        menuToggle.textContent = "☰";
    }
});

// Run Init
if (window.pywebview) {
    initHUD();
} else {
    window.addEventListener('pywebviewready', () => {
        initHUD();
    });
}
