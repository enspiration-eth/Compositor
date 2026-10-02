// Camera RAW develop (RawImporter.swift + RawDevelopSheet.swift). The Mac app hands RAW files to Core Image's
// CIRAWFilter; here a DNG's Bayer mosaic is read with UTIF and developed by web/wasm/src/RawPixels.c, with the DNG
// colour model done as the DNG SDK does it: the camera's colour matrices interpolated for the white balance, the
// as-shot neutral turned into a temperature and tint (Robertson's method), and the camera to sRGB transform.
import { canvasOf, ctx2d } from './adjustments';
import { withHeap, loadKernels } from './kernels';

type Ifd = Record<string, any> & { width: number; height: number; data?: Uint8Array };
type M3 = number[]; // row-major 3×3

export interface RawImage {
  data: Uint16Array; width: number; height: number;
  /** The 2×2 CFA pattern, 0 red 1 green 2 blue, as [y0x0, y0x1, y1x0, y1x1]. */
  cfa: number[];
  black: number; white: number;
  neutral: number[] | null;
  cm1: M3 | null; cm2: M3 | null; temp1: number; temp2: number;
  baseline: number; orientation: number;
  crop: [number, number, number, number] | null;
}
export interface RawDevelopSettings { exposure: number; temperature: number; tint: number; boost: number; asShotTemperature: number; asShotTint: number }
export const isAsShot = (s: RawDevelopSettings) => s.exposure === 0 && s.boost === 1 && s.temperature === s.asShotTemperature && s.tint === s.asShotTint;
export const resetRaw = (s: RawDevelopSettings): RawDevelopSettings => ({ ...s, exposure: 0, boost: 1, temperature: s.asShotTemperature, tint: s.asShotTint });

/** Set by the UI: shows the Develop sheet and resolves with the developed canvas, or null when cancelled. */
export let rawDevelopHook: ((name: string, raw: RawImage) => Promise<HTMLCanvasElement | null>) | null = null;
export function setRawDevelopHook(f: typeof rawDevelopHook) { rawDevelopHook = f; }
export class DevelopCancelled extends Error { constructor() { super('Cancelled'); this.name = 'AbortError'; } }

let utifP: Promise<any> | null = null;
const utif = () => (utifP ??= import('utif').then(m => (m as any).default ?? m));
const num = (v: unknown, i = 0): number | undefined => { const a = v as ArrayLike<number> | undefined; return a && a.length > i ? Number(a[i]) : undefined; };
const arr = (v: unknown): number[] | null => { const a = v as ArrayLike<number> | undefined; return a && a.length ? Array.from(a, Number) : null; };

