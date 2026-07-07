import React from 'react';
import { Timer } from '../types';

interface TimerWidgetProps {
  timers: Timer[];
  onCancel: (id: string) => void;
  onAddSeconds: (id: string, seconds: number) => void;
}

export default function TimerWidget({ timers, onCancel, onAddSeconds }: TimerWidgetProps) {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  if (timers.length === 0) return null;

  return (
    <div className="space-y-4 max-w-sm w-full bg-white/70 backdrop-blur-md border border-[#DED8CF]/50 rounded-[2rem] p-5 shadow-float text-[#2C2C24]">
      <div className="flex items-center justify-between pb-3 border-b border-[#DED8CF]/30">
        <h4 className="text-xs font-bold text-[#78786C] uppercase tracking-wider flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor" className="w-4 h-4 text-[#C18C5D] animate-pulse">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Active Timers ({timers.length})
        </h4>
      </div>

      <div className="space-y-4 max-h-48 overflow-y-auto pr-1">
        {timers.map((timer) => {
          const isDone = timer.timeLeft === 0;
          const progressPercent = timer.duration > 0 ? (timer.timeLeft / timer.duration) * 100 : 0;

          return (
            <div 
              key={timer.id} 
              className={`p-4 rounded-[1.5rem] border transition-all duration-300 ${
                isDone 
                  ? 'bg-[#A85448]/10 border-[#A85448]/30 animate-bounce' 
                  : 'bg-white/50 border-[#DED8CF]'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-[#4A4A40] truncate font-sans">
                    {timer.label}
                  </p>
                  <p className={`text-3xl font-serif font-bold tabular-nums tracking-tight mt-1 ${isDone ? 'text-[#A85448]' : 'text-[#2C2C24]'}`}>
                    {isDone ? 'ALARM!' : formatTime(timer.timeLeft)}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {!isDone && (
                    <button
                      onClick={() => onAddSeconds(timer.id, 60)}
                      className="text-[10px] font-bold text-[#5D7052] bg-[#5D7052]/10 border border-[#5D7052]/20 hover:bg-[#5D7052]/20 px-3 py-2 rounded-full transition-colors active:scale-95 cursor-pointer"
                      title="Add 1 minute"
                    >
                      +1 Min
                    </button>
                  )}
                  <button
                    onClick={() => onCancel(timer.id)}
                    className="text-[#78786C] hover:text-[#A85448] p-2 rounded-full hover:bg-[#A85448]/10 transition-colors active:scale-95 cursor-pointer"
                    title="Cancel Timer"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>

              {!isDone && (
                <div className="w-full bg-[#DED8CF]/40 h-2 rounded-full mt-3 overflow-hidden">
                  <div 
                    className="bg-[#5D7052] h-full rounded-full transition-all duration-1000 ease-linear"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
