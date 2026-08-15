import {
  Recipe,
  UserProfile,
  Favorite,
  CookingHistoryEntry,
  AppSession,
  AuthUser,
  ShoppingListItem,
  UserMemory,
  ProviderInfo,
} from '../types';

// Base URL of the FastAPI backend. Override with VITE_API_BASE_URL when deploying.
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

const TOKEN_KEY = 'chefvoice_token';
const USER_KEY = 'chefvoice_user';

// --------------------------------------------------------------------------- //
// Session management (replaces supabase.auth)
//
// The JWT and user are persisted in localStorage. A tiny listener registry
// stands in for supabase's onAuthStateChange so the app can react to
// login/logout without a page reload.
// --------------------------------------------------------------------------- //

type Listener = (session: AppSession | null) => void;
const listeners = new Set<Listener>();

// Guarded localStorage access so the module is safe to import in non-browser
// environments (unit tests, SSR) where `localStorage` is undefined.
function readStore(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(key);
}

function writeStore(key: string, value: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(key, value);
}

function removeStore(key: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(key);
}

export function getToken(): string | null {
  return readStore(TOKEN_KEY);
}

function getStoredUser(): AuthUser | null {
  const raw = readStore(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function getSession(): AppSession | null {
  const token = getToken();
  const user = getStoredUser();
  if (!token || !user) return null;
  return { access_token: token, user };
}

function persistSession(token: string, user: AuthUser) {
  writeStore(TOKEN_KEY, token);
  writeStore(USER_KEY, JSON.stringify(user));
  notify();
}

export function onAuthChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify() {
  const session = getSession();
  listeners.forEach((l) => l(session));
}

/** Convert the HTTP base URL into a ws:// or wss:// URL for the given path. */
export function getWsUrl(path: string): string {
  return `${API_BASE_URL.replace(/^http/, 'ws')}${path}`;
}

// --------------------------------------------------------------------------- //
// Fetch helpers
// --------------------------------------------------------------------------- //

function authHeaders(): HeadersInit {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function parse(response: Response, fallbackMessage: string) {
  if (!response.ok) {
    // An expired/invalid JWT (7-day lifetime) surfaces as 401. Clear the dead
    // session so the app drops back to the sign-in screen instead of leaving the
    // user stuck behind repeating generic errors. `logout()` notifies listeners.
    if (response.status === 401) {
      logout();
      throw new Error('Your session has expired. Please sign in again.');
    }
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.detail || fallbackMessage);
  }
  return response.json();
}

// --------------------------------------------------------------------------- //
// LLM providers (drives the model selector). Public endpoint, no auth needed.
// --------------------------------------------------------------------------- //

export async function fetchProviders(): Promise<ProviderInfo[]> {
  const response = await fetch(`${API_BASE_URL}/providers`);
  return parse(response, 'Failed to load model providers');
}

// --------------------------------------------------------------------------- //
// Auth actions
// --------------------------------------------------------------------------- //

export async function signup(username: string, password: string): Promise<AppSession> {
  const response = await fetch(`${API_BASE_URL}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await parse(response, 'Failed to create account');
  persistSession(data.token, data.user);
  return getSession()!;
}

export async function login(username: string, password: string): Promise<AppSession> {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await parse(response, 'Failed to sign in');
  persistSession(data.token, data.user);
  return getSession()!;
}

export function logout(): void {
  removeStore(TOKEN_KEY);
  removeStore(USER_KEY);
  notify();
}

// --------------------------------------------------------------------------- //
// Recipes
// --------------------------------------------------------------------------- //

export async function fetchRecipes(): Promise<Recipe[]> {
  const response = await fetch(`${API_BASE_URL}/recipes`, { headers: authHeaders() });
  return parse(response, 'Failed to fetch recipes');
}

export async function searchRecipes(query: string): Promise<Recipe[]> {
  const response = await fetch(
    `${API_BASE_URL}/recipes/search?query=${encodeURIComponent(query)}`,
    { headers: authHeaders() },
  );
  return parse(response, 'Failed to search recipes');
}

export async function fetchRecipe(id: string): Promise<Recipe> {
  const response = await fetch(`${API_BASE_URL}/recipes/${id}`, { headers: authHeaders() });
  return parse(response, 'Failed to fetch recipe');
}

export async function createRecipe(recipe: Omit<Recipe, 'id'>): Promise<Recipe> {
  const response = await fetch(`${API_BASE_URL}/recipes`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(recipe),
  });
  return parse(response, 'Failed to create recipe');
}

export async function deleteRecipe(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/recipes/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  await parse(response, 'Failed to delete recipe');
}

// --------------------------------------------------------------------------- //
// User profile
//
// The backend derives the user from the auth token, so the `userId` argument is
// accepted for call-site compatibility but not sent to the server.
// --------------------------------------------------------------------------- //

export async function getUserProfile(_userId: string): Promise<UserProfile> {
  const response = await fetch(`${API_BASE_URL}/profile`, { headers: authHeaders() });
  const data = await parse(response, 'Failed to load profile');
  return { ...data, email: null };
}

export async function updateAdminStatus(_userId: string, isAdmin: boolean): Promise<UserProfile> {
  const response = await fetch(`${API_BASE_URL}/profile/admin`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ is_admin: isAdmin }),
  });
  return parse(response, 'Failed to update admin status');
}

// --------------------------------------------------------------------------- //
// Favorites
// --------------------------------------------------------------------------- //

export async function getUserFavorites(_userId: string): Promise<Favorite[]> {
  const response = await fetch(`${API_BASE_URL}/favorites`, { headers: authHeaders() });
  return parse(response, 'Failed to load favorites');
}

export async function addFavorite(_userId: string, recipeId: string): Promise<Favorite> {
  const response = await fetch(`${API_BASE_URL}/favorites`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ recipe_id: recipeId }),
  });
  return parse(response, 'Failed to add favorite');
}

export async function removeFavorite(_userId: string, recipeId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/favorites/${recipeId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  await parse(response, 'Failed to remove favorite');
}

// --------------------------------------------------------------------------- //
// Cooking history
// --------------------------------------------------------------------------- //

export async function getCookingHistory(_userId: string): Promise<CookingHistoryEntry[]> {
  const response = await fetch(`${API_BASE_URL}/history`, { headers: authHeaders() });
  return parse(response, 'Failed to load cooking history');
}

export async function addCookingHistory(
  _userId: string,
  recipeId: string,
  durationMinutes?: number,
  rating?: number,
): Promise<CookingHistoryEntry> {
  const response = await fetch(`${API_BASE_URL}/history`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      recipe_id: recipeId,
      duration_minutes: durationMinutes,
      rating,
    }),
  });
  return parse(response, 'Failed to save cooking history');
}

// --------------------------------------------------------------------------- //
// Conversations (voice-session transcripts)
// --------------------------------------------------------------------------- //

export async function fetchConversations() {
  const response = await fetch(`${API_BASE_URL}/conversations`, { headers: authHeaders() });
  return parse(response, 'Failed to fetch conversations');
}

export async function saveConversation(title: string, messages: any[]) {
  const response = await fetch(`${API_BASE_URL}/conversations`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ title, messages }),
  });
  return parse(response, 'Failed to save conversation');
}

// --------------------------------------------------------------------------- //
// Shopping list (also updated by the voice agent's add-to-list tool)
// --------------------------------------------------------------------------- //

export async function fetchShoppingList(): Promise<ShoppingListItem[]> {
  const response = await fetch(`${API_BASE_URL}/shopping-list`, { headers: authHeaders() });
  return parse(response, 'Failed to fetch shopping list');
}

export async function addShoppingListItem(item: {
  name: string;
  quantity?: string;
  unit?: string;
}): Promise<ShoppingListItem> {
  const response = await fetch(`${API_BASE_URL}/shopping-list`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(item),
  });
  return parse(response, 'Failed to add shopping list item');
}

export async function patchShoppingListItem(
  id: string,
  patch: Record<string, unknown>,
): Promise<ShoppingListItem> {
  const response = await fetch(`${API_BASE_URL}/shopping-list/${id}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify(patch),
  });
  return parse(response, 'Failed to update shopping list item');
}

export async function deleteShoppingListItem(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/shopping-list/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  await parse(response, 'Failed to delete shopping list item');
}

// --------------------------------------------------------------------------- //
// Memories (also written by the voice agent's save-note tool)
// --------------------------------------------------------------------------- //

export async function fetchMemories(recipeId?: string): Promise<UserMemory[]> {
  const qs = recipeId ? `?recipe_id=${encodeURIComponent(recipeId)}` : '';
  const response = await fetch(`${API_BASE_URL}/memories${qs}`, { headers: authHeaders() });
  return parse(response, 'Failed to fetch memories');
}

export async function createMemory(note: string, recipeId?: string): Promise<UserMemory> {
  const response = await fetch(`${API_BASE_URL}/memories`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ note, recipe_id: recipeId }),
  });
  return parse(response, 'Failed to save memory');
}

// --------------------------------------------------------------------------- //
// Recipe import from a URL (admin / agent tool)
// --------------------------------------------------------------------------- //

export async function importRecipeFromUrl(url: string) {
  const response = await fetch(`${API_BASE_URL}/recipes/import`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ url }),
  });
  return parse(response, 'Failed to import recipe');
}
