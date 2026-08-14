export interface Ingredient {
  name: string;
  amount: string;
  unit: string;
}

export interface Step {
  step: number;
  text: string;
  timer_duration: number | null;
  safety_alert: string | null;
}

export interface Recipe {
  id: string;
  title: string;
  cuisine: string;
  time: number;
  difficulty: string;
  servings: number;
  dietary?: string[];
  image_url?: string;
  ingredients: Ingredient[];
  steps: Step[];
  embedding?: number[];
  created_at?: string;
  average_rating?: number;
  rating_count?: number;
}

export interface Timer {
  id: string;
  label: string;
  duration: number;
  timeLeft: number;
  alarmPlayed: boolean;
}

export interface Message {
  id: string;
  // 'tool' = an immersive chip shown while the agent runs a tool (e.g. searching).
  role: 'user' | 'ai' | 'tool';
  text: string;
}

// Which LLM backend the voice agent uses ('llama' = Groq, 'nvidia' = OpenRouter
// Nemotron, 'local' = on-device Gemma via Ollama). Matches the provider ids the
// backend's /providers endpoint returns.
export type ModelProvider = 'llama' | 'nvidia' | 'local';

export interface ProviderInfo {
  id: ModelProvider;
  label: string;
  model: string;
  available: boolean;
  default: boolean;
}

export interface VoiceAction {
  type:
    | 'next_step'
    | 'prev_step'
    | 'repeat_step'
    | 'set_timer'
    | 'cancel_timer'
    | 'search_recipes'
    | 'select_recipe'
    | 'start_cooking'
    | 'scale_recipe'
    | 'shopping_list_updated'
    | 'memory_saved'
    | 'recipe_imported'
    | 'none';
  params?: {
    duration?: number;
    label?: string;
    query?: string;
    id?: string;
    step_index?: number;
    servings?: number;
    ingredients?: Ingredient[];
    results?: Recipe[];
    item?: ShoppingListItem;
    memory?: UserMemory;
    recipe?: Recipe;
  };
}

export interface UserProfile {
  id: string;
  email: string | null;
  allergies: string[];
  dietary_preferences: string[];
  is_admin?: boolean;
}

// Authenticated user identity returned by the backend auth endpoints.
export interface AuthUser {
  id: string;
  username: string;
}

// Local session shape (replaces @supabase/supabase-js `Session`).
export interface AppSession {
  access_token: string;
  user: AuthUser;
}

export interface ShoppingListItem {
  id: string;
  user_id: string;
  name: string;
  quantity: string;
  unit: string;
  checked: boolean;
  created_at?: string;
}

export interface UserMemory {
  id: string;
  user_id: string;
  recipe_id?: string | null;
  note: string;
  created_at?: string;
}

export interface Favorite {
  id: string;
  user_id: string;
  recipe_id: string;
  created_at?: string;
}

export interface CookingHistoryEntry {
  id: string;
  user_id: string;
  recipe_id: string;
  completed_at: string;
  duration_minutes?: number;
  rating?: number;
  recipe?: Recipe;
}
