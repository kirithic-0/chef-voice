"""
NVIDIA NIM tool-calling agent loop for ChefVoice.
"""
from __future__ import annotations

import json
import time
from typing import Any, Awaitable, Callable, Optional

import httpx

from tools import TOOL_DEFINITIONS, ToolContext, build_system_prompt, execute_tool

NVIDIA_CHAT_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
# Mistral NeMo family on NIM (classic NeMo-12B is not enabled on many keys).
DEFAULT_MODEL = "mistralai/mistral-nemotron"
FALLBACK_MODEL = "mistralai/mistral-nemotron"
MAX_TOOL_ROUNDS = 4
TOOL_CALL_TIMEOUT = 25.0
STREAM_TIMEOUT = 45.0


SendJson = Callable[[dict], Awaitable[None]]


async def _nvidia_chat(
    http_client: Any,
    api_key: str,
    model: str,
    messages: list[dict],
    *,
    tools: Optional[list] = None,
    tool_choice: Optional[str] = None,
    stream: bool = False,
    temperature: float = 0.4,
    max_tokens: int = 512,
    timeout: float = TOOL_CALL_TIMEOUT,
) -> Any:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if stream else "application/json",
    }
    body: dict[str, Any] = {
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

    if stream:
        return http_client.stream("POST", NVIDIA_CHAT_URL, headers=headers, json=body, timeout=timeout)

    resp = await http_client.post(NVIDIA_CHAT_URL, headers=headers, json=body, timeout=timeout)
    return resp


async def _nvidia_chat_with_fallback(
    http_client: Any,
    api_key: str,
    model: str,
    messages: list[dict],
    *,
    tools: Optional[list] = None,
    tool_choice: Optional[str] = None,
    temperature: float = 0.4,
    max_tokens: int = 512,
) -> tuple[Any, str]:
    """Call NIM; on timeout/5xx, retry once with FALLBACK_MODEL if different."""
    active = model
    try:
        resp = await _nvidia_chat(
            http_client,
            api_key,
            active,
            messages,
            tools=tools,
            tool_choice=tool_choice,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=TOOL_CALL_TIMEOUT,
        )
    except httpx.TimeoutException:
        if active == FALLBACK_MODEL:
            raise
        print(f"[agent] timeout on {active}, falling back to {FALLBACK_MODEL}")
        active = FALLBACK_MODEL
        resp = await _nvidia_chat(
            http_client,
            api_key,
            active,
            messages,
            tools=tools,
            tool_choice=tool_choice,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=TOOL_CALL_TIMEOUT,
        )

    if resp.status_code >= 500 and active != FALLBACK_MODEL:
        print(f"[agent] {active} returned {resp.status_code}, falling back to {FALLBACK_MODEL}")
        active = FALLBACK_MODEL
        resp = await _nvidia_chat(
            http_client,
            api_key,
            active,
            messages,
            tools=tools,
            tool_choice=tool_choice,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=TOOL_CALL_TIMEOUT,
        )

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


async def stream_final_text(
    http_client: Any,
    api_key: str,
    model: str,
    messages: list[dict],
    send_json: SendJson,
) -> str:
    """Stream final assistant tokens to the client as ai_text_partial, return full text."""
    full = []
    async with http_client.stream(
        "POST",
        NVIDIA_CHAT_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
        json={
            "model": model,
            "messages": messages,
            "temperature": 0.4,
            "max_tokens": 512,
            "stream": True,
        },
        timeout=STREAM_TIMEOUT,
    ) as resp:
        if resp.status_code >= 400:
            err_body = await resp.aread()
            raise RuntimeError(f"NVIDIA stream error {resp.status_code}: {err_body[:500]}")

        async for line in resp.aiter_lines():
            if not line:
                continue
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

    system = build_system_prompt(ctx.cooking_state)
    messages: list[dict] = [
        {"role": "system", "content": system},
        *history[-8:],
        {"role": "user", "content": user_text},
    ]

    active_model = model
    final_text = ""

    for round_idx in range(MAX_TOOL_ROUNDS):
        print(f"[agent] round={round_idx} model={active_model}")
        resp, active_model = await _nvidia_chat_with_fallback(
            ctx.http_client,
            ctx.nvidia_api_key,
            active_model,
            messages,
            tools=TOOL_DEFINITIONS,
            tool_choice="auto",
        )

        if resp.status_code == 400 and active_model != FALLBACK_MODEL:
            # Some cloud models reject tools; fall back once
            print(f"[agent] model {active_model} rejected tools ({resp.text[:300]}), trying fallback")
            active_model = FALLBACK_MODEL
            resp, active_model = await _nvidia_chat_with_fallback(
                ctx.http_client,
                ctx.nvidia_api_key,
                active_model,
                messages,
                tools=TOOL_DEFINITIONS,
                tool_choice="auto",
            )

        if resp.status_code >= 400:
            raise RuntimeError(f"NVIDIA error {resp.status_code}: {resp.text[:800]}")

        data = resp.json()
        message = (data.get("choices") or [{}])[0].get("message") or {}
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
                print(f"[agent] tool={name} args={args}")
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

        # No tool calls — take content as final (may stream a polished reply)
        final_text = (message.get("content") or "").strip()
        break
    # Prefer streaming final text for snappier UI when tools exhausted without content
    if not final_text:
        wrap_messages = list(messages)
        wrap_messages.append({
            "role": "user",
            "content": "Please give your spoken reply to the user now based on the tool results. No more tools. Natural language only.",
        })
        try:
            final_text = await stream_final_text(
                ctx.http_client,
                ctx.nvidia_api_key,
                active_model,
                wrap_messages,
                send_json,
            )
        except Exception as e:
            print(f"[agent] stream failed, falling back to non-stream: {type(e).__name__}: {e!r}")
            resp = await _nvidia_chat(
                ctx.http_client,
                ctx.nvidia_api_key,
                active_model,
                wrap_messages,
                max_tokens=512,
                timeout=TOOL_CALL_TIMEOUT,
            )
            resp.raise_for_status()
            final_text = ((resp.json().get("choices") or [{}])[0].get("message") or {}).get("content") or ""
            final_text = final_text.strip()

    # Flush any remaining UI actions
    while ctx.ui_actions:
        action = ctx.ui_actions.pop(0)
        await send_json({"type": "ai_action", "action": action})

    elapsed = time.time() - t0
    print(f"[agent] turn complete in {elapsed:.2f}s text_len={len(final_text)}")
    return final_text
