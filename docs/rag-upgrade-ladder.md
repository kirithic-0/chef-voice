# ChefVoice RAG — Analysis and Upgrade Ladder

> Companion to `retrieval-revamp-plan.md`. That doc locks one destination (Qdrant + hybrid +
> rerank). This one measures what exists today, then lays out **every** upgrade sorted by
> complexity, so each stage can be shipped and judged on its own. It also treats
> **incremental ingestion as a design constraint that applies at every stage**, not a feature
> bolted on at the end.
>
> All numbers below were measured on this machine against the live `chefvoice.db`
> (15 recipes, `all-MiniLM-L6-v2`, Python 3.11, bundled SQLite 3.45.1).

---

## Part 1 — What the pipeline actually is today

### 1.1 The whole thing, end to end

**Write path** — three routes, all converging on one function:

| Route | Entry | Builds embed text | Writes |
|---|---|---|---|
| Admin create | [main.py:228](backend/main.py:228) | `db.build_recipe_text` | `db.create_recipe` |
| URL import (HTTP) | [main.py:368](backend/main.py:368) → tool | **its own inline copy** | `db.create_recipe` |
| URL import (voice agent) | [tools.py:732](backend/tools.py:732) | **its own inline copy** | `db.create_recipe` |
| Seed | [seed.py](backend/seed.py) | `db.build_recipe_text` | `DELETE FROM recipes` + re-insert all |

`db.create_recipe` ([database.py:285](backend/database.py:285)) inserts a row with the 384-float
vector serialized as **JSON text** in the `embedding` column. `db.delete_recipe`
([database.py:310](backend/database.py:310)) is a plain `DELETE`. There is no update path.

**Read path** — two callers, one implementation:

```
"veg pasta"  ──► MiniLM.encode ──► db.search_recipes(vec, 6) ──► top-6 by cosine
                                        │
   /recipes/search (main.py:212) ───────┤
   tool_search_recipes (tools.py:392) ──┘
```

`db.search_recipes` ([database.py:314](backend/database.py:314)) does, **per query**:
`SELECT *` on every recipe (including the full `steps` JSON), `json.loads` each embedding,
re-normalize each vector, dot product, sort, slice 6.

**Document representation** — [`build_recipe_text`](backend/database.py:177) embeds:

```
Title: Classic Butter Chicken. Cuisine: Indian. Difficulty: Medium.
Ingredients: 800 g, cubed Chicken thighs, 1/2 cup Yogurt, ... 1/2 cup Heavy cream.
```

That is **241 of 1554 characters** of that recipe — about **15%**. `steps`, `time`, `servings`,
`dietary`, and ratings are stored but never embedded and never filtered on.

That is the entire RAG system: one dense vector per recipe, one brute-force cosine loop,
a hardcoded top-6. No lexical signal, no filters, no reranking, no thresholds, no evaluation.

### 1.2 Measured failures

Each row was reproduced against the live database, not reasoned about.

