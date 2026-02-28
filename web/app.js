import { viewer } from "./viewer.js";
import { mountPersonaEditor } from "./persona_editor.js";

// --- Bridge API Base (Headless Engine)
const BRIDGE_BASE = "http://localhost:8001";

const IDLE_ANIM_BASE = "../assets/animations/idle";

// --- State
let config = { tabs: [] };
let manifest = { characters: [] };

// Tabs we render (character tab is UI-only; the rest come from config)
let uiTabs = [];
let activeTabId = "chat";

// ✅ SINGLE GATE ONLY: characterLoaded
// After a character is loaded, NOTHING is gated by “scene applied”.
const state = {
  characterLoaded: false,
  loadedCharacterId: null,
  // animations UI state
  animations: {
    enabled: false,
    idleItems: [], // { label, url, kind: "loop"|"oneshot" }
    loaded: false,
    loading: false,
  },
};

// Current slider values in memory (single source of truth)
const sliderState = new Map(); // id -> number

// --- UI elements
const tabStrip = document.getElementById("tabStrip");
const sliderBank = document.getElementById("sliderBank");
const payloadPreview = document.getElementById("payloadPreview");

const btnApply = document.getElementById("btn-apply");
const btnReset = document.getElementById("btn-reset");

const panelLeft = document.getElementById("panel-left");
const panelRight = document.getElementById("panel-right");

const sceneStatus = document.getElementById("sceneStatus");

// Character UI elements (these exist in your HTML; we hide/show as needed)
const characterSelect = document.getElementById("characterSelect");
const sceneBlock = document.getElementById("sceneBlock");

// Rig export button (optional)
const btnExportRig = document.getElementById("btn-export-rig");

// --- Side panel toggles
document.getElementById("btn-open-left")?.addEventListener("click", () => panelLeft?.classList.toggle("open"));
document.getElementById("btn-open-right")?.addEventListener("click", () => panelRight?.classList.toggle("open"));
document.querySelectorAll(".panel-close").forEach((btn) => {
  btn.addEventListener("click", () => {
    const which = btn.dataset.panel;
    (which === "left" ? panelLeft : panelRight)?.classList.remove("open");
  });
});

// --- Helpers
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function roundToStep(value, step) {
  if (!step || step <= 0) return value;
  const inv = 1 / step;
  return Math.round(value * inv) / inv;
}
function setStatus(msg) {
  if (sceneStatus) sceneStatus.textContent = msg;
}

function getActiveActorId() {
  return (
    state.loadedCharacterId ||
    localStorage.getItem("active_actor_id") ||
    manifest.characters?.[0]?.id ||
    "Unknown_Actor"
  );
}

function getTab(tabId) {
  return uiTabs.find((t) => t.id === tabId) || null;
}
function getActiveTab() {
  return getTab(activeTabId);
}

// TEMP: payload preview (remove next phase)
function renderPayloadPreview(payload) {
  payloadPreview.textContent = JSON.stringify(payload, null, 2);
}

// ---------------------------
// Animations: idle discovery
// ---------------------------

async function fetchJsonMaybe(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// If you run a simple local server (python -m http.server), directory listing is HTML.
// We support that as a fallback so you don't need to hand-maintain a manifest.
async function fetchDirListingLinksMaybe(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const html = await res.text();
    // Quick and dirty anchor extraction. Works for simple servers.
    const doc = new DOMParser().parseFromString(html, "text/html");
    const hrefs = Array.from(doc.querySelectorAll("a"))
      .map((a) => a.getAttribute("href") || "")
      .filter((h) => h && !h.startsWith("?") && !h.startsWith("#"));
    return hrefs;
  } catch {
    return null;
  }
}

function normalizeUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

async function discoverIdleAnimations() {
  // Preferred: user-provided manifest (optional)
  const manifest = await fetchJsonMaybe(`${IDLE_ANIM_BASE}/manifest.json`);
  if (manifest && Array.isArray(manifest.items)) {
    return manifest.items
      .filter((x) => x?.url)
      .map((x) => ({
        label: x.label ?? x.url,
        url: x.url,
        kind: x.kind === "oneshot" ? "oneshot" : "loop",
      }));
  }

  // Fallback: directory listings
  // Updated to look into 'fbx' subfolders
  const loopListing = await fetchDirListingLinksMaybe(`${IDLE_ANIM_BASE}/loop/fbx/`);
  const oneListing = await fetchDirListingLinksMaybe(`${IDLE_ANIM_BASE}/oneshot/fbx/`);

  const items = [];
  const addFromListing = (listing, kind, base) => {
    if (!listing) return;
    for (const h of listing) {
      if (!h.toLowerCase().endsWith(".fbx") && !h.toLowerCase().endsWith(".glb")) continue;

      const file = decodeURIComponent(h).split("/").pop();
      // Use direct concatenation for relative paths
      const url = base + file;

      items.push({
        label: file?.replace(/\.(fbx|glb)$/i, "") || file || url,
        url,
        kind,
      });
    }
  };

  addFromListing(loopListing, "loop", `${IDLE_ANIM_BASE}/loop/fbx/`);
  addFromListing(oneListing, "oneshot", `${IDLE_ANIM_BASE}/oneshot/fbx/`);

  // Stable sorting: loops first, then oneshots
  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "loop" ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  return items;
}

// Build payload from a tab's sliders only
function buildPayloadForTab(tabId) {
  const tab = getTab(tabId);
  const sliders = Array.isArray(tab?.sliders) ? tab.sliders : [];
  const values = {};
  for (const s of sliders) {
    values[s.id] = sliderState.get(s.id) ?? s.default ?? 0;
  }
  return { tab: tabId, values };
}

// --- Rendering
function renderTabs() {
  tabStrip.innerHTML = "";

  for (const tab of uiTabs) {
    // ✅ SINGLE GATE:
    // - If character NOT loaded: only show Character tab
    // - If character loaded: show ALL tabs (Scene + everything)
    if (!state.characterLoaded && tab.id !== "character") continue;

    const btn = document.createElement("button");
    btn.className = "tab-btn" + (tab.id === activeTabId ? " active" : "");
    btn.textContent = tab.label;

    btn.onclick = () => {
      activeTabId = tab.id;
      renderTabs();
      renderTabContent(tab.id);
      renderPayloadPreview(buildPayloadForTab(activeTabId));
    };

    tabStrip.appendChild(btn);
  }
}

