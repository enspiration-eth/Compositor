// The adjustment and filter settings, ported from Compositor's Swift (Document/Levels.swift, Curves.swift,
// HueSaturation.swift, ImageAdjustments.swift, Filters.swift, Dither.swift, CameraRaw.swift). The lookup tables
// and cubes are built here exactly as the Swift builds them; the per-pixel work runs in the original C kernels
// (WebAssembly). Blurs, which the Mac app hands to Core Image, use the browser's canvas filters instead.
import * as K from './kernels';

export type AdjustmentKind = 'Hue/Saturation' | 'Levels' | 'Curves' | 'Exposure' | 'Gradient Map' | 'Grain' | 'Add Noise'
  | 'Gaussian Blur' | 'Motion Blur' | 'Invert' | 'Black & White' | 'Color Balance';
export const ADJUSTMENT_KINDS: AdjustmentKind[] = ['Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map', 'Grain', 'Add Noise',
  'Gaussian Blur', 'Motion Blur', 'Invert', 'Black & White', 'Color Balance'];

export type FilterKind = 'Gaussian Blur' | 'Motion Blur' | 'Add Noise' | 'Vignette' | 'Bloom / Glow' | 'Dither' | 'Tonal Contrast'
  | 'Lens Correction' | 'Camera Raw Filter' | 'Remove Background' | 'Content-Aware Fill' | 'Curves' | 'Exposure' | 'Gradient Map'
  | 'Grain' | 'Black & White' | 'Color Balance' | 'Levels' | 'Hue/Saturation' | 'Invert';
export const FILTER_MENU: FilterKind[] = ['Gaussian Blur', 'Motion Blur', 'Add Noise', 'Vignette', 'Bloom / Glow', 'Dither', 'Tonal Contrast',
  'Lens Correction', 'Camera Raw Filter', 'Remove Background'];
export const IMAGE_ADJUSTMENTS: FilterKind[] = ['Exposure', 'Gradient Map', 'Grain', 'Black & White', 'Color Balance'];

// ---------- Levels (Levels.swift) ----------
export interface LevelRange { black: number; gamma: number; white: number; outputBlack: number; outputWhite: number }
export const identityRange = (): LevelRange => ({ black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 });
export interface LevelsSettings { channel: 'RGB' | 'Red' | 'Green' | 'Blue'; ranges: LevelRange[] }
export const defaultLevels = (): LevelsSettings => ({ channel: 'RGB', ranges: [0, 1, 2, 3].map(identityRange) });
const clampF = (n: number, lo: number, hi: number, fb: number) => Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
export function normalizeRange(r: LevelRange): LevelRange {
  const black = clampF(r.black, 0, 254, 0);
  return { black, white: clampF(r.white, black + 1, 255, 255), gamma: clampF(r.gamma, 0.1, 9.99, 1),
    outputBlack: clampF(r.outputBlack, 0, 255, 0), outputWhite: clampF(r.outputWhite, 0, 255, 255) };
}
function rangeApply(r: LevelRange, v: number) {
  const s = normalizeRange(r);
  const input = Math.min(1, Math.max(0, (v * 255 - s.black) / (s.white - s.black)));
  return (s.outputBlack + Math.pow(input, 1 / s.gamma) * (s.outputWhite - s.outputBlack)) / 255;
}
export function levelsIsIdentity(l: LevelsSettings) {
  return l.ranges.every(r => { const n = normalizeRange(r); return n.black === 0 && n.white === 255 && n.gamma === 1 && n.outputBlack === 0 && n.outputWhite === 255; });
}
export function levelsTables(l: LevelsSettings): number[] {
  const out: number[] = [];
  for (const c of [1, 2, 3]) for (let i = 0; i < 256; i++) out.push(rangeApply(l.ranges[0], rangeApply(l.ranges[c], i / 255)));
  return out;
}
/** Levels › Auto (LevelsAutomatic.swift in spirit): clip 0.1% at each end of the RGB histogram. */
export function autoLevels(hist: number[][]): LevelsSettings {
  const l = defaultLevels();
  for (const c of [1, 2, 3]) {
    const bins = hist[c], total = bins.reduce((a, b) => a + b, 0);
    if (!total) continue;
    let acc = 0, lo = 0, hi = 255;
    for (let i = 0; i < 256; i++) { acc += bins[i]; if (acc > total * 0.001) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += bins[i]; if (acc > total * 0.001) { hi = i; break; } }
    if (hi - lo >= 2) l.ranges[c] = { ...identityRange(), black: lo, white: hi };
  }
  return l;
}

// ---------- Curves (Curves.swift) ----------
export interface CurvePoint { x: number; y: number }
export interface CurvesSettings { channel: 'RGB' | 'Red' | 'Green' | 'Blue'; channels: CurvePoint[][] }
export const defaultCurves = (): CurvesSettings => ({ channel: 'RGB', channels: [0, 1, 2, 3].map(() => [{ x: 0, y: 0 }, { x: 255, y: 255 }]) });
/** Shape-preserving cubic Hermite interpolation, as the Swift does. */
export function curveValue(p: CurvePoint[], x: number): number {
  let li = 0;
  for (let k = 0; k < p.length; k++) if (p[k].x <= x) li = k;
  const i = Math.min(p.length - 2, Math.max(0, li));
  const d: number[] = [];
  for (let k = 0; k < p.length - 1; k++) d.push((p[k + 1].y - p[k].y) / (p[k + 1].x - p[k].x));
  const slope = (j: number) => {
    if (j === 0) return d[0];
    if (j === p.length - 1) return d[d.length - 1];
    if (d[j - 1] * d[j] <= 0) return 0;
    return 2 / (1 / d[j - 1] + 1 / d[j]);
  };
  const h = p[i + 1].x - p[i].x, t = Math.min(1, Math.max(0, (x - p[i].x) / h));
  const y = (2 * t ** 3 - 3 * t * t + 1) * p[i].y + (t ** 3 - 2 * t * t + t) * h * slope(i)
    + (-2 * t ** 3 + 3 * t * t) * p[i + 1].y + (t ** 3 - t * t) * h * slope(i + 1);
  return Math.min(255, Math.max(0, y));
}
export function curvesTables(c: CurvesSettings): number[] {
  const out: number[] = [];
  for (const ch of [1, 2, 3]) for (let i = 0; i < 256; i++) out.push(curveValue(c.channels[0], curveValue(c.channels[ch], i)) / 255);
  return out;
}

