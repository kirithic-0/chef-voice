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
  role: 'user' | 'ai';
  text: string;
}

export interface VoiceAction {
  type: 'next_step' | 'prev_step' | 'repeat_step' | 'set_timer' | 'cancel_timer' | 'search_recipes' | 'select_recipe' | 'start_cooking' | 'none';
  params?: {
    duration?: number;
    label?: string;
    query?: string;
    id?: string;
  };
}

export interface UserProfile {
  id: string;
  email: string | null;
  allergies: string[];
  dietary_preferences: string[];
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
