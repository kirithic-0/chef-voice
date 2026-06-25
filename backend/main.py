import os
import json
import base64
import asyncio
import time
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
import httpx
import websockets
from dotenv import load_dotenv
from sentence_transformers import SentenceTransformer

load_dotenv()

# Retrieve API keys and configurations
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
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
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
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
            "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
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
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
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
    
    if not DEEPGRAM_API_KEY or not GROQ_API_KEY or not ELEVENLABS_API_KEY:
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
    
    # Session state
    cooking_state = {
        "screen": "home",
        "recipe": None,
        "current_step": 0,
        "timers": [],
        "tts_mode": "web_speech",
        "allergies": [],
        "dietary_preferences": []
    }
    
    history = []
    
    # Initialize long-running HTTP Client
    http_client = httpx.AsyncClient(timeout=30.0)
    
    async def stream_elevenlabs_audio(text: str):
        voice_id = "EXAVITQu4vr4xnSDxMaL"  # default voice
        el_url = f"wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input?model_id=eleven_monolingual_v1&output_format=pcm_16000"
        
        print("Connecting to ElevenLabs WebSocket for streaming TTS...")
        try:
            async with websockets.connect(el_url) as el_ws:
                # 1. Send Configuration
                config_msg = {
                    "text": " ",
                    "voice_settings": {
                        "stability": 0.5,
                        "similarity_boost": 0.75
                    },
                    "xi_api_key": ELEVENLABS_API_KEY
                }
                await el_ws.send(json.dumps(config_msg))
                
                # 2. Send Text
                input_msg = {
                    "text": f"{text} ",
                    "try_trigger_generation": True
                }
                await el_ws.send(json.dumps(input_msg))
                
                # 3. Send EOS
                eos_msg = {"text": ""}
                await el_ws.send(json.dumps(eos_msg))
                
                # 4. Stream audio back
                while True:
                    resp = await el_ws.recv()
                    data = json.loads(resp)
                    audio_b64 = data.get("audio")
                    if audio_b64:
                        await client_ws.send_json({
                            "type": "ai_audio_chunk",
                            "audio": audio_b64
                        })
                    if data.get("isFinal") or not audio_b64:
                        break
                
                # Send completion signal
                await client_ws.send_json({"type": "ai_audio_end"})
                print("ElevenLabs TTS streaming completed.")
        except Exception as e:
            print(f"Error in ElevenLabs streaming TTS: {e}")
            await client_ws.send_json({
                "type": "error",
                "message": "ElevenLabs premium voice connection failed. Reverting to web speech."
            })
            await client_ws.send_json({"type": "ai_audio_end"})

    async def process_user_turn(combined_transcript):
        # Send user transcript to client
        await client_ws.send_json({
            "type": "user_transcript",
            "text": combined_transcript
        })
        history.append({"role": "user", "content": combined_transcript})
        
        # Construct dynamic cooking context system prompt
        recipe = cooking_state.get("recipe")
        current_step_idx = cooking_state.get("current_step", 0)
        screen = cooking_state.get("screen", "home")
        timers = cooking_state.get("timers", [])
        allergies = cooking_state.get("allergies", [])
        dietary_prefs = cooking_state.get("dietary_preferences", [])
        
        recipe_context = "None"
        step_context = "None"
        if recipe:
            recipe_context = f"Title: {recipe.get('title')}\nCuisine: {recipe.get('cuisine')}\nIngredients: {json.dumps(recipe.get('ingredients'))}"
            steps = recipe.get("steps", [])
            if 0 <= current_step_idx < len(steps):
                curr_step = steps[current_step_idx]
                step_context = f"Step {current_step_idx + 1} of {len(steps)}: {curr_step.get('text')}"
                if curr_step.get('safety_alert'):
                    step_context += f" (SAFETY ALERT: {curr_step.get('safety_alert')})"
                if curr_step.get('timer_duration'):
                    step_context += f" (Suggested Timer: {curr_step.get('timer_duration')} seconds)"
        
        timers_context = json.dumps(timers)
        allergies_str = ", ".join(allergies) if allergies else "None"
        dietary_str = ", ".join(dietary_prefs) if dietary_prefs else "None"
        
        system_prompt = (
            "You are ChefVoice, a hands-free kitchen voice assistant.\n"
            "Your goal is to guide the user step-by-step through recipes, manage timers, suggest substitutions, and answer cooking questions.\n\n"
            f"Current Screen: {screen}\n"
            "You can help the user search for recipes or select a recipe from their screen. If they request a recipe search (e.g., 'find chicken recipes' or 'show me desserts'), trigger a 'search_recipes' action with the query.\n\n"
            f"Current Active Recipe Details:\n{recipe_context}\n"
            f"Current Active Cooking Step:\n{step_context}\n"
            f"Active Running Timers: {timers_context}\n"
            f"User Allergies: {allergies_str}\n"
            f"User Dietary Preferences: {dietary_str}\n\n"
            "ALLERGEN RULE: Do NOT verbally warn the user about allergies or dietary preferences in your response text. The frontend UI already handles showing allergen warnings, so you do not need to repeat them in every turn unless the user explicitly asks you about ingredients or safety.\n\n"
            "NAVIGATION RULE: You are a state router. You must inspect the 'Current Active Cooking Step' (e.g., 'Step 3 of 4'). The final step is the last number (e.g. 4). Do NOT say the recipe is completed or there are no more steps unless the user is already on the final step (e.g. Step 4 of 4) and says they are done. If the user is on an earlier step (e.g., Step 3 of 4) and says 'done', 'next', 'ready', or 'move on', you MUST return action type 'next_step' so the frontend can increment the step.\n\n"
            "You must respond ONLY with a JSON object. Do not include markdown code block formatting (like ```json). Just return raw JSON.\n"
            "The JSON object must follow this schema:\n"
            "{\n"
            '  "text": "Your spoken reply to the user. Keep it under 2 sentences since it is read aloud. Read steps clearly. Keep it concise.",\n'
            '  "action": {\n'
            '    "type": "next_step" | "prev_step" | "repeat_step" | "set_timer" | "cancel_timer" | "search_recipes" | "select_recipe" | "start_cooking" | "none",\n'
            '    "params": {\n'
            '      "duration": 300, // (integer, in seconds) only for set_timer\n'
            '      "label": "timer label", // (string) for set_timer or cancel_timer\n'
            '      "query": "search query", // (string) for search_recipes\n'
            '      "id": "recipe_id" // (string) only for select_recipe\n'
            "    }\n"
            "  }\n"
            "}\n\n"
            "Guidelines for Actions:\n"
            "- CRITICAL: If the Current Screen is 'cooking', do NOT output action types 'search_recipes' or 'select_recipe'. Only navigation (next_step, prev_step, repeat_step), timers (set_timer, cancel_timer), or none are allowed.\n"
            "- If the user says 'done', 'next', 'ready', or 'move on', return action type 'next_step'.\n"
            "- If the user says 'previous', 'go back', or 'last step', return action type 'prev_step'.\n"
            "- If the user says 'repeat' or 'say it again', return action type 'repeat_step'.\n"
            "- If the user asks to start cooking or begin, return action type 'start_cooking'.\n"
            "- If the user wants to search (e.g. 'show me chicken recipes' or 'find vegetarian dishes'), return action type 'search_recipes' with the query.\n"
            "- If the user asks for a timer (e.g. 'set a 5 minute timer'), return action type 'set_timer' with the duration in seconds.\n"
            "- If the user asks 'how much time is left?', check the active running timers context and answer verbally with action type 'none'.\n"
            "- If the user asks for a substitution (e.g. 'what can I use instead of cream?'), explain it verbally with action type 'none'.\n"
        )
        
        try:
            groq_url = "https://api.groq.com/openai/v1/chat/completions"
            groq_headers = {
                "Authorization": f"Bearer {GROQ_API_KEY}",
                "Content-Type": "application/json"
            }
            groq_body = {
                "model": "llama-3.3-70b-versatile",
                "messages": [
                    {"role": "system", "content": system_prompt},
                    *history[-6:] # Keep context short for speed
                ],
                "response_format": {"type": "json_object"}
            }
            groq_resp = await http_client.post(groq_url, headers=groq_headers, json=groq_body)
            groq_resp.raise_for_status()
            groq_data = groq_resp.json()
            
            raw_reply = groq_data["choices"][0]["message"]["content"].strip()
            print(f"Groq Raw JSON: {raw_reply}")
            
            reply_json = json.loads(raw_reply)
            ai_reply = reply_json.get("text", "")
            action_data = reply_json.get("action", {"type": "none", "params": {}})
            
            # Send action to client first for fast UI updates
            await client_ws.send_json({
                "type": "ai_action",
                "action": action_data
            })
            
            # Send AI text to client
            await client_ws.send_json({
                "type": "ai_text",
                "text": ai_reply
            })
            history.append({"role": "assistant", "content": ai_reply})
            
            # Process Audio Synthesis
            if cooking_state.get("tts_mode") == "elevenlabs" and ai_reply:
                await stream_elevenlabs_audio(ai_reply)
            else:
                # Send audio completion signal immediately to resume mic (as Web Speech will play it on client)
                await client_ws.send_json({
                    "type": "ai_audio_none"
                })
                
        except httpx.HTTPStatusError as hse:
            if hse.response.status_code == 429:
                print("Groq API 429 rate limit hit.")
                await client_ws.send_json({
                    "type": "error",
                    "message": "Groq API rate limit reached. Please wait a few seconds before speaking again."
                })
            else:
                print(f"HTTP error processing AI response: {hse}")
                await client_ws.send_json({
                    "type": "error",
                    "message": f"Server connection error ({hse.response.status_code}). Please try again."
                })
        except Exception as e:
            print(f"Error processing AI response: {e}")
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
