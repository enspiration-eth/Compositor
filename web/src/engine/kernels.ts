// Bridge to Compositor's original C pixel kernels (Compositor/Rendering/*.c), compiled unchanged to WebAssembly by
// web/wasm/build.sh. The kernels work on premultiplied RGBA, as the Mac app's CGContexts do; browser ImageData is
// straight alpha, so every call premultiplies on the way in and divides back out on the way out.
import createPixels from '../wasm/pixels.mjs';
import type { PixelsModule } from '../wasm/pixels.mjs';
import wasmUrl from '../wasm/pixels.wasm?url';

let mod: PixelsModule | null = null;

export async function loadKernels(): Promise<PixelsModule> {
  if (mod) return mod;
  mod = await createPixels({ locateFile: () => wasmUrl });
  return mod;
}
export function kernels(): PixelsModule {
  if (!mod) throw new Error('WebAssembly kernels not loaded');
  return mod;
}

/** A scratch allocation in the wasm heap, freed by `free()` or by `withHeap`. */
class Heap {
  private ptrs: number[] = [];
  constructor(private m: PixelsModule) {}
  alloc(bytes: number): number {
    const p = this.m._malloc(Math.max(1, bytes));
    if (!p) throw new Error('Out of memory in WebAssembly heap');
    this.ptrs.push(p);
    return p;
  }
  bytes(data: ArrayLike<number>): number {
    const p = this.alloc(data.length);
    this.m.HEAPU8.set(data as ArrayLike<number>, p);
    return p;
  }
  floats(data: ArrayLike<number>): number {
    const p = this.alloc(data.length * 4);
    this.m.HEAPF32.set(data as ArrayLike<number>, p >> 2);
    return p;
  }
  doubles(data: ArrayLike<number>): number {
    const p = this.alloc(data.length * 8);
    this.m.HEAPF64.set(data as ArrayLike<number>, p >> 3);
    return p;
  }
  free() { for (const p of this.ptrs) this.m._free(p); this.ptrs = []; }
}

export function withHeap<T>(body: (heap: Heap, m: PixelsModule) => T): T {
  const m = kernels();
  const heap = new Heap(m);
  try { return body(heap, m); } finally { heap.free(); }
}

export function premultiplyInto(src: Uint8ClampedArray | Uint8Array, dst: Uint8Array, offset: number) {
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 255) { dst[offset + i] = src[i]; dst[offset + i + 1] = src[i + 1]; dst[offset + i + 2] = src[i + 2]; dst[offset + i + 3] = 255; }
    else if (a === 0) { dst[offset + i] = 0; dst[offset + i + 1] = 0; dst[offset + i + 2] = 0; dst[offset + i + 3] = 0; }
    else {
      dst[offset + i] = (src[i] * a + 127) / 255; dst[offset + i + 1] = (src[i + 1] * a + 127) / 255;
      dst[offset + i + 2] = (src[i + 2] * a + 127) / 255; dst[offset + i + 3] = a;
    }
  }
}
export function unpremultiplyFrom(src: Uint8Array, offset: number, dst: Uint8ClampedArray) {
  for (let i = 0; i < dst.length; i += 4) {
    const a = src[offset + i + 3];
    if (a === 255) { dst[i] = src[offset + i]; dst[i + 1] = src[offset + i + 1]; dst[i + 2] = src[offset + i + 2]; dst[i + 3] = 255; }
    else if (a === 0) { dst[i] = 0; dst[i + 1] = 0; dst[i + 2] = 0; dst[i + 3] = 0; }
    else {
      dst[i] = Math.min(255, (src[offset + i] * 255 + a / 2) / a); dst[i + 1] = Math.min(255, (src[offset + i + 1] * 255 + a / 2) / a);
      dst[i + 2] = Math.min(255, (src[offset + i + 2] * 255 + a / 2) / a); dst[i + 3] = a;
    }
  }
}

/** Runs `body` over `img`'s pixels, premultiplied, in the wasm heap, then writes them back straight. */
export function onPremultiplied(img: ImageData, body: (ptr: number, w: number, h: number, stride: number, heap: Heap, m: PixelsModule) => void) {
  withHeap((heap, m) => {
    const n = img.width * img.height * 4;
    const ptr = heap.alloc(n);
    premultiplyInto(img.data, m.HEAPU8, ptr);
    body(ptr, img.width, img.height, img.width * 4, heap, m);
    unpremultiplyFrom(kernels().HEAPU8, ptr, img.data); // HEAPU8 may have been replaced by memory growth
  });
}

