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
    <div className="space-y-3 max-w-sm w-full bg-neutral-900/95 border border-neutral-800 rounded-2xl p-4 shadow-xl text-white">
      <div className="flex items-center justify-between pb-2 border-b border-neutral-800">
        <h4 className="text-xs font-bold text-neutral-400 uppercase tracking-wider flex items-center gap-1.5">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor" className="w-4 h-4 text-amber-500 animate-pulse">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Active Timers ({timers.length})
        </h4>
      </div>

      <div className="space-y-3 max-h-48 overflow-y-auto pr-1">
        {timers.map((timer) => {
          const isDone = timer.timeLeft === 0;
          const progressPercent = timer.duration > 0 ? (timer.timeLeft / timer.duration) * 100 : 0;

          return (
            <div 
              key={timer.id} 
              className={`p-3 rounded-xl border transition-all duration-300 ${
                isDone 
                  ? 'bg-red-500/10 border-red-500/30 animate-bounce' 
                  : 'bg-neutral-800/50 border-neutral-850'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-neutral-200 truncate">
                    {timer.label}
                  </p>
                  <p className={`text-2xl font-black tabular-nums tracking-tight ${isDone ? 'text-red-400' : 'text-neutral-100'}`}>
                    {isDone ? 'ALARM! 🚨' : formatTime(timer.timeLeft)}
                  </p>
                </div>

                <div className="flex items-center gap-1">
                  {!isDone && (
                    <button
                      onClick={() => onAddSeconds(timer.id, 60)}
                      className="text-[10px] font-bold text-neutral-300 bg-neutral-800 border border-neutral-700 hover:bg-neutral-700 px-2 py-1.5 rounded-lg transition-colors active:scale-95 cursor-pointer"
                      title="Add 1 minute"
                    >
                      +1 Min
                    </button>
                  )}
                  <button
                    onClick={() => onCancel(timer.id)}
                    className="text-neutral-400 hover:text-red-400 p-1.5 rounded-lg hover:bg-red-500/10 transition-colors active:scale-95 cursor-pointer"
                    title="Cancel Timer"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>

              {!isDone && (
                <div className="w-full bg-neutral-800 h-1.5 rounded-full mt-2.5 overflow-hidden">
                  <div 
                    className="bg-amber-500 h-full rounded-full transition-all duration-1000 ease-linear"
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
