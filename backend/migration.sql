-- Enable vector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Alter recipes table to add embedding
ALTER TABLE public.recipes ADD COLUMN IF NOT EXISTS embedding vector(384);

-- Create profiles table
CREATE TABLE IF NOT EXISTS public.profiles (
    id uuid REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
    allergies text[] NOT NULL DEFAULT '{}',
    dietary_preferences text[] NOT NULL DEFAULT '{}',
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create favorites table
CREATE TABLE IF NOT EXISTS public.favorites (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    recipe_id uuid REFERENCES public.recipes(id) ON DELETE CASCADE NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(user_id, recipe_id)
);

-- Create cooking_history table
CREATE TABLE IF NOT EXISTS public.cooking_history (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    recipe_id uuid REFERENCES public.recipes(id) ON DELETE CASCADE NOT NULL,
    completed_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    duration_minutes integer,
    rating integer CHECK (rating >= 1 AND rating <= 5)
);

-- Alter conversations table to link to auth.users
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- Enable Row Level Security
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cooking_history ENABLE ROW LEVEL SECURITY;

-- Enable RLS on recipes
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;

-- Create policies (drop first to prevent duplicate errors)
DROP POLICY IF EXISTS "Users can manage their own conversations" ON public.conversations;
CREATE POLICY "Users can manage their own conversations" ON public.conversations
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage their own profiles" ON public.profiles;
CREATE POLICY "Users can manage their own profiles" ON public.profiles
    FOR ALL USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can manage their own favorites" ON public.favorites;
CREATE POLICY "Users can manage their own favorites" ON public.favorites
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view/create their own history" ON public.cooking_history;
CREATE POLICY "Users can view/create their own history" ON public.cooking_history
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Create match_recipes similarity matching function
CREATE OR REPLACE FUNCTION match_recipes(
  query_embedding vector(384),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id uuid,
  title text,
  cuisine text,
  "time" integer,
  difficulty text,
  servings integer,
  dietary text[],
  image_url text,
  ingredients jsonb,
  steps jsonb,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    recipes.id,
    recipes.title,
    recipes.cuisine,
    recipes.time,
    recipes.difficulty,
    recipes.servings,
    recipes.dietary,
    recipes.image_url,
    recipes.ingredients,
    recipes.steps,
    (1 - (recipes.embedding <=> query_embedding))::float AS similarity
  FROM recipes
  WHERE 1 - (recipes.embedding <=> query_embedding) > match_threshold
  ORDER BY recipes.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Create HNSW index for fast vector similarity search scaling
CREATE INDEX IF NOT EXISTS recipes_embedding_hnsw_idx 
ON public.recipes 
USING hnsw (embedding vector_cosine_ops);

-- Alter recipes table to add rating columns
ALTER TABLE public.recipes ADD COLUMN IF NOT EXISTS average_rating float DEFAULT 0.0;
ALTER TABLE public.recipes ADD COLUMN IF NOT EXISTS rating_count integer DEFAULT 0;

-- Alter profiles table to add is_admin flag
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT false;

-- Create function to update recipe average rating and count
CREATE OR REPLACE FUNCTION public.update_recipe_rating_stats()
RETURNS TRIGGER AS $$
DECLARE
    r_id uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        r_id := OLD.recipe_id;
    ELSE
        r_id := NEW.recipe_id;
    END IF;

    UPDATE public.recipes
    SET 
        average_rating = COALESCE((SELECT AVG(rating)::float FROM public.cooking_history WHERE recipe_id = r_id AND rating IS NOT NULL), 0.0),
        rating_count = COALESCE((SELECT COUNT(rating)::integer FROM public.cooking_history WHERE recipe_id = r_id AND rating IS NOT NULL), 0)
    WHERE id = r_id;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger on cooking_history
DROP TRIGGER IF EXISTS trg_update_recipe_rating_stats ON public.cooking_history;
CREATE TRIGGER trg_update_recipe_rating_stats
    AFTER INSERT OR UPDATE OR DELETE ON public.cooking_history
    FOR EACH ROW
    EXECUTE FUNCTION public.update_recipe_rating_stats();

-- Backfill existing ratings stats for all recipes
UPDATE public.recipes r
SET 
    average_rating = COALESCE((SELECT AVG(rating)::float FROM public.cooking_history ch WHERE ch.recipe_id = r.id AND ch.rating IS NOT NULL), 0.0),
    rating_count = COALESCE((SELECT COUNT(rating)::integer FROM public.cooking_history ch WHERE ch.recipe_id = r.id AND ch.rating IS NOT NULL), 0);