| # | Finding | Evidence |
|---|---|---|
| 1 | **No relevance floor.** Nonsense returns six confident-looking recipes, and the voice agent reads them aloud as suggestions. | `"quantum blockchain algebra"` → 6 results, top similarity **0.139** |
| 2 | **Dietary data is invisible to retrieval.** | `"gluten free dessert"` → #1 is *Quick Fluffy Pancakes*, `dietary: ["Veg"]` — not gluten-free. *Mango Sticky Rice* (`Veg, Vegan, Gluten-free`) ranks 4th. |
| 3 | **Time and servings are invisible.** | `"paneer under 20 minutes"` ranks the 30-min Paneer Tikka Masala first purely on the word "paneer"; the time clause contributes nothing |
| 4 | **Filtering happens after retrieval, in the browser.** [App.tsx:327](frontend/src/App.tsx:327) filters the fixed six results client-side. | `"quick lunch"` + Non-Veg → **1 of 6 survives**. `"curry"` + Non-Veg → 2 of 6. On a larger catalog this returns an empty page routinely. |
| 5 | **`cuisine` is not a cuisine.** | Values are `Indian, Italian, Quick Meals, Healthy, Desserts` — a browse category with 5 buckets of exactly 3 |
| 6 | **No lexical signal at all.** Rare tokens, exact dish names, and ingredient spellings ride entirely on MiniLM's 384 dimensions. | — |
| 7 | **O(N) loop, with JSON parsing and re-normalization inside it.** | 1.3 ms @ 15 · 8.2 ms @ 100 · **85 ms @ 1k** · **418 ms @ 5k** · **1.78 s @ 20k**. A cached normalized float32 matrix does the same work in 0.05–0.56 ms — **28× to 3177×** faster. |
| 8 | **Vectors stored as JSON text.** | 7924 bytes vs 1536 as float32 — **5.2× bloat**, and `json.loads` is **328× slower** than `np.frombuffer`. 7.9 MB per 1000 recipes. |
| 9 | **The embed template is duplicated.** [tools.py:728](backend/tools.py:728) rebuilds `build_recipe_text`'s string inline instead of calling it. | The moment the template changes, imported recipes get embedded by the old one and land in a different region of the space. Silent, permanent drift. |
| 10 | **No evaluation.** No golden set, no metrics, no baseline. | Every improvement below is currently unfalsifiable |
| 11 | **`match_count` hardcoded to 6** in both callers | [main.py:216](backend/main.py:216), [tools.py:397](backend/tools.py:397) |
| 12 | **The catalog is too small to measure anything.** 15 recipes in 5 categories of 3. | Recall@5 saturates near 1.0 for any sensible query — hybrid and reranking have no headroom to demonstrate a win |
| 13 | **Personalization data is collected and ignored.** `favorites`, `cooking_history`, `average_rating`, `user_memories` all exist and never touch ranking. | — |

### 1.3 What is already good

Worth keeping, not rebuilding:

- **All three write paths converge on `db.create_recipe`.** That is the single choke point every
  indexing upgrade needs, and it already exists.
- **Recipe IDs are `uuid4` strings** ([database.py:147](backend/database.py:147)) — usable directly
  as vector-store point IDs, no mapping layer.
- **SQLite is unambiguously the system of record.** Any index can be rebuilt from it.
- **Encoding already runs in a threadpool** (`run_in_threadpool`), so it does not block the event loop.
- **Recipes are short.** No chunking strategy is needed — one document per recipe is correct and
  removes a whole category of complexity.

### 1.4 The honest summary

At 15 recipes, **the current pipeline's latency is fine and its relevance is not**. Findings 1–6
are relevance bugs that exist at any scale; findings 7–8 are scale bugs that do not bite yet. This
matters for sequencing: the instinct is to reach for a vector database, but a vector database fixes
7 and 8, which are not currently hurting, and does nothing about 1–6.

---

## Part 2 — The upgrade ladder

Six stages, ordered by complexity — new concepts, new dependencies, new infrastructure. Each
stage is independently shippable and independently measurable. **Every stage assumes Stage 0
exists**, because without it none of the claims below can be checked.

Column key: **Cost** is implementation effort. **Δ Relevance** is expected search-quality gain
at the *current* catalog size. **Incremental** is what the change does to per-recipe ingestion.

---

### Stage 0 — Ground truth *(no pipeline change)*

You cannot rank anything below without this, and it is the part that makes the work defensible.

| Item | What it is | Cost |
|---|---|---|
| 0a | **Golden set**: 40–60 `{query, relevant_recipe_ids}` judgments covering dish names, ingredients, dietary, time, cuisine, vague intent ("something comforting"), and 5 nonsense queries that should return *nothing* | 3–4 h |
| 0b | **`eval/evaluate.py`**: Recall@k, MRR, nDCG@k, plus latency p50/p95, one row per configuration | 2 h |
| 0c | **Baseline run** against today's pipeline — this is the "before" number | 15 min |
| 0d | **`debug_scores`** on the search response behind a query flag (dense / lexical / fused / rerank) | 1 h |
| 0e | **Frozen eval snapshot** of the catalog + its judgments | 1 h |

