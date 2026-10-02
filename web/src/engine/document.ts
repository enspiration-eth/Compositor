// The document model, after Photoshop.eth's CanvasDocument / ImageLayer (Document/*.swift) and its .comp manifest:
// layers bottom to top, pass-through folders via parentID, per-layer transform (origin, size, clockwise rotation
// about the center, flips), opacity, blend mode, raster mask, clipping (maskSourceID), adjustments, text, shapes
// and effects. Pixels live in canvases; history shares unchanged canvases between steps (copy on write).
import type { AdjustmentRecord, RGB } from './adjustments';
import { canvasOf, ctx2d } from './adjustments';
import { layerEffects } from './kernels';

export type BlendMode = 'Normal' | 'Darken' | 'Multiply' | 'Color Burn' | 'Linear Burn' | 'Lighten' | 'Screen' | 'Color Dodge'
  | 'Linear Dodge (Add)' | 'Overlay' | 'Soft Light' | 'Hard Light' | 'Vivid Light' | 'Linear Light' | 'Pin Light' | 'Hard Mix'
  | 'Difference' | 'Exclusion' | 'Subtract' | 'Divide' | 'Hue' | 'Saturation' | 'Color' | 'Luminosity';
export const BLEND_GROUPS: BlendMode[][] = [
  ['Normal'], ['Darken', 'Multiply', 'Color Burn', 'Linear Burn'], ['Lighten', 'Screen', 'Color Dodge', 'Linear Dodge (Add)'],
  ['Overlay', 'Soft Light', 'Hard Light', 'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix'],
  ['Difference', 'Exclusion', 'Subtract', 'Divide'], ['Hue', 'Saturation', 'Color', 'Luminosity'],
];
export const BLEND_MODES: BlendMode[] = BLEND_GROUPS.flat();

export interface Transform { x: number; y: number; w: number; h: number; rotation: number; flipX: boolean; flipY: boolean; sampling: 'High quality' | 'Smooth' | 'Nearest' }
export interface TextStyle { content: string; fontName: string; fontSize: number; red: number; green: number; blue: number;
  alignment: 'Left' | 'Center' | 'Right'; tracking: number; leading: number; boxSize?: { width: number; height: number };
  /** LayerTextColorRun / LayerTextFontRun: letters in another color or face, UTF-16 offsets, sorted, not overlapping. */
  colorRuns?: { location: number; length: number; red: number; green: number; blue: number }[];
  fontRuns?: { location: number; length: number; fontName: string }[] }
