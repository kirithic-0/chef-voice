import { useState, useEffect, useRef } from 'react';
import { Timer } from '../types';

export function useCookingTimers() {
  const [timers, setTimers] = useState<Timer[]>([]);
  const timersRef = useRef<Timer[]>([]);

  // Sync ref with state
  useEffect(() => {
    timersRef.current = timers;
  }, [timers]);

  const playBeep = () => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime); // A5 note
      
      gain.gain.setValueAtTime(0.5, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 1.5);
      
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      
      osc.start();
      osc.stop(audioCtx.currentTime + 1.5);
    } catch (e) {
      console.error("Failed to play alarm sound", e);
    }
  };

  useEffect(() => {
    const interval = setInterval(() => {
      const activeTimers = timersRef.current;
      if (activeTimers.length === 0) return;

      let updated = false;
      const nextTimers = activeTimers.map(t => {
        if (t.timeLeft <= 1 && !t.alarmPlayed) {
          playBeep();
          updated = true;
          return { ...t, timeLeft: 0, alarmPlayed: true };
        } else if (t.timeLeft > 0) {
          updated = true;
          return { ...t, timeLeft: t.timeLeft - 1 };
        }
        return t;
      });

      if (updated) {
        setTimers(nextTimers);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const addTimer = (duration: number, label: string = "Timer") => {
    const newTimer: Timer = {
      id: `timer-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      label,
      duration,
      timeLeft: duration,
      alarmPlayed: false
    };
    setTimers(prev => [...prev, newTimer]);
  };

  const removeTimer = (id: string) => {
    setTimers(prev => prev.filter(t => t.id !== id));
  };

  const addTimeToTimer = (id: string, seconds: number) => {
    setTimers(prev => prev.map(t => {
      if (t.id === id) {
        return {
          ...t,
          duration: t.duration + seconds,
          timeLeft: t.timeLeft + seconds,
          alarmPlayed: false
        };
      }
      return t;
    }));
  };

  const clearAllTimers = () => {
    setTimers([]);
  };

  return {
    timers,
    addTimer,
    removeTimer,
    addTimeToTimer,
    clearAllTimers
  };
}
