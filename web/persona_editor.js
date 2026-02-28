/**
 * persona_editor.js — Persona & Knowledge Graph editor for the devtool left panel.
 * Provides two tabs: PERSONA (identity, moods, modes) and KNOWLEDGE (KG subjects + relations).
 */

const BRIDGE = 'http://localhost:8001';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function post(endpoint, body) {
  return fetch(`${BRIDGE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json());
}

function confBadge(v) {
  const n = parseFloat(v);
  if (n >= 0.8) return '<span class="pe-badge pe-badge-high">high</span>';
  if (n >= 0.5) return '<span class="pe-badge pe-badge-med">med</span>';
  return '<span class="pe-badge pe-badge-low">low</span>';
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let _actorId = null;
let _personaData = null;
let _kgData = null;

// ─────────────────────────────────────────────────────────────────────────────
// Mount — called once with the left panel body element and actor id
// ─────────────────────────────────────────────────────────────────────────────

export function mountPersonaEditor(container, actorId) {
  _actorId = actorId;
  container.innerHTML = `
    <div class="pe-root">
      <div class="pe-tabs">
        <button class="pe-tab active" data-tab="persona">🎭 Persona</button>
      </div>
      <div class="pe-body">
        <div class="pe-pane" id="pe-pane-persona">Loading…</div>
      </div>
    </div>`;

  container.querySelectorAll('.pe-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.pe-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.tab;
      container.querySelectorAll('.pe-pane').forEach(p => p.classList.add('pe-hidden'));
      container.querySelector(`#pe-pane-${target}`).classList.remove('pe-hidden');
    });
  });

  loadPersona(container);
}

// ─────────────────────────────────────────────────────────────────────────────
// PERSONA TAB
// ─────────────────────────────────────────────────────────────────────────────

async function loadPersona(container) {
  const pane = container.querySelector('#pe-pane-persona');
  pane.innerHTML = '<p class="pe-muted">Loading…</p>';
  const data = await fetch(`${BRIDGE}/persona/${encodeURIComponent(_actorId)}`).then(r => r.json()).catch(() => null);
  if (!data) { pane.innerHTML = '<p class="pe-muted pe-err">Could not reach bridge.</p>'; return; }
  _personaData = data;
  renderPersonaPane(pane, data);
}

function renderPersonaPane(pane, data) {
  const id = data.identity || {};
  const moods = data.moods || [];
  const modes = data.modes || [];
  const currentMood = data.current_mood || 'neutral';

  pane.innerHTML = `
    <!-- IDENTITY -->
    <section class="pe-section">
      <div class="pe-section-header">Identity Core</div>
      <label class="pe-label">Name</label>
      <input class="pe-input" id="pe-id-name" value="${esc(id.name || '')}" placeholder="Character name">

      <label class="pe-label">Core Traits <span class="pe-hint">Who she IS (2-3 sentences)</span></label>
      <textarea class="pe-textarea" id="pe-id-traits" rows="3">${esc(id.core_traits || '')}</textarea>

      <label class="pe-label">Speech Style <span class="pe-hint">Voice fingerprint</span></label>
      <textarea class="pe-textarea" id="pe-id-style" rows="2">${esc(id.speech_style || '')}</textarea>

      <label class="pe-label">Values <span class="pe-hint">What she protects / won't do</span></label>
      <textarea class="pe-textarea" id="pe-id-values" rows="2">${esc(id.values || '')}</textarea>

      <button class="pe-btn pe-btn-primary" id="pe-save-identity">Save Identity</button>
    </section>

    <!-- MOODS -->
    <section class="pe-section">
      <div class="pe-section-header">
        Moods
        <span class="pe-current-mood">Active: <strong>${esc(currentMood)}</strong></span>
      </div>
      <div class="pe-mood-grid" id="pe-mood-grid">
        ${moods.map(m => renderMoodCard(m, currentMood)).join('')}
      </div>
      <button class="pe-btn pe-btn-ghost" id="pe-add-mood">+ New Mood</button>
    </section>

    <!-- MODES -->
    <section class="pe-section">
      <div class="pe-section-header">Mode Prompts</div>
      <div class="pe-accordion" id="pe-mode-accordion">
        ${modes.map(renderModeRow).join('')}
      </div>
      <button class="pe-btn pe-btn-ghost" id="pe-add-mode">+ New Mode</button>
    </section>`;

  // Save identity
  pane.querySelector('#pe-save-identity').addEventListener('click', async () => {
    const btn = pane.querySelector('#pe-save-identity');
    btn.textContent = 'Saving…'; btn.disabled = true;
    await post('/save_identity', {
      actor_id: _actorId,
      name: pane.querySelector('#pe-id-name').value,
      core_traits: pane.querySelector('#pe-id-traits').value,
      speech_style: pane.querySelector('#pe-id-style').value,
      values: pane.querySelector('#pe-id-values').value,
    });
    btn.textContent = 'Saved ✓'; setTimeout(() => { btn.textContent = 'Save Identity'; btn.disabled = false; }, 1500);
  });

  // Mood: activate on click, save on edit
  pane.querySelectorAll('.pe-mood-card').forEach(card => wireMoodCard(card, pane));
  pane.querySelector('#pe-add-mood')?.addEventListener('click', () => addMoodForm(pane));

  // Mode: expand accordion rows
  pane.querySelectorAll('.pe-mode-row').forEach(row => wireModeRow(row));
  pane.querySelector('#pe-add-mode')?.addEventListener('click', () => addModeForm(pane));
}

