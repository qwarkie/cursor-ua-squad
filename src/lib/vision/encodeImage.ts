// encodeImage.ts — Blob (camera capture, file drop) -> downscaled base64 the vision routes accept.
// COPY: with the rest of kit/vision into src/lib/vision/. Zero dependencies.
// CHANGE: DEFAULTS below to trade round-trip latency for detail. maxBytes must stay under MAX_IMAGE_BYTES in vision_images.py.

import { visionError } from './visionTypes';
import type { VisionImage, VisionMediaType } from './visionTypes';

export interface EncodeOptions {
  /** Longest edge of the output in px. 1024 is ~1.1k tokens and reads small print on a receipt. */
  maxDimension?: number;
  /** Hard ceiling on encoded bytes. The server rejects anything over 3.5 MB decoded. */
  maxBytes?: number;
  mediaType?: VisionMediaType;
  quality?: number;
}

const DEFAULTS: Required<EncodeOptions> = {
  maxDimension: 1024,
  maxBytes: 3_000_000,
  mediaType: 'image/jpeg',
  quality: 0.85,
};

const MAX_PASSES = 6;

// Re-exported so `import { encodeImage, detectEncodeSupport } from '@/lib/vision/encodeImage'`
// keeps working; the probe itself lives in encodeSupport.ts.
export { detectEncodeSupport } from './encodeSupport';
export type { EncodeSupport } from './encodeSupport';

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void };

async function decode(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      // from-image so EXIF-rotated phone photos are not sent to the model sideways.
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
    } catch {
      /* older Safari rejects the options bag — fall through to <img> */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () =>
        reject(visionError('decode_failed', 'The blob is not an image this browser can decode.'));
      el.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (cause) {
    URL.revokeObjectURL(url); // never leak the object URL on the failure path
    throw cause;
  }
}

function drawScaled(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw visionError('encode_failed', 'The browser refused a 2D canvas context mid-encode.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

/**
 * iOS Safari holds a canvas backing store until GC and enforces a per-tab canvas memory ceiling;
 * six 1024px passes plus a live camera preview is enough to hit it and get a blank photo.
 * Zeroing the dimensions frees the buffer immediately.
 */
function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

function encodeCanvas(canvas: HTMLCanvasElement, mediaType: VisionMediaType, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (out) => {
        if (!out || out.size === 0) {
          reject(visionError('encode_failed', `Encoding to ${mediaType} produced no data.`));
          return;
        }
        // Browsers SILENTLY fall back to PNG for a codec they lack (Safari and webp).
        // The server sniffs magic bytes, so mislabelled bytes would 422 — fail here with the fix.
        const actual = (out.type.split(';')[0] ?? '').toLowerCase();
        if (actual !== mediaType) {
          reject(
            visionError(
              'encode_failed',
              `This browser cannot encode ${mediaType} (it produced ${actual || 'an untyped blob'}). Pass mediaType: 'image/jpeg'.`,
            ),
          );
          return;
        }
        resolve(out);
      },
      mediaType,
      quality,
    );
  });
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(visionError('encode_failed', 'FileReader could not read the encoded image.'));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      if (comma < 0) {
        reject(visionError('encode_failed', 'FileReader returned no data-URL payload.'));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Downscale, encode, base64. Throws a VisionError — never returns placeholder bytes.
 * Steps quality down first, then resolution, until the payload fits `maxBytes`.
 */
export async function encodeImage(blob: Blob, options: EncodeOptions = {}): Promise<VisionImage> {
  const { maxDimension, maxBytes, mediaType, quality } = { ...DEFAULTS, ...options };
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw visionError('encode_failed', 'encodeImage received an empty blob.');
  }
  const decoded = await decode(blob);
  try {
    if (decoded.width === 0 || decoded.height === 0) {
      throw visionError('decode_failed', 'The decoded image has zero dimensions.');
    }
    let scale = Math.min(1, maxDimension / Math.max(decoded.width, decoded.height));
    let q = quality;
    let out: Blob | null = null;
    let width = 0;
    let height = 0;
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      width = Math.max(1, Math.round(decoded.width * scale));
      height = Math.max(1, Math.round(decoded.height * scale));
      const canvas = drawScaled(decoded.source, width, height);
      try {
        out = await encodeCanvas(canvas, mediaType, q);
      } finally {
        releaseCanvas(canvas); // free the backing store before the next pass allocates another
      }
      if (out.size <= maxBytes) break;
      if (mediaType !== 'image/png' && q > 0.5) q = Math.max(0.5, q - 0.15);
      else scale *= 0.75;
    }
    if (!out || out.size > maxBytes) {
      throw visionError(
        'payload_too_large',
        `Image is still ${Math.round((out?.size ?? 0) / 1024)}KB after ${MAX_PASSES} passes (limit ${Math.round(maxBytes / 1024)}KB). Lower maxDimension.`,
      );
    }
    return { base64: await toBase64(out), mediaType, width, height };
  } finally {
    decoded.release();
  }
}
