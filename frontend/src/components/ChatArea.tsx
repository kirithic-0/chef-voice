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
    <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8 space-y-4 max-w-3xl mx-auto w-full h-full flex flex-col justify-between">
      {messages.length === 0 && !isAiThinking && !interimTranscript ? (
        <div className="my-auto flex flex-col items-center justify-center">
          <p className="text-neutral-450 text-base md:text-lg text-center select-none font-light">
            Press the mic to start a conversation or type below
          </p>
        </div>
      ) : (
        <div className="flex flex-col w-full">
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          {interimTranscript && (
            <div className="flex w-full justify-end my-2">
              <div className="max-w-[75%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed shadow-sm bg-neutral-900/60 text-white rounded-tr-none italic animate-pulse">
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
