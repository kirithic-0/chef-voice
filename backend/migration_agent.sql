-- Shopping list + user memories for ChefVoice agent tools
-- Run in Supabase SQL editor after migration.sql

CREATE TABLE IF NOT EXISTS public.shopping_list_items (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name text NOT NULL,
    quantity text NOT NULL DEFAULT '',
    unit text NOT NULL DEFAULT '',
    checked boolean NOT NULL DEFAULT false,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.user_memories (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    recipe_id uuid REFERENCES public.recipes(id) ON DELETE SET NULL,
    note text NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.shopping_list_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_memories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own shopping list" ON public.shopping_list_items;
CREATE POLICY "Users manage own shopping list" ON public.shopping_list_items
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users manage own memories" ON public.user_memories;
CREATE POLICY "Users manage own memories" ON public.user_memories
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS shopping_list_items_user_id_idx ON public.shopping_list_items(user_id);
CREATE INDEX IF NOT EXISTS user_memories_user_id_idx ON public.user_memories(user_id);
CREATE INDEX IF NOT EXISTS user_memories_recipe_id_idx ON public.user_memories(recipe_id);
