# ChefVoice: Voice-First Cooking Assistant

![ChefVoice Dashboard](./docs/screenshot.png)
*(Note: Please save the provided image as `screenshot.png` inside a `docs` folder in the root directory for this image to display correctly on GitHub/GitLab)*

ChefVoice is an advanced, hands-free AI-powered kitchen assistant that guides users step-by-step through recipes using continuous voice commands. It features real-time speech-to-text transcription, structured LLM-based navigation and timer routing, high-fidelity audio synthesis, and semantic vector search.

---

## ✨ Features in Detail

* **Voice-First Hands-Free Navigation:** Keep your hands on the food, not your phone. Navigate through recipe steps completely hands-free using natural language commands like *"next step"*, *"go back"*, *"repeat that"*, or *"what was the first step?"*.
* **Barge-In Capabilities:** The assistant is truly conversational. You can interrupt the AI mid-sentence by speaking over it, and it will immediately stop talking and listen to your new command.
* **Intelligent Timer Management:** The system understands time and context. Say *"set a 10-minute timer for the pasta"* and it will visually and audibly track it. You can query timers (*"how much time is left?"*) or cancel them verbally.
* **AI-Powered Semantic Search:** Instead of exact keyword matching, search for recipes conceptually. A query like *"creamy indian curry"* or *"sweet vegan treats"* will find relevant recipes based on meaning and context.
* **Proactive Allergen & Dietary Alerts:** User profiles store dietary restrictions. If an active recipe step involves a known allergen (e.g., nuts or dairy), the app displays persistent warning cards and alters voice prompts to ensure safety.
* **Personalized Kitchen Hub:** A beautifully designed dashboard (shown above) lets users filter recipes by cuisine, dietary preference (Veg/Non-Veg), explore recently cooked meals, manage favorites, and rate completed recipes.

---

## 🛠️ Technical Features in Detail

ChefVoice is built as a modern, high-performance web application utilizing streaming AI technologies and vector databases.

### 1. Real-Time Streaming Architecture (WebSockets)
To achieve conversational latency, the application bypasses standard REST APIs for core voice features. Audio is captured via the browser's **Web Audio API** and streamed over **WebSockets** to the FastAPI backend. The backend concurrently pipes this audio to Deepgram for real-time transcription, dramatically reducing time-to-first-byte (TTFB).

### 2. Multi-Modal AI Orchestration
The app strings together multiple AI models to create a cohesive experience:
* **Speech-to-Text (ASR):** Deepgram's `nova-2` streaming API provides sub-second, highly accurate transcription of user audio chunks.
* **LLM Intent Routing:** The transcribed text is sent to the **Groq API** (running `Llama-3.3-70b-versatile`). The LLM acts as an orchestrator, returning structured JSON to classify the user's intent (e.g., `NAVIGATION`, `TIMER_SET`, `TIMER_QUERY`, `GENERAL_CHAT`) and extracting relevant parameters.
* **Text-to-Speech (TTS):** Responses are synthesized using **ElevenLabs WebSocket Streaming API**, delivering high-fidelity, natural-sounding audio back to the client as a continuous stream.

### 3. Vector Database & Semantic Search (pgvector)
Traditional full-text search is replaced with a **Retrieval-Augmented Generation (RAG)** approach for recipe discovery:
* A local instance of `sentence-transformers/all-MiniLM-L6-v2` runs on the backend to generate dense vector embeddings for every recipe and search query.
* These embeddings are stored in a **Supabase PostgreSQL** database utilizing the **`pgvector`** extension.
* Searches are executed via custom SQL RPC functions that calculate the **cosine distance** between the query vector and recipe vectors, returning the most conceptually similar results instantly.

### 4. Robust Security & State Management
* **Row Level Security (RLS):** Supabase RLS policies are strictly enforced. All database queries natively scope down to `auth.uid() = user_id`, guaranteeing that favorites, cooking histories, and profiles are securely isolated per user.
* **Concurrency:** The Python backend utilizes Starlette concurrency thread-pools to ensure that heavy tasks (like local model inference for embeddings) do not block the main asynchronous event loop.

### 5. Premium Frontend Engineering
* **Stack:** Built with React, TypeScript, and Vite for a lightning-fast developer and user experience.
* **Design:** Styled with Tailwind CSS to create a highly polished, responsive, and accessible UI, featuring glassmorphism elements, dynamic filtering chips, and custom CSS waveforms driven by real-time microphone data.

---

## ⚙️ Setup & Installation

### 1. Prerequisites
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
