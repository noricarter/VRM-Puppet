import sqlite3
import json
import os
from datetime import datetime

# Path relative to project root or absolute
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(PROJECT_ROOT, "core/persistence.db")

def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Builds the Three Regions foundational schema."""
    conn = get_connection()
    cursor = conn.cursor()

    print(f"Initializing SQL Authority at {DB_PATH}...")

    # --- Region 2: Artifacts (Existence) ---
    
    # Character Registry
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS registry_actors (
            actor_id TEXT PRIMARY KEY,
            vrm_path TEXT NOT NULL,
            manifest_data TEXT, -- Full JSON for deep traits
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # UI Controls Registry
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS registry_ui_controls (
            control_id TEXT PRIMARY KEY,
            tab_id TEXT NOT NULL,
            label TEXT,
            min REAL,
            max REAL,
            step REAL,
            "default" REAL,
            sort_order INTEGER
        )
    ''')

    # Workflow Registry
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS registry_workflows (
            workflow_id TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            node_mappings TEXT -- JSON mapping labels to node IDs
        )
    ''')

    # Animation Registry (Actions & Metadata)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS registry_animations (
            anim_id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT UNIQUE NOT NULL,
            category TEXT NOT NULL,
            trigger_condition TEXT,
            action_purpose TEXT,
            action_effect TEXT,
            indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # --- Region 1: Reality (Truth Right Now) ---
    
    # Global System State
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS reality_state (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Live Performance State (Sliders/Weights)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS reality_performance (
            actor_id TEXT,
            param_id TEXT,
            value REAL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (actor_id, param_id)
        )
    ''')

    # Live Actor Stats (Energy/Stamina)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS reality_actor_stats (
            actor_id TEXT PRIMARY KEY,
            stamina REAL DEFAULT 1.0,
            energy REAL DEFAULT 1.0,
            mood TEXT DEFAULT 'Neutral',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # --- Region 3: Memory (Past Artifacts) ---
    
    # Dialogue History
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS memory_dialogue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_id TEXT,
            role TEXT, -- 'user' or 'assistant'
            content TEXT,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Stat Logs (Heartbeats)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS memory_stats_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_id TEXT,
            stamina REAL,
            energy REAL,
            mood TEXT,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Memory Blocks (Condensed Concepts)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS memory_blocks (
            block_id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_id TEXT,
            content TEXT, -- Human/LLM-readable summary
            concepts TEXT, -- JSON list of extracted tags/ideas
            source_range TEXT, -- e.g. "msg_id_start:msg_id_end"
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # =========================================================
    # --- Modular Persona System ---
    # =========================================================

    # Structured identity (replaces flat manifest_data.persona)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS actor_identity (
            actor_id     TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            core_traits  TEXT,   -- Who she fundamentally is (2-3 sentences)
            speech_style TEXT,   -- Voice fingerprint: pacing, vocabulary, quirks
            "values"     TEXT,   -- What she protects / won't do
            updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Mood registry — each mood carries behavioral instructions
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS actor_moods (
            actor_id        TEXT NOT NULL,
            mood_id         TEXT NOT NULL,
            display_name    TEXT NOT NULL,
            behavioral_text TEXT NOT NULL,  -- How she speaks in this mood
            transition_up   TEXT,           -- mood_id this escalates to
            transition_down TEXT,           -- mood_id this de-escalates to
            PRIMARY KEY (actor_id, mood_id)
        )
    ''')

    # Mode prompt registry — per activity context
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS actor_mode_prompts (
            actor_id       TEXT NOT NULL,
            mode_id        TEXT NOT NULL,
            display_name   TEXT NOT NULL,
            system_text    TEXT NOT NULL,  -- Environmental/behavioral instructions for this mode
            trigger_prefix TEXT,           -- Message prefix that auto-activates (nullable = manual only)
            is_active      INTEGER DEFAULT 1,
            PRIMARY KEY (actor_id, mode_id)
        )
    ''')

    # =========================================================
    # --- Knowledge Graph (KG) ---
    # =========================================================

    # Subjects — entities she knows about
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS kg_subjects (
            subject_id     INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_id       TEXT NOT NULL,
            canonical_name TEXT NOT NULL,
            aliases        TEXT,           -- JSON list of alternate names
            subject_type   TEXT NOT NULL,  -- "character"|"place"|"concept"|"event"|"object"
            description    TEXT,
            confidence     REAL DEFAULT 1.0,
            source         TEXT,           -- "observer"|"user_statement"|"manual"
            first_seen     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_updated   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_kg_subjects_actor ON kg_subjects(actor_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_kg_subjects_name ON kg_subjects(canonical_name)')

    # Subject hierarchy — taxonomy / ontology tree
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS kg_hierarchy (
            child_id       INTEGER NOT NULL REFERENCES kg_subjects(subject_id),
            parent_id      INTEGER NOT NULL REFERENCES kg_subjects(subject_id),
            relation_label TEXT DEFAULT "is_a",  -- "is_a"|"part_of"|"instance_of"
            PRIMARY KEY (child_id, parent_id)
        )
    ''')

    # Relations — subject-predicate-object triples
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS kg_relations (
            relation_id     INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_id        TEXT NOT NULL,
            subject_id      INTEGER NOT NULL REFERENCES kg_subjects(subject_id),
            predicate       TEXT NOT NULL,    -- Verb/action: "hates", "works_with", "wants"
            object_id       INTEGER REFERENCES kg_subjects(subject_id),
            object_literal  TEXT,             -- For non-entity objects
            confidence      REAL DEFAULT 1.0,
            source          TEXT,
            timestamp       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_kg_relations_subject ON kg_relations(subject_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_kg_relations_object ON kg_relations(object_id)')

    # Embeddings — vector search layer (Phase 2)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS kg_embeddings (
            subject_id     INTEGER REFERENCES kg_subjects(subject_id),
            embedding_json TEXT,   -- JSON float array
            model_used     TEXT,
            indexed_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (subject_id)
        )
    ''')

    conn.commit()
    conn.close()
    print("Authority established. 🏛️🛡️")


# --- CRUD Methods ---

# --- Reality (Region 1) ---

def set_reality(key, value):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO reality_state (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
    ''', (key, str(value)))
    conn.commit()
    conn.close()

def get_reality(key, default=None):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT value FROM reality_state WHERE key = ?', (key,))
    row = cursor.fetchone()
    conn.close()
    return row['value'] if row else default

def set_performance(actor_id, param_id, value):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO reality_performance (actor_id, param_id, value, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ''', (actor_id, param_id, float(value)))
    conn.commit()
    conn.close()

def get_performance(actor_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT param_id, value FROM reality_performance WHERE actor_id = ?', (actor_id,))
    rows = cursor.fetchall()
    conn.close()
    return {r['param_id']: r['value'] for r in rows}

def set_actor_stats(actor_id, stamina, energy, mood='Neutral'):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO reality_actor_stats (actor_id, stamina, energy, mood, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ''', (actor_id, float(stamina), float(energy), mood))
    conn.commit()
    conn.close()

def get_actor_stats(actor_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM reality_actor_stats WHERE actor_id = ?', (actor_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else {"actor_id": actor_id, "stamina": 1.0, "energy": 1.0, "mood": "Neutral"}

# --- Artifacts (Region 2) ---

def register_actor(actor_id, vrm_path, manifest_dict=None):
    conn = get_connection()
    cursor = conn.cursor()
    manifest_json = json.dumps(manifest_dict) if manifest_dict else None
    cursor.execute('''
        INSERT OR REPLACE INTO registry_actors (actor_id, vrm_path, manifest_data)
        VALUES (?, ?, ?)
    ''', (actor_id, vrm_path, manifest_json))
    conn.commit()
    conn.close()

def get_all_actors():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT actor_id, vrm_path, manifest_data FROM registry_actors')
    rows = cursor.fetchall()
    conn.close()
    actors = []
    for r in rows:
        d = dict(r)
        d['manifest_data'] = json.loads(d['manifest_data']) if d['manifest_data'] else {}
        actors.append(d)
    return actors

def get_actor(actor_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM registry_actors WHERE actor_id = ?', (actor_id,))
    row = cursor.fetchone()
    conn.close()
    if row:
        d = dict(row)
        d['manifest_data'] = json.loads(d['manifest_data']) if d['manifest_data'] else {}
        return d
    return None

def update_actor_trait(actor_id, trait_key, value):
    """Updates a specific key inside the manifest_data JSON."""
    actor = get_actor(actor_id)
    if not actor:
        return False
    
    manifest = actor['manifest_data']
    manifest[trait_key] = value
    
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        UPDATE registry_actors SET manifest_data = ? WHERE actor_id = ?
    ''', (json.dumps(manifest), actor_id))
    conn.commit()
    conn.close()
    return True

def get_actor_trait(actor_id, trait_key, default=None):
    actor = get_actor(actor_id)
    if not actor:
        return default
    return actor['manifest_data'].get(trait_key, default)

def register_ui_control(control_id, tab_id, label, min_val, max_val, step, default, sort_order=0):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO registry_ui_controls (control_id, tab_id, label, min, max, step, "default", sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ''', (control_id, tab_id, label, min_val, max_val, step, default, sort_order))
    conn.commit()
    conn.close()

def get_ui_controls(tab_id=None):
    conn = get_connection()
    cursor = conn.cursor()
    if tab_id:
        cursor.execute('SELECT * FROM registry_ui_controls WHERE tab_id = ? ORDER BY sort_order ASC', (tab_id,))
    else:
        cursor.execute('SELECT * FROM registry_ui_controls ORDER BY tab_id, sort_order ASC')
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def register_workflow(workflow_id, path, node_mappings):
    conn = get_connection()
    cursor = conn.cursor()
    mapping_json = json.dumps(node_mappings) if node_mappings else None
    cursor.execute('''
        INSERT OR REPLACE INTO registry_workflows (workflow_id, path, node_mappings)
        VALUES (?, ?, ?)
    ''', (workflow_id, path, mapping_json))
    conn.commit()
    conn.close()

def get_workflow(workflow_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM registry_workflows WHERE workflow_id = ?', (workflow_id,))
    row = cursor.fetchone()
    conn.close()
    if row:
        d = dict(row)
        d['node_mappings'] = json.loads(d['node_mappings']) if d['node_mappings'] else {}
        return d
    return None

# --- Memory (Region 3) ---

def log_dialogue(actor_id, role, content):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO memory_dialogue (actor_id, role, content)
        VALUES (?, ?, ?)
    ''', (actor_id, role, content))
    conn.commit()
    conn.close()

def get_recent_history(actor_id, limit=10):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT role, content FROM memory_dialogue 
        WHERE actor_id = ? 
        ORDER BY timestamp DESC LIMIT ?
    ''', (actor_id, limit))
    rows = cursor.fetchall()
    conn.close()
    return [{"role": r['role'], "content": r['content']} for r in reversed(rows)]

def reset_recent_history(actor_id):
    conn = get_connection()
    cursor = conn.cursor()
    # 1. Clear raw dialogue
    cursor.execute('DELETE FROM memory_dialogue WHERE actor_id = ?', (actor_id,))
    # 2. Clear extracted memory blocks
    cursor.execute('DELETE FROM memory_blocks WHERE actor_id = ?', (actor_id,))
    conn.commit()
    conn.close()

    # 3. Reset background memory trait (calls its own get_connection)
    update_actor_trait(actor_id, "background_memory", "")
    print(f"Memory reset for {actor_id}")

def log_stats(actor_id, stamina, energy, mood):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO memory_stats_log (actor_id, stamina, energy, mood)
        VALUES (?, ?, ?, ?)
    ''', (actor_id, float(stamina), float(energy), mood))
    conn.commit()
    conn.close()

# --- Memory Blocks ---

def add_memory_block(actor_id, content, concepts, source_range):
    conn = get_connection()
    cursor = conn.cursor()
    
    # Robust stringification for SQLite
    content_str = json.dumps(content) if not isinstance(content, str) else content
    concepts_json = json.dumps(concepts) if not isinstance(concepts, str) else concepts
    
    cursor.execute('''
        INSERT INTO memory_blocks (actor_id, content, concepts, source_range)
        VALUES (?, ?, ?, ?)
    ''', (str(actor_id), content_str, concepts_json, str(source_range)))
    conn.commit()
    conn.close()

def get_memory_blocks(actor_id, limit=5):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT * FROM memory_blocks 
        WHERE actor_id = ? 
        ORDER BY timestamp DESC LIMIT ?
    ''', (actor_id, limit))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_all_concepts(actor_id):
    """Retrieves all distinct concepts for a character for background refinement."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT concepts FROM memory_blocks WHERE actor_id = ?', (actor_id,))
    rows = cursor.fetchall()
    conn.close()
    
    all_concepts = set()
    for r in rows:
        try:
            clist = json.loads(r['concepts'])
            if isinstance(clist, list):
                all_concepts.update(clist)
        except:
            pass
    return list(all_concepts)

