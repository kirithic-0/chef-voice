import os
import json
import asyncio
import time
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
import httpx
import websockets
from dotenv import load_dotenv
from sentence_transformers import SentenceTransformer

from agent import DEFAULT_MODEL, run_agent_turn
from tools import ToolContext

load_dotenv()

# Retrieve API keys and configurations
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY")
NVIDIA_MODEL = os.getenv("NVIDIA_MODEL", DEFAULT_MODEL)
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

app = FastAPI(title="VoiceChat Backend")

# Enable CORS for frontend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize local embedding model for semantic search
print("Loading sentence-transformers/all-MiniLM-L6-v2 model...")
embedding_model = SentenceTransformer("all-MiniLM-L6-v2")
async def get_user_from_token(token: str) -> dict:
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=500, detail="Supabase environment variables are not configured.")
    url = f"{SUPABASE_URL}/auth/v1/user"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {token}"
    }
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(url, headers=headers)
            if resp.status_code == 200:
                return resp.json()
            else:
                raise HTTPException(status_code=401, detail="Invalid token")
        except httpx.HTTPStatusError as hse:
            raise HTTPException(status_code=hse.response.status_code, detail="Authentication failed")
        except Exception as e:
            print(f"Auth error: {e}")
            raise HTTPException(status_code=401, detail="Authentication failed")

def get_token_from_header(request: Request) -> str:
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    return auth_header.split(" ")[1]

@app.get("/conversations")
async def get_conversations(request: Request):
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=500, detail="Supabase environment variables are not configured.")
    
    token = get_token_from_header(request)
    await get_user_from_token(token)
    
    url = f"{SUPABASE_URL}/rest/v1/conversations"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    params = {
        "select": "*",
        "order": "created_at.desc",
        "limit": "10"
    }
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, headers=headers, params=params)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"Error fetching conversations: {e}")
            raise HTTPException(status_code=500, detail=str(e))

@app.post("/conversations")
async def post_conversation(request: Request, data: dict):
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=500, detail="Supabase environment variables are not configured.")
    
    token = get_token_from_header(request)
    user = await get_user_from_token(token)
    user_id = user["id"]
    
    # Inject user_id to respect RLS constraint
    data["user_id"] = user_id
    
    url = f"{SUPABASE_URL}/rest/v1/conversations"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Prefer": "return=representation"
    }
    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(url, headers=headers, json=data)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"Error saving conversation: {e}")
            raise HTTPException(status_code=500, detail=str(e))

@app.get("/recipes")
async def get_recipes(request: Request):
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=500, detail="Supabase environment variables are not configured.")
    
    token = get_token_from_header(request)
    await get_user_from_token(token)
    
    url = f"{SUPABASE_URL}/rest/v1/recipes"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    params = {
        "select": "*",
        "order": "title.asc"
    }
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, headers=headers, params=params)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"Error fetching recipes: {e}")
            raise HTTPException(status_code=500, detail=str(e))

@app.get("/recipes/search")
async def search_recipes(query: str, request: Request):
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=500, detail="Supabase environment variables are not configured.")
    if not query:
        return []
    
    token = get_token_from_header(request)
    await get_user_from_token(token)
    
    try:
        # Generate embedding for the search query in a separate thread to prevent blocking the event loop
        query_embedding_arr = await run_in_threadpool(embedding_model.encode, query)
        query_embedding = query_embedding_arr.tolist()
        
        # Call Supabase match_recipes RPC
        url = f"{SUPABASE_URL}/rest/v1/rpc/match_recipes"
        headers = {
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }
        payload = {
            "query_embedding": query_embedding,
            "match_threshold": 0.0,
            "match_count": 6
        }
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        print(f"Error searching recipes: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/recipes/{recipe_id}")
async def get_recipe(recipe_id: str, request: Request):
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=500, detail="Supabase environment variables are not configured.")
    
    token = get_token_from_header(request)
    await get_user_from_token(token)
    
    url = f"{SUPABASE_URL}/rest/v1/recipes"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    params = {
        "select": "*",
        "id": f"eq.{recipe_id}"
    }
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, headers=headers, params=params)
            response.raise_for_status()
            data = response.json()
            if not data:
                raise HTTPException(status_code=404, detail="Recipe not found")
            return data[0]
        except HTTPException as he:
            raise he
        except Exception as e:
            print(f"Error fetching recipe {recipe_id}: {e}")
            raise HTTPException(status_code=500, detail=str(e))

async def check_is_admin(user_id: str, token: str) -> bool:
    url = f"{SUPABASE_URL}/rest/v1/profiles"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {token}"
    }
    params = {
        "select": "is_admin",
        "id": f"eq.{user_id}"
    }
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(url, headers=headers, params=params)
            if resp.status_code == 200:
                profiles = resp.json()
                if profiles and len(profiles) > 0:
                    return bool(profiles[0].get("is_admin", False))
            return False
        except Exception as e:
            print(f"Error checking admin status: {e}")
            return False

