import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from fastapi.testclient import TestClient
import main
from main import app

# Mock auth helpers so test requests bypass Supabase Auth API
main.get_token_from_header = MagicMock(return_value="mock_token")
main.get_user_from_token = AsyncMock(return_value={"id": "00000000-0000-0000-0000-000000000000", "email": "test@chefvoice.local"})

client = TestClient(app)

def test_read_main_recipes():
    response = client.get("/recipes")
    assert response.status_code == 200
    recipes = response.json()
    assert isinstance(recipes, list)
    assert len(recipes) > 0
    # Check recipe structure
    recipe = recipes[0]
    assert "title" in recipe
    assert "cuisine" in recipe
    assert "ingredients" in recipe
    assert "steps" in recipe

def test_recipes_search_empty():
    response = client.get("/recipes/search?query=")
    assert response.status_code == 200
    assert response.json() == []

def test_recipes_search_semantic():
    # Semantic query that should match Classic Butter Chicken or Paneer Tikka Masala
    response = client.get("/recipes/search?query=spicy creamy indian paneer chicken")
    assert response.status_code == 200
    results = response.json()
    assert isinstance(results, list)
    assert len(results) > 0
    # Check that similarity exists
    assert "similarity" in results[0]
    assert results[0]["similarity"] > 0.0

def test_get_single_recipe_valid():
    # First get all recipes to find a valid ID
    recipes_response = client.get("/recipes")
    recipe_id = recipes_response.json()[0]["id"]
    
    response = client.get(f"/recipes/{recipe_id}")
    assert response.status_code == 200
    recipe = response.json()
    assert recipe["id"] == recipe_id
    assert "title" in recipe

def test_get_single_recipe_invalid():
    # Test invalid UUID format
    response = client.get("/recipes/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404
