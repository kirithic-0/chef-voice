"""
Retrieval evaluation harness for ChefVoice.

Runs the golden set (`golden.json`) through one or more named retrieval configurations and
prints Recall@k / MRR / nDCG@k / noise rejection / latency, one row per configuration. This is
the "before" number that every retrieval change is measured against.

    python eval/evaluate.py                       # every registered config
    python eval/evaluate.py --config baseline     # just one
    python eval/evaluate.py --save baseline.json  # write results for later comparison
    python eval/evaluate.py --compare baseline.json

Scoring notes
-------------
* Judgments are graded (2 = clearly meant, 1 = acceptable). Recall and MRR treat both as
  relevant; nDCG uses the grades as gains.
* Noise probes (empty `relevant`) are scored separately as "noise rejection" — the fraction of
  nonsense queries that correctly return zero results. Folding them into Recall would be
  meaningless (recall of an empty set is undefined) and would hide the behaviour that matters.
* Latency excludes the first (cold) call per config so model warm-up does not dominate.
"""

import argparse
import json
import math
import os
import statistics
import sys
import time
from pathlib import Path

# Import the backend package from the parent directory when run as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import database as db  # noqa: E402

GOLDEN_FILE = Path(__file__).parent / "golden.json"
K_VALUES = (1, 3, 5)
NDCG_K = 5


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #

def recall_at_k(ranked_ids: list[str], relevant_ids: set[str], k: int) -> float:
    if not relevant_ids:
        return 0.0
    hits = len(set(ranked_ids[:k]) & relevant_ids)
    # Cap the denominator at k: a query with 5 relevant recipes cannot score 1.0 at k=3.
    return hits / min(len(relevant_ids), k)


def precision_at_k(ranked_ids: list[str], relevant_ids: set[str], k: int) -> float:
    """Fraction of the top-k that is relevant, measured against what was actually returned.

    Unlike recall, this penalises padding a short answer with junk. It is the metric that a
    catalog-floods-in-behind-the-real-match failure shows up in — the one a
    recall/MRR/nDCG-only harness is blind to, which is how a 0.26-precision pipeline once
    looked healthy on every number reported. Denominator is min(k, results returned), so a
    query that correctly returns two good answers scores 1.0 rather than being punished for not
    filling k slots.
    """
    if not relevant_ids:
        return 0.0
    topk = ranked_ids[:k]
    if not topk:
        return 0.0
    return len(set(topk) & relevant_ids) / len(topk)


def reciprocal_rank(ranked_ids: list[str], relevant_ids: set[str]) -> float:
    for position, recipe_id in enumerate(ranked_ids, start=1):
        if recipe_id in relevant_ids:
            return 1.0 / position
    return 0.0


def ndcg_at_k(ranked_ids: list[str], grades: dict[str, int], k: int) -> float:
    if not grades:
        return 0.0
    dcg = sum(
        grades.get(recipe_id, 0) / math.log2(position + 1)
        for position, recipe_id in enumerate(ranked_ids[:k], start=1)
    )
    ideal = sum(
        grade / math.log2(position + 1)
        for position, grade in enumerate(sorted(grades.values(), reverse=True)[:k], start=1)
    )
    return dcg / ideal if ideal else 0.0


# --------------------------------------------------------------------------- #
# Retrieval configurations
#
# Each config is a callable (query: str) -> list[recipe dict]. Registering a new pipeline here
# is all it takes to add a column to the comparison.
# --------------------------------------------------------------------------- #

CONFIGS: dict[str, dict] = {}


def register(name: str, description: str):
    def wrap(fn):
        CONFIGS[name] = {"fn": fn, "description": description}
        return fn
    return wrap


def _encoder():
    """Load the shared sentence-transformer once, lazily."""
    global _MODEL
    try:
        return _MODEL
    except NameError:
        pass
    from sentence_transformers import SentenceTransformer
    _MODEL = SentenceTransformer("all-MiniLM-L6-v2")
    return _MODEL


