"""
Integration tests for the Groq tool-calling agent loop (agent.run_agent_turn).

These are hermetic: a fake OpenAI-compatible client feeds scripted Groq
responses into the loop, so we can assert the agent calls the *correct* tools,
threads tool results back, emits UI actions, and falls back on timeouts —
without any network access or API key.
"""
from __future__ import annotations

import json

import httpx
import pytest

import agent
import database as db
import tools


# --------------------------------------------------------------------------- #
# Fakes that mimic httpx.AsyncClient's OpenAI-compatible surface
# --------------------------------------------------------------------------- #

class FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code
        self.text = json.dumps(payload)

    def json(self) -> dict:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("error", request=None, response=self)  # type: ignore[arg-type]


class FakeStream:
    """Async context manager yielding SSE lines, like http_client.stream(...)."""

    def __init__(self, lines: list[str], status_code: int = 200):
        self._lines = lines
        self.status_code = status_code

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aread(self) -> bytes:
        return b""


class FakeGroqClient:
    """Returns scripted responses; records every request body for assertions."""

    def __init__(self, post_script: list, stream_script: list | None = None):
        self.post_script = list(post_script)
        self.stream_script = list(stream_script or [])
        self.calls: list[dict] = []

    async def post(self, url, headers=None, json=None, timeout=None):
        self.calls.append({"url": url, "body": json, "headers": headers or {}})
        item = self.post_script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def stream(self, method, url, headers=None, json=None, timeout=None):
        self.calls.append({"url": url, "body": json, "headers": headers or {}, "stream": True})
        return self.stream_script.pop(0)


def tool_call_response(name: str, args: dict, call_id: str = "call_1", content=None) -> FakeResponse:
    """A Groq assistant message that requests one tool call."""
    return FakeResponse({
        "choices": [{
            "message": {
                "role": "assistant",
                "content": content,
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args)},
                }],
            }
        }]
    })


def text_response(text: str) -> FakeResponse:
    """A plain Groq assistant message with no tool calls (final answer)."""
    return FakeResponse({"choices": [{"message": {"role": "assistant", "content": text}}]})


def sse(text: str) -> str:
    return "data: " + json.dumps({"choices": [{"delta": {"content": text}}]})


class _Vec:
    def tolist(self):
        return [0.0] * 384


class FakeEmbed:
    def encode(self, text):
        return _Vec()


def make_ctx(cooking_state=None, http_client=None):
    from tools import ToolContext
    return ToolContext(
        cooking_state=cooking_state if cooking_state is not None else {"screen": "home", "recipe": None, "current_step": 0, "timers": []},
        user_id="test-user",
        http_client=http_client,
        embedding_model=FakeEmbed(),
        llm_api_key="gsk_test",
        llm_model=agent.DEFAULT_MODEL,
        llm_base_url=agent.GROQ_CHAT_URL,
    )


async def collector():
    events: list[dict] = []

    async def _send(ev: dict):
        events.append(ev)

    return events, _send


