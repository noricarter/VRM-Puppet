import json
import re
import urllib.request
import urllib.parse
import uuid
import time
import os
import sys
import subprocess
import shutil
import threading
import queue
from http.server import HTTPServer, BaseHTTPRequestHandler, ThreadingHTTPServer
from media_pipeline import process_audio_for_lipsync
from brain_tool import BrainTool
from tts_engine import TTSEngine
import db_manager
from prompt_composer import PromptComposer
from search_util import search_and_summarize

_composer = PromptComposer()

def get_default_actor_id():
    try:
        actors = db_manager.get_all_actors()
        return actors[0]['actor_id'] if actors else "Unknown_Actor"
    except Exception:
        return "Unknown_Actor"

# --- IDLE MONITOR STATE ---
_last_activity_time = time.time()
_active_actor_id = None # Set dynamically on first chat
_bridge_initialized = False

# --- CONFIG ---
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMP_DIR = os.path.join(PROJECT_ROOT, "web/temp")
OUTPUT_DIR = TEMP_DIR 

# --- GLOBAL TOOLS ---
brain_tool = BrainTool()
tts_engine = TTSEngine() # Fast Standalone TTS

# --- QUEUEING SYSTEM ---
chat_queue = queue.Queue()

def chat_worker():
    """Consumes requests from chat_queue and executes them one-by-one."""
    while True:
        try:
            req_data = chat_queue.get()
            if req_data is None: break # Shutdown signal
            
            print(f"--- Queue: Processing request for {req_data['actor_id']} ---")
            try:
                generate_and_stream(
                    req_data['messages'], 
                    req_data['actor_id'], 
                    req_data['model'], 
                    req_data['voice_desc'], 
                    req_data['images'],
                    req_data.get('active_context'),
                    extra_data=req_data.get('extra_data')
                )
            except Exception as ge:
                error_msg = f"Generation failed: {str(ge)}"
                print(f"--- Queue: Generation Error: {ge} ---")
                streamer.push("error", error_msg)
                streamer.push("system_warn", {"text": f"🧠 Brain Halt: {error_msg}"})
            
            chat_queue.task_done()
        except Exception as e:
            print(f"--- Queue Worker Critical Error: {e} ---")
            streamer.push("system_warn", {"text": f"🚨 Queue Worker Failure: {str(e)}"})
            time.sleep(1)

def clean_text_for_speech(text):
    """Strips markdown, parentheticals, and stage cues for clean TTS."""
    import re
    
    # 1. Strip markdown bold **text** and other markers first
    text = text.replace('**', '')
    text = text.replace('__', '')
    
    # 2. Strip stage cues like "Pilot's Voice:" or "Assistant:" 
    # Must handle both start-of-line and mid-text if the LLM is weird
    text = re.sub(r'^[A-Za-z0-9 ’\'-]+:', '', text, flags=re.MULTILINE)
    
    # 3. Strip parenthetical narration (actions)
    text = re.sub(r'\(.*?\)', '', text)
    
    # 4. Strip asterisk markers but KEEP the text (e.g. *emphasis*)
    # User requested to keep the content inside asterisks
    text = text.replace('*', '')
    
    # 5. Strip remaining markdown and weird chars
    text = re.sub(r'[#_>]', '', text)
    
    # 6. Normalize whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    
    # 6. Normalize whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    
    return text


def _clean_kg_token(text, max_len=80):
    """Normalize noisy LLM token strings before KG validation."""
    if text is None:
        return ""
    out = str(text).strip().strip('"').strip("'")
    out = out.replace('*', '')
    out = re.sub(r'\s+', ' ', out).strip()
    if len(out) > max_len:
        out = out[:max_len].rstrip()
    return out


def _is_valid_kg_name(name):
    """Named entities should be concise noun-like labels, not full sentences."""
    if not name:
        return False
    if len(name) < 2 or len(name) > 80:
        return False
    if name.endswith(('.', '?', '!', ':', ';')):
        return False
    # Block obvious sentence-like fragments.
    lowered = name.lower()
    bad_starts = (
        "i ", "i'm ", "im ", "my ", "we ", "we're ", "you ", "the ", "this ", "that "
    )
    if lowered.startswith(bad_starts):
        return False
    if len(name.split()) > 8:
        return False
    return True


def _is_valid_kg_predicate(predicate):
    """Predicates should be compact verb labels (no sentence punctuation)."""
    if not predicate:
        return False
    p = predicate.strip().lower()
    if len(p) < 2 or len(p) > 32:
        return False
    if any(ch in p for ch in ".!?,:;"):
        return False
    return bool(re.match(r'^[a-z0-9_ -]+$', p))


def _canonical_emotion_state(raw_state):
    """Map arbitrary mood labels to HUD canonical states."""
    s = (str(raw_state or "")).strip().lower()
    if not s:
        return None
    if s in {"neutral", "positive", "negative_sad", "negative_embarrassed", "negative_sad_embarrassed", "negative_anger"}:
        return s
    if any(k in s for k in ("angry", "anger", "annoy", "furious", "irritat", "mad")):
        return "negative_anger"
    if any(k in s for k in ("embarrass", "fluster", "shy", "awkward")) and any(k in s for k in ("sad", "sorrow", "down")):
        return "negative_sad_embarrassed"
    if any(k in s for k in ("embarrass", "fluster", "shy", "awkward")):
        return "negative_embarrassed"
    if any(k in s for k in ("sad", "sorrow", "down", "hurt", "upset")):
        return "negative_sad"
    if any(k in s for k in ("happy", "joy", "positive", "excited", "warm")):
        return "positive"
    if any(k in s for k in ("calm", "content", "relaxed", "focused")):
        return "neutral"
    return None


