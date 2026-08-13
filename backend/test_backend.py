import os
import tempfile
import uuid

# Configure an isolated database BEFORE importing the app.
os.environ["CHEFVOICE_DB"] = os.path.join(tempfile.gettempdir(), "chefvoice_test.db")
os.environ.setdefault("JWT_SECRET", "test-secret-key-for-chefvoice-tests-0123456789")

# Start each test session from a clean database file.
try:
    os.remove(os.environ["CHEFVOICE_DB"])
except FileNotFoundError:
    pass

from fastapi.testclient import TestClient

import main
import database as db
from main import app, get_current_user

# Authenticate every request as a fixed test user by overriding the dependency.
TEST_USER = {"id": "00000000-0000-0000-0000-000000000000", "username": "tester"}
app.dependency_overrides[get_current_user] = lambda: TEST_USER

client = TestClient(app)


def _seed_recipes():
    """Insert a tiny catalogue with real embeddings so semantic search works."""
    conn = db.get_conn()
    conn.execute("DELETE FROM recipes")
    conn.commit()
    samples = [
        {
            "title": "Classic Butter Chicken", "cuisine": "Indian", "time": 40,
            "difficulty": "Medium", "servings": 4, "dietary": ["Gluten-free"], "image_url": None,
            "ingredients": [{"name": "Chicken thighs", "amount": "800", "unit": "g"}],
            "steps": [{"step": 1, "text": "Cook", "timer_duration": None, "safety_alert": None}],
        },
        {
            "title": "Healthy Quinoa Salad", "cuisine": "Healthy", "time": 15,
            "difficulty": "Easy", "servings": 4, "dietary": ["Vegan"], "image_url": None,
            "ingredients": [{"name": "Quinoa", "amount": "1", "unit": "cup"}],
            "steps": [{"step": 1, "text": "Mix", "timer_duration": None, "safety_alert": None}],
        },
    ]
    for recipe in samples:
        embedding = main.embedding_model.encode(db.build_recipe_text(recipe)).tolist()
        db.create_recipe(recipe, embedding)


_seed_recipes()


def test_read_main_recipes():
    response = client.get("/recipes")
    assert response.status_code == 200
    recipes = response.json()
    assert isinstance(recipes, list)
    assert len(recipes) > 0
    recipe = recipes[0]
    assert "title" in recipe
    assert "cuisine" in recipe
    assert "ingredients" in recipe
    assert "steps" in recipe
    # JSON columns must be deserialized back into arrays.
    assert isinstance(recipe["ingredients"], list)
    assert isinstance(recipe["dietary"], list)


def test_recipes_search_empty():
    response = client.get("/recipes/search?query=")
    assert response.status_code == 200
    assert response.json() == []


def test_recipes_search_semantic():
    # A query that should rank the butter chicken above the quinoa salad.
    response = client.get("/recipes/search?query=spicy creamy indian chicken curry")
    assert response.status_code == 200
    results = response.json()
    assert isinstance(results, list)
    assert len(results) > 0
    assert "similarity" in results[0]
    assert results[0]["similarity"] > 0.0
    assert results[0]["title"] == "Classic Butter Chicken"


def test_get_single_recipe_valid():
    recipe_id = client.get("/recipes").json()[0]["id"]
    response = client.get(f"/recipes/{recipe_id}")
    assert response.status_code == 200
    assert response.json()["id"] == recipe_id


def test_get_single_recipe_invalid():
    response = client.get("/recipes/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404


def test_protected_route_requires_token():
    # Temporarily remove the auth override to exercise the real dependency.
    app.dependency_overrides.pop(get_current_user, None)
    try:
        response = client.get("/recipes")
        assert response.status_code == 401
    finally:
        app.dependency_overrides[get_current_user] = lambda: TEST_USER


def test_signup_login_flow():
    username = f"user_{uuid.uuid4().hex[:8]}"

    signup = client.post("/auth/signup", json={"username": username, "password": "secret123"})
    assert signup.status_code == 200
    assert "token" in signup.json()
    assert signup.json()["user"]["username"] == username

    # Duplicate username is rejected.
    dup = client.post("/auth/signup", json={"username": username, "password": "secret123"})
    assert dup.status_code == 409

    # Correct credentials log in.
    login = client.post("/auth/login", json={"username": username, "password": "secret123"})
    assert login.status_code == 200
    assert "token" in login.json()

    # Wrong password is rejected.
    bad = client.post("/auth/login", json={"username": username, "password": "wrong"})
    assert bad.status_code == 401