// ---------- Hue/Saturation (HueSaturation.swift) ----------
export type ColorRangeName = 'Master' | 'Reds' | 'Yellows' | 'Greens' | 'Cyans' | 'Blues' | 'Magentas';
export const COLOR_RANGES: ColorRangeName[] = ['Master', 'Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas'];
export type Band = [number, number, number, number];
export const DEFAULT_BANDS: Record<ColorRangeName, Band> = {
  Master: [0, 0, 360, 360], Reds: [315, 345, 15, 45], Yellows: [15, 45, 75, 105], Greens: [75, 105, 135, 165],
  Cyans: [135, 165, 195, 225], Blues: [195, 225, 255, 285], Magentas: [255, 285, 315, 345],
};
export interface RangeAdjustment { hue: number; saturation: number; lightness: number }
export interface HueSaturationSettings {
  range: ColorRangeName; colorize: boolean; adjustments: Partial<Record<ColorRangeName, RangeAdjustment>>;
  /** Applies the selected range to everything outside its band instead. */
  invertRange?: boolean;
  /** Edited hue bands (falloff start, range start, range end, falloff end); missing ones use Photoshop's defaults. */
  bands?: Partial<Record<ColorRangeName, Band>>;
}
export const bandOf = (s: HueSaturationSettings, r: ColorRangeName): Band => s.bands?.[r] ?? DEFAULT_BANDS[r];
/** HueBand.setHandle: moves one handle, keeping the four in order and the band under a full circle. */
export function setBandHandle(b: Band, i: number, deg: number): Band {
  const v = ((deg % 360) + 360) % 360, u = [...b] as Band; u[i] = v;
  const span = fwd(u[0], u[3]), toS = fwd(u[0], u[1]), toE = fwd(u[0], u[2]);
  return span > 1 && span <= 350 && toS <= toE && toE <= span ? u : b;
}
/** HueBand.centered: the band moved whole so its middle sits at `deg`. */
export function shiftBand(b: Band, delta: number): Band { return b.map(v => (((v + delta) % 360) + 360) % 360) as Band; }
const wrap360 = (v: number) => { const r = v % 360; return r < 0 ? r + 360 : r; };
/** HueBand.normalize: all four handles in 0…360 and the band under a full circle. */
function normalizeBand(b: Band): Band {
  const u = b.map(wrap360) as Band;
  if (fwd(u[0], u[3]) > 350) u[3] = wrap360(u[0] + 350);
  return u;
}
/** HueBand.centered(on:): the band re-centered on `hue`, keeping its core and shoulder widths (the Sample eyedropper). */
export function bandCentered(b: Band, hue: number): Band {
  const core = fwd(b[1], b[2]), leading = fwd(b[0], b[1]), trailing = fwd(b[2], b[3]);
  const start = wrap360(hue - core / 2);
  return [wrap360(start - leading), start, wrap360(start + core), wrap360(start + core + trailing)];
}
/** HueBand.include: widened so `hue` is fully inside, moving whichever edge is nearer (the Add eyedropper). */
export function bandInclude(b: Band, hue: number): Band {
  if (bandWeight(b, hue) >= 1) return b;
  const [fs, rs, re, fe] = b, shoulderIn = fwd(fs, rs), shoulderOut = fwd(re, fe);
  return fwd(hue, rs) <= fwd(re, hue) ? normalizeBand([hue - shoulderIn, hue, re, fe]) : normalizeBand([fs, rs, hue, hue + shoulderOut]);
}
/** HueBand.exclude: narrowed so `hue` falls outside entirely, shoulder included (the Remove eyedropper). */
export function bandExclude(b: Band, hue: number): Band {
  if (bandWeight(b, hue) <= 0) return b;
  const [fs, rs, re, fe] = b, shoulderIn = fwd(fs, rs), shoulderOut = fwd(re, fe);
  return fwd(fs, hue) <= fwd(hue, fe) ? normalizeBand([hue + 1, hue + 1 + shoulderIn, re, fe]) : normalizeBand([fs, rs, hue - 1 - shoulderOut, hue - 1]);
}
/** The hue of a color as the Mac app's eyedroppers read it (PickerHSB), or null when it is too near neutral. */
export function sampledHue(r: number, g: number, b: number): number | null {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (max <= 0 || d / max <= 0.02) return null;
  let hue = max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d;
  hue *= 60; return hue < 0 ? hue + 360 : hue;
}
/** HueSaturationSettings.weight(of:hue:). */
export function rangeWeight(s: HueSaturationSettings, r: ColorRangeName, hue: number) {
  if (r === 'Master') return 1;
  const w = bandWeight(bandOf(s, r), hue);
  return s.invertRange && r === s.range ? 1 - w : w;
}
/** Mac's JSON for HueSaturationSettings: Swift encodes [ColorRange: T] dictionaries as flat [key, value, …] arrays. */
export function hueSatToMac(s: HueSaturationSettings): Record<string, unknown> {
  const flat = <T>(o: Partial<Record<ColorRangeName, T>>) => Object.entries(o).flatMap(([k, v]) => [k, v]);
  const bands = Object.fromEntries(COLOR_RANGES.map(r => [r, bandOf(s, r)]));
  return { range: s.range, colorize: s.colorize, invertRange: !!s.invertRange, adjustments: flat(s.adjustments),
    bands: flat(Object.fromEntries(Object.entries(bands).map(([k, b]) => [k, { falloffStart: b[0], rangeStart: b[1], rangeEnd: b[2], falloffEnd: b[3] }]))) };
}
export function hueSatFromMac(j: any): HueSaturationSettings | undefined {
  if (!j || typeof j !== 'object') return undefined;
  const unflat = (v: unknown): Record<string, any> => Array.isArray(v) ? Object.fromEntries(v.flatMap((x, i) => i % 2 === 0 ? [[x, v[i + 1]]] : [])) : (v && typeof v === 'object' ? v as Record<string, any> : {});
  const ok = (r: unknown): r is ColorRangeName => COLOR_RANGES.includes(r as ColorRangeName);
  const adjustments: HueSaturationSettings['adjustments'] = {};
  for (const [k, a] of Object.entries(unflat(j.adjustments))) if (ok(k) && a) adjustments[k] = { hue: +a.hue || 0, saturation: +a.saturation || 0, lightness: +a.lightness || 0 };
  const bands: HueSaturationSettings['bands'] = {};
  for (const [k, b] of Object.entries(unflat(j.bands))) if (ok(k) && b) {
    const v: Band = Array.isArray(b) ? b as Band : [b.falloffStart, b.rangeStart, b.rangeEnd, b.falloffEnd];
    if (v.every(Number.isFinite) && v.some((x, i) => x !== DEFAULT_BANDS[k][i])) bands[k] = v;
  }
  return { range: ok(j.range) ? j.range : 'Master', colorize: !!j.colorize, invertRange: !!j.invertRange, adjustments, ...(Object.keys(bands).length ? { bands } : {}) };
}
export const defaultHueSat = (): HueSaturationSettings => ({ range: 'Master', colorize: false, adjustments: {} });
const fwd = (from: number, to: number) => { const d = (to - from) % 360; return d < 0 ? d + 360 : d; };
function bandWeight(b: Band, hue: number) {
  const [fs, rs, re, fe] = b;
  const span = fwd(fs, fe);
  if (!(span > 0)) return 1;
  const pos = fwd(fs, hue);
  if (pos > span) return 0;
  const rampIn = fwd(fs, rs), plateauEnd = fwd(fs, re);
  if (pos < rampIn) return rampIn > 0 ? pos / rampIn : 1;
  if (pos <= plateauEnd) return 1;
  const rampOut = span - plateauEnd;
  return rampOut > 0 ? (span - pos) / rampOut : 1;
}
const isZeroAdj = (a?: RangeAdjustment) => !a || (a.hue === 0 && a.saturation === 0 && a.lightness === 0);
export function hueSatIsIdentity(s: HueSaturationSettings) { return !s.colorize && Object.values(s.adjustments).every(a => isZeroAdj(a)); }
function toHSL(r: number, g: number, b: number): [number, number, number] {
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), l = (hi + lo) / 2, d = hi - lo;
  if (!(d > 0)) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = hi === r ? (g - b) / d : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return [h, Math.min(1, s), l];
}
function toRGB(h: number, s: number, l: number): [number, number, number] {
  if (!(s > 0)) return [l, l, l];
  const c = (1 - Math.abs(2 * l - 1)) * s, sector = h / 60, x = c * (1 - Math.abs((sector % 2) - 1)), m = l - c / 2;
  let rgb: [number, number, number];
  switch (Math.trunc(sector)) {
    case 0: rgb = [c, x, 0]; break; case 1: rgb = [x, c, 0]; break; case 2: rgb = [0, c, x]; break;
    case 3: rgb = [0, x, c]; break; case 4: rgb = [x, 0, c]; break; default: rgb = [c, 0, x];
  }
  return rgb.map(v => Math.min(1, Math.max(0, v + m))) as [number, number, number];
}
function adjustedSaturation(sat: number, amount: number) {
  const a = Math.min(1, Math.max(-1, amount / 100));
  if (!(a > 0)) return Math.max(0, sat * (1 + a));
  return a >= 1 ? (sat > 0 ? 1 : 0) : Math.min(1, sat / (1 - a));
}
export function hueSatCube(s: HueSaturationSettings, dim = 33): Float32Array {
  const response: [number, number, number][] = [];
  for (let deg = 0; deg <= 360; deg++) {
    const r: [number, number, number] = [0, 0, 0];
    for (const [name, adj] of Object.entries(s.adjustments) as [ColorRangeName, RangeAdjustment][]) {
      if (isZeroAdj(adj)) continue;
      const w = rangeWeight(s, name, deg);
      if (!(w > 0)) continue;
      r[0] += adj.hue * w; r[1] += adj.saturation * w; r[2] += adj.lightness * w;
    }
    response.push(r);
  }
  const cur = s.adjustments[s.range] ?? { hue: 0, saturation: 0, lightness: 0 };
  const out = new Float32Array(dim * dim * dim * 4);
  let idx = 0;
  const step = dim - 1;
  for (let b = 0; b < dim; b++) for (let g = 0; g < dim; g++) for (let r = 0; r < dim; r++) {
    let [h, sat, l] = toHSL(r / step, g / step, b / step);
    let la = 0;
    if (s.colorize) { h = cur.hue % 360; sat = Math.min(1, Math.max(0, cur.saturation / 100)); la = cur.lightness / 100; }
    else {
      const sm = response[Math.min(360, Math.max(0, Math.round(h)))];
      la = sm[2] / 100; h = (h + sm[0]) % 360; if (h < 0) h += 360; sat = adjustedSaturation(sat, sm[1]);
    }
    const a = Math.min(1, Math.max(-1, la));
    l = a >= 0 ? l + (1 - l) * a : l * (1 + a);
    const [rr, gg, bb] = toRGB(h, sat, Math.min(1, Math.max(0, l)));
    out[idx++] = rr; out[idx++] = gg; out[idx++] = bb; out[idx++] = 1;
  }
  return out;
}

