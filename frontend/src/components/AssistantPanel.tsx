import React, { useState, useEffect } from 'react';
import { Message, Recipe, ModelProvider, ProviderInfo } from '../types';
import { fetchProviders } from '../lib/api';
import ChatArea from './ChatArea';
import Waveform from './Waveform';

interface AssistantPanelProps {
  voice: {
    messages: Message[];
    isAiThinking: boolean;
    interimTranscript: string;
    status: 'idle' | 'connecting' | 'recording' | 'isAiThinking' | 'isAiSpeaking';
    analyser: AnalyserNode | null;
    isMuted: boolean;
    toggleMute: () => void;
    sendTextMessage: (text: string) => void;
    modelProvider: ModelProvider;
    setModelProvider: (p: ModelProvider) => void;
  };
  suggestions: Recipe[];
  onPick: (recipe: Recipe) => void;
  onClose: () => void;
}

// Shown until /providers responds; keeps the selector usable offline too.
const FALLBACK_PROVIDERS: ProviderInfo[] = [
  { id: 'llama', label: 'Llama 3.3 70B (Groq)', model: '', available: true, default: true },
  { id: 'nvidia', label: 'Nemotron 3 Nano (OpenRouter)', model: '', available: true, default: false },
];

const SHORT_LABEL: Record<ModelProvider, string> = {
  llama: 'Llama',
  nvidia: 'Nemotron',
};

/**
 * Floating recipe-discovery assistant for the home/detail screens. The user
 * chats (voice or text), the agent calls search_recipes, and the results show
 * here as clickable suggestions that flow into the normal detail -> cooking path.
 */