def _infer_emotion_for_presentation(reasoning_data, thought, ai_text):
    """
    Derive per-turn emotion signal for avatar presentation.
    Priority:
    1) explicit fields from reasoning JSON
    2) heuristic inference from thought/response text
    """
    rd = reasoning_data if isinstance(reasoning_data, dict) else {}

    explicit_state = (
        rd.get("emotion_state")
        or rd.get("emotion")
        or rd.get("facial_mood")
        or rd.get("avatar_mood")
        or rd.get("mood")
    )
    state = _canonical_emotion_state(explicit_state)

    raw_intensity = (
        rd.get("emotion_intensity")
        or rd.get("intensity")
        or rd.get("affect_intensity")
    )
    try:
        intensity = float(raw_intensity)
    except Exception:
        intensity = 1.0
    intensity = max(0.0, min(1.0, intensity))

    if state:
        hold_sec = 10 if state.startswith("negative_") else 6
        return state, intensity, hold_sec, "explicit"

    blob = f"{thought or ''}\n{ai_text or ''}".lower()
    if any(k in blob for k in ("furious", "enraged", "scream", "infuriat", "pissed", "angry", "why do we have to go through this")):
        return "negative_anger", 0.9, 10, "heuristic"
    if any(k in blob for k in ("embarrass", "fluster", "shy", "blush", "awkward")) and any(k in blob for k in ("sad", "down", "upset", "hurt")):
        return "negative_sad_embarrassed", 0.85, 10, "heuristic"
    if any(k in blob for k in ("embarrass", "fluster", "shy", "blush", "awkward")):
        return "negative_embarrassed", 0.8, 8, "heuristic"
    if any(k in blob for k in ("sad", "sorrow", "down", "upset", "hurt", "tear")):
        return "negative_sad", 0.8, 9, "heuristic"
    if any(k in blob for k in ("happy", "glad", "excited", "love", "great", "awesome", "yay")):
        return "positive", 0.75, 6, "heuristic"
    return "neutral", 0.55, 4, "fallback"


# --- REASONING HELPERS ---

def format_action_library():
    """Formats the indexed animations into a concise string for LLM awareness."""
    anims = db_manager.get_all_animations()
    if not anims:
        return "No special actions available."
    
    lib_str = "Available Actions:\n"
    for a in anims:
        lib_str += f"- {a['filename']} (Purpose: {a['action_purpose']}, Trigger: {a['trigger_condition']})\n"
    return lib_str

# --- STREAMING INFRASTRUCTURE ---
class StreamHandler:
    def __init__(self):
        self.msg_queue = queue.Queue()
        self.active = False

    def push(self, event_type, data):
        self.msg_queue.put({"type": event_type, "data": data})

    def get(self, timeout=None):
        return self.msg_queue.get(timeout=timeout)

# Global stream instance (Persistent Singleton)
streamer = StreamHandler()

# Background thread disabled per user request
def idle_monitor():
    pass

def run_memory_heartbeat(actor_id):
    """Create one non-overlapping page per trigger using dialogue id ranges."""
    step = 15
    key_processed = f"heartbeat_last_processed_dialogue_id_{actor_id}"

    try:
        last_processed_id = int(db_manager.get_reality(key_processed, "0") or 0)
    except Exception:
        last_processed_id = 0

    max_id = db_manager.get_max_dialogue_id(actor_id)
    if max_id <= last_processed_id:
        return

    chunk = db_manager.get_dialogue_after_id(actor_id, last_processed_id, limit=step)
    if len(chunk) < step:
        return

    start_id = int(chunk[0]['id'])
    end_id = int(chunk[-1]['id'])
    start_t = chunk[0].get('timestamp')
    end_t = chunk[-1].get('timestamp')

    print(f"--- [Heartbeat: Page] Triggering extraction for {actor_id} over msg_id_{start_id}:{end_id} ---")
    streamer.push("system_warn", {"text": "📝 Writing a new page in the journal..."})

    ok = brain_tool.extract_concepts(
        actor_id,
        f"msg_id_{start_id}:{end_id}",
        dialogue_rows=chunk,
        start_t=start_t,
        end_t=end_t
    )
    if not ok:
        print(f"--- [Heartbeat WARN] Page extraction fallback failed for msg_id_{start_id}:{end_id} ---")
        return

    # Advance marker only after successful write.
    db_manager.set_reality(key_processed, str(end_id))

    # Refinement tiers depend on actual persisted page/chapter counts.
    try:
        page_count = db_manager.get_block_count(actor_id, block_type='page')
        if page_count > 0 and page_count % 5 == 0:
            print(f"--- [Heartbeat: Chapter] Refining 5 pages into a chapter for {actor_id} ---")
            streamer.push("system_warn", {"text": "📖 Consolidating pages into a new Chapter..."})
            chapter_text = brain_tool.refine_memory(actor_id, target_type='chapter')
            if chapter_text:
                chapter_count = db_manager.get_block_count(actor_id, block_type='chapter')
                if chapter_count > 0 and chapter_count % 5 == 0:
                    print(f"--- [Heartbeat: Book] Consolidating 5 chapters into a book for {actor_id} ---")
                    streamer.push("system_warn", {"text": "📚 Archiving chapters into a new Book of Life..."})
                    brain_tool.refine_memory(actor_id, target_type='book')
    except Exception as re:
        print(f"Memory Refinement Error: {re}")