def _recipe(n_steps: int) -> dict:
    return {
        "id": "r-test",
        "title": "Test Pasta",
        "cuisine": "Italian",
        "servings": 2,
        "ingredients": [{"name": "Pasta", "amount": "200", "unit": "g"}],
        "steps": [
            {"step": i + 1, "text": f"Step {i + 1} instructions", "timer_duration": None, "safety_alert": None}
            for i in range(n_steps)
        ],
    }


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_set_timer_tool_is_called_and_state_updates():
    """'set a timer for 10 minutes' -> agent calls set_timer, timer lands in state."""
    client = FakeGroqClient(post_script=[
        tool_call_response("set_timer", {"duration": 600, "label": "Pasta"}),
        text_response("Timer set for 10 minutes."),
    ])
    # Timers are a cooking-mode action, so the agent is offered the cooking tools.
    ctx = make_ctx(
        cooking_state={"screen": "cooking", "recipe": None, "current_step": 0, "timers": []},
        http_client=client,
    )
    events, send = await collector()

    final = await agent.run_agent_turn(
        user_text="set a timer for 10 minutes for the pasta",
        history=[], ctx=ctx, send_json=send, model=agent.DEFAULT_MODEL,
    )

    # The correct tool ran and mutated cooking state.
    assert len(ctx.cooking_state["timers"]) == 1
    assert ctx.cooking_state["timers"][0]["duration"] == 600
    # A UI action was emitted for the client.
    ui = [e for e in events if e["type"] == "ai_action"]
    assert any(a["action"]["type"] == "set_timer" for a in ui)
    # The first request advertised the tools and asked the model to choose.
    first_body = client.calls[0]["body"]
    assert first_body["tool_choice"] == "auto"
    assert any(t["function"]["name"] == "set_timer" for t in first_body["tools"])
    assert final == "Timer set for 10 minutes."


@pytest.mark.asyncio
async def test_navigate_step_advances_current_step():
    """While cooking, 'next step' -> navigate_step(next) advances the pointer."""
    state = {"screen": "cooking", "recipe": _recipe(3), "current_step": 0, "timers": []}
    client = FakeGroqClient(post_script=[
        tool_call_response("navigate_step", {"direction": "next"}),
        text_response("Step 2: Step 2 instructions"),
    ])
    ctx = make_ctx(cooking_state=state, http_client=client)
    events, send = await collector()

    final = await agent.run_agent_turn(
        user_text="what's the next step?",
        history=[], ctx=ctx, send_json=send, model=agent.DEFAULT_MODEL,
    )

    assert ctx.cooking_state["current_step"] == 1
    ui = [e for e in events if e["type"] == "ai_action"]
    assert any(a["action"]["type"] == "next_step" for a in ui)
    assert final


@pytest.mark.asyncio
async def test_small_talk_calls_no_tools():
    """A greeting should get a direct reply with zero tool calls."""
    client = FakeGroqClient(post_script=[text_response("Hi! Ready to cook something?")])
    ctx = make_ctx(http_client=client)
    events, send = await collector()

    final = await agent.run_agent_turn(
        user_text="hey there", history=[], ctx=ctx, send_json=send, model=agent.DEFAULT_MODEL,
    )

    assert len(client.calls) == 1                       # single round, no tool loop
    assert not [e for e in events if e["type"] == "ai_action"]
    assert final == "Hi! Ready to cook something?"


@pytest.mark.asyncio
async def test_timeout_falls_back_to_smaller_model():
    """A timeout on the primary model retries once on the fast fallback model."""
    client = FakeGroqClient(post_script=[
        httpx.TimeoutException("primary too slow"),
        text_response("Quick reply from the fallback model."),
    ])
    ctx = make_ctx(http_client=client)
    events, send = await collector()

    final = await agent.run_agent_turn(
        user_text="hello", history=[], ctx=ctx, send_json=send, model=agent.DEFAULT_MODEL,
    )

    assert final == "Quick reply from the fallback model."
    # The retry used the fallback model id.
    assert client.calls[1]["body"]["model"] == agent.FALLBACK_MODEL


@pytest.mark.asyncio
async def test_search_then_answer_threads_tool_result_back(monkeypatch):
    """'find a pasta recipe' -> search_recipes, then result is fed back for the reply."""
    monkeypatch.setattr(db, "search_recipes", lambda emb, match_count=6: [
        {"id": "r1", "title": "Weeknight Pasta", "cuisine": "Italian", "time": 20,
         "difficulty": "Easy", "similarity": 0.91},
    ])
    client = FakeGroqClient(post_script=[
        tool_call_response("search_recipes", {"query": "quick pasta"}),
        text_response("I found Weeknight Pasta — want to cook it?"),
    ])
    ctx = make_ctx(http_client=client)
    events, send = await collector()

    final = await agent.run_agent_turn(
        user_text="find me a quick pasta recipe",
        history=[], ctx=ctx, send_json=send, model=agent.DEFAULT_MODEL,
    )

    # UI got the search results.
    ui = [e for e in events if e["type"] == "ai_action"]
    assert any(a["action"]["type"] == "search_recipes" for a in ui)
    # Second round's messages include the tool result fed back to the model.
    second_msgs = client.calls[1]["body"]["messages"]
    assert any(m.get("role") == "tool" for m in second_msgs)
    assert final == "I found Weeknight Pasta — want to cook it?"


