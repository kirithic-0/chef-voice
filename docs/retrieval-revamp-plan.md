# ChefVoice — Retrieval Revamp v2 (Hybrid Search + Filters + Reranking)

> v2 supersedes the first draft. v1 was a *menu* of options; v2 locks the decisions, reorders the
> work by risk instead of by file, and fixes seven defects found by checking v1 against the actual
> code. Recover v1 with `git show db3cfa4:docs/retrieval-revamp-plan.md`.

## Context
Recipe search today is a naive baseline: one MiniLM embedding per recipe built from only
title/cuisine/difficulty/ingredients, stored as JSON text in a SQLite column, searched by a
brute-force cosine loop that re-parses and re-normalizes every vector on every query
(`database.py:search_recipes`). No keyword signal, no filters, no reranking, no evaluation.

Goal: a **production-shaped, resume-grade retrieval pipeline** — hybrid (dense + sparse) retrieval,
metadata filtering, cross-encoder reranking, served from a real vector DB, with an **evaluation
harness proving it beats the baseline**. Fixed constraints: keep `all-MiniLM-L6-v2` (384-d),
willing to run a vector DB service, catalog scale flexible.

---

## Decisions locked

| Stage | Decision | Rationale |
|---|---|---|
| Document text | Whole recipe, one point each; richer template (+ steps, dietary, time) | Recipes are short; chunking adds bookkeeping for no gain |
| Dense model | `all-MiniLM-L6-v2`, 384-d, cosine (unchanged) | Fixed constraint |
| Vector store | **Qdrant** (Docker, one container) | Payload filters + native hybrid + server-side fusion for least ops |
| Sparse signal | **fastembed `Qdrant/bm25`** + Qdrant `Modifier.IDF` | Only option that stays **incrementally indexable** — see below |
| Fusion | **RRF**, server-side via Qdrant Query API | Param-light, robust, no score normalization needed |
| Filtering | Qdrant **payload filters** (pre-filtered ANN) | Done in the DB, not post-hoc in Python |
| Reranking | **Cross-encoder** `ms-marco-MiniLM-L-6-v2` over top-30 → top-k | Strongest single precision lever; local and free |
| Query processing | Light LLM normalization **on the HTTP search path only** | The agent already emits clean queries — see latency budget |
| Result shaping | Score threshold + configurable top-k + dedup | Fixes "always returns 6, even for nonsense" |
| Eval | Golden set → Recall@k / MRR / nDCG@k, dense vs hybrid vs hybrid+rerank | The differentiator; built **before** the pipeline, not after |

Rejected: pgvector (forces a full DB migration for no retrieval gain), SPLADE (heavy for v1),
multi-field named vectors (complex, low payoff), HyDE (latency), learned fusion (overkill),
local `rank_bm25` (see incremental section — it cannot do single-doc inserts cleanly).

---

## Step 0 — Preconditions (not optional)

**Expand the catalog before writing any retrieval code.** The current 15 recipes sit in 5 categories
of exactly 3. Dense-only Recall@5 will be at or near 1.0 for any sensible query, leaving hybrid and
reranking no headroom to win — the headline metric would come out as noise.

It also breaks the architecture claim: Qdrant's `indexing_threshold` defaults to **20,000 KB of
vector data**. 15 × 384-d float32 ≈ **23 KB**, so Qdrant serves the collection with a plain
full-scan index and **never builds HNSW at all**. Roughly 13k+ vectors are needed before the default
threshold trips — otherwise set it explicitly, and say which you did.

Actions:
1. Import a few thousand recipes (RecipeNLG, or the Food.com Kaggle set).
2. **Normalize the metadata while importing** — the current schema does not support the filters this
   plan advertises:
   - `cuisine` is not a cuisine. Values are `Indian, Italian, Quick Meals, Healthy, Desserts` — a UI
     browse category. Split into `category` (browse) and `cuisine` (real).
   - There is no veg flag. It is inferred from a `dietary` JSON array of `{Veg, Vegan, Gluten-free}`,
     and **13 of 15 recipes are `Veg`** — the marquee "vegetarian" filter currently removes two
     documents. Materialize an explicit `is_veg` boolean.
   - `difficulty` has two values total; `time` is int minutes, 10–45.
3. Promote the former stretch item "LLM-generated summary + tags per recipe" **into the import
   pipeline** — it is how you get clean `cuisine` / `is_veg` / tag payloads over thousands of rows
   without hand-labeling. One LLM call per recipe, at import time only.

---

## Target architecture

**Read path**
```
query ─► [LLM normalize — HTTP path only] ─► dense(MiniLM) + sparse(BM25 TF)
       ─► Qdrant hybrid query w/ payload FILTERS (is_veg / cuisine / max_time / dietary / difficulty)
       ─► server-side RRF fusion (top ~30) ─► cross-encoder rerank ─► threshold ─► top-k
```

**Write path** (all three creation routes converge)
```
POST /recipes ───────────────┐
POST /recipes/import ────────┤─► db.create_recipe() ─► SQLite row + Qdrant upsert (one point)
agent import_recipe_from_url ┘

DELETE /recipes/{id} ─────────► db.delete_recipe() ─► SQLite delete + Qdrant delete (one point)
```

