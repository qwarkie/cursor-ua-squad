// boxGeometry.ts — normalised [0..1] box -> pixels inside an <img>/<video>, correct under object-fit.
// COPY: with the rest of kit/vision into src/lib/vision/. Pure functions, no React, no DOM writes.
// CHANGE: nothing. This is the maths BoxOverlay.tsx renders with; reuse it for hit-testing.

import type { NormalisedBox } from './visionTypes';

export type ObjectFitMode = 'fill' | 'contain' | 'cover' | 'none' | 'scale-down';

/** `object-position` resolves to either a percentage of the free space or an absolute offset. */
export interface PositionComponent {
  unit: 'fraction' | 'px';
  value: number;
}

export interface MediaLayout {
  /** Intrinsic pixels of the source: naturalWidth/Height or videoWidth/Height. */
  mediaWidth: number;
  mediaHeight: number;
  /** CSS content-box of the element, borders and padding already subtracted. */
  containerWidth: number;
  containerHeight: number;
  fit: ObjectFitMode;
  positionX: PositionComponent;
  positionY: PositionComponent;
}

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const CENTER: PositionComponent = { unit: 'fraction', value: 0.5 };

const KEYWORDS: Record<string, number | undefined> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };

const FITS: ObjectFitMode[] = ['fill', 'contain', 'cover', 'none', 'scale-down'];

/** Anything other than the five real values (including an empty string) means the CSS default. */
export function toObjectFit(value: string): ObjectFitMode {
  const found = FITS.find((mode) => mode === value.trim());
  return found ?? 'fill';
}

function toComponent(token: string): PositionComponent | null {
  const keyword = KEYWORDS[token];
  if (keyword !== undefined) return { unit: 'fraction', value: keyword };
  if (token.endsWith('%')) {
    const parsed = Number.parseFloat(token);
    return Number.isFinite(parsed) ? { unit: 'fraction', value: parsed / 100 } : null;
  }
  if (token.endsWith('px')) {
    const parsed = Number.parseFloat(token);
    return Number.isFinite(parsed) ? { unit: 'px', value: parsed } : null;
  }
  return null;
}

/**
 * Parse the computed `object-position`. Browsers normalise it to two values
 * ("50% 50%", "left top", "10px 20%"); anything else falls back to the CSS default of centred.
 */
export function parseObjectPosition(value: string): { x: PositionComponent; y: PositionComponent } {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    const only = toComponent(tokens[0]);
    return only ? { x: only, y: CENTER } : { x: CENTER, y: CENTER };
  }
  if (tokens.length === 2) {
    const x = toComponent(tokens[0]);
    const y = toComponent(tokens[1]);
    if (x && y) return { x, y };
  }
  return { x: CENTER, y: CENTER };
}

/** Per-axis scale from intrinsic pixels to displayed pixels. Only `fill` scales the axes differently. */
export function fitScale(layout: MediaLayout): { scaleX: number; scaleY: number } | null {
  const { mediaWidth: mw, mediaHeight: mh, containerWidth: cw, containerHeight: ch, fit } = layout;
  if (!(mw > 0 && mh > 0 && cw > 0 && ch > 0)) return null;
  const ratioX = cw / mw;
  const ratioY = ch / mh;
  switch (fit) {
    case 'fill':
      return { scaleX: ratioX, scaleY: ratioY };
    case 'contain': {
      const s = Math.min(ratioX, ratioY);
      return { scaleX: s, scaleY: s };
    }
    case 'cover': {
      // The overflowing axis is cropped, and object-position decides which part survives.
      const s = Math.max(ratioX, ratioY);
      return { scaleX: s, scaleY: s };
    }
    case 'none':
      return { scaleX: 1, scaleY: 1 };
    case 'scale-down': {
      const s = Math.min(1, Math.min(ratioX, ratioY));
      return { scaleX: s, scaleY: s };
    }
    default: {
      const never: never = fit;
      throw new Error(`Unhandled object-fit: ${String(never)}`);
    }
  }
}

const resolve = (free: number, component: PositionComponent): number =>
  component.unit === 'px' ? component.value : free * component.value;

/**
 * Project a normalised box into content-box pixels of the element.
 * Under `cover` the free space is negative, so the offset is negative and the boxes
 * ride the crop instead of drifting — that is the case naive overlays get wrong.
 * Returns null while the media has no intrinsic size yet (video before loadedmetadata).
 */
export function projectBox(box: NormalisedBox, layout: MediaLayout): PixelRect | null {
  const scale = fitScale(layout);
  if (!scale) return null;
  const displayedWidth = layout.mediaWidth * scale.scaleX;
  const displayedHeight = layout.mediaHeight * scale.scaleY;
  const offsetX = resolve(layout.containerWidth - displayedWidth, layout.positionX);
  const offsetY = resolve(layout.containerHeight - displayedHeight, layout.positionY);
  return {
    left: offsetX + box.x * displayedWidth,
    top: offsetY + box.y * displayedHeight,
    width: box.width * displayedWidth,
    height: box.height * displayedHeight,
  };
}

/** Intrinsic size of the media, or null before it has decoded anything. */
export function intrinsicSize(
  element: HTMLImageElement | HTMLVideoElement,
): { width: number; height: number } | null {
  if ('videoWidth' in element) {
    return element.videoWidth > 0 && element.videoHeight > 0
      ? { width: element.videoWidth, height: element.videoHeight }
      : null;
  }
  return element.naturalWidth > 0 && element.naturalHeight > 0
    ? { width: element.naturalWidth, height: element.naturalHeight }
    : null;
}