@pytest.mark.asyncio
async def test_inline_tool_call_in_text_is_recovered_and_executed():
    """Model emits `<navigate_step>{...}</navigate_step>` as TEXT instead of a
    real tool call: the agent must still run the tool (advancing the UI) and
    strip the markup from the spoken reply."""
    state = {"screen": "cooking", "recipe": _recipe(3), "current_step": 0, "timers": []}
    client = FakeGroqClient(post_script=[
        text_response('<navigate_step>{"direction": "next"}</navigate_step> Set the pan over medium heat.'),
        text_response("Set the pan over medium heat and cook for three minutes."),
    ])
    ctx = make_ctx(cooking_state=state, http_client=client)
    events, send = await collector()

    final = await agent.run_agent_turn(
        user_text="then go to the next step",
        history=[], ctx=ctx, send_json=send, model=agent.DEFAULT_MODEL,
    )

    # The tool actually ran: step advanced and a UI action was emitted.
    assert ctx.cooking_state["current_step"] == 1
    ui = [e for e in events if e["type"] == "ai_action"]
    assert any(a["action"]["type"] == "next_step" for a in ui)
    # The leaked markup never reaches the user.
    assert "<navigate_step>" not in final and "navigate_step" not in final


@pytest.mark.asyncio
async def test_cancel_timer_targets_the_specific_timer():
    """With several timers running, cancel_timer must remove the one the user means."""
    state = {
        "screen": "cooking",
        "timers": [
            {"id": "a", "label": "10-minute timer", "duration": 600, "timeLeft": 400},
            {"id": "b", "label": "pasta", "duration": 480, "timeLeft": 120},
            {"id": "c", "label": "5-minute timer", "duration": 300, "timeLeft": 250},
        ],
    }
    ctx = make_ctx(cooking_state=state)

    # By label fragment.
    res = await tools.tool_cancel_timer({"label": "pasta"}, ctx)
    assert res["status"] == "ok" and res["cancelled"]["id"] == "b"
    assert [t["id"] for t in ctx.cooking_state["timers"]] == ["a", "c"]

    # By spoken duration ("5 minute" -> the 300s timer).
    res = await tools.tool_cancel_timer({"label": "5 minute"}, ctx)
    assert res["status"] == "ok" and res["cancelled"]["id"] == "c"
    assert [t["id"] for t in ctx.cooking_state["timers"]] == ["a"]


@pytest.mark.asyncio
async def test_cancel_timer_is_ambiguous_without_a_label():
    """No label + multiple timers => ask which, don't guess."""
    state = {
        "screen": "cooking",
        "timers": [
            {"id": "a", "label": "eggs", "duration": 600, "timeLeft": 400},
            {"id": "b", "label": "rice", "duration": 480, "timeLeft": 120},
        ],
    }
    ctx = make_ctx(cooking_state=state)
    res = await tools.tool_cancel_timer({}, ctx)
    assert "error" in res
    assert len(ctx.cooking_state["timers"]) == 2  # nothing cancelled


def test_sanitize_spoken_text_strips_tool_markup():
    dirty = 'Sure! <navigate_step>{"direction": "next"}</navigate_step> Here we go. <function=set_timer>{}</function>'
    clean = agent._sanitize_spoken_text(dirty)
    assert "<" not in clean and ">" not in clean
    assert "navigate_step" not in clean and "function" not in clean
    assert "Here we go." in clean


