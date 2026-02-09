import { viewer } from "./viewer.js";

const CONFIG_URL = "./controls.config.json";
const MANIFEST_URL = "./characters/manifest.json";

const IDLE_ANIM_BASE = "./animations/idle";

// --- State
let config = { tabs: [] };
let manifest = { characters: [] };

// Tabs we render (character tab is UI-only; the rest come from config)
let uiTabs = [];
let activeTabId = "character";

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
    if (state.animations.loaded || state.animations.loading) return;
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

  wrap.appendChild(title);
  wrap.appendChild(enabledRow);
  wrap.appendChild(select);
  wrap.appendChild(btnPlay);
  wrap.appendChild(btnRandom);
  wrap.appendChild(btnStop);
  wrap.appendChild(status);

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
    const info = await viewer.loadVRMFromUrl(entry.vrm);
    state.loadedCharacterId = entry.id;
    state.characterLoaded = true;
    if (characterSelect) characterSelect.value = entry.id;

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

  // Animations tab uses its own controls; Apply/Reset are not used.
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

  viewer.setScenePosition(x, y, z);

  // Camera looks at character, with slight eye height.
  viewer.setCameraSpherical(x, y + 1.35, z, dist, yaw, pitch);

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
  // Load config + manifest
  const [cfgRes, manRes] = await Promise.all([fetch(CONFIG_URL), fetch(MANIFEST_URL)]);
  config = await cfgRes.json();
  manifest = await manRes.json();

  buildUiTabs();
  await loadManifestIntoSceneSelect();

  activeTabId = "character";
  renderTabs();
  renderTabContent(activeTabId);
  renderPayloadPreview(buildPayloadForTab(activeTabId));

  btnApply.addEventListener("click", applyActiveTab);
  btnReset.addEventListener("click", resetActiveTab);

  // Rig report export (optional convenience)
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
}

main().catch((err) => {
  console.error(err);
  payloadPreview.textContent = `UI failed to load config:\n${String(err)}`;
});