import React, { useEffect, useRef } from 'react';
import MessageBubble from './MessageBubble';
import ThinkingIndicator from './ThinkingIndicator';
import { Message } from '../types';

interface ChatAreaProps {
  messages: Message[];
  isAiThinking: boolean;
  interimTranscript: string;
}

export default function ChatArea({ messages, isAiThinking, interimTranscript }: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isAiThinking, interimTranscript]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8 space-y-4 max-w-3xl mx-auto w-full h-full flex flex-col justify-between relative z-10">
      {messages.length === 0 && !isAiThinking && !interimTranscript ? (
        <div className="my-auto flex flex-col items-center justify-center">
          <p className="text-[#78786C] text-base md:text-lg text-center select-none font-sans bg-[#F0EBE5]/50 px-6 py-3 rounded-full">
            Just speak out loud to chat, or type below
          </p>
        </div>
      ) : (
        <div className="flex flex-col w-full">
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