def generate_and_stream(messages, actor_id, requested_model, voice_desc, images=None, active_context=None, extra_data=None):
    """Background thread function to generate text and stream audio chunks."""
    global _last_activity_time
    _last_activity_time = time.time() # Update activity on start
    
    print(f"--- Chat Stream Started for {actor_id} ---")
    
    # 1. Update Stats (Energy Cost)
    stats = db_manager.get_actor_stats(actor_id)
    new_energy = max(0, stats.get('energy', 1.0) - 0.05)
    db_manager.set_actor_stats(actor_id, stats.get('stamina', 1.0), new_energy, stats.get('mood', 'Neutral'))
    
    # 2. Re-build System Prompt (Ensure latest interests/mood are used)
    # We find the 'trigger message' which is usually the last one
    trigger_message = messages[-1]['content'] if messages else ""
    
    # Keep only Ollama-compatible dialogue turns.
    # Internal roles like "memory" are stored for persistence but should not be
    # forwarded as chat roles to the model.
    clean_history = [m for m in messages if m.get('role') in ('user', 'assistant')]
    
    lib_str = format_action_library()
    known_contexts = db_manager.kg_get_contexts(actor_id)
    
    # Determine active context
    if not active_context:
        if trigger_message.startswith('[OBSERVER_PULSE]'):
            active_context = db_manager.get_reality(f"observer_context_{actor_id}") or "observer"
        elif trigger_message.startswith('[AUDIOBOOK_PULSE]'):
            active_context = "audiobook"
        else:
            active_context = "user_dialogue"

    full_system_msg = _composer.build_system_prompt(
        actor_id=actor_id,
        message=trigger_message,
        action_library_str=lib_str,
        legacy_persona=db_manager.get_actor_trait(actor_id, "persona", "You are a helpful AI."),
        legacy_background=db_manager.get_actor_trait(actor_id, "background_memory", ""),
        extra_context=extra_data.get('extra_context') if extra_data else None,
        known_contexts=known_contexts,
        active_context=active_context,
    )
    
    # Assemble final payload for Ollama
    ollama_messages = [{"role": "system", "content": full_system_msg}] + clean_history

    ollama_url = "http://localhost:11434/api/chat"
    # If images were provided, attach them to the LAST user message
    if images and len(ollama_messages) > 0:
        for i in range(len(ollama_messages) - 1, -1, -1):
            if ollama_messages[i]['role'] == 'user':
                ollama_messages[i]['images'] = images
                break

    ollama_payload = {
        "model": requested_model,
        "messages": ollama_messages,
        "format": "json",
        "stream": False,
        "keep_alive": -1,
        "options": {
            "temperature": 0.85,       # Slight reduction keeps her coherent; default is 0.8–1.0
            "repeat_penalty": 1.15,    # Penalises repeating tokens/phrases; 1.0 = off, >1 = stronger
            "repeat_last_n": 128,      # How many tokens back to scan for repetition
            "num_predict": 1024,       # Prevent long reasoning/JSON blocks from being truncated
            "num_ctx": 4096            # Support deep memory retrieval Windows
        }
    }
    
    ai_full_text = ""
    reasoning_data = {}

    def _call_ollama_chat(payload):
        model_name = payload.get("model", requested_model)
        print(f"--- Calling Ollama Chat (Model: {model_name}) ---")
        req = urllib.request.Request(ollama_url, data=json.dumps(payload).encode('utf-8'))
        raw = "{}"
        try:
            with urllib.request.urlopen(req) as resp:
                result_data = json.loads(resp.read().decode('utf-8'))
                raw = result_data.get('message', {}).get('content', '{}')
        except urllib.error.HTTPError as he:
            if he.code == 404:
                warn_msg = f"Model '{model_name}' not found in Ollama."
                print(f"!!! {warn_msg} Attempting auto-fallback...")
                streamer.push("system_warn", {"text": f"⚠️ {warn_msg} Trying fallback..."})
                try:
                    tags_req = urllib.request.Request("http://localhost:11434/api/tags")
                    with urllib.request.urlopen(tags_req) as tags_resp:
                        tags_data = json.loads(tags_resp.read().decode('utf-8'))
                        available = tags_data.get('models', [])
                        if available:
                            fallback_name = available[0].get('name')
                            print(f"--- Fallback: Retrying with '{fallback_name}' ---")
                            streamer.push("system_warn", {"text": f"🔄 Falling back to: {fallback_name}"})
                            payload['model'] = fallback_name
                            req = urllib.request.Request(ollama_url, data=json.dumps(payload).encode('utf-8'))
                            with urllib.request.urlopen(req) as resp2:
                                res2_data = json.loads(resp2.read().decode('utf-8'))
                                raw = res2_data.get('message', {}).get('content', '{}')
                        else:
                            raise Exception("No fallback models found.")
                except Exception as fe:
                    print(f"Fallback Failed: {fe}")
                    streamer.push("system_warn", {"text": f"❌ All Brain Fallbacks failed: {str(fe)}"})
                    raise he
            else:
                raise he
        except Exception as oe:
            print(f"Ollama Connection Error: {oe}")
            streamer.push("system_warn", {"text": f"🌐 Ollama Connection Error: {str(oe)}"})
            streamer.push("error", f"Brain disconnect: {str(oe)}")
            raise oe
        return raw

    def _extract_reasoning(raw_json_text):
        # Safe defaults
        out = {
            "reasoning_data": {},
            "thought": "Thinking...",
            "intent": "",
            "selection_type": "no_action",
            "selected_action": None,
            "confidence": 0.0,
            "response_mode": "speak",
            "memory_note": "",
            "search_query": None,
            "memory_query": None,
            "ai_full_text": "",
        }

        print(f"Raw Response: {raw_json_text}")

        # LLMs sometimes add markdown blocks or trailing text
        start_idx = raw_json_text.find('{')
        end_idx = raw_json_text.rfind('}')
        if start_idx != -1 and end_idx != -1 and end_idx >= start_idx:
            clean_json_str = raw_json_text[start_idx:end_idx + 1]
        else:
            clean_json_str = raw_json_text

        try:
            out["reasoning_data"] = json.loads(clean_json_str)
        except Exception as je:
            print(f"JSON Parse Error: {je}")
            print(f"Raw was: {raw_json_text}")
            streamer.push("system_warn", {"text": f"🧩 Brain Salad (JSON Error): {str(je)}"})
            # Attempt to use regex as a last resort
            found_response = re.search(r'"response":\s*"(.*?)"', raw_json_text, re.DOTALL)
            if found_response:
                out["reasoning_data"] = {"response": found_response.group(1), "response_mode": "speak"}
                streamer.push("system_warn", {"text": "🩹 Recovered dialogue via regex fallback."})

        rd = out["reasoning_data"]
        out["ai_full_text"] = rd.get('response') or rd.get('text') or rd.get('dialogue') or ""
        out["thought"] = rd.get('thought', out["thought"])
        out["intent"] = rd.get('physical_intent', out["intent"])
        out["selection_type"] = rd.get('selection_type', out["selection_type"])
        out["selected_action"] = rd.get('action')
        out["confidence"] = rd.get('confidence', out["confidence"])
        out["response_mode"] = rd.get('response_mode', out["response_mode"])

        memory_note = rd.get('memory_note')
        out["memory_note"] = memory_note.strip() if isinstance(memory_note, str) else ""

        search_query = rd.get('search_query')
        out["search_query"] = search_query.strip() if isinstance(search_query, str) and search_query.strip() else None
        memory_query = rd.get('memory_query')
        out["memory_query"] = memory_query.strip() if isinstance(memory_query, str) and memory_query.strip() else None

        # Fallback for silent speak mode
        if out["response_mode"] == 'speak' and not out["ai_full_text"]:
            out["ai_full_text"] = "Hmm, interesting. Let me think about that one."

        # Enforce threshold for execution only
        if out["selection_type"] == 'appropriate_action' and (not out["selected_action"] or out["confidence"] < 0.7):
            out["selected_action"] = None
            out["selection_type"] = 'missing_action'
            out["thought"] += " (Downgraded to missing: Confidence below threshold or no file)"

        return out

    try:
        parsed = _extract_reasoning(_call_ollama_chat(ollama_payload))
        reasoning_data = parsed["reasoning_data"]
        thought = parsed["thought"]
        intent = parsed["intent"]
        selection_type = parsed["selection_type"]
        selected_action = parsed["selected_action"]
        confidence = parsed["confidence"]
        response_mode = parsed["response_mode"]
        memory_note = parsed["memory_note"]
        search_query = parsed["search_query"]
        memory_query = parsed["memory_query"]
        ai_full_text = parsed["ai_full_text"]

        # Resolve search/memory internally so the user gets a single final response.
        if search_query or memory_query:
            followup_user_msg = ""
            if search_query:
                print(f"--- Triggering Web Research: {search_query} ---")
                streamer.push("system_warn", {"text": f"🔍 Researching: {search_query}"})
                try:
                    research_results = search_and_summarize(search_query)
                    followup_user_msg = f"[RESEARCH_RESULT] Search query: '{search_query}'\nFindings:\n{research_results}"
                except Exception as se:
                    print(f"Web Research Error: {se}")
                    streamer.push("system_warn", {"text": f"🕳️ Research Failed: {str(se)}"})
                    followup_user_msg = (
                        f"[RESEARCH_RESULT] Search query: '{search_query}'\n"
                        f"Findings:\nSearch failed: {str(se)}"
                    )
            else:
                print(f"--- Triggering Memory Research: {memory_query} ---")
                streamer.push("system_warn", {"text": f"🧠 Recalling: {memory_query}"})
                try:
                    kg_context = db_manager.kg_retrieve_context(
                        actor_id,
                        [memory_query],
                        active_context=active_context
                    )
                    if kg_context:
                        followup_user_msg = f"[MEMORY_RESULT] Memory query: '{memory_query}'\nFindings:\n{kg_context}"
                    else:
                        followup_user_msg = (
                            f"[MEMORY_RESULT] Memory query: '{memory_query}'\n"
                            f"Findings:\nNo information found in memory for '{memory_query}'."
                        )
                except Exception as me:
                    print(f"Memory Research Error: {me}")
                    streamer.push("system_warn", {"text": f"🕳️ Memory Recall Failed: {str(me)}"})
                    followup_user_msg = (
                        f"[MEMORY_RESULT] Memory query: '{memory_query}'\n"
                        f"Findings:\nMemory retrieval failed: {str(me)}"
                    )

            followup_messages = messages + [
                {"role": "assistant", "content": json.dumps(reasoning_data)},
                {"role": "user", "content": followup_user_msg}
            ]
            followup_clean_history = [m for m in followup_messages if m.get('role') in ('user', 'assistant')]
            followup_trigger = followup_messages[-1]['content'] if followup_messages else trigger_message
            followup_system_msg = _composer.build_system_prompt(
                actor_id=actor_id,
                message=followup_trigger,
                action_library_str=lib_str,
                legacy_persona=db_manager.get_actor_trait(actor_id, "persona", "You are a helpful AI."),
                legacy_background=db_manager.get_actor_trait(actor_id, "background_memory", ""),
                extra_context=extra_data.get('extra_context') if extra_data else None,
                known_contexts=db_manager.kg_get_contexts(actor_id),
                active_context=active_context,
            )
            followup_payload = {
                "model": ollama_payload.get("model", requested_model),
                "messages": [{"role": "system", "content": followup_system_msg}] + followup_clean_history,
                "format": "json",
                "stream": False,
                "keep_alive": -1,
                "options": ollama_payload.get("options", {})
            }

            parsed = _extract_reasoning(_call_ollama_chat(followup_payload))
            reasoning_data = parsed["reasoning_data"]
            thought = parsed["thought"]
            intent = parsed["intent"]
            selection_type = parsed["selection_type"]
            selected_action = parsed["selected_action"]
            confidence = parsed["confidence"]
            response_mode = parsed["response_mode"]
            memory_note = parsed["memory_note"]
            ai_full_text = parsed["ai_full_text"]
            # Prevent a recursive tool loop in this same turn.
            search_query = None
            memory_query = None

        # Push reasoning info once, after tool resolution.
        streamer.push("reasoning", {
            "thought": thought,
            "intent": intent,
            "selection_type": selection_type,
            "action": selected_action,
            "confidence": confidence
        })

        # Emit per-turn emotion signal for real-time avatar expression/overlays.
        emo_state, emo_intensity, emo_hold_sec, emo_source = _infer_emotion_for_presentation(
            reasoning_data, thought, ai_full_text
        )
        streamer.push("emotion", {
            "state": emo_state,
            "intensity": emo_intensity,
            "hold_sec": emo_hold_sec,
            "source": emo_source
        })

        if selection_type == 'appropriate_action' and selected_action:
            viewer_path = f"assets/animations/{selected_action}"
            streamer.push("action", {
                "url": viewer_path,
                "name": selected_action
            })

        spoken_text = clean_text_for_speech(ai_full_text) if ai_full_text else ""

        print(f"Assistant Thought: {thought}")
        print(f"Assistant (Dialogue Only): {spoken_text}")
        print(f"Assistant Response Mode: {response_mode}")

        # --- RESPONSE MODE ROUTING ---
        will_speak  = response_mode in ('speak', 'speak_and_absorb')
        will_absorb = response_mode in ('absorb', 'speak_and_absorb')

        # A. Store spoken dialogue in history (only when actually speaking)
        if will_speak and spoken_text.strip():
            db_manager.log_dialogue(actor_id, "assistant", spoken_text)

        # B. Store memory note + handle KG self-write (absorb paths)
        if will_absorb and memory_note:
            print(f"--- Memory Absorbed: {memory_note} ---")
            db_manager.log_dialogue(actor_id, "memory", memory_note)
            streamer.push("thinking", {"note": memory_note})

        # --- Memory Heartbeat (Hierarchical Life Story) ---
        try:
            msg_count = db_manager.get_dialogue_count(actor_id)
            if msg_count > 0:
                run_memory_heartbeat(actor_id)
        except Exception as heartbreaker:
            print(f"Memory Heartbeat Error: {heartbreaker}")

        # C. KG Self-Write 
        raw_kg = reasoning_data.get('kg_entries') or reasoning_data.get('kg_entry')
        if raw_kg:
            kg_list = raw_kg if isinstance(raw_kg, list) else [raw_kg]
            for kg_entry in kg_list:
                if not isinstance(kg_entry, dict):
                    continue
                
                subj   = _clean_kg_token(kg_entry.get('subject'))
                stype  = _clean_kg_token(kg_entry.get('subject_type'), max_len=40)
                src    = _clean_kg_token(kg_entry.get('source_context'), max_len=64)
                desc   = _clean_kg_token(kg_entry.get('description'), max_len=240)
                rel    = _clean_kg_token(kg_entry.get('relation'), max_len=32)
                obj    = _clean_kg_token(kg_entry.get('object'))

                # Fix: Skip if predicate (relation) is missing or nonsensical
                if not _is_valid_kg_predicate(rel):
                    print(f"--- [KG SKIP] Skipping malformed relation: '{rel}' ---")
                    continue

                # Validate required fields
                missing = [f for f, v in [('subject', subj), ('subject_type', stype), ('source_context', src)] if not v]
                if missing:
                    warn = f"KG entry missing required fields: {', '.join(missing)}"
                    print(f"--- [KG WARN] {warn} ---")
                    streamer.push("system_warn", {"text": warn, "entry": kg_entry})
                else:
                    if not _is_valid_kg_name(subj):
                        print(f"--- [KG SKIP] Subject failed quality gate: '{subj}' ---")
                        continue
                    if obj and not _is_valid_kg_name(obj):
                        print(f"--- [KG SKIP] Object failed quality gate: '{obj}' ---")
                        continue

                    # Validate source context:
                    # Accept: always-valid builtins, existing DB contexts, OR any new
                    # well-formed "type:Title" string (allows creating new contexts on the fly).
                    # Reject: malformed strings with spaces, missing colon, or garbage chars.
                    import re as _re
                    always_valid = {'user_dialogue', 'manual', 'observer'}
                    known_contexts_now = db_manager.kg_get_contexts(actor_id)
                    _valid_format = bool(_re.match(r'^[a-zA-Z0-9_]+:[a-zA-Z0-9_]+$', src))
                    _is_valid = src in always_valid or src in known_contexts_now or _valid_format

                    if not _is_valid:
                        warn = f"Malformed source_context '{src}'. Use format type:Title (e.g. show:Death_Note, audiobook:Dune)"
                        print(f"--- [KG WARN] {warn} ---")
                        streamer.push("system_warn", {"text": warn, "entry": kg_entry})

                    else:
                        try:
                            sid = db_manager.kg_add_subject(
                                actor_id, subj, stype,
                                description=desc or None,
                                source=src, confidence=0.85
                            )
                            if rel and obj:
                                # Resolve object to an ID so relations link properly in both directions
                                existing_obj = db_manager.kg_get_subject(actor_id, obj)
                                if existing_obj:
                                    oid = existing_obj['subject_id']
                                else:
                                    oid = db_manager.kg_add_subject(
                                        actor_id, obj, "Entity",
                                        description=None,
                                        source=src, confidence=0.85
                                    )
                                db_manager.kg_add_relation(
                                    actor_id, sid, rel,
                                    object_id=oid, object_literal=obj, source=src
                                )
                            confirm = f"{subj} [{stype}, ctx: {src}]"
                            if rel and obj:
                                confirm += f" → {rel} → {obj}"
                            print(f"--- [KG WRITE] {confirm} ---")
                            streamer.push("kg_write", {"text": confirm, "entry": kg_entry})
                        except Exception as ke:
                            warn = f"KG write failed: {ke}"
                            print(f"--- [KG ERROR] {warn} ---")
                            streamer.push("system_warn", {"text": warn})

        # C. TTS pipeline — only when speaking
        if will_speak and spoken_text.strip():
            import re
            raw_paragraphs = re.split(r'\n+', spoken_text)
            
            for i, raw_para in enumerate(raw_paragraphs):
                clean_para = clean_text_for_speech(raw_para)
                if not clean_para or len(clean_para) < 2:
                    continue
                    
                print(f"--- Processing Chunk {i+1} (Paragraph): {clean_para[:50]}... ---")
                
                audio_id = f"stream_{int(time.time())}_{i}"
                wav_path = os.path.join(TEMP_DIR, f"{audio_id}.wav")
                voice_ref = db_manager.get_actor_trait(actor_id, "voice_reference_audio", None)
                
                try:
                    tts_engine.generate(clean_para, wav_path, voice_reference_audio=voice_ref)
                except Exception as e:
                    warn = f"TTS unavailable for this chunk: {e}"
                    print(f"TTS Fail: {e}")
                    # Degrade gracefully: keep chat functional even when voice backend is down.
                    streamer.push("system_warn", {"text": warn})
                    streamer.push("assistant_text", {
                        "text": clean_para,
                        "stats": {"energy": new_energy}
                    })
                    continue

                vis_path = os.path.join(TEMP_DIR, f"{audio_id}_visemes.json")
                process_audio_for_lipsync(wav_path, vis_path)
                
                streamer.push("audio", {
                    "audioUrl": f"./temp/{audio_id}.wav",
                    "visemeUrl": f"./temp/{audio_id}_visemes.json",
                    "text": clean_para,
                    "stats": {"energy": new_energy}
                })

        streamer.push("done", {})
        print("--- Stream Complete ---")
        
    except Exception as e:
        print(f"Stream Error: {e}")
        streamer.push("error", str(e))