function renderMoodCard(mood, currentMood) {
  const active = mood.mood_id === currentMood ? 'pe-mood-active' : '';
  return `<div class="pe-mood-card ${active}" data-mood-id="${esc(mood.mood_id)}">
    <div class="pe-mood-name">${esc(mood.display_name)}</div>
    <textarea class="pe-mood-text" rows="3">${esc(mood.behavioral_text)}</textarea>
    <div class="pe-mood-footer">
      <button class="pe-btn pe-btn-xs pe-activate-mood">Activate</button>
      <button class="pe-btn pe-btn-xs pe-btn-primary pe-save-mood">Save</button>
    </div>
  </div>`;
}

function wireMoodCard(card, pane) {
  const moodId = card.dataset.moodId;
  card.querySelector('.pe-activate-mood').addEventListener('click', async () => {
    await post('/set_mood', { actor_id: _actorId, mood_id: moodId });
    pane.querySelectorAll('.pe-mood-card').forEach(c => c.classList.remove('pe-mood-active'));
    card.classList.add('pe-mood-active');
    pane.querySelector('.pe-current-mood strong').textContent = moodId;
  });
  card.querySelector('.pe-save-mood').addEventListener('click', async () => {
    const btn = card.querySelector('.pe-save-mood');
    btn.textContent = '…'; btn.disabled = true;
    const moodData = _personaData.moods.find(m => m.mood_id === moodId) || {};
    await post('/save_mood', {
      actor_id: _actorId, mood_id: moodId,
      display_name: moodData.display_name || moodId,
      behavioral_text: card.querySelector('.pe-mood-text').value,
      transition_up: moodData.transition_up, transition_down: moodData.transition_down,
    });
    btn.textContent = '✓'; setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1200);
  });
}

function addMoodForm(pane) {
  const form = document.createElement('div');
  form.className = 'pe-add-form';
  form.innerHTML = `
    <input class="pe-input pe-input-sm" placeholder="mood_id (e.g. playful)" id="nma-id">
    <input class="pe-input pe-input-sm" placeholder="Display Name (e.g. Playful)" id="nma-name">
    <textarea class="pe-textarea" rows="2" placeholder="Behavioral instructions…" id="nma-text"></textarea>
    <div class="pe-form-row">
      <button class="pe-btn pe-btn-primary pe-btn-sm" id="nma-save">Add Mood</button>
      <button class="pe-btn pe-btn-ghost pe-btn-sm" id="nma-cancel">Cancel</button>
    </div>`;
  pane.querySelector('#pe-mood-grid').appendChild(form);
  form.querySelector('#nma-cancel').addEventListener('click', () => form.remove());
  form.querySelector('#nma-save').addEventListener('click', async () => {
    const mid = form.querySelector('#nma-id').value.trim();
    const name = form.querySelector('#nma-name').value.trim();
    const txt = form.querySelector('#nma-text').value.trim();
    if (!mid || !name) return;
    await post('/save_mood', { actor_id: _actorId, mood_id: mid, display_name: name, behavioral_text: txt });
    loadPersona(pane.closest('.pe-root').parentElement);
  });
}

