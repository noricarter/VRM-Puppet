import json
import os
import sys

# Add core to path so we can import db_manager
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../core')))

from db_manager import init_db, register_actor, register_ui_control, register_workflow

# Paths
MANIFEST_PATH = "infrastructure/manifest.json.legacy"
CONTROLS_PATH = "infrastructure/controls.config.json"

def ingest_actors():
    if not os.path.exists(MANIFEST_PATH):
        print(f"Skipping actors: {MANIFEST_PATH} not found.")
        return
    with open(MANIFEST_PATH, 'r') as f:
        data = json.load(f)
    actors = data.get('characters', [])
    for actor in actors:
        # Patch local path to absolute-ish assets path
        vrm_filename = os.path.basename(actor['vrm'])
        actor_id = actor['id']
        actor['vrm'] = f"assets/vrms/{actor_id}/{vrm_filename}"
        register_actor(actor['id'], actor['vrm'], actor)
    
    # SCAN FOR NEW VRMS NOT IN MANIFEST
    vrm_root = "assets/vrms"
    if os.path.exists(vrm_root):
        for dirname in os.listdir(vrm_root):
            dir_path = os.path.join(vrm_root, dirname)
            if os.path.isdir(dir_path):
                # Check if this actor is already in the manifest list
                if any(a['id'] == dirname for a in actors):
                    continue
                
                # Look for .vrm file
                vrm_file = None
                for f in os.listdir(dir_path):
                    if f.endswith(".vrm"):
                        vrm_file = f
                        break
                
                if vrm_file:
                    print(f"Found new actor: {dirname}")
                    # Create default manifest data
                    new_actor_data = {
                        "id": dirname,
                        "vrm": f"assets/vrms/{dirname}/{vrm_file}",
                        "name": dirname.replace("_", " "),
                        "description": "Auto-detected VRM",
                        "system": "You are a helpful assistant.",
                        "voice": "en_US-hfc_female-medium"
                    }
                    register_actor(dirname, new_actor_data['vrm'], new_actor_data)
                    actors.append(new_actor_data)

    print(f"Ingested {len(actors)} actors.")

def ingest_ui():
    if not os.path.exists(CONTROLS_PATH):
        print(f"Skipping UI: {CONTROLS_PATH} not found.")
        return
    with open(CONTROLS_PATH, 'r') as f:
        data = json.load(f)
    
    count = 0
    for tab in data.get('tabs', []):
        tab_id = tab['id']
        for i, slider in enumerate(tab.get('sliders', [])):
            register_ui_control(
                control_id=slider['id'],
                tab_id=tab_id,
                label=slider['label'],
                min_val=slider['min'],
                max_val=slider['max'],
                step=slider.get('step', 0.01),
                default=slider['default'],
                sort_order=i
            )
            count += 1
    print(f"Ingested {count} UI controls.")

def ingest_workflows():
    # vrm_chat (2).json - The Main Performance Pipeline
    register_workflow(
        workflow_id="vrm_chat",
        path="assets/workflows/vrm_chat (2).json",
        node_mappings={
            "chat_input": "21",
            "system_prompt": "22",
            "tts_loader": "19",
            "audio_save": "23",
            "text_output": "16",
            "seed_source": "21",
            "ollama_node": "2",
            "connectivity_node": "1"
        }
    )
    # internal_chat.json - The Brain Tool Pipeline
    register_workflow(
        workflow_id="internal_chat",
        path="assets/workflows/internal_chat.json",
        node_mappings={
            "chat_input": "21",
            "system_prompt": "22",
            "text_output": "16",
            "ollama_node": "2",
            "connectivity_node": "1"
        }
    )
    # brain (11).json - The Complex Cognitive Engine (Legacy/Future)
    register_workflow(
        workflow_id="vrm_brain",
        path="assets/workflows/brain (11).json",
        node_mappings={} 
    )
    print("Ingested workflow mappings.")

def main():
    init_db()
    ingest_actors()
    ingest_ui()
    ingest_workflows()
    print("\n✅ COMPREHENSIVE INGESTION COMPLETE. SQL is now the Authority. 🏛️🛡️")

if __name__ == "__main__":
    main()