**The staleness trap in 0e:** adding recipes silently degrades your metrics. A newly imported recipe
that *should* match query Q is not in Q's judgment list, so it scores as a false positive. Either
evaluate against a frozen snapshot, or re-judge affected queries on import. This is the single most
common way an eval harness starts lying to you.

**Incremental impact:** none.

---

### Stage 1 — Zero-dependency wins *(no new packages, no infrastructure)*

Same architecture. This stage fixes findings 1, 2, 3, 4, 7, 8, 9, 11 and is deployable the day it
is written. **This is the highest value-per-hour stage in the document.**

| # | Upgrade | Fixes | Cost | Δ Relevance |
|---|---|---|---|---|
| 1a | **Richer `build_recipe_text`** — add steps, dietary, time, servings, and a short tag list. Embeds ~90% of the recipe instead of 15%. | 2, 3, partly 6 | 1 h + re-embed | **High** |
| 1b | **De-duplicate the template** — make [tools.py:728](backend/tools.py:728) call `db.build_recipe_text`. Do this *in the same commit as 1a* or the import paths drift immediately. | 9 | 15 min | correctness |
| 1c | **In-memory embedding matrix** — load once as a normalized `float32` `(N, 384)` array, invalidate on write, replace the loop with one matmul + `argpartition` | 7 | 2 h | none (latency) |
| 1d | **Store vectors as `float32` BLOB**, not JSON text | 8 | 1 h + migration | none (5.2× smaller) |
| 1e | **Score threshold + configurable `match_count`** — return `[]` below the floor | 1, 11 | 1 h | **High** |
| 1f | **Server-side filters on `/recipes/search`** (`is_veg`, `cuisine`, `max_time`, `difficulty`) applied as a boolean mask on the matrix **before** top-k | 4 | 3 h | **High** |
| 1g | **Materialize `is_veg`** as a real column; split `cuisine` into `category` (browse) and `cuisine` (real) | 2, 5 | 2 h + migration | enables 1f |
| 1h | **Query-embedding LRU cache** — repeated/debounced queries skip the encode | — | 30 min | none (latency) |
| 1i | **Rating / recency tie-break** on near-equal scores | 13 | 1 h | Low |
| 1j | **Frontend filter controls** wired to 1f instead of post-filtering | 4 | 2 h | **High** (perceived) |

**Why 1f matters more than it looks.** Pre-filtering and post-filtering are not the same operation.
Post-filtering asks "of these 6, which are veg?" Pre-filtering asks "of the veg recipes, which 6 are
best?" The first collapses to 1 result on a measured query today; the second cannot. At brute-force
scale, pre-filtering is a free numpy mask — this is one of the rare cases where the simple
architecture makes the correct behavior *cheaper*.

**Incremental impact:** preserved, with two caveats. The 1c cache needs invalidation on
create/delete (an in-process flag, or an append to the matrix). And **1a forces a one-time re-embed
of the whole catalog** — 15 recipes today, which is exactly why it should happen now rather than at
5,000.

**Gate:** metrics beat the Stage 0 baseline; nonsense query returns empty; `"quick lunch"` + Non-Veg
returns a full page.

---

### Stage 2 — Lexical signal and fusion *(still zero new dependencies)*

Dense embeddings are weak on exact tokens, rare ingredient names, and dish names they have never
seen. Hybrid retrieval is the standard fix, and it does **not** require a vector database.