@register("baseline", "dense-only brute-force cosine over JSON embeddings, fixed top-6, no threshold")
def config_baseline(query: str) -> list[dict]:
    """The pipeline as it existed before the retrieval work — the 'before' number.

    Deliberately calls db.search_recipes directly rather than going through retrieval.py, so
    this row keeps measuring the original behaviour even as the pipeline moves on.
    """
    embedding = _encoder().encode(query).tolist()
    return db.search_recipes(embedding, match_count=6)


@register("dense", "stage 1 — richer document text, cached matrix, score threshold")
def config_dense(query: str) -> list[dict]:
    import retrieval
    return retrieval.search(query, limit=6, mode="dense")


@register("hybrid", "stage 2 — dense + FTS5 BM25 fused with RRF")
def config_hybrid(query: str) -> list[dict]:
    import retrieval
    return retrieval.search(query, limit=6, mode="hybrid")


# --------------------------------------------------------------------------- #
# Runner
# --------------------------------------------------------------------------- #

def load_golden() -> dict:
    with open(GOLDEN_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def build_title_index() -> dict[str, str]:
    """Map recipe title -> id so judgments can be written against stable titles."""
    return {r["title"]: r["id"] for r in db.list_recipes()}


def resolve_judgments(golden: dict, title_to_id: dict[str, str]) -> tuple[list[dict], list[str]]:
    """Turn title-keyed judgments into id-keyed ones. Returns (queries, missing_titles)."""
    resolved, missing = [], []
    for entry in golden["queries"]:
        grades = {}
        for title, grade in entry["relevant"].items():
            recipe_id = title_to_id.get(title)
            if recipe_id is None:
                missing.append(f"{entry['id']}: {title}")
                continue
            grades[recipe_id] = grade
        resolved.append({**entry, "grades": grades})
    return resolved, missing


def run_config(name: str, queries: list[dict]) -> dict:
    fn = CONFIGS[name]["fn"]

    # Clear the query-embedding cache between configs. Without this the second config scores
    # every query as a cache hit and reports a latency that no real user would ever see.
    try:
        import retrieval
        retrieval._encode_cached.cache_clear()
    except ImportError:
        pass

    # Warm-up call, excluded from the latency sample.
    fn("warm up the model and any caches")

    scored, noise_correct, noise_total, latencies = [], 0, 0, []
    failures = []

    for entry in queries:
        start = time.perf_counter()
        results = fn(entry["query"])
        latencies.append((time.perf_counter() - start) * 1000)

        ranked_ids = [r["id"] for r in results]

        if not entry["grades"]:
            noise_total += 1
            if not ranked_ids:
                noise_correct += 1
            else:
                failures.append(
                    f"  noise {entry['id']} {entry['query']!r} returned {len(ranked_ids)} "
                    f"(top: {results[0]['title']} @ {results[0].get('similarity', 0):.3f})"
                )
            continue

        relevant = set(entry["grades"])
        row = {
            "id": entry["id"],
            "mrr": reciprocal_rank(ranked_ids, relevant),
            "ndcg": ndcg_at_k(ranked_ids, entry["grades"], NDCG_K),
            "precision@5": precision_at_k(ranked_ids, relevant, 5),
            "results_returned": len(ranked_ids),
        }
        for k in K_VALUES:
            row[f"recall@{k}"] = recall_at_k(ranked_ids, relevant, k)
        scored.append(row)

        if row["recall@5"] == 0.0:
            top = results[0]["title"] if results else "(empty)"
            failures.append(f"  miss  {entry['id']} {entry['query']!r} -> top was {top!r}")

    def mean(key: str) -> float:
        return statistics.mean(r[key] for r in scored) if scored else 0.0

    ordered = sorted(latencies)
    return {
        "config": name,
        "description": CONFIGS[name]["description"],
        "queries_scored": len(scored),
        "mrr": mean("mrr"),
        f"ndcg@{NDCG_K}": mean("ndcg"),
        "precision@5": mean("precision@5"),
        "avg_results": mean("results_returned"),
        **{f"recall@{k}": mean(f"recall@{k}") for k in K_VALUES},
        "noise_rejection": (noise_correct / noise_total) if noise_total else 0.0,
        "noise_correct": noise_correct,
        "noise_total": noise_total,
        "latency_p50_ms": ordered[len(ordered) // 2] if ordered else 0.0,
        "latency_p95_ms": ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))] if ordered else 0.0,
        "failures": failures,
    }


