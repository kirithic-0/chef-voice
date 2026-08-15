"""
SQLite data layer for ChefVoice.

This module replaces the previous Supabase (PostgreSQL + pgvector) backend with a
self-contained local database. Everything the app needs lives in a single SQLite
file, and semantic recipe search is performed in-process with NumPy cosine
similarity over sentence-transformer embeddings.

Design notes
------------
* JSON columns: SQLite has no array/JSONB type, so list/dict fields
  (`ingredients`, `steps`, `dietary`, `embedding`, ...) are stored as
  JSON text and parsed back into Python objects on read. This keeps the JSON shape
  returned to the frontend identical to the old Supabase responses.
* Vector search: the recipe catalogue is small, so a brute-force cosine similarity
  over all stored embeddings is instant and easy to reason about. It also removes
  the pgvector dependency without changing the RAG story.
* Access model: row-level security is gone; per-user isolation is enforced in the
  API layer (main.py) by always scoping queries to the authenticated user id.
"""

import json
import os
import sqlite3
import threading
import uuid
from pathlib import Path
from typing import Any, Optional

import numpy as np

# Database file location (override with CHEFVOICE_DB for tests / custom paths).
DB_PATH = os.getenv("CHEFVOICE_DB", str(Path(__file__).parent / "chefvoice.db"))

