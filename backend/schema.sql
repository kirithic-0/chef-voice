-- Create recipes table
CREATE TABLE IF NOT EXISTS public.recipes (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    title text NOT NULL,
    cuisine text NOT NULL,
    time integer NOT NULL, -- in minutes
    difficulty text NOT NULL,
    servings integer NOT NULL,
    dietary text[] NOT NULL DEFAULT '{}',
    image_url text,
    ingredients jsonb NOT NULL, -- array of {name, amount, unit}
    steps jsonb NOT NULL, -- array of {step, text, timer_duration, safety_alert}
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS and create select policy
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read access to recipes" ON public.recipes;
CREATE POLICY "Allow public read access to recipes" ON public.recipes 
    FOR SELECT USING (true);

-- Clean existing seed data to prevent duplicates on rerun
TRUNCATE TABLE public.recipes;

-- Seed recipes
INSERT INTO public.recipes (title, cuisine, time, difficulty, servings, dietary, image_url, ingredients, steps) VALUES
(
    'Classic Butter Chicken',
    'Indian',
    40,
    'Medium',
    4,
    ARRAY['Gluten-free'],
    'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?w=600&auto=format&fit=crop&q=60',
    '[
        {"name": "Chicken thighs", "amount": "800", "unit": "g, cubed"},
        {"name": "Yogurt", "amount": "1/2", "unit": "cup"},
        {"name": "Garlic paste", "amount": "1", "unit": "tbsp"},
        {"name": "Ginger paste", "amount": "1", "unit": "tbsp"},
        {"name": "Garam masala", "amount": "2", "unit": "tsp"},
        {"name": "Butter", "amount": "50", "unit": "g"},
        {"name": "Tomato puree", "amount": "400", "unit": "g"},
        {"name": "Heavy cream", "amount": "1/2", "unit": "cup"}
    ]'::jsonb,
    '[
        {"step": 1, "text": "Marinate chicken in yogurt, garlic, ginger, and garam masala.", "timer_duration": 1800, "safety_alert": "Wash hands and clean surfaces after handling raw chicken."},
        {"step": 2, "text": "Melt butter in a large skillet over medium-high heat. Sear chicken until browned, about 3 minutes per side.", "timer_duration": 360, "safety_alert": "Watch out for splattering hot butter!"},
        {"step": 3, "text": "Stir in tomato puree and simmer on low heat for 10 minutes until chicken is cooked through.", "timer_duration": 600, "safety_alert": null},
        {"step": 4, "text": "Pour in heavy cream and stir. Simmer for another 2 minutes before serving.", "timer_duration": 120, "safety_alert": null}
    ]'::jsonb
),
(
    'Creamy Tomato Basil Pasta',
    'Italian',
    20,
    'Easy',
    2,
    ARRAY['Veg'],
    'https://images.unsplash.com/photo-1598866594230-a7c12756260f?w=600&auto=format&fit=crop&q=60',
    '[
        {"name": "Penne pasta", "amount": "200", "unit": "g"},
        {"name": "Olive oil", "amount": "2", "unit": "tbsp"},
        {"name": "Garlic", "amount": "3", "unit": "cloves, minced"},
        {"name": "Canned crushed tomatoes", "amount": "400", "unit": "g"},
        {"name": "Heavy cream", "amount": "1/4", "unit": "cup"},
        {"name": "Fresh basil", "amount": "1/4", "unit": "cup, chopped"},
        {"name": "Parmesan cheese", "amount": "1/4", "unit": "cup"}
    ]'::jsonb,
    '[
        {"step": 1, "text": "Bring a large pot of salted water to boil. Add penne pasta and cook for 10 minutes until al dente.", "timer_duration": 600, "safety_alert": "Be careful when handling boiling water!"},
        {"step": 2, "text": "While pasta cooks, heat olive oil in a pan. Sauté minced garlic until fragrant, about 1 minute.", "timer_duration": 60, "safety_alert": "Do not let garlic burn or it will taste bitter."},
        {"step": 3, "text": "Add crushed tomatoes and simmer on low heat for 8 minutes.", "timer_duration": 480, "safety_alert": null},
        {"step": 4, "text": "Stir in heavy cream and fresh basil. Add the drained pasta, toss, top with Parmesan, and serve.", "timer_duration": null, "safety_alert": null}
    ]'::jsonb
),
(
    'Quick Fluffy Pancakes',
    'Quick Meals',
    15,
    'Easy',
    3,
    ARRAY['Veg'],
    'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=600&auto=format&fit=crop&q=60',
    '[
        {"name": "All-purpose flour", "amount": "1", "unit": "cup"},
        {"name": "Sugar", "amount": "2", "unit": "tbsp"},
        {"name": "Baking powder", "amount": "2", "unit": "tsp"},
        {"name": "Milk", "amount": "3/4", "unit": "cup"},
        {"name": "Melted butter", "amount": "2", "unit": "tbsp"},
        {"name": "Egg", "amount": "1", "unit": ""},
        {"name": "Maple syrup", "amount": "to serve", "unit": ""}
    ]'::jsonb,
    '[
        {"step": 1, "text": "In a bowl, whisk flour, sugar, and baking powder. In another bowl, mix milk, egg, and melted butter.", "timer_duration": null, "safety_alert": null},
        {"step": 2, "text": "Pour wet ingredients into dry ingredients. Stir gently until just combined. The batter should be slightly lumpy.", "timer_duration": null, "safety_alert": null},
        {"step": 3, "text": "Heat a non-stick skillet over medium heat. Ladle batter onto the skillet. Cook until bubbles form on top, about 3 minutes.", "timer_duration": 180, "safety_alert": null},
        {"step": 4, "text": "Flip the pancakes and cook the other side until golden brown, about 2 minutes. Serve hot with maple syrup.", "timer_duration": 120, "safety_alert": "Avoid touching the hot griddle surface."}
    ]'::jsonb
),
(
    'Healthy Quinoa Salad',
    'Healthy',
    15,
    'Easy',
    4,
    ARRAY['Veg', 'Vegan', 'Gluten-free'],
    'https://images.unsplash.com/photo-1505576399279-565b52d4ac71?w=600&auto=format&fit=crop&q=60',
    '[
        {"name": "Quinoa", "amount": "1", "unit": "cup"},
        {"name": "Water", "amount": "2", "unit": "cups"},
        {"name": "Cucumber", "amount": "1", "unit": "diced"},
        {"name": "Cherry tomatoes", "amount": "1", "unit": "cup, halved"},
        {"name": "Olive oil", "amount": "3", "unit": "tbsp"},
        {"name": "Lemon juice", "amount": "2", "unit": "tbsp"},
        {"name": "Salt and Pepper", "amount": "to taste", "unit": ""}
    ]'::jsonb,
    '[
        {"step": 1, "text": "Rinse quinoa. Combine quinoa and water in a pot. Bring to a boil, then cover and simmer for 15 minutes.", "timer_duration": 900, "safety_alert": null},
        {"step": 2, "text": "Remove quinoa from heat and let cool. Meanwhile, dice the cucumber and halve the cherry tomatoes.", "timer_duration": 300, "safety_alert": "Use caution when chopping vegetables with a sharp knife."},
        {"step": 3, "text": "In a large bowl, whisk olive oil, lemon juice, salt, and pepper to make the dressing.", "timer_duration": null, "safety_alert": null},
        {"step": 4, "text": "Add the cooled quinoa, cucumbers, and tomatoes to the bowl. Toss to coat and serve chilled.", "timer_duration": null, "safety_alert": null}
    ]'::jsonb
),
(
    'Paneer Tikka Masala',
    'Indian',
    30,
    'Medium',
    3,
    ARRAY['Veg'],
    'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=600&auto=format&fit=crop&q=60',
    '[
        {"name": "Paneer", "amount": "400", "unit": "g, cubed"},
        {"name": "Bell peppers", "amount": "2", "unit": "cubed"},
        {"name": "Onion", "amount": "1", "unit": "large, chopped"},
        {"name": "Yogurt", "amount": "1/2", "unit": "cup"},
        {"name": "Tikka spices", "amount": "2", "unit": "tbsp"},
        {"name": "Tomato paste", "amount": "2", "unit": "tbsp"},
        {"name": "Heavy cream", "amount": "1/4", "unit": "cup"}
    ]'::jsonb,
    '[
        {"step": 1, "text": "Mix yogurt and tikka spices. Coat paneer cubes and chopped bell peppers. Marinate for 15 minutes.", "timer_duration": 900, "safety_alert": null},
        {"step": 2, "text": "Sauté onions in a pan until golden brown, about 5 minutes. Add tomato paste and cook for another 2 minutes.", "timer_duration": 420, "safety_alert": null},
        {"step": 3, "text": "Add marinated paneer and bell peppers. Cook for 8 minutes on medium heat, stirring occasionally.", "timer_duration": 480, "safety_alert": "Be gentle so the paneer cubes do not break apart."},
        {"step": 4, "text": "Stir in cream, simmer for 2 minutes, and garnish with fresh coriander before serving.", "timer_duration": 120, "safety_alert": null}
    ]'::jsonb
),
(
    'Fudgy Chocolate Chip Cookies',
    'Desserts',
    25,
    'Easy',
    12,
    ARRAY['Veg'],
    'https://images.unsplash.com/photo-1499636136210-6f4ee915583e?w=600&auto=format&fit=crop&q=60',
    '[
        {"name": "Butter", "amount": "1/2", "unit": "cup, melted"},
        {"name": "Brown sugar", "amount": "1/2", "unit": "cup"},
        {"name": "White sugar", "amount": "1/4", "unit": "cup"},
        {"name": "Egg", "amount": "1", "unit": ""},
        {"name": "Flour", "amount": "1.25", "unit": "cups"},
        {"name": "Chocolate chips", "amount": "1", "unit": "cup"}
    ]'::jsonb,
    '[
        {"step": 1, "text": "Preheat your oven to 180°C (350°F). In a large bowl, whisk melted butter, brown sugar, and white sugar.", "timer_duration": null, "safety_alert": "Ovens get very hot, use oven mitts!"},
        {"step": 2, "text": "Whisk in the egg until smooth. Slowly stir in the flour until a soft dough forms. Fold in chocolate chips.", "timer_duration": null, "safety_alert": null},
        {"step": 3, "text": "Scoop dough balls onto a baking sheet. Bake for 10-12 minutes until edges are golden.", "timer_duration": 720, "safety_alert": null},
        {"step": 4, "text": "Remove from oven and let sit on the hot pan for 5 minutes, then transfer to a wire rack to cool.", "timer_duration": 300, "safety_alert": "Cookies will be soft right out of the oven, handle with care."}
    ]'::jsonb
);