SQLite stays the **system of record**. Qdrant is the **retrieval index**, rebuildable from SQLite at
any time.

---

## Incremental indexing — adding one recipe

**Yes. Single-recipe upsert is the normal path; full reingest is a maintenance operation only.**

Recipe IDs are already `uuid.uuid4()` strings (`database.py:147`), and Qdrant accepts UUID strings
as point IDs directly — no ID mapping layer needed. Upserting the same ID overwrites in place, so
create and update are the same call.

| Component | Corpus-dependent? | Cost to add one recipe |
|---|---|---|
| Dense MiniLM vector | No | 1 encode, ~5 ms |
| Sparse BM25 vector (TF side) | No — fastembed uses a **fixed `avg_len`**, not the corpus average | 1 encode, ~1 ms |
| BM25 IDF side | Yes, but **server-side** — Qdrant recomputes IDF at query time from current collection stats | free, automatic |
| Payload (is_veg, cuisine, time, tags) | No | per-recipe |
| Cross-encoder rerank | No — query-time only, zero index state | never |
| LLM query normalization | No — query-time only | never |

Total: **one `client.upsert()` with a single point, well under 50 ms.** Deletes are the same shape
(`client.delete(points=[recipe_id])`).

This is precisely why the sparse method is **fastembed + Qdrant `Modifier.IDF`** rather than local
`rank_bm25`: with `rank_bm25` the `BM25Okapi` object is built over the entire corpus in process, so
every insert forces a full rebuild. Server-side IDF makes inserts O(1). That incremental requirement
outweighs the extra `onnxruntime` dependency `fastembed` drags in.

**What still forces a full reindex** (and why the collection name is versioned):
- changing the embedding model or its dimensionality
- changing `build_recipe_text` — existing vectors were built from a different template
- changing BM25 params (`k1`, `b`, `avg_len`) — changes every stored TF vector
- adding a payload field that old points lack, if a filter must be exhaustive over it
- drift / corruption recovery

Handle those by reindexing into a **new** collection (`recipes_minilm384_v2`) and **alias-swapping**,
never by mutating the live one. Qdrant supports aliases; zero-downtime reindex is a free talking
point.

**Eval caveat:** adding recipes silently staleifies the golden set — a newly added recipe that
*should* be relevant to query Q is not in Q's judgment list, so it scores as a false positive and
depresses your metrics. Freeze an eval catalog snapshot, or re-judge affected queries when importing.

---

## Payload schema (Qdrant)

```
point.id      = recipe uuid (same as SQLite)
point.vector  = {"dense": [384 floats], "sparse": SparseVector}
point.payload = {
  recipe_id, title, cuisine, category, is_veg (bool), dietary [str],
  time (int minutes), difficulty, tags [str], text (the embedded doc, for rerank input)
}
```
Storing `text` in the payload lets the cross-encoder score without a second SQLite round-trip.
Create payload indexes on `is_veg`, `cuisine`, `time`, `difficulty` so filters stay pre-ANN.

---

## Implementation sequence (risk-ordered, each step has a gate)

Every step ends with a number. The resulting table **is** the resume artifact.

| # | Step | Gate |
|---|---|---|
| 0 | Import + normalize larger catalog | row count; payload fields populated |
| 1 | Golden set (~40 queries) + `eval/evaluate.py` against **today's** dense baseline | **the "before" number** — without it there is nothing to compare to |
| 2 | Richer `build_recipe_text` (+ steps, dietary, time), re-embed | metrics move vs step 1 |
| 3 | Qdrant up; dense-only through Qdrant | metrics **match** step 2 — proves the migration is clean |
| 4 | + BM25 sparse + RRF fusion | metrics move |
| 5 | + payload filters | filtered queries correct; latency unchanged or better |
| 6 | + cross-encoder rerank | **the headline number** |
| 7 | Query normalization, thresholds, frontend filter controls | nonsense query → empty |

Do not start step 4 before step 3's parity gate passes; a dirty migration hides inside every later
measurement.

---

## Files

**New**
- `backend/vector_store.py` — Qdrant wrapper: `ensure_collection()`, `upsert_recipe()`,
  `delete_recipe()`, `search(dense, sparse, filters, limit)`. Owns the hybrid Query API call and RRF.
- `backend/retrieval.py` — pipeline orchestration: normalize → embed + bm25 → `vector_store.search`
  → rerank → threshold → top-k. Owns the Qdrant-down fallback decision.
- `backend/rerank.py` — `CrossEncoder` wrapper; **warm at startup**, not lazily (see latency).
- `backend/reindex.py` — rebuild a collection from SQLite; idempotent; supports alias swap.
- `backend/eval/` — `golden.json` + `evaluate.py` (Recall@k / MRR / nDCG@k, one row per config).
- `docker-compose.yml` — Qdrant service + named volume.