# --- Animation Registry (New) ---

def register_animation(filename, category, trigger, purpose, effect=""):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO registry_animations (filename, category, trigger_condition, action_purpose, action_effect, indexed_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ''', (filename, category, trigger, purpose, effect))
    conn.commit()
    conn.close()

def get_all_animations():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM registry_animations')
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def delete_animation(anim_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('DELETE FROM registry_animations WHERE anim_id = ?', (anim_id,))
    conn.commit()
    conn.close()

def get_animation_by_path(path):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM registry_animations WHERE filename = ?', (path,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

if __name__ == "__main__":
    init_db()


# =========================================================
# --- Persona System CRUD ---
# =========================================================

# --- Identity ---

def set_actor_identity(actor_id, name, core_traits, speech_style, values):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO actor_identity (actor_id, name, core_traits, speech_style, "values", updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ''', (actor_id, name, core_traits, speech_style, values))
    conn.commit()
    conn.close()

def get_actor_identity(actor_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM actor_identity WHERE actor_id = ?', (actor_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


# --- Moods ---

def get_actor_interests(actor_id):
    """Retrieves the list of interests for the actor from reality_state."""
    val = get_reality(f"actor_interests_{actor_id}", "[]")
    try:
        return json.loads(val)
    except:
        return []

def set_actor_interests(actor_id, interests):
    """Saves a list of interests for the actor to reality_state."""
    if not isinstance(interests, list):
        interests = []
    # Cap at 10 interests as per requirement
    interests = interests[:10]
    set_reality(f"actor_interests_{actor_id}", json.dumps(interests))

def set_mood(actor_id, mood_id, display_name, behavioral_text, transition_up=None, transition_down=None):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO actor_moods
            (actor_id, mood_id, display_name, behavioral_text, transition_up, transition_down)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (actor_id, mood_id, display_name, behavioral_text, transition_up, transition_down))
    conn.commit()
    conn.close()

