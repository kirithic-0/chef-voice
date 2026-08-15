# `database.py` — ChefVoice Data Layer

The entire persistence layer for ChefVoice. It replaces the original cloud
**Supabase (PostgreSQL + pgvector)** backend with a self-contained local
**SQLite** file, and performs semantic recipe search **in-process** with NumPy
cosine similarity. It is the foundational leaf of the backend — it imports
nothing internal, and `tools.py`, `agent.py`, `main.py`, and `seed.py` all
build on top of it.

---

## 1. Three design decisions

1. **JSON-in-text columns** — SQLite has no array/JSON type, so every
   list/dict field (`ingredients`, `steps`, `dietary`, `embedding`,
   `messages`) is stored as a JSON **string** and parsed back with
   `json.loads` on read. This keeps the JSON shape sent to the frontend
   identical to the old Supabase responses.
2. **Brute-force vector search** — instead of pgvector, `search_recipes`
   loads every recipe embedding and ranks them by cosine similarity in NumPy.
   The catalogue is small (~15 recipes), so a full scan is instant.
3. **Security lives in the API layer** — there is no row-level security.
   Per-user isolation is enforced in `main.py` by always scoping queries to the
   authenticated user id. Functions that touch user-owned data take a
   `user_id` and put it in the `WHERE` clause.

---

## 2. Connection model

```python
DB_PATH = env CHEFVOICE_DB || ./chefvoice.db   # overridable (tests use a temp path)
_conn   = one shared sqlite3.Connection         # module-global handle
_lock   = one threading.Lock()                  # serializes ALL access
```

- **One shared connection, one global lock.** `conn` is a single
  `sqlite3.Connection` — the open handle to the DB file. Every read and write
  goes through `_lock`, so database access is fully serialized (simple, at the
  cost of no read parallelism).
- **`check_same_thread=False`** — `sqlite3` normally forbids using a
  connection from a thread other than the one that created it. FastAPI/uvicorn
  serves requests on multiple threads, so this flag lifts that restriction;
  `_lock` is what makes the sharing safe.
- **`row_factory = sqlite3.Row`** — lets code access columns by name
  (`row["title"]`) and do `dict(row)`.
- **`PRAGMA foreign_keys = ON`** — SQLite ignores foreign keys by default;
  this line activates the `ON DELETE CASCADE` / `SET NULL` rules.
- **`get_conn()`** uses **double-checked locking** (`if _conn is None` both
  outside and inside the lock) so the connection is created exactly once.
- **`init_db()`** just calls `get_conn()` — safe to run on every startup
  because the schema uses `CREATE TABLE IF NOT EXISTS`.
- **`new_id()`** returns a `uuid4()` string, mirroring the old Postgres UUID PKs.

---

## 3. Schema (8 tables)

Everything hangs off `users`:

```
users (id) ─────┬── 1:1 ── profiles          (shared PK, CASCADE)
                ├── 1:N ── favorites          ─┐
                ├── 1:N ── cooking_history     ─┤ all CASCADE
                ├── 1:N ── conversations       ─┤ on user delete
                ├── 1:N ── shopping_list_items ─┤
                └── 1:N ── user_memories       ─┘

recipes (id) ───┬── 1:N ── favorites          (CASCADE)
                ├── 1:N ── cooking_history     (CASCADE)
                └── 0:N ── user_memories       (SET NULL — note outlives recipe)
```

| Table | Key columns | Notes |
|-------|-------------|-------|
| **users** | `id` PK, `username` UNIQUE, `password_hash` | Auth identity only (hashing lives in `auth.py`). |
| **profiles** | `id` PK **and** FK→users(id) | 1:1 via shared PK. `is_admin` is 0/1. |
| **recipes** | `id` PK | Shared catalogue. `time` in minutes; `dietary`/`ingredients`/`steps`/`embedding` are JSON; `embedding` = 384 floats; `average_rating`+`rating_count` denormalized. |
| **favorites** | `UNIQUE(user_id, recipe_id)` | Join table; UNIQUE prevents double-favoriting. |
| **cooking_history** | `user_id`, `recipe_id`, `rating` | One row per completed cook; `rating` feeds the recipe average. |
| **conversations** | `user_id`, `messages` (JSON) | Saved voice-session transcripts. |
| **shopping_list_items** | `user_id`, `name`, `checked` | Editable per-item list. |
| **user_memories** | `user_id`, optional `recipe_id`, `note` | Free-text notes; `recipe_id` is `SET NULL` on recipe delete. |

