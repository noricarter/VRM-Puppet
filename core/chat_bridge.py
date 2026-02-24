import json
import re
import urllib.request
import urllib.parse
import uuid
import time
import os
import shutil
import threading
import queue
from http.server import HTTPServer, BaseHTTPRequestHandler, ThreadingHTTPServer
from media_pipeline import process_audio_for_lipsync
from brain_tool import BrainTool
from tts_engine import TTSEngine
import db_manager
from prompt_composer import PromptComposer

_composer = PromptComposer()

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
                    req_data['images']
                )
            except Exception as ge:
                print(f"--- Queue: Generation Error: {ge} ---")
                streamer.push("error", f"Generation failed: {str(ge)}")
            
            chat_queue.task_done()
        except Exception as e:
            print(f"--- Queue Worker Critical Error: {e} ---")
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

    def get(self):
        return self.msg_queue.get()

# Global stream instance (Persistent Singleton)
streamer = StreamHandler()

def generate_and_stream(messages, actor_id, requested_model, voice_desc, images=None):
    """Background thread function to generate text and stream audio chunks."""
    # streamer = StreamHandler() # REMOVED: Never replace the global singleton!
    print(f"--- Chat Stream Started for {actor_id} ---")
    
    # 1. Update Stats (Energy Cost)
    stats = db_manager.get_actor_stats(actor_id)
    new_energy = max(0, stats.get('energy', 1.0) - 0.05)
    db_manager.set_actor_stats(actor_id, stats.get('stamina', 1.0), new_energy, stats.get('mood', 'Neutral'))
    
    ollama_url = "http://localhost:11434/api/chat"
    # If images were provided, attach them to the LAST user message in the payload
    # Ollama vision models expect "images": ["base64_data"] inside a message object
    if images and len(messages) > 0:
        # We find the last user message and attach the images
        for i in range(len(messages) - 1, -1, -1):
            if messages[i]['role'] == 'user':
                messages[i]['images'] = images
                print(f"--- Vision: Attached {len(images)} image(s) to prompt ---")
                break

    ollama_payload = {
        "model": requested_model,
        "messages": messages,
        "format": "json",
        "stream": False,
        "keep_alive": -1
    }
    
    ai_full_text = ""
    reasoning_data = {}
    
    print(f"--- Calling Ollama Chat (Model: {requested_model}) ---")
    
    try:
        req = urllib.request.Request(ollama_url, data=json.dumps(ollama_payload).encode('utf-8'))
        raw_json = "{}"
        try:
            with urllib.request.urlopen(req) as resp:
                result_data = json.loads(resp.read().decode('utf-8'))
                raw_json = result_data.get('message', {}).get('content', '{}')
        except urllib.error.HTTPError as he:
            if he.code == 404:
                print(f"!!! Model '{requested_model}' not found in Ollama. Attempting auto-fallback...")
                try:
                    tags_req = urllib.request.Request("http://localhost:11434/api/tags")
                    with urllib.request.urlopen(tags_req) as tags_resp:
                        tags_data = json.loads(tags_resp.read().decode('utf-8'))
                        available = tags_data.get('models', [])
                        if available:
                            fallback_name = available[0].get('name')
                            print(f"--- Fallback: Retrying with '{fallback_name}' ---")
                            ollama_payload['model'] = fallback_name
                            req = urllib.request.Request(ollama_url, data=json.dumps(ollama_payload).encode('utf-8'))
                            with urllib.request.urlopen(req) as resp2:
                                res2_data = json.loads(resp2.read().decode('utf-8'))
                                raw_json = res2_data.get('message', {}).get('content', '{}')
                        else:
                            raise Exception("No models available in Ollama.")
                except Exception as fe:
                    print(f"Fallback Failed: {fe}")
                    raise he
            else:
                raise he

        try:
            print(f"Raw Response: {raw_json}")
            
            # --- Robust JSON Extraction ---
            # LLMs sometimes add markdown blocks or trailing text
            start_idx = raw_json.find('{')
            end_idx = raw_json.rfind('}') + 1
            if start_idx != -1 and end_idx != -1:
                clean_json_str = raw_json[start_idx:end_idx]
            else:
                clean_json_str = raw_json

            try:
                reasoning_data = json.loads(clean_json_str)
                ai_full_text = reasoning_data.get('response', '')
                thought = reasoning_data.get('thought', 'Thinking...')
                intent = reasoning_data.get('physical_intent', '')
                selection_type = reasoning_data.get('selection_type', 'no_action')
                selected_action = reasoning_data.get('action')
                confidence = reasoning_data.get('confidence', 0)
            except Exception as je:
                print(f"!!! Final Parsing Error: {je}")
                # We stop trying to "rescue" it with bad regex. 
                # If the AI breaks the format, we let the user see the raw failure 
                # or a simple fallback, so we know the prompt needs work.
                ai_full_text = "I'm having some trouble focusing my thoughts. Could you say that again?"
                thought = "JSON parsing failed."
                intent = "None"
                selection_type = "no_action"
                selected_action = None
                confidence = 0

            print(f"--- AI Response: {ai_full_text} ---")
            
            # Enforce Threshold for execution only
            if selection_type == 'appropriate_action' and (not selected_action or confidence < 0.7):
                selected_action = None
                selection_type = 'missing_action' # Downgrade if confidence is low
                thought += " (Downgraded to missing: Confidence below threshold or no file)"
            
            # Push reasoning info to UI early
            streamer.push("reasoning", {
                "thought": thought,
                "intent": intent,
                "selection_type": selection_type,
                "action": selected_action,
                "confidence": confidence
            })
            
            # If an appropriate action was selected, push it to trigger the viewer
            if selection_type == 'appropriate_action' and selected_action:
                # Resolve relative path for frontend
                viewer_path = f"assets/animations/{selected_action}"
                streamer.push("action", {
                    "url": viewer_path,
                    "name": selected_action
                })
        except Exception as e:
            print(f"Processing Error: {e}")
            ai_full_text = "Internal error during reasoning extraction."

        print(f"Assistant Thought: {thought}")
        print(f"Assistant (Dialogue Only): {ai_full_text}")
        db_manager.log_dialogue(actor_id, "assistant", ai_full_text)
        
        # 3. SPLIT INTO PARAGRAPHS
        import re
        # Split by one or more newlines to respect paragraph breaks
        raw_paragraphs = re.split(r'\n+', ai_full_text)
        
        for i, raw_para in enumerate(raw_paragraphs):
            clean_para = clean_text_for_speech(raw_para)
            if not clean_para or len(clean_para) < 2:
                continue
                
            print(f"--- Processing Chunk {i+1} (Paragraph): {clean_para[:50]}... ---")
            
            # Generate Audio
            audio_id = f"stream_{int(time.time())}_{i}"
            wav_path = os.path.join(TEMP_DIR, f"{audio_id}.wav")
            
            # Fetch reference audio for cloning if it exists
            voice_ref = db_manager.get_actor_trait(actor_id, "voice_reference_audio", None)
            
            try:
                tts_engine.generate(clean_para, wav_path, voice_reference_audio=voice_ref)
            except Exception as e:
                print(f"TTS Fail: {e}")
                streamer.push("error", f"TTS Failed: {e}")
                continue

            # Generate Visemes
            vis_path = os.path.join(TEMP_DIR, f"{audio_id}_visemes.json")
            process_audio_for_lipsync(wav_path, vis_path)
            
            # Push Event
            streamer.push("audio", {
                "audioUrl": f"./temp/{audio_id}.wav",
                "visemeUrl": f"./temp/{audio_id}_visemes.json",
                "text": raw_para,
                "stats": {"energy": new_energy}
            })
            
        # 4. Finish
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
                    msg = streamer.get() # Blocking get
                    event_data = f"data: {json.dumps(msg)}\n\n"
                    self.wfile.write(event_data.encode('utf-8'))
                    self.wfile.flush()
                    
                    if msg['type'] == 'done' or msg['type'] == 'error':
                        break
                except Exception as e:
                    print(f"SSE Broken Pipe: {e}")
                    break
            print("--- SSE Stream Closed ---")

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
            actor_id = data.get('actor_id', 'Jane_Doe')
            
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
                stats = db_manager.get_actor_stats(actor_id)
                stamina = stats.get('stamina', 1.0)
                energy = stats.get('energy', 1.0)
                mood = stats.get('mood', 'Neutral')

                # --- REGION 3: Memory Logging (User) ---
                db_manager.log_dialogue(actor_id, "user", user_message)

                # --- REGION 3: Context Retrieval & Memory Management ---
                background_mem = db_manager.get_actor_trait(actor_id, "background_memory", "")
                history = db_manager.get_recent_history(actor_id, limit=15)
                
                # LAUNCH BACKGROUND MEMORY CONSOLIDATION (Disabled for Latency)
                # def run_memory_maintenance():
                #     if len(history) >= 12:
                #         print(f"--- Brain Tool: Starting background memory extraction for {actor_id} ---")
                #         range_str = f"recent_compression_{int(time.time())}"
                #         try:
                #             brain_tool.extract_concepts(actor_id, range_str, data.get('model'))
                #             brain_tool.refine_memory(actor_id, data.get('model'))
                #         except Exception as e:
                #             print(f"--- Brain Tool: Background error: {e}")

                # if len(history) >= 12:
                #     threading.Thread(target=run_memory_maintenance, daemon=True).start()

                # 4. Construct Final Messages Payload
                messages_payload = []

                # A. System Instructions — assembled by PromptComposer
                lib_str = format_action_library()
                full_system_msg = _composer.build_system_prompt(
                    actor_id=actor_id,
                    message=user_message,
                    action_library_str=lib_str,
                    legacy_persona=persona,
                    legacy_background=background_mem,
                    extra_context=data.get('extra_context'),  # RAG Phase 2 hook
                )

                messages_payload.append({"role": "system", "content": full_system_msg})

                # B. History (The Memory)
                # If history was just compressed by background thread, we should cap it here
                visible_history = history[-10:] if len(history) > 10 else history
                for h in visible_history:
                    messages_payload.append({"role": h['role'], "content": h['content']})

                # --- START BACKGROUND STREAMING ---
                requested_model = data.get('model')
                images = data.get('images', []) # Added mission support

                if not requested_model:
                    requested_model = db_manager.get_actor_trait(actor_id, "llm_model", "fimbulvetr-v2.1:latest")

                # --- PUSH TO SERIAL QUEUE ---
                chat_queue.put({
                    "messages": messages_payload,
                    "actor_id": actor_id,
                    "model": requested_model,
                    "voice_desc": voice_desc,
                    "images": images
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
            actor_id = data.get('actor_id', 'Jane_Doe')
            db_manager.reset_recent_history(actor_id)
            self._set_headers()
            self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))

        elif self.path == '/update_trait':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            actor_id = data.get('actor_id', 'Jane_Doe')
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
            actor_id = 'Jane_Doe'
            if content_length > 0:
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data.decode('utf-8'))
                actor_id = data.get('actor_id', 'Jane_Doe')
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
    """Removes temporary files older than 24 hours."""
    now = time.time()
    if not os.path.exists(TEMP_DIR):
        return
    
    print(f"--- Storage Hygiene: Cleaning {TEMP_DIR} ---")
    for f in os.listdir(TEMP_DIR):
        fpath = os.path.join(TEMP_DIR, f)
        if os.stat(fpath).st_mtime < now - 86400: # 24 hours
            if os.path.isfile(fpath):
                os.remove(fpath)
                print(f"Deleted old asset: {f}")

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
    
    print(f"--- Chat Bridge running on port {port} ---")
    print("Pre-requisite: ComfyUI must be running on port 8188.")
    httpd.serve_forever()

if __name__ == "__main__":
    run_server()
