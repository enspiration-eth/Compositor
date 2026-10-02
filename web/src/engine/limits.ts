// How big a document this device can hold. Phones and tablets cap a single canvas at about 16.7 megapixels
// (iOS Safari refuses larger 2D canvases outright, and both mobile browsers run out of memory well before
// desktop ones do), so new canvases are limited there and imported images are scaled to fit.
const nav = typeof navigator !== 'undefined' ? navigator : null;
export const isMobileDevice = !!nav && (/iPhone|iPad|iPod|Android/i.test(nav.userAgent) || (nav.maxTouchPoints > 1 && /Mac/.test(nav.platform)));
/** Pixels per document (and per layer canvas). */
export const MAX_DOC_PIXELS = isMobileDevice ? 4096 * 4096 : 30000 * 30000;
/** The longest side, lowered to the GPU's texture limit once the renderer knows it. */
export let maxSide = 30000;
export function setMaxSide(n: number) { if (n > 0) maxSide = Math.min(30000, n); }
/** Does a w × h document fit this device? */
export const fitsDevice = (w: number, h: number) => w * h <= MAX_DOC_PIXELS && Math.max(w, h) <= maxSide;
/** The scale (≤ 1) that makes w × h fit this device. */
export function deviceFitScale(w: number, h: number): number {
  return Math.min(1, Math.sqrt(MAX_DOC_PIXELS / (w * h)), maxSide / Math.max(w, h));
}
/** Set when the last imported image had to be scaled down to fit; the UI reports it once. */
export const importNote = { text: '' };
