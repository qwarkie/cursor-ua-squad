// encodeSupport.ts — can THIS browser turn a Blob into base64? The three real `unsupported` cases.
// COPY: with the rest of kit/vision into src/lib/vision/. Zero dependencies, no React.
// CHANGE: nothing. Add a case here only if you find a fourth way the encode path can be missing.

export type EncodeSupport =
  | { supported: true }
  | { supported: false; capability: string; reason: string; hint: string };

let cached: EncodeSupport | null = null;

/** Cheap, synchronous, cached: N mounted components allocate ONE probe canvas between them. */
export function detectEncodeSupport(): EncodeSupport {
  if (typeof document === 'undefined') return probe(); // never cache a pre-DOM answer
  if (!cached) cached = probe();
  return cached;
}

function probe(): EncodeSupport {
  if (typeof document === 'undefined') {
    return {
      supported: false,
      capability: 'document',
      reason: 'There is no DOM in this runtime, so an image cannot be decoded or re-encoded.',
      hint: 'Call encodeImage() from the browser, or send an already-encoded VisionImage instead of a Blob.',
    };
  }
  const canvas = document.createElement('canvas');
  if (typeof canvas.toBlob !== 'function') {
    return {
      supported: false,
      capability: 'canvas.toBlob',
      reason: 'This browser has no HTMLCanvasElement.toBlob, so the photo cannot be re-encoded.',
      hint: 'Update the browser, or encode the image yourself and pass a VisionImage to extract()/detect().',
    };
  }
  if (!canvas.getContext('2d')) {
    return {
      supported: false,
      capability: 'canvas.2d',
      reason: 'The browser refused a 2D canvas context — usually memory pressure or a hardened privacy mode.',
      hint: 'Close other tabs and reload, or disable the anti-fingerprinting setting that blocks canvas.',
    };
  }
  return { supported: true };
}