| # | Upgrade | Cost | Notes |
|---|---|---|---|
| 2a | **SQLite FTS5 index** over the recipe text — `CREATE VIRTUAL TABLE recipes_fts USING fts5(...)` with the built-in `bm25()` ranking | 3 h | **Verified available** in the bundled SQLite 3.45.1 — no new package |
| 2b | **RRF fusion** of dense top-N and BM25 top-N, ~15 lines of Python. Rank-based, so no score normalization | 2 h | |
| 2c | **Synonym / alias expansion** — a small hand-written map (`aglio e olio` → `garlic oil spaghetti`, `capsicum` → `bell pepper`) | 2 h | Cheap recall on the queries dense retrieval misses |
| 2d | **Query hygiene** — strip units, numbers, and filler before embedding | 1 h | |
| 2e | **Result dedup** on near-identical titles from repeated imports | 1 h | |

**FTS5 is the right lexical choice specifically because of the incremental requirement.**
Verified behavior: inserting a row updates the inverted index in place, and `bm25()` recomputes IDF
from the current table on every query — the same property Qdrant provides with `Modifier.IDF`.
The obvious alternative, `rank_bm25`'s `BM25Okapi`, builds a corpus object **in process**, so every
single insert forces a full rebuild. Same for `sklearn`'s `TfidfVectorizer`, whose vocabulary is
fitted once and cannot see new words. Those two libraries are the default suggestions for "add BM25"
and both of them quietly break the requirement.

**Incremental impact:** fully preserved. One extra `INSERT INTO recipes_fts` inside
`db.create_recipe`, one `DELETE` inside `db.delete_recipe`.

**Gate:** metrics beat Stage 1; `"aglio e olio"`-style exact-name queries improve; latency unchanged.

---

### Stage 3 — Reranking *(one model dependency, no infrastructure)*

The strongest single precision lever available, and structurally the cheapest to reason about,
because **a reranker holds no index state at all**.

| # | Upgrade | Cost | Notes |
|---|---|---|---|
| 3a | **Cross-encoder rerank** — `ms-marco-MiniLM-L-6-v2` over the fused top-30 → top-k | 4 h | ~50–150 ms on CPU for 30 candidates |
| 3b | **Warm the model at startup**, not lazily | 30 min | Otherwise the first voice search eats an ~80 MB load |
| 3c | **Two separately calibrated thresholds** | 2 h | The cross-encoder emits **unbounded logits** (roughly −11…+11), not cosine similarities. Threshold on `sigmoid(logit)`, and never reuse the Stage 1 cosine constant. |
| 3d | **Store the embedded text alongside the vector** so reranking needs no second DB round-trip | 1 h | |
| 3e | **Candidate cap on the voice path** — rerank 15 instead of 30 if the turn budget is tight | 1 h | |

**Incremental impact: zero.** Query-time only. Adding a recipe costs nothing here, forever. This is
worth internalizing — reranking is the one major quality upgrade with *no* ingestion consequence,
which is why it is worth doing before anything infrastructural.

**Gate:** the headline number. Expect the largest single jump in nDCG here.

---

### Stage 4 — Real vector database *(infrastructure)*

This is where `retrieval-revamp-plan.md` starts. Everything in it is sound; the sequencing note
below is the only thing worth adding.

| # | Upgrade | Cost |
|---|---|---|
| 4a | **Qdrant** in Docker; named vectors (dense + sparse); payload indexes on `is_veg`, `cuisine`, `time`, `difficulty` | 1 d |
| 4b | **`vector_store.py`** — `ensure_collection` / `upsert_recipe` / `delete_recipe` / `search`, owning the hybrid Query API call and server-side RRF | 1 d |
| 4c | **Dual-write inside `db.create_recipe` / `db.delete_recipe`** — the choke point, not the endpoints | 3 h |
| 4d | **`reindex.py`** — idempotent rebuild from SQLite, with **versioned collections + alias swap** | 4 h |
| 4e | **`VECTOR_STORE=none`** escape hatch so `pytest` runs without Docker | 1 h |
| 4f | **Loud degradation** when Qdrant is down — the brute-force fallback cannot apply payload filters, and silently returning unfiltered results for "veg under 20 min" is worse than an error | 2 h |

