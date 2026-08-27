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
    category       TEXT NOT NULL DEFAULT '',        -- browse bucket (Indian / Quick Meals / ...)
    time           INTEGER NOT NULL,               -- minutes
    difficulty     TEXT NOT NULL,
    servings       INTEGER NOT NULL,
    dietary        TEXT NOT NULL DEFAULT '[]',      -- JSON array
    is_veg         INTEGER NOT NULL DEFAULT 0,      -- 0 / 1, materialized from `dietary`
    image_url      TEXT,
    ingredients    TEXT NOT NULL,                   -- JSON array of {name, amount, unit}
    steps          TEXT NOT NULL,                   -- JSON array of {step, text, timer_duration, safety_alert}
    search_text    TEXT NOT NULL DEFAULT '',        -- the exact text that was embedded
    embedding      BLOB,                            -- 384 float32 (little-endian), see _pack_vector
    average_rating REAL NOT NULL DEFAULT 0,
    rating_count   INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Lexical half of hybrid retrieval. FTS5 ships inside SQLite, so BM25 costs no new dependency
-- and — critically — stays incrementally indexable: inserting one row updates the inverted
-- index in place, and bm25() recomputes IDF from the current table on every query. A library
-- like rank_bm25 builds its corpus object in process and would force a full rebuild per insert.
CREATE VIRTUAL TABLE IF NOT EXISTS recipes_fts USING fts5(
    recipe_id UNINDEXED,
    text,
    tokenize = 'porter unicode61'
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
                # Wait up to 5s for a held lock instead of failing instantly with
                # "database is locked" — the default busy timeout is 0, so any
                # concurrent access (a voice-session write overlapping a REST
                # write, a second worker, an external reader) would otherwise
                # abort a write and surface as e.g. "couldn't save cooking log".
                conn.execute("PRAGMA busy_timeout = 5000;")
                # WAL lets readers run concurrently with the single writer, which
                # removes most reader/writer lock contention. synchronous=NORMAL is
                # the safe, recommended durability pairing for WAL.
                conn.execute("PRAGMA journal_mode = WAL;")
                conn.execute("PRAGMA synchronous = NORMAL;")
                conn.execute("PRAGMA foreign_keys = ON;")
                conn.executescript(SCHEMA)
                _migrate(conn)
                conn.commit()
                _conn = conn
    return _conn


# Columns added after the original schema shipped. `CREATE TABLE IF NOT EXISTS` will not add
# them to a database that already exists, so they are applied here instead.
_ADDED_COLUMNS = [
    ("recipes", "category", "TEXT NOT NULL DEFAULT ''"),
    ("recipes", "is_veg", "INTEGER NOT NULL DEFAULT 0"),
    ("recipes", "search_text", "TEXT NOT NULL DEFAULT ''"),
]


def _migrate(conn: sqlite3.Connection) -> None:
    """Bring an existing database up to the current schema. Idempotent."""
    for table, column, decl in _ADDED_COLUMNS:
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")

    # Backfill the derived columns for rows written before they existed. Embeddings are NOT
    # backfilled here: they were built from the old, narrower document template and must be
    # re-encoded by reindex.py, which owns the model.
    for row in conn.execute(
        "SELECT id, cuisine, category, dietary FROM recipes WHERE category = '' OR is_veg IS NULL"
    ).fetchall():
        conn.execute(
            "UPDATE recipes SET category = ?, is_veg = ? WHERE id = ?",
            (
                row["category"] or row["cuisine"],
                1 if derive_is_veg(json.loads(row["dietary"] or "[]")) else 0,
                row["id"],
            ),
        )


def init_db() -> None:
    """Ensure the database file and schema exist. Safe to call repeatedly."""
    get_conn()


# --------------------------------------------------------------------------- #
# Index freshness signal
#
# Retrieval keeps the whole embedding matrix in memory (retrieval.py). Rather than have every
# write path remember to invalidate that cache, writes bump this counter and the cache rebuilds
# when it notices a change. One choke point, no cross-module imports.
# --------------------------------------------------------------------------- #

_index_version = 0


def index_version() -> int:
    return _index_version


def bump_index_version() -> None:
    global _index_version
    _index_version += 1


# --------------------------------------------------------------------------- #
# Embedding storage
#
# Vectors are stored as raw float32 bytes rather than JSON text: 1536 bytes instead of ~7900,
# and np.frombuffer is ~300x faster than json.loads. _unpack_vector still accepts the old JSON
# form so a database written before the migration keeps working until reindex.py runs.
# --------------------------------------------------------------------------- #

VECTOR_DIM = 384


def pack_vector(embedding: list[float]) -> bytes:
    return np.asarray(embedding, dtype=np.float32).tobytes()


def unpack_vector(value: Any) -> Optional[np.ndarray]:
    if value is None:
        return None
    if isinstance(value, (bytes, memoryview)):
        return np.frombuffer(value, dtype=np.float32)
    # Legacy: JSON text written before the BLOB migration.
    return np.asarray(json.loads(value), dtype=np.float32)


def derive_is_veg(dietary: list[str]) -> bool:
    """A recipe is vegetarian if its dietary tags say so. Vegan implies vegetarian."""
    return any(tag.strip().lower() in ("veg", "vegan", "vegetarian") for tag in dietary or [])


# --------------------------------------------------------------------------- #
# Full-text index maintenance (the lexical half of hybrid retrieval)
# --------------------------------------------------------------------------- #

def index_recipe_text(recipe_id: str, text: str) -> None:
    """Add or replace one recipe's row in the FTS index. Costs one insert, not a rebuild."""
    _execute("DELETE FROM recipes_fts WHERE recipe_id = ?", (recipe_id,))
    _execute("INSERT INTO recipes_fts (recipe_id, text) VALUES (?, ?)", (recipe_id, text))


def unindex_recipe_text(recipe_id: str) -> None:
    _execute("DELETE FROM recipes_fts WHERE recipe_id = ?", (recipe_id,))


def search_recipes_lexical(query: str, limit: int = 30) -> list[tuple[str, float]]:
    """BM25 ranking over the FTS index. Returns [(recipe_id, score)], best first.

    FTS5's bm25() returns a NEGATIVE number where more-negative is better; it is flipped here
    so callers always see "higher is better". A malformed MATCH expression (an unbalanced quote
    from a user query) raises sqlite3.OperationalError rather than returning nothing, so it is
    caught — the dense half of the pipeline still answers.
    """
    if not query.strip():
        return []
    try:
        rows = _query_all(
            """
            SELECT recipe_id, bm25(recipes_fts) AS score
            FROM recipes_fts
            WHERE recipes_fts MATCH ?
            ORDER BY score
            LIMIT ?
            """,
            (query, limit),
        )
    except sqlite3.OperationalError:
        return []
    return [(row["recipe_id"], -float(row["score"])) for row in rows]


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

    THE single definition of what a recipe "is" to retrieval. Every write path must call this
    rather than assembling its own string: two templates means two regions of the vector space
    and a ranking bug that never raises.

    The earlier version embedded only title, cuisine, difficulty and ingredients — about 15% of
    a recipe. Time, servings, dietary tags and the method are all things people search by
    ("gluten free dessert", "ready in 15 minutes", "one pan"), so they belong in the document.

    Changing this template invalidates every stored vector. Re-encode with reindex.py.
    """
    ingredients = ", ".join(
        f"{ing.get('amount', '')} {ing.get('unit', '')} {ing.get('name', '')}".strip()
        for ing in recipe.get("ingredients", [])
    )
    # The method carries technique and equipment words ("simmer", "one pan", "no bake") that
    # nothing else in the row does. Timers and safety alerts are skipped as retrieval noise.
    method = " ".join(
        str(step.get("text", "")).strip()
        for step in recipe.get("steps", [])
        if step.get("text")
    )

    dietary = recipe.get("dietary") or []
    diet_phrase = ", ".join(dietary) if dietary else "no dietary tags"
    if derive_is_veg(dietary):
        diet_phrase += ", vegetarian"
    else:
        diet_phrase += ", contains meat or fish"

    category = recipe.get("category") or recipe.get("cuisine") or ""
    time_minutes = recipe.get("time")

    return (
        f"Title: {recipe.get('title')}. "
        f"Cuisine: {recipe.get('cuisine')}. Category: {category}. "
        f"Difficulty: {recipe.get('difficulty')}. "
        f"Ready in {time_minutes} minutes. Serves {recipe.get('servings')}. "
        f"Dietary: {diet_phrase}. "
        f"Ingredients: {ingredients}. "
        f"Method: {method}"
    ).strip()


def _recipe_to_dict(row: sqlite3.Row, include_embedding: bool = False) -> dict:
    data = {
        "id": row["id"],
        "title": row["title"],
        "cuisine": row["cuisine"],
        "category": row["category"] or row["cuisine"],
        "time": row["time"],
        "difficulty": row["difficulty"],
        "servings": row["servings"],
        "dietary": json.loads(row["dietary"] or "[]"),
        "is_veg": bool(row["is_veg"]),
        "image_url": row["image_url"],
        "ingredients": json.loads(row["ingredients"] or "[]"),
        "steps": json.loads(row["steps"] or "[]"),
        "average_rating": row["average_rating"],
        "rating_count": row["rating_count"],
        "created_at": row["created_at"],
    }
    if include_embedding and row["embedding"] is not None:
        vector = unpack_vector(row["embedding"])
        data["embedding"] = vector.tolist() if vector is not None else None
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
    """Insert a recipe and everything retrieval needs to find it again.

    This is the ONE choke point every creation route converges on — the admin endpoint, the
    HTTP importer, and the voice agent's import tool. Index side effects belong here and
    nowhere else; wiring them into an endpoint would cover one route and silently miss two.
    """
    recipe_id = new_id()
    dietary = recipe.get("dietary", []) or []
    # A caller that already knows the browse bucket can pass it; otherwise the legacy
    # `cuisine` value is the bucket, which is what it has always actually been.
    category = recipe.get("category") or recipe["cuisine"]
    search_text = build_recipe_text({**recipe, "category": category})

    _execute(
        """
        INSERT INTO recipes (id, title, cuisine, category, time, difficulty, servings,
                             dietary, is_veg, image_url, ingredients, steps,
                             search_text, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            recipe_id,
            recipe["title"],
            recipe["cuisine"],
            category,
            int(recipe["time"]),
            recipe["difficulty"],
            int(recipe["servings"]),
            json.dumps(dietary),
            1 if derive_is_veg(dietary) else 0,
            recipe.get("image_url"),
            json.dumps(recipe.get("ingredients", [])),
            json.dumps(recipe.get("steps", [])),
            search_text,
            pack_vector(embedding),
        ),
    )
    index_recipe_text(recipe_id, search_text)
    bump_index_version()
    return get_recipe(recipe_id)


