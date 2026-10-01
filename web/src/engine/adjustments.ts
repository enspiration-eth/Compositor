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
type Band = [number, number, number, number];
const DEFAULT_BANDS: Record<ColorRangeName, Band> = {
  Master: [0, 0, 360, 360], Reds: [315, 345, 15, 45], Yellows: [15, 45, 75, 105], Greens: [75, 105, 135, 165],
  Cyans: [135, 165, 195, 225], Blues: [195, 225, 255, 285], Magentas: [255, 285, 315, 345],
};
export interface RangeAdjustment { hue: number; saturation: number; lightness: number }
export interface HueSaturationSettings { range: ColorRangeName; colorize: boolean; adjustments: Partial<Record<ColorRangeName, RangeAdjustment>> }
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
      const w = name === 'Master' ? 1 : bandWeight(DEFAULT_BANDS[name], deg);
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
export interface CameraRawSettings { temperature: number; tint: number; exposure: number; contrast: number; highlights: number; shadows: number; whites: number;
  blacks: number; vibrance: number; saturation: number; texture: number; clarity: number; dehaze: number; vignetteAmount: number; vignetteMidpoint: number;
  vignetteRoundness: number; vignetteFeather: number; vignetteHighlights: number; grainAmount: number; grainSize: number; grainRoughness: number }
export const defaultCameraRaw = (): CameraRawSettings => ({ temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  vibrance: 0, saturation: 0, texture: 0, clarity: 0, dehaze: 0, vignetteAmount: 0, vignetteMidpoint: 50, vignetteRoundness: 0, vignetteFeather: 50,
  vignetteHighlights: 0, grainAmount: 0, grainSize: 25, grainRoughness: 50 });