**Sequencing note — Stage 4 is a scale and ops upgrade, not a relevance upgrade.** By the time
you arrive here, the relevance wins have already been banked in Stages 1–3. Measured against those:
the Stage 1 cached matmul answers in **0.05–0.17 ms at 15–5,000 vectors**, which is faster than a
network round-trip to a local Qdrant. Qdrant starts genuinely earning its keep above roughly
50k–100k vectors, or the moment you need multiple processes or machines sharing one index.

Two consequences worth stating plainly:

- Qdrant's `indexing_threshold` defaults to **20,000 KB of vector data**. 15 × 384-d float32 is
  ~23 KB, so at the current catalog size Qdrant will full-scan and **never build an HNSW index at
  all** — the architecture claim would be cosmetic. Either import a real catalog (see 4g) or set the
  threshold explicitly and say which you did.
- If the goal includes a credible "production retrieval system" story, Stage 4 is worth doing
  regardless of the latency math — but it should be presented as the scale/ops chapter, with
  Stages 1–3 owning the relevance numbers. That framing is both more accurate and more convincing.

| 4g | **Import a real catalog** (RecipeNLG / Food.com), normalizing `cuisine`, `is_veg`, and tags during import — one LLM call per recipe at import time | 1 d |

Do 4g **before** measuring anything at this stage; 15 recipes cannot distinguish these designs.

**Incremental impact:** preserved by design — single-point `upsert` keyed by the recipe's existing
UUID, which makes create and update the same call. This holds **only** if the sparse side uses
server-side IDF (`models.Modifier.IDF`). fastembed's `Qdrant/bm25` emits the TF half with a fixed
`avg_len`, so per-document encoding stays corpus-independent; forgetting the IDF modifier gives you
TF-only scoring that looks like it works and quietly underperforms.

---

### Stage 5 — Query understanding and personalization *(query-time intelligence)*

| # | Upgrade | Cost | Notes |
|---|---|---|---|
| 5a | **Structured filter extraction** — "veg pasta under 30 min" → `{query: "pasta", is_veg: true, max_time: 30}` | 4 h | **HTTP search path only.** See the latency note below. |
| 5b | **Conversational query rewrite** — resolve "make it vegetarian" against the previous turn | 3 h | Voice-specific; the agent's tool arg loses this context today |
| 5c | **Personalization re-ranking** — boost by the user's `cooking_history`, `favorites`, `average_rating`, `user_memories` | 1 d | The data is already collected and already ignored |
| 5d | **Multi-query expansion** — generate 2–3 paraphrases, retrieve each, fuse | 4 h | Recall gain, latency cost |
| 5e | **HyDE** — embed a hypothetical answer instead of the query | 4 h | Highest latency cost of the group; measure before keeping |
| 5f | **Negation handling** — "pasta without garlic" currently retrieves garlic pasta | 4 h | Dense embeddings are notoriously bad at this; needs a filter, not a vector |

**The latency trap in 5a.** A voice turn is already STT → LLM decides to call `search_recipes` →
tool → LLM composes the reply → TTS. Putting an LLM normalization call *inside the tool* makes that
**two serial LLM round-trips per turn** — several hundred milliseconds on Groq, considerably worse
on the local Ollama provider. It is also redundant there, because the agent already emits a cleaned
`query` argument ([tools.py:392](backend/tools.py:392)). Raw human text only ever arrives at the
typed search box ([App.tsx:304](frontend/src/App.tsx:304)). So: normalize on `/recipes/search`,
skip it for the agent tool.

**Incremental impact:** none — all query-time — **except 5c** if user preference vectors are
precomputed, which introduces a second thing to keep fresh. Compute them on read until that hurts.

---

### Stage 6 — Learned and heavyweight *(the ceiling)*

