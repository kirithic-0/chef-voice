"""
Groq tool-calling agent loop for ChefVoice.

Groq exposes an OpenAI-compatible Chat Completions API, so the same request /
response shape (tools, tool_calls, streaming SSE) works unchanged. The endpoint
is configurable via ToolContext.llm_base_url, so any OpenAI-compatible provider
(Groq by default, or NVIDIA NIM, etc.) can be swapped in without code changes.
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Awaitable, Callable, Optional

import httpx

from tools import TOOL_DEFINITIONS, ToolContext, build_system_prompt, execute_tool, tools_for_screen

# Groq's OpenAI-compatible Chat Completions endpoint. Override per-request via
# ToolContext.llm_base_url (set from the LLM_BASE_URL env var in main.py).
GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"

# Tool-calling models on Groq. Override the primary via the GROQ_MODEL env var;
# the fallback is a smaller/faster model used on timeout or 5xx. Both support
# OpenAI-style function calling and are chosen for Groq's low latency.
DEFAULT_MODEL = "llama-3.3-70b-versatile"
FALLBACK_MODEL = "llama-3.1-8b-instant"
# Most turns need one tool call + a reply. Cap rounds low to save both requests
# (free-tier daily caps) and tokens (each round re-sends the whole context).
MAX_TOOL_ROUNDS = 2
TOOL_CALL_TIMEOUT = 25.0
STREAM_TIMEOUT = 45.0

# For the local Ollama provider (api_style="ollama"): how long Ollama keeps the
# model resident after a request. A whole session's turns then reuse the warm
# model (only the first turn pays the ~1-2 min cold load). Override via env.
OLLAMA_KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "30m")

# Verbose agent tracing is off by default; enable with CHEFVOICE_DEBUG=1.
DEBUG = os.getenv("CHEFVOICE_DEBUG", "").lower() in ("1", "true", "yes")


def _log(*args) -> None:
    if DEBUG:
        print(*args)


SendJson = Callable[[dict], Awaitable[None]]


def _build_chat_request(
    *,
    api_style: str,
    api_key: str,
    model: str,
    messages: list[dict],
    tools: Optional[list],
    tool_choice: Optional[str],
    stream: bool,
    temperature: float,
    max_tokens: int,
    extra_headers: Optional[dict],
    extra_body: Optional[dict],
) -> tuple[dict, dict]:
    """Build (headers, body) for the target dialect. Returns OpenAI or Ollama shape."""
    if api_style == "ollama":
        # Ollama's native /api/chat: no auth, params under `options`, and
        # `keep_alive` so the model stays warm between a session's turns.
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if extra_headers:
            headers.update(extra_headers)
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": stream,
            "keep_alive": OLLAMA_KEEP_ALIVE,
            "options": {"temperature": temperature, "num_predict": max_tokens},
        }
        if tools is not None:
            body["tools"] = tools
        # Ollama has no `tool_choice` (it auto-decides). extra_body carries
        # top-level fields like {"think": False}.
        if extra_body:
            body.update(extra_body)
        return headers, body

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if stream else "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": stream,
    }
    if tools is not None:
        body["tools"] = tools
    if tool_choice is not None:
        body["tool_choice"] = tool_choice
    if extra_body:
        body.update(extra_body)
    return headers, body


def _extract_message(api_style: str, data: dict) -> dict:
    """Pull the assistant message ({content, tool_calls, ...}) from a response."""
    if api_style == "ollama":
        return data.get("message") or {}
    return (data.get("choices") or [{}])[0].get("message") or {}


async def _llm_chat(
    http_client: Any,
    api_key: str,
    model: str,
    messages: list[dict],
    *,
    chat_url: str = GROQ_CHAT_URL,
    api_style: str = "openai",
    tools: Optional[list] = None,
    tool_choice: Optional[str] = None,
    stream: bool = False,
    temperature: float = 0.4,
    max_tokens: int = 512,
    timeout: float = TOOL_CALL_TIMEOUT,
    extra_headers: Optional[dict] = None,
    extra_body: Optional[dict] = None,
) -> Any:
    headers, body = _build_chat_request(
        api_style=api_style,
        api_key=api_key,
        model=model,
        messages=messages,
        tools=tools,
        tool_choice=tool_choice,
        stream=stream,
        temperature=temperature,
        max_tokens=max_tokens,
        extra_headers=extra_headers,
        extra_body=extra_body,
    )

    if stream:
        return http_client.stream("POST", chat_url, headers=headers, json=body, timeout=timeout)

    resp = await http_client.post(chat_url, headers=headers, json=body, timeout=timeout)
    return resp


async def _llm_chat_with_fallback(
    http_client: Any,
    api_key: str,
    model: str,
    messages: list[dict],
    *,
    chat_url: str = GROQ_CHAT_URL,
    api_style: str = "openai",
    fallback_model: Optional[str] = FALLBACK_MODEL,
    tools: Optional[list] = None,
    tool_choice: Optional[str] = None,
    temperature: float = 0.4,
    max_tokens: int = 512,
    timeout: float = TOOL_CALL_TIMEOUT,
    extra_headers: Optional[dict] = None,
    extra_body: Optional[dict] = None,
) -> tuple[Any, str]:
    """Call the LLM; on timeout/5xx, retry once with `fallback_model` (if set)."""

    async def _call(active_model: str):
        return await _llm_chat(
            http_client,
            api_key,
            active_model,
            messages,
            chat_url=chat_url,
            api_style=api_style,
            tools=tools,
            tool_choice=tool_choice,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
            extra_headers=extra_headers,
            extra_body=extra_body,
        )

    def _can_fallback(active: str) -> bool:
        return bool(fallback_model) and active != fallback_model

    active = model
    try:
        resp = await _call(active)
    except httpx.TimeoutException:
        if not _can_fallback(active):
            raise
        _log(f"[agent] timeout on {active}, falling back to {fallback_model}")
        active = fallback_model
        resp = await _call(active)

    if resp.status_code >= 500 and _can_fallback(active):
        _log(f"[agent] {active} returned {resp.status_code}, falling back to {fallback_model}")
        active = fallback_model
        resp = await _call(active)

    return resp, active


def _parse_tool_args(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


# Some models occasionally emit tool calls as TEXT inside the message content
# (e.g. `<navigate_step>{"direction": "next"}</navigate_step>` or
# `<function=navigate_step>{...}</function>`) instead of a structured tool_call.
# When that happens the tool never actually runs — so the UI never updates — and
# the raw markup leaks into the spoken reply. We detect these, run them for real,
# and strip them out of the text the user sees/hears.
_TOOL_NAMES = {t["function"]["name"] for t in TOOL_DEFINITIONS}

_INLINE_TOOL_PATTERNS = [
    # <navigate_step>{...}</navigate_step>
    re.compile(r"<\s*(?P<name>[a-zA-Z_][a-zA-Z0-9_]*)\s*>\s*(?P<args>\{.*?\})?\s*<\s*/\s*(?P=name)\s*>", re.DOTALL),
    # <function=navigate_step>{...}</function>
    re.compile(r"<\s*function\s*=\s*(?P<name>[a-zA-Z_][a-zA-Z0-9_]*)\s*>\s*(?P<args>\{.*?\})?\s*<\s*/\s*function\s*>", re.DOTALL),
]

# Stray formatting tokens some models sprinkle into content.
_STRAY_MARKUP_RE = re.compile(
    r"<\s*/?\s*function[^>]*>|<\|python_tag\|>|<\|eom_id\|>|<\|eot_id\|>",
    re.IGNORECASE,
)

# Reasoning models sometimes wrap chain-of-thought in <think>...</think> (or
# <thinking>/<reasoning>) inside the message content. Strip those so the CoT is
# never spoken, even if a provider fails to suppress reasoning. Also handles an
# unclosed opener (reasoning that runs to the end of the message).
_THINK_RE = re.compile(
    r"<\s*(think|thinking|reasoning)\s*>.*?(?:<\s*/\s*\1\s*>|\Z)",
    re.IGNORECASE | re.DOTALL,
)


def _extract_inline_tool_calls(text: str) -> tuple[list[tuple[str, dict]], str]:
    """Pull tool-call markup the model wrote as text. Returns (calls, cleaned_text)."""
    calls: list[tuple[str, dict]] = []
    cleaned = text or ""
    for pattern in _INLINE_TOOL_PATTERNS:
        def _repl(m: "re.Match") -> str:
            name = m.group("name")
            if name not in _TOOL_NAMES:
                return m.group(0)  # not a real tool — leave the text untouched
            calls.append((name, _parse_tool_args(m.group("args") or "{}")))
            return ""
        cleaned = pattern.sub(_repl, cleaned)
    return calls, cleaned


def _sanitize_spoken_text(text: str) -> str:
    """Strip any tool-call markup / stray tokens so the reply is clean speech."""
    if not text:
        return ""
    _, cleaned = _extract_inline_tool_calls(text)
    cleaned = _THINK_RE.sub(" ", cleaned)
    cleaned = _STRAY_MARKUP_RE.sub(" ", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


async def stream_final_text(
    http_client: Any,
    api_key: str,
    model: str,
    messages: list[dict],
    send_json: SendJson,
    *,
    chat_url: str = GROQ_CHAT_URL,
    api_style: str = "openai",
    max_tokens: int = 512,
    timeout: float = STREAM_TIMEOUT,
    extra_headers: Optional[dict] = None,
    extra_body: Optional[dict] = None,
) -> str:
    """Stream final assistant tokens to the client as ai_text_partial, return full text."""
    full = []
    headers, body = _build_chat_request(
        api_style=api_style,
        api_key=api_key,
        model=model,
        messages=messages,
        tools=None,
        tool_choice=None,
        stream=True,
        temperature=0.4,
        max_tokens=max_tokens,
        extra_headers=extra_headers,
        extra_body=extra_body,
    )
    async with http_client.stream(
        "POST",
        chat_url,
        headers=headers,
        json=body,
        timeout=timeout,
    ) as resp:
        if resp.status_code >= 400:
            err_body = await resp.aread()
            raise RuntimeError(f"LLM stream error {resp.status_code}: {err_body[:500]}")

        async for line in resp.aiter_lines():
            if not line:
                continue
            if api_style == "ollama":
                # Ollama streams newline-delimited JSON objects (not SSE):
                # {"message":{"content":"..."},"done":false} ... {"done":true}.
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    continue
                piece = (chunk.get("message") or {}).get("content") or ""
                if piece:
                    full.append(piece)
                    await send_json({"type": "ai_text_partial", "text": piece})
                if chunk.get("done"):
                    break
                continue
            # OpenAI SSE: lines prefixed with "data:", terminated by [DONE].
            if line.startswith("data:"):
                payload = line[5:].strip()
            else:
                continue
            if payload == "[DONE]":
                break
            try:
                chunk = json.loads(payload)
            except json.JSONDecodeError:
                continue
            delta = (chunk.get("choices") or [{}])[0].get("delta") or {}
            piece = delta.get("content") or ""
            if piece:
                full.append(piece)
                await send_json({"type": "ai_text_partial", "text": piece})

    return "".join(full).strip()


async def run_agent_turn(
    *,
    user_text: str,
    history: list[dict],
    ctx: ToolContext,
    send_json: SendJson,
    model: str = DEFAULT_MODEL,
) -> str:
    """
    Run tool-calling rounds, emit ui_actions, then stream/speak final text.
    Returns the final assistant text. Mutates history and ctx.cooking_state / ctx.ui_actions.
    """
    t0 = time.time()
    ctx.ui_actions.clear()
    chat_url = ctx.llm_base_url or GROQ_CHAT_URL
    api_style = ctx.api_style or "openai"
    # The "auto" sentinel means "use the built-in Groq fallback"; an explicit
    # None (e.g. OpenRouter, local) disables fallback; any other string is used as-is.
    fallback_model = FALLBACK_MODEL if ctx.fallback_model == "auto" else ctx.fallback_model
    extra_headers = ctx.extra_headers or None
    # extra_body is sent on tool-selection rounds; final_extra_body on the final
    # spoken-reply pass. When they differ (e.g. reasoning on for tools, off for
    # speech), we never speak a tool-round's content directly — we always
    # generate the reply with final_extra_body so no chain-of-thought leaks in.
    extra_body = ctx.extra_body or None
    final_extra_body = ctx.final_extra_body or None
    force_clean_final = final_extra_body != extra_body
    max_tokens = ctx.max_tokens or 512
    req_timeout = ctx.request_timeout or TOOL_CALL_TIMEOUT
    stream_timeout = ctx.stream_timeout or STREAM_TIMEOUT

    system = build_system_prompt(ctx.cooking_state)
    messages: list[dict] = [
        {"role": "system", "content": system},
        *history[-4:],
        {"role": "user", "content": user_text},
    ]
    # Offer only the tools relevant to the current screen (fewer schema tokens).
    active_tools = tools_for_screen(ctx.cooking_state.get("screen"))

    active_model = model
    final_text = ""

    for round_idx in range(MAX_TOOL_ROUNDS):
        _log(f"[agent] round={round_idx} model={active_model}")
        resp, active_model = await _llm_chat_with_fallback(
            ctx.http_client,
            ctx.llm_api_key,
            active_model,
            messages,
            chat_url=chat_url,
            api_style=api_style,
            fallback_model=fallback_model,
            tools=active_tools,
            tool_choice="auto",
            max_tokens=max_tokens,
            timeout=req_timeout,
            extra_headers=extra_headers,
            extra_body=extra_body,
        )

        if resp.status_code == 400 and fallback_model and active_model != fallback_model:
            # Some models reject tools; fall back once
            _log(f"[agent] model {active_model} rejected tools ({resp.text[:300]}), trying fallback")
            active_model = fallback_model
            resp, active_model = await _llm_chat_with_fallback(
                ctx.http_client,
                ctx.llm_api_key,
                active_model,
                messages,
                chat_url=chat_url,
                api_style=api_style,
                fallback_model=fallback_model,
                tools=active_tools,
                tool_choice="auto",
                max_tokens=max_tokens,
                timeout=req_timeout,
                extra_headers=extra_headers,
                extra_body=extra_body,
            )

        if resp.status_code >= 400:
            raise RuntimeError(f"LLM error {resp.status_code}: {resp.text[:800]}")

        data = resp.json()
        message = _extract_message(api_style, data)
        tool_calls = message.get("tool_calls") or []

        if tool_calls:
            # Append assistant message with tool_calls for the next round
            messages.append({
                "role": "assistant",
                "content": message.get("content") or None,
                "tool_calls": tool_calls,
            })
            for call in tool_calls:
                fn = call.get("function") or {}
                name = fn.get("name") or ""
                args = _parse_tool_args(fn.get("arguments"))
                call_id = call.get("id") or f"call_{name}"
                _log(f"[agent] tool={name} args={args}")
                # Surface the tool call in the UI (immersive "the agent is doing X").
                await send_json({"type": "ai_tool_call", "name": name, "args": args})
                result = await execute_tool(name, args, ctx)
                # Emit UI actions produced by this tool so far
                while ctx.ui_actions:
                    action = ctx.ui_actions.pop(0)
                    await send_json({"type": "ai_action", "action": action})
                messages.append({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": json.dumps(result),
                })
            continue

        # No structured tool calls. Some models instead emit tool calls as text;
        # recover and execute those for real so the UI updates, then continue so
        # the model produces a clean spoken reply from the tool results.
        content = message.get("content") or ""
        inline_calls, cleaned = _extract_inline_tool_calls(content)
        if inline_calls:
            _log(f"[agent] recovered {len(inline_calls)} inline tool call(s) from text")
            synthetic = [
                {
                    "id": f"inline_{i}",
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args)},
                }
                for i, (name, args) in enumerate(inline_calls)
            ]
            messages.append({
                "role": "assistant",
                "content": cleaned.strip() or None,
                "tool_calls": synthetic,
            })
            for i, (name, args) in enumerate(inline_calls):
                await send_json({"type": "ai_tool_call", "name": name, "args": args})
                result = await execute_tool(name, args, ctx)
                while ctx.ui_actions:
                    action = ctx.ui_actions.pop(0)
                    await send_json({"type": "ai_action", "action": action})
                messages.append({
                    "role": "tool",
                    "tool_call_id": f"inline_{i}",
                    "content": json.dumps(result),
                })
            continue

        # No tool calls. When the final reply must use a different config than the
        # tool rounds (e.g. reasoning off, so no chain-of-thought leaks into
        # speech), don't speak this round's content — fall through to the clean
        # final pass below. Otherwise take the content directly.
        if force_clean_final:
            break
        final_text = _sanitize_spoken_text(content)
        break
    # Prefer streaming final text for snappier UI when tools exhausted without content
    if not final_text:
        wrap_messages = list(messages)
        wrap_messages.append({
            "role": "user",
            "content": "Now reply to the user out loud in natural, friendly spoken language. Do not call tools and do not narrate any reasoning.",
        })
        try:
            final_text = await stream_final_text(
                ctx.http_client,
                ctx.llm_api_key,
                active_model,
                wrap_messages,
                send_json,
                chat_url=chat_url,
                api_style=api_style,
                max_tokens=max_tokens,
                timeout=stream_timeout,
                extra_headers=extra_headers,
                extra_body=final_extra_body,
            )
        except Exception as e:
            _log(f"[agent] stream failed, falling back to non-stream: {type(e).__name__}: {e!r}")
            resp = await _llm_chat(
                ctx.http_client,
                ctx.llm_api_key,
                active_model,
                wrap_messages,
                chat_url=chat_url,
                api_style=api_style,
                max_tokens=max_tokens,
                timeout=req_timeout,
                extra_headers=extra_headers,
                extra_body=final_extra_body,
            )
            resp.raise_for_status()
            final_text = (_extract_message(api_style, resp.json()).get("content") or "").strip()

    # Final safety net: never let tool markup reach the user's ears/screen.
    final_text = _sanitize_spoken_text(final_text)

    # Flush any remaining UI actions
    while ctx.ui_actions:
        action = ctx.ui_actions.pop(0)
        await send_json({"type": "ai_action", "action": action})

    elapsed = time.time() - t0
    _log(f"[agent] turn complete in {elapsed:.2f}s text_len={len(final_text)}")
    return final_text
