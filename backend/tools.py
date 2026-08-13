"""
ChefVoice tool schemas and deterministic executors.

Tools run on the server. Results go back into the NVIDIA agent loop.
UI sync events are collected as `ui_actions` for the WebSocket client.
"""
from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from fastapi.concurrency import run_in_threadpool

# --- Unit conversion tables (kitchen) ---
VOLUME_TO_ML = {
    "ml": 1.0,
    "milliliter": 1.0,
    "milliliters": 1.0,
    "l": 1000.0,
    "liter": 1000.0,
    "liters": 1000.0,
    "tsp": 4.92892,
    "teaspoon": 4.92892,
    "teaspoons": 4.92892,
    "tbsp": 14.7868,
    "tablespoon": 14.7868,
    "tablespoons": 14.7868,
    "cup": 236.588,
    "cups": 236.588,
    "fl oz": 29.5735,
    "floz": 29.5735,
    "oz": 29.5735,  # fluid oz in kitchen voice context unless marked weight
}

WEIGHT_TO_G = {
    "g": 1.0,
    "gram": 1.0,
    "grams": 1.0,
    "kg": 1000.0,
    "oz": 28.3495,
    "ounce": 28.3495,
    "ounces": 28.3495,
    "lb": 453.592,
    "pound": 453.592,
    "pounds": 453.592,
}

SUBSTITUTION_HINTS = {
    "cream": "Use coconut cream, cashew cream, or evaporated milk.",
    "heavy cream": "Use coconut cream or half-and-half plus a little butter.",
    "butter": "Use olive oil, ghee, or a plant-based butter.",
    "egg": "Use a flax egg (1 tbsp ground flax + 3 tbsp water) or commercial egg replacer.",
    "eggs": "Use flax eggs or commercial egg replacer.",
    "milk": "Use oat, almond, or soy milk.",
    "yogurt": "Use coconut yogurt or sour cream.",
    "parmesan": "Use nutritional yeast or pecorino (if dairy is OK).",
}


TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "search_recipes",
            "description": "Semantic search over the recipe catalog. Use when the user wants to find or browse recipes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural language search query"}
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_recipe",
            "description": "Fetch a full recipe by id.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Recipe UUID"}
                },
                "required": ["id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_current_step",
            "description": "Return the current cooking step and recipe progress.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "navigate_step",
            "description": "Move to next, previous, repeat, or a specific step index while cooking.",
            "parameters": {
                "type": "object",
                "properties": {
                    "direction": {
                        "type": "string",
                        "enum": ["next", "prev", "repeat", "goto"],
                    },
                    "step_index": {
                        "type": "integer",
                        "description": "0-based step index when direction is goto",
                    },
                },
                "required": ["direction"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_timer",
            "description": "Start a named cooking timer.",
            "parameters": {
                "type": "object",
                "properties": {
                    "duration": {"type": "integer", "description": "Duration in seconds"},
                    "label": {"type": "string", "description": "Timer label"},
                },
                "required": ["duration"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cancel_timer",
            "description": "Cancel a running timer by label substring match.",
            "parameters": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                },
                "required": ["label"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "scale_recipe",
            "description": "Scale the active recipe ingredient amounts to a new servings count.",
            "parameters": {
                "type": "object",
                "properties": {
                    "servings": {"type": "integer", "minimum": 1},
                },
                "required": ["servings"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "convert_units",
            "description": "Convert a kitchen measurement between units.",
            "parameters": {
                "type": "object",
                "properties": {
                    "amount": {"type": "number"},
                    "from_unit": {"type": "string"},
                    "to_unit": {"type": "string"},
                    "kind": {
                        "type": "string",
                        "enum": ["volume", "weight"],
                        "description": "Measurement family",
                    },
                },
                "required": ["amount", "from_unit", "to_unit"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "suggest_substitution",
            "description": "Suggest a substitution for an ingredient.",
            "parameters": {
                "type": "object",
                "properties": {
                    "ingredient": {"type": "string"},
                },
                "required": ["ingredient"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "select_recipe",
            "description": "Select a recipe by id for the detail screen.",
            "parameters": {
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "start_cooking",
            "description": "Enter cooking mode for the currently selected recipe.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_to_shopping_list",
            "description": "Add an item to the user's shopping list.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "quantity": {"type": "string"},
                    "unit": {"type": "string"},
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "save_note",
            "description": "Save a memory/note for this user, optionally tied to a recipe.",
            "parameters": {
                "type": "object",
                "properties": {
                    "note": {"type": "string"},
                    "recipe_id": {"type": "string"},
                },
                "required": ["note"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "recall_memories",
            "description": "Recall saved notes for this user, optionally filtered by recipe.",
            "parameters": {
                "type": "object",
                "properties": {
                    "recipe_id": {"type": "string"},
                    "limit": {"type": "integer"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "import_recipe_from_url",
            "description": "Import a recipe from a public URL into the catalog.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                },
                "required": ["url"],
            },
        },
    },
]


@dataclass
class ToolContext:
    cooking_state: dict[str, Any]
    user_id: str
    token: str
    http_client: Any
    supabase_url: str
    supabase_service_key: str
    embedding_model: Any
    nvidia_api_key: str
    nvidia_model: str
    ui_actions: list[dict[str, Any]] = field(default_factory=list)


def parse_amount(amount: Any) -> Optional[float]:
    if amount is None:
        return None
    if isinstance(amount, (int, float)):
        return float(amount)
    s = str(amount).strip().lower()
    if not s or s in {"to serve", "to taste", "as needed"}:
        return None
    # fractions like 1/2 or 1 1/2
    mixed = re.match(r"^(\d+)\s+(\d+)/(\d+)$", s)
    if mixed:
        whole, num, den = mixed.groups()
        return float(whole) + (float(num) / float(den))
    frac = re.match(r"^(\d+)/(\d+)$", s)
    if frac:
        num, den = frac.groups()
        return float(num) / float(den)
    try:
        return float(s)
    except ValueError:
        m = re.search(r"(\d+(\.\d+)?)", s)
        return float(m.group(1)) if m else None


def format_amount(value: float) -> str:
    if abs(value - round(value)) < 1e-6:
        return str(int(round(value)))
    # simple quarters
    for den in (2, 3, 4, 8):
        num = round(value * den)
        if abs(value - (num / den)) < 0.02:
            if num > den:
                whole = num // den
                rem = num % den
                return f"{whole} {rem}/{den}" if rem else str(whole)
            return f"{num}/{den}"
    return f"{value:.2f}".rstrip("0").rstrip(".")


def scale_ingredients(ingredients: list[dict], base_servings: int, new_servings: int) -> list[dict]:
    if base_servings <= 0:
        base_servings = 1
    ratio = new_servings / base_servings
    scaled = []
    for ing in ingredients:
        item = dict(ing)
        amt = parse_amount(ing.get("amount"))
        if amt is not None:
            item["amount"] = format_amount(amt * ratio)
        scaled.append(item)
    return scaled


def convert_units(amount: float, from_unit: str, to_unit: str, kind: str = "volume") -> dict[str, Any]:
    fu = from_unit.strip().lower()
    tu = to_unit.strip().lower()
    table = VOLUME_TO_ML if kind == "volume" else WEIGHT_TO_G
    if fu not in table or tu not in table:
        return {"error": f"Unsupported units for {kind}: {from_unit} -> {to_unit}"}
    base = amount * table[fu]
    converted = base / table[tu]
    return {
        "amount": round(converted, 4),
        "from": {"amount": amount, "unit": from_unit},
        "to": {"amount": round(converted, 4), "unit": to_unit},
        "kind": kind,
    }


def build_system_prompt(cooking_state: dict[str, Any]) -> str:
    recipe = cooking_state.get("recipe")
    current_step_idx = cooking_state.get("current_step", 0)
    screen = cooking_state.get("screen", "home")
    timers = cooking_state.get("timers", [])
    dietary_prefs = cooking_state.get("dietary_preferences", [])

    recipe_context = "None"
    step_context = "None"
    if recipe:
        recipe_context = (
            f"Title: {recipe.get('title')}\n"
            f"Cuisine: {recipe.get('cuisine')}\n"
            f"Servings: {recipe.get('servings')}\n"
            f"Ingredients: {json.dumps(recipe.get('ingredients'))}\n"
            f"All Recipe Steps: {json.dumps(recipe.get('steps'))}"
        )
        steps = recipe.get("steps", [])
        if 0 <= current_step_idx < len(steps):
            curr_step = steps[current_step_idx]
            step_context = f"Step {current_step_idx + 1} of {len(steps)}: {curr_step.get('text')}"
            if curr_step.get("safety_alert"):
                step_context += f" (SAFETY ALERT: {curr_step.get('safety_alert')})"
            if curr_step.get("timer_duration"):
                step_context += f" (Suggested Timer: {curr_step.get('timer_duration')} seconds)"

    dietary_str = ", ".join(dietary_prefs) if dietary_prefs else "None"

    return (
        "You are ChefVoice, a hands-free kitchen voice assistant.\n"
        "Guide the user through recipes, manage timers, suggest substitutions, and answer cooking questions.\n"
        "Use tools for search, navigation, timers, scaling, shopping list, memories, and imports.\n"
        "For simple greetings or small talk (hi, hello, thanks), reply briefly in spoken language without calling tools.\n"
        "After tools finish, reply with natural spoken text only (no JSON, no markdown).\n"
        "When navigating or repeating a step, read that step's instructions completely and verbatim.\n"
        "For general cooking questions, answer directly without rereading the full step.\n"
        "If the screen is 'cooking', do not search or select other recipes unless the user clearly asks to leave cooking mode.\n\n"
        f"Current Screen: {screen}\n"
        f"Current Active Recipe Details:\n{recipe_context}\n"
        f"Current Active Cooking Step:\n{step_context}\n"
        f"Active Running Timers: {json.dumps(timers)}\n"
        f"User Dietary Preferences: {dietary_str}\n"
    )


async def _supabase_headers(ctx: ToolContext, prefer: Optional[str] = None) -> dict[str, str]:
    headers = {
        "apikey": ctx.supabase_service_key,
        "Authorization": f"Bearer {ctx.token}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


async def tool_search_recipes(args: dict, ctx: ToolContext) -> dict:
    query = (args.get("query") or "").strip()
    if not query:
        return {"results": []}
    query_embedding_arr = await run_in_threadpool(ctx.embedding_model.encode, query)
    query_embedding = query_embedding_arr.tolist()
    url = f"{ctx.supabase_url}/rest/v1/rpc/match_recipes"
    payload = {
        "query_embedding": query_embedding,
        "match_threshold": 0.0,
        "match_count": 6,
    }
    resp = await ctx.http_client.post(url, headers=await _supabase_headers(ctx), json=payload)
    resp.raise_for_status()
    results = resp.json()
    slim = [
        {
            "id": r.get("id"),
            "title": r.get("title"),
            "cuisine": r.get("cuisine"),
            "time": r.get("time"),
            "difficulty": r.get("difficulty"),
            "similarity": r.get("similarity"),
        }
        for r in results
    ]
    ctx.ui_actions.append({
        "type": "search_recipes",
        "params": {"query": query, "results": results},
    })
    return {"query": query, "results": slim}


async def tool_get_recipe(args: dict, ctx: ToolContext) -> dict:
    recipe_id = args.get("id")
    url = f"{ctx.supabase_url}/rest/v1/recipes"
    params = {"select": "*", "id": f"eq.{recipe_id}"}
    resp = await ctx.http_client.get(url, headers=await _supabase_headers(ctx), params=params)
    resp.raise_for_status()
    data = resp.json()
    if not data:
        return {"error": "Recipe not found"}
    return {"recipe": data[0]}


async def tool_get_current_step(args: dict, ctx: ToolContext) -> dict:
    recipe = ctx.cooking_state.get("recipe")
    idx = ctx.cooking_state.get("current_step", 0)
    if not recipe:
        return {"error": "No active recipe"}
    steps = recipe.get("steps", [])
    if not steps:
        return {"error": "Recipe has no steps"}
    idx = max(0, min(idx, len(steps) - 1))
    step = steps[idx]
    return {
        "step_index": idx,
        "step_number": idx + 1,
        "total_steps": len(steps),
        "text": step.get("text"),
        "timer_duration": step.get("timer_duration"),
        "safety_alert": step.get("safety_alert"),
        "screen": ctx.cooking_state.get("screen"),
    }


async def tool_navigate_step(args: dict, ctx: ToolContext) -> dict:
    recipe = ctx.cooking_state.get("recipe")
    if not recipe or ctx.cooking_state.get("screen") != "cooking":
        return {"error": "Not currently cooking a recipe"}
    steps = recipe.get("steps", [])
    if not steps:
        return {"error": "No steps"}
    direction = args.get("direction", "next")
    idx = ctx.cooking_state.get("current_step", 0)
    action_type = "none"
    if direction == "next":
        if idx >= len(steps) - 1:
            return {
                "status": "already_on_last_step",
                "step_index": idx,
                "text": steps[idx].get("text"),
                "total_steps": len(steps),
            }
        idx += 1
        action_type = "next_step"
    elif direction == "prev":
        if idx <= 0:
            return {
                "status": "already_on_first_step",
                "step_index": idx,
                "text": steps[idx].get("text"),
                "total_steps": len(steps),
            }
        idx -= 1
        action_type = "prev_step"
    elif direction == "repeat":
        action_type = "repeat_step"
    elif direction == "goto":
        target = int(args.get("step_index", 0))
        idx = max(0, min(target, len(steps) - 1))
        action_type = "repeat_step" if idx == ctx.cooking_state.get("current_step", 0) else "next_step"
    else:
        return {"error": f"Unknown direction: {direction}"}

    ctx.cooking_state["current_step"] = idx
    ctx.ui_actions.append({"type": action_type, "params": {"step_index": idx}})
    return {
        "status": "ok",
        "direction": direction,
        "step_index": idx,
        "step_number": idx + 1,
        "total_steps": len(steps),
        "text": steps[idx].get("text"),
        "timer_duration": steps[idx].get("timer_duration"),
        "safety_alert": steps[idx].get("safety_alert"),
    }


async def tool_set_timer(args: dict, ctx: ToolContext) -> dict:
    duration = int(args.get("duration", 0))
    if duration <= 0:
        return {"error": "duration must be positive seconds"}
    label = args.get("label") or "Cooking Timer"
    timer = {
        "id": f"timer-{uuid.uuid4().hex[:10]}",
        "label": label,
        "duration": duration,
        "timeLeft": duration,
        "alarmPlayed": False,
    }
    timers = list(ctx.cooking_state.get("timers") or [])
    timers.append(timer)
    ctx.cooking_state["timers"] = timers
    ctx.ui_actions.append({"type": "set_timer", "params": {"duration": duration, "label": label, "id": timer["id"]}})
    return {"status": "ok", "timer": timer}


async def tool_cancel_timer(args: dict, ctx: ToolContext) -> dict:
    label = (args.get("label") or "").lower()
    timers = list(ctx.cooking_state.get("timers") or [])
    match = next((t for t in timers if label in str(t.get("label", "")).lower()), None)
    if not match:
        return {"error": f"No timer matching label '{args.get('label')}'", "timers": timers}
    timers = [t for t in timers if t.get("id") != match.get("id")]
    ctx.cooking_state["timers"] = timers
    ctx.ui_actions.append({"type": "cancel_timer", "params": {"label": match.get("label"), "id": match.get("id")}})
    return {"status": "ok", "cancelled": match}


async def tool_scale_recipe(args: dict, ctx: ToolContext) -> dict:
    recipe = ctx.cooking_state.get("recipe")
    if not recipe:
        return {"error": "No active recipe to scale"}
    new_servings = int(args.get("servings", 0))
    if new_servings < 1:
        return {"error": "servings must be >= 1"}
    base = int(recipe.get("servings") or 1)
    scaled = scale_ingredients(recipe.get("ingredients") or [], base, new_servings)
    recipe = dict(recipe)
    recipe["ingredients"] = scaled
    recipe["servings"] = new_servings
    ctx.cooking_state["recipe"] = recipe
    ctx.ui_actions.append({
        "type": "scale_recipe",
        "params": {"servings": new_servings, "ingredients": scaled},
    })
    return {"status": "ok", "servings": new_servings, "ingredients": scaled}


async def tool_convert_units(args: dict, ctx: ToolContext) -> dict:
    kind = args.get("kind") or "volume"
    return convert_units(float(args["amount"]), args["from_unit"], args["to_unit"], kind)


async def tool_suggest_substitution(args: dict, ctx: ToolContext) -> dict:
    ingredient = (args.get("ingredient") or "").strip().lower()
    for key, hint in SUBSTITUTION_HINTS.items():
        if key in ingredient or ingredient in key:
            return {"ingredient": args.get("ingredient"), "suggestion": hint}
    return {
        "ingredient": args.get("ingredient"),
        "suggestion": f"Try a similar pantry staple with the same role as {args.get('ingredient')}, and adjust seasoning to taste.",
    }


async def tool_select_recipe(args: dict, ctx: ToolContext) -> dict:
    recipe_id = args.get("id")
    fetched = await tool_get_recipe({"id": recipe_id}, ctx)
    if "error" in fetched:
        return fetched
    recipe = fetched["recipe"]
    ctx.cooking_state["recipe"] = recipe
    ctx.cooking_state["screen"] = "detail"
    ctx.cooking_state["current_step"] = 0
    ctx.ui_actions.append({"type": "select_recipe", "params": {"id": recipe_id}})
    return {"status": "ok", "recipe": {"id": recipe.get("id"), "title": recipe.get("title")}}


async def tool_start_cooking(args: dict, ctx: ToolContext) -> dict:
    recipe = ctx.cooking_state.get("recipe")
    if not recipe:
        return {"error": "Select a recipe before starting"}
    ctx.cooking_state["screen"] = "cooking"
    ctx.cooking_state["current_step"] = 0
    ctx.ui_actions.append({"type": "start_cooking", "params": {}})
    steps = recipe.get("steps") or []
    first = steps[0] if steps else None
    return {
        "status": "ok",
        "title": recipe.get("title"),
        "first_step": first.get("text") if first else None,
        "total_steps": len(steps),
    }


async def tool_add_to_shopping_list(args: dict, ctx: ToolContext) -> dict:
    name = (args.get("name") or "").strip()
    if not name:
        return {"error": "name is required"}
    row = {
        "user_id": ctx.user_id,
        "name": name,
        "quantity": args.get("quantity") or "",
        "unit": args.get("unit") or "",
        "checked": False,
    }
    url = f"{ctx.supabase_url}/rest/v1/shopping_list_items"
    resp = await ctx.http_client.post(
        url,
        headers=await _supabase_headers(ctx, prefer="return=representation"),
        json=row,
    )
    if resp.status_code >= 400:
        return {"error": f"Failed to add item: {resp.text}"}
    data = resp.json()
    item = data[0] if isinstance(data, list) else data
    ctx.ui_actions.append({"type": "shopping_list_updated", "params": {"item": item}})
    return {"status": "ok", "item": item}


async def tool_save_note(args: dict, ctx: ToolContext) -> dict:
    note = (args.get("note") or "").strip()
    if not note:
        return {"error": "note is required"}
    row = {
        "user_id": ctx.user_id,
        "note": note,
        "recipe_id": args.get("recipe_id") or (ctx.cooking_state.get("recipe") or {}).get("id"),
    }
    # omit null recipe_id
    if not row["recipe_id"]:
        row.pop("recipe_id", None)
    url = f"{ctx.supabase_url}/rest/v1/user_memories"
    resp = await ctx.http_client.post(
        url,
        headers=await _supabase_headers(ctx, prefer="return=representation"),
        json=row,
    )
    if resp.status_code >= 400:
        return {"error": f"Failed to save note: {resp.text}"}
    data = resp.json()
    memory = data[0] if isinstance(data, list) else data
    ctx.ui_actions.append({"type": "memory_saved", "params": {"memory": memory}})
    return {"status": "ok", "memory": memory}


async def tool_recall_memories(args: dict, ctx: ToolContext) -> dict:
    limit = int(args.get("limit") or 5)
    url = f"{ctx.supabase_url}/rest/v1/user_memories"
    params = {
        "select": "*",
        "user_id": f"eq.{ctx.user_id}",
        "order": "created_at.desc",
        "limit": str(limit),
    }
    if args.get("recipe_id"):
        params["recipe_id"] = f"eq.{args['recipe_id']}"
    resp = await ctx.http_client.get(url, headers=await _supabase_headers(ctx), params=params)
    if resp.status_code >= 400:
        return {"error": f"Failed to recall memories: {resp.text}"}
    return {"memories": resp.json()}


async def tool_import_recipe_from_url(args: dict, ctx: ToolContext) -> dict:
    url = (args.get("url") or "").strip()
    if not url.startswith("http"):
        return {"error": "url must be http(s)"}

    try:
        page = await ctx.http_client.get(url, follow_redirects=True, timeout=30.0)
        page.raise_for_status()
        html = page.text
    except Exception as e:
        return {"error": f"Failed to fetch URL: {e}"}

    # Strip tags lightly for the extractor
    text = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()[:12000]

    extract_prompt = (
        "Extract a cooking recipe from the page text. Return ONLY raw JSON with keys: "
        "title, cuisine, time (minutes int), difficulty (Easy|Medium|Hard), servings (int), "
        "dietary (string array), image_url (string or empty), "
        "ingredients (array of {name, amount, unit}), "
        "steps (array of {step, text, timer_duration, safety_alert}). "
        "timer_duration is seconds or null. safety_alert is string or null."
    )
    nvidia_url = "https://integrate.api.nvidia.com/v1/chat/completions"
    body = {
        "model": ctx.nvidia_model,
        "messages": [
            {"role": "system", "content": extract_prompt},
            {"role": "user", "content": text},
        ],
        "temperature": 0.2,
    }
    headers = {
        "Authorization": f"Bearer {ctx.nvidia_api_key}",
        "Content-Type": "application/json",
    }
    try:
        nresp = await ctx.http_client.post(nvidia_url, headers=headers, json=body, timeout=60.0)
        nresp.raise_for_status()
        content = nresp.json()["choices"][0]["message"]["content"].strip()
        content = re.sub(r"^```json\s*|\s*```$", "", content, flags=re.I | re.M).strip()
        recipe_data = json.loads(content)
    except Exception as e:
        return {"error": f"Failed to extract recipe: {e}"}

    required = ["title", "cuisine", "time", "difficulty", "servings", "ingredients", "steps"]
    for field_name in required:
        if field_name not in recipe_data:
            return {"error": f"Extracted recipe missing field: {field_name}"}

    ingredients = recipe_data.get("ingredients", [])
    ingredients_list = []
    for ing in ingredients:
        name = ing.get("name", "")
        amount = ing.get("amount", "")
        unit = ing.get("unit", "")
        ingredients_list.append(f"{amount} {unit} {name}".strip())
    ingredients_str = ", ".join(ingredients_list)
    text_to_encode = (
        f"Title: {recipe_data['title']}. Cuisine: {recipe_data['cuisine']}. "
        f"Difficulty: {recipe_data['difficulty']}. Ingredients: {ingredients_str}."
    )
    embedding = (await run_in_threadpool(ctx.embedding_model.encode, text_to_encode)).tolist()
    recipe_data["embedding"] = embedding
    recipe_data.setdefault("dietary", [])
    recipe_data.setdefault("image_url", "")

    insert_url = f"{ctx.supabase_url}/rest/v1/recipes"
    resp = await ctx.http_client.post(
        insert_url,
        headers=await _supabase_headers(ctx, prefer="return=representation"),
        json=recipe_data,
    )
    if resp.status_code >= 400:
        return {"error": f"Failed to insert recipe: {resp.text}"}
    data = resp.json()
    created = data[0] if isinstance(data, list) else data
    ctx.ui_actions.append({"type": "recipe_imported", "params": {"id": created.get("id"), "recipe": created}})
    return {"status": "ok", "id": created.get("id"), "title": created.get("title")}


TOOL_HANDLERS: dict[str, Callable] = {
    "search_recipes": tool_search_recipes,
    "get_recipe": tool_get_recipe,
    "get_current_step": tool_get_current_step,
    "navigate_step": tool_navigate_step,
    "set_timer": tool_set_timer,
    "cancel_timer": tool_cancel_timer,
    "scale_recipe": tool_scale_recipe,
    "convert_units": tool_convert_units,
    "suggest_substitution": tool_suggest_substitution,
    "select_recipe": tool_select_recipe,
    "start_cooking": tool_start_cooking,
    "add_to_shopping_list": tool_add_to_shopping_list,
    "save_note": tool_save_note,
    "recall_memories": tool_recall_memories,
    "import_recipe_from_url": tool_import_recipe_from_url,
}


async def execute_tool(name: str, args: dict, ctx: ToolContext) -> dict:
    handler = TOOL_HANDLERS.get(name)
    if not handler:
        return {"error": f"Unknown tool: {name}"}
    try:
        return await handler(args or {}, ctx)
    except Exception as e:
        print(f"Tool {name} failed: {e}")
        return {"error": str(e)}