function renderTabContent(tabId) {
  sliderBank.innerHTML = "";

  const tab = getTab(tabId);
  if (!tab) return;

  // Toggle scene block visibility (your HTML block with selector/status)
  if (sceneBlock) {
    sceneBlock.style.display = tabId === "scene" ? "block" : "none";
  }

  // Scene block selector mirrors the currently loaded character.
  // Character selection happens in Character tab (keeps UX consistent and simple).
  if (tabId === "scene" && characterSelect) {
    characterSelect.disabled = true;
    if (state.loadedCharacterId) characterSelect.value = state.loadedCharacterId;
  }

  if (tabId === "character") {
    renderCharacterTab();
    return;
  }

  if (tabId === "animations") {
    renderAnimationsTab();
    return;
  }

  if (tabId === "chat") {
    renderChatTab();
    return;
  }

  if (tabId === "actions") {
    renderActionsTab();
    return;
  }

  renderSlidersForTab(tabId);
}

function renderCharacterTab() {
  const wrap = document.createElement("div");
  wrap.className = "character-select";

  const select = document.createElement("select");
  select.id = "characterSelect-inline";

  // Populate from manifest
  for (const c of manifest.characters || []) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.label ?? c.id;
    select.appendChild(opt);
  }

  // Default selection mirrors the scene dropdown if it exists
  if (characterSelect && characterSelect.value) select.value = characterSelect.value;

  const btn = document.createElement("button");
  btn.textContent = "Load Character";

  btn.onclick = async () => {
    const selectedId = select.value;
    if (!selectedId) return;

    // keep scene dropdown synced
    if (characterSelect) characterSelect.value = selectedId;

    await loadSelectedCharacter(selectedId);

    // ✅ After character load: unlock ALL tabs immediately (no second gate).
    setStatus("Character loaded.");

    // Optionally jump to Scene after load (nice flow)
    activeTabId = "scene";

    renderTabs();
    renderTabContent(activeTabId);
    renderPayloadPreview(buildPayloadForTab(activeTabId));
  };

  wrap.appendChild(select);
  wrap.appendChild(btn);
  sliderBank.appendChild(wrap);
}

// ---------------------------
// Animations tab (Idle only)
// ---------------------------

function renderAnimationsTab() {
  const wrap = document.createElement("div");
  wrap.className = "character-select";

  const title = document.createElement("div");
  title.className = "muted";
  title.textContent = "Idle Animations (debug)";

  const enabledRow = document.createElement("div");
  enabledRow.style.display = "flex";
  enabledRow.style.gap = "8px";
  enabledRow.style.alignItems = "center";

  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.checked = !!state.animations.enabled;

  const chkLbl = document.createElement("label");
  chkLbl.className = "muted";
  chkLbl.textContent = "Animations enabled (OFF = T-pose)";

  chk.addEventListener("change", () => {
    state.animations.enabled = chk.checked;
    viewer.setAnimationsEnabled?.(state.animations.enabled);
    if (!state.animations.enabled) {
      viewer.stopAnimations?.({ toTPose: true });
    }
  });

  enabledRow.appendChild(chk);
  enabledRow.appendChild(chkLbl);

  const select = document.createElement("select");
  select.style.minWidth = "280px";

  const btnPlay = document.createElement("button");
  btnPlay.textContent = "Play (Loop)";

  const btnRandom = document.createElement("button");
  btnRandom.textContent = "Random Idle Mode";

  const btnStop = document.createElement("button");
  btnStop.textContent = "Stop / T-Pose";

  const btnLipSync = document.createElement("button");
  btnLipSync.textContent = "Test Lip-Sync (temp/ComfyUI_00099_.mp3)";
  btnLipSync.style.marginTop = "12px";
  btnLipSync.style.display = "block";
  btnLipSync.className = "primary";

  // NEW: Edit Metadata Button
  const btnEditMeta = document.createElement("button");
  btnEditMeta.textContent = "Edit Metadata 📝";
  btnEditMeta.style.marginTop = "8px";
  btnEditMeta.style.display = "block";
  btnEditMeta.className = "secondary";
  btnEditMeta.onclick = () => {
    const url = select.value;
    if (!url) return alert("Select an animation first.");
    window.openEditModal(url);
  };

  const status = document.createElement("div");
  status.className = "muted";
  status.style.marginTop = "8px";

  function setAnimStatus(msg) {
    status.textContent = msg;
  }

  const populateSelect = () => {
    select.innerHTML = "";

    if (!state.animations.idleItems.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(no idle animations found)";
      select.appendChild(opt);
      return;
    }

    for (const item of state.animations.idleItems) {
      const opt = document.createElement("option");
      opt.value = item.url;
      opt.textContent = `${item.kind.toUpperCase()}: ${item.label}`;
      select.appendChild(opt);
    }
  };

  const ensureLoaded = async () => {
    if (state.animations.loaded) {
      populateSelect();
      return;
    }
    if (state.animations.loading) return;
    state.animations.loading = true;
    setAnimStatus("Scanning ./animations/idle/... ");

    const items = await discoverIdleAnimations();
    state.animations.idleItems = items;
    state.animations.loaded = true;
    state.animations.loading = false;

    // Configure idle pools on viewer side
    const loopUrls = items.filter((i) => i.kind === "loop").map((i) => i.url);
    const oneShotUrls = items.filter((i) => i.kind === "oneshot").map((i) => i.url);
    viewer.setIdleAnimationPools?.({ loopUrls, oneShotUrls });

    populateSelect();
    setAnimStatus(
      items.length
        ? `Found ${items.filter((i) => i.kind === "loop").length} loop + ${items.filter((i) => i.kind === "oneshot").length} one-shot.`
        : "No animations found. (Either add a manifest.json or enable directory listing on your server.)"
    );
  };

  // Kick discovery when tab opens
  ensureLoaded();

  btnPlay.addEventListener("click", async () => {
    if (!state.characterLoaded) return setAnimStatus("Load a character first.");
    if (!state.animations.enabled) {
      state.animations.enabled = true;
      chk.checked = true;
      viewer.setAnimationsEnabled?.(true);
    }

    const url = select.value;
    if (!url) return;

    setAnimStatus(`Playing: ${url}`);
    await viewer.playIdleAnimation?.(url, { loop: true });
  });

  btnRandom.addEventListener("click", async () => {
    if (!state.characterLoaded) return setAnimStatus("Load a character first.");
    if (!state.animations.enabled) {
      state.animations.enabled = true;
      chk.checked = true;
      viewer.setAnimationsEnabled?.(true);
    }
    setAnimStatus("Random idle mode running...");
    await viewer.startRandomIdle?.({
      loopSwitchMinSec: 10,
      loopSwitchMaxSec: 22,
      oneShotChance: 0.25,
      oneShotCooldownSec: 12,
    });
  });

  btnStop.addEventListener("click", () => {
    viewer.stopAnimations?.({ toTPose: true });
    state.animations.enabled = false;
    chk.checked = false;
    viewer.setAnimationsEnabled?.(false);
    setAnimStatus("Stopped. Back to T-pose.");
  });

  btnLipSync.addEventListener("click", async () => {
    if (!state.characterLoaded) return setAnimStatus("Load a character first.");
    setAnimStatus("Playing Test Lip-Sync...");
    await viewer.playTestLipSync?.(
      "./temp/ComfyUI_00099_.mp3",
      "./temp/ComfyUI_00099__visemes.json"
    );
  });

  wrap.appendChild(title);
  wrap.appendChild(enabledRow);
  wrap.appendChild(select);
  wrap.appendChild(btnPlay);
  wrap.appendChild(btnRandom);
  wrap.appendChild(btnStop);
  wrap.appendChild(btnLipSync);
  wrap.appendChild(btnEditMeta);
  wrap.appendChild(status);

  sliderBank.appendChild(wrap);
}