**Modified**
- `backend/database.py` — richer `build_recipe_text` (`:177`); **dual-write inside `create_recipe`
  (`:285`) and `delete_recipe` (`:310`)**; keep brute-force `search_recipes` (`:314`) as fallback.
- `backend/main.py` — `/recipes/search` accepts filter params; `ensure_collection()` + rerank warm
  on startup. `embedding_model` (`:57`) stays shared.
- `backend/tools.py` — `tool_search_recipes` (`:392`) calls `retrieval.search(...)`, **skipping LLM
  normalization**.
- `backend/seed.py` — keeps creating SQLite rows; delegates embedding/indexing to `reindex.py`
  rather than being replaced by it.
- `backend/requirements.txt` — `qdrant-client`, `fastembed`.
- `frontend/` — veg / cuisine / max-time controls on the search UI, passed to `/recipes/search`.

---

## Gotchas locked in

**1. Dual-write belongs in `database.py`, not `main.py`.** There are three creation paths and only
one lives in `main.py`: `POST /recipes` (`main.py:227`), `POST /recipes/import` (`main.py:368`,
which delegates to the tool), and the agent's `import_recipe_from_url` over the WebSocket
(`tools.py:732`). Wiring at the endpoint layer misses the voice path and the index drifts silently.
Hook `db.create_recipe` / `db.delete_recipe` — one choke point, all paths covered.
There is **no update endpoint** today (no PUT/PATCH `/recipes/{id}`); if one is added, it is the
same upsert.

**2. BM25 needs the IDF modifier.** fastembed's `Qdrant/bm25` emits the TF half only. Configure the
sparse vector with `modifier=models.Modifier.IDF` on the collection or you get TF-only scoring that
looks like it works and quietly underperforms. This is the most common silent failure in this build.

**3. Two thresholds, two scales.** `ms-marco-MiniLM-L-6-v2` outputs **unbounded raw logits**
(roughly −11…+11), not 0–1 similarities. Threshold on `sigmoid(logit)`, calibrated empirically —
and it cannot be the same constant as the cosine threshold used on the fallback path. Name both in
config.

**4. Response shape.** Results already carry `similarity` (`database.py:327`), consumed by
`tools.py:403` and asserted in `frontend/src/lib/api.test.ts:34`. Keep populating `similarity` with
the final (rerank) score rather than introducing a parallel `score` field, or update the frontend
test deliberately. Add `debug_scores` (dense / sparse / rrf / rerank) behind a query flag.

**5. The fallback cannot filter.** Brute-force cosine over `list_recipes()` has no payload filters.
If Qdrant is down and the user asked for "veg under 20 min", either reimplement the filters in
Python on that path too, or degrade **loudly**. "No hard failure" must not mean "silently wrong
filters".

**6. Latency budget on the voice path.** A voice turn is STT → LLM decides to call `search_recipes`
→ tool → LLM composes reply → TTS. Putting LLM query normalization inside the tool makes that **two
serial LLM round-trips per turn** — +400–900 ms on Groq, considerably worse on the local Ollama /
Gemma provider (`providers.py`). It is also redundant there: the agent already emits a cleaned
`query` argument (`tools.py:392`). Raw human text arrives at the **typed** search box
(`frontend/src/App.tsx:304`). So: normalize on `/recipes/search`, skip for `tool_search_recipes`.
Cross-encoder over 30 candidates is ~50–150 ms on CPU — acceptable, but it is a second ~80 MB model
download; **warm it at startup** so the first voice search does not eat the load.

**7. Tests must run without Qdrant.** `test_backend.py:48` seeds by calling `db.create_recipe`
directly, so a dual-write there makes the whole suite require a running Qdrant. Add the escape hatch
in the same commit as the dual-write: `VECTOR_STORE=none` env flag or an injectable no-op store.

---

## Verification
- `docker compose up qdrant`; `python reindex.py` → collection point count == recipe row count.
- **Incremental:** `POST /recipes` → point count +1, no reindex run; the new recipe is findable by a
  query matching only it. Same via `/recipes/import` and via the agent tool over the WebSocket.
- `DELETE /recipes/{id}` → point count −1; recipe no longer returned.
- `python eval/evaluate.py` → prints Recall@k / MRR / nDCG for dense vs hybrid vs hybrid+rerank.
  Hybrid+rerank should win. **This is the headline proof.**
- Manual: "spicy vegetarian pasta under 30 min" → correctly filtered and ordered; nonsense query →
  empty (threshold works).
- Voice/chat: assistant `search_recipes` returns reranked, filtered suggestions with no added LLM hop.
- Regression: `pytest` green **with Qdrant stopped**; `/recipes/search` response shape unchanged.
- Resilience: stop Qdrant mid-session → search falls back to brute force; filtered queries either
  still filter or fail loudly.

## Resume payoff
"Built a hybrid (dense + BM25) retrieval pipeline over **Qdrant** with **metadata pre-filtering**,
**server-side RRF fusion**, and **cross-encoder reranking**, plus LLM query normalization and
incremental single-document indexing; measured **+X% Recall@5 / MRR** over a dense baseline on a
40-query golden set." — every clause maps to a numbered step with a gate.
