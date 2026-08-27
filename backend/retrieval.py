"""
The recipe search pipeline.

    query
      -> hygiene + synonym expansion
      -> dense (MiniLM, cached matrix)  +  lexical (SQLite FTS5 BM25)
      -> RRF fusion
      -> metadata pre-filter          <- BEFORE top-k, never after
      -> score threshold
      -> top-k

Every caller — the HTTP search endpoint and the voice agent's search tool — goes through
`search()`. `database.search_recipes` remains as a dependency-free brute-force fallback.

Two design notes worth keeping in mind
--------------------------------------
*Pre-filtering, not post-filtering.* Asking "of these 6 results, which are vegetarian?" is a
different question from "of the vegetarian recipes, which 6 are best?". The first collapses a
page of results down to one or two; the second cannot. Filters are applied as a mask over the
candidate set before top-k is taken.

*The matrix cache.* The whole embedding matrix lives in memory as one normalized float32 array
and is rebuilt only when `database.index_version()` changes. That turns the per-query cost from
"parse and normalize N JSON vectors" into a single matmul — roughly 1000x at a thousand
recipes. Writes bump the version from inside `database.create_recipe`, so no caller has to
remember to invalidate anything.
"""

import os
import re
import threading
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Optional

import numpy as np

import database as db

# --------------------------------------------------------------------------- #
# Tuning knobs
# --------------------------------------------------------------------------- #

# Relevance floors — what lets search return nothing instead of six confident-looking wrong
# answers. Calibrated against the golden set; see eval/golden.json for the probes.
#
# Two floors, because one is not enough. The dense score distributions of vague-but-genuine
# queries and of nonsense OVERLAP: "something comforting and cheesy" tops out at 0.182 while
# "book a flight to tokyo" reaches 0.168. An absolute cosine floor alone therefore has only a
# ~0.015 margin to work with, which is not a margin worth trusting.
#
# The lexical side supplies a second, independent signal: every nonsense probe in the golden
# set produces ZERO FTS5 matches, because noise shares no vocabulary with a recipe catalog. So
# a result qualifies either by clearing the dense floor on its own, or by clearing a lower
# floor while a keyword match corroborates it.
#
# A z-score against the query's own score distribution was tried and rejected: it separates the
# wrong way round. Nonsense produces one accidental outlier above a flat field (z up to 2.5),
# while a genuine query has several near-tied relevant recipes and so a LOWER peak z (1.25).
#
# This is the weakest link in the pipeline. A cross-encoder (stage 3) fixes it properly by
# scoring the query and document together instead of comparing two vectors encoded apart.
MIN_DENSE_SCORE = float(os.getenv("SEARCH_MIN_SCORE", "0.18"))
MIN_CORROBORATED_SCORE = float(os.getenv("SEARCH_MIN_CORROBORATED_SCORE", "0.12"))

# Fusion depth: how many candidates each retriever contributes before fusion. Wider than the
# final k so a result the dense side ranks 12th can still be rescued by the lexical side.
CANDIDATE_DEPTH = int(os.getenv("SEARCH_CANDIDATE_DEPTH", "30"))

# RRF's smoothing constant. 60 is the value from the original Cormack et al. paper and is not
# worth tuning before there is enough evaluation data to tune it against.
RRF_K = 60

DEFAULT_LIMIT = 6

# Words that carry no retrieval signal in a recipe catalog. Stripped from the LEXICAL query
# only — the dense encoder handles natural phrasing better with them left in.
_STOPWORDS = {
    "a", "about", "an", "and", "any", "are", "as", "at", "be", "best", "by", "can", "cook",
    "cooked", "cooking", "could", "dish", "dishes", "do", "eat", "find", "for", "from", "get",
    "give", "good", "got", "have", "how", "i", "id", "in", "into", "is", "it", "like", "made",
    "make", "me", "meal", "my", "need", "nice", "of", "on", "or", "please", "really", "recipe",
    "recipes", "show", "some", "something", "that", "the", "their", "them", "there", "these",
    "they", "this", "to", "using", "very", "want", "was", "what", "which", "will", "with",
    "would", "you", "your",
}

# Terms at least this long also match as a prefix (FTS5 `term*`). Without it the stemmer treats
# "india" and "Indian" as unrelated, so the most informative word in "something creamy and
# spicy from india" contributes nothing to BM25. Short terms are excluded because a 3-letter
# prefix matches far too much.
_PREFIX_MIN_LEN = 4