export default function AssistantPanel({ voice, suggestions, onPick, onClose }: AssistantPanelProps) {
  const [textInput, setTextInput] = useState('');
  const [providers, setProviders] = useState<ProviderInfo[]>(FALLBACK_PROVIDERS);

  // Load the real provider catalogue (labels + which have API keys configured).
  useEffect(() => {
    let cancelled = false;
    fetchProviders()
      .then((list) => {
        if (!cancelled && Array.isArray(list) && list.length) setProviders(list);
      })
      .catch(() => { /* keep fallbacks if the endpoint is unreachable */ });
    return () => { cancelled = true; };
  }, []);

  const activeProvider = providers.find((p) => p.id === voice.modelProvider);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim()) return;
    voice.sendTextMessage(textInput.trim());
    setTextInput('');
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center sm:inset-x-auto sm:right-6 sm:bottom-6 pointer-events-none">
      <div className="pointer-events-auto w-full sm:w-[26rem] max-w-full h-[70vh] sm:h-[32rem] bg-[#14140F] border border-[#2C2C24] rounded-t-3xl sm:rounded-3xl shadow-[0_20px_60px_-10px_rgba(0,0,0,0.6)] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#2C2C24] bg-[#1A1A14] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#5D7052] animate-pulse" />
            <span className="text-[#F3F4F1] font-serif font-bold text-base">ChefVoice Assistant</span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close assistant"
            className="text-[#A0A096] hover:text-[#F3F4F1] p-1.5 rounded-full hover:bg-[#2C2C24] transition-colors cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Model selector — pick which LLM answers this session */}
        <div className="px-4 py-2.5 border-b border-[#2C2C24] bg-[#14140F] flex items-center gap-3">
          <span className="text-[10px] font-bold text-[#78786C] uppercase tracking-wider shrink-0">Model</span>
          <div className="flex bg-[#1A1A14] p-1 rounded-full border border-[#2C2C24] flex-1">
            {providers.map((p) => {
              const isActive = voice.modelProvider === p.id;
              const disabled = p.available === false;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => voice.setModelProvider(p.id)}
                  title={disabled ? `${p.label} — API key not configured on the server` : p.label}
                  aria-pressed={isActive}
                  className={`flex-1 px-3 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
                    isActive
                      ? 'bg-[#5D7052] text-[#F3F4F1] shadow-sm'
                      : 'text-[#A0A096] hover:text-[#F3F4F1]'
                  }`}
                >
                  {SHORT_LABEL[p.id] ?? p.label}
                  {disabled && <span className="ml-1 text-[9px] opacity-70">⚠</span>}
                </button>
              );
            })}
          </div>
        </div>
        {activeProvider?.available === false && (
          <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-300/90 text-[11px] leading-snug">
            {activeProvider.label} isn't configured on the server. Add its API key to
            <span className="font-mono"> backend/.env</span> and restart, or switch models above.
          </div>
        )}

        {/* Conversation */}
        <div className="flex-1 overflow-hidden relative">
          {voice.messages.length === 0 && !voice.isAiThinking && (
            <div className="absolute inset-0 flex items-center justify-center px-8 text-center pointer-events-none">
              <p className="text-[#78786C] text-sm leading-relaxed">
                Ask me for a recipe — try <span className="text-[#8BA67E] font-semibold">"something quick with pasta"</span> or <span className="text-[#8BA67E] font-semibold">"a healthy vegan dinner"</span>.
              </p>
            </div>
          )}
          <ChatArea
            messages={voice.messages}
            isAiThinking={voice.isAiThinking}
            interimTranscript={voice.interimTranscript}
          />
        </div>

        {/* Recipe suggestions */}
        {suggestions.length > 0 && (
          <div className="border-t border-[#2C2C24] bg-[#1A1A14] px-4 py-3 max-h-44 overflow-y-auto">
            <p className="text-[9px] font-bold text-[#78786C] uppercase tracking-wider mb-2">Suggestions — tap to open</p>
            <div className="flex flex-col gap-2">
              {suggestions.map((r) => (
                <button
                  key={r.id}
                  onClick={() => onPick(r)}
                  className="flex items-center justify-between gap-3 text-left bg-[#2C2C24] hover:bg-[#3A3A30] border border-[#4A4A40] rounded-xl px-4 py-2.5 transition-colors cursor-pointer active:scale-[0.98]"
                >
                  <span className="min-w-0">
                    <span className="block text-[#F3F4F1] text-sm font-semibold truncate">{r.title}</span>
                    <span className="block text-[#A0A096] text-[11px] font-medium truncate">
                      {r.cuisine}{typeof r.time === 'number' ? ` • ${r.time} min` : ''}{r.difficulty ? ` • ${r.difficulty}` : ''}
                    </span>
                  </span>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4 text-[#8BA67E] shrink-0">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Mic status + mute */}
        <div className="px-4 pt-3 bg-[#1A1A14] flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <Waveform status={voice.status} analyser={voice.analyser} muted={voice.isMuted} />
          </div>
          <button
            onClick={voice.toggleMute}
            disabled={voice.status === 'idle' || voice.status === 'connecting'}
            aria-pressed={voice.isMuted}
            aria-label={voice.isMuted ? 'Unmute microphone' : 'Mute microphone'}
            className={`shrink-0 p-3 rounded-full transition-all active:scale-95 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              voice.isMuted
                ? 'bg-amber-500/90 hover:bg-amber-500 text-[#1A1A14]'
                : 'bg-[#2C2C24] hover:bg-[#3A3A30] text-[#F3F4F1] border border-[#4A4A40]'
            }`}
          >
            {voice.isMuted ? (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                <path d="M13.5 4.06c0-1.336-1.616-2.005-2.56-1.06l-2.72 2.72H6.75A2.75 2.75 0 0 0 4 8.47v7.06a2.75 2.75 0 0 0 2.75 2.75h1.47l2.72 2.72c.944.945 2.56.276 2.56-1.06V4.06Z" />
                <path d="m17.28 9.22 1.72 1.72 1.72-1.72a.75.75 0 1 1 1.06 1.06L20.06 12l1.72 1.72a.75.75 0 1 1-1.06 1.06L19 13.06l-1.72 1.72a.75.75 0 1 1-1.06-1.06L17.94 12l-1.72-1.72a.75.75 0 1 1 1.06-1.06Z" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                <path d="M8.25 4.5a3.75 3.75 0 1 1 7.5 0v8.25a3.75 3.75 0 1 1-7.5 0V4.5Z" />
                <path d="M6 10.5a.75.75 0 0 1 .75.75v1.5a5.25 5.25 0 1 0 10.5 0v-1.5a.75.75 0 0 1 1.5 0v1.5a6.751 6.751 0 0 1-6 6.709v2.291h3a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1 0-1.5h3v-2.291a6.751 6.751 0 0 1-6-6.709v-1.5A.75.75 0 0 1 6 10.5Z" />
              </svg>
            )}
          </button>
        </div>

        {/* Text input */}
        <form onSubmit={handleSubmit} className="p-4 bg-[#1A1A14] flex gap-2">
          <input
            type="text"
            placeholder="Ask for a recipe…"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            className="flex-1 bg-[#2C2C24] border border-[#4A4A40] rounded-full px-4 py-2.5 text-sm text-[#F3F4F1] focus:outline-none focus:border-[#5D7052] transition-all placeholder:text-[#78786C]"
          />
          <button
            type="submit"
            className="bg-[#5D7052] hover:bg-[#5D7052]/90 text-[#F3F4F1] font-bold px-5 py-2.5 rounded-full text-xs uppercase tracking-wider transition-all active:scale-95 cursor-pointer"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
