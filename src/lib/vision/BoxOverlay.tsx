// BoxOverlay.tsx — labelled boxes pinned over an <img> or <video>, correct under object-fit: cover.
// COPY: with the rest of kit/vision into src/lib/vision/. Put it inside the SAME `relative` wrapper as the media.
// CHANGE: the box and chip classes below to match your palette. Geometry lives in boxGeometry.ts.

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { intrinsicSize, parseObjectPosition, projectBox, toObjectFit } from './boxGeometry';
import type { MediaLayout } from './boxGeometry';
import type { DetectedRegion } from './visionTypes';

export interface BoxOverlayProps {
  /** The <img> or <video> the boxes belong to. Must be mounted in the same commit. */
  mediaRef: RefObject<HTMLImageElement | HTMLVideoElement | null>;
  regions: DetectedRegion[];
  /** Index of the region to highlight; the rest dim. Null highlights all equally. */
  activeIndex?: number | null;
  showConfidence?: boolean;
  onSelect?: (region: DetectedRegion, index: number) => void;
  className?: string;
}

type Placement = { layout: MediaLayout; offsetX: number; offsetY: number };

const px = (value: string): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function BoxOverlay({
  mediaRef,
  regions,
  activeIndex = null,
  showConfidence = true,
  onSelect,
  className,
}: BoxOverlayProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  // A ref is not reactive: `{photo && <img ref={mediaRef} />}` attaches AFTER this component's
  // first effect ran, and without this the boxes would never appear. Runs after every commit,
  // does one identity compare, and only re-renders on the commit where the element changes.
  const [media, setMedia] = useState<HTMLImageElement | HTMLVideoElement | null>(null);
  useEffect(() => {
    if (mediaRef.current !== media) setMedia(mediaRef.current);
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!media || !root) {
      setPlacement(null);
      return;
    }
    let frame = 0;

    const measure = () => {
      frame = 0;
      const size = intrinsicSize(media);
      if (!size) {
        setPlacement(null); // no decoded frame yet — render nothing rather than a guessed box
        return;
      }
      const rect = media.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const style = window.getComputedStyle(media);
      // getBoundingClientRect is the border box; object-fit lays out inside the CONTENT box.
      const insetLeft = px(style.borderLeftWidth) + px(style.paddingLeft);
      const insetTop = px(style.borderTopWidth) + px(style.paddingTop);
      const insetRight = px(style.borderRightWidth) + px(style.paddingRight);
      const insetBottom = px(style.borderBottomWidth) + px(style.paddingBottom);
      const containerWidth = rect.width - insetLeft - insetRight;
      const containerHeight = rect.height - insetTop - insetBottom;
      if (containerWidth <= 0 || containerHeight <= 0) {
        setPlacement(null);
        return;
      }
      const position = parseObjectPosition(style.objectPosition);
      setPlacement({
        // The overlay is not required to sit exactly on the media — measure the real gap.
        offsetX: rect.left - rootRect.left + insetLeft,
        offsetY: rect.top - rootRect.top + insetTop,
        layout: {
          mediaWidth: size.width,
          mediaHeight: size.height,
          containerWidth,
          containerHeight,
          fit: toObjectFit(style.objectFit),
          positionX: position.x,
          positionY: position.y,
        },
      });
    };

    // Coalesce bursts (rotate + reflow + metadata all fire together) into one measure per frame.
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };

    schedule();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(media);
    observer?.observe(root);
    // 'load' = <img> decoded, 'loadedmetadata' = <video> knows its size,
    // 'resize' on a <video> = the camera track changed resolution mid-stream.
    const events = ['load', 'loadedmetadata', 'resize'];
    const target: EventTarget = media;
    events.forEach((name) => target.addEventListener(name, schedule));
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      events.forEach((name) => target.removeEventListener(name, schedule));
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
    };
    // Deliberately NOT `regions`: the geometry depends only on the element. Re-running on a new
    // regions array (callers build one per render) would tear down and rebind the observer and
    // all five listeners on every single render.
  }, [media]);

  return (
    <div
      ref={rootRef}
      aria-hidden={onSelect ? undefined : true}
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ''}`}
    >
      {placement &&
        regions.map((region, index) => {
          const rect = projectBox(region.box, placement.layout);
          if (!rect) return null;
          const dim = activeIndex !== null && activeIndex !== index;
          return (
            <button
              key={`${region.label}-${index}`}
              type="button"
              disabled={!onSelect}
              onClick={onSelect ? () => onSelect(region, index) : undefined}
              // Runtime geometry only — every colour and radius below is a token.
              style={{
                left: `${placement.offsetX + rect.left}px`,
                top: `${placement.offsetY + rect.top}px`,
                width: `${rect.width}px`,
                height: `${rect.height}px`,
              }}
              className={`absolute rounded-lg border-2 text-left ${
                dim ? 'border-secondary opacity-50' : 'border-brand-solid'
              } ${onSelect ? 'pointer-events-auto cursor-pointer' : ''}`}
            >
              <span className="absolute left-0 top-0 max-w-full truncate rounded-br-lg rounded-tl-md bg-brand-solid px-1.5 py-0.5 text-xs font-medium text-primary_on-brand">
                {region.label}
                {showConfidence ? ` ${Math.round(region.confidence * 100)}%` : ''}
              </span>
            </button>
          );
        })}
    </div>
  );
}

export default BoxOverlay;
