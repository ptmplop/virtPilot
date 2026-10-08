// VirtPilot palette — Tailwind's named scales, re-tuned for the "Slate + Steel" identity.
//
// Pages use Tailwind's named colours directly (text-emerald-400, bg-amber-500/15, …) for
// status and category accents. Rather than rewrite hundreds of call sites, each scale is
// rebuilt here from Tailwind's own ramp: same lightness ladder, chroma damped, hue pulled
// onto the brand's family. Every existing class keeps its meaning (green = running,
// amber = warning, red = destructive) but speaks in the same quiet voice as the logo.
const tw = require('tailwindcss/colors');

// ── sRGB ⇄ OKLCH ────────────────────────────────────────────────────────────────
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToOklch(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLin(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180) / Math.PI];
}

function oklchToHex([L, C, H]) {
  const h = (H * Math.PI) / 180;
  const A = C * Math.cos(h), B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, toGam(c))) * 255).toString(16).padStart(2, '0')).join('');
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLin(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const onWhite = (hex) => 1.05 / (luminance(hex) + 0.05);

// Rebuild a Tailwind ramp: keep each shade's lightness, damp chroma, set the hue.
// Shades 600+ are the light-theme text colours, so each is darkened (never lightened)
// until it clears WCAG AA 4.5:1 on the grey page as well as on white — Tailwind's own emerald/amber-600 do not.
function retune(scale, { hue, chroma }) {
  const out = {};
  for (const [shade, hex] of Object.entries(scale)) {
    let [L, C] = hexToOklch(hex);
    let col = oklchToHex([L, C * chroma, hue]);
    if (Number(shade) >= 600) {
      while (onWhite(col) < 4.95 && L > 0.2) {
        L -= 0.005;
        col = oklchToHex([L, C * chroma, hue]);
      }
    }
    out[shade] = col;
  }
  return out;
}

// Brand anchors (OKLCH hue): steel #4F7CAC ≈ 253°, slate #3B4A5E ≈ 258°.
const steel = retune(tw.blue, { hue: 253, chroma: 0.52 });
const sage = retune(tw.emerald, { hue: 162, chroma: 0.55 });
const lagoon = retune(tw.teal, { hue: 195, chroma: 0.5 });
const ochre = retune(tw.amber, { hue: 72, chroma: 0.62 });
const clay = retune(tw.orange, { hue: 50, chroma: 0.55 });
const brick = retune(tw.red, { hue: 27, chroma: 0.62 });
const heather = retune(tw.violet, { hue: 292, chroma: 0.45 });
const slate = retune(tw.slate, { hue: 258, chroma: 0.9 });

module.exports = {
  slate, gray: slate,
  blue: steel, sky: steel, indigo: steel,
  emerald: sage, green: sage,
  teal: lagoon, cyan: lagoon,
  amber: ochre, yellow: ochre,
  orange: clay,
  red: brick, rose: brick,
  violet: heather, purple: heather, fuchsia: heather,
  _util: { hexToOklch, oklchToHex },
};
