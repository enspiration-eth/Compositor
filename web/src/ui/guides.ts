// Rulers, guides, the layout grid and snapping: CanvasRulers.swift, Guides.swift, GridSettingsSheet.swift and the
// session's Snap To options. View settings persist per browser, like the Mac app's ToolDefaults.
import { app } from './app';
import { uuid, type Guide, type Layer, isEffectivelyVisible, layerCorners } from '../engine/document';

export interface ViewSettings {
  rulers: boolean; grid: boolean; guides: boolean; pixelGrid: boolean;
  snap: boolean; snapGuides: boolean; snapGrid: boolean; snapLayers: boolean; snapBounds: boolean;
  lockGuides: boolean; gridSpacing: number; gridSubdivisions: number;
  /** GridAppearance: color preset (or Custom), major-line style and opacity in percent. */
  gridPreset: GridPreset; gridCustom: { red: number; green: number; blue: number }; gridStyle: GridStyle; gridOpacity: number;
}
export const GRID_PRESETS = { 'Light Gray': [0.7, 0.7, 0.7], 'Light Blue': [0.29, 0.78, 1], 'Light Red': [1, 0.4, 0.4], Green: [0.25, 0.8, 0.25],
  'Medium Blue': [0.2, 0.4, 1], Yellow: [1, 1, 0], Magenta: [1, 0, 1], Cyan: [0, 1, 1], Black: [0, 0, 0], Custom: null } as const;
export type GridPreset = keyof typeof GRID_PRESETS;
export const GRID_STYLES = { Lines: [] as number[], 'Dashed Lines': [4, 3], Dots: [1, 2] } as const;
export type GridStyle = keyof typeof GRID_STYLES;
export const GRID_DEFAULTS = { gridSpacing: 64, gridSubdivisions: 8, gridPreset: 'Light Gray' as GridPreset, gridStyle: 'Lines' as GridStyle, gridOpacity: 45 };
export function gridColor(): [number, number, number] {
  const p = GRID_PRESETS[view.gridPreset] ?? null, c = view.gridCustom;
  return p ? [p[0], p[1], p[2]] : [c.red, c.green, c.blue];
}
const defaults: ViewSettings = { rulers: false, grid: false, guides: true, pixelGrid: true, snap: true, snapGuides: true, snapGrid: true,
  snapLayers: true, snapBounds: true, lockGuides: false, ...GRID_DEFAULTS, gridCustom: { red: 0.7, green: 0.7, blue: 0.7 } };
export const view: ViewSettings = (() => {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('compositor.view') || '{}') }; } catch { return { ...defaults }; }
})();
export function setView<K extends keyof ViewSettings>(k: K, v: ViewSettings[K]) {
  view[k] = v;
  try { localStorage.setItem('compositor.view', JSON.stringify(view)); } catch { /* private mode */ }
  app.emit('view-settings');
}

// ---------- guides ----------
export function addGuide(axis: Guide['axis'], position: number): Guide | null {
  const d = app.doc; if (!d) return null;
  app.edit('New Guide');
  const g = { id: uuid(), axis, position: Math.round(position) };
  d.guides.push(g); if (!view.guides) setView('guides', true);
  app.changed('guides');
  return g;
}
export function clearGuides() { const d = app.doc; if (!d?.guides.length) return; app.edit('Clear Guides'); d.guides = []; app.changed('guides'); }
/** The guide within `tol` screen points of a stage point, if guides are showing and unlocked. */
export function guideAt(sx: number, sy: number, tol = 4): Guide | null {
  const d = app.doc, p = app.project; if (!d || !p || !view.guides || view.lockGuides) return null;
  let best: Guide | null = null, bestD = tol;
  for (const g of d.guides) {
    const dist = g.axis === 'vertical' ? Math.abs(g.position * p.zoom + p.ox - sx) : Math.abs(g.position * p.zoom + p.oy - sy);
    if (dist <= bestD) { best = g; bestD = dist; }
  }
  return best;
}

