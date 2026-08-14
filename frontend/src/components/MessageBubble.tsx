import React from 'react';
import { Message } from '../types';

interface MessageBubbleProps {
  message: Message;
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  // Tool-call chip: a small centered pill showing what the agent is doing
  // (e.g. "🔍 Searching recipes…") so tool use is visible and immersive.
  if (message.role === 'tool') {
    return (
      <div className="flex w-full justify-center my-1.5">
        <div className="max-w-[85%] px-3.5 py-1.5 text-[12px] font-semibold text-[#5D7052] bg-[#5D7052]/10 border border-[#5D7052]/25 rounded-full flex items-center gap-1.5 shadow-sm">
          {message.text}
        </div>
      </div>
    );
  }

  const isUser = message.role === 'user';
  return (
    <div className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'} my-2`}>
      <div
        className={`max-w-[75%] px-5 py-3 text-[15px] leading-relaxed shadow-sm transition-all duration-300 font-sans ${
          isUser
            ? 'bg-[#5D7052] text-[#F3F4F1] rounded-[1.5rem] rounded-tr-[0.25rem]'
            : 'bg-[#F0EBE5] text-[#2C2C24] rounded-[1.5rem] rounded-tl-[0.25rem] border border-[#DED8CF]'
        }`}
      >
        {message.text}
      </div>
    </div>
  );
}
