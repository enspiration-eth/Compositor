// Subject detection for Remove Background, Select Subject and Object Selection. The Mac app asks Apple's Vision for a
// foreground mask (VNGenerateForegroundInstanceMaskRequest); browsers have nothing like it, so this runs U²-Net-p
// (Qin et al., Apache-2.0, public/models/u2netp.onnx) in onnxruntime-web's WebAssembly backend. Both are loaded on
// first use only. Everything after the raw mask follows SubjectRemoval.swift, with GuidedMatte's arithmetic compiled
// to wasm (wasm/src/MattePixels.c).
import type { InferenceSession } from 'onnxruntime-web';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { canvasOf, ctx2d } from './adjustments';
import { kernels, withHeap } from './kernels';

const SIZE = 320;
let sessionPromise: Promise<InferenceSession> | null = null;
let ortModule: typeof import('onnxruntime-web') | null = null;

async function session(): Promise<InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await import('onnxruntime-web/wasm');
      ortModule = ort as unknown as typeof import('onnxruntime-web');
      ort.env.wasm.numThreads = 1; // GitHub Pages isn't cross-origin isolated, so no wasm threads
      ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
      const url = new URL(`${import.meta.env.BASE_URL}models/u2netp.onnx`, location.href).href;
      return ort.InferenceSession.create(url, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    })();
    sessionPromise.catch(() => { sessionPromise = null; });
  }
  return sessionPromise;
}
export function modelLoaded() { return ortModule !== null; }

/** The model's saliency map for `src` (any size), 320×320, 0–1, normalized to its own range as rembg does. */
async function raw(src: CanvasImageSource): Promise<Float32Array> {
  const s = await session(), ort = ortModule!;
  const c = canvasOf(SIZE, SIZE), x = ctx2d(c);
  // Transparent areas read as neutral gray, not black, so an empty background doesn't look like a dark subject.
  x.fillStyle = '#808080'; x.fillRect(0, 0, SIZE, SIZE);
  x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, SIZE, SIZE);
  const px = x.getImageData(0, 0, SIZE, SIZE).data;
  let max = 0; for (let i = 0; i < px.length; i += 4) max = Math.max(max, px[i], px[i + 1], px[i + 2]);
  max = max || 255;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225], n = SIZE * SIZE, input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) input[k * n + i] = (px[i * 4 + k] / max - mean[k]) / std[k];
  const feeds = { [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) };
  const out = await s.run(feeds);
  const pred = out[s.outputNames[0]].data as Float32Array;
  let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) { lo = Math.min(lo, pred[i]); hi = Math.max(hi, pred[i]); }
  const res = new Float32Array(n), span = hi - lo || 1;
  for (let i = 0; i < n; i++) res[i] = (pred[i] - lo) / span;
  return res;
}

/** A 0–1 map drawn at w×h with high-quality resampling. */
function resample(map: Float32Array, mw: number, mh: number, w: number, h: number): Float32Array {
  const a = canvasOf(mw, mh), ax = ctx2d(a), img = ax.createImageData(mw, mh);
  for (let i = 0; i < map.length; i++) { const v = Math.round(map[i] * 255); img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  ax.putImageData(img, 0, 0);
  const b = canvasOf(w, h), bx = ctx2d(b); bx.imageSmoothingQuality = 'high'; bx.drawImage(a, 0, 0, w, h);
  const d = bx.getImageData(0, 0, w, h).data, out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] / 255;
  return out;
}
function grayLevels(src: CanvasImageSource, w: number, h: number): Float32Array {
  const c = canvasOf(w, h), x = ctx2d(c); x.fillStyle = '#808080'; x.fillRect(0, 0, w, h); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data, out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
  return out;
}

export interface MatteSettings { quality: 'Basic' | 'Advanced'; refineEdges: number; matteContrast: number; shiftEdge: number }
export const defaultMatte = (): MatteSettings => ({ quality: 'Basic', refineEdges: 12, matteContrast: 25, shiftEdge: 0 });

function refine(mask: Float32Array, guide: Float32Array, w: number, h: number, s: MatteSettings, radius: number) {
  withHeap((heap, m) => {
    const mp = heap.floats(mask);
    if (s.refineEdges > 0) { const gp = heap.floats(guide); if (!m._matte_guided_filter(mp, gp, w, h, Math.max(1, radius), 1e-4)) throw new Error('Out of memory refining the matte'); }
    if (s.shiftEdge !== 0) m._matte_shift_edge(mp, w, h, s.shiftEdge);
    if (s.matteContrast > 0) m._matte_contrast(mp, w * h, s.matteContrast);
    mask.set(kernels().HEAPF32.subarray(mp >> 2, (mp >> 2) + w * h));
  });
}

const rawCache = new WeakMap<object, Float32Array>();
/** SubjectRemoval.subjectMask: white over the subject, as a 0–1 map the size of `src`. Advanced refines it on a copy no
 *  larger than `limit` on its longest side, guided by the image itself. */
export async function subjectMatte(src: HTMLCanvasElement, s: MatteSettings = defaultMatte(), limit = 4096): Promise<Float32Array> {
  let r = rawCache.get(src);
  if (!r) { r = await raw(src); rawCache.set(src, r); }
  const W = src.width, H = src.height;
  if (s.quality !== 'Advanced' || (s.refineEdges <= 0 && s.shiftEdge === 0 && s.matteContrast <= 0)) return resample(r, SIZE, SIZE, W, H);
  const f = Math.min(1, limit / Math.max(W, H)), w = Math.max(1, Math.round(W * f)), h = Math.max(1, Math.round(H * f));
  const m = resample(r, SIZE, SIZE, w, h);
  refine(m, grayLevels(src, w, h), w, h, s, Math.round(s.refineEdges * f));
  return w === W && h === H ? m : resample(m, w, h, W, H);
}

/** Raw saliency for an arbitrary region (Object Selection's second look), resampled to w×h. */
export async function saliency(src: HTMLCanvasElement): Promise<Float32Array> {
  return resample(await raw(src), SIZE, SIZE, src.width, src.height);
}

/** A 0–1 map as a layer mask canvas (gray in RGB, opaque). */
export function matteToMask(m: Float32Array, w: number, h: number): HTMLCanvasElement {
  const c = canvasOf(w, h), x = ctx2d(c), img = x.createImageData(w, h);
  for (let i = 0; i < m.length; i++) { const v = Math.round(m[i] * 255); img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  x.putImageData(img, 0, 0); return c;
}
