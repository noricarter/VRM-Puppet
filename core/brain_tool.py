import json
import os
import re
import db_manager

class BrainTool:
    def __init__(self):
        self.project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    def _ensure_model_exists(self, model_id):
        """Checks if a model exists in Ollama, otherwise finds a fallback."""
        import urllib.request
        try:
            # First check if the requested one is there
            tags_req = urllib.request.Request("http://localhost:11434/api/tags")
            with urllib.request.urlopen(tags_req) as tags_resp:
                tags_data = json.loads(tags_resp.read().decode('utf-8'))
                available = [m.get('name') for m in tags_data.get('models', [])]
                if model_id in available:
                    return model_id
                
                # If not, try common variants or the first available
                for m in available:
                    if model_id.split(':')[0] in m:
                        print(f"--- Brain Tool: Fallback to variant '{m}' ---")
                        return m
                
                if available:
                    print(f"--- Brain Tool: Total Fallback to '{available[0]}' ---")
                    return available[0]
        except Exception as e:
            print(f"--- Brain Tool: Model check failed: {e}")
        return model_id # Hope for the best

    def _run_ollama(self, system_msg, user_msg, model_id=None):
        if not model_id:
            model_id = "fimbulvetr-v2.1:latest" # Default
            
        model_id = self._ensure_model_exists(model_id)
        
        import urllib.request
        url = "http://localhost:11434/api/generate"
        payload = {
            "model": model_id,
            "prompt": user_msg,
            "system": system_msg,
            "stream": False,
            "keep_alive": 0
        }
        
        try:
            req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'))
            with urllib.request.urlopen(req) as response:
                res_data = json.loads(response.read().decode('utf-8'))
                return res_data.get('response', '').strip()
        except Exception as e:
            print(f"BrainTool direct Ollama call failed: {e}")
            return ""

    def extract_concepts(self, actor_id, message_range_str, model_id=None, dialogue_rows=None, start_t=None, end_t=None):
        """
        Stage 1: Analyzes a range of messages and identifies key concepts/ideas.
        Creates a 'page' block with start/end timestamps.
        """
        # Use supplied non-overlapping dialogue slice when provided.
        if dialogue_rows:
            history = [{"role": r.get('role', ''), "content": r.get('content', '')} for r in dialogue_rows]
            history_str = "\n".join([f"{h['role']}: {h['content']}" for h in history])
            start_t = start_t or dialogue_rows[0].get('timestamp')
            end_t = end_t or dialogue_rows[-1].get('timestamp')
        else:
            # Fallback for legacy/manual callers.
            history = db_manager.get_recent_history(actor_id, limit=15)
            history_str = "\n".join([f"{h['role']}: {h['content']}" for h in history])
            start_t, end_t = db_manager.get_dialogue_timestamp_range(actor_id, limit=15)

        system_msg = ("Analyze the following conversation carefully. Identify the main subjects, "
                      "key concepts, and any important ideas mentioned. "
                      "Format your output as a JSON object with 'concepts' (list of strings) "
                      "and 'description' (a cohesive 2-3 sentence narrative summary). "
                      "Include the period 'Period: [Start] to [End]' at the top of the description "
                      f"using these times: {start_t} to {end_t}")
        
        user_msg = f"CONVERSATION:\n{history_str}\n\nKey Concepts and Summary:"
        
        raw_result = (self._run_ollama(system_msg, user_msg, model_id) or "").strip()

        # Try strict JSON extraction first.
        content = ""
        concepts = []
        try:
            start = raw_result.find('{')
            end = raw_result.rfind('}')
            if start != -1 and end != -1 and end >= start:
                data = json.loads(raw_result[start:end + 1])
                content = str(data.get('description') or '').strip()
                parsed_concepts = data.get('concepts') or []
                if isinstance(parsed_concepts, list):
                    concepts = [str(c).strip() for c in parsed_concepts if str(c).strip()]
        except Exception as e:
            print(f"BrainTool Extraction JSON parse warning: {e}")

        # Fallback if model output is non-JSON or malformed.
        if not content:
            tail = history[-8:]
            lines = []
            for h in tail:
                role = str(h.get('role', 'unknown'))
                text = str(h.get('content', '')).strip()
                if not text:
                    continue
                lines.append(f"{role}: {text[:140]}")
            stitched = " | ".join(lines) if lines else "(no recent dialogue captured)"
            content = f"Period: {start_t} to {end_t}\n{stitched}"

        if not concepts:
            # Lightweight concept fallback: proper-like tokens from recent dialogue.
            caps = re.findall(r"\b[A-Z][A-Za-z0-9_'-]{2,}\b", history_str)
            dedup = []
            for token in caps:
                if token not in dedup:
                    dedup.append(token)
                if len(dedup) >= 12:
                    break
            concepts = dedup

        try:
            bid = db_manager.add_memory_block(
                actor_id, content, concepts, message_range_str,
                block_type='page', start_time=start_t, end_time=end_t
            )
            self._link_to_kg(actor_id, bid, content)
            return True
        except Exception as e:
            print(f"BrainTool Extraction DB write failed: {e}")
            return False

    def refine_memory(self, actor_id, target_type='chapter', model_id=None):
        """
        Stage 2: Consolidates multiple child blocks into a higher-level summary (Chapter or Book).
        """
        child_type = 'page' if target_type == 'chapter' else 'chapter'
        blocks = db_manager.get_memory_blocks(actor_id, limit=5, block_type=child_type)
        
        if not blocks:
            return ""

        # Aggregate child data
        summary_parts = [b['content'] for b in blocks]
        all_concepts = set()
        for b in blocks:
            try:
                all_concepts.update(json.loads(b['concepts']))
            except: pass
            
        start_t = blocks[-1]['start_time'] # Blocks are DESC, so last is earliest
        end_t = blocks[0]['end_time']
        
        system_msg = (f"You are a memory consolidation engine. Below are several {child_type} blocks. "
                      f"Rewrite these into a single, cohesive {target_type} summary. "
                      "STRICT RULE: Use ONLY factual reporting. No roleplay. "
                      f"Include the header 'Period: {start_t} to {end_t}' at the top.")
        
        user_msg = f"CONCEPTS: {', '.join(all_concepts)}\n\n{child_type.upper()} BLOCKS:\n" + "\n---\n".join(summary_parts)
        
        refined_summary = self._run_ollama(system_msg, user_msg, model_id)
        
        # Store as new block
        bid = db_manager.add_memory_block(
            actor_id, refined_summary, list(all_concepts), f"refine_{child_type}",
            block_type=target_type, start_time=start_t, end_time=end_t
        )
        self._link_to_kg(actor_id, bid, refined_summary)

        # Update background memory if this is the most recent high-level consolidation
        if target_type in ('chapter', 'book'):
            db_manager.update_actor_trait(actor_id, "background_memory", refined_summary)
            
        return refined_summary

    def _link_to_kg(self, actor_id, block_id, text):
        """Finds KG subjects mentioned in the text and links them to the block."""
        # Simple heuristic: fetch all subjects for this actor and check if name is in text
        # In a real RAG system, this would be an embedding search or NER.
        subjects = db_manager.kg_get_contexts(actor_id) # Technically returns names of non-internal contexts
        # Better: get all subjects
        import sqlite3
        conn = sqlite3.connect(os.path.join(self.project_root, "core/persistence.db"))
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT subject_id, canonical_name FROM kg_subjects WHERE actor_id = ?", (actor_id,))
        rows = cursor.fetchall()
        
        for r in rows:
            if r['canonical_name'].lower() in text.lower():
                db_manager.kg_link_memory(r['subject_id'], block_id)
        conn.close()
