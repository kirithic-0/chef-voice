import os
import json
import asyncio
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
import httpx
import websockets
import jwt
from dotenv import load_dotenv
from sentence_transformers import SentenceTransformer

import database as db
import auth
import providers
from agent import run_agent_turn
from tools import ToolContext

load_dotenv()

# Third-party API keys for the real-time voice pipeline.
# Deepgram = streaming speech-to-text (required for the voice socket to work).
# Text-to-speech is handled client-side with the browser Web Speech API.
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")

# LLM provider is chosen per session by the client's model selector and resolved
# via providers.resolve_provider() ("llama" = Groq, "nvidia" = OpenRouter
# Nemotron). Both are OpenAI-compatible, so the agent loop is unchanged.

# Comma-separated list of allowed frontend origins (defaults to the Vite dev server).
FRONTEND_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "FRONTEND_ORIGIN",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if o.strip()
]

app = FastAPI(title="ChefVoice Backend")

# CORS: we authenticate with bearer tokens (not cookies), so credentials are off
# and origins are restricted to the known frontend hosts.
app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize the local embedding model used for semantic recipe search (RAG).
print("Loading sentence-transformers/all-MiniLM-L6-v2 model...")
embedding_model = SentenceTransformer("all-MiniLM-L6-v2")

# Create the SQLite database and schema on startup.
db.init_db()


# --------------------------------------------------------------------------- #
# Request models
# --------------------------------------------------------------------------- #

class Credentials(BaseModel):
    username: str
    password: str


class ProfileUpdate(BaseModel):
    allergies: list[str] = []
    dietary_preferences: list[str] = []


class AdminUpdate(BaseModel):
    is_admin: bool


class FavoriteCreate(BaseModel):
    recipe_id: str


class HistoryCreate(BaseModel):
    recipe_id: str
    duration_minutes: int | None = None
    rating: int | None = None


class ConversationCreate(BaseModel):
    title: str = ""
    messages: list[dict] = []


class RecipeCreate(BaseModel):
    title: str
    cuisine: str
    time: int
    difficulty: str
    servings: int
    dietary: list[str] = []
    image_url: str | None = None
    ingredients: list[dict]
    steps: list[dict]


class ShoppingItemCreate(BaseModel):
    name: str
    quantity: str = ""
    unit: str = ""
    checked: bool = False


class ShoppingItemUpdate(BaseModel):
    name: str | None = None
    quantity: str | None = None
    unit: str | None = None
    checked: bool | None = None


class MemoryCreate(BaseModel):
    note: str
    recipe_id: str | None = None


class ImportRequest(BaseModel):
    url: str


# --------------------------------------------------------------------------- #
# Auth helpers
# --------------------------------------------------------------------------- #

def get_current_user(request: Request) -> dict:
    """FastAPI dependency: validate the bearer token and return {id, username}."""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    token = auth_header.split(" ", 1)[1]
    try:
        payload = auth.decode_token(token)
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")
    return {"id": user_id, "username": payload.get("username")}


def require_admin(user: dict) -> None:
    if not db.is_admin(user["id"]):
        raise HTTPException(status_code=403, detail="Forbidden: Admin access required.")


# --------------------------------------------------------------------------- #
# Authentication endpoints
# --------------------------------------------------------------------------- #

