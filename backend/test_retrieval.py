"""
Retrieval pipeline tests.

The behaviours locked in here are the ones that were broken before the retrieval work and that
regress silently if they break again: nothing raises, the wrong recipes just quietly come back.

Runs against an isolated database — never the developer's chefvoice.db.
"""

import os
import tempfile

# conftest.py already set this before any test module was imported; repeating it here keeps
# the file runnable on its own. setdefault, not assignment — conftest wins when both apply.
os.environ.setdefault("CHEFVOICE_DB", os.path.join(tempfile.gettempdir(), "chefvoice_test.db"))
os.environ.setdefault("JWT_SECRET", "test-secret-key-for-chefvoice-tests-0123456789")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import database as db  # noqa: E402
import main  # noqa: E402
import retrieval  # noqa: E402
from main import app, get_current_user  # noqa: E402

TEST_USER = {"id": "00000000-0000-0000-0000-000000000000", "username": "tester"}
app.dependency_overrides[get_current_user] = lambda: TEST_USER
client = TestClient(app)


SAMPLES = [
    {
        "title": "Classic Butter Chicken", "cuisine": "Indian", "time": 40,
        "difficulty": "Medium", "servings": 4, "dietary": ["Gluten-free"], "image_url": None,
        "ingredients": [{"name": "Chicken thighs", "amount": "800", "unit": "g"},
                        {"name": "Garam masala", "amount": "2", "unit": "tsp"}],
        "steps": [{"step": 1, "text": "Simmer the chicken in a creamy tomato gravy.",
                   "timer_duration": None, "safety_alert": None}],
    },
    {
        "title": "Spaghetti Aglio e Olio", "cuisine": "Italian", "time": 20,
        "difficulty": "Easy", "servings": 2, "dietary": ["Veg", "Vegan"], "image_url": None,
        "ingredients": [{"name": "Spaghetti", "amount": "200", "unit": "g"},
                        {"name": "Garlic", "amount": "6", "unit": "cloves"}],
        "steps": [{"step": 1, "text": "Fry sliced garlic in olive oil until golden.",
                   "timer_duration": None, "safety_alert": None}],
    },
    {
        "title": "Mango Sticky Rice", "cuisine": "Thai", "time": 45,
        "difficulty": "Medium", "servings": 4,
        "dietary": ["Veg", "Vegan", "Gluten-free"], "image_url": None,
        "ingredients": [{"name": "Glutinous rice", "amount": "200", "unit": "g"},
                        {"name": "Coconut milk", "amount": "200", "unit": "ml"}],
        "steps": [{"step": 1, "text": "Steam the soaked rice, then fold through sweet coconut milk.",
                   "timer_duration": 1200, "safety_alert": None}],
    },
]


def _catalogue_counts() -> tuple[int, int]:
    conn = db.get_conn()
    with db._lock:
        rows = conn.execute("SELECT COUNT(*) AS n FROM recipes").fetchone()["n"]
        fts = conn.execute("SELECT COUNT(*) AS n FROM recipes_fts").fetchone()["n"]
    return rows, fts


@pytest.fixture(scope="module", autouse=True)
def catalogue():
    # This fixture clears the recipes table. Prove we are pointed at the scratch database
    # first — DB_PATH is bound at import time, so a change in module import order is all it
    # takes for "clear the table" to mean the developer's real catalogue.
    from conftest import assert_test_database
    assert_test_database(db)

    conn = db.get_conn()
    with db._lock:
        conn.execute("DELETE FROM recipes")
        conn.execute("DELETE FROM recipes_fts")
        conn.commit()
    db.bump_index_version()

    for recipe in SAMPLES:
        embedding = main.embedding_model.encode(db.build_recipe_text(recipe)).tolist()
        db.create_recipe(recipe, embedding)
    retrieval.set_model(main.embedding_model)
    yield


# --------------------------------------------------------------------------- #
# Document template
# --------------------------------------------------------------------------- #

def test_document_includes_the_fields_people_search_by():
    """The old template embedded only title/cuisine/difficulty/ingredients — about 15% of a
    recipe — so "gluten free" and "under 20 minutes" were invisible to retrieval."""
    text = db.build_recipe_text(SAMPLES[2])
    assert "Mango Sticky Rice" in text
    assert "45 minutes" in text            # time
    assert "Gluten-free" in text           # dietary
    assert "vegetarian" in text            # derived veg flag
    assert "coconut milk" in text.lower()  # ingredients
    assert "steam" in text.lower()         # method


