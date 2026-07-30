// toBase64.ts — downscale a captured Blob and base64-encode it for a vision model.
// COPY: into src/camera/ next to useCameraPhoto.ts. Zero dependencies.
// CHANGE: DEFAULTS.maxDimension / maxBytes to trade round-trip latency for detail.

export interface EncodedImage {
  /** Raw base64, no data: prefix — what Anthropic/OpenAI image blocks want. */
  base64: string;
  /** Same bytes as a data URL — handy for <img src> previews. */
  dataUrl: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
  /** Encoded byte length (pre-base64). base64 is ~1.37x this on the wire. */
  bytes: number;
}

export interface DownscaleOptions {
  /** Longest edge of the output, in px. */
  maxDimension?: number;
  /** Hard ceiling on encoded bytes; quality then size are stepped down to meet it. */
  maxBytes?: number;
  mediaType?: 'image/jpeg' | 'image/png' | 'image/webp';
  quality?: number;
}

const DEFAULTS: Required<DownscaleOptions> = {
  maxDimension: 1024, // ~1.1k tokens on claude-sonnet; fast enough for a live loop
  maxBytes: 900_000,
  mediaType: 'image/jpeg',
  quality: 0.85,
};

const MAX_PASSES = 6;

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void };

async function decode(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      // from-image so EXIF-rotated phone photos are not encoded sideways.
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
    } catch {
      /* older Safari rejects the options bag — fall through */
    }
    try {
      const bmp = await createImageBitmap(blob);
      return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Image could not be decoded — the blob is not a supported image.'));
      el.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (cause) {
    URL.revokeObjectURL(url);
    throw cause;
  }
}

function drawScaled(src: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable — cannot downscale this image.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return canvas;
}

function encode(canvas: HTMLCanvasElement, mediaType: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (!b || b.size === 0) { reject(new Error(`Encoding to ${mediaType} produced no data.`)); return; }
        // Browsers SILENTLY fall back to PNG for a codec they lack (Safari < 14 + webp).
        // Shipping those bytes under the wrong media_type makes the vision API 400 —
        // so fail loudly here instead of mislabelling the payload.
        const actual = (b.type.split(';')[0] ?? '').toLowerCase();
        if (actual !== mediaType) {
          reject(new Error(`This browser cannot encode ${mediaType} (it produced ${actual || 'an untyped blob'}). Pass mediaType: 'image/jpeg'.`));
          return;
        }
        resolve(b);
      },
      mediaType,
      quality,
    );
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('FileReader failed to read the encoded image.'));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      if (comma < 0) { reject(new Error('Unexpected FileReader output — no data URL payload.')); return; }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** Read intrinsic pixel size without re-encoding. Throws on undecodable input. */
export async function readImageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const d = await decode(blob);
  try {
    return { width: d.width, height: d.height };
  } finally {
    d.release();
  }
}

/**
 * Downscale + encode. Throws (never returns placeholder bytes) if the blob
 * cannot be decoded or the browser refuses a canvas.
 */
export async function toBase64(blob: Blob, options: DownscaleOptions = {}): Promise<EncodedImage> {
  const { maxDimension, maxBytes, mediaType, quality } = { ...DEFAULTS, ...options };
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error('toBase64 received an empty blob.');

  const decoded = await decode(blob);
  try {
    if (decoded.width === 0 || decoded.height === 0) throw new Error('Decoded image has zero dimensions.');
    const longest = Math.max(decoded.width, decoded.height);
    let scale = Math.min(1, maxDimension / longest);
    let q = quality;
    let out: Blob | null = null;
    let w = 0;
    let h = 0;

    // Step quality down, then resolution, until the payload fits. Bounded loop.
    // PNG ignores `quality`, so for PNG we go straight to shrinking the pixels.
    const lossy = mediaType !== 'image/png';
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      w = Math.max(1, Math.round(decoded.width * scale));
      h = Math.max(1, Math.round(decoded.height * scale));
      out = await encode(drawScaled(decoded.source, w, h), mediaType, q);
      if (out.size <= maxBytes) break;
      if (lossy && q > 0.5) q = Math.max(0.5, q - 0.15);
      else scale *= 0.75;
    }
    if (!out) throw new Error('Image encoding produced no output.');
    if (out.size > maxBytes) {
      throw new Error(
        `Image is still ${Math.round(out.size / 1024)}KB after ${MAX_PASSES} downscale passes ` +
          `(limit ${Math.round(maxBytes / 1024)}KB). Lower maxDimension or raise maxBytes.`,
      );
    }
    const base64 = await blobToBase64(out);
    return { base64, dataUrl: `data:${mediaType};base64,${base64}`, mediaType, width: w, height: h, bytes: out.size };
  } finally {
    decoded.release();
  }
}

/** Anthropic messages-API image block, ready to push into a content array. */
export function toAnthropicImageBlock(img: EncodedImage) {
  return { type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 } };
}

/** OpenAI chat-completions image part (the fallback provider) — same bytes, data URL form. */
export function toOpenAIImageBlock(img: EncodedImage) {
  return { type: 'image_url' as const, image_url: { url: img.dataUrl } };
}