// ---------------------------
// Chat Tab (Interactive Test)
// ---------------------------

async function syncTraits() {
  const actorId = getActiveActorId();
  try {
    const res = await fetch("http://localhost:8001/get_traits", {
      method: "POST",
      body: JSON.stringify({ actor_id: actorId })
    });
    if (res.ok) return await res.json();
  } catch (e) { console.error("Sync traits failed", e); }
  return {};
}

async function fetchModels() {
  try {
    const res = await fetch("http://localhost:8001/get_models");
    if (res.ok) {
      const data = await res.json();
      return data.models || [];
    }
  } catch (e) { console.error("Fetch models failed", e); }
  return ["fimbulvetr-v2.1:latest"]; // Minimal fallback
}

async function saveTrait(trait, value) {
  const actorId = getActiveActorId();
  try {
    await fetch("http://localhost:8001/update_trait", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor_id: actorId, trait, value })
    });
  } catch (e) { console.error("Save trait failed", e); }
}

async function renderChatTab() {
  const wrap = document.createElement("div");
  wrap.className = "character-select";
  wrap.style.maxWidth = "800px";
  wrap.style.display = "grid";
  wrap.style.gridTemplateColumns = "1fr 1fr";
  wrap.style.gap = "20px";
  wrap.style.alignItems = "start";

  const traits = await syncTraits();

  // --- Left Column: Character Design (Traits) ---
  const traitsCol = document.createElement("div");
  traitsCol.style.display = "flex";
  traitsCol.style.flexDirection = "column";
  traitsCol.style.gap = "8px";

  const personaTitle = document.createElement("div");
  personaTitle.className = "muted";
  personaTitle.style.fontSize = "11px";
  personaTitle.textContent = "Persona (Roleplay Instructions)";

  const personaInput = document.createElement("textarea");
  personaInput.value = traits.persona || "You are a helpful and polite AI humanoid named Pilot.";
  personaInput.style.width = "100%";
  personaInput.style.height = "100px";
  personaInput.style.fontSize = "13px";
  personaInput.className = "chat-input";

  const voiceTitle = document.createElement("div");
  voiceTitle.className = "muted";
  voiceTitle.style.fontSize = "11px";
  voiceTitle.textContent = "Voice Description (Qwen3-TTS)";

  const voiceInput = document.createElement("input");
  voiceInput.type = "text";
  voiceInput.value = traits.voice_description || "A warm, gentle female voice.";
  voiceInput.style.width = "100%";
  voiceInput.style.fontSize = "13px";

  const voiceRefTitle = document.createElement("div");
  voiceRefTitle.className = "muted";
  voiceRefTitle.style.fontSize = "11px";
  voiceRefTitle.style.marginTop = "8px";
  voiceRefTitle.textContent = "Voice Reference Audio (Optional Wav Path)";

  const voiceRefInput = document.createElement("input");
  voiceRefInput.type = "text";
  voiceRefInput.value = traits.voice_reference_audio || "";
  voiceRefInput.placeholder = "e.g. assets/voices/jane_ref.wav";
  voiceRefInput.style.width = "100%";
  voiceRefInput.style.fontSize = "13px";

  const modelTitle = document.createElement("div");
  modelTitle.className = "muted";
  modelTitle.style.fontSize = "11px";
  modelTitle.style.marginTop = "8px";
  modelTitle.textContent = "LLM Model (Ollama)";

  const modelSelect = document.createElement("select");
  modelSelect.style.width = "100%";
  modelSelect.style.fontSize = "13px";
  const availableModels = await fetchModels();
  for (const m of availableModels) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    modelSelect.appendChild(opt);
  }
  modelSelect.value = traits.llm_model || "fimbulvetr-v2.1:latest";

  const btnSave = document.createElement("button");
  btnSave.textContent = "Save Character Traits";
  btnSave.style.marginTop = "8px";
  btnSave.style.height = "36px";
  btnSave.onclick = async () => {
    btnSave.textContent = "Saving...";
    await saveTrait("persona", personaInput.value);
    await saveTrait("voice_description", voiceInput.value);
    await saveTrait("voice_reference_audio", voiceRefInput.value);
    await saveTrait("llm_model", modelSelect.value);
    btnSave.textContent = "Saved 🛡️";
    setTimeout(() => btnSave.textContent = "Save Character Traits", 2000);
  };

  traitsCol.appendChild(personaTitle);
  traitsCol.appendChild(personaInput);
  traitsCol.appendChild(voiceTitle);
  traitsCol.appendChild(voiceInput);
  traitsCol.appendChild(voiceRefTitle);
  traitsCol.appendChild(voiceRefInput);
  traitsCol.appendChild(modelTitle);
  traitsCol.appendChild(modelSelect);
  traitsCol.appendChild(btnSave);

  // --- Right Column: Interaction (Chat & Controls) ---
  const chatCol = document.createElement("div");
  chatCol.style.display = "flex";
  chatCol.style.flexDirection = "column";
  chatCol.style.gap = "8px";

  const messageTitle = document.createElement("div");
  messageTitle.className = "muted";
  messageTitle.style.fontSize = "11px";
  messageTitle.textContent = "Message Pilot";

  const messageInput = document.createElement("input");
  messageInput.type = "text";
  messageInput.placeholder = "Talk to her...";
  messageInput.style.flexGrow = "1";
  messageInput.style.height = "40px";
  messageInput.style.fontSize = "14px";

  const micBtn = document.createElement("button");
  micBtn.textContent = "🎤";
  micBtn.style.width = "40px";
  micBtn.style.height = "40px";
  micBtn.style.padding = "0";
  micBtn.title = "Voice Input";

  const continuousToggle = document.createElement("button");
  continuousToggle.textContent = "🎧";
  continuousToggle.style.width = "40px";
  continuousToggle.style.height = "40px";
  continuousToggle.style.padding = "0";
  continuousToggle.style.opacity = "0.5";
  continuousToggle.title = "Hands-Free Mode (Auto-Send)";

  const inputRow = document.createElement("div");
  inputRow.style.display = "flex";
  inputRow.style.gap = "4px";
  inputRow.appendChild(messageInput);
  inputRow.appendChild(continuousToggle);
  inputRow.appendChild(micBtn);

  // --- Web Speech API (STT) ---
  let recognition = null;
  let isContinuous = false;
  let isSpeaking = false; // True while TTS audio is playing — mutes the mic
  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      micBtn.textContent = "🔴";
      micBtn.style.backgroundColor = "rgba(255, 0, 0, 0.2)";
      status.textContent = "Listening...";
    };

    let silenceTimer = null;

    recognition.onend = () => {
      micBtn.textContent = "🎤";
      micBtn.style.backgroundColor = "";
      status.textContent = isContinuous ? "Hands-Free active..." : "Speech stopped.";

      // Auto-restart if continuous — but NOT while she is speaking (prevents feedback loop)
      if (isContinuous && !isSpeaking) {
        setTimeout(() => {
          try { recognition.start(); } catch (e) { }
        }, 300);
      }
    };

    recognition.onresult = (event) => {
      const transcript = event.results[event.results.length - 1][0].transcript;
      messageInput.value = transcript;
      status.textContent = "Transcribed: " + transcript;

      if (isContinuous) {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          if (messageInput.value.length > 2) {
            btnSend.click();
          }
        }, 1500); // Wait 1.5 seconds of silence before auto-sending
      }
    };

    recognition.onerror = (event) => {
      console.error("Speech Recognition Error:", event.error);
      micBtn.textContent = "⚠️";
      status.textContent = "Speech Error: " + event.error;
    };
  } else {
    micBtn.disabled = true;
    micBtn.title = "Speech Recognition not supported in this browser.";
    micBtn.style.opacity = "0.3";
  }

  micBtn.onclick = () => {
    if (!recognition) return;
    isContinuous = false; // Disable continuous if manually clicking one-shot
    continuousToggle.style.opacity = "0.5";
    continuousToggle.style.backgroundColor = "";
    try {
      recognition.start();
    } catch (e) {
      recognition.stop();
    }
  };

  continuousToggle.onclick = () => {
    if (!recognition) return;
    isContinuous = !isContinuous;

    if (isContinuous) {
      continuousToggle.style.opacity = "1";
      continuousToggle.style.backgroundColor = "rgba(76, 201, 240, 0.2)";
      continuousToggle.textContent = "🔊";
      try { recognition.start(); } catch (e) { }
    } else {
      continuousToggle.style.opacity = "0.5";
      continuousToggle.style.backgroundColor = "";
      continuousToggle.textContent = "🎧";
      recognition.stop();
    }
  };

  // Submit on Enter
  messageInput.onkeydown = (e) => { if (e.key === 'Enter') btnSend.click(); };

  const btnSend = document.createElement("button");
  btnSend.textContent = "Send Message";
  btnSend.className = "primary";
  btnSend.style.height = "48px";
  btnSend.style.fontSize = "15px";

  const status = document.createElement("div");
  status.className = "muted";
  status.style.fontSize = "11px";
  status.style.marginTop = "4px";

  const memorySection = document.createElement("div");
  memorySection.style.marginTop = "12px";
  memorySection.style.paddingTop = "12px";
  memorySection.style.borderTop = "1px solid var(--border)";

  const btnResetMem = document.createElement("button");
  btnResetMem.textContent = "Reset Conversation History 🧠🛑";
  btnResetMem.style.width = "100%";
  btnResetMem.style.fontSize = "12px";
  btnResetMem.style.height = "34px";
  btnResetMem.onclick = async () => {
    if (!confirm("Wipe her memory? This cannot be undone.")) return;
    await fetch("http://localhost:8001/reset_memory", {
      method: "POST",
      body: JSON.stringify({ actor_id: getActiveActorId() })
    });
    alert("Memory flatlined. 🌑");
  };

  // --- AUDIO QUEUE SYSTEM ---
  // --- AUDIO QUEUE SYSTEM ---
  const audioQueue = {
    items: [],
    isPlaying: false,
    async push(item) {
      this.items.push(item);
      if (!this.isPlaying) this.startProcessor();
    },
    async startProcessor() {
      if (this.isPlaying) return; // Guard
      this.isPlaying = true;

      // Mute the microphone so she doesn't hear herself
      isSpeaking = true;
      if (recognition && isContinuous) {
        try { recognition.stop(); } catch (e) { }
      }

      while (this.items.length > 0) {
        const item = this.items.shift();
        try {
          status.textContent = `Speaking: "${item.text.substring(0, 20)}..."`;
          // This await holds the loop until audio finishes (or errors)
          // lip_sync_controller.play() returns a Promise that resolves on 'onended'
          await viewer.playTestLipSync(item.audioUrl, item.visemeUrl);
        } catch (e) {
          console.error("Playback error:", e);
        }
      }

      this.isPlaying = false;
      status.textContent = "Response complete.";

      // Unmute — re-enable listening after she finishes speaking
      isSpeaking = false;
      if (recognition && isContinuous) {
        setTimeout(() => {
          try { recognition.start(); } catch (e) { }
        }, 400); // Small delay to let audio fully clear the mic
      }
    }
  };

  btnSend.onclick = async () => {
    if (!state.characterLoaded) return (status.textContent = "Load a character first.");
    const message = messageInput.value.trim();
    if (!message) return;

    btnSend.disabled = true;
    btnSend.textContent = "Listening...";
    status.textContent = "Connecting to Neural Bridge...";

    // 1. Start the Stream (POST)
    try {
      const response = await fetch("http://localhost:8001/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          actor_id: getActiveActorId(),
          model: modelSelect.value
        })
      });

      if (!response.ok) throw new Error("Bridge failed to start stream");

      // 2. Connect to SSE (GET)
      status.textContent = "Thinking...";
      const evtSource = new EventSource("http://localhost:8001/stream_audio");

      evtSource.onmessage = (e) => {
        const msg = JSON.parse(e.data);

        if (msg.type === 'audio') {
          audioQueue.push(msg.data);
          status.textContent = "Receiving audio stream...";
        } else if (msg.type === 'reasoning') {
          // Update Actions Tab Log if it's open
          addReasoningToLog(msg.data);
          status.textContent = "Reasoning complete...";

          // If no action was selected (Missing or None), ensure we are idling
          if (msg.data.selection_type !== 'appropriate_action' && state.characterLoaded) {
            viewer.startRandomIdle();
          }
        } else if (msg.type === 'action') {
          // Auto-trigger animation
          if (state.characterLoaded) {
            viewer.playIdleAnimation(`../${msg.data.url}`, { loop: false });
          }
        } else if (msg.type === 'done') {
          console.log("Stream complete.");
          evtSource.close();
          btnSend.disabled = false;
          btnSend.textContent = "Send Message";
          messageInput.value = "";
          status.textContent = "Stream finished.";
        } else if (msg.type === 'error') {
          console.error("Stream error:", msg.data);
          evtSource.close();
          status.textContent = "Stream Error.";
          btnSend.disabled = false;
        }
      };

      evtSource.onerror = (e) => {
        console.error("SEE Error", e);
        evtSource.close();
        btnSend.disabled = false;
        btnSend.textContent = "Send Message";
      };

    } catch (e) {
      status.textContent = "Error: Connection lost.";
      btnSend.disabled = false;
      btnSend.textContent = "Send Message";
    }
  };

  chatCol.appendChild(messageTitle);
  chatCol.appendChild(inputRow);
  chatCol.appendChild(btnSend);
  chatCol.appendChild(status);
  chatCol.appendChild(memorySection);
  memorySection.appendChild(btnResetMem);

  wrap.appendChild(traitsCol);
  wrap.appendChild(chatCol);

  sliderBank.innerHTML = ""; // Clear existing
  sliderBank.appendChild(wrap);
}