@app.post("/recipes")
async def create_recipe(request: Request, recipe_data: dict):
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=500, detail="Supabase environment variables are not configured.")
    
    token = get_token_from_header(request)
    user = await get_user_from_token(token)
    user_id = user["id"]
    
    is_admin = await check_is_admin(user_id, token)
    if not is_admin:
        raise HTTPException(status_code=403, detail="Forbidden: Admin access required.")
    
    required_fields = ["title", "cuisine", "time", "difficulty", "servings", "ingredients", "steps"]
    for field in required_fields:
        if field not in recipe_data:
            raise HTTPException(status_code=400, detail=f"Missing required field: {field}")
            
    ingredients = recipe_data.get("ingredients", [])
    ingredients_list = []
    for ing in ingredients:
        name = ing.get("name", "")
        amount = ing.get("amount", "")
        unit = ing.get("unit", "")
        ingredients_list.append(f"{amount} {unit} {name}".strip())
    ingredients_str = ", ".join(ingredients_list)
    
    text_to_encode = f"Title: {recipe_data['title']}. Cuisine: {recipe_data['cuisine']}. Difficulty: {recipe_data['difficulty']}. Ingredients: {ingredients_str}."
    
    try:
        query_embedding_arr = await run_in_threadpool(embedding_model.encode, text_to_encode)
        recipe_data["embedding"] = query_embedding_arr.tolist()
        
        url = f"{SUPABASE_URL}/rest/v1/recipes"
        headers = {
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Prefer": "return=representation"
        }
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, headers=headers, json=recipe_data)
            resp.raise_for_status()
            return resp.json()[0]
    except Exception as e:
        print(f"Error creating recipe: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/recipes/{recipe_id}")
async def delete_recipe(recipe_id: str, request: Request):
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=500, detail="Supabase environment variables are not configured.")
        
    token = get_token_from_header(request)
    user = await get_user_from_token(token)
    user_id = user["id"]
    
    is_admin = await check_is_admin(user_id, token)
    if not is_admin:
        raise HTTPException(status_code=403, detail="Forbidden: Admin access required.")
        
    try:
        url = f"{SUPABASE_URL}/rest/v1/recipes"
        headers = {
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }
        params = {
            "id": f"eq.{recipe_id}"
        }
        async with httpx.AsyncClient() as client:
            resp = await client.delete(url, headers=headers, params=params)
            resp.raise_for_status()
            return {"status": "success", "message": f"Recipe {recipe_id} deleted successfully."}
    except Exception as e:
        print(f"Error deleting recipe: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/shopping-list")
async def get_shopping_list(request: Request):
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=500, detail="Supabase environment variables are not configured.")
    token = get_token_from_header(request)
    user = await get_user_from_token(token)
    url = f"{SUPABASE_URL}/rest/v1/shopping_list_items"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    params = {
        "select": "*",
        "user_id": f"eq.{user['id']}",
        "order": "created_at.desc",
    }
    async with httpx.AsyncClient() as client:
        resp = await client.get(url, headers=headers, params=params)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()


@app.post("/shopping-list")
async def add_shopping_list_item(request: Request, data: dict):
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=500, detail="Supabase environment variables are not configured.")
    token = get_token_from_header(request)
    user = await get_user_from_token(token)
    row = {
        "user_id": user["id"],
        "name": data.get("name", "").strip(),
        "quantity": data.get("quantity") or "",
        "unit": data.get("unit") or "",
        "checked": bool(data.get("checked", False)),
    }
    if not row["name"]:
        raise HTTPException(status_code=400, detail="name is required")
    url = f"{SUPABASE_URL}/rest/v1/shopping_list_items"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, headers=headers, json=row)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data_out = resp.json()
        return data_out[0] if isinstance(data_out, list) else data_out


@app.patch("/shopping-list/{item_id}")
async def patch_shopping_list_item(item_id: str, request: Request, data: dict):
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=500, detail="Supabase environment variables are not configured.")
    token = get_token_from_header(request)
    await get_user_from_token(token)
    allowed = {k: data[k] for k in ("name", "quantity", "unit", "checked") if k in data}
    if not allowed:
        raise HTTPException(status_code=400, detail="No updatable fields")
    url = f"{SUPABASE_URL}/rest/v1/shopping_list_items"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    params = {"id": f"eq.{item_id}"}
    async with httpx.AsyncClient() as client:
        resp = await client.patch(url, headers=headers, params=params, json=allowed)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data_out = resp.json()
        return data_out[0] if isinstance(data_out, list) and data_out else data_out


@app.delete("/shopping-list/{item_id}")
async def delete_shopping_list_item(item_id: str, request: Request):
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=500, detail="Supabase environment variables are not configured.")
    token = get_token_from_header(request)
    await get_user_from_token(token)
    url = f"{SUPABASE_URL}/rest/v1/shopping_list_items"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    params = {"id": f"eq.{item_id}"}
    async with httpx.AsyncClient() as client:
        resp = await client.delete(url, headers=headers, params=params)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return {"status": "success"}


