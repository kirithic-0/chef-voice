# ChefVoice — Retrieval Revamp (Hybrid Search + Filters + Reranking)

## Context
The recipe search today is a naive baseline: one MiniLM embedding per recipe (built from only
title/cuisine/difficulty/ingredients), stored as JSON text in a SQLite column, searched by a
**brute-force cosine loop that re-parses and re-normalizes every vector on every query**
(`database.py:search_recipes`). No keyword signal, no filters, no reranking, no evaluation.

Goal (per user): turn this into a **production-shaped, resume-grade retrieval pipeline** —
**hybrid (dense + sparse) retrieval, metadata filtering, and cross-encoder reranking**, served from
a **real vector DB**, with an **evaluation harness** proving it beats the baseline. Constraints from
the user: **keep the MiniLM embedding model** (`all-MiniLM-L6-v2`, 384-d), **willing to run a vector
DB service**, catalog scale is flexible ("whichever is impressive"). At 15 recipes this is
over-engineered on paper — the point is the architecture + the measured quality gains.

Weighting rubric per option (1–5, higher = better; **Effort** 5 = least work):
**Resume** = signal/impressiveness · **Quality** = relevance/precision gain · **Effort** · **Fit**
= matches constraints (keep MiniLM, run-a-DB, current stack). ✅ = recommended.

---

## Target architecture (recommended path)
SQLite stays the **system of record** (recipes/users/etc.). A new **Qdrant** service is the
**retrieval index**. Query flow:

```
query ─► [LLM query normalize (light)] ─► dense(MiniLM) + sparse(BM25)
        ─► Qdrant hybrid search w/ payload FILTERS (veg/cuisine/time/dietary)
        ─► RRF fusion (top ~30) ─► cross-encoder rerank ─► threshold ─► top-k
```
Dual-write: on recipe create/update/delete, upsert/delete the Qdrant point. A reindex script
rebuilds the index from SQLite. An eval harness (golden queries → Recall@k / MRR / nDCG) compares
dense-only vs hybrid vs hybrid+rerank.

---

## Stage-by-stage options + weights

### 1. Ingestion — what text becomes the document
| Option | Resume | Quality | Effort | Fit | Verdict |
|---|:--:|:--:|:--:|:--:|---|
| a. Current blob (title/cuisine/diff/ingredients) | 1 | 1 | 5 | 3 | baseline |
| b. + steps + dietary + time (richer doc) | 2 | 4 | 5 | 5 | ✅ do this |
| c. LLM-generated summary + tags per recipe | 4 | 4 | 3 | 4 | ✅ stretch (great signal) |
| d. Multi-field named vectors (title vs body separately) | 4 | 3 | 2 | 3 | skip (complex, low payoff here) |
Pick: **b now, c as a stretch.** Reuse/extend `build_recipe_text` (`database.py:177`). Also store
structured metadata (cuisine, dietary, time, difficulty, veg-flag) in the Qdrant **payload** for
filtering, and keep `recipe_id` to join back to SQLite.

### 2. Chunking
Recipes are short → **one document per recipe** (no chunking). Per-step chunking only helps
technique queries and adds bookkeeping; not worth it. Effort 5, Quality neutral. **Pick: whole-recipe.**

### 3. Embedding model (dense) — FIXED by user
Keep `all-MiniLM-L6-v2` (384-d), L2-normalized, cosine. Load once (already done, `main.py:57`).
No change. (Note for later: e5/bge would raise quality, but user chose to keep MiniLM.)

### 4. Vector store / index service
| Option | Resume | Quality | Effort | Fit | Verdict |
|---|:--:|:--:|:--:|:--:|---|
| a. **Qdrant** (dedicated vector DB) | 5 | 5 | 4 | 5 | ✅ recommended |
| b. Postgres + pgvector (migrate off SQLite) | 5 | 4 | 2 | 3 | strong alt, bigger migration |
| c. Weaviate | 4 | 4 | 3 | 3 | heavier, module-driven |
| d. Milvus | 4 | 4 | 2 | 2 | overkill at this scale |
| e. Chroma | 2 | 3 | 5 | 3 | easy but "dev toy" signal |
Pick: **Qdrant** — first-class **payload filtering** + **native hybrid** (dense+sparse) with
server-side **RRF/DBSF fusion**, HNSW index, clean Python client, runs as one Docker container.
Best resume signal for least ops. Index: **HNSW, cosine** (Qdrant default) — mention IVF/flat as
alternatives but HNSW is the impressive standard.