export interface FilterSettings {
  radius: number; angle: number; distance: number; amount: number; gaussian: boolean; monochromatic: boolean;
  vignetteAmount: number; vignetteColor: RGB; vignetteMidpoint: number; vignetteRoundness: number; vignetteFeather: number; vignetteHighlights: number;
  bloomAmount: number; bloomRadius: number; tonalAmount: number; tonalRadius: number; tonalShadows: number; tonalMidtones: number; tonalHighlights: number;
  distortion: number; curves: CurvesSettings; exposure: ExposureSettings; gradientMap: GradientMapSettings; grain: GrainSettings;
  blackWhite: BlackWhiteSettings; colorBalance: ColorBalanceSettings; dither: DitherSettings; cameraRaw: CameraRawSettings;
  levels: LevelsSettings; hueSat: HueSaturationSettings;
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
export function blurImageData(img: ImageData, sigma: number): ImageData {
  const pad = Math.ceil(sigma * 3);
  const src = canvasFromImageData(img);
  const out = canvasOf(img.width, img.height);
  const c = ctx2d(out);
  if (sigma <= 0.05) return img;
  // Edges extend (Core Image's clampedToExtent): draw the image into a padded canvas with its edge pixels stretched.
  const padded = canvasOf(img.width + pad * 2, img.height + pad * 2), pc = ctx2d(padded);
  pc.drawImage(src, pad, pad);
  pc.drawImage(src, 0, 0, 1, img.height, 0, pad, pad, img.height);
  pc.drawImage(src, img.width - 1, 0, 1, img.height, img.width + pad, pad, pad, img.height);
  pc.drawImage(padded, 0, pad, padded.width, 1, 0, 0, padded.width, pad);
  pc.drawImage(padded, 0, pad + img.height - 1, padded.width, 1, 0, pad + img.height, padded.width, pad);
  c.filter = `blur(${sigma}px)`;
  c.drawImage(padded, -pad, -pad);
  c.filter = 'none';
  return c.getImageData(0, 0, img.width, img.height);
}
/** Gaussian blur that spreads past transparent edges (no edge extension), for layer content. */
export function blurTransparent(img: ImageData, sigma: number): ImageData {
  const src = canvasFromImageData(img), out = canvasOf(img.width, img.height), c = ctx2d(out);
  c.filter = `blur(${sigma}px)`; c.drawImage(src, 0, 0); c.filter = 'none';
  return c.getImageData(0, 0, img.width, img.height);
}
export function motionBlur(img: ImageData, angleDeg: number, distance: number, transparentEdges = true): ImageData {
  const src = canvasFromImageData(img), out = canvasOf(img.width, img.height), c = ctx2d(out);
  // Core Image's CIMotionBlur radius is distance/√12 (a box blur's standard deviation); this averages samples
  // spread evenly along the streak, which has the same spread.
  const length = distance; void MOTION_RADIUS_PER_PIXEL;
  const n = Math.max(2, Math.min(96, Math.ceil(length)));
  const a = -angleDeg * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a);
  // Accumulate in float for an exact average.
  const acc = new Float32Array(img.data.length);
  const tmp = ctx2d(canvasOf(img.width, img.height));
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1) - 0.5) * length;
    tmp.clearRect(0, 0, img.width, img.height);
    if (!transparentEdges) {
      tmp.drawImage(src, Math.round(t * dx) - 0, Math.round(t * dy));
    } else tmp.drawImage(src, t * dx, t * dy);
    const d = tmp.getImageData(0, 0, img.width, img.height).data;
    for (let k = 0; k < d.length; k += 4) {
      const al = d[k + 3] / 255;
      acc[k] += d[k] * al; acc[k + 1] += d[k + 1] * al; acc[k + 2] += d[k + 2] * al; acc[k + 3] += d[k + 3];
    }
  }
  const res = c.createImageData(img.width, img.height);
  for (let k = 0; k < acc.length; k += 4) {
    const al = acc[k + 3] / n;
    res.data[k + 3] = al;
    if (al > 0) { const s = 255 / (al * n); res.data[k] = acc[k] * s; res.data[k + 1] = acc[k + 1] * s; res.data[k + 2] = acc[k + 2] * s; }
  }
  return res;
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
    case 'Bloom / Glow': {
      // CIBloom: a blurred copy added over the image at the intensity. Composited here with 'screen' so it never clips.
      const blurred = blurImageData(img, s.bloomRadius * ctx.scale);
      const out = canvasFromImageData(img), c = ctx2d(out);
      c.globalCompositeOperation = 'screen'; c.globalAlpha = Math.min(1, s.bloomAmount / 50);
      c.drawImage(canvasFromImageData(blurred), 0, 0);
      c.globalCompositeOperation = 'destination-in'; c.globalAlpha = 1; c.drawImage(canvasFromImageData(img), 0, 0);
      return c.getImageData(0, 0, img.width, img.height);
    }
    case 'Tonal Contrast': {
      const base = blurImageData(img, s.tonalRadius * ctx.scale);
      K.tonalContrast(img, base, s.tonalAmount, s.tonalShadows, s.tonalMidtones, s.tonalHighlights);
      return img;
    }
    case 'Lens Correction': K.lensDistort(img, s.distortion / 100 * LENS_STRENGTH); return img;
    case 'Dither': return applyDither(img, s.dither);
    case 'Camera Raw Filter': {
      const cr = s.cameraRaw, warm = cr.temperature / 100, mag = cr.tint / 100;
      K.cameraRaw(img, { gains: [1 + 0.35 * warm + 0.15 * mag, 1 - 0.30 * mag, 1 - 0.35 * warm + 0.15 * mag], exposure: cr.exposure, contrast: cr.contrast,
        highlights: cr.highlights, shadows: cr.shadows, whites: cr.whites, blacks: cr.blacks, vibrance: cr.vibrance, saturation: cr.saturation });
      if (cr.texture || cr.clarity || cr.dehaze || cr.vignetteAmount)
        K.cameraRawEffects(img, cr, ctx.scale);
      if (cr.grainAmount > 0) K.grain(img, cr.grainAmount, 0.5 + (cr.grainSize / 100) * 19.5, cr.grainRoughness, ctx.seed, 0, 0, 1 / ctx.scale);
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
  hsvSettings?: unknown;
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
  s.hueSat = { range: 'Master', colorize: a.colorize, adjustments: { Master: { hue: a.hue, saturation: a.saturation, lightness: a.lightness } } };
  if (a.exposureSettings) s.exposure = a.exposureSettings;
  if (a.gradientMapSettings) s.gradientMap = a.gradientMapSettings;
  if (a.grainSettings) s.grain = a.grainSettings;
  if (a.blackWhiteSettings) s.blackWhite = a.blackWhiteSettings;
  if (a.colorBalanceSettings) s.colorBalance = a.colorBalanceSettings;
  s.radius = a.blurRadius ?? 4; s.angle = a.motionAngle ?? 0; s.distance = a.motionDistance ?? 20;
  s.amount = a.noiseAmount ?? 10; s.gaussian = !!a.noiseGaussian; s.monochromatic = !!a.noiseMonochromatic;
  return { kind: a.kind as FilterKind, settings: s, seed: a.kind === 'Grain' ? (a.grainSettings?.seed ?? 0) : (a.noiseSeed ?? 0) };
}