// ---- Typed wrappers, one per kernel the web app uses ----

export function levelsApply(img: ImageData, tables: ArrayLike<number>) {
  onPremultiplied(img, (p, w, h, _s, heap, m) => m._levels_apply(p, w * h, heap.floats(tables)));
}
export function levelsHistogram(img: ImageData): number[][] {
  return withHeap((heap, m) => {
    const n = img.width * img.height;
    const p = heap.alloc(n * 4);
    premultiplyInto(img.data, m.HEAPU8, p);
    const bins = heap.alloc(1024 * 8);
    m.HEAPF64.fill(0, bins >> 3, (bins >> 3) + 1024);
    m._levels_histogram(p, 0, n, bins);
    const all = Array.from(kernels().HEAPF64.subarray(bins >> 3, (bins >> 3) + 1024));
    return [0, 1, 2, 3].map(i => all.slice(i * 256, i * 256 + 256));
  });
}
export function cubeApply(img: ImageData, cube: Float32Array, dimension: number) {
  onPremultiplied(img, (p, w, h, _s, heap, m) => m._cube_apply(p, w * h, heap.floats(cube), dimension));
}
export function gradientMap(img: ImageData, table: Uint8Array) {
  onPremultiplied(img, (p, w, h, s, heap, m) => m._adjust_gradient_map(p, w, h, s, heap.bytes(table)));
}
export function grain(img: ImageData, amount: number, size: number, roughness: number, seed: number, ox = 0, oy = 0, upp = 1) {
  onPremultiplied(img, (p, w, h, s, _heap, m) => m._adjust_grain(p, w, h, s, amount, size, roughness, seed >>> 0, ox, oy, upp));
}
export function blackWhite(img: ImageData, weights: number[], tint: boolean, tintHue: number, tintSaturation: number) {
  onPremultiplied(img, (p, w, h, s, heap, m) => m._adjust_black_white(p, w, h, s, heap.floats(weights), tint ? 1 : 0, tintHue, tintSaturation));
}
export function colorBalance(img: ImageData, sh: number[], mid: number[], hi: number[], preserve: boolean) {
  onPremultiplied(img, (p, w, h, s, heap, m) => m._adjust_color_balance(p, w, h, s, heap.floats(sh), heap.floats(mid), heap.floats(hi), preserve ? 1 : 0));
}
export function noiseAddAt(img: ImageData, amount: number, gaussian: boolean, mono: boolean, seed: number, ox = 0, oy = 0) {
  // int64 origins are passed as BigInt by Emscripten's WASM_BIGINT default; fall back to noise_add at the origin.
  onPremultiplied(img, (p, w, h, s, _heap, m) => {
    if (ox === 0 && oy === 0) m._noise_add(p, w, h, s, amount, gaussian ? 1 : 0, mono ? 1 : 0, seed >>> 0);
    else (m._noise_add_at as unknown as (...a: unknown[]) => void)(p, w, h, s, amount, gaussian ? 1 : 0, mono ? 1 : 0, seed >>> 0, BigInt(Math.floor(ox)), BigInt(Math.floor(oy)));
  });
}
export function coloredVignette(img: ImageData, frame: [number, number, number, number], fillsClear: boolean, amount: number, midpoint: number,
  roundness: number, feather: number, highlights: number, r: number, g: number, b: number) {
  onPremultiplied(img, (p, w, h, s, _heap, m) => m._adjust_colored_vignette(p, w, h, s, frame[0], frame[1], frame[2], frame[3], fillsClear ? 1 : 0,
    amount, midpoint, roundness, feather, highlights, r, g, b));
}
export function tonalContrast(img: ImageData, blurred: ImageData, amount: number, sh: number, mid: number, hi: number) {
  onPremultiplied(img, (p, w, h, s, heap, m) => {
    const b = heap.alloc(blurred.data.length);
    premultiplyInto(blurred.data, m.HEAPU8, b);
    m._adjust_tonal_contrast(p, b, w, h, s, s, amount, sh, mid, hi);
  });
}
export function lensDistort(img: ImageData, k: number) {
  onPremultiplied(img, (p, w, h, s, heap, m) => {
    const src = heap.alloc(img.data.length);
    m.HEAPU8.copyWithin(src, p, p + img.data.length);
    m._lens_distort(src, p, w, h, s, k);
  });
}
export function cameraRaw(img: ImageData, a: { gains: [number, number, number]; exposure: number; contrast: number; highlights: number; shadows: number;
  whites: number; blacks: number; vibrance: number; saturation: number }) {
  onPremultiplied(img, (p, w, h, s, _heap, m) => m._adjust_camera_raw(p, w, h, s, a.gains[0], a.gains[1], a.gains[2], a.exposure, a.contrast,
    a.highlights, a.shadows, a.whites, a.blacks, a.vibrance, a.saturation, 0));
}
export function cameraRawEffects(img: ImageData, e: { texture: number; clarity: number; dehaze: number; vignetteAmount: number; vignetteMidpoint: number;
  vignetteRoundness: number; vignetteFeather: number; vignetteHighlights: number }, scale = 1) {
  onPremultiplied(img, (p, w, h, s, _heap, m) => m._adjust_camera_raw_effects(p, w, h, s, e.texture, e.clarity, e.dehaze, 0, 0, 50, 50, 0,
    e.vignetteAmount, e.vignetteMidpoint, e.vignetteRoundness, e.vignetteFeather, e.vignetteHighlights, 0, scale));
}

