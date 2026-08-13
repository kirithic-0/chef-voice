import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchRecipes, searchRecipes, fetchRecipe } from './api';

// Mock global fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch as any;

// With no token in (a non-existent) localStorage, requests carry only JSON headers.
const jsonHeaders = { 'Content-Type': 'application/json' };

describe('ChefVoice API Client', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('fetchRecipes should request all recipes with auth headers', async () => {
    const mockRecipesData = [
      { id: '1', title: 'Classic Butter Chicken', cuisine: 'Indian' },
      { id: '2', title: 'Tomato Pasta', cuisine: 'Italian' },
    ];

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => mockRecipesData });

    const recipes = await fetchRecipes();
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:8000/recipes', {
      headers: jsonHeaders,
    });
    expect(recipes).toEqual(mockRecipesData);
    expect(recipes.length).toBe(2);
  });

  it('searchRecipes should perform a semantic query fetch', async () => {
    const mockSearchResults = [
      { id: '1', title: 'Classic Butter Chicken', cuisine: 'Indian', similarity: 0.9 },
    ];

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => mockSearchResults });

    const query = 'spicy chicken';
    const results = await searchRecipes(query);
    expect(mockFetch).toHaveBeenCalledWith(
      `http://localhost:8000/recipes/search?query=${encodeURIComponent(query)}`,
      { headers: jsonHeaders },
    );
    expect(results).toEqual(mockSearchResults);
    expect(results[0].title).toBe('Classic Butter Chicken');
  });

  it('fetchRecipe should fetch a single recipe by ID', async () => {
    const mockRecipe = { id: 'recipe-123', title: 'Quick Fluffy Pancakes', cuisine: 'Quick Meals' };

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => mockRecipe });

    const recipe = await fetchRecipe('recipe-123');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:8000/recipes/recipe-123', {
      headers: jsonHeaders,
    });
    expect(recipe).toEqual(mockRecipe);
    expect(recipe.title).toBe('Quick Fluffy Pancakes');
  });

  it('fetchRecipe should surface the backend error detail on failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ detail: 'Recipe not found' }),
    });

    await expect(fetchRecipe('invalid-id')).rejects.toThrow('Recipe not found');
  });
});