// --- ACTIONS TAB ---
let reasoningHistory = [];
let allIndexedAnimations = []; // Fetched on demand

async function fetchAllAnimations() {
  try {
    const res = await fetch("http://localhost:8001/scan_animations"); // Note: returns uncategorized if we want, but we need indexed?
    // Wait, scan_animations returns unindexed. We need get_all_animations.
    // Let's add an endpoint for that or just use scan if it changed.
    // Actually, let's assume get_all_animations is what we need.
  } catch (e) {
    console.error("Fetch all animations failed", e);
  }
}

function addReasoningToLog(data) {
  reasoningHistory.unshift({
    timestamp: new Date().toLocaleTimeString(),
    ...data
  });
  if (reasoningHistory.length > 20) reasoningHistory.pop();

  // If active tab is actions, re-render log
  if (activeTabId === "actions") {
    const logContainer = document.getElementById("reasoning-log");
    if (logContainer) renderReasoningLog(logContainer);
  }
}

function renderReasoningLog(container) {
  container.innerHTML = "";
  if (reasoningHistory.length === 0) {
    container.innerHTML = "<div class='muted' style='font-style:italic; padding:10px;'>No reasoning history yet. Start a chat!</div>";
    return;
  }

  reasoningHistory.forEach(r => {
    const item = document.createElement("div");
    item.style.padding = "10px";
    item.style.borderBottom = "1px solid var(--border)";
    item.style.fontSize = "13px";

    const time = document.createElement("span");
    time.className = "muted";
    time.style.fontSize = "10px";
    time.style.display = "block";
    time.textContent = r.timestamp;

    const thought = document.createElement("div");
    thought.style.color = "#8d99ae";
    thought.style.marginBottom = "4px";
    thought.innerHTML = `<strong>Thought:</strong> ${r.thought}`;

    const intent = document.createElement("div");
    intent.style.fontSize = "12px";
    intent.style.marginBottom = "4px";
    intent.innerHTML = `<strong>Physical Intent:</strong> <em>${r.intent || "None"}</em>`;

    const decision = document.createElement("div");
    let typeLabel = "No Action";
    let typeColor = "#666";
    let actionLabel = r.action || "None";

    if (r.selection_type === "appropriate_action") {
      typeLabel = "Appropriate Action ✅";
      typeColor = "#4cc9f0";
    } else if (r.selection_type === "missing_action") {
      typeLabel = "Missing Action ⚠️";
      typeColor = "#ef233c";
      actionLabel = "NONE (Library Gap)";
    }

    decision.innerHTML = `<strong style="color:${typeColor}">${typeLabel}</strong>: ${actionLabel} (${(r.confidence * 100).toFixed(0)}% confidence)`;

    item.appendChild(time);
    item.appendChild(thought);
    item.appendChild(intent);
    item.appendChild(decision);
    container.appendChild(item);
  });
}

