"""
LLM provider registry for ChefVoice.

Every provider here is an OpenAI-compatible Chat Completions endpoint, so the
tool-calling agent loop in agent.py runs against any of them unchanged — only
the base URL, API key, model id, and a couple of request tweaks differ. The
frontend's model selector sends a provider key ("llama" or "nvidia") in the
voice-session state, and main.py resolves it here per turn.

Keys and model overrides are read from the environment lazily (in
resolve_provider) so they pick up whatever load_dotenv() populated at startup,
regardless of import order.
"""
from __future__ import annotations

import os
from typing import Optional

GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"


def _first_env(*names: str) -> Optional[str]:
    """Return the first non-empty environment variable among `names`."""
    for name in names:
        value = os.getenv(name)
        if value and value.strip():
            return value.strip()
    return None


# Static provider definitions. Anything env-derived (API keys, model/base-url
# overrides) is applied later in resolve_provider().
_PROVIDERS: dict[str, dict] = {
    "llama": {
        "id": "llama",
        "label": "Llama 3.3 70B (Groq)",
        "base_url": GROQ_CHAT_URL,
        "base_url_env": ("LLM_BASE_URL",),
        "model": "llama-3.3-70b-versatile",
        "model_env": ("GROQ_MODEL", "LLM_MODEL"),
        # Smaller/faster Groq sibling, used automatically on timeout or 5xx.
        "fallback_model": "llama-3.1-8b-instant",
        "api_key_env": ("GROQ_API_KEY", "LLM_API_KEY"),
        # Spoken replies are short; a tight cap saves output tokens.
        "max_tokens": 300,
        # Groq is fast; keep the snappy real-time budgets.
        "request_timeout": 25.0,
        "stream_timeout": 45.0,
        "extra_headers": {},
        # extra_body: sent on tool-selection rounds. final_extra_body: sent on
        # the final spoken-reply pass. Groq needs neither.
        "extra_body": {},
        "final_extra_body": {},
    },
    "nvidia": {
        "id": "nvidia",
        "label": "Nemotron 3 Nano (OpenRouter)",
        "base_url": OPENROUTER_CHAT_URL,
        "base_url_env": ("OPENROUTER_BASE_URL",),
        # Free NVIDIA Nemotron 3 Nano 30B (A3B MoE) on OpenRouter: supports tools,
        # 256k ctx, and — unlike the 550B Ultra — answers in ~1-3s and holds up
        # under rapid repeated calls without the free-tier throttling/hangs that
        # made Ultra unusable for a real-time voice loop.
        "model": "nvidia/nemotron-3-nano-30b-a3b:free",
        "model_env": ("OPENROUTER_MODEL",),
        # OpenRouter has no cheap sibling wired up here — no auto-fallback.
        "fallback_model": None,
        "api_key_env": ("OPEN_API_KEY", "OPENROUTER_API_KEY"),
        # Reasoning is off for the spoken reply, so a tight cap is plenty.
        "max_tokens": 300,
        # Fast model, but give the free tier a little more headroom than Groq.
        "request_timeout": 45.0,
        "stream_timeout": 60.0,
        # Optional but recommended by OpenRouter for attribution / rankings.
        "extra_headers": {
            "HTTP-Referer": "http://localhost:5173",
            "X-Title": "ChefVoice",
        },
        # Split reasoning by phase (see agent.run_agent_turn):
        #  - extra_body (tool-selection rounds): reasoning ON — it's what makes
        #    the model reliably CALL tools instead of just describing them.
        #  - final_extra_body (spoken-reply pass): reasoning OFF — phrasing the
        #    result needs no reasoning, and turning it off guarantees the CoT
        #    never bleeds into the spoken text (this model sometimes dumps raw,
        #    untagged reasoning into `content`, which no sanitizer can catch).
        "extra_body": {"reasoning": {"enabled": True}},
        "final_extra_body": {"reasoning": {"enabled": False}},
    },
}

# Friendly aliases the frontend (or an env default) may send.
_ALIASES: dict[str, str] = {
    "llama": "llama",
    "groq": "llama",
    "nvidia": "nvidia",
    "nemotron": "nvidia",
    "openrouter": "nvidia",
}

# Provider used when the client sends nothing (or something unknown).
DEFAULT_PROVIDER = _ALIASES.get(
    os.getenv("DEFAULT_MODEL_PROVIDER", "llama").strip().lower(), "llama"
)


def normalize_provider(name: Optional[str]) -> str:
    """Map a client-supplied provider name to a canonical key ('llama'|'nvidia')."""
    if name:
        key = _ALIASES.get(str(name).strip().lower())
        if key:
            return key
    return DEFAULT_PROVIDER


def resolve_provider(name: Optional[str]) -> dict:
    """
    Return a fully-resolved provider config for `name`, with env applied:

        {id, label, base_url, model, fallback_model, api_key, max_tokens,
         extra_headers, extra_body}

    `api_key` is None when the provider's key isn't configured — callers should
    surface a clear "not configured" error rather than calling the API.
    """
    key = normalize_provider(name)
    spec = _PROVIDERS[key]
    return {
        "id": spec["id"],
        "label": spec["label"],
        "base_url": _first_env(*spec["base_url_env"]) or spec["base_url"],
        "model": _first_env(*spec["model_env"]) or spec["model"],
        "fallback_model": spec["fallback_model"],
        "api_key": _first_env(*spec["api_key_env"]),
        "max_tokens": spec["max_tokens"],
        "request_timeout": spec["request_timeout"],
        "stream_timeout": spec["stream_timeout"],
        "extra_headers": dict(spec["extra_headers"]),
        "extra_body": dict(spec["extra_body"]),
        "final_extra_body": dict(spec["final_extra_body"]),
    }


def list_providers() -> list[dict]:
    """Public metadata for the UI: which providers exist and whether each is ready."""
    out = []
    for key, spec in _PROVIDERS.items():
        out.append(
            {
                "id": spec["id"],
                "label": spec["label"],
                "model": _first_env(*spec["model_env"]) or spec["model"],
                "available": _first_env(*spec["api_key_env"]) is not None,
                "default": key == DEFAULT_PROVIDER,
            }
        )
    return out
