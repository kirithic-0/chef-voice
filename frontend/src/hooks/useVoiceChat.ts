import { useState, useEffect, useRef } from 'react';
import { Message, VoiceAction } from '../types';
import { getToken, getWsUrl } from '../lib/api';

export function useVoiceChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [isAiThinking, setIsAiThinking] = useState(false);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'recording' | 'isAiThinking' | 'isAiSpeaking'>('idle');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [ttsMode, setTtsMode] = useState<'web_speech'>('web_speech');
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

  // PCM Streaming Audio Player states
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingAudioRef = useRef(false);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const hasReceivedAudioEndRef = useRef(false);

  const isAiThinkingRef = useRef(false);
  const isAiSpeakingRef = useRef(false);
  const ttsModeRef = useRef<'web_speech'>('web_speech');

  useEffect(() => {
    isAiThinkingRef.current = isAiThinking;
  }, [isAiThinking]);

  useEffect(() => {
    isAiSpeakingRef.current = isAiSpeaking;
  }, [isAiSpeaking]);

  useEffect(() => {
    ttsModeRef.current = ttsMode;
  }, [ttsMode]);

  // Decode Base64 to Int16Array
  const base64ToInt16Array = (base64: string): Int16Array => {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new Int16Array(bytes.buffer);
  };

  // Convert Int16 raw PCM to Float32 array
  const int16ToFloat32 = (int16Array: Int16Array): Float32Array => {
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }
    return float32Array;
  };

  // Play next PCM audio chunk in the queue
  const playNextChunk = () => {
    if (!audioContextRef.current) return;
    
    const queue = audioQueueRef.current;
    if (queue.length === 0) {
      isPlayingAudioRef.current = false;
      if (hasReceivedAudioEndRef.current) {
        setIsAiSpeaking(false);
        setStatus('recording');
        hasReceivedAudioEndRef.current = false;
      }
      return;
    }

    isPlayingAudioRef.current = true;
    const float32Data = queue.shift()!;
    
    try {
      const audioCtx = audioContextRef.current;
      const audioBuffer = audioCtx.createBuffer(1, float32Data.length, 16000); // 16kHz raw PCM
      audioBuffer.copyToChannel(float32Data as any, 0);

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      
      activeSourcesRef.current.push(source);
      
      source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
        playNextChunk();
      };
      
      source.start(0);
    } catch (e) {
      console.error("Error playing raw audio chunk", e);
      playNextChunk();
    }
  };

  // Interrupt AI speaking (Barge-In)
  const interruptAi = () => {
    let interrupted = false;

    // Stop ElevenLabs streaming audio sources
    if (activeSourcesRef.current.length > 0) {
      activeSourcesRef.current.forEach(source => {
        try {
          source.stop();
        } catch (e) {}
      });
      activeSourcesRef.current = [];
      interrupted = true;
    }
    
    // Clear audio queue
    audioQueueRef.current = [];
    isPlayingAudioRef.current = false;
    hasReceivedAudioEndRef.current = false;

    // Cancel Web Speech TTS if speaking
    if (window.speechSynthesis && window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      interrupted = true;
    }

    if (interrupted) {
      setIsAiSpeaking(false);
      setStatus('recording');
      console.log('AI audio playback interrupted by user speech (Barge-In).');
    }
  };

  // Speaks using browser Web Speech API
  const speakWebSpeech = (text: string) => {
    if (!window.speechSynthesis) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find(v => v.lang.startsWith('en') && v.name.includes('Google')) || 
                  voices.find(v => v.lang.startsWith('en')) || 
                  null;
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
        
        // Sync initial state if provided
        ws.send(JSON.stringify({
          type: 'state_update',
          state: initialState ? { ...initialState, tts_mode: ttsModeRef.current } : { tts_mode: ttsModeRef.current }
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
          setMessages((prev) => [
            ...prev,
            { id: `user-${Date.now()}`, role: 'user', text: data.text },
          ]);
          setIsAiThinking(true);
          setStatus('isAiThinking');
          if (isAiSpeakingRef.current) {
            interruptAi();
          }
        } else if (data.type === 'ai_action') {
          console.log('Action received from AI:', data.action);
          setLatestAction(data.action);
        } else if (data.type === 'ai_text') {
          setMessages((prev) => [
            ...prev,
            { id: `ai-${Date.now()}`, role: 'ai', text: data.text },
          ]);
          setIsAiThinking(false);
          speakWebSpeech(data.text);
        } else if (data.type === 'ai_text_partial') {
          // Progressive tokens streamed from the NVIDIA agent; keep the
          // thinking indicator up until the final ai_text arrives.
          setIsAiThinking(true);
        } else if (data.type === 'ai_audio_chunk') {
          // Ignored: text-to-speech is handled client-side by the Web Speech API.
        } else if (data.type === 'ai_audio_end') {
          // no-op in Web Speech mode
        } else if (data.type === 'ai_audio_none') {
          // Client Web Speech handles playback; recording resumes on utterance end.
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

    // 3. Stop audio playback and cancel speech
    if (activeSourcesRef.current.length > 0) {
      activeSourcesRef.current.forEach(source => {
        try { source.stop(); } catch(e){}
      });
      activeSourcesRef.current = [];
    }
    audioQueueRef.current = [];
    isPlayingAudioRef.current = false;
    hasReceivedAudioEndRef.current = false;

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
    setIsAiThinking(false);
    setIsAiSpeaking(false);
    setStatus('idle');
    setLatestAction(null);
    setAnalyser(null);
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

  // Sync TTS Mode changes
  useEffect(() => {
    sendStateUpdate({ tts_mode: ttsMode });
  }, [ttsMode]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stop();
    };
  }, []);

  return {
    messages,
    interimTranscript,
    isRecording,
    isAiSpeaking,
    isAiThinking,
    status,
    ttsMode,
    setTtsMode,
    latestAction,
    setLatestAction,
    sendStateUpdate,
    sendTextMessage,
    analyser,
    start,
    stop,
  };
}