@pytest.mark.asyncio
async def test_streams_final_text_when_tools_exhausted_without_content():
    """If the tool round yields no text, the agent streams a spoken wrap-up reply."""
    client = FakeGroqClient(
        post_script=[
            tool_call_response("set_timer", {"duration": 300, "label": "Eggs"}),
            text_response(""),  # tool round done, but model returns no spoken text
        ],
        stream_script=[FakeStream([sse("Your egg "), sse("timer is running."), "data: [DONE]"])],
    )
    ctx = make_ctx(http_client=client)
    events, send = await collector()

    final = await agent.run_agent_turn(
        user_text="start a 5 minute egg timer",
        history=[], ctx=ctx, send_json=send, model=agent.DEFAULT_MODEL,
    )

    partials = [e for e in events if e["type"] == "ai_text_partial"]
    assert partials, "expected streamed ai_text_partial events"
    assert final == "Your egg timer is running."


# --------------------------------------------------------------------------- #
# Local provider: Ollama's native /api/chat dialect (api_style="ollama").
# Response shape differs from OpenAI: the message lives at top-level `message`
# (no `choices`), tool-call `arguments` are already a dict, requests carry
# params under `options` + a top-level `think`/`keep_alive` and no auth header.
# --------------------------------------------------------------------------- #

def ollama_tool_call_response(name: str, args: dict, content: str = "") -> FakeResponse:
    """An Ollama assistant message requesting one tool call (arguments as a dict)."""
    return FakeResponse({
        "message": {
            "role": "assistant",
            "content": content,
            "tool_calls": [{"function": {"name": name, "arguments": args}}],
        }
    })


def ollama_text_response(text: str) -> FakeResponse:
    """A plain Ollama assistant message (no tool calls)."""
    return FakeResponse({"message": {"role": "assistant", "content": text}})


def ollama_ndjson(*pieces: str) -> FakeStream:
    """Ollama streams newline-delimited JSON objects, ending with {"done": true}."""
    lines = [json.dumps({"message": {"content": p}, "done": False}) for p in pieces]
    lines.append(json.dumps({"done": True}))
    return FakeStream(lines)


def make_ollama_ctx(cooking_state=None, http_client=None):
    from tools import ToolContext
    return ToolContext(
        cooking_state=cooking_state if cooking_state is not None else {"screen": "home", "recipe": None, "current_step": 0, "timers": []},
        user_id="test-user",
        http_client=http_client,
        embedding_model=FakeEmbed(),
        llm_api_key="local",
        llm_model="chefvoice-gemma",
        llm_base_url="http://localhost:11434/api/chat",
        api_style="ollama",
        fallback_model=None,
        extra_body={"think": False},
        final_extra_body={"think": False},
    )


@pytest.mark.asyncio
async def test_ollama_tool_call_selection_and_native_request_shape():
    """The ollama dialect: parse a top-level `message` with dict args, run the
    tool, and build the request in Ollama's native shape (options/think/keep_alive,
    no tool_choice, no max_tokens, no Authorization header)."""
    client = FakeGroqClient(post_script=[
        ollama_tool_call_response("set_timer", {"duration": 600, "label": "Pasta"}),
        ollama_text_response("Timer set for 10 minutes."),
    ])
    ctx = make_ollama_ctx(
        cooking_state={"screen": "cooking", "recipe": None, "current_step": 0, "timers": []},
        http_client=client,
    )
    events, send = await collector()

    final = await agent.run_agent_turn(
        user_text="set a timer for 10 minutes",
        history=[], ctx=ctx, send_json=send, model="chefvoice-gemma",
    )

    # Tool ran and mutated state (dict arguments needed no JSON-string parsing).
    assert len(ctx.cooking_state["timers"]) == 1
    assert ctx.cooking_state["timers"][0]["duration"] == 600
    ui = [e for e in events if e["type"] == "ai_action"]
    assert any(a["action"]["type"] == "set_timer" for a in ui)

    # First request was built in Ollama's native dialect, not OpenAI's.
    first = client.calls[0]
    body = first["body"]
    assert body["options"]["num_predict"] == ctx.max_tokens
    assert body["think"] is False
    assert "keep_alive" in body
    assert "tool_choice" not in body      # Ollama auto-decides
    assert "max_tokens" not in body       # params live under `options`
    assert "Authorization" not in first["headers"]  # local: no API key
    assert final == "Timer set for 10 minutes."