async function renderActionsTab() {
  const wrap = document.createElement("div");
  wrap.style.display = "grid";
  wrap.style.gridTemplateColumns = "1fr 1fr";
  wrap.style.gap = "20px";
  wrap.style.padding = "10px";
  wrap.style.height = "100%";

  // --- Left: Reasoning Log ---
  const leftCol = document.createElement("div");
  leftCol.style.display = "flex";
  leftCol.style.flexDirection = "column";
  leftCol.style.background = "rgba(0,0,0,0.2)";
  leftCol.style.borderRadius = "12px";
  leftCol.style.overflow = "hidden";

  const logHeader = document.createElement("div");
  logHeader.style.padding = "10px";
  logHeader.style.background = "rgba(255,255,255,0.05)";
  logHeader.style.borderBottom = "1px solid var(--border)";
  logHeader.innerHTML = "<strong>Reasoning Log (AI Thought Stream)</strong>";

  const logBody = document.createElement("div");
  logBody.id = "reasoning-log";
  logBody.style.flex = "1";
  logBody.style.overflowY = "auto";
  renderReasoningLog(logBody);

  leftCol.appendChild(logHeader);
  leftCol.appendChild(logBody);

  // --- Right: Manual action palette ---
  const rightCol = document.createElement("div");
  rightCol.style.display = "flex";
  rightCol.style.flexDirection = "column";
  rightCol.style.gap = "12px";

  const paletteHeader = document.createElement("div");
  paletteHeader.className = "muted";
  paletteHeader.style.fontSize = "12px";
  paletteHeader.textContent = "Manual Action Palette (Force Play)";

  const paletteBody = document.createElement("div");
  paletteBody.style.display = "grid";
  paletteBody.style.gridTemplateColumns = "repeat(auto-fill, minmax(120px, 1fr))";
  paletteBody.style.gap = "8px";

  // Fetch all animations if we haven't already
  try {
    const res = await fetch("http://localhost:8001/scan_animations"); // Re-using to check disk
    // But we need the registry too! 
    // Let's just create a new endpoint /get_registry_animations
  } catch (e) { }

  // For now, let's use the scan_animations to at least show something, 
  // but better to have the registry. 
  // I will add /get_registry_animations to chat_bridge and use it here.
  const regRes = await fetch("http://localhost:8001/get_registry_animations");
  const registryanims = await regRes.json();

  registryanims.forEach(anim => {
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.style.fontSize = "11px";
    btn.style.height = "auto";
    btn.style.padding = "8px";
    btn.style.textAlign = "left";
    btn.innerHTML = `<div>${anim.filename.split('/').pop()}</div><div class='muted' style='font-size:9px'>${anim.category}</div>`;
    btn.onclick = () => {
      if (!state.characterLoaded) return alert("Load a character first.");
      viewer.playIdleAnimation(`../assets/animations/${anim.filename}`, { loop: false });
    };
    paletteBody.appendChild(btn);
  });

  rightCol.appendChild(paletteHeader);
  rightCol.appendChild(paletteBody);

  wrap.appendChild(leftCol);
  wrap.appendChild(rightCol);

  sliderBank.innerHTML = "";
  sliderBank.appendChild(wrap);
}

