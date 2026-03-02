import { viewer } from "./viewer.js";
import { mountPersonaEditor } from "./persona_editor.js";

// --- Bridge API Base (Headless Engine)
const BRIDGE_BASE = "http://localhost:8001";

const IDLE_ANIM_BASE = "../assets/animations/idle";
const DEFAULT_OVERLAY_TUNE = {
  cheekSpanX: 0.04,
  cheekY: 0.02,
  cheekZ: 0.15,
  cheekSize: 1.04,
  cheekOpacity: 0.58,
};

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
  moodTester: {
    autoEnabled: true,
    selectedMood: "neutral",
    intensity: 1.0,
    variation: 0.2,
    overlayAuto: true,
    emojiOverlay: "",
    faceOverlay: "none",
    overlayTune: {
      ...DEFAULT_OVERLAY_TUNE,
    },
  },
  // animations UI state
  animations: {
    enabled: false,
    idleItems: [], // { label, url, kind: "loop"|"oneshot" }
    loaded: false,
    loading: false,
  },
  onboarding: {
    characterLoadedPersisted: false,
    preflightCompleted: false,
    preflightPassed: false,
    leftPanelOpened: false,
    traitsSaved: false,
    firstChatSent: false,
    animationsScanned: false,
    audioChecked: false,
  },
  preflight: {
    running: false,
    report: null,
    error: "",
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
document.getElementById("btn-open-left")?.addEventListener("click", () => {
  panelLeft?.classList.toggle("open");
  if (state.characterLoaded) markOnboarding("leftPanelOpened", true);
});
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

function getOnboardingStorageKey(actorId) {
  return `onboarding_${actorId || "unknown"}`;
}

function loadOnboarding(actorId) {
  state.onboarding = {
    characterLoadedPersisted: false,
    preflightCompleted: false,
    preflightPassed: false,
    leftPanelOpened: false,
    traitsSaved: false,
    firstChatSent: false,
    animationsScanned: false,
    audioChecked: false,
  };
  state.preflight = {
    running: false,
    report: null,
    error: "",
  };
  if (!actorId) return;
  try {
    const raw = localStorage.getItem(getOnboardingStorageKey(actorId));
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.onboarding = { ...state.onboarding, ...parsed };
  } catch {
    // Ignore malformed stored state.
  }
}

async function hydrateOnboardingFromBackend(actorId) {
  if (!actorId) return;
  try {
    const url = `${BRIDGE_BASE}/onboarding_status?actor_id=${encodeURIComponent(actorId)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    if (data.traits_present) state.onboarding.traitsSaved = true;
    if (data.has_dialogue) state.onboarding.firstChatSent = true;
    if (data.has_indexed_animations) state.onboarding.animationsScanned = true;
    saveOnboarding(actorId);
    refreshCharacterTabIfActive();
  } catch {
    // Non-fatal: keep local onboarding only.
  }
}

function saveOnboarding(actorId) {
  if (!actorId) return;
  localStorage.setItem(getOnboardingStorageKey(actorId), JSON.stringify(state.onboarding));
}

function refreshCharacterTabIfActive() {
  if (activeTabId !== "character") return;
  renderTabContent(activeTabId);
  renderPayloadPreview(buildPayloadForTab(activeTabId));
}

function markOnboarding(key, value = true) {
  if (!(key in state.onboarding)) return;
  if (state.onboarding[key] === value) return;
  state.onboarding[key] = value;
  saveOnboarding(getActiveActorId());
  refreshCharacterTabIfActive();
}

async function runPreflightCheck(modelName) {
  state.preflight.running = true;
  state.preflight.error = "";
  refreshCharacterTabIfActive();
  try {
    const url = `${BRIDGE_BASE}/preflight?model=${encodeURIComponent(modelName || "")}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error("Preflight endpoint not found on port 8001. Restart bridge/launch.py to load latest backend.");
      }
      throw new Error(`Preflight HTTP ${res.status}`);
    }
    const data = await res.json();
    state.preflight.report = data;
    state.preflight.error = "";
    markOnboarding("preflightCompleted", true);
    markOnboarding("preflightPassed", !!(data.all_required_passed ?? data.all_passed));
    return data;
  } catch (err) {
    state.preflight.error = String(err);
    state.preflight.report = null;
    markOnboarding("preflightCompleted", false);
    markOnboarding("preflightPassed", false);
    return null;
  } finally {
    state.preflight.running = false;
    refreshCharacterTabIfActive();
  }
}