// ---------- ImageAdjustments.swift ----------
export interface ExposureSettings { exposure: number; offset: number; gamma: number }
export const defaultExposure = (): ExposureSettings => ({ exposure: 0, offset: 0, gamma: 1 });
export function exposureTable(e: ExposureSettings): number[] {
  const scale = Math.pow(2, e.exposure), t: number[] = [];
  for (let i = 0; i < 256; i++) {
    const enc = i / 255;
    let lin = enc <= 0.04045 ? enc / 12.92 : Math.pow((enc + 0.055) / 1.055, 2.4);
    lin = Math.pow(Math.max(0, lin * scale + e.offset), 1 / e.gamma);
    const o = lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
    t.push(Math.min(1, Math.max(0, o)));
  }
  return [...t, ...t, ...t];
}
export interface RGB { red: number; green: number; blue: number }
export interface GradientMapSettings { shadows: RGB; highlights: RGB; reversed: boolean }
export const defaultGradientMap = (): GradientMapSettings => ({ shadows: { red: 0, green: 0, blue: 0 }, highlights: { red: 1, green: 1, blue: 1 }, reversed: false });
export function gradientMapTable(g: GradientMapSettings): Uint8Array {
  const [dark, light] = g.reversed ? [g.highlights, g.shadows] : [g.shadows, g.highlights];
  const t = new Uint8Array(768);
  const ch = (a: number, b: number, x: number) => Math.min(255, Math.max(0, Math.round((a + (b - a) * x) * 255)));
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    t[i * 3] = ch(dark.red, light.red, x); t[i * 3 + 1] = ch(dark.green, light.green, x); t[i * 3 + 2] = ch(dark.blue, light.blue, x);
  }
  return t;
}
export interface BlackWhiteSettings { reds: number; yellows: number; greens: number; cyans: number; blues: number; magentas: number; tint: boolean; tintHue: number; tintSaturation: number }
export const defaultBlackWhite = (): BlackWhiteSettings => ({ reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintHue: 40, tintSaturation: 20 });
export interface ColorBalanceSettings { shadowCyanRed: number; shadowMagentaGreen: number; shadowYellowBlue: number; midCyanRed: number; midMagentaGreen: number;
  midYellowBlue: number; highlightCyanRed: number; highlightMagentaGreen: number; highlightYellowBlue: number; preserveLuminosity: boolean }
export const defaultColorBalance = (): ColorBalanceSettings => ({ shadowCyanRed: 0, shadowMagentaGreen: 0, shadowYellowBlue: 0, midCyanRed: 0, midMagentaGreen: 0,
  midYellowBlue: 0, highlightCyanRed: 0, highlightMagentaGreen: 0, highlightYellowBlue: 0, preserveLuminosity: true });
export interface GrainSettings { amount: number; size: number; roughness: number; seed: number }
export const defaultGrain = (): GrainSettings => ({ amount: 25, size: 1.5, roughness: 50, seed: 0 });

// ---------- Filters.swift ----------
export interface DitherSettings { style: number; pixelSize: number; pixelShape: 'Square' | 'Dot'; cellSize: number; textSize: number; lineSpacing: number;
  glow: number; dots: number; wobble: number; angle: number; levels: number; diffusion: number; density: number; contrast: number;
  colors: 'Black & White' | 'Two Colors' | 'Original'; dark: RGB; light: RGB; lightOnDark: boolean; characters: string }
