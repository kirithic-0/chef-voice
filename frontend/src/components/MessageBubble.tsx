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
