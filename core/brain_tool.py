import json
import os
import random
import json
import os
import random
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

    def extract_concepts(self, actor_id, message_range_str, model_id=None):
        """
        Stage 1: Analyzes a range of messages and identifies key concepts/ideas.
        """
        # Fetch the history for this range (placeholder logic: last 10 messages)
        history = db_manager.get_recent_history(actor_id, limit=10)
        history_str = "\n".join([f"{h['role']}: {h['content']}" for h in history])

        system_msg = ("Analyze the following conversation carefully. Identify the main subjects, "
                      "key concepts, and any important ideas mentioned. "
                      "Format your output as a JSON object with 'concepts' (list of strings) "
                      "and 'description' (short summary).")
        
        user_msg = f"CONVERSATION:\n{history_str}\n\nKey Concepts and Summary:"
        
        raw_result = self._run_ollama(system_msg, user_msg, model_id)
        print(f"--- Brain Tool: Raw extraction result length: {len(raw_result)}")
        
        try:
            # Attempt to parse JSON from the LLM output
            start = raw_result.find('{')
            end = raw_result.rfind('}') + 1
            if start != -1 and end != -1:
                data = json.loads(raw_result[start:end])
                content = data.get('description', raw_result)
                # Ensure content is a string for SQL safety
                if not isinstance(content, str):
                    content = json.dumps(content)
                    
                concepts = data.get('concepts', [])
                db_manager.add_memory_block(actor_id, content, concepts, message_range_str)
                print(f"--- Brain Tool: Successfully extracted {len(concepts)} concepts for {actor_id}")
                return True
            else:
                # No JSON markers found, treat whole thing as description
                db_manager.add_memory_block(actor_id, raw_result, [], message_range_str)
                print(f"--- Brain Tool: Stored raw text memory (No JSON found)")
                return True
        except Exception as e:
            print(f"BrainTool Extraction Error: {e}")
            # Fallback: store as raw text
            db_manager.add_memory_block(actor_id, raw_result, [], message_range_str)
            print(f"--- Brain Tool: Stored raw text memory due to error")
        
        return False

    def refine_memory(self, actor_id, model_id=None):
        """
        Stage 2: Consolidates multiple memory blocks into a cohesive summary.
        """
        blocks = db_manager.get_memory_blocks(actor_id, limit=5)
        if not blocks:
            return ""

        summary_parts = [b['content'] for b in blocks]
        concepts = db_manager.get_all_concepts(actor_id)
        
        system_msg = ("You are a memory consolidation engine. Below are several summary blocks and "
                      "a list of key concepts from past conversations. Rewrite these into a single, "
                      "cohesive, and naturally readable narrative summary. "
                      "STRICT RULE: Use ONLY factual reporting. No roleplay, no asterisks, no dialogue snippets.")
        
        user_msg = f"CONCEPTS: {', '.join(concepts)}\n\nSUMMARY BLOCKS:\n" + "\n---\n".join(summary_parts)
        
        print(f"--- Brain Tool: Refining {len(blocks)} memory blocks for {actor_id}")
        refined_summary = self._run_ollama(system_msg, user_msg, model_id)
        print(f"--- Brain Tool: Refined summary length: {len(refined_summary)}")
        
        # Store refined summary in the actor's manifest traits for the main bridge to use
        db_manager.update_actor_trait(actor_id, "background_memory", refined_summary)
        return refined_summary
