import React from 'react';

interface MicButtonProps {
  status: 'idle' | 'connecting' | 'recording' | 'isAiThinking' | 'isAiSpeaking';
  onClick: () => void;
}

export default function MicButton({ status, onClick }: MicButtonProps) {
  const isIdle = status === 'idle';
  const isConnecting = status === 'connecting';
  const isRecording = status === 'recording';
  const isThinking = status === 'isAiThinking';
  const isSpeaking = status === 'isAiSpeaking';

  const isDisabled = isThinking || isSpeaking || isConnecting;

  let btnClasses = "w-16 h-16 rounded-full flex items-center justify-center transition-all duration-300 ";
  if (isRecording) {
    btnClasses += "bg-red-500 text-white ring-4 ring-red-100 animate-pulse";
  } else if (isDisabled) {
    btnClasses += "bg-neutral-200 text-neutral-400 cursor-not-allowed";
  } else {
    btnClasses += "bg-neutral-900 text-white hover:bg-neutral-800 active:scale-95 cursor-pointer";
  }

  let statusText = "";
  if (isConnecting) statusText = "Connecting...";
  else if (isRecording) statusText = "● Listening";
  else if (isThinking) statusText = "Thinking...";
  else if (isSpeaking) statusText = "Speaking...";

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={isDisabled ? undefined : onClick}
        className={btnClasses}
        disabled={isDisabled}
        aria-label="Toggle voice chat"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.8}
          stroke="currentColor"
          className="w-6 h-6"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z"
          />
        </svg>
      </button>
      <div className="h-5">
        {statusText && (
          <span className={`text-[12px] font-medium tracking-wide uppercase select-none ${isRecording ? 'text-red-500' : 'text-neutral-400'}`}>
            {statusText}
          </span>
        )}
      </div>
    </div>
  );
}