function renderSlidersForTab(tabId) {
  const tab = getTab(tabId);
  const sliders = Array.isArray(tab?.sliders) ? tab.sliders : [];

  for (const s of sliders) {
    if (!sliderState.has(s.id)) sliderState.set(s.id, s.default ?? 0);

    const wrap = document.createElement("div");
    wrap.className = "slider";

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = s.label ?? s.id;

    const input = document.createElement("input");
    input.type = "range";
    input.min = s.min;
    input.max = s.max;
    input.step = s.step ?? 0.01;
    input.value = sliderState.get(s.id);

    const valueEl = document.createElement("div");
    valueEl.className = "value";

    const updateValueEl = (v) => {
      const step = Number(s.step ?? 0.01);
      const digits = Math.max(0, String(step).split(".")[1]?.length ?? 0);
      valueEl.textContent = Number(v).toFixed(Math.min(digits, 3));
    };
    updateValueEl(input.value);

    input.addEventListener("input", () => {
      let v = Number(input.value);
      v = clamp(v, Number(s.min), Number(s.max));
      v = roundToStep(v, Number(s.step ?? 0.01));
      sliderState.set(s.id, v);
      updateValueEl(v);

      // Keep preview in sync
      renderPayloadPreview(buildPayloadForTab(activeTabId));

      // ✅ LIVE UPDATE: Apply changes to model immediately
      if (state.characterLoaded) {
        applyActiveTab();
      }
    });

    wrap.appendChild(label);
    wrap.appendChild(input);
    wrap.appendChild(valueEl);
    sliderBank.appendChild(wrap);
  }
}

// --- Character + Scene
async function loadSelectedCharacter(characterId) {
  const entry = (manifest.characters || []).find((c) => c.id === characterId);
  if (!entry) {
    setStatus("Selected character not found in manifest.");
    return;
  }

  viewer.ensureInit("viewport");

  if (state.loadedCharacterId === entry.id) {
    state.characterLoaded = true;
    setStatus(`Loaded: ${entry.label ?? entry.id}`);
    return;
  }

  setStatus(`Loading ${entry.label ?? entry.id}...`);
  try {
    // Prepend ../ because app.js is in web/ and assets are in root/assets
    const vrmUrl = entry.vrm.startsWith("assets/") ? "../" + entry.vrm : entry.vrm;
    const info = await viewer.loadVRMFromUrl(vrmUrl);
    state.loadedCharacterId = entry.id;
    state.characterLoaded = true;
    if (characterSelect) characterSelect.value = entry.id;

    // --- Persist for Mind Map ---
    localStorage.setItem('active_actor_id', entry.id);
    document.getElementById('btn-mind-map').style.display = 'inline-flex';

    // Mount persona editor in left panel
    const editorMount = document.getElementById('persona-editor-mount');
    if (editorMount) mountPersonaEditor(editorMount, entry.id);

    setStatus(
      `Loaded: ${entry.label ?? entry.id} (hasNeck: ${info.hasNeck}, approxHeight: ${info.approxHeight?.toFixed?.(2) ?? "?"
      })`
    );
  } catch (e) {
    console.error(e);
    setStatus(`Failed to load VRM: ${String(e)}`);
  }
}

