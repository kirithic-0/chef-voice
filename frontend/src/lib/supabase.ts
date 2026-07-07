import { createClient } from '@supabase/supabase-js';
import { Recipe, UserProfile, Favorite, CookingHistoryEntry } from '../types';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

// Initialize Supabase Client
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

const API_BASE_URL = 'http://localhost:8000';

// Helper to build headers with authenticated JWT
async function getAuthHeaders(): Promise<HeadersInit> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };
}

// FastAPI Proxy API Calls
export async function fetchConversations() {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_BASE_URL}/conversations`, { headers });
  if (!response.ok) {
    throw new Error('Failed to fetch conversations');
  }
  return response.json();
}

export async function saveConversation(title: string, messages: any[]) {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_BASE_URL}/conversations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title, messages }),
  });
  if (!response.ok) {
    throw new Error('Failed to save conversation');
  }
  return response.json();
}

export async function fetchRecipes(): Promise<Recipe[]> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_BASE_URL}/recipes`, { headers });
  if (!response.ok) {
    throw new Error('Failed to fetch recipes');
  }
  return response.json();
}

export async function searchRecipes(query: string): Promise<Recipe[]> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_BASE_URL}/recipes/search?query=${encodeURIComponent(query)}`, { headers });
  if (!response.ok) {
    throw new Error('Failed to search recipes');
  }
  return response.json();
}

export async function fetchRecipe(id: string): Promise<Recipe> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_BASE_URL}/recipes/${id}`, { headers });
  if (!response.ok) {
    throw new Error('Failed to fetch recipe');
  }
  return response.json();
}

// User Profile DB helpers
export async function getUserProfile(userId: string): Promise<UserProfile> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) {
    // If profile doesn't exist, create it
    if (error.code === 'PGRST116') {
      const defaultProfile = {
        id: userId,
        allergies: [],
        dietary_preferences: []
      };
      const { data: newProfile, error: insertError } = await supabase
        .from('profiles')
        .insert([defaultProfile])
        .select()
        .single();
      
      if (insertError) throw insertError;
      return { ...newProfile, email: null };
    }
    throw error;
  }
  return { ...data, email: null };
}

export async function updateUserProfile(userId: string, allergies: string[], dietaryPreferences: string[]) {
  const { data, error } = await supabase
    .from('profiles')
    .upsert({
      id: userId,
      allergies,
      dietary_preferences: dietaryPreferences,
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Favorites DB helpers
export async function getUserFavorites(userId: string): Promise<Favorite[]> {
  const { data, error } = await supabase
    .from('favorites')
    .select('*')
    .eq('user_id', userId);

  if (error) throw error;
  return data || [];
}

export async function addFavorite(userId: string, recipeId: string) {
  const { data, error } = await supabase
    .from('favorites')
    .insert([{ user_id: userId, recipe_id: recipeId }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function removeFavorite(userId: string, recipeId: string) {
  const { error } = await supabase
    .from('favorites')
    .delete()
    .eq('user_id', userId)
    .eq('recipe_id', recipeId);

  if (error) throw error;
}

// Cooking History DB helpers
export async function getCookingHistory(userId: string): Promise<CookingHistoryEntry[]> {
  const { data, error } = await supabase
    .from('cooking_history')
    .select('*, recipes(*)')
    .eq('user_id', userId)
    .order('completed_at', { ascending: false });

  if (error) throw error;
  
  // Format the returned data to map nested recipe properly
  return (data || []).map(entry => ({
    id: entry.id,
    user_id: entry.user_id,
    recipe_id: entry.recipe_id,
    completed_at: entry.completed_at,
    duration_minutes: entry.duration_minutes,
    rating: entry.rating,
    recipe: entry.recipes // Supabase embeds plural table name as key
  }));
}

export async function addCookingHistory(userId: string, recipeId: string, durationMinutes?: number, rating?: number) {
  const { data, error } = await supabase
    .from('cooking_history')
    .insert([{
      user_id: userId,
      recipe_id: recipeId,
      duration_minutes: durationMinutes,
      rating: rating,
      completed_at: new Date().toISOString()
    }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Admin and Recipe Management helpers
export async function updateAdminStatus(userId: string, isAdmin: boolean) {
  const { data, error } = await supabase
    .from('profiles')
    .update({ is_admin: isAdmin })
    .eq('id', userId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function createRecipe(recipe: Omit<Recipe, 'id'>): Promise<Recipe> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_BASE_URL}/recipes`, {
    method: 'POST',
    headers,
    body: JSON.stringify(recipe)
  });
  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.detail || 'Failed to create recipe');
  }
  return response.json();
}

export async function deleteRecipe(id: string): Promise<void> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_BASE_URL}/recipes/${id}`, {
    method: 'DELETE',
    headers
  });
  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.detail || 'Failed to delete recipe');
  }
}