Everything here is real, and everything here breaks incremental ingestion. That is the defining
property of the stage.

| # | Upgrade | Cost | Incremental cost |
|---|---|---|---|
| 6a | **Stronger embedding model** (`bge-base-en-v1.5`, `e5-base`, `gte-base`) — 768-d, materially better than MiniLM | 4 h + re-embed | **Full re-embed** |
| 6b | **Domain fine-tuning** on `(query, cooked_recipe)` pairs mined from `cooking_history` | 3–5 d | **Full re-embed per model version** |
| 6c | **SPLADE learned sparse** in place of BM25 | 2 d | **Full re-index** |
| 6d | **Quantization / Matryoshka truncation** for memory | 1 d | **Full re-index** |
| 6e | **LLM-as-judge** eval to grow the golden set beyond hand-labeling | 1 d | none |
| 6f | **Online metrics** — search result → recipe opened → cooking completed, as the real relevance signal | 2 d | none |

6e and 6f are the two items here that are cheap, safe, and compound — they make every earlier stage
measurable against real behavior instead of hand judgments. The rest should wait until the golden
set says the ceiling has actually been hit.

---

### The ladder at a glance

| Stage | New deps | New infra | Relevance gain | Effort | Breaks incremental? |
|---|---|---|---|---|---|
| 0 Ground truth | — | — | none (enables all) | ~1 d | no |
| 1 Zero-dep wins | — | — | **High** | 1–2 d | one-time re-embed (1a) |
| 2 Lexical + fusion | — | — | Medium–High | 1 d | no |
| 3 Reranking | 1 model | — | **High** | 1 d | **never** |
| 4 Vector DB | 2 pkgs | Docker | ~none at current scale | 2–3 d | no, if IDF is server-side |
| 5 Query understanding | — | — | Medium | 1–2 d | no |
| 6 Learned models | varies | varies | Medium | 3–5 d | **yes, by definition** |

**Recommended order: 0 → 1 → 2 → 3 → 4g → 4 → 5 → 6.** Stages 1–3 are eight days of work with no
infrastructure, and they carry essentially all of the retrieval-quality gain.

---

## Part 3 — The incremental ingestion contract

The requirement: **adding one recipe must cost one recipe's worth of work, at every stage above.**

### 3.1 Where it already holds, and where it does not

The dense path is *already* incremental — every write route encodes one recipe and inserts one row.
The only non-incremental thing in the codebase today is [`seed.py`](backend/seed.py), which
`DELETE`s the whole table and re-inserts. That is correct for a seed script and wrong as a mental
model for everything else.

So this is not a feature to build. It is a **constraint that disqualifies specific design choices**,
and the disqualified choices happen to be the ones most tutorials reach for first.

### 3.2 Component-by-component

| Component | Corpus-dependent? | Cost to add one recipe |
|---|---|---|
| Dense MiniLM vector | No | 1 encode, ~6 ms (measured) |
| SQLite FTS5 entry (Stage 2) | Index yes, **IDF computed at query time** | 1 `INSERT`, sub-ms |
| Qdrant sparse BM25 TF (Stage 4) | No — fixed `avg_len` | 1 encode, ~1 ms |
| Qdrant IDF | Yes — but **server-side**, recomputed per query | free |
| Payload / metadata | No | per-recipe |
| Cross-encoder rerank (Stage 3) | No — query-time only, zero index state | never |
| Query normalization (Stage 5) | No — query-time only | never |
| In-memory matrix cache (Stage 1c) | **Yes** — must be invalidated or appended | one array append |

Total for a new recipe: **one encode plus one or two index writes — well under 50 ms**, at every
stage except 6.

### 3.3 The architectural rule

**One write choke point.** All three creation routes already converge on `db.create_recipe`; every
indexing side effect belongs *there*, never at the endpoint layer. Wiring indexing into
[main.py:228](backend/main.py:228) would cover the admin route and silently miss both import paths,
and the index would drift with no error anywhere. Same for `db.delete_recipe`. When an update
endpoint appears, it is the same upsert.