@app.post("/auth/signup")
def signup(creds: Credentials):
    username = creds.username.strip().lower()
    if not username or not creds.password:
        raise HTTPException(status_code=400, detail="Username and password are required.")
    if len(creds.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")
    if db.get_user_by_username(username):
        raise HTTPException(status_code=409, detail="That username is already taken.")

    user = db.create_user(username, auth.hash_password(creds.password))
    token = auth.create_token(user["id"], user["username"])
    return {"token": token, "user": user}


@app.post("/auth/login")
def login(creds: Credentials):
    username = creds.username.strip().lower()
    row = db.get_user_by_username(username)
    if not row or not auth.verify_password(creds.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    user = {"id": row["id"], "username": row["username"]}
    token = auth.create_token(user["id"], user["username"])
    return {"token": token, "user": user}


@app.get("/auth/user")
def get_authenticated_user(user: dict = Depends(get_current_user)):
    return user


# --------------------------------------------------------------------------- #
# LLM provider catalogue (drives the frontend's model selector)
# --------------------------------------------------------------------------- #

@app.get("/providers")
def get_providers():
    """List selectable LLM providers and whether each has an API key configured."""
    return providers.list_providers()


# --------------------------------------------------------------------------- #
# Recipe endpoints
# --------------------------------------------------------------------------- #

@app.get("/recipes")
def get_recipes(user: dict = Depends(get_current_user)):
    return db.list_recipes()


@app.get("/recipes/search")
async def search_recipes(query: str, user: dict = Depends(get_current_user)):
    if not query:
        return []
    query_embedding = await run_in_threadpool(embedding_model.encode, query)
    return db.search_recipes(query_embedding.tolist(), match_count=6)


@app.get("/recipes/{recipe_id}")
def get_single_recipe(recipe_id: str, user: dict = Depends(get_current_user)):
    recipe = db.get_recipe(recipe_id)
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")
    return recipe


@app.post("/recipes")
async def create_recipe(recipe: RecipeCreate, user: dict = Depends(get_current_user)):
    require_admin(user)
    recipe_dict = recipe.model_dump()
    text_to_encode = db.build_recipe_text(recipe_dict)
    embedding = await run_in_threadpool(embedding_model.encode, text_to_encode)
    return db.create_recipe(recipe_dict, embedding.tolist())


@app.delete("/recipes/{recipe_id}")
def remove_recipe(recipe_id: str, user: dict = Depends(get_current_user)):
    require_admin(user)
    db.delete_recipe(recipe_id)
    return {"status": "success", "message": f"Recipe {recipe_id} deleted successfully."}


# --------------------------------------------------------------------------- #
# Profile endpoints
# --------------------------------------------------------------------------- #

@app.get("/profile")
def get_profile(user: dict = Depends(get_current_user)):
    return db.get_or_create_profile(user["id"])


@app.put("/profile")
def put_profile(update: ProfileUpdate, user: dict = Depends(get_current_user)):
    return db.update_profile(user["id"], update.allergies, update.dietary_preferences)


@app.put("/profile/admin")
def put_admin(update: AdminUpdate, user: dict = Depends(get_current_user)):
    return db.set_admin(user["id"], update.is_admin)


# --------------------------------------------------------------------------- #
# Favorites endpoints
# --------------------------------------------------------------------------- #

@app.get("/favorites")
def get_favorites(user: dict = Depends(get_current_user)):
    return db.list_favorites(user["id"])


@app.post("/favorites")
def post_favorite(fav: FavoriteCreate, user: dict = Depends(get_current_user)):
    return db.add_favorite(user["id"], fav.recipe_id)


@app.delete("/favorites/{recipe_id}")
def delete_favorite(recipe_id: str, user: dict = Depends(get_current_user)):
    db.remove_favorite(user["id"], recipe_id)
    return {"status": "success"}


# --------------------------------------------------------------------------- #
# Cooking history endpoints
# --------------------------------------------------------------------------- #

@app.get("/history")
def get_history(user: dict = Depends(get_current_user)):
    return db.list_cooking_history(user["id"])


@app.post("/history")
def post_history(entry: HistoryCreate, user: dict = Depends(get_current_user)):
    return db.add_cooking_history(
        user["id"], entry.recipe_id, entry.duration_minutes, entry.rating
    )


# --------------------------------------------------------------------------- #
# Conversation endpoints (voice-session transcripts)
# --------------------------------------------------------------------------- #

@app.get("/conversations")
def get_conversations(user: dict = Depends(get_current_user)):
    return db.list_conversations(user["id"])


@app.post("/conversations")
def post_conversation(conv: ConversationCreate, user: dict = Depends(get_current_user)):
    return db.add_conversation(user["id"], conv.title, conv.messages)


# --------------------------------------------------------------------------- #
# Shopping list endpoints (also driven by the agent's shopping-list tool)
# --------------------------------------------------------------------------- #

@app.get("/shopping-list")
def get_shopping_list(user: dict = Depends(get_current_user)):
    return db.list_shopping_list(user["id"])


@app.post("/shopping-list")
def post_shopping_item(item: ShoppingItemCreate, user: dict = Depends(get_current_user)):
    name = item.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    return db.add_shopping_list_item(user["id"], name, item.quantity, item.unit, item.checked)


@app.patch("/shopping-list/{item_id}")
def patch_shopping_item(item_id: str, patch: ShoppingItemUpdate, user: dict = Depends(get_current_user)):
    fields = patch.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="No updatable fields")
    updated = db.update_shopping_list_item(item_id, user["id"], fields)
    if not updated:
        raise HTTPException(status_code=404, detail="Item not found")
    return updated


@app.delete("/shopping-list/{item_id}")
def delete_shopping_item(item_id: str, user: dict = Depends(get_current_user)):
    db.delete_shopping_list_item(item_id, user["id"])
    return {"status": "success"}


# --------------------------------------------------------------------------- #
# Memory endpoints (also driven by the agent's save_note / recall_memories tools)
# --------------------------------------------------------------------------- #

@app.get("/memories")
def get_memories(recipe_id: str | None = None, limit: int = 20, user: dict = Depends(get_current_user)):
    return db.list_memories(user["id"], recipe_id, limit)


@app.post("/memories")
def post_memory(memory: MemoryCreate, user: dict = Depends(get_current_user)):
    note = memory.note.strip()
    if not note:
        raise HTTPException(status_code=400, detail="note is required")
    return db.add_memory(user["id"], note, memory.recipe_id)


# --------------------------------------------------------------------------- #
# Recipe import (fetch a URL and extract a recipe with the agent's import tool)
# --------------------------------------------------------------------------- #

@app.post("/recipes/import")
async def import_recipe(req: ImportRequest, user: dict = Depends(get_current_user)):
    # Recipe extraction uses the server's default LLM provider.
    provider = providers.resolve_provider(None)
    if not provider["api_key"]:
        raise HTTPException(
            status_code=500,
            detail=f"{provider['label']} is not configured (missing API key).",
        )
    url = req.url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="url is required")

    from tools import tool_import_recipe_from_url

    async with httpx.AsyncClient(timeout=60.0) as client:
        ctx = ToolContext(
            cooking_state={},
            user_id=user["id"],
            http_client=client,
            embedding_model=embedding_model,
            llm_api_key=provider["api_key"],
            llm_model=provider["model"],
            llm_base_url=provider["base_url"],
            api_style=provider["api_style"],
            extra_headers=provider["extra_headers"],
            extra_body=provider["extra_body"],
        )
        result = await tool_import_recipe_from_url({"url": url}, ctx)
        if result.get("error"):
            raise HTTPException(status_code=400, detail=result["error"])
        return result


