import { useState, useEffect, useRef } from 'react';
import { Message, VoiceAction, ModelProvider, Recipe } from '../types';
import { getToken, getWsUrl } from '../lib/api';
import { getPreferredVoice } from '../lib/speech';

// Friendly, spoken-style label + emoji for a tool call, shown as a chip in the
// chat so the user sees what the agent is doing (search, timer, step nav, …).
function describeToolCall(name: string, args: any = {}): string {
  const a = args || {};
  switch (name) {
    case 'search_recipes':
      return a.query ? `🔍 Searching recipes for “${a.query}”` : '🔍 Searching recipes';
    case 'past_cooked_recipes':
      return '📖 Looking through what you’ve cooked';
    case 'get_recipe':
      return '📄 Pulling up the recipe';
    case 'select_recipe':
      return '✅ Opening that recipe';
    case 'start_cooking':
      return '👨‍🍳 Starting cook mode';
    case 'import_recipe_from_url':
      return '🌐 Importing that recipe';
    case 'get_current_step':
      return '📍 Checking the current step';
    case 'navigate_step': {
      const dir: Record<string, string> = {
        next: '⏭️ Moving to the next step',
        prev: '⏮️ Going back a step',
        repeat: '🔁 Repeating this step',
        goto: '↪️ Jumping to that step',
      };
      return dir[a.direction] || '↔️ Navigating steps';
    }
    case 'set_timer':
      return a.label ? `⏱️ Setting a timer for ${a.label}` : '⏱️ Setting a timer';
    case 'cancel_timer':
      return a.label ? `🚫 Cancelling the ${a.label} timer` : '🚫 Cancelling the timer';
    default:
      return `⚙️ Running ${name}`;
  }
}

