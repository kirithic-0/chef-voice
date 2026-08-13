# ChefVoice Learning Checklist

Session goal: deeply understand the agent upgrade (NVIDIA tools, grounded search, kitchen tools, Web Speech only, product layer). Check items only after you can explain them in your own words.

## Stage 1 — The problem (why we change anything)

- [ ] What the old pipeline did (STT → Groq JSON blob → client actions → TTS)
- [ ] Why prompt-forced JSON is brittle (hallucinated actions, no tool results back to the model)
- [ ] Why `search_recipes` felt “dumb” (frontend searched; model never saw hits)
- [ ] Why allergies / ElevenLabs are being removed from this work
- [ ] Why NVIDIA replaces Groq (same OpenAI-style API, your env key)

## Stage 2 — The solution (what + how + design decisions)

- [ ] Tool-calling agent loop (tool rounds → execute → feed results → final speech text)
- [ ] Server-owned `cooking_state` vs client `ai_action` sync
- [ ] `search_recipes` as a real tool (pgvector → model → spoken grounded answer)
- [ ] Deterministic kitchen tools (navigate, timers, scale, convert) and why not LLM math
- [ ] Web Speech only path (`ai_text` + `ai_audio_none`; no cloud TTS)

## Stage 3 — Broader impact

- [ ] What breaks if tools fail or return empty results
- [ ] What the frontend must handle (new action types, no allergen UI, no ElevenLabs toggle)
- [ ] Shopping list / memory / recipe import and how they plug into the same tool loop
- [ ] Env surface: `NVIDIA_API_KEY`, `DEEPGRAM_API_KEY`, `VITE_WS_URL` (no Groq/ElevenLabs)

## Setup you must do once

1. Put `NVIDIA_API_KEY` in `backend/.env` (you said this is done).
2. Run SQL in Supabase: `backend/migration_agent.sql` (shopping list + memories tables).
3. Restart backend: `uvicorn main:app --reload` from `backend/`.

## Quiz log

### Stage 1 quiz
_Pending your answers in chat._

### Stage 2 quiz
_Pending_

### Stage 3 quiz
_Pending_
