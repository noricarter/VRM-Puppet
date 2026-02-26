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
from datetime import datetime

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
    '[RESEARCH_RESULT]': 'idle_thought',
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
        known_contexts: list = None, # Available KG source contexts for self-writing
        active_context: str = None,  # Currently active context (for retrieval ranking)
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
        current_time = datetime.now().strftime("%A, %B %d, %Y at %I:%M %p")
        
        if identity:
            id_block = f"--- WHO I AM ---\n"
            id_block += f"Current System Time: {current_time}\n"
            id_block += "CRITICAL: The system time above is the TRUE current date. Always trust it over your internal training data. You are living in the present.\n"
            if identity.get('name'):
                id_block += f"My name is {identity['name']}.\n"
            
            # Inject Interests
            interests = db_manager.get_actor_interests(actor_id)
            if interests:
                id_block += f"Active Interests: {', '.join(interests)}\n"
            
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
        kg_context = db_manager.kg_retrieve_context(actor_id, names, active_context=active_context)
        if kg_context:
            sections.append(f"--- {kg_context}")

        # ---- Legacy background memory (pre-KG) ---------------------------
        if legacy_background:
            sections.append(f"--- BACKGROUND KNOWLEDGE ---\n{legacy_background}")

        # ---- RAG Phase 2 hook ------------------------------------------
        if extra_context:
            sections.append(f"--- RETRIEVED CONTEXT ---\n{extra_context}")

        # ---- Layer 5: Universal Performance Rules -------------------------
        # Dynamically adjust rules based on mode
        mode_id = detect_mode(message)
        speech_rule = "You MUST provide spoken words in the 'response' field." if mode_id == 'user_dialogue' else "Verbal response is OPTIONAL. Use 'absorb' for routine observations."

        sections.append(f"""--- STRICT DIALOGUE RULES ---
1. You are a vocal performer in a recording booth. Your 'response' field is your script.
2. {speech_rule}
3. Provide ONLY SPOKEN WORDS. Express emotion through word choice, not symbols.
4. NEVER use asterisks (*) for any purpose. Do not wrap your speech in them.
5. NO roleplay descriptions, NO narration, NO *stage directions*.
6. If you want to emphasize a word, use UPPERCASE instead of asterisks or italics.
7. Keep responses short and conversational.
8. WEB SEARCH TOOL: You HAVE internet access! If the user explicitly asks you to "search", "look up" something, or asks about current real-world events, you MUST set 'search_query' to the search term (e.g. "Tokyo weather"). Otherwise, keep it null.
9. If searching, you MUST acknowledge it in the 'response' field (e.g. "I'm looking that up right now.").
10. ANTI-HALLUCINATION: If the user provides a [RESEARCH_RESULT] block and the exact answer is NOT in the text, you MUST admit you couldn't find it. DO NOT invent dates, facts, or schedules.

IDEAL RESPONSE EXAMPLES (NO ASTERISKS):
- "It truly is wonderful to see you again. My day feels brighter already."
- "Keep your voice down... did you catch that faint sound coming from the hall just now?"
- "Hmm... give me a moment to think. Actually, I believe the path to the left is our best bet."

THE 'response' FIELD MUST BE CRISP, CLEAN DIALOGUE ONLY. ABSOLUTELY NO ASTERISKS.""")

        # ---- Action Reasoning Engine (unchanged from original) -----------
        if action_library_str:
            # Build known-contexts block for KG self-write guidance
            ctx_block = ""
            if known_contexts:
                ctx_list = '\n'.join(f'  - {c}' for c in known_contexts)
                ctx_block = f"""
--- KNOWN KG CONTEXTS (use EXACT spelling when writing kg_entry) ---
{ctx_list}
  - user_dialogue   (always valid — for things learned from direct conversation)
"""
            else:
                ctx_block = """
--- KNOWN KG CONTEXTS ---
No contexts yet. You may create a new one using the format: type:SourceName
Examples: audiobook:We_Are_Legion, show:The_Last_of_Us, user_dialogue
"""

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
{ctx_block}
--- RESPONSE MODE ---
Each turn you MUST choose how to respond by setting "response_mode":

- "speak"            — Reply out loud. Use for direct questions, reactions worth saying aloud,
                       or short conversational exchanges.
- "absorb"           — Stay silent. File what you heard into memory as "memory_note".
                       Use when passively observing (audiobook, show, ambient conversation).
                       Do NOT set "response" text — leave it as an empty string.
- "speak_and_absorb" — Both: reply out loud AND capture a memory note.
                       Use when something is genuinely surprising or worth commenting on
                       while also being worth remembering precisely.

GUIDANCE:
- [OBSERVER_PULSE] or [AUDIOBOOK_PULSE] with no dramatic event → prefer "absorb"
- [OBSERVER_PULSE] with something shocking, funny, or directly addressed to you → "speak_and_absorb"
- Direct user messages → almost always "speak"
- "memory_note" should be a single crisp sentence in first person: "I learned that Bob signed a cryonics contract."

JSON OUTPUT FORMAT (MANDATORY STRUCTURE):
{{
  "thought": "Internal reasoning about intent and mood.",
  "physical_intent": "Brief description of gesture.",
  "selection_type": "appropriate_action | missing_action | no_action",
  "action": "filename.fbx or null",
  "confidence": 0.9,
  "response_mode": "speak | absorb | speak_and_absorb",
  "memory_note": "Knowledge to save.",
  "search_query": "Search term ONLY if explicitly requested, else null",
  "response": "Clean spoken dialogue."
}}

CRITICAL: Do NOT add extra fields like 'thoughts' or 'UserInterface_Insight'. Use EXACTLY the keys above.
If response_mode is 'speak', you MUST fill the 'response' field with dialogue.

kg_entry RULES:
- ONLY include kg_entry when absorbing a NAMED entity (proper noun, specific place, event).
- OMIT kg_entry entirely (do not include the key at all) for vague references, pronouns, or conversational turns.
- source_context MUST exactly match one of the listed KNOWN KG CONTEXTS.
- If the source is a new audiobook or show not yet listed, create it as: audiobook:Title or show:Title."""
            sections.append(action_block.strip())

        return "\n\n".join(sections)