/** The file's Bayer mosaic and its DNG colour tags, or null when it has none UTIF can decode (then the preview is used). */
export async function parseRaw(buf: ArrayBuffer): Promise<RawImage | null> {
  const U = await utif();
  let ifds: Ifd[];
  try { ifds = U.decode(buf); } catch { return null; }
  const all: Ifd[] = [];
  const visit = (l: Ifd[]) => { for (const f of l) { all.push(f); if (f.subIFD) visit(f.subIFD); } };
  visit(ifds);
  const f = all.filter(x => num(x.t262) === 32803 && num(x.t277) !== 3).sort((a, b) => (num(b.t256) ?? 0) * (num(b.t257) ?? 0) - (num(a.t256) ?? 0) * (num(a.t257) ?? 0))[0];
  if (!f) return null;
  const rep = arr(f.t33421) ?? arr(ifds[0]!.t33421) ?? [2, 2], pat = arr(f.t33422) ?? arr(ifds[0]!.t33422);
  if (!pat || rep[0] !== 2 || rep[1] !== 2 || pat.length < 4 || pat.slice(0, 4).some(c => c > 2)) return null;
  try { U.decodeImage(buf, f, ifds); } catch { return null; }
  if (!f.width || !f.height || !f.data) return null;
  const bps = num(f.t258) ?? 16, n = f.width * f.height;
  const white = num(f.t50717) ?? (2 ** bps - 1);
  let data: Uint16Array;
  if (f.data.length >= n * 2) {
    // UTIF leaves 16-bit samples in either byte order depending on the compression: take the one that fits the white level.
    const b = f.data, le = new Uint16Array(n), be = new Uint16Array(n);
    let mle = 0, mbe = 0;
    for (let i = 0; i < n; i++) { const lo = b[i * 2]!, hi = b[i * 2 + 1]!; le[i] = lo | (hi << 8); be[i] = (lo << 8) | hi; }
    for (let i = 0; i < n; i += 97) { if (le[i]! > mle) mle = le[i]!; if (be[i]! > mbe) mbe = be[i]!; }
    data = mle <= white * 1.05 || mbe > white * 1.05 ? le : be;
  } else if (f.data.length >= n) data = Uint16Array.from(f.data.subarray(0, n));
  else return null;
  // Linearization table, when the file has one.
  const lin = arr(f.t50712);
  if (lin) for (let i = 0; i < n; i++) data[i] = lin[Math.min(lin.length - 1, data[i]!)]!;
  const blacks = arr(f.t50714) ?? [0];
  const tag = (k: string) => f[k] ?? ifds[0]![k];
  const illumTemp = (code: number | undefined) => ({ 1: 5500, 2: 4150, 3: 2850, 4: 5500, 9: 5500, 10: 6500, 11: 7500, 12: 6430, 13: 5000, 14: 4150, 15: 3450, 17: 2856, 18: 4874, 19: 6774, 20: 5503, 21: 6504, 22: 7504, 23: 5003, 24: 3200 } as Record<number, number>)[code ?? 0] ?? 5000;
  const cm1 = arr(tag('t50721')), cm2 = arr(tag('t50722'));
  const origin = arr(f.t50719), size = arr(f.t50720);
  return {
    data, width: f.width, height: f.height, cfa: pat.slice(0, 4),
    black: blacks.reduce((a, b) => a + b, 0) / blacks.length, white,
    neutral: arr(tag('t50728'))?.slice(0, 3) ?? null,
    cm1: cm1?.length === 9 ? cm1 : null, cm2: cm2?.length === 9 ? cm2 : null,
    temp1: illumTemp(num(tag('t50778'))), temp2: illumTemp(num(tag('t50779'))),
    baseline: num(tag('t50730')) ?? 0, orientation: num(ifds[0]!.t274) ?? 1,
    crop: origin && size ? [origin[0]!, origin[1]!, size[0]!, size[1]!] : null,
  };
}

