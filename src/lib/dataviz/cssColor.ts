// cssColor.ts — turns whatever a CSS custom property holds into a colour an SVG attribute accepts.
// COPY: keep beside chartTheme.ts. Tailwind v4's palette computes to oklch(), which older Safari
// CHANGE: nothing. Add a branch below only if your theme ships colours in a space not listed here.

/**
 * Returns a colour string safe to put in `fill`/`stroke`, or null when the value is not a colour
 * we can render. Null is a real answer — the caller reports the variable, it never substitutes one.
 */
export function toCssColor(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith('#') || v.startsWith('rgb') || v.startsWith('hsl')) return v;
  if (v.startsWith('oklch(')) return oklchToRgbString(v.slice(6, -1));
  if (v.startsWith('oklab(')) return oklabToRgbString(v.slice(6, -1));
  // Named colours (`white`, `transparent`) pass through: SVG understands them directly.
  // `none` is not one — it means "no paint", which is a missing token, not a colour.
  if (v !== 'none' && /^[a-z]+$/i.test(v)) return v;
  return null;
}

/** The three colour components, alpha (after `/`) dropped — opacity is set per mark, not per colour. */
function components(body: string): string[] | null {
  const parts = body.split('/')[0].trim().split(/[\s,]+/).filter(Boolean);
  return parts.length >= 3 ? parts.slice(0, 3) : null;
}

/**
 * `none` is CSS Color 4 for "this component is missing" and browsers serialise a neutral grey as
 * `oklch(98.5% 0 none)`. It converts as zero — treating it as NaN throws away half the theme.
 */
function scalar(raw: string, reference: number): number {
  const t = raw.trim();
  if (t === 'none') return 0;
  const value = Number.parseFloat(t);
  if (Number.isNaN(value)) return Number.NaN;
  return t.endsWith('%') ? (value / 100) * reference : value;
}

function hueRadians(raw: string): number {
  const t = raw.trim();
  if (t === 'none') return 0;
  const value = Number.parseFloat(t);
  if (Number.isNaN(value)) return Number.NaN;
  const degrees = t.endsWith('turn')
    ? value * 360
    : t.endsWith('rad')
      ? (value * 180) / Math.PI
      : t.endsWith('grad')
        ? value * 0.9
        : value;
  return (degrees * Math.PI) / 180;
}

function oklchToRgbString(body: string): string | null {
  const parts = components(body);
  if (!parts) return null;
  const l = scalar(parts[0], 1);
  const c = scalar(parts[1], 0.4);
  const h = hueRadians(parts[2]);
  if ([l, c, h].some(Number.isNaN)) return null;
  return oklabToRgb(l, Math.cos(h) * c, Math.sin(h) * c);
}

function oklabToRgbString(body: string): string | null {
  const parts = components(body);
  if (!parts) return null;
  const l = scalar(parts[0], 1);
  const a = scalar(parts[1], 0.4);
  const b = scalar(parts[2], 0.4);
  if ([l, a, b].some(Number.isNaN)) return null;
  return oklabToRgb(l, a, b);
}

/** Björn Ottosson's Oklab -> linear sRGB matrices, then the sRGB transfer function. */
function oklabToRgb(L: number, a: number, b: number): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return `rgb(${encode(lr)}, ${encode(lg)}, ${encode(lb)})`;
}

function encode(channel: number): number {
  const x = Math.min(1, Math.max(0, channel));
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  return Math.round(c * 255);
}
