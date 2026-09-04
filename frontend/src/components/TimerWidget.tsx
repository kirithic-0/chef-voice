import React from 'react';
import { Timer } from '../types';

interface TimerWidgetProps {
  timers: Timer[];
  onCancel: (id: string) => void;
  onAddSeconds: (id: string, seconds: number) => void;
}

/**
 * Timers as they appear in cooking mode's rail — no card chrome, because the
 * rail already separates its sections with hairlines. Numerals are set in the
 * display serif so the count is readable from across the kitchen.
 */
export default function TimerWidget({ timers, onCancel, onAddSeconds }: TimerWidgetProps) {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (timers.length === 0) return null;

  return (
    <div className="flex flex-col gap-7">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-bold tracking-[0.14em] text-[#6E6858]">
          {timers.length > 1 ? `TIMERS · ${timers.length}` : 'TIMER'}
        </span>
      </div>

      {timers.map((timer) => {
        const isDone = timer.timeLeft === 0;
        const progressPercent = timer.duration > 0 ? (timer.timeLeft / timer.duration) * 100 : 0;

        return (
          <div key={timer.id}>
            <div className="flex items-baseline justify-between gap-3">
              <span className={`text-[11px] font-bold tracking-[0.1em] uppercase truncate ${isDone ? 'text-[#D08159]' : 'text-[#C97A46]'}`}>
                {timer.label}
              </span>
              <span className="text-[11px] text-[#6E6858] shrink-0">of {formatTime(timer.duration)}</span>
            </div>

            <div className={`font-serif text-[68px] leading-none tracking-[-2px] tabular-nums mt-2 ${isDone ? 'text-[#D08159]' : 'text-[#F4EFE7]'}`}>
              {isDone ? 'Done' : formatTime(timer.timeLeft)}
            </div>

            <div className="h-[2px] bg-[#322D24] mt-4">
              <div
                className={`h-[2px] transition-all duration-1000 ease-linear ${isDone ? 'bg-[#D08159]' : 'bg-[#C97A46]'}`}
                style={{ width: `${isDone ? 100 : progressPercent}%` }}
              />
            </div>

            <div className="flex items-center gap-5 mt-3.5">
              {!isDone && (
                <>
                  <button
                    onClick={() => onAddSeconds(timer.id, 60)}
                    className="text-[13px] font-bold text-[#A29A88] hover:text-[#F4EFE7] transition-colors cursor-pointer"
                  >
                    +1 min
                  </button>
                  <button
                    onClick={() => onAddSeconds(timer.id, 300)}
                    className="text-[13px] font-bold text-[#A29A88] hover:text-[#F4EFE7] transition-colors cursor-pointer"
                  >
                    +5 min
                  </button>
                </>
              )}
              <button
                onClick={() => onCancel(timer.id)}
                className="text-[13px] font-bold text-[#A29A88] hover:text-[#D08159] transition-colors cursor-pointer"
              >
                {isDone ? 'Dismiss' : 'Cancel'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