def get_mood(actor_id, mood_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM actor_moods WHERE actor_id = ? AND mood_id = ?', (actor_id, mood_id))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def get_all_moods(actor_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM actor_moods WHERE actor_id = ?', (actor_id,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_current_mood(actor_id):
    """Returns the mood_id string from reality_actor_stats."""
    stats = get_actor_stats(actor_id)
    return stats.get('mood', 'neutral')

def set_current_mood(actor_id, mood_id):
    """Updates the live mood in reality_actor_stats."""
    stats = get_actor_stats(actor_id)
    set_actor_stats(actor_id, stats.get('stamina', 1.0), stats.get('energy', 1.0), mood_id)


# --- Mode Prompts ---

def set_mode_prompt(actor_id, mode_id, display_name, system_text, trigger_prefix=None):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO actor_mode_prompts
            (actor_id, mode_id, display_name, system_text, trigger_prefix)
        VALUES (?, ?, ?, ?, ?)
    ''', (actor_id, mode_id, display_name, system_text, trigger_prefix))
    conn.commit()
    conn.close()

def get_mode_prompt(actor_id, mode_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM actor_mode_prompts WHERE actor_id = ? AND mode_id = ? AND is_active = 1',
                   (actor_id, mode_id))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def get_all_mode_prompts(actor_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM actor_mode_prompts WHERE actor_id = ? ORDER BY mode_id', (actor_id,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]


# =========================================================
# --- Knowledge Graph CRUD ---
# =========================================================

def kg_add_subject(actor_id, canonical_name, subject_type, description=None,
                   aliases=None, confidence=1.0, source='manual'):
    """Add or update a subject in the knowledge graph.
    Uniqueness key is (actor_id, canonical_name, source) — two entities with
    the same name but different source contexts are treated as distinct.
    """
    conn = get_connection()
    cursor = conn.cursor()
    aliases_json = json.dumps(aliases) if aliases else None

    # Check if already exists (by canonical_name AND source for this actor)
    cursor.execute(
        'SELECT subject_id FROM kg_subjects WHERE actor_id = ? AND canonical_name = ? AND source = ?',
        (actor_id, canonical_name, source)
    )
    existing = cursor.fetchone()

    if existing:
        cursor.execute('''
            UPDATE kg_subjects SET description=?, confidence=?, last_updated=CURRENT_TIMESTAMP
            WHERE subject_id=?
        ''', (description, confidence, existing['subject_id']))
        subject_id = existing['subject_id']
    else:
        cursor.execute('''
            INSERT INTO kg_subjects (actor_id, canonical_name, aliases, subject_type, description, confidence, source)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (actor_id, canonical_name, aliases_json, subject_type, description, confidence, source))
        subject_id = cursor.lastrowid

    conn.commit()
    conn.close()
    return subject_id


def kg_get_contexts(actor_id):
    """Return all distinct source context values for this actor's KG subjects,
    ordered by recency. Used to populate the LLM's available context list."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT DISTINCT source
        FROM kg_subjects
        WHERE actor_id = ? AND source IS NOT NULL AND source != ''
        ORDER BY last_updated DESC
    ''', (actor_id,))
    rows = cursor.fetchall()
    conn.close()
    return [r['source'] for r in rows]

def kg_get_subject(actor_id, name):
    """Look up a subject by canonical name or alias."""
    conn = get_connection()
    cursor = conn.cursor()
    # Direct match
    cursor.execute('SELECT * FROM kg_subjects WHERE actor_id = ? AND canonical_name = ? COLLATE NOCASE',
                   (actor_id, name))
    row = cursor.fetchone()
    if not row:
        # Alias scan — check if name appears in any aliases JSON
        cursor.execute('SELECT * FROM kg_subjects WHERE actor_id = ?', (actor_id,))
        for r in cursor.fetchall():
            try:
                aliases = json.loads(r['aliases'] or '[]')
                if any(name.lower() == a.lower() for a in aliases):
                    row = r
                    break
            except Exception:
                pass
    conn.close()
    return dict(row) if row else None

def kg_get_all_subjects(actor_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM kg_subjects WHERE actor_id = ? ORDER BY confidence DESC', (actor_id,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def kg_add_hierarchy(child_id, parent_id, relation_label='is_a'):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR IGNORE INTO kg_hierarchy (child_id, parent_id, relation_label)
        VALUES (?, ?, ?)
    ''', (child_id, parent_id, relation_label))
    conn.commit()
    conn.close()

def kg_get_ancestors(subject_id, max_depth=4):
    """Walk the hierarchy upward, returning ancestor subjects."""
    conn = get_connection()
    cursor = conn.cursor()
    ancestors = []
    current_ids = [subject_id]
    for _ in range(max_depth):
        if not current_ids:
            break
        placeholders = ','.join('?' for _ in current_ids)
        cursor.execute(f'''
            SELECT h.parent_id, s.canonical_name, s.subject_type, h.relation_label
            FROM kg_hierarchy h
            JOIN kg_subjects s ON s.subject_id = h.parent_id
            WHERE h.child_id IN ({placeholders})
        ''', current_ids)
        rows = cursor.fetchall()
        if not rows:
            break
        ancestors.extend([dict(r) for r in rows])
        current_ids = [r['parent_id'] for r in rows]
    conn.close()
    return ancestors

def kg_add_relation(actor_id, subject_id, predicate, object_id=None,
                    object_literal=None, confidence=1.0, source='manual'):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO kg_relations (actor_id, subject_id, predicate, object_id, object_literal, confidence, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (actor_id, subject_id, predicate, object_id, object_literal, confidence, source))
    conn.commit()
    conn.close()

def kg_get_relations(actor_id, subject_id, min_confidence=0.5):
    """Get all relations where this subject appears (as subject or object)."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT r.*, ss.canonical_name AS subject_name, os.canonical_name AS object_name
        FROM kg_relations r
        JOIN kg_subjects ss ON ss.subject_id = r.subject_id
        LEFT JOIN kg_subjects os ON os.subject_id = r.object_id
        WHERE r.actor_id = ?
          AND (r.subject_id = ? OR r.object_id = ?)
          AND r.confidence >= ?
        ORDER BY r.confidence DESC, r.timestamp DESC
    ''', (actor_id, subject_id, subject_id, min_confidence))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def kg_retrieve_context(actor_id, names_mentioned, min_confidence=0.5, max_subjects=5,
                        active_context=None):
    """
    Given a list of names extracted from a message, retrieve relevant
    KG context: subjects, their ancestry, and their relations.
    When active_context is set, subjects from that context rank first;
    ambiguous names that exist across multiple contexts are listed separately
    so the LLM can distinguish them.
    Returns a formatted string ready for injection into the prompt.
    """
    if not names_mentioned:
        return ""

    results = []
    seen_subject_ids = set()

    conn = get_connection()
    cursor = conn.cursor()

    for name in names_mentioned[:max_subjects]:
        # Fetch ALL matching subjects for this name (may be from multiple contexts)
        cursor.execute(
            'SELECT * FROM kg_subjects WHERE actor_id = ? AND canonical_name = ? COLLATE NOCASE ORDER BY last_updated DESC',
            (actor_id, name)
        )
        matches = [dict(r) for r in cursor.fetchall()]

        # Also scan aliases
        if not matches:
            cursor.execute('SELECT * FROM kg_subjects WHERE actor_id = ?', (actor_id,))
            for r in cursor.fetchall():
                try:
                    aliases = json.loads(r['aliases'] or '[]')
                    if any(name.lower() == a.lower() for a in aliases):
                        matches.append(dict(r))
                except Exception:
                    pass

        if not matches:
            continue

        # Sort: active_context first, then by recency
        if active_context:
            matches.sort(key=lambda s: (0 if s.get('source') == active_context else 1, s['subject_id'] * -1))

        for subject in matches:
            sid = subject['subject_id']
            if sid in seen_subject_ids:
                continue
            seen_subject_ids.add(sid)

            conf_label = 'high' if subject['confidence'] >= 0.8 else ('medium' if subject['confidence'] >= 0.5 else 'low')
            source_tag = f" [ctx: {subject['source']}]" if subject.get('source') else ""
            line = (f"• {subject['canonical_name']} [{subject['subject_type']}]{source_tag}"
                    f" — {subject['description'] or 'no description'} (confidence: {conf_label})")

            # Ancestry context
            ancestors = kg_get_ancestors(sid)
            if ancestors:
                ancestry_str = ' → '.join(f"{a['canonical_name']} ({a['relation_label']})" for a in ancestors[:3])
                line += f"\n  ↳ {ancestry_str}"

            # Relations
            relations = kg_get_relations(actor_id, sid, min_confidence)
            for rel in relations[:4]:
                obj_str = rel.get('object_name') or rel.get('object_literal') or '?'
                line += f"\n  • {rel['subject_name']} → {rel['predicate']} → {obj_str}"

            results.append(line)

    conn.close()

    if not results:
        return ""

    return "WHAT I KNOW:\n" + "\n".join(results)

