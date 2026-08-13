# ChefVoice App

![ChefVoice Dashboard](./docs/screenshot.png)

A voice-first AI cooking assistant with real-time audio streaming, semantic recipe search, and a conversational web UI.

Navigate cooking steps hands-free, set smart timers, ask questions about ingredients, and receive high-fidelity spoken guidance — all powered by a streaming AI architecture. The entire app runs **locally with zero cloud dependencies**: data lives in a single SQLite file and authentication is self-hosted.

---

## Features

| Feature | Description |
| --- | --- |
| **Hands-Free Navigation** | Navigate through recipe steps completely hands-free using natural language commands like "next step" or "what was the first step?". |
| **Barge-In Capabilities** | The assistant is truly conversational. Interrupt the AI mid-sentence and it will instantly stop talking and listen to your new command. |
| **Real-Time Voice Synthesis** | ElevenLabs WebSocket Streaming API generates high-fidelity speech delivered as audio chunks for minimal latency. |
| **Semantic Search (RAG)** | Recipes are embedded with `all-MiniLM-L6-v2` and ranked by NumPy cosine similarity for meaning-based search — type "spicy creamy curry" and get the right dishes without keyword matches. |
| **Conversational LLM** | Groq (`Llama-3.3-70b-versatile`) acts as the orchestration brain, routing intents, maintaining context, and extracting parameters as structured JSON. |
| **Speech-to-Text Input** | Deepgram `nova-2` streaming API provides sub-second, highly accurate transcription of continuous audio streams. |
| **Intelligent Timers** | Context-aware timer management (e.g., "set a timer for the pasta"). Timers are fully controllable via voice. |
| **Proactive Dietary Alerts** | Persistent warning cards and altered voice prompts for allergens, based on per-user profiles stored locally. |
| **Local Auth & Profiles** | Self-hosted JWT authentication (bcrypt-hashed passwords). Favorites, cooking history, ratings, and an admin recipe portal are all scoped per user. |

---

## Getting Started