export function useVoiceChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  // Recipes from the agent's search, waiting for the reply they belong to.
  // search_recipes resolves (ai_action) BEFORE the model has composed its answer
  // (ai_text), so results are parked here and attached to that answer when it
  // lands. They are dropped at the start of every new user turn, so a reply can
  // never inherit the previous question's results.
  const pendingRecipesRef = useRef<Recipe[] | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [isAiThinking, setIsAiThinking] = useState(false);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'recording' | 'isAiThinking' | 'isAiSpeaking'>('idle');
  const [interimTranscript, setInterimTranscript] = useState('');
  // Which LLM backend the agent uses this session ('llama' = Groq,
  // 'local' = on-device Gemma via Ollama).
  // Chosen in the assistant's model selector.
  const [modelProvider, setModelProvider] = useState<ModelProvider>('llama');
  const [latestAction, setLatestAction] = useState<VoiceAction | null>(null);
  
  // Real Audio Analyser state
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isStoppedManuallyRef = useRef(false);

  const isAiThinkingRef = useRef(false);
  const isAiSpeakingRef = useRef(false);
  const modelProviderRef = useRef<ModelProvider>('llama');

  useEffect(() => {
    isAiThinkingRef.current = isAiThinking;
  }, [isAiThinking]);

  useEffect(() => {
    isAiSpeakingRef.current = isAiSpeaking;
  }, [isAiSpeaking]);

  useEffect(() => {
    modelProviderRef.current = modelProvider;
  }, [modelProvider]);

  // Interrupt AI speaking (Barge-In): stop the Web Speech reply mid-sentence.
  const interruptAi = () => {
    if (window.speechSynthesis && window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      setIsAiSpeaking(false);
      setStatus('recording');
      console.log('AI speech interrupted by user speech (Barge-In).');
    }
  };

  // Speaks using browser Web Speech API
  const speakWebSpeech = (text: string) => {
    if (!window.speechSynthesis) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = getPreferredVoice();
    if (voice) {
      utterance.voice = voice;
    }

    utterance.onstart = () => {
      setIsAiSpeaking(true);
      setStatus('isAiSpeaking');
    };

    utterance.onend = () => {
      setIsAiSpeaking(false);
      setStatus('recording');
    };

    utterance.onerror = () => {
      setIsAiSpeaking(false);
      setStatus('recording');
    };

    window.speechSynthesis.speak(utterance);
  };

  // Starts recording mic and sending chunks
  const startRecording = (stream: MediaStream) => {
    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = ''; // Use browser default
    }

    const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    mediaRecorderRef.current = mediaRecorder;

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(event.data);
        }
      }
    };

    mediaRecorder.start(250);
    setIsRecording(true);
    setStatus('recording');
  };

  const start = async (initialState: any = null) => {
    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    isStoppedManuallyRef.current = false;
    setStatus('connecting');

    try {
      // 1. Get microphone access with Echo Cancellation & Noise Suppression
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      audioStreamRef.current = stream;
      setIsMuted(false); // a fresh mic stream always starts live

      // 2. Setup Web Audio Analyser
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const audioCtx = audioContextRef.current;
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      
      const sourceNode = audioCtx.createMediaStreamSource(stream);
      const analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 128; // Small fftSize for fast waveform visualization
      sourceNode.connect(analyserNode);
      setAnalyser(analyserNode);

      // 3. Open WebSocket connection with authenticated token
      const token = getToken() || '';
      const ws = new WebSocket(getWsUrl(`/ws/chat?token=${encodeURIComponent(token)}`));
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('VoiceChat WebSocket connection opened.');
        reconnectAttemptsRef.current = 0; // reset reconnect counter
        startRecording(stream);
        
        // Sync initial state if provided, including the chosen model provider.
        const baseState = {
          model_provider: modelProviderRef.current,
        };
        ws.send(JSON.stringify({
          type: 'state_update',
          state: initialState ? { ...initialState, ...baseState } : baseState,
        }));
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'user_interim') {
          setInterimTranscript(data.text);
          if (isAiSpeakingRef.current) {
            interruptAi();
          }
        } else if (data.type === 'user_transcript') {
          setInterimTranscript('');
          pendingRecipesRef.current = null;
          setMessages((prev) => [
            ...prev,
            { id: `user-${Date.now()}`, role: 'user', text: data.text },
          ]);
          setIsAiThinking(true);
          setStatus('isAiThinking');
          if (isAiSpeakingRef.current) {
            interruptAi();
          }
        } else if (data.type === 'ai_tool_call') {
          // Immersive: show a chip in the chat for each tool the agent runs.
          setMessages((prev) => [
            ...prev,
            { id: `tool-${Date.now()}-${data.name}`, role: 'tool', text: describeToolCall(data.name, data.args) },
          ]);
        } else if (data.type === 'ai_action') {
          console.log('Action received from AI:', data.action);
          setLatestAction(data.action);
        } else if (data.type === 'ai_text') {
          const found = pendingRecipesRef.current;
          pendingRecipesRef.current = null;
          setMessages((prev) => [
            ...prev,
            {
              id: `ai-${Date.now()}`,
              role: 'ai',
              text: data.text,
              ...(found && found.length ? { recipes: found } : {}),
            },
          ]);
          setIsAiThinking(false);
          speakWebSpeech(data.text);
        } else if (data.type === 'ai_text_partial') {
          // Progressive tokens streamed from the Groq agent; keep the
          // thinking indicator up until the final ai_text arrives.
          setIsAiThinking(true);
        } else if (data.type === 'error') {
          console.error('Server error:', data.message);
          setMessages((prev) => [
            ...prev,
            { id: `error-${Date.now()}`, role: 'ai', text: `⚠️ ${data.message}` },
          ]);
          setIsAiThinking(false);
          if (
            mediaRecorderRef.current && 
            mediaRecorderRef.current.state === 'recording' && 
            wsRef.current && 
            wsRef.current.readyState === WebSocket.OPEN
          ) {
            setStatus('recording');
          } else {
            setStatus('idle');
          }
        }
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
      };

      ws.onclose = () => {
        // Ignore close events from a socket that's already been replaced by a
        // newer session (e.g. general assistant -> cooking hands off to a fresh
        // WebSocket). Acting here would wipe the new session's analyser or kick
        // off a reconnect with this old socket's stale state.
        if (wsRef.current !== ws) {
          return;
        }
        console.log('WebSocket connection closed.');
        setAnalyser(null);
        if (!isStoppedManuallyRef.current) {
          // Attempt reconnection with exponential backoff
          const attempts = reconnectAttemptsRef.current;
          const delay = Math.min(5000, 1000 * Math.pow(2, attempts));
          console.log(`WebSocket closed unexpectedly. Reconnecting in ${delay}ms... (Attempt ${attempts + 1})`);
          reconnectAttemptsRef.current++;
          
          reconnectTimeoutRef.current = window.setTimeout(() => {
            start(initialState).catch(() => {});
          }, delay);
        } else {
          setStatus('idle');
        }
      };

    } catch (err) {
      console.error('Failed to start voice chat:', err);
      setStatus('idle');
      throw err;
    }
  };

  const stop = () => {
    isStoppedManuallyRef.current = true;
    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // 1. Stop recording
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;

    // 2. Stop microphone tracks
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((track) => track.stop());
      audioStreamRef.current = null;
    }

    // 3. Cancel any reply still being spoken
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    // 4. Close WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    // 5. Reset states
    setMessages([]);
    setInterimTranscript('');
    setIsRecording(false);
    setIsMuted(false);
    setIsAiThinking(false);
    setIsAiSpeaking(false);
    setStatus('idle');
    setLatestAction(null);
    setAnalyser(null);
  };

  // Toggle the microphone on/off without tearing down the session. Muting
  // disables the audio track so silence (not your voice) streams to Deepgram —
  // the assistant stops hearing you until you unmute.
  const toggleMute = () => {
    setIsMuted((prev) => {
      const next = !prev;
      const stream = audioStreamRef.current;
      if (stream) {
        stream.getAudioTracks().forEach((track) => {
          track.enabled = !next;
        });
      }
      if (next) {
        setInterimTranscript('');
      }
      return next;
    });
  };

  // Send state update
  const sendStateUpdate = (state: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'state_update',
        state
      }));
    }
  };

  // Send text message (manual text input)
  const sendTextMessage = (text: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'user_text',
        text
      }));
    }
  };

  // Push model-provider changes to the backend so the switch takes effect on
  // the next turn without reconnecting (no-op if the socket isn't open yet).
  useEffect(() => {
    sendStateUpdate({ model_provider: modelProvider });
  }, [modelProvider]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stop();
    };
  }, []);

  /**
   * Park recipes the agent just found so they attach to its next reply.
   * Called by the search_recipes UI action, which fires before that reply exists.
   */
  const attachRecipes = (found: Recipe[]) => {
    pendingRecipesRef.current = found.length ? found : null;
  };

  return {
    attachRecipes,
    messages,
    interimTranscript,
    isRecording,
    isMuted,
    toggleMute,
    isAiSpeaking,
    isAiThinking,
    status,
    modelProvider,
    setModelProvider,
    latestAction,
    setLatestAction,
    sendStateUpdate,
    sendTextMessage,
    analyser,
    start,
    stop,
  };
}