@pytest.mark.asyncio
async def test_tool_call_is_surfaced_to_ui():
    """Every tool the agent runs emits an ai_tool_call event so the UI can show a chip."""
    client = FakeGroqClient(post_script=[
        tool_call_response("set_timer", {"duration": 600, "label": "Pasta"}),
        text_response("Timer set for 10 minutes."),
    ])
    ctx = make_ctx(
        cooking_state={"screen": "cooking", "recipe": None, "current_step": 0, "timers": []},
        http_client=client,
    )
    events, send = await collector()

    await agent.run_agent_turn(
        user_text="set a 10 minute timer",
        history=[], ctx=ctx, send_json=send, model=agent.DEFAULT_MODEL,
    )

    tool_events = [e for e in events if e["type"] == "ai_tool_call"]
    assert any(e["name"] == "set_timer" and e["args"].get("duration") == 600 for e in tool_events)


@pytest.mark.asyncio
async def test_past_cooked_recipes_dedupes_newest_first(monkeypatch):
    """past_cooked_recipes returns the user's history, most-recent-per-recipe, de-duped."""
    monkeypatch.setattr(db, "list_cooking_history", lambda uid: [
        {"rating": 5, "duration_minutes": 20, "completed_at": "2026-08-01",
         "recipe": {"id": "r1", "title": "Weeknight Pasta", "cuisine": "Italian"}},
        {"rating": 4, "duration_minutes": 30, "completed_at": "2026-07-30",
         "recipe": {"id": "r1", "title": "Weeknight Pasta", "cuisine": "Italian"}},  # dup -> collapsed
        {"rating": 3, "duration_minutes": 15, "completed_at": "2026-07-20",
         "recipe": {"id": "r2", "title": "Greek Salad", "cuisine": "Greek"}},
    ])
    ctx = make_ctx()

    res = await tools.tool_past_cooked_recipes({}, ctx)

    assert [r["title"] for r in res["recipes"]] == ["Weeknight Pasta", "Greek Salad"]
    assert res["count"] == 2
    assert any(a["type"] == "past_cooked_recipes" for a in ctx.ui_actions)


@pytest.mark.asyncio
async def test_ollama_streams_final_text_from_ndjson():
    """When the tool round yields no text, the ollama streaming path parses
    newline-delimited JSON (not SSE) into a spoken reply."""
    client = FakeGroqClient(
        post_script=[
            ollama_tool_call_response("set_timer", {"duration": 300, "label": "Eggs"}),
            ollama_text_response(""),  # tool round done, no spoken text yet
        ],
        stream_script=[ollama_ndjson("Your egg ", "timer is running.")],
    )
    ctx = make_ollama_ctx(http_client=client)
    events, send = await collector()

    final = await agent.run_agent_turn(
        user_text="start a 5 minute egg timer",
        history=[], ctx=ctx, send_json=send, model="chefvoice-gemma",
    )

    partials = [e for e in events if e["type"] == "ai_text_partial"]
    assert partials, "expected streamed ai_text_partial events"
    assert final == "Your egg timer is running."
    # The streaming request was also native (think off, streaming on).
    stream_call = [c for c in client.calls if c.get("stream")][0]
    assert stream_call["body"]["think"] is False
    assert stream_call["body"]["stream"] is True
