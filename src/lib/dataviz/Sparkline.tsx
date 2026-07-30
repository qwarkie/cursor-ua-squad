// Sparkline.tsx — a trend line small enough to sit inside a sentence. Inline SVG, zero dependencies.
// COPY: standalone. It does not import recharts, so it renders on the first paint and on any browser.
// CHANGE: MAX_POINTS if you feed it very long series; the colour comes from a text-* class you pass.

const MAX_POINTS = 200;

export type SparklineProps = {
  /** Oldest first. Needs at least two finite numbers — a single point is not a trend. */
  values: readonly number[];
  width?: number;
  height?: number;
  strokeWidth?: number;
  /** Fill under the line. Reads as "volume"; leave it off when only direction matters. */
  area?: boolean;
  /**
   * The line is drawn in `currentColor`, so the colour is whatever text colour lands here:
   * `text-utility-brand-600` (the default, and the same colour as chart series 0 in both themes),
   * `text-success-primary`, `text-error-primary`.
   */
  className?: string;
  /** Screen-reader description. Say what the line is, e.g. "Requests over the last 24 hours". */
  label?: string;
};

export function Sparkline({
  values,
  width = 96,
  height = 28,
  strokeWidth = 1.5,
  area = false,
  // Not `text-brand-secondary`: the design system remaps that to a neutral in dark mode, so a
  // brand-coloured trend line would silently turn grey. `text-utility-brand-600` stays brand.
  className = 'text-utility-brand-600',
  label = 'Trend',
}: SparklineProps) {
  const bad = values.findIndex((v) => !Number.isFinite(v));
  if (bad !== -1) {
    return (
      <span
        className="text-xs text-error-primary"
        role="note"
        title="A sparkline needs finite numbers. Drop or interpolate the bad entries before passing the series in."
      >
        values[{bad}] is {String(values[bad])}
      </span>
    );
  }
  if (values.length < 2) {
    return (
      <span className="text-xs text-quaternary" title="A trend needs at least two points.">
        —
      </span>
    );
  }

  const points = decimate(values, MAX_POINTS);
  const pad = strokeWidth;
  const geometry = project(points, width, height, pad);

  return (
    <svg
      className={`inline-block shrink-0 overflow-visible ${className}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      focusable="false"
    >
      {area && <path d={geometry.area} fill="currentColor" fillOpacity={0.14} stroke="none" />}
      <path
        d={geometry.line}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={geometry.lastX} cy={geometry.lastY} r={strokeWidth + 0.5} fill="currentColor" />
    </svg>
  );
}

/**
 * More points than pixels is wasted path data on a phone. Stride sampling, first and last always
 * kept — the shape stays honest because nothing is smoothed or averaged away, only skipped.
 */
function decimate(values: readonly number[], max: number): number[] {
  if (values.length <= max) return values.slice();
  const step = (values.length - 1) / (max - 1);
  const out: number[] = [];
  for (let i = 0; i < max; i += 1) out.push(values[Math.round(i * step)]);
  return out;
}

function project(values: readonly number[], width: number, height: number, pad: number) {
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  const usableW = Math.max(1, width - pad * 2);
  const usableH = Math.max(1, height - pad * 2);
  const stepX = usableW / (values.length - 1);
  // A flat series is real data, not an error: draw it on the midline rather than dividing by zero.
  const y = (v: number) => (span === 0 ? height / 2 : pad + (1 - (v - min) / span) * usableH);

  const coords = values.map((v, i) => [round(pad + i * stepX), round(y(v))] as const);
  const line = coords.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px} ${py}`).join(' ');
  const baseline = height - pad;
  const first = coords[0];
  const last = coords[coords.length - 1];
  const areaPath = `M${first[0]} ${baseline} ${line.replace(/^M/, 'L')} L${last[0]} ${baseline} Z`;

  return { line, area: areaPath, lastX: last[0], lastY: last[1] };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