function getActiveActorId() {
  return (
    state.loadedCharacterId ||
    localStorage.getItem("active_actor_id") ||
    manifest.characters?.[0]?.id ||
    "Unknown_Actor"
  );
}

function sanitizeOverlayTune(raw) {
  const src = (raw && typeof raw === "object") ? raw : {};
  const readNum = (key, fallback) => {
    const n = Number(src[key]);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    cheekSpanX: clamp(readNum("cheekSpanX", DEFAULT_OVERLAY_TUNE.cheekSpanX), 0.02, 0.2),
    cheekY: clamp(readNum("cheekY", DEFAULT_OVERLAY_TUNE.cheekY), -0.2, 0.1),
    cheekZ: clamp(readNum("cheekZ", DEFAULT_OVERLAY_TUNE.cheekZ), -0.05, 0.25),
    cheekSize: clamp(readNum("cheekSize", DEFAULT_OVERLAY_TUNE.cheekSize), 0.4, 2.0),
    cheekOpacity: clamp(readNum("cheekOpacity", DEFAULT_OVERLAY_TUNE.cheekOpacity), 0.0, 2.0),
  };
}

function getOverlayTuneStorageKey(actorId) {
  return `mood_overlay_tune_${actorId || "unknown"}`;
}

function loadOverlayTuneLocal(actorId) {
  try {
    const raw = localStorage.getItem(getOverlayTuneStorageKey(actorId));
    if (!raw) return { ...DEFAULT_OVERLAY_TUNE };
    return sanitizeOverlayTune(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_OVERLAY_TUNE };
  }
}

function applyOverlayTuneForActor(actorId) {
  state.moodTester.overlayTune = loadOverlayTuneLocal(actorId);
  viewer.setMoodOverlayTuning?.(state.moodTester.overlayTune);
}

let overlayTuneSaveTimer = null;
function persistOverlayTuneForActor(actorId) {
  if (!actorId) return;
  localStorage.setItem(getOverlayTuneStorageKey(actorId), JSON.stringify(state.moodTester.overlayTune));
  if (overlayTuneSaveTimer) clearTimeout(overlayTuneSaveTimer);
  overlayTuneSaveTimer = setTimeout(() => {
    saveTrait("mood_overlay_tune", state.moodTester.overlayTune).catch((e) =>
      console.warn("Failed to persist mood overlay tune to backend:", e)
    );
  }, 250);
}