// ---------- snapping ----------
function targets(axis: 'x' | 'y', exclude: Set<string>): number[] {
  const d = app.doc!, out: number[] = [];
  const total = axis === 'x' ? d.width : d.height;
  if (view.snapBounds) out.push(0, total / 2, total);
  if (view.guides && view.snapGuides) for (const g of d.guides) if ((g.axis === 'vertical') === (axis === 'x')) out.push(g.position);
  if (view.snapLayers) for (const l of d.layers) {
    if (exclude.has(l.id) || l.isGroup || l.adjustment || !isEffectivelyVisible(d, l)) continue;
    const cs = layerCorners(l).map(c => axis === 'x' ? c[0] : c[1]);
    const lo = Math.min(...cs), hi = Math.max(...cs);
    out.push(lo, (lo + hi) / 2, hi);
  }
  return out;
}
function gridSnap(v: number): number | null {
  if (!(view.grid && view.snapGrid)) return null;
  const step = view.gridSpacing / Math.max(1, view.gridSubdivisions);
  return Math.round(v / step) * step;
}
/** The correction that brings the closest of `edges` onto a snap target within 6 screen points, or 0. */
export function snapDelta(axis: 'x' | 'y', edges: number[], exclude: Layer[] = []): number {
  const p = app.project; if (!p || !view.snap) return 0;
  const tol = 6 / p.zoom, ex = new Set(exclude.map(l => l.id)), ts = targets(axis, ex);
  let best = 0, bestD = tol;
  for (const e of edges) {
    for (const t of ts) { const dd = Math.abs(t - e); if (dd < bestD) { bestD = dd; best = t - e; } }
    const g = gridSnap(e); if (g !== null && Math.abs(g - e) < bestD) { bestD = Math.abs(g - e); best = g - e; }
  }
  return best;
}
export function snapPoint(x: number, y: number, exclude: Layer[] = []): [number, number] {
  return [x + snapDelta('x', [x], exclude), y + snapDelta('y', [y], exclude)];
}

