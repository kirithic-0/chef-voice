"""
ChefVoice tool schemas and deterministic executors.

Tools run on the server. Results go back into the Groq agent loop.
UI sync events are collected as `ui_actions` for the WebSocket client.
"""
from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from fastapi.concurrency import run_in_threadpool

import database as db
import retrieval

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

TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "search_recipes",
            "description": (
                "Hybrid semantic + keyword search over the recipe catalog. Use when the user "
                "wants to find or browse recipes. Pass is_veg, min_time or max_time when the user "
                "states such a constraint — they filter the catalog properly, which describing "
                "them in the query text does not (a time limit especially: the search cannot "
                "compare durations from the query text, only from these fields). Returns nothing "
                "when no recipe is a real match; say so rather than inventing one."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural language search query"},
                    "is_veg": {
                        "type": "boolean",
                        "description": "True for vegetarian only, false for non-vegetarian only. Omit if unstated.",
                    },
                    "min_time": {
                        "type": "integer",
                        "description": (
                            "Minimum total cooking time in minutes; keeps recipes at least this long. "
                            "Use for 'longer/more than', 'over', 'at least'. Inclusive, so for a strict "
                            "'more than 20 minutes' pass 21, and for 'at least 20' pass 20. Omit if unstated."
                        ),
                    },
                    "max_time": {
                        "type": "integer",
                        "description": (
                            "Maximum total cooking time in minutes; keeps recipes no longer than this. "
                            "Use for 'under', 'less than', 'within', 'quick'. Inclusive, so for a strict "
                            "'under 20 minutes' pass 19. Omit if unstated."
                        ),
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "past_cooked_recipes",
            "description": (
                "List the recipes THIS user has cooked before (their own cooking history), "
                "newest first. Use it for general chat about what they've made — 'what have I "
                "cooked?', 'what did I make last week?', 'suggest something I've cooked before', "
                "'cook that again'. General-chat/home tool only."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "Max recipes to return (default 6)"}
                },
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
            "description": (
                "Cancel one running timer. Identify it with `label` — use the exact "
                "label or a duration like '10 minute' when several timers are running "
                "so the right one is cancelled. Omit `label` only when a single timer "
                "is active. Active timers and their labels are listed in the context."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "label": {
                        "type": "string",
                        "description": "Timer label, label fragment, or duration (e.g. 'pasta', '10 minute').",
                    },
                },
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

# Tool subsets by screen. Offering only the relevant tools per screen trims the
# tool-schema tokens sent on every request (and nudges the model toward the right
# action). Inline-text tool recovery in agent.py still knows the full set.
#
# The two chats are deliberately separate: recipe DISCOVERY tools (search_recipes,
# past_cooked_recipes) belong to the general/home chat ONLY, so the in-recipe
# cooking chat can't wander off to search or list history — it stays focused on
# guiding the current recipe.
_HOME_TOOL_NAMES = {"search_recipes", "past_cooked_recipes", "get_recipe", "select_recipe", "start_cooking", "import_recipe_from_url"}
_COOKING_TOOL_NAMES = {"get_current_step", "navigate_step", "set_timer", "cancel_timer"}


def tools_for_screen(screen: Optional[str]) -> list[dict[str, Any]]:
    """Return only the TOOL_DEFINITIONS relevant to the current screen."""
    names = _COOKING_TOOL_NAMES if screen == "cooking" else _HOME_TOOL_NAMES
    return [t for t in TOOL_DEFINITIONS if t["function"]["name"] in names]


@dataclass
class ToolContext:
    cooking_state: dict[str, Any]
    user_id: str
    http_client: Any
    embedding_model: Any
    llm_api_key: str
    llm_model: str
    # OpenAI-compatible chat endpoint (Groq by default; set from LLM_BASE_URL).
    llm_base_url: str = "https://api.groq.com/openai/v1/chat/completions"
    # Request/response dialect: "openai" (Groq, OpenRouter) or "ollama" (local
    # /api/chat). The agent branches on this; everything else stays shared.
    api_style: str = "openai"
    # Per-provider request tweaks, set by main.py from the selected provider.
    # fallback_model: the "auto" sentinel means "use the agent's built-in Groq
    # fallback"; None means "no fallback" (e.g. OpenRouter has no cheap sibling
    # wired up); any other string is used verbatim.
    fallback_model: Optional[str] = "auto"
    max_tokens: int = 512
    # Per-request timeouts (seconds). None -> use the agent's built-in defaults.
    request_timeout: Optional[float] = None
    stream_timeout: Optional[float] = None
    # Extra HTTP headers / request-body fields merged into each LLM call (e.g.
    # OpenRouter attribution headers, reasoning-model controls). extra_body is
    # sent on tool-selection rounds; final_extra_body on the final spoken-reply
    # pass (lets us keep reasoning on for tool choice but off for clean speech).
    extra_headers: dict[str, Any] = field(default_factory=dict)
    extra_body: dict[str, Any] = field(default_factory=dict)
    final_extra_body: dict[str, Any] = field(default_factory=dict)
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

    recipe_context = "None"
    step_context = "None"
    if recipe:
        steps = recipe.get("steps", []) or []
        ingredients = recipe.get("ingredients", []) or []
        # Compact ingredient list ("2 tbsp Olive oil, ...") instead of full JSON.
        ing_str = ", ".join(
            " ".join(str(p) for p in (i.get("amount"), i.get("unit"), i.get("name")) if p).strip()
            for i in ingredients
        ) or "None"
        # Only the current step (+ immediate neighbors) is included here — NOT
        # every step — to keep the per-request token cost low. The model reads
        # step text verbatim from the navigate_step / get_current_step results.
        recipe_context = (
            f"Title: {recipe.get('title')}\n"
            f"Cuisine: {recipe.get('cuisine')}\n"
            f"Servings: {recipe.get('servings')}\n"
            f"Ingredients: {ing_str}\n"
            f"Total steps: {len(steps)}"
        )
        if 0 <= current_step_idx < len(steps):
            curr_step = steps[current_step_idx]
            step_context = f"Step {current_step_idx + 1} of {len(steps)}: {curr_step.get('text')}"
            if curr_step.get("safety_alert"):
                step_context += f" (SAFETY ALERT: {curr_step.get('safety_alert')})"
            if curr_step.get("timer_duration"):
                step_context += f" (Suggested Timer: {curr_step.get('timer_duration')} seconds)"
            if current_step_idx + 1 < len(steps):
                step_context += f"\nNext (Step {current_step_idx + 2}): {steps[current_step_idx + 1].get('text')}"
            if current_step_idx - 1 >= 0:
                step_context += f"\nPrevious (Step {current_step_idx}): {steps[current_step_idx - 1].get('text')}"

    return (
        "You are ChefVoice, a hands-free kitchen voice assistant.\n"
        "Help the user find a recipe, then guide them through cooking it hands-free.\n"
        "Your tools: search_recipes, past_cooked_recipes, get_recipe, select_recipe, "
        "import_recipe_from_url, start_cooking, get_current_step, navigate_step, set_timer, cancel_timer. "
        "You CAN suggest ingredient substitutions from your own cooking knowledge: if the user "
        "asks what to use instead of an ingredient, give a sensible swap (with a rough amount) and "
        "a quick note on how it changes the dish. You still cannot scale recipes, convert units, "
        "manage a shopping list, or save notes; if asked for those, say so briefly.\n"
        "You do NOT have the recipe catalog memorized. To find, recommend, or name ANY recipe "
        "you MUST call the search_recipes tool first, and only mention recipes it returns — "
        "never invent recipe names or answer recipe requests from your own knowledge. "
        "When the user describes a dish or asks for ideas (screen 'home' or 'detail'), call "
        "search_recipes, then read back the top suggestions by name so they can pick one to cook. "
        "To answer what the user has cooked before, or to recommend from their history, call "
        "past_cooked_recipes (available in general chat only).\n"
        "ALWAYS take actions by calling the provided tools/functions through the tool-calling "
        "mechanism. To move between steps you MUST call the navigate_step tool — never just "
        "describe the move. To start a timer, call set_timer. Do not act by writing text.\n"
        "NEVER write a tool call, function name, XML/HTML tag, angle brackets, or JSON in your "
        "reply. Your reply is read aloud, so it must be plain spoken sentences only — "
        "no markup like <navigate_step> and no code.\n"
        "For simple greetings or small talk (hi, hello, thanks), reply briefly in spoken language without calling tools.\n"
        "After tools finish, reply with natural spoken text only (no JSON, no markdown).\n"
        "When navigating or repeating a step, read that step's instructions completely and verbatim.\n"
        "For general cooking questions, answer directly without rereading the full step.\n"
        "If the screen is 'cooking', do not search or select other recipes unless the user clearly asks to leave cooking mode.\n\n"
        f"Current Screen: {screen}\n"
        f"Current Active Recipe Details:\n{recipe_context}\n"
        f"Current Active Cooking Step:\n{step_context}\n"
        f"Active Running Timers: {json.dumps(timers)}\n"
    )


async def tool_search_recipes(args: dict, ctx: ToolContext) -> dict:
    """The agent's recipe search. Same pipeline as the HTTP endpoint, no extra LLM hop.

    Query normalization deliberately is NOT applied here. A voice turn is already
    STT -> LLM decides to call this -> tool -> LLM composes the reply -> TTS; adding an LLM
    rewrite inside the tool would make that two serial LLM round-trips per turn. It would also
    be redundant, because the agent already passes a cleaned `query`.
    """
    query = (args.get("query") or "").strip()
    if not query:
        return {"results": []}

    # Models are inconsistent about types: some emit {"min_time": 21}, others
    # {"min_time": "20"}. A string here would reach Filters.matches() and raise on
    # `int(recipe_time) < "20"`, so coerce to int and drop anything unparseable.
    def _as_minutes(value: Any) -> Optional[int]:
        if value is None:
            return None
        try:
            minutes = int(float(value))
        except (TypeError, ValueError):
            return None
        return minutes if minutes > 0 else None

    filters = retrieval.Filters(
        is_veg=args.get("is_veg"),
        min_time=_as_minutes(args.get("min_time")),
        max_time=_as_minutes(args.get("max_time")),
    )
    results = await run_in_threadpool(
        lambda: retrieval.search(query, limit=6, filters=filters)
    )
    slim = [
        {
            "id": r.get("id"),
            "title": r.get("title"),
            "cuisine": r.get("cuisine"),
            "time": r.get("time"),
            "difficulty": r.get("difficulty"),
            "is_veg": r.get("is_veg"),
            "similarity": r.get("similarity"),
        }
        for r in results
    ]
    ctx.ui_actions.append({
        "type": "search_recipes",
        "params": {"query": query, "results": results},
    })
    return {"query": query, "results": slim}


async def tool_past_cooked_recipes(args: dict, ctx: ToolContext) -> dict:
    """The user's cooking history (general-chat only). De-duped to most-recent per recipe."""
    try:
        limit = max(1, min(int(args.get("limit") or 6), 20))
    except (TypeError, ValueError):
        limit = 6
    history = db.list_cooking_history(ctx.user_id)
    slim = []
    seen = set()
    for entry in history:
        recipe = entry.get("recipe") or {}
        rid = recipe.get("id")
        if not rid or rid in seen:
            continue
        seen.add(rid)
        slim.append({
            "id": rid,
            "title": recipe.get("title"),
            "cuisine": recipe.get("cuisine"),
            "rating": entry.get("rating"),
            "duration_minutes": entry.get("duration_minutes"),
            "cooked_at": entry.get("completed_at"),
        })
        if len(slim) >= limit:
            break
    ctx.ui_actions.append({"type": "past_cooked_recipes", "params": {"results": slim}})
    return {"count": len(slim), "recipes": slim}


async def tool_get_recipe(args: dict, ctx: ToolContext) -> dict:
    recipe = db.get_recipe(args.get("id"))
    if not recipe:
        return {"error": "Recipe not found"}
    return {"recipe": recipe}


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


def _humanize_duration(seconds: int) -> str:
    """A distinct default label so multiple timers can be told apart."""
    if seconds >= 3600 and seconds % 3600 == 0:
        return f"{seconds // 3600}-hour timer"
    if seconds >= 60 and seconds % 60 == 0:
        return f"{seconds // 60}-minute timer"
    if seconds >= 60:
        return f"{seconds // 60}m {seconds % 60}s timer"
    return f"{seconds}-second timer"


def _duration_from_text(text: str) -> Optional[int]:
    """Parse a spoken duration ('10 minute', '90 sec', '5') into seconds."""
    m = re.search(r"(\d+)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)?", text.lower())
    if not m:
        return None
    n = int(m.group(1))
    unit = m.group(2) or ""
    if unit.startswith(("hour", "hr")):
        return n * 3600
    if unit.startswith(("sec",)):
        return n
    if unit.startswith(("min",)):
        return n * 60
    return n * 60  # bare number in a kitchen usually means minutes


def _timer_summary(timers: list[dict]) -> list[dict]:
    return [{"label": t.get("label"), "timeLeft": t.get("timeLeft")} for t in timers]


async def tool_set_timer(args: dict, ctx: ToolContext) -> dict:
    duration = int(args.get("duration", 0))
    if duration <= 0:
        return {"error": "duration must be positive seconds"}
    raw = (args.get("label") or "").strip()
    # Give unlabeled/generic timers a distinct name so they can be cancelled precisely.
    label = raw if raw and raw.lower() not in {"cooking timer", "timer"} else _humanize_duration(duration)
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
    timers = list(ctx.cooking_state.get("timers") or [])
    if not timers:
        return {"error": "There are no active timers to cancel."}

    label = (args.get("label") or "").strip()

    if not label:
        # Only unambiguous when a single timer is running.
        if len(timers) == 1:
            match = timers[0]
        else:
            return {
                "error": "Multiple timers are running — ask the user which one to cancel.",
                "timers": _timer_summary(timers),
            }
    else:
        low = label.lower()
        # 1) exact label, 2) label fragment, 3) matching duration.
        candidates = [t for t in timers if str(t.get("label", "")).lower() == low]
        if not candidates:
            candidates = [t for t in timers if low in str(t.get("label", "")).lower()]
        if not candidates:
            secs = _duration_from_text(label)
            if secs is not None:
                candidates = [t for t in timers if int(t.get("duration", 0)) == secs]
        if not candidates:
            return {"error": f"No timer matches '{label}'.", "timers": _timer_summary(timers)}
        if len(candidates) > 1:
            return {
                "error": f"Several timers match '{label}' — ask the user which one to cancel.",
                "matches": _timer_summary(candidates),
            }
        match = candidates[0]

    timers = [t for t in timers if t.get("id") != match.get("id")]
    ctx.cooking_state["timers"] = timers
    ctx.ui_actions.append({"type": "cancel_timer", "params": {"label": match.get("label"), "id": match.get("id")}})
    return {"status": "ok", "cancelled": {"label": match.get("label"), "id": match.get("id")}}


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


async def tool_import_recipe_from_url(args: dict, ctx: ToolContext) -> dict:
    # Same admin gate as POST /recipes and POST /recipes/import: this writes to
    # the shared catalogue. Gating only the HTTP endpoint would just move the
    # bypass to the voice socket, which reaches this function directly.
    if not db.is_admin(ctx.user_id):
        return {"error": "Only an admin can import recipes into the catalogue."}

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
    messages = [
        {"role": "system", "content": extract_prompt},
        {"role": "user", "content": text},
    ]
    if ctx.api_style == "ollama":
        # Ollama native /api/chat: no auth, params under `options`, reply in
        # `message.content`. extra_body carries top-level fields like think.
        body = {
            "model": ctx.llm_model,
            "messages": messages,
            "stream": False,
            "options": {"temperature": 0.2},
        }
        headers = {"Content-Type": "application/json", **(ctx.extra_headers or {})}
        if ctx.extra_body:
            body.update(ctx.extra_body)
    else:
        body = {
            "model": ctx.llm_model,
            "messages": messages,
            "temperature": 0.2,
        }
        headers = {
            "Authorization": f"Bearer {ctx.llm_api_key}",
            "Content-Type": "application/json",
            **(ctx.extra_headers or {}),
        }
        if ctx.extra_body:
            body.update(ctx.extra_body)
    try:
        nresp = await ctx.http_client.post(ctx.llm_base_url, headers=headers, json=body, timeout=60.0)
        nresp.raise_for_status()
        payload = nresp.json()
        message = payload.get("message") if ctx.api_style == "ollama" else payload["choices"][0]["message"]
        content = (message.get("content") or "").strip()
        content = re.sub(r"^```json\s*|\s*```$", "", content, flags=re.I | re.M).strip()
        recipe_data = json.loads(content)
    except Exception as e:
        return {"error": f"Failed to extract recipe: {e}"}

    required = ["title", "cuisine", "time", "difficulty", "servings", "ingredients", "steps"]
    for field_name in required:
        if field_name not in recipe_data:
            return {"error": f"Extracted recipe missing field: {field_name}"}

    recipe_data.setdefault("dietary", [])
    recipe_data.setdefault("image_url", "")
    # Use db.build_recipe_text rather than assembling the document here: a second copy of the
    # template drifts the moment the first one changes, and imported recipes would silently
    # end up embedded differently from every other recipe in the catalog.
    text_to_encode = db.build_recipe_text(recipe_data)
    embedding = (await run_in_threadpool(ctx.embedding_model.encode, text_to_encode)).tolist()

    created = db.create_recipe(recipe_data, embedding)
    ctx.ui_actions.append({"type": "recipe_imported", "params": {"id": created.get("id"), "recipe": created}})
    return {"status": "ok", "id": created.get("id"), "title": created.get("title")}


TOOL_HANDLERS: dict[str, Callable] = {
    "search_recipes": tool_search_recipes,
    "past_cooked_recipes": tool_past_cooked_recipes,
    "get_recipe": tool_get_recipe,
    "get_current_step": tool_get_current_step,
    "navigate_step": tool_navigate_step,
    "set_timer": tool_set_timer,
    "cancel_timer": tool_cancel_timer,
    "select_recipe": tool_select_recipe,
    "start_cooking": tool_start_cooking,
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