# Hand-written aliases for terms the dense encoder reliably misses: regional ingredient names,
# and dish names whose tokens carry no meaning to a model trained on general English.
_SYNONYMS = {
    "aglio": "garlic",
    "olio": "oil",
    "capsicum": "bell pepper",
    "brinjal": "eggplant aubergine",
    "aubergine": "eggplant",
    "coriander": "cilantro",
    "curd": "yogurt",
    "besan": "chickpea flour",
    "atta": "wheat flour",
    "maida": "flour",
    "paneer": "paneer cottage cheese",
    "chana": "chickpeas",
    "aloo": "potato",
    "gobi": "cauliflower",
    "veg": "vegetarian",
    "nonveg": "meat chicken fish",
    "starter": "appetizer snack",
    "sweet": "dessert",
    "sweets": "dessert",
    "tiffin": "breakfast snack",
}


@dataclass
class Filters:
    """Metadata constraints applied before ranking. Every field is optional."""
    is_veg: Optional[bool] = None
    category: Optional[str] = None
    cuisine: Optional[str] = None
    difficulty: Optional[str] = None
    max_time: Optional[int] = None
    dietary: Optional[list[str]] = None

    def active(self) -> bool:
        return any(
            value is not None
            for value in (self.is_veg, self.category, self.cuisine,
                          self.difficulty, self.max_time, self.dietary)
        )

    def matches(self, recipe: dict) -> bool:
        if self.is_veg is not None and bool(recipe.get("is_veg")) != self.is_veg:
            return False
        if self.category and (recipe.get("category") or "").lower() != self.category.lower():
            return False
        if self.cuisine and (recipe.get("cuisine") or "").lower() != self.cuisine.lower():
            return False
        if self.difficulty and (recipe.get("difficulty") or "").lower() != self.difficulty.lower():
            return False
        if self.max_time is not None and int(recipe.get("time") or 0) > self.max_time:
            return False
        if self.dietary:
            tags = {tag.lower() for tag in recipe.get("dietary") or []}
            if not {want.lower() for want in self.dietary} <= tags:
                return False
        return True


# --------------------------------------------------------------------------- #
# The embedding model, shared with the API process
# --------------------------------------------------------------------------- #

_model: Any = None
_model_lock = threading.Lock()


def set_model(model: Any) -> None:
    """Hand retrieval the already-loaded SentenceTransformer instead of loading a second copy."""
    global _model
    _model = model


def get_model() -> Any:
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from sentence_transformers import SentenceTransformer
                _model = SentenceTransformer("all-MiniLM-L6-v2")
    return _model


@lru_cache(maxsize=512)
def _encode_cached(query: str) -> tuple[float, ...]:
    """Encode a query, memoized. The search box debounces but still repeats queries often."""
    vector = np.asarray(get_model().encode(query), dtype=np.float32)
    vector /= np.linalg.norm(vector) + 1e-9
    return tuple(float(x) for x in vector)


def encode_query(query: str) -> np.ndarray:
    return np.asarray(_encode_cached(query), dtype=np.float32)


# --------------------------------------------------------------------------- #
# The matrix cache
# --------------------------------------------------------------------------- #

_cache_lock = threading.Lock()
_cached_version: Optional[int] = None
_cached_recipes: list[dict] = []
_cached_matrix: np.ndarray = np.zeros((0, db.VECTOR_DIM), dtype=np.float32)


def _corpus() -> tuple[list[dict], np.ndarray]:
    """Recipes and their normalized vectors, rebuilt only when the catalog changes."""
    global _cached_version, _cached_recipes, _cached_matrix
    version = db.index_version()
    if _cached_version != version:
        with _cache_lock:
            if _cached_version != version:
                _cached_recipes, _cached_matrix = db.load_recipe_vectors()
                _cached_version = version
    return _cached_recipes, _cached_matrix


def invalidate_cache() -> None:
    """Force a rebuild on the next search. Only needed when rows are written outside database.py."""
    global _cached_version
    _cached_version = None
    _encode_cached.cache_clear()


def warm() -> None:
    """Load the model and build the matrix up front so the first real search is not the slow one."""
    get_model()
    _corpus()


# --------------------------------------------------------------------------- #
# Query processing
# --------------------------------------------------------------------------- #

def normalize_query(query: str) -> str:
    return re.sub(r"\s+", " ", (query or "").strip())


def lexical_query(query: str) -> str:
    """Turn a natural-language query into an FTS5 MATCH expression.

    Punctuation is stripped rather than escaped (FTS5 treats bare quotes and hyphens as
    syntax), stopwords are dropped, aliases are expanded, and the surviving terms are OR-ed so
    a query only has to match on something rather than everything.
    """
    tokens = re.findall(r"[a-z0-9]+", (query or "").lower())
    terms: list[str] = []
    for token in tokens:
        if token in _STOPWORDS or len(token) < 2:
            continue
        terms.append(token)
        expansion = _SYNONYMS.get(token)
        if expansion:
            terms.extend(expansion.split())
    # Preserve order, drop repeats.
    seen, unique = set(), []
    for term in terms:
        if term not in seen:
            seen.add(term)
            # Longer terms match as a prefix so "india" reaches "Indian" and a half-typed word
            # still retrieves. Digits are left alone — "20*" would match 200 and 2000.
            unique.append(f"{term}*" if len(term) >= _PREFIX_MIN_LEN and term.isalpha() else term)
    return " OR ".join(unique)


