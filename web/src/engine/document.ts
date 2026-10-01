// The document model, after Compositor's CanvasDocument / ImageLayer (Document/*.swift) and its .comp manifest:
// layers bottom to top, pass-through folders via parentID, per-layer transform (origin, size, clockwise rotation
// about the center, flips), opacity, blend mode, raster mask, clipping (maskSourceID), adjustments, text, shapes
// and effects. Pixels live in canvases; history shares unchanged canvases between steps (copy on write).
import type { AdjustmentRecord, RGB } from './adjustments';
import { canvasOf, ctx2d } from './adjustments';

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
  alignment: 'Left' | 'Center' | 'Right'; tracking: number; leading: number; boxSize?: { width: number; height: number } }
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
  mask: HTMLCanvasElement | null; maskEnabled: boolean;  // gray in R, same pixel size as `canvas`
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
    const layers = doc.layers.map(l => ({ ...l, transform: { ...l.transform }, effects: l.effects ? structuredClone(l.effects) : undefined,
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
export function cssFont(t: TextStyle) {
  const name = t.fontName || 'Helvetica';
  const family = /mono|menlo|courier/i.test(name) ? `"${name}", ui-monospace, monospace` : /serif|times|georgia/i.test(name) && !/sans/i.test(name)
    ? `"${name}", Georgia, serif` : `"${name}", "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const weight = /bold|black|heavy/i.test(name) ? 'bold ' : '';
  return `${weight}${t.fontSize}px ${family}`;
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
export function effectsMargin(e?: Effects): number {
  if (!e) return 0;
  let m = 0;
  if (e.stroke && e.stroke.enabled !== false && !e.stroke.inside) m = Math.max(m, e.stroke.size + 2);
  if (e.shadow && e.shadow.enabled !== false) m = Math.max(m, e.shadow.distance + e.shadow.blur * 2 + 2);
  if (e.outerGlow && e.outerGlow.enabled !== false) m = Math.max(m, e.outerGlow.size * 2 + 2);
  return Math.ceil(m);
}
function silhouette(src: HTMLCanvasElement, color: string, w: number, h: number, ox: number, oy: number) {
  const c = canvasOf(w, h), x = ctx2d(c);
  x.drawImage(src, ox, oy); x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, w, h);
  return c;
}
/** The layer's pixels with its effects drawn around and over them, padded by `margin` on every side. */
export function renderEffects(src: HTMLCanvasElement, e: Effects, scale = 1): { canvas: HTMLCanvasElement; margin: number } {
  const margin = Math.ceil(effectsMargin(e) / scale);
  const w = src.width + margin * 2, h = src.height + margin * 2;
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