function renderModeRow(mode) {
  return `<div class="pe-mode-row" data-mode-id="${esc(mode.mode_id)}">
    <div class="pe-mode-header">
      <span class="pe-mode-name">${esc(mode.display_name)}</span>
      ${mode.trigger_prefix ? `<code class="pe-trigger">${esc(mode.trigger_prefix)}</code>` : '<span class="pe-muted">manual</span>'}
      <button class="pe-mode-toggle">▾</button>
    </div>
    <div class="pe-mode-body pe-hidden">
      <textarea class="pe-textarea pe-mode-text" rows="5">${esc(mode.system_text)}</textarea>
      <input class="pe-input pe-input-sm" placeholder="trigger_prefix (optional)" value="${esc(mode.trigger_prefix || '')}">
      <button class="pe-btn pe-btn-primary pe-btn-sm pe-save-mode">Save Mode</button>
    </div>
  </div>`;
}

function wireModeRow(row) {
  row.querySelector('.pe-mode-toggle').addEventListener('click', () => {
    row.querySelector('.pe-mode-body').classList.toggle('pe-hidden');
  });
  row.querySelector('.pe-save-mode').addEventListener('click', async () => {
    const btn = row.querySelector('.pe-save-mode');
    btn.textContent = 'Saving…'; btn.disabled = true;
    const modeId = row.dataset.modeId;
    const modeData = _personaData.modes.find(m => m.mode_id === modeId) || {};
    await post('/save_mode', {
      actor_id: _actorId, mode_id: modeId,
      display_name: modeData.display_name || modeId,
      system_text: row.querySelector('.pe-mode-text').value,
      trigger_prefix: row.querySelectorAll('.pe-input-sm')[0]?.value || null,
    });
    btn.textContent = 'Saved ✓'; setTimeout(() => { btn.textContent = 'Save Mode'; btn.disabled = false; }, 1500);
  });
}