Conventions: **booleans are `INTEGER` 0/1** (`is_admin`, `checked`),
**timestamps** default to `datetime('now')` (UTC text) at the DB level.

---

## 4. Query helpers

Three one-line wrappers keep every function terse and consistent:

| Helper | Purpose |
|--------|---------|
| `_execute(query, params)` | Write: lock → execute → **commit** → return cursor. |
| `_query_all(query, params)` | Read → `list[Row]`. |
| `_query_one(query, params)` | Read → single `Row` or `None`. |

---

## 5. Serializers (JSON text → Python objects)

- `build_recipe_text(recipe)` — composes the descriptive string that gets
  embedded (`Title: … Cuisine: … Difficulty: … Ingredients: …`). **Shared** by
  the seed script and the admin create-recipe path so stored recipes and search
  queries are embedded consistently.
- `_recipe_to_dict(row, include_embedding=False)` — parses the JSON columns;
  drops the large embedding unless explicitly requested.
- `_profile_to_dict` / `_shopping_item_to_dict` — same idea, plus casting 0/1
  back to Python `bool`.

---

## 6. Function groups

| Group | Key functions | Notes |
|-------|---------------|-------|
| **Users** | `create_user`, `get_user_by_username`, `get_user_by_id` | `create_user` inserts the user **and** a default profile row. |
| **Profiles** | `get_or_create_profile`, `set_admin`, `is_admin` | `get_or_create_profile` is defensively lazy. |
| **Recipes** | `list_recipes`, `get_recipe`, `create_recipe`, `delete_recipe`, `search_recipes`, `recompute_recipe_rating` | See §7 for search + ratings. |
| **Favorites** | `list_favorites`, `add_favorite`, `remove_favorite` | `add_favorite` is idempotent (returns existing row instead of erroring). |
| **Cooking history** | `list_cooking_history`, `add_cooking_history` | List embeds the joined recipe per row; adding with a rating triggers a recompute. |
| **Conversations** | `list_conversations`, `add_conversation` | `messages` JSON-encoded on write, decoded on read. |
| **Shopping list** | `list_shopping_list`, `add/update/delete_shopping_list_item` | Update/delete scope by `id AND user_id` so users can't touch each other's items. |
| **Memories** | `list_memories`, `add_memory` | Back the agent's `save_note` / `recall_memories` tools. |

---

## 7. Two things worth understanding

**Semantic search** (`search_recipes`, brute-force cosine similarity):

1. Load all recipes that have an embedding.
2. Normalize the query vector to unit length (`q / (‖q‖ + 1e-9)`; the epsilon
   avoids divide-by-zero).
3. For each recipe, normalize its embedding and take the **dot product** — for
   unit vectors that *is* cosine similarity.
4. Sort descending, return the top `match_count` (default 6), each with a
   `similarity` score attached.

**Denormalized ratings** (`recompute_recipe_rating`): `average_rating` and
`rating_count` are cached on the recipe row rather than computed on every read.
The function recalculates them with a single `AVG(rating), COUNT(rating)` over
`cooking_history`, and is called whenever `add_cooking_history` receives a
rating. It **replaces an old Postgres trigger** (`update_recipe_rating_stats`)
that fired automatically in the cloud DB.

---

## 8. Things to keep in mind (not bugs)

- **Global lock = single-threaded DB.** Every read serializes. Fine at this
  scale; the first thing to revisit if concurrency grows (options:
  connection-per-thread, a pool, or WAL mode).
- **N+1 reads** in `list_cooking_history` (a `get_recipe` per row). Harmless
  here; a JOIN would replace it at scale.
- **`list_favorites` returns raw join rows**, not the joined recipe — the
  frontend cross-references them against the already-loaded recipe list.
- **Trust boundary:** this layer assumes callers pass the correct `user_id`; it
  does not check who is asking. It is only as safe as the auth layer above it.