// ---------- the DNG colour model ----------
const mul = (a: M3, b: M3): M3 => { const r: number[] = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!); return r; };
const apply = (m: M3, v: number[]) => [0, 1, 2].map(i => m[i * 3]! * v[0]! + m[i * 3 + 1]! * v[1]! + m[i * 3 + 2]! * v[2]!);
function inv(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C || 1e-12;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
const diag = (v: number[]): M3 => [v[0]!, 0, 0, 0, v[1]!, 0, 0, 0, v[2]!];
const xyToXYZ = ([x, y]: number[]) => [x! / y!, 1, (1 - x! - y!) / y!];
const XYZtoxy = (v: number[]) => { const s = v[0]! + v[1]! + v[2]!; return s > 0 ? [v[0]! / s, v[1]! / s] : [0.3457, 0.3585]; };
// Robertson's isotemperature lines, as in the DNG SDK's dng_temperature.cpp: reciprocal megakelvin, u, v, slope.
const TEMP_TABLE = [[0, 0.18006, 0.26352, -0.24341], [10, 0.18066, 0.26589, -0.25479], [20, 0.18133, 0.26846, -0.26876], [30, 0.18208, 0.27119, -0.28539],
  [40, 0.18293, 0.27407, -0.30470], [50, 0.18388, 0.27709, -0.32675], [60, 0.18494, 0.28021, -0.35156], [70, 0.18611, 0.28342, -0.37915],
  [80, 0.18740, 0.28668, -0.40955], [90, 0.18880, 0.28997, -0.44278], [100, 0.19032, 0.29326, -0.47888], [125, 0.19462, 0.30141, -0.58204],
  [150, 0.19962, 0.30921, -0.70471], [175, 0.20525, 0.31647, -0.84901], [200, 0.21142, 0.32312, -1.0182], [225, 0.21807, 0.32909, -1.2168],
  [250, 0.22511, 0.33439, -1.4512], [275, 0.23247, 0.33904, -1.7298], [300, 0.24010, 0.34308, -2.0637], [325, 0.24792, 0.34655, -2.4681],
  [350, 0.25591, 0.34951, -2.9641], [375, 0.26400, 0.35200, -3.5814], [400, 0.27218, 0.35407, -4.3633], [425, 0.28039, 0.35577, -5.3762],
  [450, 0.28863, 0.35714, -6.7262], [475, 0.29685, 0.35823, -8.5955], [500, 0.30505, 0.35907, -11.324], [525, 0.31320, 0.35968, -15.628],
  [550, 0.32129, 0.36011, -23.325], [575, 0.32931, 0.36038, -40.770], [600, 0.33724, 0.36051, -116.45]] as const;
const TINT_SCALE = -3000;
export function xyToTempTint([x, y]: number[]): [number, number] {
  const u = 2 * x! / (1.5 - x! + 6 * y!), v = 3 * y! / (1.5 - x! + 6 * y!);
  let lastDt = 0, lastDu = 0, lastDv = 0;
  for (let i = 1; i <= 30; i++) {
    let du = 1, dv = TEMP_TABLE[i]![3]; const len = Math.hypot(du, dv); du /= len; dv /= len;
    let uu = u - TEMP_TABLE[i]![1], vv = v - TEMP_TABLE[i]![2];
    let dt = -uu * dv + vv * du;
    if (dt <= 0 || i === 30) {
      if (dt > 0) dt = 0;
      dt = -dt;
      const f = i === 1 ? 0 : dt / (lastDt + dt);
      const temp = 1e6 / (TEMP_TABLE[i - 1]![0] * f + TEMP_TABLE[i]![0] * (1 - f));
      uu = u - (TEMP_TABLE[i - 1]![1] * f + TEMP_TABLE[i]![1] * (1 - f));
      vv = v - (TEMP_TABLE[i - 1]![2] * f + TEMP_TABLE[i]![2] * (1 - f));
      du = du * (1 - f) + lastDu * f; dv = dv * (1 - f) + lastDv * f;
      const l2 = Math.hypot(du, dv); du /= l2; dv /= l2;
      return [temp, (uu * du + vv * dv) * TINT_SCALE];
    }
    lastDt = dt; lastDu = du; lastDv = dv;
  }
  return [5000, 0];
}
export function tempTintToXy(temp: number, tint: number): [number, number] {
  const r = 1e6 / temp, offset = tint / TINT_SCALE;
  for (let i = 0; i < 30; i++) {
    if (r < TEMP_TABLE[i + 1]![0] || i === 29) {
      const a = TEMP_TABLE[i]!, b = TEMP_TABLE[i + 1]!, f = (b[0] - r) / (b[0] - a[0]);
      let u = a[1] * f + b[1] * (1 - f), v = a[2] * f + b[2] * (1 - f);
      let u1 = 1, v1 = a[3]; const l1 = Math.hypot(u1, v1); u1 /= l1; v1 /= l1;
      let u2 = 1, v2 = b[3]; const l2 = Math.hypot(u2, v2); u2 /= l2; v2 /= l2;
      let u3 = u1 * f + u2 * (1 - f), v3 = v1 * f + v2 * (1 - f); const l3 = Math.hypot(u3, v3); u3 /= l3; v3 /= l3;
      u += u3 * offset; v += v3 * offset;
      return [1.5 * u / (u - 4 * v + 2), v / (u - 4 * v + 2)];
    }
  }
  return [0.3457, 0.3585];
}
// Without colour matrices the camera is taken to see linear sRGB.
const XYZ_TO_SRGB: M3 = [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.2040, 1.0570];
const BRADFORD: M3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const D65 = [0.3127, 0.3290];
/** XYZ → camera at a white point: the two calibrations blended by inverse temperature (dng_color_spec). */
function colorMatrixAt(raw: RawImage, xy: number[]): M3 {
  if (!raw.cm1 && !raw.cm2) return XYZ_TO_SRGB;
  if (!raw.cm1 || !raw.cm2 || raw.temp1 === raw.temp2) return (raw.cm1 ?? raw.cm2)!;
  const [t] = xyToTempTint(xy);
  const [lo, hi, mLo, mHi] = raw.temp1 < raw.temp2 ? [raw.temp1, raw.temp2, raw.cm1, raw.cm2] : [raw.temp2, raw.temp1, raw.cm2, raw.cm1];
  const g = Math.min(1, Math.max(0, (1 / t - 1 / hi) / (1 / lo - 1 / hi)));
  return mLo.map((v, i) => g * v + (1 - g) * mHi[i]!);
}
/** The as-shot white balance as a temperature and tint: the neutral's white point found by iteration, as the SDK does. */
export function asShotSettings(raw: RawImage): RawDevelopSettings {
  let xy = [0.3457, 0.3585];
  if (raw.neutral && (raw.cm1 || raw.cm2)) {
    for (let k = 0; k < 30; k++) {
      const next = XYZtoxy(apply(inv(colorMatrixAt(raw, xy)), raw.neutral));
      const done = Math.abs(next[0]! - xy[0]!) + Math.abs(next[1]! - xy[1]!) < 1e-7;
      xy = next; if (done) break;
    }
  } else xy = D65;
  const [t, tint] = xyToTempTint(xy);
  const temperature = Math.round(Math.min(12000, Math.max(2000, t))), tn = Math.round(Math.min(150, Math.max(-150, tint)));
  return { exposure: 0, temperature, tint: tn, boost: 1, asShotTemperature: temperature, asShotTint: tn };
}
/** White-balance multipliers and the balanced camera → linear sRGB matrix for a temperature and tint. */
export function developTransform(raw: RawImage, s: RawDevelopSettings): { wb: number[]; m: M3; gain: number } {
  const xy = tempTintToXy(s.temperature, s.tint);
  const cm = colorMatrixAt(raw, xy);
  let neutral = apply(cm, xyToXYZ(xy));
  const mx = Math.max(...neutral); neutral = neutral.map(v => Math.max(1e-6, v / mx));
  const wb = neutral.map(v => 1 / v);
  // Balanced camera (neutral → 1,1,1) → XYZ at the white point → Bradford to D65 → linear sRGB.
  const toXYZ = mul(inv(cm), diag(neutral));
  const src = apply(BRADFORD, xyToXYZ(xy)), dst = apply(BRADFORD, xyToXYZ(D65));
  const adapt = mul(inv(BRADFORD), mul(diag([dst[0]! / src[0]!, dst[1]! / src[1]!, dst[2]! / src[2]!]), BRADFORD));
  let m = mul(XYZ_TO_SRGB, mul(adapt, toXYZ));
  const white = apply(m, [1, 1, 1]);
  m = m.map((v, i) => v / white[Math.floor(i / 3)]!);
  return { wb, m, gain: Math.pow(2, s.exposure + raw.baseline) };
}

/** Develops the mosaic. `previewSide` makes a quick superpixel image about that many pixels across (at least) for the
 *  sheet's preview; without it the full frame is demosaiced. Orientation and the default crop applied. */
export async function developRaw(raw: RawImage, s: RawDevelopSettings, previewSide?: number): Promise<HTMLCanvasElement> {
  await loadKernels();
  const { wb, m, gain } = developTransform(raw, s);
  const step = previewSide ? Math.max(1, Math.floor(Math.max(raw.width, raw.height) / 2 / previewSide)) : 0;
  const half = step > 0;
  const ow = half ? Math.floor(raw.width / 2 / step) : raw.width, oh = half ? Math.floor(raw.height / 2 / step) : raw.height;
  const img = new ImageData(ow, oh);
  withHeap((heap, mod) => {
    const src = heap.alloc(raw.data.length * 2);
    new Uint16Array(mod.HEAPU8.buffer, src, raw.data.length).set(raw.data);
    const out = heap.alloc(ow * oh * 4);
    mod._raw_develop(src, raw.width, raw.height, heap.bytes(raw.cfa), raw.black, raw.white, heap.floats(wb), heap.floats(m), gain, s.boost, step, out);
    img.data.set(mod.HEAPU8.subarray(out, out + ow * oh * 4));
  });
  let c = canvasOf(ow, oh); ctx2d(c).putImageData(img, 0, 0);
  if (raw.crop) {
    const k = half ? 0.5 / step : 1, [x, y, w, hh] = raw.crop.map(v => Math.round(v * k)) as [number, number, number, number];
    if (w > 0 && hh > 0 && x + w <= ow && y + hh <= oh && (w < ow || hh < oh)) { const cc = canvasOf(w, hh); ctx2d(cc).drawImage(c, -x, -y); c = cc; }
  }
  return orient(c, raw.orientation);
}
/** EXIF/TIFF orientation 1…8 applied. */
function orient(c: HTMLCanvasElement, o: number): HTMLCanvasElement {
  if (o <= 1 || o > 8) return c;
  const swap = o >= 5, w = c.width, h = c.height, out = canvasOf(swap ? h : w, swap ? w : h), x = ctx2d(out);
  const t: Record<number, [number, number, number, number, number, number]> = {
    2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, h], 4: [1, 0, 0, -1, 0, h],
    5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, h, 0], 7: [0, -1, -1, 0, h, w], 8: [0, -1, 1, 0, 0, w],
  };
  x.setTransform(...t[o]!); x.drawImage(c, 0, 0);
  return out;
}