async function applyScene() {
  if (!state.characterLoaded) {
    setStatus("Load a character first.");
    return;
  }

  // Allow scene updates even if on 'actions' tab so we can frame characters during performance
  if (activeTabId === "animations") return;

  // Apply scene transforms + camera from sliders
  const p = buildPayloadForTab("scene");
  const v = p.values;

  const x = Number(v["scene.pos.x"] ?? 0);
  const y = Number(v["scene.pos.y"] ?? 0);
  const z = Number(v["scene.pos.z"] ?? 0);

  const dist = Number(v["scene.cam.dist"] ?? 2.2);
  const yaw = Number(v["scene.cam.yaw"] ?? 0);
  const pitch = Number(v["scene.cam.pitch"] ?? 0.2);

  const camMode = Number(v["scene.cam.mode"] ?? 0);
  const camX = Number(v["scene.cam.pos.x"] ?? 0);
  const camY = Number(v["scene.cam.pos.y"] ?? 1.5);
  const camZ = Number(v["scene.cam.pos.z"] ?? 2.2);

  viewer.setScenePosition(x, y, z);

  // Camera looks at character, with slight eye height.
  if (camMode === 1) {
    // FREE MODE (Manual XYZ + Rotation)
    viewer.setCameraPosition(camX, camY, camZ, false, yaw, pitch);
  } else {
    // ORBIT MODE (Spherical)
    viewer.setCameraSpherical(x, y + 1.35, z, dist, yaw, pitch);
  }

  // TEMP preview
  renderPayloadPreview({ ...p, character: state.loadedCharacterId });

  // NOTE: no gating changes here (scene does NOT unlock anything)
}

// --- Apply & Reset
function applyActiveTab() {
  if (activeTabId === "character") {
    // Character loads via its own button; Apply does nothing here by design.
    return;
  }

  if (!state.characterLoaded) {
    setStatus("Load a character first.");
    return;
  }

  if (activeTabId === "scene") {
    return applyScene();
  }

  const payload = buildPayloadForTab(activeTabId);
  renderPayloadPreview(payload);

  const values = payload.values || {};

  let headYaw = null;
  let headPitch = null;

  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith("preset.")) {
      viewer.setExpression(key.slice("preset.".length), value);
      continue;
    }
    if (key.startsWith("morph.")) {
      viewer.setMorphTarget(key.slice("morph.".length), value);
      continue;
    }
    if (key === "head.yaw") {
      headYaw = value;
      continue;
    }
    if (key === "head.pitch") {
      headPitch = value;
      continue;
    }
  }

  if (headYaw !== null || headPitch !== null) {
    viewer.setNeckYawPitch(headYaw ?? 0, headPitch ?? 0);
  }
}

function resetActiveTab() {
  const tab = getActiveTab();
  const sliders = Array.isArray(tab?.sliders) ? tab.sliders : [];
  if (sliders.length === 0) return;

  for (const s of sliders) {
    sliderState.set(s.id, s.default ?? 0);
  }

  renderTabContent(activeTabId);
  renderPayloadPreview(buildPayloadForTab(activeTabId));

  // ✅ LIVE RESET: Apply reset values to model immediately
  if (state.characterLoaded) {
    applyActiveTab();
  }
}

// --- Boot
function buildUiTabs() {
  // Character tab is UI-only (do NOT allow config to define another "character" tab)
  uiTabs = [{ id: "character", label: "Character", sliders: [] }];

  const seen = new Set(["character"]);

  // Config-driven tabs (scene + presets + morph groups + neck)
  for (const t of config.tabs || []) {
    const id = t.id;
    if (!id) continue;

    // Prevent duplicates (and prevent a second Character tab coming from config)
    if (seen.has(id)) continue;
    seen.add(id);

    uiTabs.push({
      id,
      label: t.label ?? id,
      sliders: Array.isArray(t.sliders) ? t.sliders : [],
    });
  }

  // If config doesn't contain scene, we still want a scene tab (so the UI doesn't break)
  if (!uiTabs.some((t) => t.id === "scene")) {
    uiTabs.splice(1, 0, {
      id: "scene",
      label: "Scene",
      sliders: [],
    });
  }

  // Animations tab (Idle only for now)
  if (!uiTabs.some((t) => t.id === "animations")) {
    uiTabs.push({ id: "animations", label: "Animations", sliders: [] });
  }

  // Chat tab (Interaction test)
  if (!uiTabs.some((t) => t.id === "chat")) {
    uiTabs.push({ id: "chat", label: "Chat 🧠🎙️", sliders: [] });
  }

  // Actions tab
  if (!uiTabs.some((t) => t.id === "actions")) {
    uiTabs.push({ id: "actions", label: "Actions 🎭🧐", sliders: [] });
  }
}

async function loadManifestIntoSceneSelect() {
  if (!characterSelect) return;

  characterSelect.innerHTML = "";
  for (const c of manifest.characters || []) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.label ?? c.id;
    characterSelect.appendChild(opt);
  }
}