# --------------------------------------------------------------------------- #
# Retrieval
# --------------------------------------------------------------------------- #

def _dense_candidates(query: str, depth: int) -> list[tuple[str, float]]:
    recipes, matrix = _corpus()
    if not recipes:
        return []
    scores = matrix @ encode_query(query)
    depth = min(depth, len(recipes))
    top = np.argpartition(-scores, depth - 1)[:depth]
    top = top[np.argsort(-scores[top])]
    return [(recipes[i]["id"], float(scores[i])) for i in top]


def _rrf(rankings: list[list[tuple[str, float]]], weights: Optional[list[float]] = None) -> dict[str, float]:
    """Reciprocal Rank Fusion.

    Fuses on RANK, not score, which is the whole point: dense cosine (roughly 0-1) and BM25
    (unbounded, corpus-dependent) live on incomparable scales, and normalizing them against
    corpus statistics would make every score shift whenever a recipe is added. Ranks are
    immune to both problems.
    """
    weights = weights or [1.0] * len(rankings)
    fused: dict[str, float] = {}
    for ranking, weight in zip(rankings, weights):
        for position, (recipe_id, _score) in enumerate(ranking, start=1):
            fused[recipe_id] = fused.get(recipe_id, 0.0) + weight / (RRF_K + position)
    return fused


def search(
    query: str,
    limit: int = DEFAULT_LIMIT,
    mode: str = "hybrid",
    filters: Optional[Filters] = None,
    min_score: Optional[float] = None,
    debug: bool = False,
) -> list[dict]:
    """Rank recipes for a query. Returns [] when nothing clears the relevance floor.

    `mode` is "hybrid" (dense + BM25 fused) or "dense" (dense only); the dense path is kept
    addressable so the evaluation harness can measure what fusion is actually worth.
    """
    query = normalize_query(query)
    if not query:
        return []

    filters = filters or Filters()
    floor = MIN_DENSE_SCORE if min_score is None else min_score

    recipes, _matrix = _corpus()
    if not recipes:
        return []
    by_id = {recipe["id"]: recipe for recipe in recipes}

    dense = _dense_candidates(query, CANDIDATE_DEPTH)
    dense_scores = dict(dense)

    lexical: list[tuple[str, float]] = []
    if mode == "hybrid":
        lexical = db.search_recipes_lexical(lexical_query(query), CANDIDATE_DEPTH)
        # Rows can exist in the FTS index that are not in the vector corpus (a recipe whose
        # embedding failed to write). Ranking something we cannot describe is worse than
        # dropping it.
        lexical = [(rid, score) for rid, score in lexical if rid in by_id]

    lexical_scores = dict(lexical)

    if mode == "hybrid" and lexical:
        fused = _rrf([dense, lexical])
    else:
        # Dense-only: rank by cosine directly. Passing a single list through RRF would discard
        # the score magnitudes the threshold depends on.
        fused = {recipe_id: score for recipe_id, score in dense}

    # The relevance floor is always applied on the DENSE cosine score, never on the fused RRF
    # value: RRF numbers are ~1/60 by construction and carry no notion of "how similar", so
    # they cannot answer "is this good enough to show at all".
    candidates = []
    for recipe_id, fused_score in fused.items():
        dense_score = dense_scores.get(recipe_id, 0.0)
        lexical_score = lexical_scores.get(recipe_id)
        # Qualify on the dense score alone, or on a lower floor when a keyword match
        # corroborates it. See the floor constants for why one threshold is not enough.
        qualifies = dense_score >= floor or (
            lexical_score is not None and dense_score >= MIN_CORROBORATED_SCORE
        )
        if not qualifies:
            continue
        recipe = by_id[recipe_id]
        if not filters.matches(recipe):
            continue
        candidates.append((recipe_id, fused_score, dense_score, lexical_score))

    # Ties on the primary score fall back to the catalog's own quality signal rather than to
    # whatever order the dict happened to produce.
    candidates.sort(
        key=lambda row: (
            round(row[1], 6),
            by_id[row[0]].get("average_rating") or 0.0,
            by_id[row[0]].get("rating_count") or 0,
        ),
        reverse=True,
    )

    results = []
    for recipe_id, fused_score, dense_score, lexical_score in candidates[:limit]:
        # `similarity` stays the response's ranking score — the frontend and the agent tool
        # both read it — and remains on the cosine scale so it is comparable across modes.
        result = {**by_id[recipe_id], "similarity": dense_score}
        if debug:
            result["debug_scores"] = {
                "dense": dense_score,
                "lexical_bm25": lexical_score,
                "rrf": fused_score,
                "mode": mode,
            }
        results.append(result)
    return results