// ---------- drawing ----------
export const RULER = 18;
function tickStep(zoom: number): number {
  const steps = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
  return steps.find(s => s * zoom >= 60) ?? 10000;
}
export function drawRuler(c: HTMLCanvasElement, axis: 'x' | 'y', dpr: number, pointer: [number, number] | null) {
  const x = c.getContext('2d')!, p = app.project;
  x.setTransform(1, 0, 0, 1, 0, 0); x.fillStyle = '#262626'; x.fillRect(0, 0, c.width, c.height);
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = c.width / dpr, H = c.height / dpr;
  x.strokeStyle = '#1a1a1a'; x.beginPath(); if (axis === 'x') { x.moveTo(0, H - 0.5); x.lineTo(W, H - 0.5); } else { x.moveTo(W - 0.5, 0); x.lineTo(W - 0.5, H); } x.stroke();
  if (!p) return;
  const zoom = p.zoom, off = axis === 'x' ? p.ox : p.oy, len = axis === 'x' ? W : H;
  const step = tickStep(zoom), minor = step / 10 * zoom >= 4 ? step / 10 : step / 5 * zoom >= 4 ? step / 5 : step / 2;
  const first = Math.floor(-off / zoom / minor) * minor, last = (len - off) / zoom;
  x.strokeStyle = '#6a6a6a'; x.fillStyle = '#9a9a9a'; x.font = '9px -apple-system, Inter, sans-serif'; x.beginPath();
  for (let v = first; v <= last; v += minor) {
    const s = Math.round(v * zoom + off) + 0.5;
    const major = Math.abs(v / step - Math.round(v / step)) < 1e-6, t = major ? RULER : (Math.abs(v / (step / 2) - Math.round(v / (step / 2))) < 1e-6 ? 7 : 4);
    if (axis === 'x') { x.moveTo(s, RULER - t); x.lineTo(s, RULER); } else { x.moveTo(RULER - t, s); x.lineTo(RULER, s); }
    if (major) {
      const label = String(Math.round(v));
      if (axis === 'x') x.fillText(label, s + 2, 9);
      else { x.save(); x.translate(9, s + 2); x.rotate(-Math.PI / 2); x.textAlign = 'right'; x.fillText(label, 0, 0); x.restore(); }
    }
  }
  x.stroke();
  if (pointer) { // the pointer's position, as the Mac rulers mark it
    const s = axis === 'x' ? pointer[0] : pointer[1];
    x.strokeStyle = '#4c8dff'; x.beginPath(); if (axis === 'x') { x.moveTo(s + 0.5, 0); x.lineTo(s + 0.5, RULER); } else { x.moveTo(0, s + 0.5); x.lineTo(RULER, s + 0.5); } x.stroke();
  }
}
/** Grid and guides over the canvas (CanvasLinesOverlay). */
export function drawLines(x: CanvasRenderingContext2D, stageW: number, stageH: number, dragGuide: Guide | null) {
  const p = app.project; if (!p) return;
  const d = p.doc, z = p.zoom, X = (v: number) => Math.round(v * z + p.ox) + 0.5, Y = (v: number) => Math.round(v * z + p.oy) + 0.5;
  const left = Math.max(0, X(0)), right = Math.min(stageW, X(d.width)), top = Math.max(0, Y(0)), bottom = Math.min(stageH, Y(d.height));
  if (view.grid && view.gridSpacing > 0) {
    // drawLayoutGrid: dotted subdivisions at 28/45 of the majors' opacity, majors in the chosen style; every line
    // counted from the origin (LayoutGrid.lines) so an uneven step doesn't drift off the majors.
    const spacing = view.gridSpacing, step = spacing / Math.max(1, view.gridSubdivisions);
    const [r, g, b] = gridColor().map(v => Math.round(v * 255)), major = Math.min(100, Math.max(1, view.gridOpacity)) / 100;
    const along = (len: number) => { const n = Math.floor(len / step + 0.001), out: number[] = []; for (let i = 0; i <= n; i++) out.push(Math.round(i * step)); return out; };
    const isMajor = (v: number) => Math.abs(Math.round(v) % spacing) < 0.001;
    const stroke = (pick: (v: number) => boolean, alpha: number, dash: readonly number[]) => {
      x.strokeStyle = `rgba(${r},${g},${b},${alpha})`; x.setLineDash([...dash]); x.beginPath();
      for (const v of along(d.width)) if (pick(v)) { const s = X(v); if (s >= left - 1 && s <= right + 1) { x.moveTo(s, top); x.lineTo(s, bottom); } }
      for (const v of along(d.height)) if (pick(v)) { const s = Y(v); if (s >= top - 1 && s <= bottom + 1) { x.moveTo(left, s); x.lineTo(right, s); } }
      x.stroke();
    };
    x.save(); x.lineWidth = 1;
    if (step * z >= 4 && view.gridSubdivisions > 1) stroke(v => !isMajor(v), major * 28 / 45, [1, 2]);
    if (spacing * z >= 4) stroke(isMajor, major, GRID_STYLES[view.gridStyle] ?? []);
    x.restore();
  }
  if (view.guides || dragGuide) {
    x.save(); x.lineWidth = 1; x.strokeStyle = '#25c7f7'; x.beginPath();
    const all = view.guides ? d.guides : [];
    for (const g of dragGuide && !all.includes(dragGuide) ? [...all, dragGuide] : all) {
      if (g.axis === 'vertical') { const s = X(g.position); x.moveTo(s, 0); x.lineTo(s, stageH); }
      else { const s = Y(g.position); x.moveTo(0, s); x.lineTo(stageW, s); }
    }
    x.stroke(); x.restore();
  }
}