export const DITHER_STYLES = ['Atkinson (Classic Mac)', 'Floyd–Steinberg', 'Bayer 2 × 2', 'Bayer 4 × 4', 'Bayer 8 × 8', 'Halftone Dots', 'Halftone Lines',
  'Halftone Diamonds', 'Mac Patterns', 'ASCII', 'Scanlines (CRT)'];
export const defaultDither = (): DitherSettings => ({ style: 0, pixelSize: 2, pixelShape: 'Square', cellSize: 8, textSize: 14, lineSpacing: 4, glow: 35, dots: 0,
  wobble: 0, angle: 45, levels: 2, diffusion: 100, density: 0, contrast: 0, colors: 'Black & White', dark: { red: 0, green: 0, blue: 0 },
  light: { red: 1, green: 1, blue: 1 }, lightOnDark: true, characters: ' .:-=+*#%@' });
export interface CRPoint { x: number; y: number }
export interface CRCurve { shadows: number; darks: number; lights: number; highlights: number; shadowSplit: number; darkSplit: number; lightSplit: number;
  rgb: CRPoint[]; red: CRPoint[]; green: CRPoint[]; blue: CRPoint[]; refineSaturation: number }
export interface CRWheel { hue: number; saturation: number; luminance: number }
export interface CRGrading { shadows: CRWheel; midtones: CRWheel; highlights: CRWheel; global: CRWheel; blending: number; balance: number }
export interface CRDetail { sharpenAmount: number; sharpenRadius: number; sharpenDetail: number; sharpenMasking: number; noiseLuminance: number;
  noiseLuminanceDetail: number; noiseLuminanceContrast: number; noiseColor: number; noiseColorDetail: number; noiseColorSmoothness: number }
export interface CROptics { removeChromaticAberration: boolean; enableLensProfile: boolean; profileDistortion: number; profileVignetting: number; distortion: number;
  purpleAmount: number; purpleHueLow: number; purpleHueHigh: number; greenAmount: number; greenHueLow: number; greenHueHigh: number; vignetteAmount: number; vignetteMidpoint: number }
export interface CRCalibration { process: number; shadowTint: number; redHue: number; redSaturation: number; greenHue: number; greenSaturation: number; blueHue: number; blueSaturation: number }
export interface CameraRawSettings { whiteBalance?: 'Custom' | 'Auto'; temperature: number; tint: number; exposure: number; contrast: number; highlights: number; shadows: number; whites: number;
  blacks: number; vibrance: number; saturation: number; texture: number; clarity: number; dehaze: number; vignetteAmount: number; vignetteMidpoint: number;
  vignetteRoundness: number; vignetteFeather: number; vignetteHighlights: number; vignetteStyle: number; grainAmount: number; grainSize: number; grainRoughness: number;
  glow: number; glowStyle: number; glowRange: number; glowSpread: number; glowWarmth: number;
  curve: CRCurve; mixer: { hue: number[]; saturation: number[]; luminance: number[]; points?: CRPointColor[] }; grading: CRGrading; detail: CRDetail; optics: CROptics; calibration: CRCalibration;
  geometry?: CRGeometry }
/** CameraRawPointColor: one picked color (hue 0…360, saturation and luminance 0…1) and how far its adjustment reaches. */
export interface CRPointColor { hue: number; saturation: number; luminance: number; hueShift: number; saturationShift: number; luminanceShift: number;
  hueRange: number; saturationRange: number; luminanceRange: number }
/** CameraRawGeometryGuide: normalized 0…1 from the lower-left of the pixel grid, as the Mac app stores it. */
export interface CRGuide { startX: number; startY: number; endX: number; endY: number }
/** CameraRawGeometrySettings (CameraRawGeometryCalibration.swift). */
export interface CRGeometry { upright: 'Off' | 'Guided'; projection: 'Perspective' | 'Rectilinear'; vertical: number; horizontal: number; rotate: number;
  aspect: number; scale: number; offsetX: number; offsetY: number; constrainCrop: boolean; guides: CRGuide[] }
export const defaultGeometry = (): CRGeometry => ({ upright: 'Off', projection: 'Perspective', vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 0,
  offsetX: 0, offsetY: 0, constrainCrop: false, guides: [] });
const guideLen = (g: CRGuide) => Math.hypot(g.endX - g.startX, g.endY - g.startY);
export function geometryAdjusts(g?: CRGeometry) {
  return !!g && ((g.upright === 'Guided' && g.guides.some(x => guideLen(x) > 0.01)) || !!(g.vertical || g.horizontal || g.rotate || g.aspect || g.scale || g.offsetX || g.offsetY));
}
function guidedCorrections(guides: CRGuide[]) {
  const first = guides[0]; if (!first) return [0, 0, 0];
  const dx = first.endX - first.startX, dy = first.endY - first.startY;
  if (Math.hypot(dx, dy) <= 1e-4) return [0, 0, 0];
  let rotate = -Math.atan2(dy, dx) * 180 / Math.PI;
  if (rotate > 45) rotate -= 90; else if (rotate < -45) rotate += 90;
  let vertical = 0, horizontal = 0;
  const second = guides[1];
  if (second) {
    const sx = second.endX - second.startX, sy = second.endY - second.startY;
    if (Math.hypot(sx, sy) > 1e-4) {
      const a2 = Math.atan2(sy, sx) * 180 / Math.PI;
      vertical = Math.abs(a2) > 45 ? (a2 > 0 ? 25 : -25) : 0;
      horizontal = Math.abs(a2) <= 45 ? (a2 > 0 ? 25 : -25) : 0;
    }
  }
  return [vertical, horizontal, rotate];
}
/** CameraRawGeometrySettings.outputCorners, converted from Core Image's y-up to pixel rows (TL, TR, BR, BL). */
export function geometryCorners(g0: CRGeometry, w: number, h: number): number[] {
  const cl = (v: number, lo = -100, hi = 100) => Math.min(hi, Math.max(lo, v || 0));
  const g = { ...g0, vertical: cl(g0.vertical), horizontal: cl(g0.horizontal), rotate: cl(g0.rotate, -45, 45), aspect: cl(g0.aspect), scale: cl(g0.scale), offsetX: cl(g0.offsetX), offsetY: cl(g0.offsetY) };
  let [vertical, horizontal, rotation] = [g.vertical, g.horizontal, g.rotate];
  if (g.upright === 'Guided') { const c = guidedCorrections(g.guides.filter(x => guideLen(x) > 0.01)); vertical += c[0]; horizontal += c[1]; rotation += c[2]; }
  const strength = g.projection === 'Perspective' ? 1 : 0.55;
  const v = vertical / 100 * w * 0.18 * strength, hz = horizontal / 100 * h * 0.18 * strength;
  const aspectScale = 1 + g.aspect / 200, zoom = 1 + g.scale / 100;
  const shiftX = g.offsetX / 100 * w * 0.15, shiftY = g.offsetY / 100 * h * 0.15;
  let pts: [number, number][] = [[-v + shiftX, h + shiftY], [w + v + shiftX, h + shiftY], [w + hz + shiftX, -shiftY], [-hz + shiftX, -shiftY]];
  const cx = w / 2 + shiftX, cy = h / 2 + shiftY, r = rotation * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  pts = pts.map(([x, y]) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos]);
  if (aspectScale !== 1) pts = pts.map(([x, y]) => [cx + (x - cx) * aspectScale, cy + (y - cy) / aspectScale]);
  if (zoom !== 1) pts = pts.map(([x, y]) => [cx + (x - cx) * zoom, cy + (y - cy) * zoom]);
  return pts.flatMap(([x, y]) => [x, h - y]);
}
/** CameraRawGeometrySettings.apply: the perspective warp (the wasm distort kernel), then Constrain Crop. */
export function applyGeometry(img: ImageData, g: CRGeometry): ImageData {
  const w = img.width, h = img.height;
  const r = K.distortWarp(img, w, h, geometryCorners(g, w, h));
  if (!r.mode) return img;
  if (!g.constrainCrop) return r.img;
  const [x0, y0, x1, y1] = K.alphaBounds(r.img);
  const cw = x1 - x0, ch = y1 - y0;
  if (cw < 1 || ch < 1 || (cw >= w && ch >= h)) return r.img;
  const src = canvasOf(w, h); ctx2d(src).putImageData(r.img, 0, 0);
  const out = canvasOf(w, h), x = ctx2d(out), k = Math.min(w / cw, h / ch);
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, x0, y0, cw, ch, (w - cw * k) / 2, (h - ch * k) / 2, cw * k, ch * k);
  return x.getImageData(0, 0, w, h);
}
const pointAdjusts = (p?: CRPointColor[]) => !!p?.some(q => q.hueShift || q.saturationShift || q.luminanceShift);
/** CameraRawMixerSettings.pointFloats. */
const pointFloats = (p: CRPointColor[]) => p.slice(0, 8).flatMap(q => [q.hue / 360, q.saturation, q.luminance, q.hueShift / 100, q.saturationShift / 100,
  q.luminanceShift / 100, Math.min(180, Math.max(5, q.hueRange)) / 360, Math.min(1, Math.max(0.05, q.saturationRange)), Math.min(1, Math.max(0.05, q.luminanceRange))]);