type RGB3 = { red: number; green: number; blue: number };
const sameRGB = (a: RGB3, b: RGB3) => a.red === b.red && a.green === b.green && a.blue === b.blue;
// ---- LayerTextStyle run editing (Document/TypeTool.swift) ----
function unitColors(t: TextStyle): RGB3[] {
  const base = { red: t.red, green: t.green, blue: t.blue }, out = Array.from({ length: t.content.length }, () => base);
  for (const r of t.colorRuns ?? []) for (let i = Math.max(0, r.location); i < Math.min(out.length, r.location + r.length); i++) out[i] = { red: r.red, green: r.green, blue: r.blue };
  return out;
}
function setUnitColors(t: TextStyle, colors: RGB3[]) {
  const base = { red: t.red, green: t.green, blue: t.blue }, runs: NonNullable<TextStyle['colorRuns']> = [];
  colors.forEach((c, i) => {
    if (sameRGB(c, base)) return;
    const last = runs[runs.length - 1];
    if (last && last.location + last.length === i && sameRGB(last, c)) last.length++; else runs.push({ location: i, length: 1, red: c.red, green: c.green, blue: c.blue });
  });
  t.colorRuns = runs.length ? runs : undefined;
}
function unitFonts(t: TextStyle): string[] {
  const out = Array.from({ length: t.content.length }, () => t.fontName);
  for (const r of t.fontRuns ?? []) for (let i = Math.max(0, r.location); i < Math.min(out.length, r.location + r.length); i++) out[i] = r.fontName;
  return out;
}
function setUnitFonts(t: TextStyle, fonts: string[]) {
  if (fonts.length && fonts.every(f => f === fonts[0])) { t.fontName = fonts[0]; t.fontRuns = undefined; return; }
  const runs: NonNullable<TextStyle['fontRuns']> = [];
  fonts.forEach((f, i) => {
    if (f === t.fontName) return;
    const last = runs[runs.length - 1];
    if (last && last.location + last.length === i && last.fontName === f) last.length++; else runs.push({ location: i, length: 1, fontName: f });
  });
  t.fontRuns = runs.length ? runs : undefined;
}
/** LayerTextStyle.setColor: paints [start, end); an empty range or the whole text recolors all of it. */
export function setTextColor(t: TextStyle, c: RGB3, start = 0, end = 0) {
  const n = t.content.length; start = Math.max(0, Math.min(start, n)); end = Math.max(start, Math.min(end, n));
  if (start === end || (start === 0 && end === n)) { t.red = c.red; t.green = c.green; t.blue = c.blue; t.colorRuns = undefined; return; }
  const colors = unitColors(t); for (let i = start; i < end; i++) colors[i] = c; setUnitColors(t, colors);
}
/** LayerTextStyle.setFont. */
export function setTextFont(t: TextStyle, name: string, start = 0, end = 0) {
  const n = t.content.length; start = Math.max(0, Math.min(start, n)); end = Math.max(start, Math.min(end, n));
  if (start === end || (start === 0 && end === n)) { t.fontName = name; t.fontRuns = undefined; return; }
  const fonts = unitFonts(t); for (let i = start; i < end; i++) fonts[i] = name; setUnitFonts(t, fonts);
}
/** Keeps runs on the letters they belong to as `t.content` becomes `next` (one contiguous edit, as typing makes). */
export function retargetRuns(t: TextStyle, next: string): TextStyle {
  const out: TextStyle = structuredClone(t);
  const prev = t.content;
  if (prev === next) return out;
  if (!out.colorRuns && !out.fontRuns) { out.content = next; return out; }
  // LayerTextStyle.replaceCharacters: new letters take the color and face of the one before, as typing does.
  let a = 0; while (a < prev.length && a < next.length && prev[a] === next[a]) a++;
  let b = 0; while (b < prev.length - a && b < next.length - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++;
  const start = a, end = prev.length - b, length = next.length - a - b;
  const colors = unitColors(t), fonts = unitFonts(t);
  const ic = start > 0 ? colors[start - 1] : (end > start ? colors[start] : colors[0] ?? { red: t.red, green: t.green, blue: t.blue });
  const iff = start > 0 ? fonts[start - 1] : (end > start ? fonts[start] : fonts[0] ?? t.fontName);
  colors.splice(start, end - start, ...Array.from({ length }, () => ic));
  fonts.splice(start, end - start, ...Array.from({ length }, () => iff));
  out.content = next;
  if (out.colorRuns) setUnitColors(out, colors);
  if (out.fontRuns) setUnitFonts(out, fonts);
  return out;
}
export interface ShapeStyle { kind: 'Rectangle' | 'Ellipse' | 'Line'; red: number; green: number; blue: number; cornerRadius: number; lineWidth?: number;
  start?: { x: number; y: number }; end?: { x: number; y: number } }
export interface Effects {
  stroke?: { enabled?: boolean; size: number; red: number; green: number; blue: number; opacity: number; inside: boolean };
  shadow?: { enabled?: boolean; angle: number; distance: number; blur: number; red: number; green: number; blue: number; opacity: number };
  colorOverlay?: { enabled?: boolean; red: number; green: number; blue: number; opacity: number };
  innerShadow?: { enabled?: boolean; angle: number; distance: number; blur: number; red: number; green: number; blue: number; opacity: number };
  outerGlow?: { enabled?: boolean; size: number; red: number; green: number; blue: number; opacity: number };
  innerGlow?: { enabled?: boolean; size: number; red: number; green: number; blue: number; opacity: number };
}
export type EffectKey = keyof Effects;
export const EFFECT_NAMES: Record<EffectKey, string> = { stroke: 'Stroke', shadow: 'Drop Shadow', colorOverlay: 'Color Overlay', innerShadow: 'Inner Shadow',
  outerGlow: 'Outer Glow', innerGlow: 'Inner Glow' };

export interface Layer {
  id: string; name: string; visible: boolean; opacity: number; blend: BlendMode;
  parentId: string | null; isGroup: boolean; collapsed?: boolean;
  canvas: HTMLCanvasElement | null;          // pixels (null for groups and adjustment layers)
  transform: Transform;
  mask: HTMLCanvasElement | null; maskEnabled: boolean;  // gray in R, same pixel size as `canvas` (unless placed)
  /** LayerMask.placement: where the mask's own pixel grid sits on the document once moved apart from its layer;
   *  undefined while it covers the layer's pixel grid. */
  maskPlacement?: Transform;
  /** The layer's transform when `maskPlacement` was last set, so a linked placed mask follows later layer moves. */
  maskBase?: Transform;
  /** LayerMask.isLinked (default true): linked, layer and mask move together; unlinked, each on its own. */
  maskLinked?: boolean;
  clipTo: string | null;                       // maskSourceID: base layer whose alpha clips this one
  adjustment?: AdjustmentRecord;
  text?: TextStyle; shape?: ShapeStyle; effects?: Effects;
  rev: number;                                 // bumped on every pixel change, for GPU texture caching
}
export interface Doc {
  id: string; name: string; width: number; height: number; resolution: number;
  layers: Layer[]; activeId: string | null; selectedIds: string[];
  selection: HTMLCanvasElement | null;  // document-size, alpha = selected
  selRev: number;
  dirty: boolean; fileHandle?: unknown;
  guides: Guide[];
}
/** CanvasGuide (Document/Guides.swift): document pixels, Y for a horizontal guide, X for a vertical one. */
export interface Guide { id: string; axis: 'horizontal' | 'vertical'; position: number }

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
})).toUpperCase();