### Prerequisites
* Python 3.9+
* Node.js 16+ and npm
* API keys for the voice pipeline (optional — everything except the live voice assistant works without them):
  [Deepgram](https://deepgram.com/), [Groq](https://groq.com/), and [ElevenLabs](https://elevenlabs.io/)

There is **no database server to install** — the app creates a local SQLite file on first run.

### Local Development

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd texttovoice
   ```

2. **Install and run the backend**
   ```bash
   cd backend
   python -m venv .venv

   # Activate virtual environment
   # Windows: .venv\Scripts\activate
   # macOS/Linux: source .venv/bin/activate

   pip install -r requirements.txt

   # Configure environment (copy the example and fill in your keys + a JWT secret)
   cp .env.example .env

   # Create the SQLite database and generate recipe embeddings (run once)
   python seed.py

   # Start the FastAPI dev server on http://localhost:8000
   uvicorn main:app --reload
   ```

3. **Install and run the frontend (separate terminal)**
   ```bash
   cd frontend

   # Install Node dependencies
   npm install

   # Start the Vite dev server
   npm run dev
   ```

4. **Open in browser**
   Navigate to the URL provided by Vite (usually `http://localhost:5173`).
   Create an account with any username and password (stored locally in your SQLite database) and start cooking.

> **Tip:** To use the admin recipe portal, open **My Profile** and toggle **Admin Mode**.

---

## Environment Variables

**Backend (`backend/.env`)** — copy from `backend/.env.example`
| Variable | Required | Description |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | Voice only | Deepgram API key for real-time speech-to-text |
| `GROQ_API_KEY` | Voice only | Groq API key for Llama-3 intent routing |
| `ELEVENLABS_API_KEY` | Voice only | ElevenLabs API key for streaming text-to-speech |
| `JWT_SECRET` | Recommended | Secret for signing session tokens (use a long random string in production) |
| `FRONTEND_ORIGIN` | Optional | Comma-separated allowed CORS origins (default `http://localhost:5173,http://127.0.0.1:5173`) |
| `CHEFVOICE_DB` | Optional | Path to the SQLite file (default `backend/chefvoice.db`) |

**Frontend (`frontend/.env`)** — optional, copy from `frontend/.env.example`
| Variable | Description |
| --- | --- |
| `VITE_API_BASE_URL` | Backend base URL (default `http://localhost:8000`). The WebSocket URL is derived automatically. |

---

## Architecture Overview

### Tech Stack

#### Backend
| Technology | Purpose |
| --- | --- |
| **Python 3.9+** | Runtime language |
| **FastAPI** | Async web framework with robust WebSocket support |
| **SQLite** | Zero-config, single-file relational database |
| **Sentence-Transformers** | Local embedding generation (`all-MiniLM-L6-v2`) |
| **NumPy** | In-process cosine-similarity vector search |
| **PyJWT + bcrypt** | Self-hosted JWT authentication with hashed passwords |
| **Deepgram** | Streaming Speech-to-Text (ASR) engine |
| **Groq API** | Ultra-fast LLM orchestration (`Llama-3.3-70b-versatile`) |
| **ElevenLabs** | Streaming Text-to-Speech (TTS) synthesis |

#### Frontend
| Technology | Purpose |
| --- | --- |
| **React 19** | UI framework |
| **Vite** | Build tool and dev server |
| **Tailwind CSS 4** | Utility-first CSS styling and responsive design |
| **Web Audio API** | Low-latency audio capture and custom waveform visualization |
| **Web Speech API** | Fallback client-side speech synthesis |

### Data Layer
All persistence lives in a single SQLite file (`backend/chefvoice.db`) with tables for
`users`, `profiles`, `recipes`, `favorites`, `cooking_history`, and `conversations`.
List/array fields and the 384-dimension embeddings are stored as JSON text. Semantic
search loads recipe embeddings and ranks them by cosine similarity in `database.py` —
no external vector database required. Per-user data isolation is enforced in the API
layer by scoping every query to the authenticated user id from the JWT.

---

## API Reference

### Authentication — `/auth`
| Endpoint | Method | Description |
| --- | --- | --- |
| `/auth/signup` | `POST` | Create an account (`username`, `password`); returns a JWT |
| `/auth/login` | `POST` | Sign in; returns a JWT |
| `/auth/user` | `GET` | Return the authenticated user (validates the token) |

### WebSocket — `/ws/chat?token=<jwt>`
Real-time conversational voice interaction, streaming audio in and out.

* **Client → Server**: Client streams raw microphone audio captured via the Web Audio API, plus JSON control frames for cooking-state sync and text input.
* **Server → Client**: Server transcribes the audio, routes the intent through the LLM, and streams back synthesized speech audio chunks along with structured JSON events (e.g., timer triggers, navigation updates).

### REST — Recipes, Profile, Favorites, History
All REST endpoints require an `Authorization: Bearer <jwt>` header.

| Endpoint | Method | Description |
| --- | --- | --- |
| `/recipes` | `GET` | Fetch all recipes |
| `/recipes/search?query=...` | `GET` | Semantic vector search |
| `/recipes/{id}` | `GET` | Fetch a specific recipe |
| `/recipes` | `POST` | Create a recipe (admin only; embedding generated server-side) |
| `/recipes/{id}` | `DELETE` | Delete a recipe (admin only) |
| `/profile` | `GET` / `PUT` | Get or update the current user's profile (allergies, dietary preferences) |
| `/profile/admin` | `PUT` | Toggle the current user's admin flag |
| `/favorites` | `GET` / `POST` | List or add favorites |
| `/favorites/{recipe_id}` | `DELETE` | Remove a favorite |
| `/history` | `GET` / `POST` | List or log completed cooking sessions (with rating) |
| `/conversations` | `GET` / `POST` | Fetch or save voice-session transcripts |

---

## Testing

Backend tests use `pytest` and run against a temporary SQLite database.

```bash
cd backend
pytest test_backend.py -v
```

Frontend API-client tests use `vitest`.

```bash
cd frontend
npm test
```

Test coverage includes:
* Recipe fetching and structure validation
* Semantic RAG search precision (cosine similarity ranking)
* Authentication (signup/login, token validation)
* 404 handling for unknown recipes
