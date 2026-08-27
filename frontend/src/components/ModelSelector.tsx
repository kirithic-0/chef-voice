import { useState, useEffect } from 'react';
import { ModelProvider, ProviderInfo } from '../types';
import { fetchProviders } from '../lib/api';

// Shown until /providers responds; keeps the selector usable offline too.
const FALLBACK_PROVIDERS: ProviderInfo[] = [
  { id: 'llama', label: 'GPT-OSS 120B (Groq)', model: '', available: true, default: true },
  { id: 'local', label: 'Gemma 4 26B (Local)', model: '', available: true, default: false },
];

const SHORT_LABEL: Record<ModelProvider, string> = {
  llama: 'Groq',
  local: 'Gemma',
};

interface ModelSelectorProps {
  value: ModelProvider;
  onChange: (p: ModelProvider) => void;
  /** Hide the inline "not configured / start Ollama" hint (e.g. when space is tight). */
  hideHint?: boolean;
}

/**
 * The LLM picker (Groq / Gemma). Shared by the home assistant panel
 * and the in-recipe cooking chat drawer so both stay in sync — the selected
 * provider lives on the single useVoiceChat session, so switching here retargets
 * the live voice/text session on its next turn without reconnecting.
 */
export default function ModelSelector({ value, onChange, hideHint = false }: ModelSelectorProps) {
  const [providers, setProviders] = useState<ProviderInfo[]>(FALLBACK_PROVIDERS);

  // Load the real provider catalogue (labels + which are actually available).
  useEffect(() => {
    let cancelled = false;
    fetchProviders()
      .then((list) => {
        if (!cancelled && Array.isArray(list) && list.length) setProviders(list);
      })
      .catch(() => { /* keep fallbacks if the endpoint is unreachable */ });
    return () => { cancelled = true; };
  }, []);

  const activeProvider = providers.find((p) => p.id === value);

  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="text-[10px] font-bold text-[#78786C] uppercase tracking-wider shrink-0">Model</span>
        <div className="flex bg-[#1A1A14] p-1 rounded-full border border-[#2C2C24] flex-1">
          {providers.map((p) => {
            const isActive = value === p.id;
            const disabled = p.available === false;
            return (
              <button
                key={p.id}
                type="button"
                disabled={disabled}
                onClick={() => onChange(p.id)}
                title={disabled ? `${p.label} — ${p.id === 'local' ? "Ollama isn't running on the server" : 'API key not configured on the server'}` : p.label}
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
      {!hideHint && activeProvider?.available === false && (
        <div className="mt-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-300/90 text-[11px] leading-snug">
          {activeProvider.id === 'local' ? (
            <>
              {activeProvider.label} isn't reachable. Start Ollama
              (<span className="font-mono">ollama serve</span>) and import the model, or switch models above.
            </>
          ) : (
            <>
              {activeProvider.label} isn't configured on the server. Add its API key to
              <span className="font-mono"> backend/.env</span> and restart, or switch models above.
            </>
          )}
        </div>
      )}
    </div>
  );
}