function addModeForm(pane) {
  const form = document.createElement('div');
  form.className = 'pe-add-form';
  form.innerHTML = `
    <input class="pe-input pe-input-sm" placeholder="mode_id (e.g. gaming)" id="nmo-id">
    <input class="pe-input pe-input-sm" placeholder="Display Name" id="nmo-name">
    <input class="pe-input pe-input-sm" placeholder="trigger_prefix (optional)" id="nmo-trigger">
    <textarea class="pe-textarea" rows="3" placeholder="Mode instructions…" id="nmo-text"></textarea>
    <div class="pe-form-row">
      <button class="pe-btn pe-btn-primary pe-btn-sm" id="nmo-save">Add Mode</button>
      <button class="pe-btn pe-btn-ghost pe-btn-sm" id="nmo-cancel">Cancel</button>
    </div>`;
  pane.querySelector('#pe-mode-accordion').appendChild(form);
  form.querySelector('#nmo-cancel').addEventListener('click', () => form.remove());
  form.querySelector('#nmo-save').addEventListener('click', async () => {
    await post('/save_mode', {
      actor_id: _actorId,
      mode_id: form.querySelector('#nmo-id').value.trim(),
      display_name: form.querySelector('#nmo-name').value.trim(),
      system_text: form.querySelector('#nmo-text').value.trim(),
      trigger_prefix: form.querySelector('#nmo-trigger').value.trim() || null,
    });
    loadPersona(pane.closest('.pe-root').parentElement);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE TAB
// ─────────────────────────────────────────────────────────────────────────────

async function loadKG(container) {
  const pane = container.querySelector('#pe-pane-knowledge');
  pane.innerHTML = '<p class="pe-muted">Loading…</p>';
  const data = await fetch(`${BRIDGE}/kg/${encodeURIComponent(_actorId)}`).then(r => r.json()).catch(() => null);
  if (!data) { pane.innerHTML = '<p class="pe-muted pe-err">Could not reach bridge.</p>'; return; }
  _kgData = data;
  renderKGPane(pane, data);
}

function renderKGPane(pane, data) {
  const subjects = data.subjects || [];

  pane.innerHTML = `
    <section class="pe-section">
      <div class="pe-section-header">
        Subjects
        <span class="pe-muted">${subjects.length} known</span>
      </div>

      <!-- Search -->
      <input class="pe-input pe-input-sm" id="kg-search" placeholder="Search subjects…">

      <!-- Subject list -->
      <div class="pe-subject-list" id="kg-subject-list">
        ${subjects.length === 0
      ? '<p class="pe-muted">No subjects yet. Add the first one below.</p>'
      : subjects.map(renderSubjectCard).join('')}
      </div>

      <!-- Add subject form -->
      <div class="pe-add-form" id="kg-add-form" style="display:none">
        <div class="pe-form-row">
          <input class="pe-input pe-input-sm" placeholder="Name (canonical)" id="kg-name">
          <select class="pe-select" id="kg-type">
            <option>character</option><option>place</option><option>concept</option>
            <option>event</option><option>object</option>
          </select>
        </div>
        <input class="pe-input pe-input-sm" placeholder="Aliases (comma separated)" id="kg-aliases">
        <textarea class="pe-textarea" rows="2" placeholder="Description" id="kg-desc"></textarea>
        <div class="pe-form-row">
          <label class="pe-label pe-inline">Confidence</label>
          <input type="range" id="kg-conf" min="0" max="1" step="0.05" value="1">
          <span id="kg-conf-val">1.0</span>
        </div>
        <div class="pe-form-row">
          <button class="pe-btn pe-btn-primary pe-btn-sm" id="kg-save-sub">Add Subject</button>
          <button class="pe-btn pe-btn-ghost pe-btn-sm" id="kg-cancel-sub">Cancel</button>
        </div>
      </div>
      <button class="pe-btn pe-btn-ghost" id="kg-show-add">+ Add Subject</button>
    </section>`;

  // Search filter
  pane.querySelector('#kg-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    pane.querySelectorAll('.pe-subject-card').forEach(card => {
      card.style.display = card.dataset.name.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  // Wire subject cards
  pane.querySelectorAll('.pe-subject-card').forEach(card => wireSubjectCard(card, pane));

  // Show add form
  pane.querySelector('#kg-show-add').addEventListener('click', () => {
    pane.querySelector('#kg-add-form').style.display = '';
    pane.querySelector('#kg-show-add').style.display = 'none';
  });
  pane.querySelector('#kg-cancel-sub').addEventListener('click', () => {
    pane.querySelector('#kg-add-form').style.display = 'none';
    pane.querySelector('#kg-show-add').style.display = '';
  });

  // Confidence slider display
  const rangeEl = pane.querySelector('#kg-conf');
  const confVal = pane.querySelector('#kg-conf-val');
  rangeEl.addEventListener('input', () => confVal.textContent = parseFloat(rangeEl.value).toFixed(2));

  // Save new subject
  pane.querySelector('#kg-save-sub').addEventListener('click', async () => {
    const btn = pane.querySelector('#kg-save-sub');
    btn.textContent = 'Saving…'; btn.disabled = true;
    await post('/kg_save_subject', {
      actor_id: _actorId,
      canonical_name: pane.querySelector('#kg-name').value.trim(),
      subject_type: pane.querySelector('#kg-type').value,
      aliases: pane.querySelector('#kg-aliases').value,
      description: pane.querySelector('#kg-desc').value.trim(),
      confidence: parseFloat(pane.querySelector('#kg-conf').value),
    });
    loadKG(pane.closest('.pe-root').parentElement);
  });
}

function renderSubjectCard(s) {
  const rels = (s.relations || []).slice(0, 6);
  const relHtml = rels.length ? rels.map(r => {
    const obj = r.object_name || r.object_literal || '?';
    return `<div class="pe-rel-row">
      <span class="pe-rel-sub">${esc(r.subject_name)}</span>
      <span class="pe-rel-pred">${esc(r.predicate)}</span>
      <span class="pe-rel-obj">${esc(obj)}</span>
      ${confBadge(r.confidence)}
    </div>`;
  }).join('') : '<p class="pe-muted pe-rel-empty">No relations yet.</p>';

  return `<div class="pe-subject-card" data-subject-id="${s.subject_id}" data-name="${esc(s.canonical_name)}">
    <div class="pe-subject-header">
      <div>
        <span class="pe-subject-name">${esc(s.canonical_name)}</span>
        <code class="pe-type-badge">${esc(s.subject_type)}</code>
        ${confBadge(s.confidence)}
      </div>
      <button class="pe-subject-delete" title="Delete subject">&times;</button>
    </div>
    <p class="pe-subject-desc">${esc(s.description || 'No description.')}</p>

    <div class="pe-rels">
      <div class="pe-rels-header">Relations <button class="pe-btn pe-btn-xs pe-btn-ghost pe-add-rel-btn">+ Add</button></div>
      <div class="pe-rel-list">${relHtml}</div>
      <div class="pe-rel-form pe-hidden">
        <input class="pe-input pe-input-sm" placeholder="predicate (verb)" id="rf-pred-${s.subject_id}">
        <select class="pe-select" id="rf-obj-type-${s.subject_id}">
          <option value="subject">Subject (entity)</option>
          <option value="literal">Literal (text)</option>
        </select>
        <input class="pe-input pe-input-sm" id="rf-obj-${s.subject_id}" placeholder="object name or text">
        <div class="pe-form-row">
          <input type="range" id="rf-conf-${s.subject_id}" min="0" max="1" step="0.05" value="0.9">
          <span id="rf-conf-val-${s.subject_id}">0.9</span>
        </div>
        <button class="pe-btn pe-btn-primary pe-btn-sm pe-save-rel-btn">Save Relation</button>
      </div>
    </div>
  </div>`;
}

function wireSubjectCard(card, pane) {
  const sid = parseInt(card.dataset.subjectId);

  // Delete subject
  card.querySelector('.pe-subject-delete').addEventListener('click', async () => {
    if (!confirm(`Delete "${card.dataset.name}" and all its relations?`)) return;
    await post('/kg_delete_subject', { actor_id: _actorId, subject_id: sid });
    loadKG(pane.closest('.pe-root').parentElement);
  });

  // Toggle add-relation form
  card.querySelector('.pe-add-rel-btn').addEventListener('click', () => {
    card.querySelector('.pe-rel-form').classList.toggle('pe-hidden');
  });

  // Confidence slider
  const rangeEl = card.querySelector(`#rf-conf-${sid}`);
  const confValEl = card.querySelector(`#rf-conf-val-${sid}`);
  rangeEl?.addEventListener('input', () => confValEl.textContent = parseFloat(rangeEl.value).toFixed(2));

  // Save relation
  card.querySelector('.pe-save-rel-btn')?.addEventListener('click', async () => {
    const btn = card.querySelector('.pe-save-rel-btn');
    btn.textContent = 'Saving…'; btn.disabled = true;

    const predicate = card.querySelector(`#rf-pred-${sid}`).value.trim();
    const objType = card.querySelector(`#rf-obj-type-${sid}`).value;
    const objRaw = card.querySelector(`#rf-obj-${sid}`).value.trim();
    const confidence = parseFloat(rangeEl.value);

    let objectId = null;
    let objectLiteral = null;

    if (objType === 'subject') {
      const match = (_kgData?.subjects || []).find(s => s.canonical_name.toLowerCase() === objRaw.toLowerCase());
      if (match) objectId = match.subject_id;
      else objectLiteral = objRaw; // fallback to literal if not found
    } else {
      objectLiteral = objRaw;
    }

    await post('/kg_save_relation', {
      actor_id: _actorId, subject_id: sid, predicate,
      object_id: objectId, object_literal: objectLiteral, confidence,
    });
    loadKG(pane.closest('.pe-root').parentElement);
  });
}