export function newDoc(width: number, height: number, name = 'Untitled'): Doc {
  return { id: uuid(), name, width, height, resolution: 72, layers: [], activeId: null, selectedIds: [], selection: null, selRev: 0, dirty: false, guides: [] };
}
export function fullTransform(doc: Doc): Transform { return { x: 0, y: 0, w: doc.width, h: doc.height, rotation: 0, flipX: false, flipY: false, sampling: 'High quality' }; }
export function newPixelLayer(doc: Doc, name: string, canvas?: HTMLCanvasElement, t?: Partial<Transform>): Layer {
  const c = canvas ?? canvasOf(doc.width, doc.height);
  return { id: uuid(), name, visible: true, opacity: 1, blend: 'Normal', parentId: null, isGroup: false, canvas: c,
    transform: { ...fullTransform(doc), w: c.width, h: c.height, ...t }, mask: null, maskEnabled: true, clipTo: null, rev: 1 };
}

// ---------- geometry ----------
export type Mat = [number, number, number, number, number, number]; // a b c d e f (x' = a x + c y + e)
export const mul = (m: Mat, n: Mat): Mat => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export const invert = (m: Mat): Mat => {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};
export const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** Layer pixel → document, as BrushRaster.pixelToDocument: rotation clockwise about the box center. */
export function pixelToDoc(t: Transform, pw: number, ph: number): Mat {
  const r = t.rotation * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  const sx = t.w / pw * (t.flipX ? -1 : 1), sy = t.h / ph * (t.flipY ? -1 : 1);
  const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
  return mul([cos, sin, -sin, cos, cx, cy], [sx, 0, 0, sy, -pw / 2 * sx, -ph / 2 * sy]);
}
export function layerMatrix(l: Layer): Mat {
  const c = l.canvas;
  return pixelToDoc(l.transform, c ? c.width : l.transform.w, c ? c.height : l.transform.h);
}
export function layerCorners(l: Layer): [number, number][] {
  const m = pixelToDoc(l.transform, 1, 1);
  return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => apply(m, x, y));
}
export function layerContains(l: Layer, x: number, y: number) {
  const t = l.transform, cx = t.x + t.w / 2, cy = t.y + t.h / 2, r = t.rotation * Math.PI / 180;
  const dx = x - cx, dy = y - cy;
  return Math.abs(dx * Math.cos(r) + dy * Math.sin(r)) <= t.w / 2 && Math.abs(-dx * Math.sin(r) + dy * Math.cos(r)) <= t.h / 2;
}

// ---------- placed / unlinked masks (Document/LayerMask.swift) ----------
const sameT = (a: Transform, b: Transform) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.rotation === b.rotation && a.flipX === b.flipX && a.flipY === b.flipY;
const unitToDoc = (t: Transform) => pixelToDoc(t, 1, 1);
/** LayerTransform.placing: the transform nearest `t` that maps the unit square by `m` (no shear). */
export function placing(t: Transform, m: Mat): Transform {
  const sign = t.flipX ? -1 : 1;
  const angle = Math.atan2(m[1] * sign, m[0] * sign);
  const along = -m[2] * Math.sin(angle) + m[3] * Math.cos(angle);
  const mid = apply(m, 0.5, 0.5);
  const w = Math.hypot(m[0], m[1]), h = Math.abs(along), deg = angle * 180 / Math.PI;
  return { ...t, w, h, rotation: deg + Math.round((t.rotation - deg) / 360) * 360, flipY: along < 0, x: mid[0] - w / 2, y: mid[1] - h / 2 };
}
/** LayerTransform.following: this placement carried along as a layer moves from `old` to `nw`. */
export function following(p: Transform, old: Transform, nw: Transform): Transform {
  if (sameT(old, nw)) return p;
  if (old.w === nw.w && old.h === nw.h && old.rotation === nw.rotation && old.flipX === nw.flipX && old.flipY === nw.flipY)
    return { ...p, x: p.x + nw.x - old.x, y: p.y + nw.y - old.y };
  return placing(p, mul(unitToDoc(nw), mul(invert(unitToDoc(old)), unitToDoc(p))));
}
/** Where the mask's pixels sit on the document right now; undefined while it covers the layer's grid. */
export function maskPlacementOf(l: Layer): Transform | undefined {
  if (!l.mask || !l.maskPlacement) return undefined;
  const p = l.maskLinked !== false && l.maskBase ? following(l.maskPlacement, l.maskBase, l.transform) : l.maskPlacement;
  return sameT(p, l.transform) && l.canvas && l.mask.width === l.canvas.width && l.mask.height === l.canvas.height ? undefined : p;
}
/** ImageLayer.maskTransform: where the mask's pixels sit on the document. */
export const maskTransformOf = (l: Layer): Transform => maskPlacementOf(l) ?? l.transform;
/** The mask seen as a layer of its own (its pixels where they sit), so brushes, fills and filters work in the mask's
 *  own grid as the Mac app does, without resampling a placed mask into the layer's grid. */