const linearCR = (): CRPoint[] => [{ x: 0, y: 0 }, { x: 1, y: 1 }];
const wheel = (): CRWheel => ({ hue: 0, saturation: 0, luminance: 0 });
export const CR_MIXER_NAMES = ['Reds', 'Oranges', 'Yellows', 'Greens', 'Aquas', 'Blues', 'Purples', 'Magentas'];
export const defaultCameraRaw = (): CameraRawSettings => ({ temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  vibrance: 0, saturation: 0, texture: 0, clarity: 0, dehaze: 0, vignetteAmount: 0, vignetteMidpoint: 50, vignetteRoundness: 0, vignetteFeather: 50,
  vignetteHighlights: 0, vignetteStyle: 0, grainAmount: 0, grainSize: 25, grainRoughness: 50, glow: 0, glowStyle: 0, glowRange: 0, glowSpread: 0, glowWarmth: 0,
  curve: { shadows: 0, darks: 0, lights: 0, highlights: 0, shadowSplit: 25, darkSplit: 50, lightSplit: 75, rgb: linearCR(), red: linearCR(), green: linearCR(), blue: linearCR(), refineSaturation: 0 },
  mixer: { hue: Array(8).fill(0), saturation: Array(8).fill(0), luminance: Array(8).fill(0) },
  grading: { shadows: wheel(), midtones: wheel(), highlights: wheel(), global: wheel(), blending: 50, balance: 0 },
  detail: { sharpenAmount: 0, sharpenRadius: 10, sharpenDetail: 25, sharpenMasking: 0, noiseLuminance: 0, noiseLuminanceDetail: 50, noiseLuminanceContrast: 0,
    noiseColor: 0, noiseColorDetail: 50, noiseColorSmoothness: 50 },
  optics: { removeChromaticAberration: false, enableLensProfile: false, profileDistortion: 100, profileVignetting: 100, distortion: 0, purpleAmount: 0,
    purpleHueLow: 270, purpleHueHigh: 310, greenAmount: 0, greenHueLow: 60, greenHueHigh: 120, vignetteAmount: 0, vignetteMidpoint: 50 },
  calibration: { process: 6, shadowTint: 0, redHue: 0, redSaturation: 0, greenHue: 0, greenSaturation: 0, blueHue: 0, blueSaturation: 0 } });

// CameraRawCurveSettings (CameraRawColor.swift): the parametric curve fitted to Photoshop's, then the point curves.
const isLinearCR = (p: CRPoint[]) => p.length === 2 && p[0].x === 0 && p[0].y === 0 && p[1].x === 1 && p[1].y === 1;
function crPoint(x: number, pts: CRPoint[]) { return pts.length < 2 ? x : curveValue(pts.map(q => ({ x: q.x * 255, y: q.y * 255 })), x * 255) / 255; }
function crBend(tone: number, lower: number, low: number, upper: number, high: number) {
  const strength = 1.66;
  if (tone < lower && lower > 0) return lower * Math.pow(tone / lower, Math.pow(2, -low / 100 * strength));
  if (tone > upper && upper < 1) { const rest = 1 - upper; return 1 - rest * Math.pow((1 - tone) / rest, Math.pow(2, high / 100 * strength)); }
  return tone;
}
function crParametric(c: CRCurve, tone: number) {
  if (!c.shadows && !c.darks && !c.lights && !c.highlights) return tone;
  const anchors: CRPoint[] = [];
  for (let i = 0; i <= 32; i++) {
    const x = i / 32;
    anchors.push({ x, y: crBend(crBend(x, c.shadowSplit / 100, c.shadows, c.lightSplit / 100, c.highlights), c.darkSplit / 100, c.darks, c.darkSplit / 100, c.lights) });
  }
  return crPoint(tone, anchors);
}
/** CameraRawSettings.neutralize: the Temperature and Tint that make a linear-light color neutral, or null. */
export function crNeutralize(r: number, g: number, b: number): { temperature: number; tint: number } | null {
  if (r <= 1e-4 || g <= 1e-4 || b <= 1e-4) return null;
  const a1 = 0.35 * r, b1 = 0.15 * r + 0.30 * g, c1 = g - r, a2 = -0.35 * b, b2 = 0.15 * b + 0.30 * g, c2 = g - b;
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) <= 1e-8) return null;
  const warm = (c1 * b2 - c2 * b1) / det, magenta = (a1 * c2 - a2 * c1) / det;
  if (!isFinite(warm) || !isFinite(magenta)) return null;
  return { temperature: warm * 100, tint: magenta * 100 };
}
export const srgbDecode = (e: number) => e <= 0.04045 ? e / 12.92 : Math.pow((e + 0.055) / 1.055, 2.4);
/** CameraRawSettings.autoBalance: gray-world average of the opaque pixels in linear light, then neutralize. */
export function crAutoBalance(img: ImageData) {
  const d = img.data, lut = new Float64Array(256).map((_, i) => srgbDecode(i / 255));
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue; r += lut[d[i]]; g += lut[d[i + 1]]; b += lut[d[i + 2]]; n++; }
  return n ? crNeutralize(r / n, g / n, b / n) : null;
}
/** CameraRawMixerSettings.weights(forHue:): how much each of the eight families owns a hue. */
export const crMixerWeights = (deg: number) => [0, 30, 60, 120, 180, 240, 270, 300].map(c => { let d = Math.abs(deg - c); if (d > 180) d = 360 - d; return Math.max(0, 1 - d / 40); });
/** CameraRawCurveSettings.region(for:): the parametric slider owning a tone. */
export const crCurveRegion = (c: CRCurve, tone: number): 'shadows' | 'darks' | 'lights' | 'highlights' =>
  tone < c.shadowSplit / 100 ? 'shadows' : tone < c.darkSplit / 100 ? 'darks' : tone < c.lightSplit / 100 ? 'lights' : 'highlights';