# --------------------------------------------------------------------------- #
# Real-time voice WebSocket (Deepgram STT -> Groq LLM -> browser Web Speech TTS)
# --------------------------------------------------------------------------- #

@app.websocket("/ws/chat")
async def websocket_chat(client_ws: WebSocket):
    await client_ws.accept()
    print("WebSocket client connected.")

    token = client_ws.query_params.get("token")
    if not token:
        print("WebSocket authentication failed: missing token.")
        await client_ws.send_json({"type": "error", "message": "Missing authentication token."})
        await client_ws.close()
        return

    try:
        payload = auth.decode_token(token)
        user_id = payload.get("sub")
        if not user_id:
            raise jwt.InvalidTokenError("Missing subject")
        print(f"WebSocket client authenticated: user {user_id}")
    except jwt.InvalidTokenError as e:
        print(f"WebSocket authentication failed: {e}")
        await client_ws.send_json({"type": "error", "message": "Invalid authentication token."})
        await client_ws.close()
        return

    if not DEEPGRAM_API_KEY:
        print("Missing Deepgram API key in environment.")
        await client_ws.send_json({
            "type": "error",
            "message": "Voice input is unavailable: the server is missing its Deepgram API key.",
        })
        await client_ws.close()
        return

    dg_url = (
        "wss://api.deepgram.com/v1/listen"
        "?model=nova-2&language=en&interim_results=true"
        "&punctuate=true&endpointing=1000"
    )
    dg_headers = {"Authorization": f"Token {DEEPGRAM_API_KEY}"}

    # Session state
    cooking_state = {
        "screen": "home",
        "recipe": None,
        "current_step": 0,
        "timers": [],
        "tts_mode": "web_speech",
        "dietary_preferences": []
    }

    history = []

    # Initialize long-running HTTP Client
    http_client = httpx.AsyncClient(timeout=30.0)

    async def process_user_turn(combined_transcript):
        # Send user transcript to client
        await client_ws.send_json({
            "type": "user_transcript",
            "text": combined_transcript
        })
        history.append({"role": "user", "content": combined_transcript})

        # Resolve the LLM provider the client picked in its model selector
        # (sent as `model_provider` in the session state). Falls back to the
        # server default when absent/unknown.
        provider = providers.resolve_provider(cooking_state.get("model_provider"))
        if not provider["api_key"]:
            await client_ws.send_json({
                "type": "error",
                "message": f"{provider['label']} isn't configured on the server. "
                           f"Add its API key to backend/.env and restart.",
            })
            return

        ctx = ToolContext(
            cooking_state=cooking_state,
            user_id=user_id,
            http_client=http_client,
            embedding_model=embedding_model,
            llm_api_key=provider["api_key"],
            llm_model=provider["model"],
            llm_base_url=provider["base_url"],
            api_style=provider["api_style"],
            fallback_model=provider["fallback_model"],
            max_tokens=provider["max_tokens"],
            request_timeout=provider["request_timeout"],
            stream_timeout=provider["stream_timeout"],
            extra_headers=provider["extra_headers"],
            extra_body=provider["extra_body"],
            final_extra_body=provider["final_extra_body"],
        )

        try:
            # OpenAI-compatible tool-calling agent: emits ai_action /
            # ai_text_partial events via send_json and returns the spoken reply.
            ai_reply = await run_agent_turn(
                user_text=combined_transcript,
                history=history[:-1],  # agent re-appends the user message itself
                ctx=ctx,
                send_json=client_ws.send_json,
                model=provider["model"],
            )

            if not ai_reply:
                ai_reply = "Sorry, I did not catch that. Could you say it again?"

            await client_ws.send_json({"type": "ai_text", "text": ai_reply})
            history.append({"role": "assistant", "content": ai_reply})

            # Web Speech only: the client speaks ai_text; no cloud TTS.
            await client_ws.send_json({"type": "ai_audio_none"})

        except httpx.TimeoutException as te:
            print(f"Timeout processing AI response: {type(te).__name__}: {te!r}")
            await client_ws.send_json({
                "type": "error",
                "message": "The AI model took too long to respond. Please try speaking again."
            })
        except httpx.HTTPStatusError as hse:
            if hse.response.status_code == 429:
                print(f"{provider['label']} 429 rate limit hit.")
                await client_ws.send_json({
                    "type": "error",
                    "message": f"{provider['label']} rate limit reached. Please wait a few seconds before speaking again."
                })
            else:
                print(f"HTTP error processing AI response: {hse}")
                await client_ws.send_json({
                    "type": "error",
                    "message": f"Server connection error ({hse.response.status_code}). Please try again."
                })
        except Exception as e:
            print(f"Error processing AI response: {type(e).__name__}: {e!r}")
            err = str(e)
            # The agent surfaces LLM HTTP errors as RuntimeError("LLM error <code>: ...").
            # Give a clear message for rate limits (esp. OpenRouter's free daily cap).
            if "429" in err or "rate limit" in err.lower():
                if "free-models-per-day" in err or "free_tier_daily" in err:
                    msg = (f"{provider['label']} has hit its free daily request limit. "
                           f"Switch to Llama, add OpenRouter credits, or try again after the daily reset.")
                else:
                    msg = f"{provider['label']} rate limit reached. Please wait a few seconds and try again."
                await client_ws.send_json({"type": "error", "message": msg})
            else:
                await client_ws.send_json({
                    "type": "error",
                    "message": "An unexpected error occurred. Please try speaking again."
                })

    # Initialize Queue for serializing user turns
    turn_queue = asyncio.Queue()

    async def turn_worker():
        try:
            while True:
                turn_text = await turn_queue.get()
                try:
                    await process_user_turn(turn_text)
                except Exception as e:
                    print(f"Error in turn worker: {e}")
                finally:
                    turn_queue.task_done()
        except asyncio.CancelledError:
            pass

    try:
        async with websockets.connect(dg_url, additional_headers=dg_headers) as dg_ws:
            print("Connected to Deepgram streaming API.")

            # Read from client and forward to Deepgram or process control frames / text messages
            async def client_to_dg():
                try:
                    while True:
                        message = await client_ws.receive()
                        if "bytes" in message:
                            await dg_ws.send(message["bytes"])
                        elif "text" in message:
                            data = json.loads(message["text"])
                            if data.get("type") == "state_update":
                                # Sync state from client
                                updated = data.get("state", {})
                                cooking_state.update(updated)
                            elif data.get("type") == "user_text":
                                user_text = data.get("text", "").strip()
                                if user_text:
                                    # Put turn text into the serialized queue
                                    await turn_queue.put(user_text)
                            elif data.get("type") == "ping":
                                await client_ws.send_json({"type": "pong"})
                except WebSocketDisconnect:
                    print("Client disconnected (WS connection closed).")
                except Exception as e:
                    print(f"Error in client_to_dg: {e}")
                finally:
                    await dg_ws.close()

            # Read from Deepgram and process transcripts
            user_turn_transcript = []
            last_speech_time = [time.time()]

            async def dg_to_client():
                async def trigger_turn():
                    combined_transcript = " ".join(user_turn_transcript).strip()
                    user_turn_transcript.clear()
                    if combined_transcript:
                        print(f"Triggering Turn: {combined_transcript}")
                        # Put turn transcript into the serialized queue
                        await turn_queue.put(combined_transcript)
                try:
                    async for message in dg_ws:
                        data = json.loads(message)
                        channel = data.get("channel", {})
                        alternatives = channel.get("alternatives", [])
                        is_final = data.get("is_final", False)
                        speech_final = data.get("speech_final", False)

                        if alternatives:
                            transcript = alternatives[0].get("transcript", "").strip()
                            if transcript:
                                last_speech_time[0] = time.time()
                                if is_final or speech_final:
                                    user_turn_transcript.append(transcript)
                                    combined_interim = " ".join(user_turn_transcript)
                                    await client_ws.send_json({
                                        "type": "user_interim",
                                        "text": combined_interim
                                    })
                                else:
                                    combined_interim = " ".join(user_turn_transcript + [transcript])
                                    await client_ws.send_json({
                                        "type": "user_interim",
                                        "text": combined_interim
                                    })
                        if speech_final:
                            await trigger_turn()
                        elif user_turn_transcript and (time.time() - last_speech_time[0] > 1.2):
                            print("Turn triggered by silence timeout fallback.")
                            await trigger_turn()
                except Exception as e:
                    print(f"Error in dg_to_client: {e}")

            # KeepAlive deepgram
            async def keep_alive_dg():
                try:
                    while True:
                        await asyncio.sleep(5)
                        await dg_ws.send(json.dumps({"type": "KeepAlive"}))
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    print(f"Error in keep_alive_dg: {e}")

            # Run tasks concurrently
            worker_task = asyncio.create_task(turn_worker())
            done, pending = await asyncio.wait(
                [
                    asyncio.create_task(client_to_dg()),
                    asyncio.create_task(dg_to_client()),
                    asyncio.create_task(keep_alive_dg()),
                    worker_task
                ],
                return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()

    except WebSocketDisconnect:
        print("WebSocket disconnected.")
    except Exception as e:
        print(f"Error in WebSocket handler: {e}")
        try:
            await client_ws.send_json({
                "type": "error",
                "message": f"Connection to voice service failed: {str(e)}"
            })
            await client_ws.close()
        except Exception:
            pass
    finally:
        await http_client.aclose()
        print("WebSocket chat resources released.")