export const maskGridView = (l: Layer): Layer => ({ ...l, transform: maskTransformOf(l), canvas: l.mask });
const bgCache = new WeakMap<HTMLCanvasElement, [number, number]>();
/** LayerMask.background: white or black beyond a placed mask's pixels, whichever most of its edge is. */
export function maskBackground(m: HTMLCanvasElement, rev = 0): number {
  const c = bgCache.get(m); if (c && c[0] === rev) return c[1];
  const W = m.width, H = m.height, d = m.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H).data;
  let tot = 0, n = 0;
  const step = Math.max(1, Math.floor(Math.max(W, H) / 256));
  for (let x = 0; x < W; x += step) { tot += d[x * 4] + d[((H - 1) * W + x) * 4]; n += 2; }
  for (let y = 0; y < H; y += step) { tot += d[y * W * 4] + d[(y * W + W - 1) * 4]; n += 2; }
  const v = tot * 2 >= n * 255 ? 255 : 0; bgCache.set(m, [rev, v]); return v;
}
const gridCache = new WeakMap<Layer, { key: string; c: HTMLCanvasElement }>();
/** LayerMask.clipImage: the mask as renderers take it, stretched over the layer's pixel grid (placed masks resampled). */
export function maskInLayerGrid(l: Layer): HTMLCanvasElement | null {
  if (!l.mask) return null;
  const p = maskPlacementOf(l); if (!p) return l.mask;
  const pw = l.canvas ? l.canvas.width : Math.max(1, Math.round(l.transform.w)), ph = l.canvas ? l.canvas.height : Math.max(1, Math.round(l.transform.h));
  const key = `${l.rev}|${pw}x${ph}|${JSON.stringify(p)}|${JSON.stringify(l.transform)}`;
  const hit = gridCache.get(l); if (hit && hit.key === key && hit.c.width === pw) return hit.c;
  const c = hit?.c && hit.c.width === pw && hit.c.height === ph ? hit.c : canvasOf(pw, ph), x = ctx2d(c);
  x.setTransform(1, 0, 0, 1, 0, 0);
  const bg = maskBackground(l.mask, l.rev); x.fillStyle = `rgb(${bg},${bg},${bg})`; x.fillRect(0, 0, pw, ph);
  const m = mul(invert(pixelToDoc(l.transform, pw, ph)), pixelToDoc(p, l.mask.width, l.mask.height));
  x.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(l.mask, 0, 0); x.setTransform(1, 0, 0, 1, 0, 0);
  gridCache.set(l, { key, c }); return c;
}
/** Resample a placed mask back into its layer's pixel grid (before painting or filtering it in that grid). */
export function bakeMask(l: Layer): boolean {
  if (!l.mask || !maskPlacementOf(l)) return false;
  const g = maskInLayerGrid(l)!; const c = canvasOf(g.width, g.height); ctx2d(c).drawImage(g, 0, 0);
  l.mask = c; l.maskBase = undefined; l.maskPlacement = l.maskLinked === false ? { ...l.transform } : undefined; l.rev++; return true;
}
/** Set where the mask sits on the document (undefined: back over the layer). */
export function setMaskPlacement(l: Layer, p: Transform | undefined) {
  if (p && l.canvas && l.mask && sameT(p, l.transform) && l.mask.width === l.canvas.width && l.mask.height === l.canvas.height) p = undefined;
  if (!p && l.maskLinked === false) p = l.transform;
  l.maskPlacement = p ? { ...p } : undefined; l.maskBase = p && l.maskLinked !== false ? { ...l.transform } : undefined; l.rev++;
}
/** Apply a document-wide geometric change (crop, canvas size, flip, image size) to a layer and its mask placement. */
export function eachTransform(l: Layer, f: (t: Transform) => void) { f(l.transform); if (l.maskPlacement) f(l.maskPlacement); if (l.maskBase) f(l.maskBase); }
/** EditorSession.toggleMaskLink. */
export function toggleMaskLink(l: Layer) {
  if (!l.mask) return;
  const p = maskPlacementOf(l);
  if (l.maskLinked !== false) { l.maskLinked = false; l.maskPlacement = { ...(p ?? l.transform) }; l.maskBase = undefined; }
  else { l.maskLinked = true; setMaskPlacement(l, p); }
  l.rev++;
}

// ---------- tree helpers ----------
export function childrenOf(doc: Doc, parent: string | null) { return doc.layers.filter(l => l.parentId === parent); }
export function ancestors(doc: Doc, l: Layer): Layer[] {
  const out: Layer[] = []; let p = l.parentId;
  while (p) { const g = doc.layers.find(x => x.id === p); if (!g) break; out.push(g); p = g.parentId; }
  return out;
}
export function descendants(doc: Doc, id: string): Layer[] {
  const out: Layer[] = [];
  const walk = (pid: string) => { for (const l of doc.layers) if (l.parentId === pid) { out.push(l); if (l.isGroup) walk(l.id); } };
  walk(id); return out;
}
export function isEffectivelyVisible(doc: Doc, l: Layer) { return l.visible && ancestors(doc, l).every(a => a.visible); }
export function getLayer(doc: Doc, id: string | null) { return id ? doc.layers.find(l => l.id === id) ?? null : null; }