**A rebuild script that is a maintenance tool, not a write path.** `reindex.py` rebuilds any index
from SQLite — the system of record — and is idempotent. Full reingest exists, but it runs when *you*
run it, never as a consequence of adding a recipe.

**Versioned indexes plus alias swap.** When something genuinely forces a rebuild (below), build into
a *new* collection and swap the alias. Never mutate the live index in place. This turns Stage 6's
"breaks incremental ingestion" from an outage into a background job.

### 3.4 What legitimately forces a full rebuild

Short, known list — everything else must be incremental:

1. Changing the embedding model or its dimensionality *(Stage 1a's cousin, Stage 6a)*
2. Changing `build_recipe_text` — existing vectors were built from a different template *(Stage 1a)*
3. Changing BM25 parameters (`k1`, `b`, `avg_len`) — changes every stored TF vector
4. Adding a metadata field that older records lack, when a filter must be exhaustive over it
5. Drift or corruption recovery

Note that **Stage 1a is on this list**, which is the argument for doing it now: re-embedding 15
recipes takes seconds; re-embedding 50,000 takes an afternoon and an alias swap.

### 3.5 The trap list — things that silently break it

Each of these is a common suggestion for one of the upgrades above, and each one turns an O(1)
insert into an O(N) rebuild:

- **`rank_bm25` (`BM25Okapi`)** — the corpus object is built in process; every insert rebuilds it.
  Use FTS5 (Stage 2) or Qdrant's server-side IDF (Stage 4).
- **`sklearn.TfidfVectorizer`** — vocabulary is *fitted*; words in new recipes fall out of vocab
  until you refit everything.
- **FAISS IVF / any centroid-based index** — centroids are trained on a sample and drift as the
  corpus grows. HNSW is insert-friendly; IVF is not.
- **Corpus-level score normalization** (z-scoring against corpus mean/std) — every insert shifts
  every score. RRF avoids this entirely by fusing *ranks*, not scores.
- **Precomputed "similar recipes" neighbor graphs** — stale for every existing recipe the moment a
  new one is added, unless explicitly invalidated.
- **The golden set itself** (Stage 0e) — not an index, but it staleifies on insert the same way, and
  it is the one people never think of.

### 3.6 Verification checklist

- `POST /recipes` → index count +1, no reindex run, and the new recipe is findable by a query that
  matches only it
- Same, via `/recipes/import`
- Same, via the agent's `import_recipe_from_url` over the WebSocket — this is the path a
  main.py-level dual-write would miss
- `DELETE /recipes/{id}` → index count −1, recipe no longer returned
- `python reindex.py` → index count == recipe row count, and metrics are unchanged afterward
  (proving the incremental path and the rebuild path agree)
- `pytest` green with no vector store running

---

## Appendix — Measurement reference

Brute-force `search_recipes` vs. a cached normalized `float32` matrix, same machine, 384-d vectors:

| Recipes | Current loop | Cached matmul | Speedup | Vector storage as JSON |
|---:|---:|---:|---:|---:|
| 15 | 1.3 ms | 0.05 ms | 28× | 0.1 MB |
| 100 | 8.2 ms | 0.03 ms | 268× | 0.8 MB |
| 1,000 | 85 ms | 0.07 ms | 1151× | 7.9 MB |
| 5,000 | 418 ms | 0.17 ms | 2436× | 39.6 MB |
| 20,000 | 1.78 s | 0.56 ms | 3177× | 158 MB |

Single 384-d vector: **7924 bytes as JSON text vs 1536 as float32** (5.2×); parsing is **328×**
slower (`json.loads` 76 µs vs `np.frombuffer` 0.23 µs).

Query encode latency: **~6 ms** warm (87 ms on the first call).