class ChatBridgeHandler(BaseHTTPRequestHandler):
    def _set_headers(self, response_code=200):
        self.send_response(response_code)
        self.send_header('Content-type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_OPTIONS(self):
        self._set_headers()

    def do_GET(self):
        if self.path == '/get_actors':
            actors = db_manager.get_all_actors()
            result = {"characters": []}
            for a in actors:
                result["characters"].append({
                    "id": a["actor_id"],
                    "label": a["manifest_data"].get("label", a["actor_id"]),
                    "vrm": a["vrm_path"]
                })
            self._set_headers()
            self.wfile.write(json.dumps(result).encode('utf-8'))

        elif self.path == '/get_controls':
            controls = db_manager.get_ui_controls()
            tabs_map = {}
            for c in controls:
                tid = c["tab_id"]
                if tid not in tabs_map:
                    tabs_map[tid] = {"id": tid, "label": tid.capitalize(), "sliders": []}
                tabs_map[tid]["sliders"].append({
                    "id": c["control_id"],
                    "label": c["label"],
                    "min": c["min"],
                    "max": c["max"],
                    "step": c["step"],
                    "default": c["default"]
                })
            self._set_headers()
            self.wfile.write(json.dumps({"tabs": list(tabs_map.values())}).encode('utf-8'))

        elif self.path.startswith('/get_interests'):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            aid = (qs.get('actor_id') or [''])[0] or get_default_actor_id()
            interests = db_manager.get_actor_interests(aid)
            self._set_headers()
            self.wfile.write(json.dumps({'interests': interests}).encode('utf-8'))

        elif self.path.startswith('/get_memory_blocks'):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            aid = (qs.get('actor_id') or [''])[0] or get_default_actor_id()
            limit = int((qs.get('limit') or ['15'])[0])
            btype = (qs.get('type') or ['page'])[0]
            blocks = db_manager.get_memory_blocks(aid, limit=limit, block_type=btype)
            self._set_headers()
            self.wfile.write(json.dumps({'blocks': blocks}).encode('utf-8'))

        elif self.path.startswith('/onboarding_status'):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            aid = (qs.get('actor_id') or [''])[0] or get_default_actor_id()
            actor = db_manager.get_actor(aid)
            manifest = (actor or {}).get('manifest_data', {}) or {}
            persona = str(manifest.get('persona', '') or '').strip()
            voice = str(manifest.get('voice_description', '') or '').strip()
            model = str(manifest.get('llm_model', '') or '').strip()
            dialogue_count = int(db_manager.get_dialogue_count(aid) or 0)
            animation_count = int(db_manager.get_animation_count() or 0)
            payload = {
                "actor_id": aid,
                "traits_present": bool(persona or voice or model),
                "dialogue_count": dialogue_count,
                "has_dialogue": dialogue_count > 0,
                "animation_count": animation_count,
                "has_indexed_animations": animation_count > 0,
            }
            self._set_headers()
            self.wfile.write(json.dumps(payload).encode('utf-8'))

        elif self.path.startswith('/preflight'):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            model = (qs.get('model') or [''])[0].strip()
            cmd = [sys.executable, str(os.path.join(PROJECT_ROOT, "tools", "bootstrap.py")), "--check", "--json"]
            if model:
                cmd.extend(["--model", model])
            try:
                proc = subprocess.run(
                    cmd,
                    cwd=PROJECT_ROOT,
                    text=True,
                    capture_output=True,
                    timeout=120
                )
                out = (proc.stdout or "").strip()
                err = (proc.stderr or "").strip()
                data = None
                for candidate in (out, err):
                    if not candidate:
                        continue
                    try:
                        data = json.loads(candidate)
                        break
                    except Exception:
                        continue
                if data is None:
                    data = {"ok_count": 0, "total": 0, "all_passed": False, "checks": []}
                data["returncode"] = proc.returncode
                if err:
                    data["stderr"] = err
                self._set_headers(200)
                self.wfile.write(json.dumps(data).encode('utf-8'))
            except Exception as e:
                self._set_headers(500)
                self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))

        elif self.path == '/get_models':
            try:
                req = urllib.request.Request("http://localhost:11434/api/tags")
                with urllib.request.urlopen(req) as response:
                    data = json.loads(response.read().decode('utf-8'))
                    models = [m['name'] for m in data.get('models', [])]
                    self._set_headers()
                    self.wfile.write(json.dumps({"models": models}).encode('utf-8'))
            except Exception as e:
                # Fallback if Ollama is not reachable or returns error
                self._set_headers()
                self.wfile.write(json.dumps({"models": ["fimbulvetr-v2.1:latest", "mistral", "llama3"]}).encode('utf-8'))

        elif self.path == '/stream_audio':
            self.send_response(200)
            self.send_header('Content-type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            print("--- Client Connected to SSE Stream ---")
            
            # Keep connection open until client disconnects or we break
            while True:
                try:
                    try:
                        import queue
                        msg = streamer.get(timeout=5)
                    except queue.Empty:
                        # Send an SSE event instead of a comment, so the frontend onmessage triggers and resets the watchdog
                        ping_msg = {"type": "ping", "data": "keep-alive"}
                        event_data = f"data: {json.dumps(ping_msg)}\n\n"
                        self.wfile.write(event_data.encode('utf-8'))
                        self.wfile.flush()
                        continue
                        
                    event_data = f"data: {json.dumps(msg)}\n\n"
                    self.wfile.write(event_data.encode('utf-8'))
                    self.wfile.flush()
                    
                    if msg['type'] == 'done' or msg['type'] == 'error':
                        break
                except Exception as e:
                    print(f"SSE Broken Pipe: {e}")
                    break
            print("--- SSE Stream Closed ---")

        elif self.path == '/kg_contexts':
            # GET /kg_contexts?actor_id=...
            actor_id_param = urllib.parse.urlparse(self.path)
            from urllib.parse import parse_qs
            qs = parse_qs(urllib.parse.urlparse(self.path).query)
            aid = (qs.get('actor_id') or [''])[0] or get_default_actor_id()
            contexts = db_manager.kg_get_contexts(aid)
            self._set_headers()
            self.wfile.write(json.dumps({'contexts': contexts}).encode('utf-8'))

        elif self.path == '/scan_animations':
            unindexed = scan_and_clean_animations()
            self._set_headers()
            self.wfile.write(json.dumps(unindexed).encode('utf-8'))

        elif self.path == '/get_registry_animations':
            anims = db_manager.get_all_animations()
            self._set_headers()
            self.wfile.write(json.dumps(anims).encode('utf-8'))

        # ---- Persona Editor API ----
        elif self.path.startswith('/persona/'):
            actor_id = urllib.parse.unquote(self.path.split('/persona/')[1].split('?')[0])
            identity = db_manager.get_actor_identity(actor_id)
            moods = db_manager.get_all_moods(actor_id)
            modes = db_manager.get_all_mode_prompts(actor_id)
            current_mood = db_manager.get_current_mood(actor_id)
            self._set_headers()
            self.wfile.write(json.dumps({
                'identity': identity,
                'moods': moods,
                'modes': modes,
                'current_mood': current_mood,
            }).encode('utf-8'))

        # ---- Knowledge Graph API ----
        elif self.path.startswith('/kg/'):
            actor_id = urllib.parse.unquote(self.path.split('/kg/')[1].split('?')[0])
            subjects = db_manager.kg_get_all_subjects(actor_id)
            # Enrich each subject with its relations
            for s in subjects:
                s['relations'] = db_manager.kg_get_relations(actor_id, s['subject_id'], min_confidence=0.0)
                s['ancestors'] = db_manager.kg_get_ancestors(s['subject_id'])
            self._set_headers()
            self.wfile.write(json.dumps({'subjects': subjects}).encode('utf-8'))

        else:
            self._set_headers(404)
            self.wfile.write(b'{"error": "Not Found"}')


    def do_POST(self):
        if self.path == '/chat':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            
            user_message = data.get('message', '')
            actor_id = data.get('actor_id') or get_default_actor_id()
            
            # --- REGION 2: Fetch Persistent Traits ---
            persona = data.get('system')
            if not persona:
                persona = db_manager.get_actor_trait(actor_id, "persona", "You are a helpful AI.")
            
            voice_desc = db_manager.get_actor_trait(actor_id, "voice_description", "A warm, gentle female voice.")

            print(f"--- Chat Request (Actor: {actor_id}) ---")
            print(f"User: {user_message}")
            try:
                # --- REGION 1: Reality Update ---
                db_manager.set_reality("active_actor", actor_id)
                global _active_actor_id, _last_activity_time
                _active_actor_id = actor_id
                _last_activity_time = time.time()
                
                # --- REGION 3: Memory Logging (User) ---
                db_manager.log_dialogue(actor_id, "user", user_message)

                # --- REGION 3: History Retrieval ---
                history = db_manager.get_recent_history(actor_id, limit=15)
                
                # --- START BACKGROUND STREAMING ---
                requested_model = data.get('model')
                images = data.get('images', [])

                if not requested_model:
                    requested_model = db_manager.get_actor_trait(actor_id, "llm_model", "fimbulvetr-v2.1:latest")

                # --- PUSH TO SERIAL QUEUE ---
                chat_queue.put({
                    "messages": history,
                    "actor_id": actor_id,
                    "model": requested_model,
                    "voice_desc": voice_desc,
                    "images": images,
                    "extra_data": {
                        "extra_context": data.get('extra_context')
                    }
                })
                
                # Return success immediately so client can subscribe to SSE
                self._set_headers()
                self.wfile.write(json.dumps({"status": "queued"}).encode('utf-8'))
                
            except Exception as e:
                print(f"Chat POST Error: {e}")
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode('utf-8'))

        elif self.path == '/reset_memory':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            actor_id = data.get('actor_id') or get_default_actor_id()
            db_manager.reset_recent_history(actor_id)
            self._set_headers()
            self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))

        elif self.path == '/mind_maintenance':
            content_length = int(self.headers.get('Content-Length', 0))
            data = {}
            if content_length > 0:
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data.decode('utf-8'))

            actor_id = data.get('actor_id') or get_default_actor_id()
            apply_mode = bool(data.get('apply', True))
            mode_flag = '--apply' if apply_mode else '--dry-run'

            script_path = os.path.join(PROJECT_ROOT, 'tools', 'mind_maintenance.py')
            cmd = [sys.executable, script_path, '--actor', actor_id, mode_flag]

            try:
                proc = subprocess.run(
                    cmd,
                    cwd=PROJECT_ROOT,
                    capture_output=True,
                    text=True,
                    timeout=120,
                    check=False,
                )
            except Exception as e:
                self._set_headers(500)
                self.wfile.write(json.dumps({"error": f"Failed to run maintenance: {str(e)}"}).encode('utf-8'))
                return

            output = (proc.stdout or "").strip()
            err = (proc.stderr or "").strip()
            if proc.returncode != 0:
                self._set_headers(500)
                self.wfile.write(json.dumps({
                    "error": "Mind maintenance failed.",
                    "stdout": output,
                    "stderr": err,
                    "returncode": proc.returncode
                }).encode('utf-8'))
                return

            summary = {}
            for line in output.splitlines():
                line = line.strip()
                m = re.match(r"^- ([a-z_]+):\s+([0-9]+)$", line)
                if m:
                    summary[m.group(1)] = int(m.group(2))

            self._set_headers()
            self.wfile.write(json.dumps({
                "status": "success",
                "actor_id": actor_id,
                "mode": "apply" if apply_mode else "dry-run",
                "summary": summary,
                "stdout": output,
            }).encode('utf-8'))

        elif self.path == '/update_trait':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            actor_id = data.get('actor_id') or get_default_actor_id()
            trait = data.get('trait')
            value = data.get('value')
            if trait and value:
                db_manager.update_actor_trait(actor_id, trait, value)
                self._set_headers()
                self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))
            else:
                self.send_response(400)
                self.end_headers()

        elif self.path == '/get_traits':
            content_length = int(self.headers.get('Content-Length', 0))
            actor_id = get_default_actor_id()
            if content_length > 0:
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data.decode('utf-8'))
                actor_id = data.get('actor_id') or get_default_actor_id()
            actor = db_manager.get_actor(actor_id)
            traits = actor['manifest_data'] if actor else {}
            self._set_headers()
            self.wfile.write(json.dumps(traits).encode('utf-8'))

        elif self.path == '/get_models': # Legacy POST support
            self.do_GET()

        elif self.path == '/get_actors': # Legacy POST support
            self.do_GET()

        elif self.path == '/get_controls': # Legacy POST support
            self.do_GET()

        elif self.path == '/index_animation':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            
            # extract fields
            filename = data.get('filename')
            category = data.get('category')
            trigger = data.get('trigger', '')
            purpose = data.get('purpose', '')
            effect = data.get('effect', '')
            
            if filename and category and trigger and purpose:
                db_manager.register_animation(filename, category, trigger, purpose, effect)
                self._set_headers()
                self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))
            else:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Missing required fields")

        elif self.path == '/get_animation_metadata':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            filename = data.get('filename')
            
            if filename:
                meta = db_manager.get_animation_by_path(filename)
                if meta:
                    self._set_headers()
                    self.wfile.write(json.dumps(meta).encode('utf-8'))
                else:
                    self.send_response(404)
                    self.end_headers()
                    self.wfile.write(b"Animation not found in registry")
            else:
                self.send_response(400)
                self.end_headers()

        # ---- Persona Editor Save Endpoints ----

        elif self.path == '/save_identity':
            d = json.loads(self.rfile.read(int(self.headers['Content-Length'])).decode())
            db_manager.set_actor_identity(
                d['actor_id'], d['name'],
                d.get('core_traits',''), d.get('speech_style',''), d.get('values','')
            )
            self._set_headers()
            self.wfile.write(json.dumps({'status': 'ok'}).encode())

        elif self.path == '/save_mood':
            d = json.loads(self.rfile.read(int(self.headers['Content-Length'])).decode())
            db_manager.set_mood(
                d['actor_id'], d['mood_id'], d['display_name'], d['behavioral_text'],
                d.get('transition_up'), d.get('transition_down')
            )
            self._set_headers()
            self.wfile.write(json.dumps({'status': 'ok'}).encode())

        elif self.path == '/set_mood':
            d = json.loads(self.rfile.read(int(self.headers['Content-Length'])).decode())
            db_manager.set_current_mood(d['actor_id'], d['mood_id'])
            self._set_headers()
            self.wfile.write(json.dumps({'status': 'ok'}).encode())

        elif self.path == '/save_mode':
            d = json.loads(self.rfile.read(int(self.headers['Content-Length'])).decode())
            db_manager.set_mode_prompt(
                d['actor_id'], d['mode_id'], d['display_name'],
                d['system_text'], d.get('trigger_prefix')
            )
            self._set_headers()
            self.wfile.write(json.dumps({'status': 'ok'}).encode())

        # ---- Knowledge Graph Save Endpoints ----

        elif self.path == '/kg_save_subject':
            d = json.loads(self.rfile.read(int(self.headers['Content-Length'])).decode())
            import json as _json
            aliases = d.get('aliases', [])
            if isinstance(aliases, str):
                aliases = [a.strip() for a in aliases.split(',') if a.strip()]
            sid = db_manager.kg_add_subject(
                d['actor_id'], d['canonical_name'], d['subject_type'],
                d.get('description'), aliases, float(d.get('confidence', 1.0)),
                d.get('source', 'manual')
            )
            self._set_headers()
            self.wfile.write(json.dumps({'status': 'ok', 'subject_id': sid}).encode())

        elif self.path == '/kg_save_relation':
            d = json.loads(self.rfile.read(int(self.headers['Content-Length'])).decode())
            db_manager.kg_add_relation(
                d['actor_id'], int(d['subject_id']), d['predicate'],
                int(d['object_id']) if d.get('object_id') else None,
                d.get('object_literal'), float(d.get('confidence', 1.0)),
                d.get('source', 'manual')
            )
            self._set_headers()
            self.wfile.write(json.dumps({'status': 'ok'}).encode())

        elif self.path == '/kg_delete_subject':
            d = json.loads(self.rfile.read(int(self.headers['Content-Length'])).decode())
            conn = db_manager.get_connection()
            c = conn.cursor()
            sid = int(d['subject_id'])
            c.execute('DELETE FROM kg_relations WHERE subject_id=? OR object_id=?', (sid, sid))
            c.execute('DELETE FROM kg_hierarchy WHERE child_id=? OR parent_id=?', (sid, sid))
            c.execute('DELETE FROM kg_subjects WHERE subject_id=?', (sid,))
            conn.commit(); conn.close()
            self._set_headers()
            self.wfile.write(json.dumps({'status': 'ok'}).encode())


