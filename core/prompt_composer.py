"""
PromptComposer — Modular prompt assembly for the persona system.

Assembles the final system prompt from five composable layers:
  1. Identity Core      — who she is (stable)
  2. Mood State         — how she is right now (behavioral instructions)
  3. Mode Context       — what she is doing (environmental instructions)
  4. Knowledge Context  — what she knows about subjects in this message (KG)
  5. Universal Rules    — no asterisks, JSON format, action engine (always present)

Falls back gracefully to legacy manifest_data.persona if no identity row exists.
The `extra_context` argument is the RAG Phase 2 hook — pass pre-fetched chunks there.
"""

import re
import sys
import os

# Allow import from either core/ or project root
_CORE_DIR = os.path.dirname(os.path.abspath(__file__))
if _CORE_DIR not in sys.path:
    sys.path.insert(0, _CORE_DIR)

import db_manager


# ---------------------------------------------------------------------------
# Mode detection
# ---------------------------------------------------------------------------

_MODE_PREFIXES = {
    '[OBSERVER_PULSE]':  'observer',
    '[AUDIOBOOK_PULSE]': 'audiobook',
    '[IDLE_PULSE]':      'idle_thought',
    '[NPC_':             'npc_dialogue',
}

def detect_mode(message: str) -> str:
    """Infer mode from message prefix. Returns mode_id string."""
    for prefix, mode_id in _MODE_PREFIXES.items():
        if message.startswith(prefix):
            return mode_id
    return 'user_dialogue'


# ---------------------------------------------------------------------------
# Subject name extraction (Phase 1 — token-based)
# ---------------------------------------------------------------------------

def extract_subject_names(message: str, actor_id: str) -> list:
    """
    Extract names from the message that match known KG subjects.
    Phase 1: scan known canonical names + aliases against message tokens.
    Phase 2: replace with NER / embedding similarity.
    """
    subjects = db_manager.kg_get_all_subjects(actor_id)
    if not subjects:
        return []

    message_lower = message.lower()
    found = []
    for s in subjects:
        if s['canonical_name'].lower() in message_lower:
            found.append(s['canonical_name'])
            continue
        # Check aliases
        try:
            import json
            aliases = json.loads(s['aliases'] or '[]')
            for alias in aliases:
                if alias.lower() in message_lower:
                    found.append(s['canonical_name'])
                    break
        except Exception:
            pass
    return list(dict.fromkeys(found))  # deduplicate, preserve order


# ---------------------------------------------------------------------------
# PromptComposer
# ---------------------------------------------------------------------------

