import React, { useEffect, useRef } from 'react';

interface WaveformProps {
  status: 'idle' | 'connecting' | 'recording' | 'isAiThinking' | 'isAiSpeaking';
  analyser: AnalyserNode | null;
  muted?: boolean;
}

export default function Waveform({ status, analyser, muted = false }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let phase = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };

    resize();
    window.addEventListener('resize', resize);

    // Setup frequency buffer
    const bufferLength = analyser ? analyser.frequencyBinCount : 64;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      const w = canvas.width / (window.devicePixelRatio || 1);
      const h = canvas.height / (window.devicePixelRatio || 1);

      ctx.clearRect(0, 0, w, h);
      phase += 0.08;

      let lines = 4;
      let amplitude = 10;
      let color = '226, 232, 240'; // neutral slate
      let speed = 0.08;

      if (muted) {
        // Mic is muted — show a flat, dim line regardless of live audio.
        amplitude = 2;
        color = '160, 160, 150'; // muted gray
        lines = 2;
        phase += 0.02;
      } else if (status === 'recording') {
        color = '239, 68, 68'; // red
        lines = 5;
        phase += 0.12;

        if (analyser) {
          analyser.getByteFrequencyData(dataArray);
          // Calculate average volume
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
          }
          const avg = sum / dataArray.length;
          // Scale amplitude based on volume: quiet -> 3px, loud -> 45px
          amplitude = 3 + (avg / 255) * 45;
        } else {
          amplitude = 15 + Math.sin(phase * 2) * 5;
        }
      } else if (status === 'isAiThinking') {
        amplitude = 8 + Math.cos(phase) * 3;
        color = '99, 102, 241'; // indigo
        lines = 3;
        phase += 0.04;
      } else if (status === 'isAiSpeaking') {
        amplitude = 25 + Math.sin(phase * 3) * 12;
        color = '16, 185, 129'; // emerald
        lines = 6;
        phase += 0.16;
      } else {
        // idle
        amplitude = 2;
        color = '115, 115, 115'; // neutral gray
        lines = 2;
        phase += 0.02;
      }

      ctx.lineWidth = 2.0;

      for (let i = 0; i < lines; i++) {
        ctx.beginPath();
        const percent = i / lines;
        const alpha = 1.0 - percent * 0.7;
        
        const gradient = ctx.createLinearGradient(0, 0, w, 0);
        gradient.addColorStop(0, `rgba(${color}, 0)`);
        gradient.addColorStop(0.5, `rgba(${color}, ${alpha})`);
        gradient.addColorStop(1, `rgba(${color}, 0)`);
        ctx.strokeStyle = gradient;

        const waveOffset = i * 0.8;
        for (let x = 0; x < w; x++) {
          const scaling = Math.sin((x / w) * Math.PI); // Pin ends to zero
          const y = h / 2 + Math.sin(x * 0.015 - phase + waveOffset) * amplitude * scaling;
          if (x === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }

      animationRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      window.removeEventListener('resize', resize);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [status, analyser, muted]);

  return (
    <div className="w-full h-24 bg-neutral-950/20 rounded-2xl border border-neutral-800/10 overflow-hidden relative backdrop-blur-md">
      <canvas ref={canvasRef} className="w-full h-full block" />
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
        {muted && status === 'recording' && (
          <span className="text-[11px] font-semibold tracking-wider text-amber-400 uppercase">
            🔇 Mic Muted
          </span>
        )}
        {!muted && status === 'recording' && (
          <span className="text-[11px] font-semibold tracking-wider text-red-500 uppercase animate-pulse">
            Listening Continuous
          </span>
        )}
        {status === 'isAiThinking' && (
          <span className="text-[11px] font-semibold tracking-wider text-indigo-400 uppercase animate-pulse">
            Chef is thinking...
          </span>
        )}
        {status === 'isAiSpeaking' && (
          <span className="text-[11px] font-semibold tracking-wider text-emerald-400 uppercase animate-pulse">
            Chef is speaking...
          </span>
        )}
        {status === 'connecting' && (
          <span className="text-[11px] font-semibold tracking-wider text-amber-400 uppercase animate-pulse">
            Connecting...
          </span>
        )}
        {status === 'idle' && (
          <span className="text-[11px] font-semibold tracking-wider text-neutral-400 uppercase">
            Mic Muted
          </span>
        )}
      </div>
    </div>
  );
}