const crAdjustsCurve = (c: CRCurve) => !!(c.shadows || c.darks || c.lights || c.highlights || c.refineSaturation) || !isLinearCR(c.rgb) || !isLinearCR(c.red) || !isLinearCR(c.green) || !isLinearCR(c.blue);

export interface FilterSettings {
  radius: number; angle: number; distance: number; amount: number; gaussian: boolean; monochromatic: boolean;
  vignetteAmount: number; vignetteColor: RGB; vignetteMidpoint: number; vignetteRoundness: number; vignetteFeather: number; vignetteHighlights: number;
  bloomAmount: number; bloomRadius: number; tonalAmount: number; tonalRadius: number; tonalShadows: number; tonalMidtones: number; tonalHighlights: number;
  distortion: number; curves: CurvesSettings; exposure: ExposureSettings; gradientMap: GradientMapSettings; grain: GrainSettings;
  blackWhite: BlackWhiteSettings; colorBalance: ColorBalanceSettings; dither: DitherSettings; cameraRaw: CameraRawSettings;
  levels: LevelsSettings; hueSat: HueSaturationSettings;
  /** Panel-only previews, never saved: Camera Raw's Option-drag clipping view (1 highlights, 2 shadows) and Point Color's Visualize. */
  crClipping?: number; crVisualize?: number;
  /** Camera Raw's Option-drag on Masking: the sharpening edge mask instead of the grade. */
  crSharpenMask?: boolean;
}
export const defaultFilterSettings = (): FilterSettings => ({
  radius: 1, angle: 0, distance: 10, amount: 10, gaussian: false, monochromatic: false,
  vignetteAmount: 35, vignetteColor: { red: 0, green: 0, blue: 0 }, vignetteMidpoint: 50, vignetteRoundness: 100, vignetteFeather: 60, vignetteHighlights: 25,
  bloomAmount: 40, bloomRadius: 24, tonalAmount: 50, tonalRadius: 16, tonalShadows: 40, tonalMidtones: 60, tonalHighlights: 30,
  distortion: 0, curves: defaultCurves(), exposure: defaultExposure(), gradientMap: defaultGradientMap(), grain: defaultGrain(),
  blackWhite: defaultBlackWhite(), colorBalance: defaultColorBalance(), dither: defaultDither(), cameraRaw: defaultCameraRaw(),
  levels: defaultLevels(), hueSat: defaultHueSat(),
});
const MOTION_RADIUS_PER_PIXEL = 1 / Math.sqrt(12);
const LENS_STRENGTH = 0.35;

// ---------- canvas helpers ----------
export function canvasOf(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c;
}
export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  return c.getContext('2d', { willReadFrequently: true })!;
}
export function imageDataOf(c: HTMLCanvasElement): ImageData { return ctx2d(c).getImageData(0, 0, c.width, c.height); }
export function canvasFromImageData(img: ImageData): HTMLCanvasElement {
  const c = canvasOf(img.width, img.height); ctx2d(c).putImageData(img, 0, 0); return c;
}
/** Gaussian blur with the edges extended (Core Image's clampedToExtent). In wasm, so it also runs in workers. */
export function blurImageData(img: ImageData, sigma: number): ImageData {
  if (sigma <= 0.05) return img;
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  K.gaussBlur(out, sigma, true);
  return out;
}
/** Gaussian blur that spreads past transparent edges (no edge extension), for layer content. */
export function blurTransparent(img: ImageData, sigma: number): ImageData {
  if (sigma <= 0.05) return img;
  K.gaussBlur(img, sigma, false);
  return img;
}
export function motionBlur(img: ImageData, angleDeg: number, distance: number): ImageData {
  // Core Image's CIMotionBlur radius is distance/√12 (a box blur's standard deviation); this averages samples
  // spread evenly along the streak, which has the same spread.
  void MOTION_RADIUS_PER_PIXEL;
  const n = Math.max(2, Math.min(96, Math.ceil(distance)));
  return K.motionBlurInto(img, angleDeg, distance, n);
}
/** CIBloom, approximated: a blurred copy screened over the image at the intensity, kept to the image's own alpha. */
function bloom(img: ImageData, sigma: number, amount: number): ImageData {
  const blurred = blurImageData(img, sigma), k = Math.min(1, amount / 50);
  const d = img.data, b = blurred.data;
  for (let i = 0; i < d.length; i += 4) {
    const ba = b[i + 3] / 255 * k;
    for (let c = 0; c < 3; c++) { const s = d[i + c] / 255, v = b[i + c] / 255; d[i + c] = Math.round(255 * (s + ba * v * (1 - s))); }
  }
  return img;
}

