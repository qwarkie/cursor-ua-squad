// audioMime.ts — negotiate a recording container the browser CAN produce and your API WILL accept.
// COPY: drop next to useAudioRecorder.ts (it imports from here); usable standalone for any upload.
// CHANGE: MIME_CANDIDATES order if your transcription backend rejects a container.

/**
 * Ordered by "most likely to be accepted by a transcription API AND supported by the browser".
 * Chrome/Edge/Firefox -> webm/opus. Safari 14.1+ -> mp4 (AAC). The final '' entry lets the
 * browser pick its own default, which is the only thing that works on some Safari builds.
 */
export const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/mpeg',
  '',
] as const;

/**
 * Returns the MIME string to hand MediaRecorder, `''` for "let the browser decide",
 * or `null` when MediaRecorder does not exist at all. Never guesses a format that
 * `isTypeSupported` rejected — a wrong mimeType makes the constructor throw.
 */
export function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const candidate of MIME_CANDIDATES) {
    if (candidate === '') return ''; // browser default
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return null;
}

/**
 * Transcription APIs (OpenAI Whisper, Deepgram, Groq) dispatch on the FILE EXTENSION, not the
 * Content-Type. Upload as `clip.${extensionFor(mimeType)}` or Safari's mp4 gets rejected as webm.
 */
export function extensionFor(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'audio/webm') return 'webm';
  if (base === 'audio/ogg') return 'ogg';
  if (base === 'audio/mp4' || base === 'audio/x-m4a' || base === 'audio/aac') return 'm4a';
  if (base === 'audio/mpeg') return 'mp3';
  if (base === 'audio/wav' || base === 'audio/x-wav') return 'wav';
  return 'webm';
}