# A single shared connection guarded by a lock. SQLite handles our low write
# concurrency comfortably, and this keeps the data layer simple and transparent.
_conn: Optional[sqlite3.Connection] = None
_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profiles (
    id                  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    is_admin            INTEGER NOT NULL DEFAULT 0,    -- 0 / 1 boolean
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recipes (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    cuisine        TEXT NOT NULL,
    time           INTEGER NOT NULL,               -- minutes
    difficulty     TEXT NOT NULL,
    servings       INTEGER NOT NULL,
    dietary        TEXT NOT NULL DEFAULT '[]',      -- JSON array
    image_url      TEXT,
    ingredients    TEXT NOT NULL,                   -- JSON array of {name, amount, unit}
    steps          TEXT NOT NULL,                   -- JSON array of {step, text, timer_duration, safety_alert}
    embedding      TEXT,                            -- JSON array of 384 floats
    average_rating REAL NOT NULL DEFAULT 0,
    rating_count   INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS favorites (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipe_id  TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, recipe_id)
);

CREATE TABLE IF NOT EXISTS cooking_history (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipe_id        TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    completed_at     TEXT NOT NULL DEFAULT (datetime('now')),
    duration_minutes INTEGER,
    rating           INTEGER
);

CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT,
    messages   TEXT NOT NULL DEFAULT '[]',   -- JSON array of {role, text}
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shopping_list_items (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    quantity   TEXT NOT NULL DEFAULT '',
    unit       TEXT NOT NULL DEFAULT '',
    checked    INTEGER NOT NULL DEFAULT 0,   -- 0 / 1 boolean
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_memories (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipe_id  TEXT REFERENCES recipes(id) ON DELETE SET NULL,
    note       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def get_conn() -> sqlite3.Connection:
    """Return the shared SQLite connection, creating and initializing it once."""
    global _conn
    if _conn is None:
        with _lock:
            if _conn is None:
                conn = sqlite3.connect(DB_PATH, check_same_thread=False)
                conn.row_factory = sqlite3.Row
                conn.execute("PRAGMA foreign_keys = ON;")
                conn.executescript(SCHEMA)
                conn.commit()
                _conn = conn
    return _conn


def init_db() -> None:
    """Ensure the database file and schema exist. Safe to call repeatedly."""
    get_conn()


def new_id() -> str:
    """Generate a UUID string id (mirrors the old Postgres uuid primary keys)."""
    return str(uuid.uuid4())


def _execute(query: str, params: tuple = ()) -> sqlite3.Cursor:
    """Run a write statement inside the shared lock and commit."""
    conn = get_conn()
    with _lock:
        cur = conn.execute(query, params)
        conn.commit()
        return cur


def _query_all(query: str, params: tuple = ()) -> list[sqlite3.Row]:
    conn = get_conn()
    with _lock:
        return conn.execute(query, params).fetchall()


def _query_one(query: str, params: tuple = ()) -> Optional[sqlite3.Row]:
    conn = get_conn()
    with _lock:
        return conn.execute(query, params).fetchone()


# --------------------------------------------------------------------------- #
# Row -> dict serialization (parses JSON text columns back into objects)
# --------------------------------------------------------------------------- #

def build_recipe_text(recipe: dict) -> str:
    """Compose the descriptive text that gets embedded for semantic search.

    Shared by the API (when an admin creates a recipe) and the seed script so
    stored recipes and search queries are embedded consistently.
    """
    parts = []
    for ing in recipe.get("ingredients", []):
        name = ing.get("name", "")
        amount = ing.get("amount", "")
        unit = ing.get("unit", "")
        parts.append(f"{amount} {unit} {name}".strip())
    ingredients_str = ", ".join(parts)
    return (
        f"Title: {recipe.get('title')}. Cuisine: {recipe.get('cuisine')}. "
        f"Difficulty: {recipe.get('difficulty')}. Ingredients: {ingredients_str}."
    )


def _recipe_to_dict(row: sqlite3.Row, include_embedding: bool = False) -> dict:
    data = {
        "id": row["id"],
        "title": row["title"],
        "cuisine": row["cuisine"],
        "time": row["time"],
        "difficulty": row["difficulty"],
        "servings": row["servings"],
        "dietary": json.loads(row["dietary"] or "[]"),
        "image_url": row["image_url"],
        "ingredients": json.loads(row["ingredients"] or "[]"),
        "steps": json.loads(row["steps"] or "[]"),
        "average_rating": row["average_rating"],
        "rating_count": row["rating_count"],
        "created_at": row["created_at"],
    }
    if include_embedding and row["embedding"]:
        data["embedding"] = json.loads(row["embedding"])
    return data


def _profile_to_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "is_admin": bool(row["is_admin"]),
        "created_at": row["created_at"],
    }


# --------------------------------------------------------------------------- #
# Users
# --------------------------------------------------------------------------- #

def create_user(username: str, password_hash: str) -> dict:
    """Insert a user and their default profile. Returns {id, username}."""
    user_id = new_id()
    _execute(
        "INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)",
        (user_id, username, password_hash),
    )
    _execute("INSERT INTO profiles (id) VALUES (?)", (user_id,))
    return {"id": user_id, "username": username}


def get_user_by_username(username: str) -> Optional[sqlite3.Row]:
    return _query_one("SELECT * FROM users WHERE username = ?", (username,))


def get_user_by_id(user_id: str) -> Optional[sqlite3.Row]:
    return _query_one("SELECT * FROM users WHERE id = ?", (user_id,))


# --------------------------------------------------------------------------- #
# Profiles
# --------------------------------------------------------------------------- #

def get_or_create_profile(user_id: str) -> dict:
    row = _query_one("SELECT * FROM profiles WHERE id = ?", (user_id,))
    if row is None:
        _execute("INSERT INTO profiles (id) VALUES (?)", (user_id,))
        row = _query_one("SELECT * FROM profiles WHERE id = ?", (user_id,))
    return _profile_to_dict(row)


def set_admin(user_id: str, is_admin: bool) -> dict:
    get_or_create_profile(user_id)
    _execute("UPDATE profiles SET is_admin = ? WHERE id = ?", (1 if is_admin else 0, user_id))
    return get_or_create_profile(user_id)


def is_admin(user_id: str) -> bool:
    row = _query_one("SELECT is_admin FROM profiles WHERE id = ?", (user_id,))
    return bool(row["is_admin"]) if row else False


# --------------------------------------------------------------------------- #
# Recipes
# --------------------------------------------------------------------------- #

def list_recipes() -> list[dict]:
    rows = _query_all("SELECT * FROM recipes ORDER BY title ASC")
    return [_recipe_to_dict(r) for r in rows]


def get_recipe(recipe_id: str) -> Optional[dict]:
    row = _query_one("SELECT * FROM recipes WHERE id = ?", (recipe_id,))
    return _recipe_to_dict(row) if row else None


def create_recipe(recipe: dict, embedding: list[float]) -> dict:
    recipe_id = new_id()
    _execute(
        """
        INSERT INTO recipes (id, title, cuisine, time, difficulty, servings,
                             dietary, image_url, ingredients, steps, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            recipe_id,
            recipe["title"],
            recipe["cuisine"],
            int(recipe["time"]),
            recipe["difficulty"],
            int(recipe["servings"]),
            json.dumps(recipe.get("dietary", [])),
            recipe.get("image_url"),
            json.dumps(recipe.get("ingredients", [])),
            json.dumps(recipe.get("steps", [])),
            json.dumps(embedding),
        ),
    )
    return get_recipe(recipe_id)


def delete_recipe(recipe_id: str) -> None:
    _execute("DELETE FROM recipes WHERE id = ?", (recipe_id,))


def search_recipes(query_embedding: list[float], match_count: int = 6) -> list[dict]:
    """Rank recipes by cosine similarity to the query embedding (in-process)."""
    rows = _query_all("SELECT * FROM recipes WHERE embedding IS NOT NULL")
    if not rows:
        return []

    q = np.asarray(query_embedding, dtype=np.float32)
    q_norm = q / (np.linalg.norm(q) + 1e-9)

    scored: list[dict] = []
    for row in rows:
        emb = np.asarray(json.loads(row["embedding"]), dtype=np.float32)
        emb_norm = emb / (np.linalg.norm(emb) + 1e-9)
        similarity = float(np.dot(q_norm, emb_norm))
        data = _recipe_to_dict(row)
        data["similarity"] = similarity
        scored.append(data)

    scored.sort(key=lambda r: r["similarity"], reverse=True)
    return scored[:match_count]


def recompute_recipe_rating(recipe_id: str) -> None:
    """Recalculate a recipe's average rating and count from cooking_history.

    Mirrors the old Postgres trigger `update_recipe_rating_stats`.
    """
    row = _query_one(
        """
        SELECT AVG(rating) AS avg_rating, COUNT(rating) AS cnt
        FROM cooking_history
        WHERE recipe_id = ? AND rating IS NOT NULL
        """,
        (recipe_id,),
    )
    avg_rating = float(row["avg_rating"]) if row and row["avg_rating"] is not None else 0.0
    count = int(row["cnt"]) if row and row["cnt"] is not None else 0
    _execute(
        "UPDATE recipes SET average_rating = ?, rating_count = ? WHERE id = ?",
        (avg_rating, count, recipe_id),
    )


# --------------------------------------------------------------------------- #
# Favorites
# --------------------------------------------------------------------------- #

def list_favorites(user_id: str) -> list[dict]:
    rows = _query_all("SELECT * FROM favorites WHERE user_id = ?", (user_id,))
    return [dict(r) for r in rows]


def add_favorite(user_id: str, recipe_id: str) -> dict:
    existing = _query_one(
        "SELECT * FROM favorites WHERE user_id = ? AND recipe_id = ?",
        (user_id, recipe_id),
    )
    if existing:
        return dict(existing)
    fav_id = new_id()
    _execute(
        "INSERT INTO favorites (id, user_id, recipe_id) VALUES (?, ?, ?)",
        (fav_id, user_id, recipe_id),
    )
    return dict(_query_one("SELECT * FROM favorites WHERE id = ?", (fav_id,)))


def remove_favorite(user_id: str, recipe_id: str) -> None:
    _execute(
        "DELETE FROM favorites WHERE user_id = ? AND recipe_id = ?",
        (user_id, recipe_id),
    )


# --------------------------------------------------------------------------- #
# Cooking history
# --------------------------------------------------------------------------- #

def list_cooking_history(user_id: str) -> list[dict]:
    """Return the user's history, newest first, with the joined recipe embedded."""
    rows = _query_all(
        "SELECT * FROM cooking_history WHERE user_id = ? ORDER BY completed_at DESC",
        (user_id,),
    )
    history = []
    for row in rows:
        entry = dict(row)
        recipe = get_recipe(row["recipe_id"])
        entry["recipe"] = recipe
        history.append(entry)
    return history


def add_cooking_history(
    user_id: str,
    recipe_id: str,
    duration_minutes: Optional[int] = None,
    rating: Optional[int] = None,
) -> dict:
    entry_id = new_id()
    _execute(
        """
        INSERT INTO cooking_history (id, user_id, recipe_id, duration_minutes, rating)
        VALUES (?, ?, ?, ?, ?)
        """,
        (entry_id, user_id, recipe_id, duration_minutes, rating),
    )
    if rating is not None:
        recompute_recipe_rating(recipe_id)
    return dict(_query_one("SELECT * FROM cooking_history WHERE id = ?", (entry_id,)))


# --------------------------------------------------------------------------- #
# Conversations (voice-session transcripts)
# --------------------------------------------------------------------------- #

def list_conversations(user_id: str, limit: int = 10) -> list[dict]:
    rows = _query_all(
        "SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
        (user_id, limit),
    )
    result = []
    for row in rows:
        entry = dict(row)
        entry["messages"] = json.loads(row["messages"] or "[]")
        result.append(entry)
    return result


def add_conversation(user_id: str, title: str, messages: list[dict[str, Any]]) -> dict:
    conv_id = new_id()
    _execute(
        "INSERT INTO conversations (id, user_id, title, messages) VALUES (?, ?, ?, ?)",
        (conv_id, user_id, title, json.dumps(messages)),
    )
    row = _query_one("SELECT * FROM conversations WHERE id = ?", (conv_id,))
    entry = dict(row)
    entry["messages"] = json.loads(row["messages"] or "[]")
    return entry


# --------------------------------------------------------------------------- #
# Shopping list (used by the agent's add_to_shopping_list tool + REST API)
# --------------------------------------------------------------------------- #

def _shopping_item_to_dict(row: sqlite3.Row) -> dict:
    item = dict(row)
    item["checked"] = bool(row["checked"])
    return item


def list_shopping_list(user_id: str) -> list[dict]:
    rows = _query_all(
        "SELECT * FROM shopping_list_items WHERE user_id = ? ORDER BY created_at DESC",
        (user_id,),
    )
    return [_shopping_item_to_dict(r) for r in rows]


def add_shopping_list_item(
    user_id: str, name: str, quantity: str = "", unit: str = "", checked: bool = False
) -> dict:
    item_id = new_id()
    _execute(
        """
        INSERT INTO shopping_list_items (id, user_id, name, quantity, unit, checked)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (item_id, user_id, name, quantity, unit, 1 if checked else 0),
    )
    return _shopping_item_to_dict(
        _query_one("SELECT * FROM shopping_list_items WHERE id = ?", (item_id,))
    )


def update_shopping_list_item(item_id: str, user_id: str, fields: dict) -> Optional[dict]:
    allowed: dict[str, Any] = {}
    for key in ("name", "quantity", "unit", "checked"):
        if key in fields:
            allowed[key] = (1 if fields[key] else 0) if key == "checked" else fields[key]
    if not allowed:
        return None
    set_clause = ", ".join(f"{k} = ?" for k in allowed)
    params = list(allowed.values()) + [item_id, user_id]
    _execute(
        f"UPDATE shopping_list_items SET {set_clause} WHERE id = ? AND user_id = ?",
        tuple(params),
    )
    row = _query_one("SELECT * FROM shopping_list_items WHERE id = ?", (item_id,))
    return _shopping_item_to_dict(row) if row else None


def delete_shopping_list_item(item_id: str, user_id: str) -> None:
    _execute(
        "DELETE FROM shopping_list_items WHERE id = ? AND user_id = ?",
        (item_id, user_id),
    )


# --------------------------------------------------------------------------- #
# User memories (used by the agent's save_note / recall_memories tools + REST API)
# --------------------------------------------------------------------------- #

def list_memories(user_id: str, recipe_id: Optional[str] = None, limit: int = 20) -> list[dict]:
    if recipe_id:
        rows = _query_all(
            """
            SELECT * FROM user_memories
            WHERE user_id = ? AND recipe_id = ?
            ORDER BY created_at DESC LIMIT ?
            """,
            (user_id, recipe_id, limit),
        )
    else:
        rows = _query_all(
            "SELECT * FROM user_memories WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
        )
    return [dict(r) for r in rows]


def add_memory(user_id: str, note: str, recipe_id: Optional[str] = None) -> dict:
    mem_id = new_id()
    _execute(
        "INSERT INTO user_memories (id, user_id, recipe_id, note) VALUES (?, ?, ?, ?)",
        (mem_id, user_id, recipe_id, note),
    )
    return dict(_query_one("SELECT * FROM user_memories WHERE id = ?", (mem_id,)))