### 5. Retrieval strategy (the core "hybrid" ask)
| Option | Resume | Quality | Effort | Fit | Verdict |
|---|:--:|:--:|:--:|:--:|---|
| a. Dense only (current) | 1 | 2 | 5 | 5 | baseline |
| b. Sparse/keyword only (BM25) | 2 | 3 | 4 | 4 | baseline-2 (great for exact terms) |
| c. **Hybrid dense + sparse w/ fusion** | 5 | 5 | 3 | 5 | ✅ the centerpiece |
Pick: **Hybrid.** Sparse method + fusion sub-choices:

**Sparse signal**
| Option | Resume | Quality | Effort | Fit | Verdict |
|---|:--:|:--:|:--:|:--:|---|
| BM25 via `fastembed` sparse vectors in Qdrant | 4 | 4 | 4 | 5 | ✅ recommended |
| Local `rank_bm25` + fuse in Python | 3 | 4 | 4 | 4 | ✅ fallback (full control) |
| SPLADE (learned sparse) | 5 | 4 | 2 | 3 | flashy but heavy; skip v1 |
| SQLite FTS5 / Postgres tsvector | 3 | 3 | 3 | 3 | only if staying in-DB |

**Fusion**
| Option | Resume | Quality | Effort | Fit | Verdict |
|---|:--:|:--:|:--:|:--:|---|
| **Reciprocal Rank Fusion (RRF)** | 4 | 4 | 5 | 5 | ✅ robust, param-light, standard |
| Weighted linear (α·dense + (1−α)·sparse) | 3 | 4 | 4 | 4 | needs score normalization + tuning |
| Learned fusion | 5 | 4 | 1 | 2 | overkill |
Pick: **BM25 sparse + RRF**, done server-side by Qdrant's Query API.

### 6. Metadata filtering
Filter by **veg/non-veg, cuisine, max cook time, dietary, difficulty** via Qdrant **payload
filters** (pre-filtered ANN, done in the DB). Resume 3 · Quality 4 (big UX win) · Effort 4 · Fit 5.
**Pick: server-side payload filters.** Surface a couple of filters in the search UI (frontend) and
pass them as query params → the agent tool can also set them.

### 7. Reranking (precision)
| Option | Resume | Quality | Effort | Fit | Verdict |
|---|:--:|:--:|:--:|:--:|---|
| a. None (fusion order) | 1 | 2 | 5 | 5 | baseline |
| b. **Cross-encoder** (`ms-marco-MiniLM-L-6-v2`) | 5 | 5 | 4 | 5 | ✅ recommended |
| c. LLM-as-reranker (Groq/Nemotron) | 4 | 4 | 4 | 4 | trendy alt; +latency/tokens |
| d. MMR (diversity) | 2 | 2 | 4 | 3 | optional add-on |
Pick: **cross-encoder** over top-N (~30) → final top-k. Local, free, already have
`sentence-transformers`. Strongest single precision lever + great resume line.

### 8. Query processing
| Option | Resume | Quality | Effort | Fit | Verdict |
|---|:--:|:--:|:--:|:--:|---|
| Raw query (current) | 1 | 2 | 5 | 5 | baseline |
| **Light LLM normalize** (spoken → clean query, extract filters) | 4 | 4 | 3 | 5 | ✅ fits voice app |
| HyDE (hypothetical-doc embedding) | 5 | 3 | 2 | 3 | flashy; +latency, skip v1 |
| Multi-query expansion | 4 | 3 | 3 | 3 | optional |
Pick: **light LLM query normalization** (reuse existing LLM infra) — also parses "veg pasta under
20 min" into query + filters. HyDE noted as a stretch.