function ditherGlyphs(chars: string, lineHeight: number) {
  const fontSize = lineHeight / 1.2;
  const meas = ctx2d(canvasOf(8, 8));
  meas.font = `bold ${fontSize}px ui-monospace, Menlo, monospace`;
  const width = Math.max(1, Math.round(meas.measureText('M').width)), height = lineHeight;
  const seen = new Set<string>(), drawn: { map: Uint8Array; cov: number }[] = [];
  for (const ch of chars) {
    if (seen.has(ch)) continue; seen.add(ch);
    const cv = canvasOf(width, height), c = ctx2d(cv);
    c.fillStyle = '#000'; c.fillRect(0, 0, width, height);
    c.font = meas.font; c.fillStyle = '#fff'; c.textBaseline = 'middle'; c.textAlign = 'center';
    c.fillText(ch, width / 2, height / 2);
    const d = c.getImageData(0, 0, width, height).data, map = new Uint8Array(width * height);
    let sum = 0;
    for (let i = 0; i < map.length; i++) { map[i] = d[i * 4]; sum += map[i]; }
    drawn.push({ map, cov: sum / (255 * width * height) });
  }
  drawn.sort((a, b) => a.cov - b.cov);
  const maps = new Uint8Array(drawn.length * width * height);
  drawn.forEach((g, i) => maps.set(g.map, i * width * height));
  return { maps, coverage: new Float32Array(drawn.map(g => g.cov)), width, height };
}
function applyDither(img: ImageData, ds: DitherSettings): ImageData {
  const usesPixelSize = ds.style !== 9 && ds.style !== 10;
  const block = usesPixelSize ? Math.round(ds.pixelSize) : 1;
  let working = img;
  if (block > 1) {
    const w = Math.ceil(img.width / block), h = Math.ceil(img.height / block);
    const small = canvasOf(w, h), c = ctx2d(small);
    c.imageSmoothingQuality = 'high';
    c.drawImage(canvasFromImageData(img), 0, 0, img.width / block, img.height / block);
    working = c.getImageData(0, 0, w, h);
  }
  const bytes = (c: RGB) => [Math.round(c.red * 255), Math.round(c.green * 255), Math.round(c.blue * 255)];
  const [dark, light] = ds.colors === 'Two Colors' ? [bytes(ds.dark), bytes(ds.light)] : [[0, 0, 0], [255, 255, 255]];
  K.dither(working, {
    style: ds.style, levels: Math.round(ds.levels), diffusion: ds.diffusion / 100, density: ds.density / 100, contrast: ds.contrast / 100,
    cell: Math.round(ds.style === 10 ? ds.lineSpacing : ds.cellSize), angle: ds.angle * Math.PI / 180, lightOnDark: ds.lightOnDark,
    originalColors: ds.colors === 'Original', dark, light, dots: ds.dots / 100, wobble: ds.wobble,
    glyphs: ds.style === 9 ? ditherGlyphs(ds.characters || ' .:-=+*#%@', Math.round(ds.textSize)) : undefined,
  });
  if (block <= 1) return working;
  const full = canvasOf(img.width, img.height), fc = ctx2d(full);
  fc.imageSmoothingEnabled = false;
  fc.drawImage(canvasFromImageData(working), 0, 0, working.width * block, working.height * block);
  const out = fc.getImageData(0, 0, img.width, img.height);
  if (ds.pixelShape === 'Dot') K.ditherDots(out, block, ds.colors === 'Two Colors' ? bytes(ds.dark) : [0, 0, 0]);
  return out;
}

export interface ApplyContext { seed: number; scale: number; canvasFrame?: [number, number, number, number]; originX?: number; originY?: number }

/** Runs one filter or adjustment over `img` in place-equivalent (returns the result). */
export function applyFilter(kind: FilterKind, s: FilterSettings, img: ImageData, ctx: ApplyContext): ImageData {
  switch (kind) {
    case 'Levels': if (!levelsIsIdentity(s.levels)) K.levelsApply(img, levelsTables(s.levels)); return img;
    case 'Curves': K.levelsApply(img, curvesTables(s.curves)); return img;
    case 'Hue/Saturation': if (!hueSatIsIdentity(s.hueSat)) K.cubeApply(img, hueSatCube(s.hueSat), 33); return img;
    case 'Exposure': K.levelsApply(img, exposureTable(s.exposure)); return img;
    case 'Gradient Map': K.gradientMap(img, gradientMapTable(s.gradientMap)); return img;
    case 'Black & White': {
      const b = s.blackWhite;
      K.blackWhite(img, [b.reds, b.yellows, b.greens, b.cyans, b.blues, b.magentas].map(v => v / 100), b.tint, b.tintHue, b.tintSaturation / 100);
      return img;
    }
    case 'Color Balance': {
      const c = s.colorBalance;
      K.colorBalance(img, [c.shadowCyanRed, c.shadowMagentaGreen, c.shadowYellowBlue].map(v => v / 100),
        [c.midCyanRed, c.midMagentaGreen, c.midYellowBlue].map(v => v / 100),
        [c.highlightCyanRed, c.highlightMagentaGreen, c.highlightYellowBlue].map(v => v / 100), c.preserveLuminosity);
      return img;
    }
    case 'Grain': if (s.grain.amount > 0) K.grain(img, s.grain.amount, s.grain.size, s.grain.roughness, ctx.seed, ctx.originX ?? 0, ctx.originY ?? 0, 1 / ctx.scale); return img;
    case 'Invert': {
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
      return img;
    }
    case 'Add Noise': K.noiseAddAt(img, s.amount, s.gaussian, s.monochromatic, ctx.seed, ctx.originX ?? 0, ctx.originY ?? 0); return img;
    case 'Gaussian Blur': return blurTransparent(img, s.radius * ctx.scale);
    case 'Motion Blur': return motionBlur(img, s.angle, s.distance * ctx.scale);
    case 'Vignette': {
      const f = ctx.canvasFrame ?? [0, 0, img.width, img.height];
      K.coloredVignette(img, f, !!ctx.canvasFrame, s.vignetteAmount, s.vignetteMidpoint, s.vignetteRoundness, s.vignetteFeather, s.vignetteHighlights,
        s.vignetteColor.red, s.vignetteColor.green, s.vignetteColor.blue);
      return img;
    }
    case 'Bloom / Glow': return bloom(img, s.bloomRadius * ctx.scale, s.bloomAmount);
    case 'Tonal Contrast': {
      const base = blurImageData(img, s.tonalRadius * ctx.scale);
      K.tonalContrast(img, base, s.tonalAmount, s.tonalShadows, s.tonalMidtones, s.tonalHighlights);
      return img;
    }
    case 'Lens Correction': K.lensDistort(img, s.distortion / 100 * LENS_STRENGTH); return img;
    case 'Dither': return applyDither(img, s.dither);
    case 'Camera Raw Filter': {
      // CameraRawSettings.apply: calibration, the basic grade, Curve + Color Mixer + Color Grading, effects and grain,
      // then optics and detail, each the Mac app's own C kernel.
      const cr = { ...defaultCameraRaw(), ...s.cameraRaw }, warm = cr.temperature / 100, mag = cr.tint / 100;
      const cal = cr.calibration, clip = s.crClipping ?? 0, vis = s.crVisualize ?? -1;
      if (s.crSharpenMask) {
        // CameraRawSettings.apply with `sharpenMask`: only the mask overlay, painted from the original.
        K.cameraRawSharpenMask(img, cr.detail, ctx.scale);
        return img;
      }
      if (clip) {
        // The clipping view replaces the grade (CameraRawSettings.apply with `clipping`).
        K.cameraRaw(img, { gains: [1 + 0.35 * warm + 0.15 * mag, 1 - 0.30 * mag, 1 - 0.35 * warm + 0.15 * mag], exposure: cr.exposure, contrast: cr.contrast,
          highlights: cr.highlights, shadows: cr.shadows, whites: cr.whites, blacks: cr.blacks, vibrance: cr.vibrance, saturation: cr.saturation, clipping: clip });
        return img;
      }
      if (vis < 0 && geometryAdjusts(cr.geometry)) img = applyGeometry(img, cr.geometry!);
      if (cal.shadowTint || cal.redHue || cal.redSaturation || cal.greenHue || cal.greenSaturation || cal.blueHue || cal.blueSaturation) K.cameraRawCalibration(img, cal);
      if (cr.temperature || cr.tint || cr.exposure || cr.contrast || cr.highlights || cr.shadows || cr.whites || cr.blacks || cr.vibrance || cr.saturation)
        K.cameraRaw(img, { gains: [1 + 0.35 * warm + 0.15 * mag, 1 - 0.30 * mag, 1 - 0.35 * warm + 0.15 * mag], exposure: cr.exposure, contrast: cr.contrast,
          highlights: cr.highlights, shadows: cr.shadows, whites: cr.whites, blacks: cr.blacks, vibrance: cr.vibrance, saturation: cr.saturation });
      const g = cr.grading, wheels = [g.shadows, g.midtones, g.highlights, g.global];
      const adjustsMixer = [...cr.mixer.hue, ...cr.mixer.saturation, ...cr.mixer.luminance].some(v => v !== 0);
      const adjustsGrading = wheels.some(w => w.saturation !== 0 || w.luminance !== 0);
      const pts = cr.mixer.points ?? [];
      if (crAdjustsCurve(cr.curve) || adjustsMixer || adjustsGrading || pointAdjusts(pts) || vis >= 0) {
        const c = cr.curve, table = (f: (x: number) => number) => Array.from({ length: 256 }, (_, i) => f(i / 255));
        K.cameraRawCurveColor(img, { tone: table(x => crPoint(crParametric(c, x), c.rgb)), red: table(x => crPoint(x, c.red)), green: table(x => crPoint(x, c.green)),
          blue: table(x => crPoint(x, c.blue)), refineSaturation: c.refineSaturation / 100, mixer: [...cr.mixer.hue, ...cr.mixer.saturation, ...cr.mixer.luminance].map(v => v / 100),
          points: pointFloats(pts), pointCount: Math.min(8, pts.length), grade: wheels.flatMap(w => [w.hue / 360, w.saturation / 100, w.luminance / 100]), blending: g.blending / 100, balance: g.balance / 100,
          visualize: vis });
      }
      if (cr.texture || cr.clarity || cr.dehaze || cr.glow || cr.vignetteAmount) K.cameraRawEffectsFull(img, cr, ctx.scale);
      if (cr.grainAmount > 0) K.grain(img, cr.grainAmount, 0.5 + (cr.grainSize / 100) * 19.5, cr.grainRoughness, ctx.seed, 0, 0, 1 / ctx.scale);
      const o = cr.optics;
      if (o.removeChromaticAberration || o.enableLensProfile || o.distortion || o.purpleAmount || o.greenAmount || o.vignetteAmount) {
        const distortionK = o.distortion / 100 * LENS_STRENGTH + (o.enableLensProfile ? o.profileDistortion / 100 * LENS_STRENGTH : 0);
        K.cameraRawOptics(img, { ...o, purpleHueLow: Math.min(o.purpleHueLow, o.purpleHueHigh), purpleHueHigh: Math.max(o.purpleHueLow, o.purpleHueHigh),
          greenHueLow: Math.min(o.greenHueLow, o.greenHueHigh), greenHueHigh: Math.max(o.greenHueLow, o.greenHueHigh), distortionK }, ctx.scale);
      }
      if (cr.detail.sharpenAmount || cr.detail.noiseLuminance || cr.detail.noiseColor) K.cameraRawDetail(img, cr.detail, ctx.scale);
      return img;
    }
    case 'Content-Aware Fill': case 'Remove Background': return img;
  }
}

