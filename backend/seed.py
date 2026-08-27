"""
Seed the local SQLite database with the starter recipe catalogue.

Run this once after installing dependencies and before starting the server:

    python seed.py

It creates the database schema (if needed), clears any existing recipes, then
inserts the recipes from `seed_recipes.json`, generating a sentence-transformer
embedding for each one so semantic search works immediately.
"""

import json
from pathlib import Path

from sentence_transformers import SentenceTransformer

import database as db  # provides build_recipe_text + all persistence helpers

SEED_FILE = Path(__file__).parent / "seed_recipes.json"


def seed() -> None:
    db.init_db()

    print("Loading sentence-transformers/all-MiniLM-L6-v2 model...")
    model = SentenceTransformer("all-MiniLM-L6-v2")

    with open(SEED_FILE, "r", encoding="utf-8") as f:
        recipes = json.load(f)

    # Start from a clean catalogue so re-running does not create duplicates. The full-text
    # index is cleared alongside the rows: it is a separate table, so dropping recipes without
    # it would leave orphan entries that keep matching queries after their recipe is gone.
    conn = db.get_conn()
    conn.execute("DELETE FROM recipes")
    conn.execute("DELETE FROM recipes_fts")
    conn.commit()
    db.bump_index_version()

    print(f"Seeding {len(recipes)} recipes...")
    for idx, recipe in enumerate(recipes, start=1):
        text = db.build_recipe_text(recipe)
        embedding = model.encode(text).tolist()
        db.create_recipe(recipe, embedding)
        print(f"  [{idx}/{len(recipes)}] {recipe['title']} - embedded & inserted")

    print("Done. The recipe catalogue is ready.")


if __name__ == "__main__":
    seed()
