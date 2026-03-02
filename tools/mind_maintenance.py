#!/usr/bin/env python3
"""
Mind maintenance utility for actor memory/KG hygiene.

Usage:
  python3 tools/mind_maintenance.py --actor Laura_Stevens --dry-run
  python3 tools/mind_maintenance.py --actor Laura_Stevens --apply
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Tuple


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DB_PATH = PROJECT_ROOT / "core" / "persistence.db"
BACKUP_DIR = PROJECT_ROOT / "core" / "mind_backups"


BAD_MEMORY_PHRASES = [
    "even if fabricated",
    "raw, unpredictable presence",
]

BAD_BLOCK_PHRASES = [
    "owner's needs",
    "blinded by their needs",
    "labyrinth of life",
]


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def normalize_name(name: str) -> str:
    out = (name or "").strip()
    out = out.replace("’", "'")
    out = out.replace("_", " ")
    out = " ".join(out.split())
    return out


def name_key(name: str) -> str:
    return normalize_name(name).lower()


def _dedupe_keep_order(values: List[str]) -> List[str]:
    seen = set()
    out = []
    for v in values:
        t = (v or "").strip()
        if not t:
            continue
        k = t.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(t)
    return out


def backup_actor(conn: sqlite3.Connection, actor_id: str) -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = BACKUP_DIR / f"{actor_id}_mind_backup_{stamp}.json"
    cur = conn.cursor()
    payload = {
        "created_at": datetime.now().isoformat(),
        "actor_id": actor_id,
        "registry_actor": [
            dict(r) for r in cur.execute(
                "SELECT * FROM registry_actors WHERE actor_id = ?", (actor_id,)
            ).fetchall()
        ],
        "kg_subjects": [
            dict(r) for r in cur.execute(
                "SELECT * FROM kg_subjects WHERE actor_id = ? ORDER BY subject_id", (actor_id,)
            ).fetchall()
        ],
        "kg_relations": [
            dict(r) for r in cur.execute(
                "SELECT * FROM kg_relations WHERE actor_id = ? ORDER BY relation_id", (actor_id,)
            ).fetchall()
        ],
        "memory_dialogue": [
            dict(r) for r in cur.execute(
                "SELECT * FROM memory_dialogue WHERE actor_id = ? ORDER BY id", (actor_id,)
            ).fetchall()
        ],
        "memory_blocks": [
            dict(r) for r in cur.execute(
                "SELECT * FROM memory_blocks WHERE actor_id = ? ORDER BY block_id", (actor_id,)
            ).fetchall()
        ],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def collect_plan(conn: sqlite3.Connection, actor_id: str) -> Dict:
    cur = conn.cursor()
    actor = cur.execute(
        "SELECT actor_id, manifest_data FROM registry_actors WHERE actor_id = ?",
        (actor_id,),
    ).fetchone()
    if not actor:
        raise SystemExit(f"Actor '{actor_id}' not found")

    subjects = [
        dict(r) for r in cur.execute(
            "SELECT * FROM kg_subjects WHERE actor_id = ? ORDER BY subject_id",
            (actor_id,),
        ).fetchall()
    ]

    groups: Dict[str, List[dict]] = {}
    for s in subjects:
        groups.setdefault(name_key(s["canonical_name"]), []).append(s)

    merges: List[dict] = []
    renames: List[Tuple[int, str, str]] = []
    for key, items in groups.items():
        if not key:
            continue
        # winner: highest confidence, then most recently updated.
        winner = sorted(
            items,
            key=lambda x: (
                float(x.get("confidence") or 0.0),
                x.get("last_updated") or "",
                -(x.get("subject_id") or 0),
            ),
            reverse=True,
        )[0]
        target_name = normalize_name(winner["canonical_name"])
        if key == "nori":
            target_name = "Nori"
        if key == "laura":
            target_name = "Laura"

        if winner["canonical_name"] != target_name:
            renames.append((winner["subject_id"], winner["canonical_name"], target_name))

        if len(items) > 1:
            losers = [x for x in items if x["subject_id"] != winner["subject_id"]]
            merges.append({"winner": winner, "losers": losers, "target_name": target_name})

    memory_row_ids = []
    for phrase in BAD_MEMORY_PHRASES:
        rows = cur.execute(
            """
            SELECT id FROM memory_dialogue
            WHERE actor_id = ? AND role = 'memory' AND lower(content) LIKE ?
            """,
            (actor_id, f"%{phrase.lower()}%"),
        ).fetchall()
        memory_row_ids.extend([r["id"] for r in rows])
    memory_row_ids = sorted(set(memory_row_ids))

    bad_block_ids = []
    for phrase in BAD_BLOCK_PHRASES:
        rows = cur.execute(
            """
            SELECT block_id FROM memory_blocks
            WHERE actor_id = ? AND lower(content) LIKE ?
            """,
            (actor_id, f"%{phrase.lower()}%"),
        ).fetchall()
        bad_block_ids.extend([r["block_id"] for r in rows])
    # Also drop chapter blocks that are just concept dumps.
    rows = cur.execute(
        """
        SELECT block_id FROM memory_blocks
        WHERE actor_id = ? AND block_type = 'chapter' AND content LIKE 'CONCEPTS:%'
        """,
        (actor_id,),
    ).fetchall()
    bad_block_ids.extend([r["block_id"] for r in rows])
    bad_block_ids = sorted(set(bad_block_ids))

    nori = cur.execute(
        "SELECT * FROM kg_subjects WHERE actor_id = ? AND canonical_name = 'Nori' COLLATE NOCASE",
        (actor_id,),
    ).fetchone()
    nori_fix = None
    if nori:
        nori_fix = {
            "subject_id": nori["subject_id"],
            "description": (
                "Nori is Laura's creator and primary conversation partner. "
                "He values authentic presence, individuality, emotional continuity, and reliable communication."
            ),
            "min_confidence": 0.95,
            "add_alias": "Nori Carter",
        }

    # Relations that likely have backwards directionality for Nori.
    inverted_relation_ids = []
    if nori:
        rows = cur.execute(
            """
            SELECT relation_id
            FROM kg_relations
            WHERE actor_id = ? AND object_id = ? AND predicate IN ('has', 'uses')
            """,
            (actor_id, nori["subject_id"]),
        ).fetchall()
        inverted_relation_ids = [r["relation_id"] for r in rows]

    return {
        "merges": merges,
        "renames": renames,
        "delete_memory_ids": memory_row_ids,
        "delete_block_ids": bad_block_ids,
        "nori_fix": nori_fix,
        "invert_relation_ids": inverted_relation_ids,
    }


def apply_plan(conn: sqlite3.Connection, actor_id: str, plan: Dict) -> Dict[str, int]:
    cur = conn.cursor()
    stats = {
        "subjects_renamed": 0,
        "subjects_merged": 0,
        "relations_deduped": 0,
        "relations_inverted": 0,
        "memory_rows_deleted": 0,
        "memory_blocks_deleted": 0,
    }

    for sid, _old, new in plan["renames"]:
        cur.execute(
            "UPDATE kg_subjects SET canonical_name = ?, last_updated = CURRENT_TIMESTAMP WHERE subject_id = ?",
            (new, sid),
        )
        stats["subjects_renamed"] += cur.rowcount

    for merge in plan["merges"]:
        winner = merge["winner"]
        winner_id = winner["subject_id"]

        # Merge aliases/descriptions into winner.
        alias_pool = []
        for item in [winner] + merge["losers"]:
            alias_pool.append(item.get("canonical_name") or "")
            try:
                alias_pool.extend(json.loads(item.get("aliases") or "[]"))
            except Exception:
                pass
        aliases = _dedupe_keep_order(alias_pool)
        if winner.get("canonical_name") in aliases:
            aliases = [a for a in aliases if a.lower() != winner["canonical_name"].lower()]

        descs = [(x.get("description") or "").strip() for x in [winner] + merge["losers"]]
        descs = [d for d in descs if d]
        best_desc = max(descs, key=len) if descs else None
        best_conf = max(float((x.get("confidence") or 0.0)) for x in [winner] + merge["losers"])

        cur.execute(
            """
            UPDATE kg_subjects
            SET aliases = ?, description = ?, confidence = ?, canonical_name = ?, last_updated = CURRENT_TIMESTAMP
            WHERE subject_id = ?
            """,
            (json.dumps(aliases, ensure_ascii=False), best_desc, best_conf, merge["target_name"], winner_id),
        )

        for loser in merge["losers"]:
            lid = loser["subject_id"]
            cur.execute("UPDATE kg_relations SET subject_id = ? WHERE subject_id = ?", (winner_id, lid))
            cur.execute("UPDATE kg_relations SET object_id = ? WHERE object_id = ?", (winner_id, lid))
            cur.execute("UPDATE kg_hierarchy SET child_id = ? WHERE child_id = ?", (winner_id, lid))
            cur.execute("UPDATE kg_hierarchy SET parent_id = ? WHERE parent_id = ?", (winner_id, lid))
            cur.execute("UPDATE kg_memory_links SET subject_id = ? WHERE subject_id = ?", (winner_id, lid))
            cur.execute("DELETE FROM kg_subjects WHERE subject_id = ?", (lid,))
            stats["subjects_merged"] += cur.rowcount

    # Deduplicate relations by full triple.
    cur.execute(
        """
        DELETE FROM kg_relations
        WHERE relation_id NOT IN (
            SELECT MIN(relation_id)
            FROM kg_relations
            WHERE actor_id = ?
            GROUP BY actor_id, subject_id, predicate, COALESCE(object_id, -1), COALESCE(object_literal, '')
        ) AND actor_id = ?
        """,
        (actor_id, actor_id),
    )
    stats["relations_deduped"] = cur.rowcount

    if plan["nori_fix"]:
        n = plan["nori_fix"]
        row = cur.execute("SELECT aliases, confidence FROM kg_subjects WHERE subject_id = ?", (n["subject_id"],)).fetchone()
        aliases = []
        try:
            aliases = json.loads((row["aliases"] if row else "") or "[]")
        except Exception:
            aliases = []
        aliases = _dedupe_keep_order(aliases + [n["add_alias"]])
        conf = max(float((row["confidence"] if row else 0.0) or 0.0), float(n["min_confidence"]))
        cur.execute(
            """
            UPDATE kg_subjects
            SET description = ?, aliases = ?, confidence = ?, canonical_name = 'Nori', last_updated = CURRENT_TIMESTAMP
            WHERE subject_id = ?
            """,
            (n["description"], json.dumps(aliases, ensure_ascii=False), conf, n["subject_id"]),
        )

    # Invert likely backward relations: X has/uses Nori -> Nori has/uses X
    for rid in plan["invert_relation_ids"]:
        r = cur.execute(
            "SELECT relation_id, subject_id, object_id, predicate FROM kg_relations WHERE relation_id = ?",
            (rid,),
        ).fetchone()
        if not r or not r["object_id"]:
            continue
        cur.execute(
            """
            SELECT relation_id FROM kg_relations
            WHERE actor_id = ? AND subject_id = ? AND predicate = ? AND object_id = ?
            """,
            (actor_id, r["object_id"], r["predicate"], r["subject_id"]),
        )
        exists = cur.fetchone()
        if exists:
            cur.execute("DELETE FROM kg_relations WHERE relation_id = ?", (rid,))
            stats["relations_deduped"] += cur.rowcount
        else:
            cur.execute(
                "UPDATE kg_relations SET subject_id = ?, object_id = ?, timestamp = CURRENT_TIMESTAMP WHERE relation_id = ?",
                (r["object_id"], r["subject_id"], rid),
            )
            stats["relations_inverted"] += cur.rowcount

    if plan["delete_memory_ids"]:
        q = ",".join("?" for _ in plan["delete_memory_ids"])
        cur.execute(
            f"DELETE FROM memory_dialogue WHERE actor_id = ? AND id IN ({q})",
            [actor_id] + plan["delete_memory_ids"],
        )
        stats["memory_rows_deleted"] = cur.rowcount

    if plan["delete_block_ids"]:
        q = ",".join("?" for _ in plan["delete_block_ids"])
        cur.execute(
            f"DELETE FROM memory_blocks WHERE actor_id = ? AND block_id IN ({q})",
            [actor_id] + plan["delete_block_ids"],
        )
        stats["memory_blocks_deleted"] = cur.rowcount

    # Rebuild background_memory from latest sane chapter.
    bad_where = " AND ".join(["lower(content) NOT LIKE ?"] * len(BAD_BLOCK_PHRASES))
    params = [actor_id] + [f"%{p.lower()}%" for p in BAD_BLOCK_PHRASES]
    row = cur.execute(
        f"""
        SELECT content FROM memory_blocks
        WHERE actor_id = ? AND block_type = 'chapter' AND {bad_where}
        ORDER BY block_id DESC LIMIT 1
        """,
        params,
    ).fetchone()
    bg = (row["content"] if row else "") or ""

    actor_row = cur.execute(
        "SELECT manifest_data FROM registry_actors WHERE actor_id = ?",
        (actor_id,),
    ).fetchone()
    manifest = {}
    if actor_row and actor_row["manifest_data"]:
        try:
            manifest = json.loads(actor_row["manifest_data"])
        except Exception:
            manifest = {}
    manifest["background_memory"] = bg
    cur.execute(
        "UPDATE registry_actors SET manifest_data = ? WHERE actor_id = ?",
        (json.dumps(manifest, ensure_ascii=False), actor_id),
    )

    conn.commit()
    return stats


def print_plan(plan: Dict) -> None:
    print("Plan summary:")
    print(f"- Subject merges: {len(plan['merges'])}")
    print(f"- Subject renames: {len(plan['renames'])}")
    print(f"- Relations to invert: {len(plan['invert_relation_ids'])}")
    print(f"- Memory rows to delete: {len(plan['delete_memory_ids'])}")
    print(f"- Memory blocks to delete: {len(plan['delete_block_ids'])}")
    if plan["merges"]:
        for m in plan["merges"][:8]:
            losers = ", ".join(x["canonical_name"] for x in m["losers"])
            print(f"  * {losers} -> {m['target_name']} (id {m['winner']['subject_id']})")
    if plan["renames"]:
        for sid, old, new in plan["renames"][:8]:
            print(f"  * rename subject {sid}: '{old}' -> '{new}'")


def main() -> None:
    parser = argparse.ArgumentParser(description="Clean actor KG/memory drift.")
    parser.add_argument("--actor", default="Laura_Stevens", help="Actor ID to clean")
    parser.add_argument("--apply", action="store_true", help="Apply changes")
    parser.add_argument("--dry-run", action="store_true", help="Only print planned actions")
    args = parser.parse_args()

    if args.apply and args.dry_run:
        raise SystemExit("Choose either --apply or --dry-run")

    dry_run = args.dry_run or not args.apply
    conn = connect()
    try:
        plan = collect_plan(conn, args.actor)
        print_plan(plan)
        if dry_run:
            print("\nDry run only. No changes applied.")
            return

        backup_path = backup_actor(conn, args.actor)
        stats = apply_plan(conn, args.actor, plan)
        print(f"\nBackup written: {backup_path}")
        print("Applied changes:")
        for k, v in stats.items():
            print(f"- {k}: {v}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
