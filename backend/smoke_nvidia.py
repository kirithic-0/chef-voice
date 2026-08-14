"""
Live smoke test: does the NVIDIA Nemotron model (via OpenRouter) do tool calling?

Two parts:

  1. RAW PROBE  - one direct OpenAI-style Chat Completions call to OpenRouter
                  with a single `get_weather` tool. Confirms the model returns a
                  well-formed `tool_calls` structure at all (the ground-truth
                  "does function calling work on this endpoint" check).

  2. AGENT LOOP - runs realistic kitchen utterances through the actual ChefVoice
                  agent (agent.run_agent_turn) using the resolved "nvidia"
                  provider, and checks the model selects the EXPECTED tool for
                  each. Recipe search / DB are stubbed so this isolates the
                  live LLM's tool-selection behaviour.

Usage (from backend/, with OPEN_API_KEY set in .env or the environment):

    ./.venv/Scripts/python.exe smoke_nvidia.py

The default OpenRouter model here is NVIDIA Nemotron 3 Nano (fast, ~1-3s/call).
Timeouts come from the resolved provider config, so this works for any override
set via OPENROUTER_MODEL too.
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import sys
import time

import httpx
from dotenv import load_dotenv

import agent
import database as db
import providers

# Windows consoles are often cp1252; keep our output legible without crashing.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

load_dotenv()

PROVIDER = providers.resolve_provider("nvidia")

# The wide per-provider timeouts (request_timeout / stream_timeout) come from the
# provider config and are applied via the ToolContext below. Allow an override
# for the raw probe / when the free endpoint is especially slow.
PROBE_TIMEOUT = float(os.getenv("SMOKE_NVIDIA_TIMEOUT", str(PROVIDER["request_timeout"])))


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
    ("search",     "find me a quick pasta recipe",  dict(HOME),           "search_recipes"),
    ("set_timer",  "set a timer for 10 minutes",    dict(COOKING),        "set_timer"),
    ("navigate",   "okay, what's the next step?",   dict(COOKING),        "navigate_step"),
    ("cancel",     "cancel the pasta timer",        dict(COOKING_TIMERS), "cancel_timer"),
    ("small_talk", "hey, thanks so much!",          dict(HOME),           None),
]


async def noop_send(_event: dict):
    pass


# --------------------------------------------------------------------------- #
# Part 1: raw tool-calling probe
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
    print("Part 1 - raw tool-calling probe")
    print("-" * 60)
    headers = {
        "Authorization": f"Bearer {PROVIDER['api_key']}",
        "Content-Type": "application/json",
        **PROVIDER["extra_headers"],
    }
    body = {
        "model": PROVIDER["model"],
        "messages": [
            {"role": "system", "content": "You are a helpful assistant. Call a tool when it is appropriate."},
            {"role": "user", "content": "What's the weather in Paris right now?"},
        ],
        "tools": PROBE_TOOLS,
        "tool_choice": "auto",
        "temperature": 0.2,
        "max_tokens": PROVIDER["max_tokens"],
        **PROVIDER["extra_body"],
    }
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
    message = (data.get("choices") or [{}])[0].get("message") or {}
    tool_calls = message.get("tool_calls") or []
    if not tool_calls:
        print(f"[FAIL] no tool_calls returned in {dt:.1f}s. content={message.get('content')!r}")
        return False

    call = tool_calls[0]
    fn = call.get("function") or {}
    name = fn.get("name")
    try:
        args = json.loads(fn.get("arguments") or "{}")
    except json.JSONDecodeError:
        args = {"<unparseable>": fn.get("arguments")}

    ok = name == "get_weather" and isinstance(args, dict) and "city" in args
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] tool_calls in {dt:.1f}s -> {name}({args})")
    usage = data.get("usage") or {}
    if usage:
        print(f"       usage: {usage}")
    print()
    return ok


# --------------------------------------------------------------------------- #
# Part 2: agent-loop tool selection
# --------------------------------------------------------------------------- #

async def agent_scenarios(client: httpx.AsyncClient) -> tuple[int, int]:
    print("Part 2 - agent loop tool selection")
    print("-" * 60)
    gap = float(os.getenv("SMOKE_GAP", "2"))
    # SMOKE_MAX limits how many scenarios run (handy on a busy free tier).
    limit = int(os.getenv("SMOKE_MAX", str(len(SCENARIOS))))
    scenarios = SCENARIOS[:limit]
    passed = 0
    for label, utterance, state, expected in scenarios:
        CALLED.clear()
        t0 = time.time()
        # Hard wall-clock cap so a trickle-hanging free-tier response can't wedge
        # the whole run (httpx read-timeouts reset on each byte received).
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


async def run() -> int:
    print(f"\nOpenRouter NVIDIA smoke test")
    print(f"model     = {PROVIDER['model']}")
    print(f"endpoint  = {PROVIDER['base_url']}")
    print("=" * 60)
    async with httpx.AsyncClient(timeout=PROVIDER["stream_timeout"]) as client:
        probe_ok = await raw_probe(client)
        passed, total = await agent_scenarios(client)

    print("=" * 60)
    print(f"RAW PROBE: {'PASS' if probe_ok else 'FAIL'}   |   AGENT: {passed}/{total} correct")
    # Success = raw function calling works AND a majority of scenarios pass.
    return 0 if (probe_ok and passed >= total - 1) else 1


def main() -> int:
    key = PROVIDER["api_key"]
    if not key or len(key) < 20:
        print(
            "OPEN_API_KEY is missing or looks truncated "
            f"(got {key!r}).\n"
            "Set the full OpenRouter key in backend/.env (OPEN_API_KEY=sk-or-...) and re-run.",
            file=sys.stderr,
        )
        return 2
    return asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(main())
