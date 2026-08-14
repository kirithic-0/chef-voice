"""
Live smoke test: does the local Gemma model (served by Ollama) do tool calling?

Same two-part shape as smoke_nvidia.py, but for the local provider, which speaks
Ollama's NATIVE /api/chat dialect (params under `options`, `think: false`, reply
in `message`, tool-call `arguments` already a dict):

  1. RAW PROBE  - one direct /api/chat call with a single `get_weather` tool.
                  Ground-truth "does native function calling work" check.

  2. AGENT LOOP - realistic kitchen utterances through the real ChefVoice agent
                  (agent.run_agent_turn) using the resolved "local" provider,
                  checking the model selects the EXPECTED tool for each. Recipe
                  search / DB are stubbed to isolate the LLM's tool selection.

Prereqs: `ollama serve` running and the model imported once:
    ollama create chefvoice-gemma -f backend/Modelfile.gemma

Usage (from backend/):
    python smoke_local.py

The FIRST turn cold-loads ~16 GB into RAM+VRAM (~1-2 min); later turns are warm
(~1-4s) because the provider sends keep_alive. No API key needed.
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import socket
import sys
import time
from urllib.parse import urlparse

import httpx

import agent
import database as db
import providers

# Windows consoles are often cp1252; keep our output legible without crashing.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

PROVIDER = providers.resolve_provider("local")

# Wide per-provider timeouts (request_timeout / stream_timeout) come from the
# provider config; override the raw probe here if needed (cold load is slow).
PROBE_TIMEOUT = float(os.getenv("SMOKE_LOCAL_TIMEOUT", str(PROVIDER["request_timeout"])))


# --- Stub search so we test tool *selection*, not embeddings/DB quality. ------
class _Vec:
    def tolist(self):
        return [0.0] * 384


class FakeEmbed:
    def encode(self, text):
        return _Vec()


db.search_recipes = lambda emb, match_count=6: [
    {"id": "r1", "title": "Weeknight Pasta", "cuisine": "Italian", "time": 20,
     "difficulty": "Easy", "similarity": 0.9},
    {"id": "r2", "title": "Garlic Butter Shrimp", "cuisine": "American", "time": 15,
     "difficulty": "Easy", "similarity": 0.8},
]

# --- Record which tools the model actually calls, per turn. -------------------
CALLED: list[tuple[str, dict]] = []
_orig_execute = agent.execute_tool


async def _recording_execute(name, args, ctx):
    CALLED.append((name, args))
    return await _orig_execute(name, args, ctx)


agent.execute_tool = _recording_execute


def _make_ctx(state: dict, client: httpx.AsyncClient):
    from tools import ToolContext

    return ToolContext(
        cooking_state=copy.deepcopy(state),
        user_id="smoke-user",
        http_client=client,
        embedding_model=FakeEmbed(),
        llm_api_key=PROVIDER["api_key"],
        llm_model=PROVIDER["model"],
        llm_base_url=PROVIDER["base_url"],
        api_style=PROVIDER["api_style"],
        fallback_model=PROVIDER["fallback_model"],
        max_tokens=PROVIDER["max_tokens"],
        request_timeout=PROVIDER["request_timeout"],
        stream_timeout=PROVIDER["stream_timeout"],
        extra_headers=PROVIDER["extra_headers"],
        extra_body=PROVIDER["extra_body"],
        final_extra_body=PROVIDER["final_extra_body"],
    )


def _recipe(n_steps=4):
    return {
        "id": "r-test",
        "title": "Test Pasta",
        "cuisine": "Italian",
        "servings": 2,
        "ingredients": [{"name": "Pasta", "amount": "200", "unit": "g"}],
        "steps": [
            {"step": i + 1, "text": f"Step {i + 1}: do the thing.", "timer_duration": None, "safety_alert": None}
            for i in range(n_steps)
        ],
    }


HOME = {"screen": "home", "recipe": None, "current_step": 0, "timers": [], "dietary_preferences": []}
COOKING = {"screen": "cooking", "recipe": _recipe(4), "current_step": 1, "timers": [], "dietary_preferences": []}
COOKING_TIMERS = {
    **COOKING,
    "timers": [
        {"id": "t1", "label": "10-minute timer", "duration": 600, "timeLeft": 500},
        {"id": "t2", "label": "pasta", "duration": 480, "timeLeft": 300},
    ],
}

# (label, utterance, cooking_state, expected-tool | None for "no tool / small talk")
SCENARIOS = [
    ("search",     "find me a quick pasta recipe",       dict(HOME),           "search_recipes"),
    ("past_cooked","what recipes have i cooked before?", dict(HOME),           "past_cooked_recipes"),
    ("set_timer",  "set a timer for 10 minutes",         dict(COOKING),        "set_timer"),
    ("navigate",   "okay, what's the next step?",        dict(COOKING),        "navigate_step"),
    ("cancel",     "cancel the pasta timer",             dict(COOKING_TIMERS), "cancel_timer"),
    # Substitutions are answered from the model's own knowledge now (no tool, no
    # "I can't do that" refusal) — check that no tool fires and read the reply.
    ("substitute", "i'm out of butter, what can i use instead?", dict(COOKING), None),
    ("small_talk", "hey, thanks so much!",               dict(HOME),           None),
]


async def noop_send(_event: dict):
    pass


# --------------------------------------------------------------------------- #
# Part 1: raw tool-calling probe (Ollama native /api/chat)
# --------------------------------------------------------------------------- #

PROBE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather for a given city.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string", "description": "City name, e.g. 'Paris'"},
                },
                "required": ["city"],
            },
        },
    }
]


async def raw_probe(client: httpx.AsyncClient) -> bool:
    print("Part 1 - raw tool-calling probe (native /api/chat)")
    print("-" * 60)
    headers = {"Content-Type": "application/json", **PROVIDER["extra_headers"]}
    body = {
        "model": PROVIDER["model"],
        "messages": [
            {"role": "system", "content": "You are a helpful assistant. Call a tool when it is appropriate."},
            {"role": "user", "content": "What's the weather in Paris right now?"},
        ],
        "tools": PROBE_TOOLS,
        "stream": False,
        "options": {"temperature": 0.2, "num_predict": PROVIDER["max_tokens"]},
        **PROVIDER["extra_body"],  # {"think": False}
    }
    print(f"(first call cold-loads the model; up to {PROBE_TIMEOUT:.0f}s)")
    t0 = time.time()
    try:
        resp = await client.post(PROVIDER["base_url"], headers=headers, json=body, timeout=PROBE_TIMEOUT)
    except Exception as e:
        print(f"[FAIL] request error: {type(e).__name__}: {e}")
        return False
    dt = time.time() - t0

    if resp.status_code >= 400:
        print(f"[FAIL] HTTP {resp.status_code}: {resp.text[:400]}")
        return False

    data = resp.json()
    message = data.get("message") or {}
    tool_calls = message.get("tool_calls") or []
    if not tool_calls:
        print(f"[FAIL] no tool_calls returned in {dt:.1f}s. content={message.get('content')!r}")
        return False

    fn = (tool_calls[0].get("function") or {})
    name = fn.get("name")
    args = fn.get("arguments")  # Ollama returns a dict, not a JSON string
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except json.JSONDecodeError:
            args = {"<unparseable>": args}

    ok = name == "get_weather" and isinstance(args, dict) and "city" in args
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] tool_calls in {dt:.1f}s -> {name}({args})")
    print()
    return ok


# --------------------------------------------------------------------------- #
# Part 2: agent-loop tool selection
# --------------------------------------------------------------------------- #

async def agent_scenarios(client: httpx.AsyncClient) -> tuple[int, int]:
    print("Part 2 - agent loop tool selection")
    print("-" * 60)
    gap = float(os.getenv("SMOKE_GAP", "0"))  # local has no rate limits
    limit = int(os.getenv("SMOKE_MAX", str(len(SCENARIOS))))
    scenarios = SCENARIOS[:limit]
    passed = 0
    for label, utterance, state, expected in scenarios:
        CALLED.clear()
        t0 = time.time()
        hard_cap = float(os.getenv("SMOKE_SCENARIO_CAP", "240"))
        try:
            reply = await asyncio.wait_for(
                agent.run_agent_turn(
                    user_text=utterance,
                    history=[],
                    ctx=_make_ctx(state, client),
                    send_json=noop_send,
                    model=PROVIDER["model"],
                ),
                timeout=hard_cap,
            )
        except Exception as e:
            print(f"[ERROR] {label:11} {type(e).__name__}: {str(e)[:160]}")
            await asyncio.sleep(gap)
            continue
        dt = time.time() - t0

        names = [n for n, _ in CALLED]
        ok = (len(names) == 0) if expected is None else (expected in names)
        passed += ok
        mark = "PASS" if ok else "FAIL"
        exp = expected or "(no tool)"
        print(f"[{mark}] {label:11} expect={exp:16} called={names or '[]'} ({dt:.1f}s)")
        for n, a in CALLED:
            print(f"           -> {n}({a})")
        if reply:
            print(f"           reply: {reply[:160]}")
        await asyncio.sleep(gap)

    print("-" * 60)
    print(f"{passed}/{len(scenarios)} scenarios selected the correct tool")
    return passed, len(scenarios)


def _server_up(base_url: str) -> bool:
    try:
        p = urlparse(base_url)
        with socket.create_connection((p.hostname or "localhost", p.port or 11434), timeout=1.0):
            return True
    except OSError:
        return False


async def run() -> int:
    print(f"\nLocal Ollama smoke test")
    print(f"model     = {PROVIDER['model']}")
    print(f"endpoint  = {PROVIDER['base_url']}")
    print("=" * 60)
    async with httpx.AsyncClient(timeout=PROVIDER["stream_timeout"]) as client:
        probe_ok = await raw_probe(client)
        passed, total = await agent_scenarios(client)

    print("=" * 60)
    print(f"RAW PROBE: {'PASS' if probe_ok else 'FAIL'}   |   AGENT: {passed}/{total} correct")
    return 0 if (probe_ok and passed >= total - 1) else 1


def main() -> int:
    if not _server_up(PROVIDER["base_url"]):
        print(
            f"Ollama isn't reachable at {PROVIDER['base_url']}.\n"
            "Start it with `ollama serve` and make sure the model is imported:\n"
            "    ollama create chefvoice-gemma -f backend/Modelfile.gemma",
            file=sys.stderr,
        )
        return 2
    return asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(main())
