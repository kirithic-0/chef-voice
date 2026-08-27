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
    // URLSearchParams form-encodes the space as '+' rather than '%20'. Both are valid in a
    // query string and the backend decodes them identically (verified against FastAPI).
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8000/recipes/search?query=spicy+chicken',
      { headers: jsonHeaders },
    );
    expect(results).toEqual(mockSearchResults);
    expect(results[0].title).toBe('Classic Butter Chicken');
  });

  it('searchRecipes should send filters to the server, not apply them locally', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

    await searchRecipes('pasta', { is_veg: true, category: 'Italian', max_time: 30 });

    const [url] = mockFetch.mock.calls[0];
    const params = new URL(url).searchParams;
    expect(params.get('query')).toBe('pasta');
    expect(params.get('is_veg')).toBe('true');
    expect(params.get('category')).toBe('Italian');
    expect(params.get('max_time')).toBe('30');
  });

  it('searchRecipes should omit filters that are not set', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

    await searchRecipes('pasta', { is_veg: undefined, category: '' });

    const [url] = mockFetch.mock.calls[0];
    const params = new URL(url).searchParams;
    expect(params.has('is_veg')).toBe(false);
    expect(params.has('category')).toBe(false);
  });

  it('searchRecipes should send is_veg=false rather than dropping it', async () => {
    // `false` is a meaningful filter (show non-vegetarian only). A naive falsy check would
    // silently turn "Non-Veg" into "no filter" and show everything.
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

    await searchRecipes('curry', { is_veg: false });

    const [url] = mockFetch.mock.calls[0];
    expect(new URL(url).searchParams.get('is_veg')).toBe('false');
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