def cleanup_temp():
    """Fully purge runtime temp assets on startup (keeps .gitkeep if present)."""
    if not os.path.exists(TEMP_DIR):
        os.makedirs(TEMP_DIR)
        print(f"--- Storage Hygiene: Created {TEMP_DIR} (0 files) ---")
        return

    deleted = 0
    before = 0
    for root, _, files in os.walk(TEMP_DIR):
        for name in files:
            if name == ".gitkeep":
                continue
            before += 1

    print(f"--- Storage Hygiene: Cleaning {TEMP_DIR} ({before} files) ---")

    for root, dirs, files in os.walk(TEMP_DIR, topdown=False):
        for name in files:
            if name == ".gitkeep":
                continue
            path = os.path.join(root, name)
            try:
                os.remove(path)
                deleted += 1
            except Exception as e:
                print(f"Temp cleanup warning: failed to delete {path}: {e}")

        for d in dirs:
            dpath = os.path.join(root, d)
            try:
                os.rmdir(dpath)
            except OSError:
                # Directory not empty or protected; safe to ignore.
                pass

    print(f"--- Storage Hygiene: Removed {deleted} files ---")

# --- ANIMATION SCANNER ---
def scan_and_clean_animations():
    """
    Scans assets/animations for:
    1. Unindexed Oneshots/Action Loops (Returns list)
    2. Missing files that are in DB (Deletes from DB)
    """
    anim_root = os.path.join(PROJECT_ROOT, "assets/animations")
    
    # 1. Maps on disk (Category -> [rel_paths])
    found_files = {} 
    
    # Categories to scan (Idle Loops are EXEMPT)
    scan_targets = {
        "idle_oneshot": os.path.join(anim_root, "idle/oneshot"),
        "action_loop": os.path.join(anim_root, "actions/loop"),
        "action_oneshot": os.path.join(anim_root, "actions/oneshot")
    }
    
    all_disk_paths = []
    
    # SCAN DISK
    for category, base_path in scan_targets.items():
        if not os.path.exists(base_path):
            continue
        
        for root, dirs, files in os.walk(base_path):
            for f in files:
                if f.lower().endswith('.fbx'):
                    full_path = os.path.join(root, f)
                    rel_path = os.path.relpath(full_path, anim_root)
                    # Normalize path separators
                    rel_path = rel_path.replace("\\", "/")
                    all_disk_paths.append(rel_path)
                    
                    # Check DB
                    if not db_manager.get_animation_by_path(rel_path):
                        if category not in found_files:
                            found_files[category] = []
                        found_files[category].append({
                            "filename": rel_path,
                            "category": category,
                            "name": f
                        })

    # CLEANUP DB (Remove ghosts)
    known_anims = db_manager.get_all_animations()
    for anim in known_anims:
        # Check existence (using full path)
        full_path = os.path.join(anim_root, anim['filename'])
        if not os.path.exists(full_path):
            print(f"--- Cleanup: Removing ghost animation {anim['filename']} from DB ---")
            db_manager.delete_animation(anim['anim_id'])
            
    return found_files

def run_server(port=8001):
    db_manager.init_db() # Ensure tables exist
    cleanup_temp() # Clean up on startup
    server_address = ('', port)
    httpd = ThreadingHTTPServer(server_address, ChatBridgeHandler)
    # Start Chat Worker Thread
    threading.Thread(target=chat_worker, daemon=True).start()
    # Start Idle Monitor Thread
    threading.Thread(target=idle_monitor, daemon=True).start()
    
    print(f"--- Chat Bridge running on port {port} ---")
    httpd.serve_forever()

if __name__ == "__main__":
    run_server()
