import React, { useEffect, useRef } from 'react';
import MessageBubble from './MessageBubble';
import ThinkingIndicator from './ThinkingIndicator';
import { Message, Recipe } from '../types';

interface ChatAreaProps {
  messages: Message[];
  isAiThinking: boolean;
  interimTranscript: string;
  // Optional custom empty-state hint. Pass `null` to render no placeholder
  // (e.g. when the surrounding panel shows its own).
  emptyHint?: React.ReactNode;
  // Opens a recipe the assistant suggested. Without it, message.recipes render
  // as plain (non-interactive) cards.
  onPickRecipe?: (recipe: Recipe) => void;
}

export default function ChatArea({ messages, isAiThinking, interimTranscript, emptyHint, onPickRecipe }: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isAiThinking, interimTranscript]);

  const isEmpty = messages.length === 0 && !isAiThinking && !interimTranscript;

  // The scroll container fills its parent (h-full) and scrolls internally. It
  // must NOT use justify-between/justify-center: on an overflowing flex column
  // that clips the top messages and makes them unreachable. Messages flow from
  // the top; the empty-state hint is centered only when there's nothing yet.
  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-8 relative z-10">
      {isEmpty ? (
        emptyHint === undefined ? (
          <div className="h-full flex items-center justify-center">
            <p className="text-[#78786C] text-sm md:text-base text-center select-none font-sans bg-[#F0EBE5]/50 px-6 py-3 rounded-full">
              Just speak out loud to chat, or type below
            </p>
          </div>
        ) : (
          emptyHint
        )
      ) : (
        <div className="flex flex-col w-full max-w-3xl mx-auto space-y-1">
          {messages.map((msg) => (
            <React.Fragment key={msg.id}>
              <MessageBubble message={msg} />
              {/* Results belong to the reply that found them, and scroll with it.
                  They used to sit in a fixed tray below the conversation with its
                  own scrollbar, so the previous question's recipes stayed on screen
                  under the next answer. */}
              {msg.recipes && msg.recipes.length > 0 && (
                <div className="flex w-full justify-start my-2">
                  <div className="w-full max-w-[85%] flex flex-col gap-2">
                    {msg.recipes.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => onPickRecipe?.(r)}
                        disabled={!onPickRecipe}
                        className="flex items-center justify-between gap-3 text-left bg-[#2C2C24] hover:bg-[#3A3A30] border border-[#4A4A40] rounded-xl px-4 py-2.5 transition-colors cursor-pointer active:scale-[0.98] disabled:cursor-default disabled:hover:bg-[#2C2C24]"
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
            </React.Fragment>
          ))}
          {interimTranscript && (
            <div className="flex w-full justify-end my-2">
              <div className="max-w-[75%] px-5 py-3 text-[15px] leading-relaxed shadow-sm transition-all duration-300 font-sans bg-[#5D7052]/60 text-[#F3F4F1] rounded-[1.5rem] rounded-tr-[0.25rem] italic animate-pulse">
                {interimTranscript}
              </div>
            </div>
          )}
          {isAiThinking && <ThinkingIndicator />}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
