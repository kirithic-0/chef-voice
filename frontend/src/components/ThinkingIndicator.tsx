import React from 'react';

export default function ThinkingIndicator() {
  return (
    <div className="flex w-full justify-start my-2">
      <div className="bg-neutral-200/50 rounded-2xl rounded-tl-none border border-neutral-250/20 px-4 py-3 shadow-sm flex items-center gap-1.5">
        <div className="w-2 h-2 bg-neutral-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
        <div className="w-2 h-2 bg-neutral-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
        <div className="w-2 h-2 bg-neutral-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
      </div>
    </div>
  );
}
