# ChefVoice: Voice-First Cooking Assistant

ChefVoice is an advanced, hands-free AI-powered kitchen assistant that guides users step-by-step through recipes using continuous voice commands. It features real-time speech-to-text transcription, structured LLM-based navigation and timer routing, high-fidelity audio synthesis, and semantic vector search.

---

## 🚀 Key Features

* **Hands-Free Cooking Navigation**: Navigate steps using voice commands (e.g., *"next"*, *"go back"*, *"repeat step"*, *"start cooking"*).
* **Barge-In Capabilities**: Interrupt the assistant's speech at any point by speaking over it.
* **Proactive Allergen Checks**: Displays persistent warning cards when active steps involve allergens defined in the user's profile.
* **Intelligent Timer Management**: Set, query, and cancel timers verbally (e.g., *"set a 5 minute timer"*).
* **AI-Powered Semantic Search**: Search for recipes using conceptual queries (e.g., *"creamy indian curry"* or *"sweet vegan treats"*) powered by a local transformer model and `pgvector`.
* **Kitchen Logs & Profiles**: Save favorites, manage dietary restrictions, and log cooked recipes with ratings.

---

## 🛠️ Tech Stack

### Frontend (Web)
* **Core**: React, TypeScript, Tailwind CSS, Vite.
* **Web Audio API**: Real-time microphone capture and custom Canvas Waveform visualization.
* **Client-Side TTS**: Web Speech API for zero-cost standard voice synthesis.

### Backend (API)
* **Framework**: FastAPI (Python), WebSockets (real-time streaming).
* **Vector Models**: `sentence-transformers/all-MiniLM-L6-v2` locally hosted for query encoding.
* **Orchestration**: Starlette concurrency thread-pools for event loop safety.

### Database & Security
* **Database**: Supabase / PostgreSQL.
* **Search Engine**: `pgvector` extension for cosine distance vector search.
* **Security**: Row Level Security (RLS) policies matching `auth.uid() = user_id`.

### External AI APIs
* **Speech-to-Text (ASR)**: Deepgram Streaming API (`nova-2` model).
* **Reasoning / LLM**: Groq API (Llama-3.3-70b-versatile).
* **Text-to-Speech (TTS)**: ElevenLabs WebSocket Streaming API (Premium Voice).

---

## ⚙️ Setup & Installation

### 1. Prerequisites
Ensure you have the following installed:
* [Python 3.9+](https://www.python.org/downloads/)
* [Node.js 16+](https://nodejs.org/)
* [Git](https://git-scm.com/)
* A [Supabase](https://supabase.com/) account.

---

### 2. Backend Setup
1. Navigate to the backend folder:
   ```bash
   cd backend
   ```
2. Create a virtual environment and activate it:
   ```bash
   python -m venv .venv
   # On Windows (cmd):
   .venv\Scripts\activate
   # On Windows (PowerShell):
   .venv\Scripts\Activate.ps1
   # On macOS/Linux:
   source .venv/bin/activate
   ```
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Create a `.env` file in the `backend/` directory:
   ```env
   DEEPGRAM_API_KEY=your_deepgram_api_key
   GROQ_API_KEY=your_groq_api_key
   ELEVENLABS_API_KEY=your_elevenlabs_api_key
   SUPABASE_URL=your_supabase_url
   SUPABASE_SERVICE_KEY=your_supabase_anon_or_service_key
   ```
5. Run migrations on your Supabase Postgres Database using the scripts provided in `backend/schema.sql` and `backend/migration.sql`.
6. Seed recipe embeddings:
   ```bash
   python seed_embeddings.py
   ```
7. Start the FastAPI server:
   ```bash
   uvicorn main:app --reload
   ```

---

### 3. Frontend Setup
1. Navigate to the frontend folder:
   ```bash
   cd ../frontend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file in the `frontend/` directory:
   ```env
   VITE_SUPABASE_URL=your_supabase_url
   VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
   ```
4. Start the Vite development server:
   ```bash
   npm run dev
   ```

---

## 🧪 Testing
To run the automated FastAPI test suite, run the following in the `backend/` folder:
```bash
pytest test_backend.py
```
