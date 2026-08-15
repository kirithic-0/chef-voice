import { useState, useEffect, useRef } from 'react';
import { Timer } from '../types';

export function useCookingTimers() {
  const [timers, setTimers] = useState<Timer[]>([]);
  const timersRef = useRef<Timer[]>([]);
  // One shared AudioContext for every beep (creating one per beep leaks contexts
  // and browsers cap how many can exist).
  const audioCtxRef = useRef<AudioContext | null>(null);
  // Wall-clock time of the last repeat beep, so a finished-but-not-dismissed
  // timer keeps alarming without beeping every single second.
  const lastReBeepRef = useRef<number>(0);

  // Sync ref with state
  useEffect(() => {
    timersRef.current = timers;
  }, [timers]);

  const getAudioCtx = (): AudioContext | null => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      // A context created before a user gesture can start suspended; resume it.
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }
      return audioCtxRef.current;
    } catch (e) {
      console.error('Failed to create audio context', e);
      return null;
    }
  };

  const playBeep = () => {
    const audioCtx = getAudioCtx();
    if (!audioCtx) return;
    try {
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
      console.error('Failed to play alarm sound', e);
    }
  };

  // Fire a browser notification when a timer finishes while the tab is hidden, so
  // you hear/see it even after switching away. No-op if unsupported or denied.
  const notifyDone = (label: string) => {
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'granted' && document.hidden) {
        new Notification('Timer done', { body: `${label} is ready.`, tag: 'chefvoice-timer' });
      }
    } catch {
      /* notifications are best-effort */
    }
  };

  useEffect(() => {
    const interval = setInterval(() => {
      const active = timersRef.current;
      if (active.length === 0) return;

      const now = Date.now();
      let changed = false;
      let anyDone = false;
      let firstAlarmThisTick = false;

      const next = active.map((t) => {
        // Derive remaining time from the wall clock, not by decrementing — this is
        // what keeps timers accurate after the tab is backgrounded.
        const timeLeft = Math.max(0, Math.round((t.endsAt - now) / 1000));

        if (timeLeft === 0) {
          anyDone = true;
          if (!t.alarmPlayed) {
            playBeep();
            notifyDone(t.label);
            firstAlarmThisTick = true;
            changed = true;
            return { ...t, timeLeft: 0, alarmPlayed: true };
          }
        }

        if (timeLeft !== t.timeLeft) {
          changed = true;
          return { ...t, timeLeft };
        }
        return t;
      });

      // Keep alarming until the user dismisses a finished timer: re-beep every 10s.
      if (firstAlarmThisTick) {
        lastReBeepRef.current = now;
      } else if (anyDone && now - lastReBeepRef.current > 10000) {
        lastReBeepRef.current = now;
        playBeep();
      }

      if (changed) {
        setTimers(next);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const addTimer = (duration: number, label: string = 'Timer') => {
    // Request notification permission on the first timer so background alerts can
    // fire later. Prompt shows once; ignored if already granted/denied.
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
    } catch {
      /* ignore */
    }

    const newTimer: Timer = {
      id: `timer-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      label,
      duration,
      timeLeft: duration,
      endsAt: Date.now() + duration * 1000,
      alarmPlayed: false,
    };
    setTimers((prev) => [...prev, newTimer]);
  };

  const removeTimer = (id: string) => {
    setTimers((prev) => prev.filter((t) => t.id !== id));
  };

  const addTimeToTimer = (id: string, seconds: number) => {
    setTimers((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        // Extend from whatever's left (or from now if it already finished).
        const base = t.endsAt > Date.now() ? t.endsAt : Date.now();
        const endsAt = base + seconds * 1000;
        return {
          ...t,
          duration: t.duration + seconds,
          endsAt,
          timeLeft: Math.max(0, Math.round((endsAt - Date.now()) / 1000)),
          alarmPlayed: false,
        };
      }),
    );
  };

  const clearAllTimers = () => {
    setTimers([]);
  };

  return {
    timers,
    addTimer,
    removeTimer,
    addTimeToTimer,
    clearAllTimers,
  };
}
