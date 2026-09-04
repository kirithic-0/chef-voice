import React, { useEffect, useRef } from 'react';

interface WaveformProps {
  status: 'idle' | 'connecting' | 'recording' | 'isAiThinking' | 'isAiSpeaking';
  analyser: AnalyserNode | null;
  muted?: boolean;
  /** Sizing for the canvas box. Defaults to the full-width panel form. */
  className?: string;
  /** Hide the overlaid status caption when the surrounding UI already labels it. */
  hideLabel?: boolean;
}

export default function Waveform({ status, analyser, muted = false, className, hideLabel = false }: WaveformProps) {
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
      let color = '110, 104, 88'; // ink muted
      let speed = 0.08;

      if (muted) {
        // Mic is muted — show a flat, dim line regardless of live audio.
        amplitude = 2;
        color = '110, 104, 88'; // ink muted
        lines = 2;
        phase += 0.02;
      } else if (status === 'recording') {
        color = '126, 146, 112'; // sage — listening
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
        color = '162, 154, 136'; // ink muted — thinking
        lines = 3;
        phase += 0.04;
      } else if (status === 'isAiSpeaking') {
        amplitude = 25 + Math.sin(phase * 3) * 12;
        color = '201, 122, 70'; // clay — speaking
        lines = 6;
        phase += 0.16;
      } else {
        // idle
        amplitude = 2;
        color = '74, 68, 54'; // ink border — idle
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
    <div className={`relative overflow-hidden ${className ?? 'w-full h-24'}`}>
      <canvas ref={canvasRef} className="w-full h-full block" />
      {!hideLabel && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
          <span className="text-[11px] font-bold tracking-[0.14em] uppercase text-[#A29A88]">
            {muted
              ? 'Mic muted'
              : status === 'recording'
                ? 'Listening'
                : status === 'isAiThinking'
                  ? 'Thinking'
                  : status === 'isAiSpeaking'
                    ? 'Speaking'
                    : status === 'connecting'
                      ? 'Connecting'
                      : 'Mic off'}
          </span>
        </div>
      )}
    </div>
  );
}