// ---------- canvases ----------
export function cloneCanvas(c: HTMLCanvasElement): HTMLCanvasElement {
  const n = canvasOf(c.width, c.height); ctx2d(n).drawImage(c, 0, 0); return n;
}
export function solidMask(w: number, h: number, white: boolean): HTMLCanvasElement {
  const m = canvasOf(w, h), c = ctx2d(m); c.fillStyle = white ? '#fff' : '#000'; c.fillRect(0, 0, w, h); return m;
}
export const rgbCss = (c: RGB | { red: number; green: number; blue: number }, a = 1) =>
  `rgba(${Math.round(c.red * 255)},${Math.round(c.green * 255)},${Math.round(c.blue * 255)},${a})`;

// ---------- history (DocumentHistory.swift: whole-document snapshots that share untouched pixels) ----------
interface Snapshot { label: string; layers: Layer[]; activeId: string | null; selectedIds: string[]; width: number; height: number;
  selection: HTMLCanvasElement | null; guides: Guide[]; }
export class History {
  undoStack: Snapshot[] = []; redoStack: Snapshot[] = [];
  private shared = new WeakSet<HTMLCanvasElement>();
  limit = 60;
  private snap(doc: Doc, label: string): Snapshot {
    const layers = doc.layers.map(l => ({ ...l, transform: { ...l.transform }, maskPlacement: l.maskPlacement && { ...l.maskPlacement }, maskBase: l.maskBase && { ...l.maskBase }, effects: l.effects ? structuredClone(l.effects) : undefined,
      adjustment: l.adjustment ? structuredClone(l.adjustment) : undefined, text: l.text ? structuredClone(l.text) : undefined,
      shape: l.shape ? structuredClone(l.shape) : undefined }));
    for (const l of layers) { if (l.canvas) this.shared.add(l.canvas); if (l.mask) this.shared.add(l.mask); }
    if (doc.selection) this.shared.add(doc.selection);
    return { label, layers, activeId: doc.activeId, selectedIds: [...doc.selectedIds], width: doc.width, height: doc.height, selection: doc.selection, guides: doc.guides.map(g => ({ ...g })) };
  }
  /** Call before changing the document. */
  push(doc: Doc, label: string) {
    this.undoStack.push(this.snap(doc, label));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    doc.dirty = true;
  }
  /** Pixels about to be written: copy them first if history still holds them. */
  own(c: HTMLCanvasElement): HTMLCanvasElement { return this.shared.has(c) ? cloneCanvas(c) : c; }
  ownLayer(l: Layer) { if (l.canvas) { const n = this.own(l.canvas); if (n !== l.canvas) l.canvas = n; } l.rev++; }
  ownMask(l: Layer) { if (l.mask) { const n = this.own(l.mask); if (n !== l.mask) l.mask = n; } l.rev++; }
  private restore(doc: Doc, s: Snapshot) {
    doc.layers = s.layers.map(l => ({ ...l, rev: l.rev + 1000 + Math.floor(Math.random() * 1e6) }));
    doc.activeId = s.activeId; doc.selectedIds = s.selectedIds; doc.width = s.width; doc.height = s.height;
    doc.selection = s.selection; doc.selRev++; doc.guides = s.guides.map(g => ({ ...g }));
    doc.dirty = true;
  }
  undo(doc: Doc): string | null {
    const s = this.undoStack.pop(); if (!s) return null;
    this.redoStack.push(this.snap(doc, s.label)); this.restore(doc, s); return s.label;
  }
  redo(doc: Doc): string | null {
    const s = this.redoStack.pop(); if (!s) return null;
    this.undoStack.push(this.snap(doc, s.label)); this.restore(doc, s); return s.label;
  }
  get undoLabel() { return this.undoStack[this.undoStack.length - 1]?.label; }
  get redoLabel() { return this.redoStack[this.redoStack.length - 1]?.label; }
}