def test_import_path_uses_the_shared_template():
    """tools.py used to assemble its own copy of the document template. Two templates means
    imported recipes land in a different region of the vector space than seeded ones."""
    import inspect
    import tools
    source = inspect.getsource(tools.tool_import_recipe_from_url)
    assert "db.build_recipe_text" in source
    assert "f\"Title: {recipe_data" not in source


# --------------------------------------------------------------------------- #
# Relevance floor
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("query", [
    "quantum blockchain algebra",
    "javascript async await tutorial",
    "book a flight to tokyo",
])
def test_nonsense_returns_nothing(query):
    """Previously every one of these returned a full page of confident-looking recipes, which
    the voice agent then read aloud as genuine suggestions."""
    assert retrieval.search(query, limit=6) == []


def test_real_query_still_returns_results():
    results = retrieval.search("creamy indian chicken curry", limit=6)
    assert results
    assert results[0]["title"] == "Classic Butter Chicken"


# --------------------------------------------------------------------------- #
# Pre-filtering
# --------------------------------------------------------------------------- #

def test_filters_are_applied_before_top_k():
    """The veg filter used to run in the browser over a fixed six results, which collapsed a
    page down to one or two. Filtering the candidate set instead keeps the page full."""
    veg = retrieval.search("dinner", limit=10, filters=retrieval.Filters(is_veg=True))
    assert veg and all(r["is_veg"] for r in veg)

    non_veg = retrieval.search("dinner", limit=10, filters=retrieval.Filters(is_veg=False))
    assert non_veg and not any(r["is_veg"] for r in non_veg)


def test_max_time_filter():
    quick = retrieval.search("food", limit=10, filters=retrieval.Filters(max_time=20))
    assert quick and all(r["time"] <= 20 for r in quick)


def test_search_endpoint_accepts_filters():
    response = client.get("/recipes/search", params={"query": "pasta", "is_veg": True})
    assert response.status_code == 200
    assert all(r["is_veg"] for r in response.json())


def test_dietary_filter_requires_every_tag():
    """"gluten free dessert" ranked a non-gluten-free recipe first because dietary tags were
    invisible to retrieval. Multiple tags are AND, not OR."""
    gf = client.get("/recipes/search", params={"query": "dessert", "dietary": "Gluten-free"}).json()
    assert gf and all("Gluten-free" in r["dietary"] for r in gf)

    both = client.get("/recipes/search", params={"query": "food", "dietary": "Vegan,Gluten-free"}).json()
    assert both and all(
        "Vegan" in r["dietary"] and "Gluten-free" in r["dietary"] for r in both
    )


def test_search_response_still_carries_similarity():
    """The frontend and the agent tool both read `similarity`; renaming it would break both."""
    response = client.get("/recipes/search", params={"query": "garlic pasta"})
    assert response.status_code == 200
    results = response.json()
    assert results and "similarity" in results[0] and results[0]["similarity"] > 0


def test_debug_scores_are_opt_in():
    plain = client.get("/recipes/search", params={"query": "garlic pasta"}).json()
    assert "debug_scores" not in plain[0]
    debugged = client.get("/recipes/search", params={"query": "garlic pasta", "debug": True}).json()
    assert set(debugged[0]["debug_scores"]) == {"dense", "lexical_bm25", "rrf", "mode"}


# --------------------------------------------------------------------------- #
# Lexical half
# --------------------------------------------------------------------------- #

def test_lexical_query_drops_stopwords_and_expands_aliases():
    match = retrieval.lexical_query("what can I make with aglio e olio")
    assert "what" not in match and "make" not in match
    assert "garlic" in match and "oil" in match


def test_longer_terms_match_as_a_prefix():
    """The Porter stemmer does not unify "india" and "Indian", so the most informative word in
    "something creamy and spicy from india" contributed nothing to BM25 until terms matched as
    prefixes. Short terms stay exact — a 3-letter prefix matches far too much."""
    assert retrieval.lexical_query("india") == "india*"
    assert db.search_recipes_lexical("india*", 5), "prefix should reach 'Indian'"
    assert db.search_recipes_lexical("india", 5) == [], "exact term should still miss"

    # Digits are left alone: "20*" would also match 200 and 2000.
    assert retrieval.lexical_query("ready in 2025") == "ready* OR 2025"


