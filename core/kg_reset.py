import os
import sys

# Path setup
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(os.path.join(PROJECT_ROOT, "core"))

import db_manager

def reset():
    actor_id = "Laura_Stevens" 
    print(f"--- Initiating Full Memory Wipe for {actor_id} ---")
    
    # This calls reset_recent_history which now includes reset_knowledge_graph
    db_manager.reset_recent_history(actor_id)
    
    print("--- Wipe Complete. Laura has a clean slate. ---")

if __name__ == "__main__":
    reset()