// ---------- text and shapes (TypeTool.swift / ShapeTool.swift, drawn with canvas 2D instead of Core Text) ----------
/** A family name for a PostScript font name (ArialMT → Arial, Helvetica-Bold → Helvetica), for fonts named as Photoshop files store them. */
export function cssFamilyGuess(name: string) {
  return name.replace(/-(Regular|Roman|Book|Bold|Italic|BoldItalic|Light|Medium|Semibold|SemiBold|Black|Heavy|Oblique|BoldOblique|It)$/i, '')
    .replace(/(PS)?MT$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || name;
}
export function cssFont(t: TextStyle) {
  const name = t.fontName || 'Helvetica';
  const guess = cssFamilyGuess(name), named = guess !== name ? `"${name}", "${guess}"` : `"${name}"`;
  const family = /mono|menlo|courier/i.test(name) ? `${named}, ui-monospace, monospace` : /serif|times|georgia/i.test(name) && !/sans/i.test(name)
    ? `${named}, Georgia, serif` : `${named}, "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const weight = /bold|black|heavy/i.test(name) ? 'bold ' : '';
  const style = /italic|oblique|-It$/i.test(name) ? 'italic ' : '';
  return `${style}${weight}${t.fontSize}px ${family}`;
}
export function wrapText(t: TextStyle, ctx: CanvasRenderingContext2D, maxWidth?: number): string[] {
  const lines: string[] = [];
  for (const para of t.content.split('\n')) {
    if (!maxWidth) { lines.push(para); continue; }
    const words = para.split(/(\s+)/); let cur = '';
    for (const w of words) {
      const next = cur + w;
      if (cur && ctx.measureText(next).width > maxWidth) { lines.push(cur.trimEnd()); cur = w.trimStart(); } else cur = next;
    }
    lines.push(cur);
  }
  return lines;
}
export const TEXT_PADDING = 12;
/** Renders a text layer's pixels; returns the canvas and its size in document pixels. */
export function renderText(t: TextStyle): HTMLCanvasElement {
  if (t.colorRuns?.length || t.fontRuns?.length) return renderRichText(t);
  const meas = ctx2d(canvasOf(4, 4)); meas.font = cssFont(t);
  (meas as unknown as { letterSpacing: string }).letterSpacing = `${t.tracking}px`;
  const boxW = t.boxSize ? t.boxSize.width - TEXT_PADDING * 2 : undefined;
  const lines = wrapText(t, meas, boxW);
  const lh = t.leading > 0 ? t.leading : t.fontSize * 1.2;
  const textW = Math.max(1, ...lines.map(l => meas.measureText(l).width));
  const w = Math.ceil(t.boxSize ? t.boxSize.width : textW + TEXT_PADDING * 2);
  const h = Math.ceil(t.boxSize ? Math.max(t.boxSize.height, lines.length * lh + TEXT_PADDING * 2) : lines.length * lh + TEXT_PADDING * 2);
  const c = canvasOf(w, h), x = ctx2d(c);
  x.font = cssFont(t); (x as unknown as { letterSpacing: string }).letterSpacing = `${t.tracking}px`;
  x.fillStyle = rgbCss(t); x.textBaseline = 'middle';
  x.textAlign = t.alignment === 'Center' ? 'center' : t.alignment === 'Right' ? 'right' : 'left';
  const ax = t.alignment === 'Center' ? w / 2 : t.alignment === 'Right' ? w - TEXT_PADDING : TEXT_PADDING;
  lines.forEach((line, i) => x.fillText(line, ax, TEXT_PADDING + lh * i + lh / 2));
  return c;
}
/** Text with color and font runs (CoreText's attributed string on the Mac): laid out letter-run by letter-run. */
function renderRichText(t: TextStyle): HTMLCanvasElement {
  const colors = unitColors(t), fonts = unitFonts(t);
  const meas = ctx2d(canvasOf(4, 4)); (meas as unknown as { letterSpacing: string }).letterSpacing = `${t.tracking}px`;
  const fontCss = (name: string) => cssFont({ ...t, fontName: name });
  const width = (from: number, to: number) => {
    let w = 0, i = from;
    while (i < to) { let j = i + 1; while (j < to && fonts[j] === fonts[i]) j++; meas.font = fontCss(fonts[i]); w += meas.measureText(t.content.slice(i, j)).width; i = j; }
    return w;
  };
  // Lines as [start, end) offsets into content.
  const boxW = t.boxSize ? t.boxSize.width - TEXT_PADDING * 2 : undefined;
  const lines: [number, number][] = [];
  let pos = 0;
  for (const para of t.content.split('\n')) {
    const p0 = pos, p1 = pos + para.length;
    if (!boxW) lines.push([p0, p1]);
    else {
      let ls = p0, last = p0;
      const re = /\S+\s*/g; let m: RegExpExecArray | null;
      while ((m = re.exec(para))) {
        const we = p0 + m.index + m[0].length;
        if (last > ls && width(ls, we) > boxW) { lines.push([ls, last]); ls = last; }
        last = we;
      }
      lines.push([ls, p1]);
    }
    pos = p1 + 1;
  }
  const lh = t.leading > 0 ? t.leading : t.fontSize * 1.2;
  const widths = lines.map(([a, b]) => width(a, b).valueOf());
  const textW = Math.max(1, ...lines.map(([a, b]) => width(a, t.content.slice(a, b).trimEnd().length + a)));
  const w = Math.ceil(t.boxSize ? t.boxSize.width : textW + TEXT_PADDING * 2);
  const h = Math.ceil(t.boxSize ? Math.max(t.boxSize.height, lines.length * lh + TEXT_PADDING * 2) : lines.length * lh + TEXT_PADDING * 2);
  const c = canvasOf(w, h), x = ctx2d(c);
  (x as unknown as { letterSpacing: string }).letterSpacing = `${t.tracking}px`;
  x.textBaseline = 'middle'; x.textAlign = 'left';
  lines.forEach(([a, b], li) => {
    const lw = width(a, a + t.content.slice(a, b).trimEnd().length);
    let px = t.alignment === 'Center' ? (w - lw) / 2 : t.alignment === 'Right' ? w - TEXT_PADDING - lw : TEXT_PADDING;
    const py = TEXT_PADDING + lh * li + lh / 2;
    let i = a;
    while (i < b) {
      let j = i + 1; while (j < b && fonts[j] === fonts[i] && sameRGB(colors[j], colors[i])) j++;
      const seg = t.content.slice(i, j);
      x.font = fontCss(fonts[i]); x.fillStyle = rgbCss(colors[i]); x.fillText(seg, px, py);
      px += x.measureText(seg).width; i = j;
    }
  });
  void widths;
  return c;
}
export function renderShape(s: ShapeStyle, w: number, h: number): HTMLCanvasElement {
  const c = canvasOf(w, h), x = ctx2d(c);
  x.fillStyle = x.strokeStyle = rgbCss(s);
  if (s.kind === 'Rectangle') {
    const r = Math.min(s.cornerRadius, w / 2, h / 2);
    x.beginPath(); x.roundRect(0, 0, w, h, r); x.fill();
  } else if (s.kind === 'Ellipse') {
    x.beginPath(); x.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); x.fill();
  } else {
    const a = s.start ?? { x: 0, y: 0.5 }, b = s.end ?? { x: 1, y: 0.5 };
    x.lineWidth = s.lineWidth ?? 4; x.lineCap = 'round';
    x.beginPath(); x.moveTo(a.x * w, a.y * h); x.lineTo(b.x * w, b.y * h); x.stroke();
  }
  return c;
}

// ---------- layer effects (LayerEffects.swift; the Mac app renders them in Metal, here with canvas 2D) ----------
/** LayerEffectsRenderer.margin: the room the effects need around the layer, in its own pixels. */
export function effectsMargin(e?: Effects): number {
  if (!e) return 0;
  const on = <T extends { enabled?: boolean }>(v?: T): v is T => !!v && v.enabled !== false;
  let m = 0;
  if (on(e.stroke) && !e.stroke.inside) m = Math.max(m, e.stroke.size);
  if (on(e.shadow)) m = Math.max(m, e.shadow.distance + e.shadow.blur * 3);
  if (on(e.outerGlow)) m = Math.max(m, e.outerGlow.size * 3);
  return Math.ceil(m) + 2;
}
/** The layer's pixels with its effects drawn around and over them, padded by `margin` on every side. Effect sizes are
 *  in the layer's own pixels, as in the Mac app. Runs the Mac app's effect passes in wasm (EffectsPixels.c); the canvas
 *  2D approximation below is only a fallback for when the kernels can't run. */
export function renderEffects(src: HTMLCanvasElement, e: Effects, scale = 1): { canvas: HTMLCanvasElement; margin: number } {
  const margin = effectsMargin(e);
  const w = src.width + margin * 2, h = src.height + margin * 2;
  try {
    const on = <T extends { enabled?: boolean; opacity: number }>(v?: T): v is T => !!v && v.enabled !== false && v.opacity > 0;
    const off = (r: number) => r * Math.PI / 180;
    const p = new Array(48).fill(0);
    const put = (i: number, c: { red: number; green: number; blue: number; opacity: number }, ...rest: number[]) => { p.splice(i, 8, c.red, c.green, c.blue, c.opacity, 1, ...rest, ...new Array(3 - rest.length).fill(0)); };
    if (on(e.stroke) && e.stroke.size > 0) put(0, e.stroke, e.stroke.size, e.stroke.inside ? 1 : 0);
    if (on(e.shadow)) put(8, e.shadow, -Math.cos(off(e.shadow.angle)) * e.shadow.distance, Math.sin(off(e.shadow.angle)) * e.shadow.distance, e.shadow.blur);
    if (on(e.colorOverlay)) put(16, e.colorOverlay);
    if (on(e.innerShadow)) put(24, e.innerShadow, -Math.cos(off(e.innerShadow.angle)) * e.innerShadow.distance, Math.sin(off(e.innerShadow.angle)) * e.innerShadow.distance, e.innerShadow.blur);
    if (on(e.outerGlow) && e.outerGlow.size > 0) put(32, e.outerGlow, e.outerGlow.size);
    if (on(e.innerGlow) && e.innerGlow.size > 0) put(40, e.innerGlow, e.innerGlow.size);
    const padded = canvasOf(w, h), px = ctx2d(padded); px.drawImage(src, margin, margin);
    const out = layerEffects(px.getImageData(0, 0, w, h), p);
    px.putImageData(out, 0, 0);
    return { canvas: padded, margin };
  } catch (err) {
    console.warn('layer effects: falling back to canvas 2D', err);
    return renderEffectsCanvas(src, e, margin, w, h);
  }
}
function silhouette(src: HTMLCanvasElement, color: string, w: number, h: number, ox: number, oy: number) {
  const c = canvasOf(w, h), x = ctx2d(c);
  x.drawImage(src, ox, oy); x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, w, h);
  return c;
}
/** The layer's pixels with its effects drawn around and over them, padded by `margin` on every side. */
function renderEffectsCanvas(src: HTMLCanvasElement, e: Effects, margin: number, w: number, h: number): { canvas: HTMLCanvasElement; margin: number } {
  const scale = 1;
  const out = canvasOf(w, h), x = ctx2d(out);
  const on = <T extends { enabled?: boolean }>(v?: T): v is T => !!v && v.enabled !== false;
  if (on(e.shadow)) {
    const r = e.shadow.angle * Math.PI / 180;
    const s = silhouette(src, rgbCss(e.shadow), w, h, margin, margin);
    x.save(); x.globalAlpha = e.shadow.opacity; x.filter = `blur(${e.shadow.blur / 2 / scale}px)`;
    // Photoshop's angle: where the light comes from, so the shadow falls the other way.
    x.drawImage(s, -Math.cos(r) * e.shadow.distance / scale, Math.sin(r) * e.shadow.distance / scale); x.restore();
  }
  if (on(e.outerGlow)) {
    const s = silhouette(src, rgbCss(e.outerGlow), w, h, margin, margin);
    x.save(); x.globalAlpha = e.outerGlow.opacity; x.filter = `blur(${e.outerGlow.size / 2 / scale}px)`;
    x.drawImage(s, 0, 0); x.drawImage(s, 0, 0); x.restore();
  }
  if (on(e.stroke) && !e.stroke.inside) {
    const s = silhouette(src, rgbCss(e.stroke), w, h, margin, margin), size = e.stroke.size / scale;
    const st = canvasOf(w, h), sx = ctx2d(st);
    const steps = Math.max(16, Math.ceil(size * 4));
    for (let i = 0; i < steps; i++) { const a = i / steps * Math.PI * 2; sx.drawImage(s, Math.cos(a) * size, Math.sin(a) * size); }
    for (let rr = size - 1; rr > 0; rr -= 1) for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; sx.drawImage(s, Math.cos(a) * rr, Math.sin(a) * rr); }
    x.save(); x.globalAlpha = e.stroke.opacity; x.drawImage(st, 0, 0); x.restore();
  }
  x.drawImage(src, margin, margin);
  const layerOnly = (draw: (c: CanvasRenderingContext2D) => void) => {
    const t = canvasOf(w, h), tx = ctx2d(t);
    draw(tx);
    tx.globalCompositeOperation = 'destination-in'; tx.drawImage(src, margin, margin);
    x.drawImage(t, 0, 0);
  };
  if (on(e.colorOverlay)) { const co = e.colorOverlay; layerOnly(c => { c.fillStyle = rgbCss(co, co.opacity); c.fillRect(0, 0, w, h); }); }
  const innerEdge = (color: string, blur: number, dx: number, dy: number, opacity: number) => layerOnly(c => {
    const inv = canvasOf(w, h), ix = ctx2d(inv);
    ix.fillStyle = color; ix.fillRect(0, 0, w, h); ix.globalCompositeOperation = 'destination-out'; ix.drawImage(src, margin, margin);
    c.globalAlpha = opacity; c.filter = `blur(${blur}px)`; c.drawImage(inv, dx, dy);
  });
  if (on(e.innerShadow)) {
    const r = e.innerShadow.angle * Math.PI / 180;
    innerEdge(rgbCss(e.innerShadow), e.innerShadow.blur / 2 / scale, -Math.cos(r) * e.innerShadow.distance / scale, Math.sin(r) * e.innerShadow.distance / scale, e.innerShadow.opacity);
  }
  if (on(e.innerGlow)) innerEdge(rgbCss(e.innerGlow), e.innerGlow.size / 2 / scale, 0, 0, e.innerGlow.opacity);
  if (on(e.stroke) && e.stroke.inside) {
    const st = e.stroke;
    layerOnly(c => {
      const inv = canvasOf(w, h), ix = ctx2d(inv);
      ix.fillStyle = '#000'; ix.fillRect(0, 0, w, h); ix.globalCompositeOperation = 'destination-out'; ix.drawImage(src, margin, margin);
      const grown = canvasOf(w, h), gx = ctx2d(grown), size = st.size / scale;
      for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2; gx.drawImage(inv, Math.cos(a) * size, Math.sin(a) * size); }
      gx.globalCompositeOperation = 'source-in'; gx.fillStyle = rgbCss(st); gx.fillRect(0, 0, w, h);
      c.globalAlpha = st.opacity; c.drawImage(grown, 0, 0);
    });
  }
  return { canvas: out, margin };
}
