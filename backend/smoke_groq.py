"""
Live smoke test: does the real Groq model call the CORRECT tools?

Runs a handful of realistic kitchen utterances through the actual agent loop
against the live Groq API and checks that the model selects the expected tool
for each. Recipe search / DB are stubbed so this isolates ONE thing: the live
LLM's tool-selection behaviour (the "does the AI agent call the right steps?"
question). No embedding model is loaded, so it starts instantly.

Usage (from backend/, with GROQ_API_KEY set in .env or the environment):

    ./.venv/Scripts/python.exe smoke_groq.py
"""
from __future__ import annotations

import asyncio
import copy
import os
import re
import sys

import httpx
from dotenv import load_dotenv

import agent
import database as db

# Windows consoles are often cp1252; keep our output legible without crashing.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY") or os.getenv("LLM_API_KEY")
LLM_MODEL = os.getenv("GROQ_MODEL") or os.getenv("LLM_MODEL") or agent.DEFAULT_MODEL
LLM_BASE_URL = os.getenv("LLM_BASE_URL", agent.GROQ_CHAT_URL)


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


HOME = {"screen": "home", "recipe": None, "current_step": 0, "timers": []}
COOKING = {"screen": "cooking", "recipe": _recipe(4), "current_step": 1, "timers": []}
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


async def run() -> int:
    from tools import ToolContext

    # Free-tier Groq is ~6000 tokens/min; space out turns and retry on 429 so a
    # rate limit doesn't get mistaken for a tool-calling failure.
    gap = float(os.getenv("SMOKE_GAP", "12"))

    async with httpx.AsyncClient(timeout=45.0) as client:
        passed = 0
        print(f"\nGroq smoke test - model={LLM_MODEL}\n" + "=" * 60)
        for label, utterance, state, expected in SCENARIOS:
            reply, last_err = None, None
            for attempt in range(3):
                CALLED.clear()
                ctx = ToolContext(
                    cooking_state=copy.deepcopy(state),
                    user_id="smoke-user",
                    http_client=client,
                    embedding_model=FakeEmbed(),
                    llm_api_key=GROQ_API_KEY,
                    llm_model=LLM_MODEL,
                    llm_base_url=LLM_BASE_URL,
                )
                try:
                    reply = await agent.run_agent_turn(
                        user_text=utterance, history=[], ctx=ctx,
                        send_json=noop_send, model=LLM_MODEL,
                    )
                    break
                except Exception as e:
                    last_err = e
                    if "429" in str(e) and attempt < 2:
                        m = re.search(r"try again in ([\d.]+)s", str(e))
                        wait = (float(m.group(1)) + 1) if m else 8.0
                        print(f"[wait] {label:11} rate-limited; retrying in {wait:.0f}s")
                        await asyncio.sleep(wait)
                        continue
                    break

            if reply is None:
                print(f"[ERROR] {label:11} {type(last_err).__name__}: {str(last_err)[:120]}")
                await asyncio.sleep(gap)
                continue

            names = [n for n, _ in CALLED]
            ok = (len(names) == 0) if expected is None else (expected in names)
            passed += ok
            mark = "PASS" if ok else "FAIL"
            exp = expected or "(no tool)"
            print(f"[{mark}] {label:11} expect={exp:20} called={names or '[]'}")
            for n, a in CALLED:
                print(f"           -> {n}({a})")
            print(f"           reply: {reply[:90]}")
            await asyncio.sleep(gap)

        print("=" * 60)
        print(f"{passed}/{len(SCENARIOS)} scenarios selected the correct tool\n")
        return 0 if passed == len(SCENARIOS) else 1


def main() -> int:
    if not GROQ_API_KEY or len(GROQ_API_KEY) < 20:
        print(
            "GROQ_API_KEY is missing or looks truncated "
            f"(got {GROQ_API_KEY!r}).\n"
            "Set the full key in backend/.env (GROQ_API_KEY=gsk_...) and re-run.",
            file=sys.stderr,
        )
        return 2
    return asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(main())
