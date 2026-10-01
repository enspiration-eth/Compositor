// Selections (Document/Selection.swift, SelectionEdits.swift): a document-size coverage mask. Shapes combine by
// replace / add (Shift) / subtract (Option); edges come from the original wand_trace kernel for marching ants.
import { type Doc, type Layer, type Mat, layerMatrix, invert } from './document';
import { canvasOf, ctx2d } from './adjustments';
import { traceMask } from './kernels';

export type SelMode = 'replace' | 'add' | 'subtract' | 'intersect';

export function combine(doc: Doc, shape: HTMLCanvasElement, mode: SelMode) {
  if (mode === 'replace' || !doc.selection) {
    if (mode === 'subtract') return;
    doc.selection = shape;
  } else {
    const c = canvasOf(doc.width, doc.height), x = ctx2d(c);
    x.drawImage(doc.selection, 0, 0);
    x.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'subtract' ? 'destination-out' : 'destination-in';
    x.drawImage(shape, 0, 0);
    doc.selection = c;
  }
  if (isEmpty(doc.selection)) doc.selection = null;
  doc.selRev++;
}
export function isEmpty(c: HTMLCanvasElement | null) {
  if (!c) return true;
  const d = ctx2d(c).getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
  return true;
}
export function shapeCanvas(doc: Doc, draw: (x: CanvasRenderingContext2D) => void, feather = 0) {
  const c = canvasOf(doc.width, doc.height), x = ctx2d(c);
  x.fillStyle = '#fff';
  if (feather > 0) {
    const t = canvasOf(doc.width, doc.height), tx = ctx2d(t); tx.fillStyle = '#fff'; draw(tx);
    x.filter = `blur(${feather}px)`; x.drawImage(t, 0, 0); x.filter = 'none';
  } else draw(x);
  return c;
}
export function rectSelection(doc: Doc, r: { x: number; y: number; w: number; h: number }, ellipse: boolean, feather = 0) {
  return shapeCanvas(doc, x => {
    x.beginPath();
    if (ellipse) x.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.abs(r.w / 2), Math.abs(r.h / 2), 0, 0, Math.PI * 2);
    else x.rect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
    x.fill();
  }, feather);
}
export function polygonSelection(doc: Doc, pts: [number, number][], feather = 0) {
  return shapeCanvas(doc, x => { x.beginPath(); pts.forEach(([a, b], i) => i ? x.lineTo(a, b) : x.moveTo(a, b)); x.closePath(); x.fill(); }, feather);
}
export function maskBytesToCanvas(doc: Doc, mask: Uint8Array) {
  const c = canvasOf(doc.width, doc.height), x = ctx2d(c), img = x.createImageData(doc.width, doc.height);
  for (let i = 0; i < mask.length; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = mask[i]; }
  x.putImageData(img, 0, 0); return c;
}
export function selectionBytes(c: HTMLCanvasElement): Uint8Array {
  const d = ctx2d(c).getImageData(0, 0, c.width, c.height).data, out = new Uint8Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
  return out;
}
export function selectAll(doc: Doc) { doc.selection = shapeCanvas(doc, x => x.fillRect(0, 0, doc.width, doc.height)); doc.selRev++; }
export function invertSelection(doc: Doc) {
  const c = shapeCanvas(doc, x => x.fillRect(0, 0, doc.width, doc.height));
  if (doc.selection) { const x = ctx2d(c); x.globalCompositeOperation = 'destination-out'; x.drawImage(doc.selection, 0, 0); }
  doc.selection = isEmpty(c) ? null : c; doc.selRev++;
}
export function featherSelection(doc: Doc, radius: number) {
  if (!doc.selection) return;
  const c = canvasOf(doc.width, doc.height), x = ctx2d(c);
  x.filter = `blur(${radius / 2}px)`; x.drawImage(doc.selection, 0, 0);
  doc.selection = c; doc.selRev++;
}
/** Expand (positive) or contract (negative) by `amount` pixels: blur then threshold, which rounds corners as Photoshop does. */
export function growSelection(doc: Doc, amount: number) {
  if (!doc.selection || !amount) return;
  const src = doc.selection;
  const blurred = canvasOf(doc.width, doc.height), bx = ctx2d(blurred);
  bx.filter = `blur(${Math.abs(amount) / 2}px)`; bx.drawImage(src, 0, 0);
  const img = bx.getImageData(0, 0, doc.width, doc.height), d = img.data;
  const threshold = amount > 0 ? 8 : 247;
  for (let i = 3; i < d.length; i += 4) { const v = d[i] > threshold ? 255 : 0; d[i] = v; d[i - 1] = d[i - 2] = d[i - 3] = 255; }
  bx.putImageData(img, 0, 0);
  doc.selection = isEmpty(blurred) ? null : blurred; doc.selRev++;
}
export function translateSelection(doc: Doc, dx: number, dy: number) {
  if (!doc.selection) return;
  const c = canvasOf(doc.width, doc.height); ctx2d(c).drawImage(doc.selection, Math.round(dx), Math.round(dy));
  doc.selection = c; doc.selRev++;
}
/** Select › Layer's Pixels. */
export function layerPixelsSelection(doc: Doc, l: Layer) {
  if (!l.canvas) return;
  const c = canvasOf(doc.width, doc.height), x = ctx2d(c);
  const m = layerMatrix(l); x.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]); x.drawImage(l.canvas, 0, 0);
  x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = '#fff'; x.fillRect(0, 0, doc.width, doc.height);
  doc.selection = isEmpty(c) ? null : c; doc.selRev++;
}
/** The selection on a layer's own pixel grid (white = selected), or null when nothing is selected. */
export function selectionInLayer(doc: Doc, l: Layer, pw: number, ph: number): HTMLCanvasElement | null {
  if (!doc.selection) return null;
  const c = canvasOf(pw, ph), x = ctx2d(c);
  const inv: Mat = invert(layerMatrix(l));
  x.setTransform(inv[0], inv[1], inv[2], inv[3], inv[4], inv[5]);
  x.drawImage(doc.selection, 0, 0);
  return c;
}
/** Marching-ants outline loops in document pixel-edge coordinates, traced by the original C kernel. */
const outlineCache = new WeakMap<HTMLCanvasElement, number[][] | null>();
export function selectionOutline(doc: Doc): number[][] | null {
  if (!doc.selection) return null;
  if (outlineCache.has(doc.selection)) return outlineCache.get(doc.selection)!;
  const bytes = selectionBytes(doc.selection);
  for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i] >= 128 ? 255 : 0;
  const loops = traceMask(bytes, doc.width, doc.height);
  outlineCache.set(doc.selection, loops);
  return loops;
}
export function selectionBounds(doc: Doc): { x: number; y: number; w: number; h: number } | null {
  if (!doc.selection) return null;
  const b = selectionBytes(doc.selection);
  let x0 = doc.width, y0 = doc.height, x1 = -1, y1 = -1;
  for (let y = 0; y < doc.height; y++) for (let x = 0; x < doc.width; x++) if (b[y * doc.width + x] > 0) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
export function selectionContains(doc: Doc, x: number, y: number) {
  if (!doc.selection || x < 0 || y < 0 || x >= doc.width || y >= doc.height) return false;
  return ctx2d(doc.selection).getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] > 127;
}
