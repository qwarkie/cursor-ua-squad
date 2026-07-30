// index.ts — one import path for the whole module: `import { useVision, BoxOverlay } from '@/lib/vision'`.
// COPY: with the rest of kit/vision into src/lib/vision/.
// CHANGE: nothing. Import the individual files directly if you prefer explicit paths.

export { useVision } from './useVision';
export type { UseVision, UseVisionOptions, VisionSource, ExtractArgs, DetectArgs } from './useVision';

export { BoxOverlay } from './BoxOverlay';
export type { BoxOverlayProps } from './BoxOverlay';

export { encodeImage } from './encodeImage';
export type { EncodeOptions } from './encodeImage';

export { detectEncodeSupport } from './encodeSupport';
export type { EncodeSupport } from './encodeSupport';

export { requestExtract, requestDetect, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from './visionClient';
export type { VisionFetchOptions } from './visionClient';

export { projectBox, fitScale, intrinsicSize, parseObjectPosition, toObjectFit } from './boxGeometry';
export type { MediaLayout, PixelRect, ObjectFitMode } from './boxGeometry';

export { matchVision, visionError, toVisionError, isVisionError, isVisionImage } from './visionTypes';
export type {
  DetectResult,
  DetectedRegion,
  DroppedRegion,
  ExtractResult,
  NormalisedBox,
  VisionError,
  VisionImage,
  VisionMediaType,
  VisionState,
  VisionUnsupported,
} from './visionTypes';
