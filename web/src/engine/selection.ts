// Selections (Document/Selection.swift, SelectionEdits.swift): a document-size coverage mask. Shapes combine by
// replace / add (Shift) / subtract (Option); edges come from the original wand_trace kernel for marching ants.
import { type Doc, type Layer, type Mat, layerMatrix, invert } from './document';
import { canvasOf, ctx2d } from './adjustments';
import { traceMask, gaussBlur, maskGrow } from './kernels';

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
  draw(x);
  if (feather > 0) softenAlpha(c, feather / 2);
  return c;
}
/** A selection's alpha blurred by `sigma` with the edges extended (DocumentSelection's feather: Gaussian of
 *  feather / 2 over the clamped extent), in wasm. */
function softenAlpha(c: HTMLCanvasElement, sigma: number) {
  const x = ctx2d(c), img = x.getImageData(0, 0, c.width, c.height), d = img.data;
  // Alpha in every channel, opaque, so the premultiplied blur treats it as plain values.
  for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = d[i + 3]; d[i + 3] = 255; }
  gaussBlur(img, sigma, true);
  for (let i = 0; i < d.length; i += 4) { d[i + 3] = d[i]; d[i] = d[i + 1] = d[i + 2] = 255; }
  x.putImageData(img, 0, 0);
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
/** ObjectSelection.smoothed: the traced outline of a 0/255 mask with its one-pixel stair steps rounded off
 *  (Douglas–Peucker at 1.6 px, then three rounds of Chaikin corner cutting), filled anti-aliased. Holes stay holes. */
export function smoothedMaskSelection(doc: Doc, mask: Uint8Array): HTMLCanvasElement {
  const loops = traceMask(mask, doc.width, doc.height);
  if (!loops) return maskBytesToCanvas(doc, mask);
  return shapeCanvas(doc, x => {
    x.beginPath();
    for (const flat of loops) {
      const pts: [number, number][] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
      const sm = chaikin(simplifyClosed(pts, 1.6), 3);
      if (sm.length < 3) continue;
      sm.forEach(([a, b], i) => i ? x.lineTo(a, b) : x.moveTo(a, b)); x.closePath();
    }
    x.fill('evenodd');
  });
}
type P = [number, number];
function simplifyClosed(input: P[], tol: number): P[] {
  const pts = input.slice();
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length < 4) return pts;
  let start = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i][0] < pts[start][0] || (pts[i][0] === pts[start][0] && pts[i][1] < pts[start][1])) start = i;
  const rot = [...pts.slice(start), ...pts.slice(0, start)];
  let open = simplifyOpen([...rot, rot[0]], tol);
  open = open.slice(0, -1);
  return open.length >= 3 ? open : pts;
}
function simplifyOpen(p: P[], tol: number): P[] {
  // Iterative Douglas–Peucker (outlines can have many thousands of points).
  const keep = new Uint8Array(p.length); keep[0] = keep[p.length - 1] = 1;
  const stack: [number, number][] = [[0, p.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b <= a + 1) continue;
    const [ax, ay] = p[a], [bx, by] = p[b], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let far = a + 1, best = 0;
    for (let i = a + 1; i < b; i++) {
      const d = len > 0 ? Math.abs(dy * p[i][0] - dx * p[i][1] + bx * ay - by * ax) / len : Math.hypot(p[i][0] - ax, p[i][1] - ay);
      if (d > best) { best = d; far = i; }
    }
    if (best > tol) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return p.filter((_, i) => keep[i]);
}
function chaikin(input: P[], iterations: number): P[] {
  let pts = input;
  if (pts.length < 3) return pts;
  for (let k = 0; k < iterations; k++) {
    const next: P[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    pts = next;
  }
  return pts;
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
  const c = canvasOf(doc.width, doc.height); ctx2d(c).drawImage(doc.selection, 0, 0);
  softenAlpha(c, radius / 2);
  doc.selection = c; doc.selRev++;
}
/** Expand (positive) or contract (negative) by `amount` pixels with round corners (Selection.swift resizeSelection:
 *  a round-capped band around the outline added or removed), as a Euclidean distance transform in wasm. Contracting
 *  also pulls away from the canvas edges. */
export function growSelection(doc: Doc, amount: number) {
  if (!doc.selection || !amount) return;
  const out = canvasOf(doc.width, doc.height), x = ctx2d(out); x.drawImage(doc.selection, 0, 0);
  const img = x.getImageData(0, 0, doc.width, doc.height), d = img.data, alpha = new Uint8Array(doc.width * doc.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4 + 3];
  maskGrow(alpha, doc.width, doc.height, Math.max(-500, Math.min(500, amount)));
  for (let i = 0; i < alpha.length; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255; d[i * 4 + 3] = alpha[i]; }
  x.putImageData(img, 0, 0);
  doc.selection = isEmpty(out) ? null : out; doc.selRev++;
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
