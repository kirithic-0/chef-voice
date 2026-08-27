"""
Rebuild every retrieval index from SQLite.

SQLite is the system of record; the embedding column, the `search_text` column and the FTS5
table are all derived from it and can be regenerated at any time. That is what makes adding a
recipe cheap: the normal write path indexes one recipe, and full reingest exists only as a
maintenance operation you run deliberately.

    python reindex.py            # re-embed and re-index everything
    python reindex.py --check    # report drift without writing anything

Run it after any of these, which invalidate stored vectors:
  * changing `database.build_recipe_text` (the document template)
  * changing the embedding model or its dimensionality
  * restoring a database written by an older schema
  * suspected drift or corruption
"""

import argparse
import json
import sys

from sentence_transformers import SentenceTransformer

import database as db

MODEL_NAME = "all-MiniLM-L6-v2"

# The 15 seed recipes were catalogued under a `cuisine` column that is really a browse bucket
# ("Quick Meals", "Healthy", "Desserts" are not cuisines). The bucket moves to `category` and
# `cuisine` gets a real value. Anything not listed keeps its existing value as both.
_REAL_CUISINE = {
    "Chana Masala": "Indian",
    "Classic Butter Chicken": "Indian",
    "Paneer Tikka Masala": "Indian",
    "Creamy Tomato Basil Pasta": "Italian",
    "Margherita Flatbread Pizza": "Italian",
    "Spaghetti Aglio e Olio": "Italian",
    "Classic Grilled Cheese": "American",
    "Quick Fluffy Pancakes": "American",
    "Fudgy Chocolate Chip Cookies": "American",
    "Fudgy Chocolate Brownies": "American",
    "Grilled Chicken Power Bowl": "American",
    "Veggie Fried Rice": "Chinese",
    "Greek Salad": "Greek",
    "Healthy Quinoa Salad": "Mediterranean",
    "Mango Sticky Rice": "Thai",
}


def _rows() -> list[dict]:
    conn = db.get_conn()
    with db._lock:
        rows = conn.execute("SELECT * FROM recipes ORDER BY title").fetchall()
    return [dict(row) for row in rows]


def check() -> int:
    """Report what a rebuild would change. Never writes. Returns a process exit code."""
    db.init_db()
    rows = _rows()
    conn = db.get_conn()
    with db._lock:
        fts_count = conn.execute("SELECT COUNT(*) AS n FROM recipes_fts").fetchone()["n"]

    missing_vector = [r["title"] for r in rows if r["embedding"] is None]
    legacy_json = [r["title"] for r in rows if isinstance(r["embedding"], str)]
    missing_text = [r["title"] for r in rows if not (r["search_text"] or "").strip()]

    # Rebuild each document from its stored row and compare: a mismatch means the template
    # changed since the vector was written, so the vector no longer describes the recipe.
    stale_text = []
    for row in rows:
        recipe = {
            "title": row["title"], "cuisine": row["cuisine"],
            "category": row["category"] or row["cuisine"], "time": row["time"],
            "difficulty": row["difficulty"], "servings": row["servings"],
            "dietary": json.loads(row["dietary"] or "[]"),
            "ingredients": json.loads(row["ingredients"] or "[]"),
            "steps": json.loads(row["steps"] or "[]"),
        }
        if db.build_recipe_text(recipe) != (row["search_text"] or ""):
            stale_text.append(row["title"])

    print(f"recipes:        {len(rows)}")
    print(f"fts rows:       {fts_count}" + ("" if fts_count == len(rows) else "   <- MISMATCH"))
    print(f"missing vector: {len(missing_vector)}" + (f"  {missing_vector}" if missing_vector else ""))
    print(f"legacy JSON:    {len(legacy_json)}" + (f"  {legacy_json}" if legacy_json else ""))
    print(f"missing text:   {len(missing_text)}" + (f"  {missing_text}" if missing_text else ""))
    print(f"stale document: {len(stale_text)}" + (f"  {stale_text[:5]}" if stale_text else ""))

    drifted = bool(missing_vector or legacy_json or missing_text or stale_text) or fts_count != len(rows)
    print("\n" + ("DRIFT — run `python reindex.py`" if drifted else "clean — indexes match the catalog"))
    return 1 if drifted else 0


def reindex(apply_cuisine_map: bool = True) -> None:
    db.init_db()
    rows = _rows()
    if not rows:
        print("no recipes to index")
        return

    print(f"loading {MODEL_NAME} ...")
    model = SentenceTransformer(MODEL_NAME)

    conn = db.get_conn()
    with db._lock:
        conn.execute("DELETE FROM recipes_fts")
        conn.commit()

    print(f"re-encoding {len(rows)} recipes ...")
    for index, row in enumerate(rows, start=1):
        dietary = json.loads(row["dietary"] or "[]")
        # The browse bucket is whatever `cuisine` has been holding all along.
        category = row["category"] or row["cuisine"]
        cuisine = row["cuisine"]
        if apply_cuisine_map and row["title"] in _REAL_CUISINE:
            cuisine = _REAL_CUISINE[row["title"]]

        recipe = {
            "title": row["title"],
            "cuisine": cuisine,
            "category": category,
            "time": row["time"],
            "difficulty": row["difficulty"],
            "servings": row["servings"],
            "dietary": dietary,
            "ingredients": json.loads(row["ingredients"] or "[]"),
            "steps": json.loads(row["steps"] or "[]"),
        }
        text = db.build_recipe_text(recipe)
        vector = model.encode(text)

        with db._lock:
            conn.execute(
                """
                UPDATE recipes
                   SET cuisine = ?, category = ?, is_veg = ?, search_text = ?, embedding = ?
                 WHERE id = ?
                """,
                (
                    cuisine,
                    category,
                    1 if db.derive_is_veg(dietary) else 0,
                    text,
                    db.pack_vector(vector.tolist()),
                    row["id"],
                ),
            )
            conn.execute(
                "INSERT INTO recipes_fts (recipe_id, text) VALUES (?, ?)", (row["id"], text)
            )
            conn.commit()

        print(f"  [{index}/{len(rows)}] {row['title']}  ({category} / {cuisine})")

    db.bump_index_version()
    print("\ndone. verifying ...\n")
    check()


def main() -> None:
    parser = argparse.ArgumentParser(description="Rebuild ChefVoice retrieval indexes from SQLite.")
    parser.add_argument("--check", action="store_true", help="report drift without writing")
    parser.add_argument(
        "--no-cuisine-map", action="store_true",
        help="skip the seed-catalog category/cuisine split",
    )
    args = parser.parse_args()

    if args.check:
        sys.exit(check())
    reindex(apply_cuisine_map=not args.no_cuisine_map)


if __name__ == "__main__":
    main()