class PromptComposer:

    def build_system_prompt(
        self,
        actor_id: str,
        message: str,
        action_library_str: str = '',
        legacy_persona: str = None,
        legacy_background: str = None,
        extra_context: str = None,   # RAG Phase 2 hook
    ) -> str:
        """
        Assemble the full system prompt for the given actor and message.

        Args:
            actor_id:           The actor being addressed.
            message:            The incoming user/pulse message.
            action_library_str: Pre-formatted action library string (from chat_bridge).
            legacy_persona:     Fallback persona string if no actor_identity row exists.
            legacy_background:  Fallback background_memory string.
            extra_context:      Pre-fetched RAG chunks (Phase 2).
        """
        sections = []

        # ---- Layer 1: Identity Core ----------------------------------------
        identity = db_manager.get_actor_identity(actor_id)
        if identity:
            id_block = f"--- WHO I AM ---\n"
            if identity.get('core_traits'):
                id_block += f"{identity['core_traits']}\n"
            if identity.get('speech_style'):
                id_block += f"\nSpeech: {identity['speech_style']}\n"
            if identity.get('values'):
                id_block += f"\nValues: {identity['values']}\n"
            sections.append(id_block.strip())
        elif legacy_persona:
            # Graceful fallback for actors not yet migrated
            sections.append(legacy_persona.strip())

        # ---- Layer 2: Mood State -------------------------------------------
        mood_id = db_manager.get_current_mood(actor_id)
        mood = db_manager.get_mood(actor_id, mood_id) if mood_id else None
        if mood and mood.get('behavioral_text'):
            mood_block = f"--- CURRENT MOOD: {mood['display_name'].upper()} ---\n{mood['behavioral_text']}"
            sections.append(mood_block)

        # ---- Layer 3: Mode Context -----------------------------------------
        mode_id = detect_mode(message)
        mode = db_manager.get_mode_prompt(actor_id, mode_id)
        if mode and mode.get('system_text'):
            mode_block = f"--- CURRENT MODE: {mode['display_name'].upper()} ---\n{mode['system_text']}"
            sections.append(mode_block)

        # ---- Layer 4: Knowledge Graph Context -----------------------------
        names = extract_subject_names(message, actor_id)
        kg_context = db_manager.kg_retrieve_context(actor_id, names)
        if kg_context:
            sections.append(f"--- {kg_context}")

        # ---- Legacy background memory (pre-KG) ---------------------------
        if legacy_background:
            sections.append(f"--- BACKGROUND KNOWLEDGE ---\n{legacy_background}")

        # ---- RAG Phase 2 hook ------------------------------------------
        if extra_context:
            sections.append(f"--- RETRIEVED CONTEXT ---\n{extra_context}")

        # ---- Layer 5: Universal Performance Rules -------------------------
        sections.append("""--- STRICT DIALOGUE RULES ---
1. You are a vocal performer in a recording booth. Your 'response' field is your script.
2. Provide ONLY SPOKEN WORDS. Express emotion through word choice, not symbols.
3. NEVER use asterisks (*) for any purpose. Do not wrap your speech in them.
4. NO roleplay descriptions, NO narration, NO *stage directions*.
5. If you want to emphasize a word, use UPPERCASE instead of asterisks or italics.
6. Keep responses short (1-3 sentences) and conversational unless explaining something complex.

IDEAL RESPONSE EXAMPLES (NO ASTERISKS):
- "It truly is wonderful to see you again. My day feels brighter already."
- "Keep your voice down... did you catch that faint sound coming from the hall just now?"
- "Hmm... give me a moment to think. Actually, I believe the path to the left is our best bet."

THE 'response' FIELD MUST BE CRISP, CLEAN DIALOGUE ONLY. ABSOLUTELY NO ASTERISKS.""")

        # ---- Action Reasoning Engine (unchanged from original) -----------
        if action_library_str:
            action_block = f"""
--- ACTION REASONING ENGINE ---
You have access to a library of physical actions to enhance your performance.
Before responding, you must REASON about whether a physical gesture is appropriate.

You must categorize your selection into one of three types:
1. 'appropriate_action': You identified an intent AND found a high-confidence match in the library.
   - USE THIS for speculative or abstract questions! (e.g., "Think about this...", "What if...", "Explain...").
   - Match with 'idle/oneshot/fbx/thinking.fbx' or 'idle/oneshot/fbx/thoughtful.fbx'.
2. 'missing_action': You identified a clear physical intent (e.g. "step back"), but NO matching animation exists.
3. 'no_action': The prompt is purely conversational and no gesture is required.

CRITICAL: You MUST output a single, valid JSON object. Do not include trailing characters or text outside the JSON.

AVAILABLE ACTIONS:
{action_library_str}

JSON OUTPUT FORMAT REQUIRED:
{{
  "thought": "Brief internal reasoning about the user's intent.",
  "physical_intent": "Describe the ideal physical action if any.",
  "selection_type": "appropriate_action | missing_action | no_action",
  "action": "matching_filename_or_null",
  "confidence": 0.0 to 1.0,
  "response": "Strictly spoken words ONLY. NO ASTERISKS. NO ROLEPLAY."
}}"""
            sections.append(action_block.strip())

        return "\n\n".join(sections)
