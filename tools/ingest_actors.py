import json
import os
from db_manager import register_actor, init_db

MANIFEST_PATH = "characters/manifest.json"

def ingest():
    if not os.path.exists(MANIFEST_PATH):
        print(f"Error: {MANIFEST_PATH} not found.")
        return

    # Ensure DB is initialized
    init_db()

    with open(MANIFEST_PATH, 'r') as f:
        data = json.load(f)

    actors = data.get('characters', [])
    print(f"Found {len(actors)} actors in manifest.")

    for actor in actors:
        actor_id = actor.get('id')
        vrm_path = actor.get('vrm')
        
        if not actor_id or not vrm_path:
            print(f"Skipping invalid actor entry: {actor}")
            continue

        print(f"Registering Artifact: {actor_id} -> {vrm_path}")
        register_actor(actor_id, vrm_path, actor)

    print("\n✅ Ingestion complete. Actors are now registered in the Artifacts region. 🏛️🛡️")

if __name__ == "__main__":
    ingest()