async function hydrateOverlayTuneFromBackend(actorId) {
  if (!actorId) return;
  try {
    const res = await fetch(`${BRIDGE_BASE}/get_traits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor_id: actorId }),
    });
    if (!res.ok) return;
    const traits = await res.json();
    if (traits && typeof traits.mood_overlay_tune === "object") {
      state.moodTester.overlayTune = sanitizeOverlayTune(traits.mood_overlay_tune);
      localStorage.setItem(getOverlayTuneStorageKey(actorId), JSON.stringify(state.moodTester.overlayTune));
      viewer.setMoodOverlayTuning?.(state.moodTester.overlayTune);
      if (activeTabId === "moods") renderTabContent(activeTabId);
    }
  } catch (e) {
    console.warn("Overlay tune backend hydration failed:", e);
  }
}

function getTab(tabId) {
  return uiTabs.find((t) => t.id === tabId) || null;
}
function getActiveTab() {
  return getTab(activeTabId);
}

function isMixerTab(tabId) {
  const tab = getTab(tabId);
  const sliders = Array.isArray(tab?.sliders) ? tab.sliders : [];
  return sliders.some((s) => {
    const id = String(s?.id || "");
    return id.startsWith("preset.") || id.startsWith("morph.");
  });
}

function syncFaceAutoModeForTab(tabId) {
  if (!state.characterLoaded) return;
  // In mixer/preset tabs, freeze auto face morph layering so manual sliders are testable.
  const shouldEnableAuto = !isMixerTab(tabId);
  viewer.setFaceAutoExpressionsEnabled?.(shouldEnableAuto);
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
      syncFaceAutoModeForTab(activeTabId);
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
    syncFaceAutoModeForTab(tabId);
    renderCharacterTab();
    return;
  }

  if (tabId === "animations") {
    syncFaceAutoModeForTab(tabId);
    renderAnimationsTab();
    return;
  }

  if (tabId === "moods") {
    syncFaceAutoModeForTab(tabId);
    renderMoodsTab();
    return;
  }

  if (tabId === "chat") {
    syncFaceAutoModeForTab(tabId);
    renderChatTab();
    return;
  }

  if (tabId === "actions") {
    syncFaceAutoModeForTab(tabId);
    renderActionsTab();
    return;
  }

  syncFaceAutoModeForTab(tabId);
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
    syncFaceAutoModeForTab(activeTabId);

    // ✅ After character load: unlock ALL tabs immediately (no second gate).
    setStatus("Character loaded.");

    // Optionally jump to Scene after load (nice flow)
    activeTabId = "scene";

    renderTabs();
    renderTabContent(activeTabId);
    renderPayloadPreview(buildPayloadForTab(activeTabId));
  };

  const effectiveOnboarding = {
    preflightStepDone: state.onboarding.preflightCompleted || !!state.preflight.report,
    characterLoaded: state.characterLoaded || state.onboarding.characterLoadedPersisted,
    leftPanelOpened: state.onboarding.leftPanelOpened,
    traitsSaved: state.onboarding.traitsSaved,
    firstChatSent: state.onboarding.firstChatSent,
    animationsScanned: state.animations.loaded || state.onboarding.animationsScanned,
    audioChecked: state.onboarding.audioChecked,
  };
  const completedCount = Object.values(effectiveOnboarding).filter(Boolean).length;
  const totalCount = Object.keys(effectiveOnboarding).length;
  const supportedPreflightModels = ["ministral-3:8b", "ministral-3:3b", "ministral-3:14b"];
  const savedPreflightModel = (localStorage.getItem("preflight_model") || "").trim();
  const preflightModel = supportedPreflightModels.includes(savedPreflightModel)
    ? savedPreflightModel
    : supportedPreflightModels[0];
  const preflightModelOptions = supportedPreflightModels
    .map((m) => `<option value="${m}" ${m === preflightModel ? "selected" : ""}>${m}</option>`)
    .join("");
  const preflightReport = state.preflight.report;
  const preflightSummary = preflightReport
    ? `${preflightReport.required_ok_count ?? preflightReport.ok_count ?? 0}/${preflightReport.required_total ?? preflightReport.total ?? 0} required passed${(preflightReport.warning_fail_count ?? 0) > 0 ? `, ${preflightReport.warning_fail_count} warning(s)` : ""}`
    : "Not run in this session";
  const preflightRows = (preflightReport?.checks || []).map((c) => `
    <div class="onboard-preflight-row ${c.ok ? "ok" : (c.severity === "warning" ? "warn" : "fail")}">
      <span class="onboard-preflight-name">${c.name}</span>
      <span class="onboard-preflight-badge ${c.severity === "warning" ? "warning" : "required"}">${c.severity === "warning" ? "warning" : "required"}</span>
      <span class="onboard-preflight-detail">${c.detail}</span>
      ${c.tooltip ? `<span class="onboard-preflight-tip" title="${c.tooltip}">ⓘ ${c.tooltip}</span>` : ""}
      ${c.ok ? "" : `<span class="onboard-preflight-fix">${c.fix || ""}</span>`}
    </div>
  `).join("");

  const checklist = document.createElement("div");
  checklist.className = "onboard-card";
  checklist.innerHTML = `
    <div class="onboard-header">
      <div class="onboard-title">Setup Wizard</div>
      <div class="onboard-progress">${completedCount}/${totalCount} complete</div>
    </div>
    <div class="onboard-preflight">
      <div class="onboard-preflight-head">
        <div class="muted">Step 1: Run preflight</div>
        <div class="onboard-preflight-summary">${preflightSummary}</div>
      </div>
      <div class="onboard-preflight-controls">
        <select id="onboard-model-input" class="onboard-model-input">
          ${preflightModelOptions}
        </select>
        <button id="onboard-run-preflight" class="secondary" type="button" ${state.preflight.running ? "disabled" : ""}>
          ${state.preflight.running ? "Running..." : "Run Preflight"}
        </button>
      </div>
      ${state.preflight.error ? `<div class="onboard-preflight-error">${state.preflight.error}</div>` : ""}
      ${preflightRows ? `<div class="onboard-preflight-list">${preflightRows}</div>` : ""}
    </div>
    <div class="onboard-steps">
      <label class="onboard-step ${effectiveOnboarding.preflightStepDone ? "done" : ""}">
        <input type="checkbox" disabled ${effectiveOnboarding.preflightStepDone ? "checked" : ""}>
        <span><strong>Step 1:</strong> Run preflight (warnings allowed)</span>
      </label>
      <label class="onboard-step ${effectiveOnboarding.characterLoaded ? "done" : ""}">
        <input type="checkbox" disabled ${effectiveOnboarding.characterLoaded ? "checked" : ""}>
        <span><strong>Step 2:</strong> Load character model</span>
      </label>
      <label class="onboard-step ${effectiveOnboarding.leftPanelOpened ? "done" : ""}">
        <input type="checkbox" disabled ${effectiveOnboarding.leftPanelOpened ? "checked" : ""}>
        <span><strong>Step 3:</strong> Open Character Editor (✏️)</span>
      </label>
      <label class="onboard-step ${effectiveOnboarding.traitsSaved ? "done" : ""}">
        <input type="checkbox" disabled ${effectiveOnboarding.traitsSaved ? "checked" : ""}>
        <span><strong>Step 4:</strong> Save persona/voice traits once</span>
      </label>
      <label class="onboard-step ${effectiveOnboarding.firstChatSent ? "done" : ""}">
        <input type="checkbox" disabled ${effectiveOnboarding.firstChatSent ? "checked" : ""}>
        <span><strong>Step 5:</strong> Send first chat</span>
      </label>
      <label class="onboard-step ${effectiveOnboarding.animationsScanned ? "done" : ""}">
        <input type="checkbox" disabled ${effectiveOnboarding.animationsScanned ? "checked" : ""}>
        <span><strong>Step 6:</strong> Open Animations tab (scan library)</span>
      </label>
      <label class="onboard-step ${effectiveOnboarding.audioChecked ? "done" : ""}">
        <input id="onboard-audio-check" type="checkbox" ${effectiveOnboarding.audioChecked ? "checked" : ""}>
        <span><strong>Step 7:</strong> I verified audio route (hear + speak)</span>
      </label>
    </div>
    <div class="onboard-actions">
      <button id="onboard-open-editor" class="secondary" type="button">Open Editor</button>
      <button id="onboard-open-chat" class="secondary" type="button">Go Chat</button>
      <button id="onboard-open-anims" class="secondary" type="button">Go Animations</button>
    </div>
  `;

  checklist.querySelector("#onboard-audio-check")?.addEventListener("change", (e) => {
    markOnboarding("audioChecked", e.target.checked);
  });
  checklist.querySelector("#onboard-run-preflight")?.addEventListener("click", async () => {
    const model = checklist.querySelector("#onboard-model-input")?.value?.trim() || "";
    localStorage.setItem("preflight_model", model || "ministral-3:8b");
    await runPreflightCheck(model || "ministral-3:8b");
  });
  checklist.querySelector("#onboard-open-editor")?.addEventListener("click", () => {
    panelLeft?.classList.add("open");
    if (state.characterLoaded) markOnboarding("leftPanelOpened", true);
  });
  checklist.querySelector("#onboard-open-chat")?.addEventListener("click", () => {
    activeTabId = "chat";
    renderTabs();
    renderTabContent(activeTabId);
    renderPayloadPreview(buildPayloadForTab(activeTabId));
  });
  checklist.querySelector("#onboard-open-anims")?.addEventListener("click", () => {
    activeTabId = "animations";
    renderTabs();
    renderTabContent(activeTabId);
    renderPayloadPreview(buildPayloadForTab(activeTabId));
  });

  wrap.appendChild(select);
  wrap.appendChild(btn);
  wrap.appendChild(checklist);
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
    markOnboarding("animationsScanned", true);

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
// Moods tab (Face expression tuning)
// ---------------------------
function renderMoodsTab() {
  const wrap = document.createElement("div");
  wrap.className = "character-select";
  wrap.style.maxWidth = "760px";
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.gap = "12px";

  const title = document.createElement("div");
  title.className = "muted";
  title.style.fontSize = "12px";
  title.textContent = "Face Mood Tuning";

  const moodOptions = [
    { value: "neutral", label: "neutral" },
    { value: "positive", label: "positive" },
    { value: "negative_sad", label: "negative sad" },
    { value: "negative_embarrassed", label: "negative embarrassed" },
    { value: "negative_sad_embarrassed", label: "negative sad+embarrassed" },
    { value: "negative_anger", label: "negative anger" },
  ];
  const moodValues = moodOptions.map((m) => m.value);

  const rowTop = document.createElement("div");
  rowTop.style.display = "flex";
  rowTop.style.gap = "10px";
  rowTop.style.alignItems = "center";
  rowTop.style.flexWrap = "wrap";

  const autoChk = document.createElement("input");
  autoChk.type = "checkbox";
  autoChk.checked = !!state.moodTester.autoEnabled;

  const autoLbl = document.createElement("label");
  autoLbl.className = "muted";
  autoLbl.textContent = "Auto face mood enabled";

  const moodSelect = document.createElement("select");
  moodSelect.style.minWidth = "180px";
  moodOptions.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.value;
    opt.textContent = m.label;
    moodSelect.appendChild(opt);
  });
  if (!moodValues.includes(state.moodTester.selectedMood)) {
    state.moodTester.selectedMood = "neutral";
  }
  moodSelect.value = state.moodTester.selectedMood;

  rowTop.appendChild(autoChk);
  rowTop.appendChild(autoLbl);
  rowTop.appendChild(moodSelect);

  const makeSliderRow = (labelText, min, max, step, value) => {
    const row = document.createElement("div");
    row.style.display = "grid";
    row.style.gridTemplateColumns = "140px 1fr 52px";
    row.style.gap = "10px";
    row.style.alignItems = "center";

    const label = document.createElement("div");
    label.className = "muted";
    label.style.fontSize = "12px";
    label.textContent = labelText;

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);

    const val = document.createElement("div");
    val.className = "muted";
    val.style.textAlign = "right";
    val.textContent = Number(value).toFixed(2);

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(val);
    return { row, input, val };
  };

  const intensityRow = makeSliderRow("Intensity", 0, 1, 0.01, state.moodTester.intensity);
  const variationRow = makeSliderRow("Variation", 0, 1, 0.01, state.moodTester.variation);

  const overlayRow = document.createElement("div");
  overlayRow.style.display = "flex";
  overlayRow.style.gap = "10px";
  overlayRow.style.alignItems = "center";
  overlayRow.style.flexWrap = "wrap";

  const overlayAutoChk = document.createElement("input");
  overlayAutoChk.type = "checkbox";
  overlayAutoChk.checked = !!state.moodTester.overlayAuto;

  const overlayAutoLbl = document.createElement("label");
  overlayAutoLbl.className = "muted";
  overlayAutoLbl.textContent = "Auto overlays by mood";

  const emojiSelect = document.createElement("select");
  emojiSelect.style.minWidth = "130px";
  [
    { value: "", label: "Emoji: none" },
    { value: "💢", label: "Emoji: 💢 annoyed" },
    { value: "!!!", label: "Emoji: !!! upset" },
    { value: "💧", label: "Emoji: 💧 sad" },
  ].forEach((item) => {
    const opt = document.createElement("option");
    opt.value = item.value;
    opt.textContent = item.label;
    emojiSelect.appendChild(opt);
  });
  emojiSelect.value = state.moodTester.emojiOverlay;

  const faceOverlaySelect = document.createElement("select");
  faceOverlaySelect.style.minWidth = "180px";
  [
    { value: "none", label: "Face FX: none" },
    { value: "embarrassed_lines", label: "Face FX: embarrassed lines" },
  ].forEach((item) => {
    const opt = document.createElement("option");
    opt.value = item.value;
    opt.textContent = item.label;
    faceOverlaySelect.appendChild(opt);
  });
  faceOverlaySelect.value = state.moodTester.faceOverlay;

  overlayRow.appendChild(overlayAutoChk);
  overlayRow.appendChild(overlayAutoLbl);
  overlayRow.appendChild(emojiSelect);
  overlayRow.appendChild(faceOverlaySelect);

  const status = document.createElement("div");
  status.className = "muted";
  status.style.fontSize = "12px";
  status.textContent = "Auto overlay map: sad -> 💧, embarrassed -> lines, sad+embarrassed -> both, anger -> 💢/!!!.";

  const tuneTitle = document.createElement("div");
  tuneTitle.className = "muted";
  tuneTitle.style.fontSize = "12px";
  tuneTitle.textContent = "Embarrassed Lines Placement";

  const tuneSpanRow = makeSliderRow("Cheek Span X", 0.02, 0.2, 0.001, state.moodTester.overlayTune.cheekSpanX);
  const tuneYRow = makeSliderRow("Cheek Y", -0.2, 0.1, 0.001, state.moodTester.overlayTune.cheekY);
  const tuneZRow = makeSliderRow("Cheek Z", -0.05, 0.25, 0.001, state.moodTester.overlayTune.cheekZ);
  const tuneSizeRow = makeSliderRow("Cheek Size", 0.4, 2.0, 0.01, state.moodTester.overlayTune.cheekSize);
  const tuneOpacityRow = makeSliderRow("Cheek Opacity", 0.0, 2.0, 0.01, state.moodTester.overlayTune.cheekOpacity);

  const resolveAutoOverlays = () => {
    const mood = state.moodTester.selectedMood;
    const intensity = state.moodTester.intensity;
    if (mood === "negative_anger") {
      return {
        emoji: intensity >= 0.75 ? "!!!" : "💢",
        face: "none",
      };
    }
    if (mood === "negative_sad") {
      return {
        emoji: "💧",
        face: "none",
      };
    }
    if (mood === "negative_embarrassed") {
      return {
        emoji: "",
        face: "embarrassed_lines",
      };
    }
    if (mood === "negative_sad_embarrassed") {
      return {
        emoji: "💧",
        face: "embarrassed_lines",
      };
    }
    return { emoji: "", face: "none" };
  };

  const syncOverlayInputsDisabled = () => {
    const disabled = !!state.moodTester.overlayAuto;
    emojiSelect.disabled = disabled;
    faceOverlaySelect.disabled = disabled;
  };

  const applyMoodState = () => {
    if (!state.characterLoaded) return;
    viewer.setFaceAutoExpressionsEnabled?.(state.moodTester.autoEnabled);
    viewer.setFaceMoodVariationScale?.(state.moodTester.variation);
    viewer.setFaceMood?.(state.moodTester.selectedMood, state.moodTester.intensity);

    let emoji = state.moodTester.emojiOverlay;
    let face = state.moodTester.faceOverlay;
    if (state.moodTester.overlayAuto) {
      const auto = resolveAutoOverlays();
      emoji = auto.emoji;
      face = auto.face;
    }
    viewer.setMoodEmojiOverlay?.(emoji, state.moodTester.intensity);
    viewer.setMoodFaceOverlay?.(face, state.moodTester.intensity);
    viewer.setMoodOverlayTuning?.(state.moodTester.overlayTune);
  };

  autoChk.addEventListener("change", () => {
    state.moodTester.autoEnabled = autoChk.checked;
    applyMoodState();
  });

  moodSelect.addEventListener("change", () => {
    state.moodTester.selectedMood = moodSelect.value;
    applyMoodState();
  });

  intensityRow.input.addEventListener("input", () => {
    state.moodTester.intensity = Number(intensityRow.input.value);
    intensityRow.val.textContent = state.moodTester.intensity.toFixed(2);
    applyMoodState();
  });

  variationRow.input.addEventListener("input", () => {
    state.moodTester.variation = Number(variationRow.input.value);
    variationRow.val.textContent = state.moodTester.variation.toFixed(2);
    applyMoodState();
  });

  overlayAutoChk.addEventListener("change", () => {
    state.moodTester.overlayAuto = overlayAutoChk.checked;
    syncOverlayInputsDisabled();
    applyMoodState();
  });

  emojiSelect.addEventListener("change", () => {
    state.moodTester.emojiOverlay = emojiSelect.value;
    applyMoodState();
  });

  faceOverlaySelect.addEventListener("change", () => {
    state.moodTester.faceOverlay = faceOverlaySelect.value;
    applyMoodState();
  });

  tuneSpanRow.input.addEventListener("input", () => {
    state.moodTester.overlayTune.cheekSpanX = Number(tuneSpanRow.input.value);
    tuneSpanRow.val.textContent = state.moodTester.overlayTune.cheekSpanX.toFixed(3);
    persistOverlayTuneForActor(getActiveActorId());
    applyMoodState();
  });

  tuneYRow.input.addEventListener("input", () => {
    state.moodTester.overlayTune.cheekY = Number(tuneYRow.input.value);
    tuneYRow.val.textContent = state.moodTester.overlayTune.cheekY.toFixed(3);
    persistOverlayTuneForActor(getActiveActorId());
    applyMoodState();
  });

  tuneZRow.input.addEventListener("input", () => {
    state.moodTester.overlayTune.cheekZ = Number(tuneZRow.input.value);
    tuneZRow.val.textContent = state.moodTester.overlayTune.cheekZ.toFixed(3);
    persistOverlayTuneForActor(getActiveActorId());
    applyMoodState();
  });

  tuneSizeRow.input.addEventListener("input", () => {
    state.moodTester.overlayTune.cheekSize = Number(tuneSizeRow.input.value);
    tuneSizeRow.val.textContent = state.moodTester.overlayTune.cheekSize.toFixed(2);
    persistOverlayTuneForActor(getActiveActorId());
    applyMoodState();
  });

  tuneOpacityRow.input.addEventListener("input", () => {
    state.moodTester.overlayTune.cheekOpacity = Number(tuneOpacityRow.input.value);
    tuneOpacityRow.val.textContent = state.moodTester.overlayTune.cheekOpacity.toFixed(2);
    persistOverlayTuneForActor(getActiveActorId());
    applyMoodState();
  });

  const quickRow = document.createElement("div");
  quickRow.style.display = "flex";
  quickRow.style.flexWrap = "wrap";
  quickRow.style.gap = "8px";
  moodOptions.forEach((m) => {
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = m.label;
    btn.onclick = () => {
      state.moodTester.selectedMood = m.value;
      moodSelect.value = m.value;
      applyMoodState();
    };
    quickRow.appendChild(btn);
  });

  const btnApply = document.createElement("button");
  btnApply.className = "primary";
  btnApply.textContent = "Apply Mood";
  btnApply.onclick = applyMoodState;

  wrap.appendChild(title);
  wrap.appendChild(rowTop);
  wrap.appendChild(intensityRow.row);
  wrap.appendChild(variationRow.row);
  wrap.appendChild(overlayRow);
  wrap.appendChild(tuneTitle);
  wrap.appendChild(tuneSpanRow.row);
  wrap.appendChild(tuneYRow.row);
  wrap.appendChild(tuneZRow.row);
  wrap.appendChild(tuneSizeRow.row);
  wrap.appendChild(tuneOpacityRow.row);
  wrap.appendChild(quickRow);
  wrap.appendChild(btnApply);
  wrap.appendChild(status);

  sliderBank.appendChild(wrap);
  syncOverlayInputsDisabled();
  applyMoodState();
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
  voiceTitle.textContent = "Voice Description (TTS)";

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
    markOnboarding("traitsSaved", true);
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
        } else if (msg.type === 'assistant_text') {
          status.textContent = "TTS unavailable, text-only response delivered.";
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
          markOnboarding("firstChatSent", true);
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
    loadOnboarding(entry.id);
    applyOverlayTuneForActor(entry.id);
    markOnboarding("characterLoadedPersisted", true);
    await hydrateOnboardingFromBackend(entry.id);
    await hydrateOverlayTuneFromBackend(entry.id);
    document.getElementById('btn-mind-map').style.display = 'inline-flex';
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
    loadOnboarding(entry.id);
    applyOverlayTuneForActor(entry.id);
    markOnboarding("characterLoadedPersisted", true);
    await hydrateOnboardingFromBackend(entry.id);
    await hydrateOverlayTuneFromBackend(entry.id);
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

  // Moods tab (expression tuning)
  if (!uiTabs.some((t) => t.id === "moods")) {
    uiTabs.push({ id: "moods", label: "Moods 🙂", sliders: [] });
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
    loadOnboarding(getActiveActorId());
    await hydrateOnboardingFromBackend(getActiveActorId());

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