/** Magic Wand: a 0/255 mask the size of `img`. */
export function wandMask(img: ImageData, x: number, y: number, radius: number, tolerance: number, contiguous: boolean): Uint8Array {
  return withHeap((heap, m) => {
    const p = heap.alloc(img.data.length);
    premultiplyInto(img.data, m.HEAPU8, p);
    const mask = heap.alloc(img.width * img.height);
    m._wand_mask(p, img.width, img.height, img.width * 4, x, y, radius, tolerance, contiguous ? 1 : 0, mask);
    return kernels().HEAPU8.slice(mask, mask + img.width * img.height);
  });
}
/** Outline loops of a mask's nonzero pixels, along pixel edges (marching ants). */
export function traceMask(mask: Uint8Array, w: number, h: number): number[][] | null {
  return withHeap((heap, m) => {
    const mp = heap.bytes(mask);
    const out = heap.alloc(16); // points**, pointCount*, loops**, loopCount*
    const r = m._wand_trace(mp, w, h, out, out + 4, out + 8, out + 12);
    if (r !== 0) return null;
    const H = kernels().HEAPU32;
    const pts = H[out >> 2], np = H[(out + 4) >> 2], loops = H[(out + 8) >> 2], nl = H[(out + 12) >> 2];
    const I = kernels().HEAP32;
    const result: number[][] = [];
    let k = 0;
    for (let l = 0; l < nl; l++) {
      const count = I[(loops >> 2) + l];
      result.push(Array.from(I.subarray((pts >> 2) + k * 2, (pts >> 2) + (k + count) * 2)));
      k += count;
    }
    void np;
    m._free(pts); m._free(loops);
    return result;
  });
}
export function spotHeal(img: ImageData, coverage: Uint8Array, opacity: number, mode: number, seed: number): boolean {
  let ok = true;
  onPremultiplied(img, (p, w, h, s, heap, m) => { ok = m._spot_heal(p, heap.bytes(coverage), w, h, s, opacity, mode, seed >>> 0) === 0; });
  return ok;
}
export function contentFill(img: ImageData, mask: Uint8Array): number {
  let r = 0;
  onPremultiplied(img, (p, w, h, s, heap, m) => { r = m._content_fill(p, s, heap.bytes(mask), w, w, h); });
  return r;
}
export function alphaBounds(img: ImageData): [number, number, number, number] {
  return withHeap((heap, m) => {
    const p = heap.alloc(img.data.length);
    premultiplyInto(img.data, m.HEAPU8, p);
    const b = heap.alloc(16);
    m._brush_alpha_bounds(p, img.width, img.height, img.width * 4, b);
    const U = kernels().HEAPU32;
    return [U[b >> 2], U[(b >> 2) + 1], U[(b >> 2) + 2], U[(b >> 2) + 3]];
  });
}
export interface DitherParamsJS {
  style: number; levels: number; diffusion: number; density: number; contrast: number; cell: number; angle: number;
  lightOnDark: boolean; originalColors: boolean; dark: number[]; light: number[];
  glyphs?: { maps: Uint8Array; coverage: Float32Array; width: number; height: number }; dots: number; wobble: number;
}
export function dither(img: ImageData, d: DitherParamsJS): boolean {
  let ok = true;
  onPremultiplied(img, (p, w, h, s, heap, m) => {
    const prm = heap.alloc(72);
    const maps = d.glyphs ? heap.bytes(d.glyphs.maps) : 0;
    const cov = d.glyphs ? heap.floats(d.glyphs.coverage) : 0;
    const H = kernels();
    const i32 = (o: number, v: number) => { H.HEAP32[(prm + o) >> 2] = v; };
    const f32 = (o: number, v: number) => { H.HEAPF32[(prm + o) >> 2] = v; };
    H.HEAPU8.fill(0, prm, prm + 72);
    i32(0, d.style); i32(4, d.levels); f32(8, d.diffusion); f32(12, d.density); f32(16, d.contrast); i32(20, d.cell); f32(24, d.angle);
    i32(28, d.lightOnDark ? 1 : 0); i32(32, d.originalColors ? 1 : 0);
    H.HEAPU8.set(d.dark.slice(0, 3), prm + 36); H.HEAPU8.set(d.light.slice(0, 3), prm + 39);
    i32(44, d.glyphs?.width ?? 1); i32(48, d.glyphs?.height ?? 1); i32(52, maps); i32(56, cov); i32(60, d.glyphs ? d.glyphs.coverage.length : 0);
    f32(64, d.dots); f32(68, d.wobble);
    ok = m._dither_apply(p, w, h, s, prm) !== 0;
  });
  return ok;
}
export function ditherDots(img: ImageData, block: number, gap: number[]) {
  onPremultiplied(img, (p, w, h, s, heap, m) => m._dither_dots(p, w, h, s, block, heap.bytes(gap)));
}

