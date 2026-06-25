import os
import httpx
from dotenv import load_dotenv
from sentence_transformers import SentenceTransformer

# Load environment variables
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    print("Error: Supabase credentials are missing in the environment.")
    exit(1)

# Initialize SentenceTransformer
print("Loading sentence-transformers/all-MiniLM-L6-v2 model...")
model = SentenceTransformer("all-MiniLM-L6-v2")
print("Model loaded successfully.")

def create_recipe_text(recipe):
    title = recipe.get("title", "")
    cuisine = recipe.get("cuisine", "")
    difficulty = recipe.get("difficulty", "")
    
    ingredients = recipe.get("ingredients", [])
    ingredients_list = []
    for ing in ingredients:
        name = ing.get("name", "")
        amount = ing.get("amount", "")
        unit = ing.get("unit", "")
        ingredients_list.append(f"{amount} {unit} {name}".strip())
    
    ingredients_str = ", ".join(ingredients_list)
    
    # Return descriptive text for embedding
    return f"Title: {title}. Cuisine: {cuisine}. Difficulty: {difficulty}. Ingredients: {ingredients_str}."

def seed_embeddings():
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json"
    }
    
    # 1. Fetch all recipes
    url = f"{SUPABASE_URL}/rest/v1/recipes"
    print(f"Fetching recipes from {url}...")
    
    with httpx.Client() as client:
        response = client.get(url, headers=headers)
        if response.status_code != 200:
            print(f"Failed to fetch recipes: {response.status_code} - {response.text}")
            return
        
        recipes = response.json()
        print(f"Found {len(recipes)} recipes to update.")
        
        for idx, recipe in enumerate(recipes):
            recipe_id = recipe.get("id")
            title = recipe.get("title")
            
            # Create text block
            text_to_encode = create_recipe_text(recipe)
            print(f"[{idx+1}/{len(recipes)}] Generating embedding for '{title}'...")
            
            # Generate embedding
            embedding = model.encode(text_to_encode)
            embedding_list = embedding.tolist()
            
            # 2. Patch embedding to Supabase
            patch_url = f"{SUPABASE_URL}/rest/v1/recipes?id=eq.{recipe_id}"
            patch_data = {"embedding": embedding_list}
            
            patch_response = client.patch(patch_url, headers=headers, json=patch_data)
            if patch_response.status_code in [200, 204]:
                print(f"Successfully updated embedding for '{title}'.")
            else:
                print(f"Failed to update embedding for '{title}': {patch_response.status_code} - {patch_response.text}")

if __name__ == "__main__":
    seed_embeddings()
