import React from 'react';
import { Message } from '../types';

interface MessageBubbleProps {
  message: Message;
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'} my-2`}>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed shadow-sm transition-all duration-200 ${
          isUser
            ? 'bg-neutral-900 text-white rounded-tr-none'
            : 'bg-neutral-200/50 text-neutral-850 rounded-tl-none border border-neutral-250/20'
        }`}
      >
        {message.text}
      </div>
    </div>
  );
}
