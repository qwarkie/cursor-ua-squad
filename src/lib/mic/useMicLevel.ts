// useMicLevel.ts — real microphone loudness (0..1 RMS) from a Web Audio AnalyserNode.
// COPY: drop into src/hooks/ next to MicButton.tsx, which imports it for the halo + meter bars.
// CHANGE: GAIN (how hot the meter reads) and DECAY (how fast it falls back) below.
import { useEffect, useState } from 'react';

const FFT_SIZE = 1024;
const GAIN = 3.2;   // speech RMS sits around 0.05-0.3; scale it into a usable 0..1
const DECAY = 0.82; // asymmetric smoothing: snap up instantly, fall slowly

type AudioCtxCtor = typeof AudioContext;

function getAudioContextCtor(): AudioCtxCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtxCtor; webkitAudioContext?: AudioCtxCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export interface MicLevel {
  /** 0..1. Drive a CSS custom property with it — do not re-render a canvas per frame. */
  level: number;
  /** Non-null when the meter could not start. The meter is cosmetic: capture still works. */
  meterError: string | null;
}

/**
 * Pass `externalStream` (e.g. useAudioRecorder().stream) to reuse an already-open microphone and
 * avoid a second permission prompt. Leave it null/undefined and the meter opens its own stream
 * while `active` is true, and stops every track it opened on cleanup.
 */
export function useMicLevel(active: boolean, externalStream?: MediaStream | null): MicLevel {
  const [level, setLevel] = useState(0);
  const [meterError, setMeterError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) { setLevel(0); return; }
    const Ctor = getAudioContextCtor();
    if (!Ctor) { setMeterError('No Web Audio in this browser — the meter is off, capture still works.'); return; }

    let cancelled = false;
    let raf = 0;
    let ctx: AudioContext | null = null;
    let ownStream: MediaStream | null = null;
    let smoothed = 0;

    // One teardown path, callable from the cleanup AND from every abort branch inside run(),
    // so an effect that unmounts mid-await can never leave the mic light on.
    const stopAll = () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      ownStream?.getTracks().forEach((t) => t.stop());
      ownStream = null;
      const dying = ctx;
      ctx = null;
      void dying?.close().catch(() => undefined);
    };

    const run = async () => {
      let source: MediaStream | null = externalStream ?? null;
      if (!source) {
        if (!navigator.mediaDevices?.getUserMedia) {
          setMeterError('Meter unavailable — this browser has no getUserMedia.');
          return;
        }
        try {
          ownStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          source = ownStream;
        } catch {
          setMeterError('Meter unavailable — microphone access was refused.');
          return;
        }
      }
      if (cancelled) { stopAll(); return; }

      try {
        ctx = new Ctor();
        // Safari and Chrome hand back a suspended AudioContext outside a user gesture.
        if (ctx.state === 'suspended') await ctx.resume();
        if (cancelled) { stopAll(); return; } // torn down during the resume() await

        const analyser = ctx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = 0.6;
        ctx.createMediaStreamSource(source).connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        setMeterError(null);

        const tick = () => {
          if (cancelled) return;
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i += 1) {
            const v = ((buf[i] ?? 128) - 128) / 128;
            sum += v * v;
          }
          const scaled = Math.min(1, Math.sqrt(sum / buf.length) * GAIN);
          smoothed = scaled > smoothed ? scaled : smoothed * DECAY + scaled * (1 - DECAY);
          setLevel(smoothed);
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        stopAll();
        setMeterError('Meter unavailable — the audio graph failed to start.');
      }
    };
    void run();

    return () => {
      cancelled = true;
      stopAll();
      setLevel(0);
    };
  }, [active, externalStream]);

  return { level, meterError };
}
