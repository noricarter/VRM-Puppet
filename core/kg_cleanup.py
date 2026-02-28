import sqlite3
import json
import os

# Path setup matching db_manager
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(PROJECT_ROOT, "core/persistence.db")

def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def cleanup():
    conn = get_connection()
    cursor = conn.cursor()
    
    print("--- Starting Knowledge Graph Cleanup ---")
    
    # 1. Remove empty predicates
    cursor.execute("DELETE FROM kg_relations WHERE predicate IS NULL OR predicate = ''")
    print(f"Removed {cursor.rowcount} relations with empty predicates.")
    
    # 2. Identify duplicate subjects (same actor_id and canonical_name)
    cursor.execute('''
        SELECT actor_id, canonical_name, COUNT(*) as cnt, MIN(subject_id) as canonical_id
        FROM kg_subjects
        GROUP BY actor_id, canonical_name
        HAVING cnt > 1
    ''')
    duplicates = [dict(r) for r in cursor.fetchall()]
    
    for dup in duplicates:
        actor_id = dup['actor_id']
        name = dup['canonical_name']
        canonical_id = dup['canonical_id']
        
        print(f"Merging duplicates for '{name}' [Actor: {actor_id}] into ID {canonical_id}...")
        
        # Get all other IDs for this subject
        cursor.execute('''
            SELECT subject_id FROM kg_subjects 
            WHERE actor_id = ? AND canonical_name = ? AND subject_id != ?
        ''', (actor_id, name, canonical_id))
        other_ids = [r['subject_id'] for r in cursor.fetchall()]
        
        for oid in other_ids:
            # Re-map relations where this was the subject
            cursor.execute("UPDATE kg_relations SET subject_id = ? WHERE subject_id = ?", (canonical_id, oid))
            # Re-map relations where this was the object
            cursor.execute("UPDATE kg_relations SET object_id = ? WHERE object_id = ?", (canonical_id, oid))
            # Re-map hierarchy
            cursor.execute("UPDATE kg_hierarchy SET child_id = ? WHERE child_id = ?", (canonical_id, oid))
            cursor.execute("UPDATE kg_hierarchy SET parent_id = ? WHERE parent_id = ?", (canonical_id, oid))
            
            # Delete the duplicate subject
            cursor.execute("DELETE FROM kg_subjects WHERE subject_id = ?", (oid,))
            print(f"  Merged and deleted duplicate ID {oid}")

    # 3. Final cleanup: Remove relations that might have become duplicates after merging
    # (Optional: logic to deduplicate kg_relations if (subject_id, predicate, object_id/literal) now conflict)
    cursor.execute('''
        DELETE FROM kg_relations 
        WHERE rowid NOT IN (
            SELECT MIN(rowid) 
            FROM kg_relations 
            GROUP BY actor_id, subject_id, predicate, object_id, object_literal
        )
    ''')
    print(f"Removed {cursor.rowcount} redundant relations created by the merge.")

    conn.commit()
    conn.close()
    print("--- Cleanup Complete ---")

if __name__ == "__main__":
    cleanup()
