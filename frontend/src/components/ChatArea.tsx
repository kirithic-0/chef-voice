import React, { useEffect, useRef } from 'react';
import MessageBubble from './MessageBubble';
import ThinkingIndicator from './ThinkingIndicator';
import { Message } from '../types';

interface ChatAreaProps {
  messages: Message[];
  isAiThinking: boolean;
  interimTranscript: string;
  // Optional custom empty-state hint. Pass `null` to render no placeholder
  // (e.g. when the surrounding panel shows its own).
  emptyHint?: React.ReactNode;
}

export default function ChatArea({ messages, isAiThinking, interimTranscript, emptyHint }: ChatAreaProps) {
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
            <MessageBubble key={msg.id} message={msg} />
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