/** A Smudge or Liquify stroke over one layer's pixels, held premultiplied in the wasm heap for the stroke's length
 *  (WarpStroke in SmudgeLiquify.swift, whose CPU path wasm/src/WarpPixels.c translates). */
export class WarpSession {
  private ptr: number;
  readonly width: number; readonly height: number;
  constructor(img: ImageData, readonly mode: 'smudge' | 'liquify', readonly diameter: number, readonly hardness: number, readonly strength: number) {
    const m = kernels();
    this.width = img.width; this.height = img.height;
    this.ptr = m._malloc(img.width * img.height * 4);
    if (!this.ptr) throw new Error('Out of memory in WebAssembly heap');
    premultiplyInto(img.data, m.HEAPU8, this.ptr);
  }
  get radius() { return Math.ceil(this.diameter / 2); }
  pickUp(x: number, y: number) { kernels()._warp_pick_up(this.ptr, this.width, this.height, x, y, this.radius); }
  smudge(x: number, y: number) { kernels()._warp_smudge(this.ptr, this.width, this.height, x, y, this.radius, this.diameter, this.hardness, this.strength); }
  push(ax: number, ay: number, bx: number, by: number) {
    kernels()._warp_push(this.ptr, this.width, this.height, ax, ay, bx, by, this.radius, this.diameter, this.hardness, this.strength);
  }
  /** The working copy's pixels in [x0, y0, x1, y1), straight alpha. */
  read(x0: number, y0: number, x1: number, y1: number): ImageData {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(this.width, Math.ceil(x1)); y1 = Math.min(this.height, Math.ceil(y1));
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0), out = new ImageData(w, h), heap = kernels().HEAPU8;
    const row = new Uint8ClampedArray(w * 4);
    for (let y = 0; y < h && y0 + y < this.height; y++) {
      unpremultiplyFrom(heap, this.ptr + ((y0 + y) * this.width + x0) * 4, row);
      out.data.set(row, y * w * 4);
    }
    return out;
  }
  dispose() { if (this.ptr) { kernels()._free(this.ptr); this.ptr = 0; } }
}
