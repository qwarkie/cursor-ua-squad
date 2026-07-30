// useVision.ts — one hook over both vision routes. Takes camera Blobs or already-encoded images.
// COPY: with the rest of kit/vision into src/lib/vision/. Needs react only; the backend is vision_router.py.
// CHANGE: nothing to start. Pass schemaName / baseUrl / timeoutMs through options.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { encodeImage } from './encodeImage';
import type { EncodeOptions } from './encodeImage';
import { detectEncodeSupport } from './encodeSupport';
import { requestDetect, requestExtract } from './visionClient';
import { isVisionImage, toVisionError } from './visionTypes';
import type { DetectResult, ExtractResult, VisionImage, VisionState } from './visionTypes';

export type { EncodeOptions } from './encodeImage';

/** A camera capture, a dropped file, or an image you already encoded yourself. */
export type VisionSource = Blob | VisionImage;

export interface UseVisionOptions {
  /** Key registered in VISION_SCHEMAS in vision_router.py. Overridable per call. */
  schemaName?: string;
  baseUrl?: string;
  timeoutMs?: number;
  encode?: EncodeOptions;
}

export interface ExtractArgs {
  schemaName?: string;
  /** Extra instruction appended to the request, e.g. "the total is in the bottom right". */
  prompt?: string;
  /** Replaces the router's system prompt entirely. */
  system?: string;
}

export interface DetectArgs {
  /** Closed vocabulary. Empty means the model chooses its own labels. */
  labels?: string[];
  prompt?: string;
  maxDetections?: number;
}

export interface UseVision<T> {
  /** False only when this browser cannot re-encode a Blob. Passing a VisionImage still works. */
  supported: boolean;
  extraction: VisionState<ExtractResult<T>>;
  detection: VisionState<DetectResult>;
  extract: (input: VisionSource | VisionSource[], args?: ExtractArgs) => Promise<void>;
  detect: (input: VisionSource, args?: DetectArgs) => Promise<void>;
  /** Re-runs the last call of that kind — wire these to the error retry button. */
  retryExtract: () => Promise<void>;
  retryDetect: () => Promise<void>;
  reset: () => void;
}

const IDLE = { status: 'idle' } as const;

export function useVision<T = Record<string, unknown>>(options: UseVisionOptions = {}): UseVision<T> {
  const support = useMemo(detectEncodeSupport, []);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [extraction, setExtraction] = useState<VisionState<ExtractResult<T>>>(IDLE);
  const [detection, setDetection] = useState<VisionState<DetectResult>>(IDLE);

  const mounted = useRef(true);
  const extractRun = useRef(0);
  const detectRun = useRef(0);
  const extractAbort = useRef<AbortController | null>(null);
  const detectAbort = useRef<AbortController | null>(null);
  const lastExtract = useRef<{ input: VisionSource | VisionSource[]; args?: ExtractArgs } | null>(null);
  const lastDetect = useRef<{ input: VisionSource; args?: DetectArgs } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      extractAbort.current?.abort();
      detectAbort.current?.abort();
    };
  }, []);

  /** Blob -> VisionImage. Already-encoded images pass straight through. */
  const prepare = useCallback(
    async (input: VisionSource[]): Promise<VisionImage[]> => {
      const encoded: VisionImage[] = [];
      for (const item of input) {
        if (isVisionImage(item)) encoded.push(item);
        else encoded.push(await encodeImage(item, optionsRef.current.encode));
      }
      return encoded;
    },
    [],
  );

  const needsEncoder = (input: VisionSource[]) => input.some((item) => !isVisionImage(item));

  const unsupportedState = <S,>(): VisionState<S> =>
    support.supported
      ? IDLE
      : { status: 'unsupported', capability: support.capability, reason: support.reason, hint: support.hint };

  const extract = useCallback(
    async (input: VisionSource | VisionSource[], args?: ExtractArgs): Promise<void> => {
      lastExtract.current = { input, args };
      const list = Array.isArray(input) ? input : [input];
      if (!support.supported && needsEncoder(list)) {
        setExtraction(unsupportedState<ExtractResult<T>>());
        return;
      }
      const schemaName = args?.schemaName ?? optionsRef.current.schemaName;
      if (!schemaName) {
        setExtraction({
          status: 'error',
          error: {
            code: 'missing_schema_name',
            message: 'No schema name. Pass useVision({ schemaName }) or extract(blob, { schemaName }) — it must match a key in VISION_SCHEMAS in vision_router.py.',
            status: null,
          },
        });
        return;
      }
      const id = ++extractRun.current;
      extractAbort.current?.abort();
      const controller = new AbortController();
      extractAbort.current = controller;
      setExtraction({ status: 'loading' });
      try {
        const images = await prepare(list);
        const data = await requestExtract<T>(
          images,
          { schemaName, prompt: args?.prompt, system: args?.system },
          { baseUrl: optionsRef.current.baseUrl, timeoutMs: optionsRef.current.timeoutMs, signal: controller.signal },
        );
        if (id !== extractRun.current || !mounted.current) return;
        setExtraction({ status: 'ready', data });
      } catch (thrown) {
        // A superseded, reset or unmounted run must never overwrite newer state with its own error.
        const error = toVisionError(thrown);
        if (error.code === 'aborted' || id !== extractRun.current || !mounted.current) return;
        setExtraction({ status: 'error', error });
      }
    },
    [prepare, support],
  );

  const detect = useCallback(
    async (input: VisionSource, args?: DetectArgs): Promise<void> => {
      lastDetect.current = { input, args };
      if (!support.supported && !isVisionImage(input)) {
        setDetection(unsupportedState<DetectResult>());
        return;
      }
      const id = ++detectRun.current;
      detectAbort.current?.abort();
      const controller = new AbortController();
      detectAbort.current = controller;
      setDetection({ status: 'loading' });
      try {
        const [image] = await prepare([input]);
        const data = await requestDetect(
          image,
          { labels: args?.labels, prompt: args?.prompt, maxDetections: args?.maxDetections },
          { baseUrl: optionsRef.current.baseUrl, timeoutMs: optionsRef.current.timeoutMs, signal: controller.signal },
        );
        if (id !== detectRun.current || !mounted.current) return;
        setDetection({ status: 'ready', data });
      } catch (thrown) {
        const error = toVisionError(thrown);
        if (error.code === 'aborted' || id !== detectRun.current || !mounted.current) return;
        setDetection({ status: 'error', error });
      }
    },
    [prepare, support],
  );

  const retryExtract = useCallback(async () => {
    const last = lastExtract.current;
    if (last) await extract(last.input, last.args);
  }, [extract]);

  const retryDetect = useCallback(async () => {
    const last = lastDetect.current;
    if (last) await detect(last.input, last.args);
  }, [detect]);

  const reset = useCallback(() => {
    extractRun.current += 1;
    detectRun.current += 1;
    extractAbort.current?.abort();
    detectAbort.current?.abort();
    lastExtract.current = null;
    lastDetect.current = null;
    setExtraction(IDLE);
    setDetection(IDLE);
  }, []);

  return { supported: support.supported, extraction, detection, extract, detect, retryExtract, retryDetect, reset };
}