@app.get("/memories")
async def get_memories(request: Request, recipe_id: str = None, limit: int = 20):
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=500, detail="Supabase environment variables are not configured.")
    token = get_token_from_header(request)
    user = await get_user_from_token(token)
    url = f"{SUPABASE_URL}/rest/v1/user_memories"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    params = {
        "select": "*",
        "user_id": f"eq.{user['id']}",
        "order": "created_at.desc",
        "limit": str(limit),
    }
    if recipe_id:
        params["recipe_id"] = f"eq.{recipe_id}"
    async with httpx.AsyncClient() as client:
        resp = await client.get(url, headers=headers, params=params)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()


@app.post("/memories")
async def create_memory(request: Request, data: dict):
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=500, detail="Supabase environment variables are not configured.")
    token = get_token_from_header(request)
    user = await get_user_from_token(token)
    note = (data.get("note") or "").strip()
    if not note:
        raise HTTPException(status_code=400, detail="note is required")
    row = {"user_id": user["id"], "note": note}
    if data.get("recipe_id"):
        row["recipe_id"] = data["recipe_id"]
    url = f"{SUPABASE_URL}/rest/v1/user_memories"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, headers=headers, json=row)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data_out = resp.json()
        return data_out[0] if isinstance(data_out, list) else data_out


@app.post("/recipes/import")
async def import_recipe(request: Request, data: dict):
    """Import a recipe from a URL via the agent tool path."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=500, detail="Supabase environment variables are not configured.")
    if not NVIDIA_API_KEY:
        raise HTTPException(status_code=500, detail="NVIDIA_API_KEY is not configured.")
    token = get_token_from_header(request)
    user = await get_user_from_token(token)
    url = (data.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="url is required")

    from tools import tool_import_recipe_from_url

    async with httpx.AsyncClient(timeout=60.0) as client:
        ctx = ToolContext(
            cooking_state={},
            user_id=user["id"],
            token=token,
            http_client=client,
            supabase_url=SUPABASE_URL,
            supabase_service_key=SUPABASE_SERVICE_KEY,
            embedding_model=embedding_model,
            nvidia_api_key=NVIDIA_API_KEY,
            nvidia_model=NVIDIA_MODEL,
        )
        result = await tool_import_recipe_from_url({"url": url}, ctx)
        if result.get("error"):
            raise HTTPException(status_code=400, detail=result["error"])
        return result


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
        user = await get_user_from_token(token)
        print(f"WebSocket client authenticated: user {user.get('id')}")
    except Exception as e:
        print(f"WebSocket authentication failed: {e}")
        await client_ws.send_json({"type": "error", "message": "Invalid authentication token."})
        await client_ws.close()
        return
    
    if not DEEPGRAM_API_KEY or not NVIDIA_API_KEY:
        print("Missing required API keys in environment.")
        await client_ws.send_json({"type": "error", "message": "Missing API keys on server."})
        await client_ws.close()
        return

    dg_url = (
        "wss://api.deepgram.com/v1/listen"
        "?model=nova-2&language=en&interim_results=true"
        "&punctuate=true&endpointing=1000"
    )
    dg_headers = {"Authorization": f"Token {DEEPGRAM_API_KEY}"}
    
    # Session state (server-authoritative; client syncs via state_update)
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

        ctx = ToolContext(
            cooking_state=cooking_state,
            user_id=user.get("id"),
            token=token,
            http_client=http_client,
            supabase_url=SUPABASE_URL,
            supabase_service_key=SUPABASE_SERVICE_KEY,
            embedding_model=embedding_model,
            nvidia_api_key=NVIDIA_API_KEY,
            nvidia_model=NVIDIA_MODEL,
        )

        try:
            ai_reply = await run_agent_turn(
                user_text=combined_transcript,
                history=history[:-1],  # history without the just-added user msg (agent re-adds it)
                ctx=ctx,
                send_json=client_ws.send_json,
                model=NVIDIA_MODEL,
            )

            if not ai_reply:
                ai_reply = "Sorry, I did not catch that. Could you say it again?"

            await client_ws.send_json({
                "type": "ai_text",
                "text": ai_reply
            })
            history.append({"role": "assistant", "content": ai_reply})

            # Web Speech only — client speaks ai_text; no cloud TTS
            await client_ws.send_json({"type": "ai_audio_none"})

        except httpx.TimeoutException as te:
            print(f"Timeout processing AI response: {type(te).__name__}: {te!r}")
            await client_ws.send_json({
                "type": "error",
                "message": "The AI model took too long to respond. Please try speaking again."
            })
        except httpx.HTTPStatusError as hse:
            if hse.response.status_code == 429:
                print("NVIDIA API 429 rate limit hit.")
                await client_ws.send_json({
                    "type": "error",
                    "message": "NVIDIA API rate limit reached. Please wait a few seconds before speaking again."
                })
            else:
                print(f"HTTP error processing AI response: {hse}")
                await client_ws.send_json({
                    "type": "error",
                    "message": f"Server connection error ({hse.response.status_code}). Please try again."
                })
        except Exception as e:
            print(f"Error processing AI response: {type(e).__name__}: {e!r}")
            import traceback
            traceback.print_exc()
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
                                print(f"State sync received: {cooking_state}")
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
            _, pending = await asyncio.wait(
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