### 9. Scoring / result shaping
Add a **similarity/rerank-score threshold** to drop weak matches (fixes "always returns 6 even for
nonsense"), configurable top-k, dedup, return scores for debugging. Effort 5, Quality 3. **Pick: yes.**

### 10. Evaluation harness (the resume differentiator)
A **golden set** (~30–50 query→relevant-recipe judgments) + a script computing **Recall@k, MRR,
nDCG@k**, comparing dense-only vs hybrid vs hybrid+rerank, printing a table. Resume 5 · Quality 5
(proves the gains) · Effort 3 · Fit 5. **Pick: yes — this is what makes it a real project.** Since
15 recipes is thin, optionally **expand the catalog** (import a larger public recipe set) so the
eval and ANN are meaningful.

### 11. Ops / ingestion pipeline
`docker-compose.yml` for Qdrant; dual-write on recipe create/update/delete; idempotent
`reindex.py` (rebuild Qdrant from SQLite, replaces the embed loop in `seed.py`); collection
versioning (name encodes model+dim so re-embeds are safe). Resume 4 · Effort 3. **Pick: yes.**

---

## Implementation outline (files)
- **New `backend/vector_store.py`** — Qdrant client wrapper: `ensure_collection()`, `upsert_recipe()`,
  `delete_recipe()`, `search(dense, sparse, filters, limit)`. Owns dense+sparse+RRF via Query API.
- **New `backend/retrieval.py`** — orchestrates the pipeline: query-normalize → embed(dense) +
  bm25(sparse) → `vector_store.search(filters)` → cross-encoder rerank → threshold → top-k.
- **New `backend/rerank.py`** — lazy-loaded `CrossEncoder`; `rerank(query, candidates) -> ordered`.
- **Extend `backend/database.py`** — richer `build_recipe_text` (add steps/dietary/time); keep it as
  system of record; expose metadata for payloads. Keep the old brute-force `search_recipes` as a
  fallback when Qdrant is down.
- **Wire `backend/main.py`** — `/recipes/search` (accept `filters`), recipe create/update/delete →
  `vector_store` dual-write; startup `ensure_collection()`. Keep `embedding_model` shared.
- **Wire `backend/tools.py`** — `tool_search_recipes` calls `retrieval.search(...)` (with filters).
- **New `backend/reindex.py`** — rebuild Qdrant from SQLite; **new `backend/eval/`** — golden
  queries + `evaluate.py` (Recall@k/MRR/nDCG).
- **`requirements.txt`** — add `qdrant-client`, `fastembed` (BM25 sparse); cross-encoder uses
  existing `sentence-transformers`.
- **`docker-compose.yml`** — Qdrant service (+ optional volume).
- **Frontend (light)** — add veg/cuisine/max-time filter controls to the search and pass them to
  `/recipes/search`; results already flow through `searchRecipes` / `assistantSuggestions`.

## Migration / data
Keep SQLite recipes; run `reindex.py` to populate Qdrant. Collection name embeds `minilm-384-v1`.
Dual-write keeps them in sync thereafter. Optionally import a larger recipe dataset first so the
eval is meaningful.

## Verification (end-to-end)
- `docker compose up qdrant`; `python reindex.py` → collection count == recipe count.
- `python eval/evaluate.py` → prints Recall@k/MRR/nDCG for **dense vs hybrid vs hybrid+rerank**;
  hybrid+rerank should win. This is the headline proof.
- Manual: query "spicy vegetarian pasta under 30 min" → correct veg/time-filtered, well-ordered
  hits; a nonsense query → empty (threshold works).
- Voice/chat: assistant `search_recipes` returns the reranked, filtered suggestions.
- Regression: `pytest` still green; `/recipes/search` returns the same response shape (+ `score`).
- Resilience: stop Qdrant → search falls back to the in-process brute-force path (no hard failure).

## Resume payoff (why each piece earns its place)
"Built a hybrid (dense + BM25) retrieval pipeline over **Qdrant** with **metadata pre-filtering**,
**RRF fusion**, and **cross-encoder reranking**; **LLM query normalization**; measured **+X% Recall@5
/ MRR** over a dense baseline on a golden eval set." — every clause maps to a stage above.