METRIC_COLUMNS = ["recall@3", "recall@5", "precision@5", "mrr", f"ndcg@{NDCG_K}", "noise_rejection"]


def print_table(rows: list[dict], baseline: dict | None = None) -> None:
    header = f"{'config':<12}" + "".join(f"{c:>16}" for c in METRIC_COLUMNS) + f"{'p50 ms':>10}{'p95 ms':>10}"
    print("\n" + header)
    print("-" * len(header))
    for row in rows:
        line = f"{row['config']:<12}"
        for column in METRIC_COLUMNS:
            value = row[column]
            cell = f"{value:.3f}"
            if baseline and row["config"] != baseline["config"]:
                delta = value - baseline[column]
                if abs(delta) >= 0.0005:
                    cell += f" ({delta:+.3f})"
            line += f"{cell:>16}"
        line += f"{row['latency_p50_ms']:>10.1f}{row['latency_p95_ms']:>10.1f}"
        print(line)
    print()
    for row in rows:
        print(f"{row['config']:<12} {row['description']}")
        print(
            f"{'':12} noise rejected {row['noise_correct']}/{row['noise_total']}"
            f" · {row['queries_scored']} judged queries"
            f" · avg {row['avg_results']:.1f} results/query"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate ChefVoice retrieval configurations.")
    parser.add_argument("--config", action="append", help="config name (repeatable); default: all")
    parser.add_argument("--save", help="write results to this JSON file")
    parser.add_argument("--compare", help="read a saved results file and show deltas against it")
    parser.add_argument("--failures", action="store_true", help="list every miss and noise leak")
    args = parser.parse_args()

    db.init_db()
    golden = load_golden()
    title_to_id = build_title_index()
    queries, missing = resolve_judgments(golden, title_to_id)

    print(f"catalog: {len(title_to_id)} recipes · golden set: {len(queries)} queries")
    if missing:
        print("\nWARNING — judgments reference titles that are not in the catalog:")
        for item in missing:
            print(f"  {item}")
        print("  The golden set is stale relative to the catalog. Re-judge before trusting these numbers.\n")

    names = args.config or list(CONFIGS)
    for name in names:
        if name not in CONFIGS:
            parser.error(f"unknown config {name!r}. Known: {', '.join(CONFIGS)}")

    rows = []
    for name in names:
        print(f"running {name} ...", flush=True)
        rows.append(run_config(name, queries))

    baseline = None
    if args.compare:
        with open(args.compare, "r", encoding="utf-8") as f:
            saved = json.load(f)
        baseline = saved["rows"][0]
        print(f"\ncomparing against {args.compare} (config {baseline['config']!r})")
    elif len(rows) > 1:
        baseline = rows[0]

    print_table(rows, baseline)

    if args.failures:
        for row in rows:
            if row["failures"]:
                print(f"\n{row['config']} — {len(row['failures'])} issues:")
                for line in row["failures"]:
                    print(line)

    if args.save:
        out = Path(args.save)
        if not out.is_absolute():
            out = Path(__file__).parent / out
        payload = {
            "catalog_size": len(title_to_id),
            "catalog_snapshot": golden.get("catalog_snapshot"),
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "rows": rows,
        }
        with open(out, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        print(f"\nsaved -> {out}")


if __name__ == "__main__":
    main()
