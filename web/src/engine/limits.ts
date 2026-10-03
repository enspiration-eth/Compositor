// Canvas size limits. Phones and tablets cap a canvas at 16.7 megapixels (iOS Safari refuses bigger 2D canvases and
// every layer is one) and at the GPU's texture size, so documents and opened images stay inside them there.
// Desktop browsers keep the Mac app's 30,000 px limit.
const coarse = typeof matchMedia !== 'undefined' && matchMedia('(any-pointer: coarse)').matches;
const touchDevice = typeof navigator !== 'undefined' && (navigator.maxTouchPoints > 0 || coarse || /iPhone|iPad|iPod|Android/.test(navigator.userAgent))
  && typeof screen !== 'undefined' && Math.min(screen.width, screen.height) < 1100;
export const limits = { mobile: touchDevice, maxSide: touchDevice ? 8192 : 30000, maxPixels: touchDevice ? 4096 * 4096 : Infinity };

/** Tightens the side limit to what the GPU can hold (called once the WebGL2 context exists). */
export function setGpuTextureLimit(maxTextureSize: number) {
  if (limits.mobile && maxTextureSize > 0) limits.maxSide = Math.min(limits.maxSide, maxTextureSize);
}
/** The scale (≤ 1) that brings w × h inside the limits. */
export function limitScale(w: number, h: number): number {
  return Math.min(1, limits.maxSide / Math.max(w, h), Math.sqrt(limits.maxPixels / (w * h)));
}
export function fitsLimits(w: number, h: number) { return limitScale(w, h) >= 1; }
/** Told when an opened image had to be scaled down to fit. */
export const limitNotice: { onDownscale: ((name: string, from: [number, number], to: [number, number]) => void) | null } = { onDownscale: null };

/** Returns the canvas, or a scaled-down copy when it's bigger than this device allows. */
export function limitCanvas(c: HTMLCanvasElement, name = 'image'): HTMLCanvasElement {
  const s = limitScale(c.width, c.height);
  if (s >= 1) return c;
  const w = Math.max(1, Math.floor(c.width * s)), h = Math.max(1, Math.floor(c.height * s));
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const x = out.getContext('2d')!; x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, w, h);
  limitNotice.onDownscale?.(name, [c.width, c.height], [w, h]);
  c.width = c.height = 0; // free the big one now (iOS counts canvas memory until GC)
  return out;
}