def test_filler_words_do_not_reach_the_index():
    """"from" leaked through the stopword list and pulled in unrelated documents."""
    match = retrieval.lexical_query("something creamy and spicy from india")
    assert "from" not in match
    assert match == "creamy* OR spicy* OR india*"


def test_lexical_index_survives_a_malformed_query():
    """User text reaches FTS5 directly; an unbalanced quote raises rather than returning []."""
    assert db.search_recipes_lexical('unbalanced " quote', 5) == []


def test_hybrid_finds_an_exact_name_dense_alone_ranks_lower():
    results = retrieval.search("aglio e olio", limit=3, mode="hybrid")
    assert results and results[0]["title"] == "Spaghetti Aglio e Olio"


# --------------------------------------------------------------------------- #
# Incremental ingestion — the property the whole design is built around
# --------------------------------------------------------------------------- #

def test_adding_one_recipe_indexes_only_that_recipe():
    rows_before, fts_before = _catalogue_counts()
    query = "smoky chipotle black bean tacos with lime crema"
    assert not any(r["title"].startswith("Smoky") for r in retrieval.search(query, limit=6))

    new = {
        "title": "Smoky Chipotle Black Bean Tacos", "cuisine": "Mexican", "time": 25,
        "difficulty": "Easy", "servings": 4, "dietary": ["Veg"], "image_url": "",
        "ingredients": [{"name": "Black beans", "amount": "400", "unit": "g"},
                        {"name": "Chipotle paste", "amount": "2", "unit": "tbsp"}],
        "steps": [{"step": 1, "text": "Simmer black beans with chipotle paste until thick.",
                   "timer_duration": None, "safety_alert": None}],
    }
    embedding = main.embedding_model.encode(db.build_recipe_text(new)).tolist()
    created = db.create_recipe(new, embedding)

    rows_after, fts_after = _catalogue_counts()
    assert (rows_after, fts_after) == (rows_before + 1, fts_before + 1)

    # Findable immediately, with no reindex step in between.
    results = retrieval.search(query, limit=6)
    assert results and results[0]["id"] == created["id"]

    # Derived columns are materialized on the write path, not by a later batch job.
    assert created["is_veg"] is True
    assert created["category"] == "Mexican"

    # ... and removing it cleans up both indexes.
    db.delete_recipe(created["id"])
    assert _catalogue_counts() == (rows_before, fts_before)
    assert not any(r["id"] == created["id"] for r in retrieval.search(query, limit=6))


def test_cache_rebuilds_when_the_catalogue_changes():
    """The matrix cache is keyed on database.index_version(); a write must invalidate it or
    searches keep answering from a stale corpus."""
    version_before = db.index_version()
    recipe = {
        "title": "Cache Probe Soup", "cuisine": "Test", "time": 5, "difficulty": "Easy",
        "servings": 1, "dietary": ["Veg"], "image_url": "",
        "ingredients": [{"name": "Water", "amount": "1", "unit": "cup"}],
        "steps": [{"step": 1, "text": "Boil.", "timer_duration": None, "safety_alert": None}],
    }
    created = db.create_recipe(recipe, main.embedding_model.encode(db.build_recipe_text(recipe)).tolist())
    assert db.index_version() > version_before
    assert any(r["id"] == created["id"] for r in retrieval.search("cache probe soup", limit=6))
    db.delete_recipe(created["id"])


# --------------------------------------------------------------------------- #
# Storage
# --------------------------------------------------------------------------- #

def test_vectors_round_trip_through_the_blob_format():
    packed = db.pack_vector([0.5] * db.VECTOR_DIM)
    assert isinstance(packed, bytes)
    assert len(packed) == db.VECTOR_DIM * 4          # float32, not JSON text
    assert db.unpack_vector(packed).shape == (db.VECTOR_DIM,)


def test_legacy_json_vectors_are_still_readable():
    """A database written before the BLOB migration must keep working until reindex runs."""
    import json
    legacy = json.dumps([0.25] * db.VECTOR_DIM)
    assert db.unpack_vector(legacy).shape == (db.VECTOR_DIM,)


def test_is_veg_derivation():
    assert db.derive_is_veg(["Veg"]) is True
    assert db.derive_is_veg(["Vegan"]) is True
    assert db.derive_is_veg(["Gluten-free"]) is False
    assert db.derive_is_veg([]) is False