/** Adjustment layer record (the .comp manifest's `adjustment` object). */
export interface AdjustmentRecord {
  kind: AdjustmentKind;
  hue: number; saturation: number; lightness: number; colorize: boolean;
  levels: LevelsSettings; curves: CurvesSettings;
  exposureSettings?: ExposureSettings; gradientMapSettings?: GradientMapSettings; grainSettings?: GrainSettings;
  blackWhiteSettings?: BlackWhiteSettings; colorBalanceSettings?: ColorBalanceSettings;
  blurRadius?: number; motionAngle?: number; motionDistance?: number;
  noiseAmount?: number; noiseGaussian?: boolean; noiseMonochromatic?: boolean; noiseSeed?: number;
  /** LayerAdjustment.hsvSettings: range-aware Hue/Saturation (older projects only have the Master fields above). */
  hsvSettings?: HueSaturationSettings;
}
export function newAdjustment(kind: AdjustmentKind): AdjustmentRecord {
  const a: AdjustmentRecord = { kind, hue: 0, saturation: 0, lightness: 0, colorize: false, levels: defaultLevels(), curves: defaultCurves() };
  if (kind === 'Exposure') a.exposureSettings = defaultExposure();
  if (kind === 'Gradient Map') a.gradientMapSettings = defaultGradientMap();
  if (kind === 'Grain') a.grainSettings = { ...defaultGrain(), seed: (Math.random() * 2 ** 32) >>> 0 };
  if (kind === 'Black & White') a.blackWhiteSettings = defaultBlackWhite();
  if (kind === 'Color Balance') a.colorBalanceSettings = defaultColorBalance();
  if (kind === 'Gaussian Blur') a.blurRadius = 4;
  if (kind === 'Motion Blur') { a.motionAngle = 0; a.motionDistance = 20; }
  if (kind === 'Add Noise') { a.noiseAmount = 10; a.noiseGaussian = false; a.noiseMonochromatic = false; a.noiseSeed = (Math.random() * 2 ** 32) >>> 0; }
  return a;
}
/** The filter settings an adjustment layer amounts to, so one code path runs both. */
export function adjustmentAsFilter(a: AdjustmentRecord): { kind: FilterKind; settings: FilterSettings; seed: number } {
  const s = defaultFilterSettings();
  s.levels = a.levels; s.curves = a.curves;
  s.hueSat = a.hsvSettings ? structuredClone(a.hsvSettings) : { range: 'Master', colorize: a.colorize, adjustments: { Master: { hue: a.hue, saturation: a.saturation, lightness: a.lightness } } };
  if (a.exposureSettings) s.exposure = a.exposureSettings;
  if (a.gradientMapSettings) s.gradientMap = a.gradientMapSettings;
  if (a.grainSettings) s.grain = a.grainSettings;
  if (a.blackWhiteSettings) s.blackWhite = a.blackWhiteSettings;
  if (a.colorBalanceSettings) s.colorBalance = a.colorBalanceSettings;
  s.radius = a.blurRadius ?? 4; s.angle = a.motionAngle ?? 0; s.distance = a.motionDistance ?? 20;
  s.amount = a.noiseAmount ?? 10; s.gaussian = !!a.noiseGaussian; s.monochromatic = !!a.noiseMonochromatic;
  return { kind: a.kind as FilterKind, settings: s, seed: a.kind === 'Grain' ? (a.grainSettings?.seed ?? 0) : (a.noiseSeed ?? 0) };
}