async function main() {
  setStatus("Syncing with Headless Engine...");

  try {
    // 1. Fetch Controls from SQL Registry
    const cfgRes = await fetch(`${BRIDGE_BASE}/get_controls`);
    config = await cfgRes.json();

    // 2. Fetch Actors from SQL Registry
    const manRes = await fetch(`${BRIDGE_BASE}/get_actors`);
    manifest = await manRes.json();

    buildUiTabs();
    await loadManifestIntoSceneSelect();

    activeTabId = "character";
    renderTabs();
    renderTabContent(activeTabId);
    renderPayloadPreview(buildPayloadForTab(activeTabId));

    btnApply.addEventListener("click", applyActiveTab);
    btnReset.addEventListener("click", resetActiveTab);

    // Rig report export
    if (btnExportRig) {
      btnExportRig.addEventListener("click", () => {
        if (!state.characterLoaded) return;
        const rig = viewer.getRigReport?.();
        if (!rig) return;

        const blob = new Blob([JSON.stringify(rig, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `rig_report_${state.loadedCharacterId ?? "character"}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      });
    }

    setStatus("Headless Engine Connected. 🏛️🛡️");

  } catch (err) {
    console.error("Initialization failed:", err);
    setStatus("Bridge Error: Make sure core/chat_bridge.py is running on port 8001.");
    payloadPreview.textContent = `UI failed to reach Host Engine:\n${String(err)}`;
  }
}

// --- METADATA MODAL LOGIC ---
let unindexedQueue = [];
let isEditingMode = false;

async function checkUnindexedAnimations() {
  try {
    const res = await fetch("http://localhost:8001/scan_animations");
    if (!res.ok) return;

    const data = await res.json();

    unindexedQueue = [];
    for (const cat in data) {
      if (Array.isArray(data[cat])) {
        unindexedQueue.push(...data[cat]);
      }
    }

    if (unindexedQueue.length > 0) {
      console.log(`⚠️ Unindexed animations found: ${unindexedQueue.length}`);
      showMetadataModal();
    } else {
      console.log("✅ All animations indexed.");
    }
  } catch (e) {
    console.warn("Animation scan failed:", e);
  }
}

const modal = document.getElementById("metadata-modal");
const metaFilename = document.getElementById("meta-filename");
const metaCategory = document.getElementById("meta-category");
const metaTrigger = document.getElementById("meta-trigger");
const metaPurpose = document.getElementById("meta-purpose");
const metaEffect = document.getElementById("meta-effect");
const metaCount = document.getElementById("meta-count");
const metaSaveBtn = document.getElementById("meta-save-btn");

// Extended to support editing existing items
function showMetadataModal(editItem = null) {
  isEditingMode = !!editItem;

  if (!isEditingMode && unindexedQueue.length === 0) {
    hideMetadataModal();
    return;
  }

  const currentItem = editItem || unindexedQueue[0];

  if (modal) modal.style.display = "flex";

  if (metaFilename) metaFilename.value = currentItem.name || currentItem.filename;
  if (metaCategory) metaCategory.value = currentItem.category;

  // If editing, use existing values (passed in item), else default empty
  if (metaTrigger) {
    metaTrigger.value = currentItem.trigger_condition || "";
    metaTrigger.focus();
  }
  if (metaPurpose) metaPurpose.value = currentItem.action_purpose || "";
  if (metaEffect) metaEffect.value = currentItem.action_effect || "";

  if (metaCount) {
    metaCount.textContent = isEditingMode
      ? "Editing Metadata"
      : `${unindexedQueue.length} remaining`;
  }

  if (metaSaveBtn) metaSaveBtn.textContent = isEditingMode ? "Update" : "Save & Next";
}

function hideMetadataModal() {
  if (modal) modal.style.display = "none";
  isEditingMode = false;
}

if (metaSaveBtn) {
  metaSaveBtn.addEventListener("click", async () => {
    let item = isEditingMode ? null : unindexedQueue[0];

    // In edit mode, we need to reconstruct the item from the form (filename mainly)
    if (isEditingMode) {
      // We rely on the inputs being populated correctly or stored in a closure. 
      // Better: read from the disabled inputs
      item = {
        // This might be the short name? No, we need full path.
        // Wait, scan returns 'name' (short) and 'filename' (rel path).
        // For edit mode, we need to ensure we have the unique filename (rel path).
        // API expects 'filename' (rel path).
        // Let's store the full path in a data attribute or hidden field?
        // Or just trust the user didn't hack the readonly input? 
        // The readonly input shows 'name'. We need 'filename'.
        // Let's store it on the modal element.
        filename: modal.dataset.fullPath,
        category: metaCategory.value
      };
    }

    const trigger = metaTrigger.value.trim();
    const purpose = metaPurpose.value.trim();
    const effect = metaEffect.value.trim();

    if (!trigger || !purpose) {
      alert("Please fill out 'Trigger' and 'Purpose'.");
      return;
    }

    metaSaveBtn.textContent = "Saving...";
    metaSaveBtn.disabled = true;

    try {
      const res = await fetch("http://localhost:8001/index_animation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: item.filename,
          category: item.category,
          trigger,
          purpose,
          effect
        })
      });

      if (res.ok) {
        if (!isEditingMode) unindexedQueue.shift();

        metaSaveBtn.disabled = false;

        if (isEditingMode) {
          hideMetadataModal();
          alert("Updated successfully!");
        } else {
          metaSaveBtn.textContent = "Save & Next";
          if (unindexedQueue.length > 0) {
            showMetadataModal();
          } else {
            hideMetadataModal();
            alert("All animations indexed! System ready. 🚀");
          }
        }
      } else {
        alert("Error saving metadata.");
        metaSaveBtn.disabled = false;
        metaSaveBtn.textContent = "Try Again";
      }
    } catch (e) {
      console.error(e);
      alert("Connection error.");
      metaSaveBtn.disabled = false;
      metaSaveBtn.textContent = "Try Again";
    }
  });
}

// Helper to open edit modal
window.openEditModal = async (url, kind) => {
  // url is like "../assets/animations/..."
  // We need the relative path from assets/animations root to match DB.
  // DB stores e.g. "actions/oneshot/wave.fbx"
  // URL might be "assets/animations/actions/oneshot/wave.fbx"

  // Normalize path
  let relPath = url;
  if (relPath.includes("assets/animations/")) {
    relPath = relPath.split("assets/animations/")[1];
  } else if (relPath.startsWith("../")) {
    // handle ../assets/animations case
    relPath = relPath.split("assets/animations/")[1];
  }

  if (!relPath) return alert("Cannot edit this path type.");

  try {
    const res = await fetch("http://localhost:8001/get_animation_metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: relPath })
    });

    if (res.ok) {
      const data = await res.json();
      // Store full path for save
      if (modal) modal.dataset.fullPath = data.filename;
      showMetadataModal(data);
    } else {
      alert("This animation is not indexed yet.");
    }
  } catch (e) {
    console.error(e);
    alert("Failed to fetch metadata.");
  }
};

// Start checks
checkUnindexedAnimations();

main();