def delete_recipe(recipe_id: str) -> None:
    _execute("DELETE FROM recipes WHERE id = ?", (recipe_id,))
    unindex_recipe_text(recipe_id)
    bump_index_version()


def load_recipe_vectors() -> tuple[list[dict], np.ndarray]:
    """Every recipe that has an embedding, plus their vectors as one L2-normalized matrix.

    Returns (recipes, matrix) where matrix[i] belongs to recipes[i]. Callers cache this and
    rebuild when index_version() changes; see retrieval.py.
    """
    rows = _query_all("SELECT * FROM recipes WHERE embedding IS NOT NULL ORDER BY id")
    recipes, vectors = [], []
    for row in rows:
        vector = unpack_vector(row["embedding"])
        if vector is None or vector.shape[0] != VECTOR_DIM:
            continue
        recipes.append(_recipe_to_dict(row))
        vectors.append(vector)

    if not vectors:
        return [], np.zeros((0, VECTOR_DIM), dtype=np.float32)

    matrix = np.vstack(vectors).astype(np.float32)
    matrix /= np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-9
    return recipes, matrix


def search_recipes(query_embedding: list[float], match_count: int = 6) -> list[dict]:
    """Brute-force cosine ranking straight from SQLite.

    retrieval.search() is the real read path. This stays as the dependency-free fallback: it
    reads the table directly, so it keeps working if the in-memory matrix is unavailable, and
    it is what the frozen eval baseline was measured against.
    """
    recipes, matrix = load_recipe_vectors()
    if not recipes:
        return []

    q = np.asarray(query_embedding, dtype=np.float32)
    q /= np.linalg.norm(q) + 1e-9

    scores = matrix @ q
    order = np.argsort(-scores)[:match_count]
    return [{**recipes[i], "similarity": float(scores[i])} for i in order]


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
    """Add an item, or fold it into the matching one this user already has.

    Adding the same thing twice produced two identical rows, which is never what
    someone shopping wants — and it happened easily, because the voice agent and
    the panel both add items and neither knew about the other. Matching is on the
    trimmed, case-insensitive name so "Tomatoes" and "tomatoes" are one entry.

    A repeat of an item that was already ticked off un-ticks it: asking for it
    again means it is wanted again.
    """
    name = (name or "").strip()
    existing = _query_one(
        "SELECT * FROM shopping_list_items WHERE user_id = ? AND lower(trim(name)) = lower(?)",
        (user_id, name),
    )
    if existing is not None:
        # Only overwrite quantity/unit when the caller actually supplied one, so
        # a bare "add tomatoes" never wipes an existing "2 kg".
        updates: dict[str, Any] = {"checked": 1 if checked else 0}
        if quantity:
            updates["quantity"] = quantity
        if unit:
            updates["unit"] = unit
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        _execute(
            f"UPDATE shopping_list_items SET {set_clause} WHERE id = ? AND user_id = ?",
            tuple(list(updates.values()) + [existing["id"], user_id]),
        )
        return _shopping_item_to_dict(
            _query_one("SELECT * FROM shopping_list_items WHERE id = ?", (existing["id"],))
        )

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
    # Scope the read-back by user_id as well. Without it the UPDATE correctly
    # refuses to touch another user's row, but the SELECT still returns that row
    # to the caller — so PATCHing a guessed id leaked the owner's item contents
    # (and their user_id) to anyone authenticated.
    row = _query_one(
        "SELECT * FROM shopping_list_items WHERE id = ? AND user_id = ?",
        (item_id, user_id),
    )
    return _shopping_item_to_dict(row) if row else None


def delete_shopping_list_item(item_id: str, user_id: str) -> bool:
    """Delete one of this user's items. Returns whether a row was actually removed.

    The caller needs the boolean to answer 404 instead of reporting success for an
    id the user does not own — a silent no-op reads as "deleted" to the client.
    """
    cursor = _execute(
        "DELETE FROM shopping_list_items WHERE id = ? AND user_id = ?",
        (item_id, user_id),
    )
    return cursor.rowcount > 0


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
