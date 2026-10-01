import { Renderer } from '../engine/render';
import { WarpSession } from '../engine/kernels';
import { view, guideAt, snapDelta, snapPoint, drawRuler, drawLines, RULER } from './guides';
import type { Guide } from '../engine/document';
// The canvas and its tools: the web counterpart of Rendering/EditorCanvas.swift, BrushStroke.swift, CloneStamp.swift,
// BlurTool.swift, Gradient.swift, ShapeTool.swift, TypeTool.swift, Crop.swift and the selection tools. The GPU draws
// the document (engine/render.ts); a 2D overlay above it draws marching ants, transform handles, crop and cursors.
import { app, type Tool } from './app';
import { type Layer, type Mat, type Transform, layerMatrix, invert, apply, cloneCanvas, rgbCss, layerContains, layerCorners, renderShape,
  isEffectivelyVisible, newPixelLayer, renderText, TEXT_PADDING, getLayer, maskTransformOf, bakeMask, retargetRuns, setTextColor, setTextFont } from '../engine/document';
import { canvasOf, ctx2d, imageDataOf, type RGB } from '../engine/adjustments';
import * as Sel from '../engine/selection';
import { wandMask, spotHeal, withHeap, kernels, distortWarp, alphaBounds, maskMorph, gaussBlur } from '../engine/kernels';
import { objectMatte, saliency } from '../engine/segment';
import { toast } from './dom';

type Pt = [number, number];
interface Stroke {
  layer: Layer; target: HTMLCanvasElement; orig: HTMLCanvasElement; buffer: HTMLCanvasElement; sel: HTMLCanvasElement | null;
  inv: Mat; scale: number; last: Pt | null; smooth: Pt | null; kind: 'paint' | 'erase' | 'mask' | 'heal' | 'clone' | 'smear';
  color: string; cloneOffset?: Pt; source?: HTMLCanvasElement; opacity?: number; dirty: [number, number, number, number] | null; lastLayerPt?: Pt;
  warp?: WarpSession; warpLast?: Pt;
}

export class CanvasController {
  stage: HTMLElement; gl: HTMLCanvasElement; overlay: HTMLCanvasElement; octx: CanvasRenderingContext2D;
  dpr = Math.max(1, window.devicePixelRatio || 1);
  pointer: Pt | null = null;       // last pointer in stage coords
  spaceDown = false;
  private drag: { kind: string; start: Pt; startDoc: Pt; data?: Record<string, unknown> } | null = null;
  private stroke: Stroke | null = null;
  lasso: Pt[] | null = null;              // in-progress lasso (doc coords)
  marquee: { x: number; y: number; w: number; h: number } | null = null;
  crop: { x: number; y: number; w: number; h: number } | null = null;
  gradientLine: [Pt, Pt] | null = null;
  shapeRect: { a: Pt; b: Pt } | null = null;
  cloneSource: Pt | null = null;
  cloneOffset: Pt | null = null;
  lastStrokeEnd: Pt | null = null;
  textEditor: HTMLTextAreaElement | null = null;
  rulerX: HTMLCanvasElement; rulerY: HTMLCanvasElement; rulerCorner: HTMLElement;
  guideDrag: { guide: Guide; isNew: boolean; startPos: number } | null = null;
  /** Free Distort in progress (Distort.swift): the layer's original pixels and the four dragged image corners. */
  distort: { layer: Layer; canvas: HTMLCanvasElement; mask: HTMLCanvasElement | null; keepMask: boolean; transform: Transform; corners: Pt[]; src: ImageData; maskSrc: ImageData | null } | null = null;
  antsPhase = 0;

  constructor(stage: HTMLElement) {
    this.stage = stage;
    this.gl = document.createElement('canvas'); this.gl.className = 'gl-canvas';
    this.overlay = document.createElement('canvas'); this.overlay.className = 'overlay-canvas';
    stage.append(this.gl, this.overlay);
    app.renderer = new Renderer(this.gl);
    app.renderer.onAsyncResult = () => { app.needsRender = true; };
    const wrap = stage.parentElement ?? stage;
    this.rulerX = document.createElement('canvas'); this.rulerX.className = 'ruler ruler-x';
    this.rulerY = document.createElement('canvas'); this.rulerY.className = 'ruler ruler-y';
    this.rulerCorner = document.createElement('div'); this.rulerCorner.className = 'ruler-corner';
    wrap.append(this.rulerX, this.rulerY, this.rulerCorner);
    for (const [c, axis] of [[this.rulerX, 'horizontal'], [this.rulerY, 'vertical']] as const) {
      c.addEventListener('pointerdown', e => {
        const p = app.project; if (!p || e.button !== 0) return;
        c.setPointerCapture(e.pointerId);
        const s = this.local(e), dp = app.toDoc(...s);
        this.guideDrag = { guide: { id: '', axis, position: axis === 'horizontal' ? Math.round(dp[1]) : Math.round(dp[0]) }, isNew: true, startPos: 0 };
        app.needsRender = true;
      });
      c.addEventListener('pointermove', e => { if (this.guideDrag) this.dragGuideTo(e); else { this.pointer = this.local(e); app.needsRender = true; } });
      c.addEventListener('pointerup', e => this.endGuideDrag(e));
      c.addEventListener('pointercancel', e => this.endGuideDrag(e));
    }
    app.on(what => {
      if (what === 'view-settings') this.layoutRulers();
      if (this.distort && (what === 'tool' || what === 'project' || (what === 'layers' && app.active !== this.distort.layer))) this.commitDistort();
    });
    this.layoutRulers();
    this.octx = this.overlay.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(stage);
    stage.addEventListener('pointerdown', e => this.down(e));
    stage.addEventListener('pointermove', e => this.move(e));
    stage.addEventListener('pointerup', e => this.up(e));
    stage.addEventListener('pointercancel', e => this.up(e));
    stage.addEventListener('dblclick', e => this.dblclick(e));
    stage.addEventListener('pointerleave', () => { this.pointer = null; app.needsRender = true; });
    stage.addEventListener('wheel', e => this.wheel(e), { passive: false });
    stage.addEventListener('contextmenu', e => e.preventDefault());
  }
  layoutRulers() {
    const on = view.rulers;
    for (const el of [this.rulerX, this.rulerY, this.rulerCorner]) el.style.display = on ? '' : 'none';
    this.stage.style.left = on ? `${RULER}px` : ''; this.stage.style.top = on ? `${RULER}px` : '';
    app.needsRender = true;
  }
  dragGuideTo(e: PointerEvent) {
    const g = this.guideDrag!, s = this.local(e), dp = app.toDoc(...s);
    let pos = g.guide.axis === 'horizontal' ? dp[1] : dp[0];
    // Guides snap to the canvas edges, center and layer edges like everything else.
    pos += snapDelta(g.guide.axis === 'horizontal' ? 'y' : 'x', [pos]);
    g.guide.position = Math.round(pos);
    this.pointer = s; app.needsRender = true;
  }
  endGuideDrag(e: PointerEvent) {
    const g = this.guideDrag; if (!g) return;
    this.guideDrag = null;
    const d = app.doc; if (!d) return;
    const s = this.local(e), r = this.stage.getBoundingClientRect();
    const outside = s[0] < 0 || s[1] < 0 || s[0] > r.width || s[1] > r.height;
    if (g.isNew) {
      if (outside) { app.needsRender = true; return; }
      app.edit('New Guide'); d.guides.push({ ...g.guide, id: crypto.randomUUID ? crypto.randomUUID().toUpperCase() : String(Date.now()) });
      if (!view.guides) view.guides = true;
    } else {
      // The guide moved live; record the move (or the removal, when dropped off the canvas) as one undo step.
      const moved = g.guide.position; g.guide.position = g.startPos;
      app.edit(outside ? 'Delete Guide' : 'Move Guide');
      if (outside) d.guides = d.guides.filter(x => x.id !== g.guide.id); else g.guide.position = moved;
    }
    app.changed('guides');
  }
  resize() {
    const r = this.stage.getBoundingClientRect();
    for (const c of [this.gl, this.overlay]) { c.width = Math.max(1, Math.round(r.width * this.dpr)); c.height = Math.max(1, Math.round(r.height * this.dpr)); c.style.width = `${r.width}px`; c.style.height = `${r.height}px`; }
    const first = app.stageSize.w === 800 && app.stageSize.h === 600;
    app.stageSize = { w: r.width, h: r.height };
    if (app.project && (app.project.fitted || first)) app.fit();
    app.needsRender = true;
  }
  local(e: { clientX: number; clientY: number }): Pt { const r = this.stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  // ---------- frame ----------
  frame() {
    const p = app.project;
    if (!p) { app.renderer.clearScreen(); this.octx.clearRect(0, 0, this.overlay.width, this.overlay.height); return; }
    app.renderer.render(p.doc);
    app.renderer.present(p.doc, p.zoom, p.ox, p.oy, this.dpr, view.pixelGrid);
    this.drawOverlay();
    if (view.rulers) this.drawRulers();
  }
  drawRulers() {
    const r = this.stage.getBoundingClientRect();
    const size = (c: HTMLCanvasElement, w: number, h: number) => {
      const W = Math.max(1, Math.round(w * this.dpr)), H = Math.max(1, Math.round(h * this.dpr));
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; c.style.width = `${w}px`; c.style.height = `${h}px`; }
    };
    size(this.rulerX, r.width, RULER); size(this.rulerY, RULER, r.height);
    drawRuler(this.rulerX, 'x', this.dpr, this.pointer); drawRuler(this.rulerY, 'y', this.dpr, this.pointer);
  }
  drawOverlay() {
    const x = this.octx, p = app.project!, d = p.doc;
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, this.overlay.width, this.overlay.height);
    x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const S = (a: number, b: number) => app.toScreen(a, b);
    // canvas border
    const [bx, by] = S(0, 0); x.strokeStyle = 'rgba(0,0,0,0.6)'; x.lineWidth = 1; x.strokeRect(Math.round(bx) - 0.5, Math.round(by) - 0.5, d.width * p.zoom + 1, d.height * p.zoom + 1);
    drawLines(x, this.overlay.width / this.dpr, this.overlay.height / this.dpr, this.guideDrag?.guide ?? null);
    // marching ants
    const loops = Sel.selectionOutline(d);
    if (loops) {
      x.save(); x.beginPath();
      for (const loop of loops) { for (let i = 0; i < loop.length; i += 2) { const [sx, sy] = S(loop[i], loop[i + 1]); i ? x.lineTo(sx, sy) : x.moveTo(sx, sy); } x.closePath(); }
      x.lineWidth = 1; x.strokeStyle = '#fff'; x.setLineDash([]); x.stroke();
      x.strokeStyle = '#000'; x.setLineDash([4, 4]); x.lineDashOffset = -this.antsPhase; x.stroke(); x.restore();
    }
    const dashed = (draw: () => void) => { x.save(); x.lineWidth = 1; x.strokeStyle = '#fff'; draw(); x.stroke(); x.strokeStyle = '#000'; x.setLineDash([4, 4]); x.lineDashOffset = -this.antsPhase; draw(); x.stroke(); x.restore(); };
    if (this.marquee) {
      const m = this.marquee, [ax, ay] = S(m.x, m.y);
      dashed(() => { x.beginPath(); if (app.marqueeKind === 'ellipse') x.ellipse(ax + m.w * p.zoom / 2, ay + m.h * p.zoom / 2, Math.abs(m.w * p.zoom / 2), Math.abs(m.h * p.zoom / 2), 0, 0, Math.PI * 2); else x.rect(ax, ay, m.w * p.zoom, m.h * p.zoom); });
    }
    if (this.lasso && this.lasso.length) {
      dashed(() => { x.beginPath(); this.lasso!.forEach(([a, b], i) => { const [sx, sy] = S(a, b); i ? x.lineTo(sx, sy) : x.moveTo(sx, sy); }); if (app.lassoKind === 'polygonal' && this.pointer) x.lineTo(...this.pointer); });
      if (app.lassoKind === 'polygonal') for (const [a, b] of this.lasso) { const [sx, sy] = S(a, b); x.fillStyle = '#fff'; x.fillRect(sx - 2.5, sy - 2.5, 5, 5); x.strokeStyle = '#000'; x.strokeRect(sx - 2.5, sy - 2.5, 5, 5); }
    }
    // transform box for the move tool
    const a = app.active;
    if (this.distort) {
      const cs = this.distort.corners.map(c => S(...c));
      x.save(); x.strokeStyle = '#4c8dff'; x.lineWidth = 1; x.beginPath(); cs.forEach((c, i) => i ? x.lineTo(...c) : x.moveTo(...c)); x.closePath(); x.stroke();
      for (const c of cs) { x.fillStyle = '#fff'; x.beginPath(); x.rect(c[0] - 4, c[1] - 4, 8, 8); x.fill(); x.stroke(); }
      x.restore();
    } else if (app.tool === 'move' && a && a.mask && app.maskTarget && a.maskLinked === false) {
      // The unlinked mask's own box (dashed): what the Move tool drags.
      const cs = layerCorners({ ...a, transform: maskTransformOf(a) }).map(([u, v]) => S(u, v));
      x.save(); x.setLineDash([5, 4]); x.strokeStyle = '#ff9f2e'; x.lineWidth = 1.5; x.beginPath(); cs.forEach((c, i) => i ? x.lineTo(...c) : x.moveTo(...c)); x.closePath(); x.stroke();
      x.setLineDash([]); x.lineWidth = 1;
      for (const hp of this.handles({ ...a, transform: maskTransformOf(a) })) { x.fillStyle = '#fff'; x.beginPath(); if (hp.kind === 'rotate') x.arc(hp.s[0], hp.s[1], 5, 0, Math.PI * 2); else x.rect(hp.s[0] - 4, hp.s[1] - 4, 8, 8); x.fill(); x.stroke(); }
      x.restore();
    } else if (app.tool === 'move' && a && !a.isGroup && !a.adjustment && isEffectivelyVisible(d, a)) {
      const cs = layerCorners(a).map(([u, v]) => S(u, v));
      x.save(); x.strokeStyle = '#4c8dff'; x.lineWidth = 1; x.beginPath(); cs.forEach((c, i) => i ? x.lineTo(...c) : x.moveTo(...c)); x.closePath(); x.stroke();
      for (const hp of this.handles(a)) { x.fillStyle = '#fff'; x.strokeStyle = '#4c8dff'; x.beginPath(); if (hp.kind === 'rotate') x.arc(hp.s[0], hp.s[1], 5, 0, Math.PI * 2); else x.rect(hp.s[0] - 4, hp.s[1] - 4, 8, 8); x.fill(); x.stroke(); }
      const top = this.handles(a).find(h0 => h0.kind === 'rotate');
      const mid = S(...apply(layerUnit(a), 0.5, 0));
      if (top) { x.beginPath(); x.moveTo(...mid); x.lineTo(...top.s); x.stroke(); }
      x.restore();
    }
    if (app.canvasHook?.draw) { x.save(); app.canvasHook.draw(x, S); x.restore(); }
    if (this.crop) {
      const c = this.crop, [cx, cy] = S(c.x, c.y), w = c.w * p.zoom, h = c.h * p.zoom;
      x.save(); x.fillStyle = 'rgba(0,0,0,0.55)'; x.beginPath(); x.rect(0, 0, this.overlay.width, this.overlay.height); x.rect(cx, cy, w, h); x.fill('evenodd');
      x.strokeStyle = '#fff'; x.lineWidth = 1; x.strokeRect(cx + 0.5, cy + 0.5, w, h);
      x.strokeStyle = 'rgba(255,255,255,0.35)'; x.beginPath();
      for (const f of [1 / 3, 2 / 3]) { x.moveTo(cx + w * f, cy); x.lineTo(cx + w * f, cy + h); x.moveTo(cx, cy + h * f); x.lineTo(cx + w, cy + h * f); }
      x.stroke();
      x.fillStyle = '#fff'; for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]]) x.fillRect(cx + w * u - 4, cy + h * v - 4, 8, 8);
      x.restore();
    }
    if (this.gradientLine) {
      const [g0, g1] = this.gradientLine.map(q => S(...q));
      x.save(); x.strokeStyle = '#fff'; x.lineWidth = 2; x.beginPath(); x.moveTo(...g0); x.lineTo(...g1); x.stroke();
      for (const q of [g0, g1]) { x.beginPath(); x.arc(q[0], q[1], 5, 0, Math.PI * 2); x.fillStyle = '#fff'; x.fill(); x.strokeStyle = '#000'; x.lineWidth = 1; x.stroke(); }
      x.restore();
    }
    if (this.shapeRect) {
      const { a: s0, b: s1 } = this.shapeRect, [ax, ay] = S(...s0), [bx2, by2] = S(...s1);
      x.save(); x.strokeStyle = '#4c8dff'; x.fillStyle = rgbCss(app.fg, 0.6); x.lineWidth = 1.5; x.beginPath();
      if (app.shape.kind === 'Ellipse') x.ellipse((ax + bx2) / 2, (ay + by2) / 2, Math.abs(bx2 - ax) / 2, Math.abs(by2 - ay) / 2, 0, 0, Math.PI * 2);
      else if (app.shape.kind === 'Line') { x.lineWidth = app.shape.lineWidth * p.zoom; x.strokeStyle = rgbCss(app.fg, 0.8); x.lineCap = 'round'; x.moveTo(ax, ay); x.lineTo(bx2, by2); }
      else x.roundRect(Math.min(ax, bx2), Math.min(ay, by2), Math.abs(bx2 - ax), Math.abs(by2 - ay), app.shape.cornerRadius * p.zoom);
      if (app.shape.kind !== 'Line') x.fill(); x.stroke(); x.restore();
    }
    if (this.cloneSource && app.tool === 'cloneStamp') {
      const [sx, sy] = S(...this.cloneSource);
      x.save(); x.strokeStyle = '#fff'; x.lineWidth = 1.5; x.beginPath(); x.moveTo(sx - 7, sy); x.lineTo(sx + 7, sy); x.moveTo(sx, sy - 7); x.lineTo(sx, sy + 7); x.stroke(); x.restore();
    }
    // brush cursor
    if (this.pointer && ['brush', 'spotHealing', 'cloneStamp', 'blur'].includes(app.tool) && !this.spaceDown) {
      const r = app.brush.size / 2 * p.zoom;
      x.save(); x.beginPath(); x.arc(this.pointer[0], this.pointer[1], Math.max(1, r), 0, Math.PI * 2);
      x.strokeStyle = 'rgba(0,0,0,0.7)'; x.lineWidth = 2.5; x.stroke(); x.strokeStyle = 'rgba(255,255,255,0.95)'; x.lineWidth = 1; x.stroke();
      if (app.brush.hardness < 0.98 && r * app.brush.hardness > 2) { x.beginPath(); x.arc(this.pointer[0], this.pointer[1], r * app.brush.hardness, 0, Math.PI * 2); x.setLineDash([2, 3]); x.stroke(); }
      x.restore();
    }
    if (this.stroke?.kind === 'heal') {
      // Show the area to heal while painting, as the Mac app's heal overlay does.
      const st = this.stroke, m = layerMatrix(st.layer);
      x.save(); x.globalAlpha = 0.45; x.setTransform(this.dpr * p.zoom, 0, 0, this.dpr * p.zoom, this.dpr * p.ox, this.dpr * p.oy);
      x.transform(m[0], m[1], m[2], m[3], m[4], m[5]); x.drawImage(st.buffer, 0, 0); x.restore();
    }
  }

  // ---------- transform handles ----------
  handles(l: Layer): { kind: string; u: number; v: number; s: Pt }[] {
    const m = layerUnit(l), out: { kind: string; u: number; v: number; s: Pt }[] = [];
    for (const [u, v] of [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]]) out.push({ kind: 'scale', u, v, s: app.toScreen(...apply(m, u, v)) });
    const top = app.toScreen(...apply(m, 0.5, 0)), center = app.toScreen(...apply(m, 0.5, 0.5));
    const dx = top[0] - center[0], dy = top[1] - center[1], len = Math.hypot(dx, dy) || 1;
    out.push({ kind: 'rotate', u: 0.5, v: -1, s: [top[0] + dx / len * 24, top[1] + dy / len * 24] });
    return out;
  }

  /** Is a Move-tool handle (the active layer's, or its unlinked mask's while the mask is selected) within 8 px? */
  handleNear(s: Pt): boolean {
    const a = app.active; if (!a || a.isGroup || a.adjustment) return false;
    const box = a.mask && app.maskTarget && a.maskLinked === false ? { ...a, transform: maskTransformOf(a) } : a;
    return this.handles(box).some(hp => Math.hypot(hp.s[0] - s[0], hp.s[1] - s[1]) < 8);
  }
  // ---------- pointer ----------
  down(e: PointerEvent) {
    if (this.textEditor && e.target !== this.textEditor) { this.commitText(); }
    const p = app.project; if (!p) return;
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    this.stage.setPointerCapture(e.pointerId);
    const s = this.local(e);
    let dpt = app.toDoc(...s);
    if (['marquee', 'crop', 'shape'].includes(app.tool)) dpt = snapPoint(...dpt);
    this.pointer = s;
    if (e.button === 1 || this.spaceDown || app.tool === 'hand') { this.drag = { kind: 'pan', start: s, startDoc: dpt, data: { ox: p.ox, oy: p.oy } }; return; }
    if (e.button !== 0) return;
    if (app.canvasHook) { this.drag = { kind: 'hook', start: s, startDoc: dpt }; app.canvasHook.down?.(dpt, e); app.needsRender = true; return; }
    if (app.tool === 'move' && !e.altKey) {
      // A transform handle under the pointer wins over a guide running through it.
      const g = this.handleNear(s) ? null : guideAt(s[0], s[1]);
      if (g) { this.guideDrag = { guide: g, isNew: false, startPos: g.position }; return; }
    }
    const d = p.doc, mode: Sel.SelMode = e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace';
    switch (app.tool as Tool) {
      case 'zoom': {
        this.drag = { kind: 'zoom', start: s, startDoc: dpt, data: { z: p.zoom, moved: false, out: e.altKey } }; return;
      }
      case 'move': return this.moveDown(e, s, dpt);
      case 'marquee': {
        if (mode === 'replace' && Sel.selectionContains(d, ...dpt)) { app.edit('Move Selection'); this.drag = { kind: 'moveSel', start: s, startDoc: dpt, data: { sel: d.selection, last: dpt } }; return; }
        this.drag = { kind: 'marquee', start: s, startDoc: dpt, data: { mode } }; this.marquee = { x: dpt[0], y: dpt[1], w: 0, h: 0 }; return;
      }
      case 'lasso': {
        if (app.lassoKind === 'polygonal') {
          if (!this.lasso) this.lasso = [dpt, dpt];
          else {
            const [fx, fy] = app.toScreen(...this.lasso[0]);
            if (this.lasso.length > 2 && Math.hypot(fx - s[0], fy - s[1]) < 8) { this.finishLasso(mode); return; }
            this.lasso.push(dpt);
          }
          this.drag = { kind: 'polyLasso', start: s, startDoc: dpt, data: { mode } };
          app.needsRender = true; return;
        }
        if (mode === 'replace' && Sel.selectionContains(d, ...dpt)) { app.edit('Move Selection'); this.drag = { kind: 'moveSel', start: s, startDoc: dpt, data: { last: dpt } }; return; }
        this.lasso = [dpt]; this.drag = { kind: 'lasso', start: s, startDoc: dpt, data: { mode } }; return;
      }
      case 'wand': return this.wandClick(dpt, mode);
      case 'crop': return this.cropDown(s, dpt);
      case 'brush': case 'spotHealing': case 'cloneStamp': case 'blur': {
        if (app.tool === 'cloneStamp' && e.altKey) { this.cloneSource = dpt; this.cloneOffset = null; app.needsRender = true; toast('Clone source set'); return; }
        return this.beginStroke(dpt, e.shiftKey);
      }
      case 'gradient': {
        const a = app.active;
        if (!a || (!a.canvas && !(app.maskTarget && a.mask))) { toast('Select a pixel layer to draw a gradient on.'); return; }
        app.edit('Gradient');
        const target = app.maskTarget && a.mask ? app.ownMask(a) : app.ownPixels(a);
        this.drag = { kind: 'gradient', start: s, startDoc: dpt, data: { layer: a, target, orig: cloneCanvas(target), sel: Sel.selectionInLayer(d, a, target.width, target.height) } };
        this.gradientLine = [dpt, dpt]; return;
      }
      case 'shape': this.shapeRect = { a: dpt, b: dpt }; this.drag = { kind: 'shape', start: s, startDoc: dpt }; return;
      case 'type': return this.typeClick(dpt);
      case 'eyedropper': return this.sample(dpt, e.altKey);
      default: return;
    }
  }
  move(e: PointerEvent) {
    if (this.guideDrag) { this.dragGuideTo(e); return; }
    const p = app.project; const s = this.local(e); this.pointer = s; app.needsRender = true;
    if (!p) return;
    const dr = this.drag;
    let dpt = app.toDoc(...s);
    if (dr && ['marquee', 'cropNew', 'cropHandle', 'shape'].includes(dr.kind)) dpt = snapPoint(...dpt);
    this.updateCursor(s);
    if (this.stroke && e.buttons & 1) {
      const events = (e.getCoalescedEvents?.() ?? [e]);
      for (const ev of events) this.strokeTo(app.toDoc(...this.local(ev)));
      return;
    }
    if (!dr) return;
    switch (dr.kind) {
      case 'hook': app.canvasHook?.move?.(dpt, e); return;
      case 'pan': p.ox = (dr.data!.ox as number) + s[0] - dr.start[0]; p.oy = (dr.data!.oy as number) + s[1] - dr.start[1]; p.fitted = false; app.emit('view'); return;
      case 'zoom': {
        const dx = s[0] - dr.start[0];
        if (Math.abs(dx) > 3) { dr.data!.moved = true; app.zoomTo((dr.data!.z as number) * Math.pow(2, dx / 120), dr.start[0], dr.start[1]); }
        return;
      }
      case 'marquee': {
        let w = dpt[0] - dr.startDoc[0], h = dpt[1] - dr.startDoc[1];
        if (e.shiftKey && dr.data!.mode !== 'add') { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
        let x0 = dr.startDoc[0], y0 = dr.startDoc[1];
        if (e.altKey && dr.data!.mode !== 'subtract') { x0 -= w; y0 -= h; w *= 2; h *= 2; }
        this.marquee = { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + h), w: Math.abs(w), h: Math.abs(h) }; return;
      }
      case 'lasso': this.lasso!.push(dpt); return;
      case 'moveSel': {
        const last = dr.data!.last as Pt; Sel.translateSelection(p.doc, dpt[0] - last[0], dpt[1] - last[1]);
        dr.data!.last = [last[0] + Math.round(dpt[0] - last[0]), last[1] + Math.round(dpt[1] - last[1])]; return;
      }
      case 'move': return this.moveDrag(dr, dpt, e);
      case 'distort': {
        const dist = this.distort; if (!dist) return;
        dist.corners[dr.data!.i as number] = snapPoint(...dpt, [dist.layer]);
        this.previewDistort(); return;
      }
      case 'cropNew': case 'cropMove': case 'cropHandle': return this.cropDrag(dr, dpt, e);
      case 'gradient': {
        let end = dpt;
        if (e.shiftKey) { const dx = dpt[0] - dr.startDoc[0], dy = dpt[1] - dr.startDoc[1], ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, len = Math.hypot(dx, dy); end = [dr.startDoc[0] + Math.cos(ang) * len, dr.startDoc[1] + Math.sin(ang) * len]; }
        this.gradientLine = [dr.startDoc, end]; this.paintGradient(dr.data!); return;
      }
      case 'shape': {
        let b = dpt;
        const a0 = dr.startDoc;
        if (e.shiftKey) {
          if (app.shape.kind === 'Line') { const dx = dpt[0] - a0[0], dy = dpt[1] - a0[1], ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, len = Math.hypot(dx, dy); b = [a0[0] + Math.cos(ang) * len, a0[1] + Math.sin(ang) * len]; }
          else { const m = Math.max(Math.abs(dpt[0] - a0[0]), Math.abs(dpt[1] - a0[1])); b = [a0[0] + Math.sign(dpt[0] - a0[0] || 1) * m, a0[1] + Math.sign(dpt[1] - a0[1] || 1) * m]; }
        }
        let a1 = a0; if (e.altKey && app.shape.kind !== 'Line') { a1 = [2 * a0[0] - b[0], 2 * a0[1] - b[1]]; }
        this.shapeRect = { a: a1, b }; return;
      }
    }
  }
  up(e: PointerEvent) {
    if (this.guideDrag) { this.endGuideDrag(e); return; }
    const p = app.project; const dr = this.drag; this.drag = null;
    if (this.stroke) { this.endStroke(); return; }
    if (!p || !dr) return;
    const d = p.doc;
    switch (dr.kind) {
      case 'hook': app.canvasHook?.up?.(app.toDoc(...this.local(e)), e); app.needsRender = true; return;
      case 'zoom': if (!dr.data!.moved) app.zoomStep(dr.data!.out || e.altKey ? -1 : 1, dr.start[0], dr.start[1]); return;
      case 'marquee': {
        const m = this.marquee; this.marquee = null;
        if (!m || m.w < 1 || m.h < 1) { if (dr.data!.mode === 'replace') app.deselect(); app.needsRender = true; return; }
        app.edit(app.marqueeKind === 'ellipse' ? 'Elliptical Marquee' : 'Rectangular Marquee');
        Sel.combine(d, Sel.rectSelection(d, m, app.marqueeKind === 'ellipse', app.marqueeFeather), dr.data!.mode as Sel.SelMode);
        app.emit('selection'); return;
      }
      case 'lasso': {
        const pts = this.lasso; this.lasso = null;
        if (!pts || pts.length < 3) { if (dr.data!.mode === 'replace') app.deselect(); app.needsRender = true; return; }
        app.edit('Lasso'); Sel.combine(d, Sel.polygonSelection(d, pts, app.marqueeFeather), dr.data!.mode as Sel.SelMode); app.emit('selection'); return;
      }
      case 'move':
        if (!dr.data!.moved) { app.history?.undoStack.pop(); return; }
        if ((dr.data!.hit as { kind?: string } | null)?.kind === 'scale') for (const l of (dr.data!.layers as Layer[] | undefined) ?? []) app.redrawShape(l);
        app.emit('transform'); return;
      case 'moveSel': app.emit('selection'); return;
      case 'gradient': {
        const line = this.gradientLine; this.gradientLine = null;
        if (!line || Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]) < 1) { app.undo(); return; }
        const l = dr.data!.layer as Layer; if (!app.maskTarget) app.rasterize(l);
        app.changed('pixels'); return;
      }
      case 'shape': return this.finishShape();
      case 'cropNew': case 'cropMove': case 'cropHandle': if (this.crop && (this.crop.w < 2 || this.crop.h < 2)) this.crop = null; app.emit('crop'); return;
    }
  }
  dblclick(e: MouseEvent) {
    if (app.tool === 'lasso' && app.lassoKind === 'polygonal' && this.lasso) { this.lasso.pop(); this.finishLasso('replace'); }
    if (app.tool === 'crop' && this.crop) this.applyCrop();
    if (app.tool === 'hand') app.fit();
    if (app.tool === 'zoom') app.zoomTo(1);
    void e;
  }
  wheel(e: WheelEvent) {
    const p = app.project; if (!p) return;
    e.preventDefault();
    const s = this.local(e);
    if (e.ctrlKey || e.metaKey) app.zoomTo(p.zoom * Math.pow(2, -e.deltaY / (e.ctrlKey ? 100 : 300)), s[0], s[1]);
    else { p.ox -= e.deltaX; p.oy -= e.deltaY; p.fitted = false; app.emit('view'); }
  }
  updateCursor(s: Pt) {
    let c = 'default';
    const t = app.tool;
    if (app.canvasHook && !this.spaceDown) c = app.canvasHook.cursor ?? 'crosshair';
    else if (this.spaceDown || t === 'hand') c = this.drag?.kind === 'pan' ? 'grabbing' : 'grab';
    else if (t === 'zoom') c = 'zoom-in';
    else if (['brush', 'spotHealing', 'cloneStamp', 'blur'].includes(t)) c = 'none';
    else if (['marquee', 'lasso', 'wand', 'crop', 'gradient', 'shape', 'eyedropper'].includes(t)) c = 'crosshair';
    else if (t === 'type') c = 'text';
    else if (t === 'move' && guideAt(s[0], s[1])) c = guideAt(s[0], s[1])!.axis === 'vertical' ? 'col-resize' : 'row-resize';
    else if (t === 'move') {
      const a = app.active;
      const hit = a ? this.handles(a).find(hp => Math.hypot(hp.s[0] - s[0], hp.s[1] - s[1]) < 8) : null;
      c = hit ? (hit.kind === 'rotate' ? 'grab' : (hit.u === 0.5 ? 'ns-resize' : hit.v === 0.5 ? 'ew-resize' : (hit.u === hit.v ? 'nwse-resize' : 'nesw-resize'))) : 'move';
    }
    this.stage.style.cursor = c;
  }

  // ---------- move / transform ----------
  moveDown(e: PointerEvent, s: Pt, dpt: Pt) {
    const d = app.doc!;
    if (this.distort) {
      const i = this.distortCornerAt(s);
      if (i >= 0) { this.drag = { kind: 'distort', start: s, startDoc: dpt, data: { i } }; return; }
      this.commitDistort();
    }
    let a = app.active;
    if (a && (e.metaKey || e.ctrlKey) && a.canvas && !a.isGroup && !a.adjustment) {
      // ⌘-drag a corner handle: Free Distort.
      const corner = this.handles(a).find(hp => hp.kind === 'scale' && hp.u !== 0.5 && hp.v !== 0.5 && Math.hypot(hp.s[0] - s[0], hp.s[1] - s[1]) < 8);
      if (corner && this.startDistort(a)) {
        const i = this.distortCornerAt(s);
        if (i >= 0) { this.drag = { kind: 'distort', start: s, startDoc: dpt, data: { i } }; return; }
      }
    }
    if (a && app.maskTarget && a.mask && a.maskLinked === false && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // An unlinked mask, selected, moves on its own (EditorSession.commitMaskTransform).
      // Its own handles scale and rotate it (the Mac app's mask transform box).
      const mhit = this.handles({ ...a, transform: maskTransformOf(a) }).find(hp => Math.hypot(hp.s[0] - s[0], hp.s[1] - s[1]) < 8) ?? null;
      app.edit('Transform Layer Mask');
      this.drag = { kind: 'move', start: s, startDoc: dpt, data: { maskOnly: true, hit: mhit, layer: a, startP: { ...maskTransformOf(a) }, moved: false } };
      return;
    }
    const hit = a && !a.isGroup ? this.handles(a).find(hp => Math.hypot(hp.s[0] - s[0], hp.s[1] - s[1]) < 8) : null;
    if (!hit && (e.metaKey || e.ctrlKey || !a)) {
      // Auto-select the topmost visible pixel layer under the pointer.
      const under = [...d.layers].reverse().find(l => !l.isGroup && l.canvas && isEffectivelyVisible(d, l) && layerContains(l, ...dpt) && alphaAt(l, dpt) > 10);
      if (under) { app.setActive(under.id); a = under; }
    }
    if (!a) return;
    const ids = d.selectedIds.includes(a.id) ? d.selectedIds : [a.id];
    let layers = ids.map(id => getLayer(d, id)!).filter(Boolean);
    // A folder moves everything inside it.
    layers = layers.flatMap(l => l.isGroup ? d.layers.filter(x => x.parentId && (x.parentId === l.id || isInside(d, x, l.id))) : [l]);
    if (e.altKey && !hit) { app.duplicateLayer(); a = app.active!; layers = [a]; }
    app.edit(hit ? (hit.kind === 'rotate' ? 'Rotate' : 'Scale') : 'Move');
    this.drag = { kind: 'move', start: s, startDoc: dpt, data: { hit, layer: a, layers, starts: layers.map(l => ({ ...l.transform })), moved: false } };
  }
  moveDrag(dr: NonNullable<CanvasController['drag']>, dpt: Pt, e: PointerEvent) {
    const data = dr.data!; data.moved = true;
    if (data.maskOnly) {
      const l = data.layer as Layer, p0 = data.startP as Transform, mh = data.hit as { kind: string; u: number; v: number } | null;
      if (mh) { l.maskPlacement = this.handleTransform(p0, mh, dr.startDoc, dpt, e); l.rev++; app.needsRender = true; return; }
      let dx = dpt[0] - dr.startDoc[0], dy = dpt[1] - dr.startDoc[1];
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      l.maskPlacement = { ...p0, x: Math.round(p0.x + dx), y: Math.round(p0.y + dy) }; l.rev++;
      app.needsRender = true; return;
    }
    const hit = data.hit as ReturnType<CanvasController['handles']>[number] | null;
    const layers = data.layers as Layer[], starts = data.starts as Transform[];
    if (!hit) {
      let dx = dpt[0] - dr.startDoc[0], dy = dpt[1] - dr.startDoc[1];
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      // Snap the primary layer's bounds (edges and center) to guides, grid, other layers and the canvas (Snap To).
      const st = starts[layers.indexOf(data.layer as Layer)] ?? starts[0];
      if (st) {
        const cs = layerCorners({ ...(data.layer as Layer), transform: st }), xs = cs.map(c => c[0]), ys = cs.map(c => c[1]);
        const x0 = Math.min(...xs) + dx, x1 = Math.max(...xs) + dx, y0 = Math.min(...ys) + dy, y1 = Math.max(...ys) + dy;
        if (!(e.shiftKey && dx === 0)) dx += snapDelta('x', [x0, (x0 + x1) / 2, x1], layers);
        if (!(e.shiftKey && dy === 0)) dy += snapDelta('y', [y0, (y0 + y1) / 2, y1], layers);
      }
      layers.forEach((l, i) => { l.transform = { ...starts[i], x: Math.round(starts[i].x + dx), y: Math.round(starts[i].y + dy) }; });
    } else {
      const l = data.layer as Layer, t0 = starts[layers.indexOf(l)] ?? (l.transform);
      l.transform = this.handleTransform(t0, hit, dr.startDoc, dpt, e);
    }
    app.needsRender = true; app.emit('transform-live');
  }
  /** A scale or rotate handle dragged from `startDoc` to `dpt`: the new transform from `t0` (Shift keeps 15° steps or
   *  frees the corner aspect, Option scales from the center). */
  handleTransform(t0: Transform, hit: { kind: string; u: number; v: number }, startDoc: Pt, dpt: Pt, e: PointerEvent): Transform {
    const c0: Pt = [t0.x + t0.w / 2, t0.y + t0.h / 2], r = t0.rotation * Math.PI / 180;
    if (hit.kind === 'rotate') {
      const a0 = Math.atan2(startDoc[1] - c0[1], startDoc[0] - c0[0]), a1 = Math.atan2(dpt[1] - c0[1], dpt[0] - c0[0]);
      let deg = t0.rotation + (a1 - a0) * 180 / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      return { ...t0, rotation: Math.round(deg * 10) / 10 };
    }
    const loc = (q: Pt): Pt => { const dx = q[0] - c0[0], dy = q[1] - c0[1]; return [dx * Math.cos(r) + dy * Math.sin(r) + t0.w / 2, -dx * Math.sin(r) + dy * Math.cos(r) + t0.h / 2]; };
    const lp = loc(dpt), ax = 1 - hit.u, ay = 1 - hit.v, A: Pt = [ax * t0.w, ay * t0.h];
    let w = hit.u === 0.5 ? t0.w : Math.max(1, hit.u > ax ? lp[0] - A[0] : A[0] - lp[0]);
    let hh = hit.v === 0.5 ? t0.h : Math.max(1, hit.v > ay ? lp[1] - A[1] : A[1] - lp[1]);
    const corner = hit.u !== 0.5 && hit.v !== 0.5;
    if (corner && !e.shiftKey) { const k = Math.max(w / t0.w, hh / t0.h); w = t0.w * k; hh = t0.h * k; }
    if (e.altKey) return { ...t0, x: c0[0] - w / 2, y: c0[1] - hh / 2, w, h: hh }; // from the center
    const left = hit.u === 0.5 ? (t0.w - w) / 2 : hit.u > ax ? A[0] : A[0] - w;
    const top = hit.v === 0.5 ? (t0.h - hh) / 2 : hit.v > ay ? A[1] : A[1] - hh;
    const cl: Pt = [left + w / 2 - t0.w / 2, top + hh / 2 - t0.h / 2];
    const nc: Pt = [c0[0] + cl[0] * Math.cos(r) - cl[1] * Math.sin(r), c0[1] + cl[0] * Math.sin(r) + cl[1] * Math.cos(r)];
    return { ...t0, x: nc[0] - w / 2, y: nc[1] - hh / 2, w, h: hh };
  }
  // ---------- Free Distort ----------
  startDistort(l: Layer | null = app.active): boolean {
    if (this.distort) return this.distort.layer === l;
    if (!l || !l.canvas || l.isGroup || l.adjustment) { toast('Select a pixel layer to distort.'); return false; }
    app.edit('Distort');
    app.rasterize(l);
    // A linked mask is warped with its layer; an unlinked one stays where it is on the document.
    const keepMask = !!l.mask && l.maskLinked === false;
    if (!keepMask) bakeMask(l);
    this.distort = { layer: l, canvas: l.canvas, mask: l.mask, keepMask, transform: { ...l.transform }, corners: layerCorners(l).map(c => [c[0], c[1]] as Pt),
      src: imageDataOf(l.canvas), maskSrc: l.mask && !keepMask ? imageDataOf(l.mask) : null };
    toast('Free Distort: drag the corners · Return applies · Esc cancels');
    app.needsRender = true;
    return true;
  }
  distortCornerAt(s: Pt): number {
    const dist = this.distort; if (!dist) return -1;
    let best = -1, bd = 10;
    dist.corners.forEach((c, i) => { const q = app.toScreen(...c), dd = Math.hypot(q[0] - s[0], q[1] - s[1]); if (dd < bd) { bd = dd; best = i; } });
    return best;
  }
  /** Warps the original pixels (and mask) into the corners; `limit` caps the longest side for the live preview. */
  private warpDistort(limit: number): { canvas: HTMLCanvasElement; mask: HTMLCanvasElement | null; transform: Transform } | null {
    const dist = this.distort!, xs = dist.corners.map(c => c[0]), ys = dist.corners.map(c => c[1]);
    const minX = Math.floor(Math.min(...xs)), minY = Math.floor(Math.min(...ys));
    const bw = Math.ceil(Math.max(...xs)) - minX, bh = Math.ceil(Math.max(...ys)) - minY;
    if (bw < 1 || bh < 1 || bw > 30000 || bh > 30000) return null;
    const f = Math.min(1, limit / Math.max(bw, bh)), dw = Math.max(1, Math.ceil(bw * f)), dh = Math.max(1, Math.ceil(bh * f));
    const local = dist.corners.flatMap(c => [(c[0] - minX) * f, (c[1] - minY) * f]);
    const toCanvas = (img: ImageData) => { const c = canvasOf(img.width, img.height); ctx2d(c).putImageData(img, 0, 0); return c; };
    const warped = distortWarp(dist.src, dw, dh, local);
    if (!warped.mode) return null;
    const mask = dist.maskSrc ? toCanvas(distortWarp(dist.maskSrc, dw, dh, local).img) : null;
    return { canvas: toCanvas(warped.img), mask, transform: { x: minX, y: minY, w: bw, h: bh, rotation: 0, flipX: false, flipY: false, sampling: dist.transform.sampling } };
  }
  previewDistort() {
    const dist = this.distort; if (!dist) return;
    const r = this.warpDistort(1024); if (!r) return;
    const l = dist.layer; l.canvas = r.canvas; l.mask = dist.keepMask ? dist.mask : r.mask; l.transform = r.transform; l.rev++;
    app.needsRender = true;
  }
  commitDistort() {
    const dist = this.distort; if (!dist) return;
    const r = this.warpDistort(8192);
    this.distort = null;
    const l = dist.layer;
    if (!r) { l.canvas = dist.canvas; l.mask = dist.mask; l.transform = dist.transform; l.rev++; app.changed('layers'); return; }
    // Hug what's actually there (DistortWarp.warpTrimmed).
    const b = alphaBounds(imageDataOf(r.canvas));
    let { canvas, mask, transform } = r;
    if (b[2] > b[0] && b[3] > b[1] && (b[0] > 0 || b[1] > 0 || b[2] < canvas.width || b[3] < canvas.height)) {
      const sx = r.transform.w / canvas.width, sy = r.transform.h / canvas.height, cw = b[2] - b[0], ch = b[3] - b[1];
      const crop = (c: HTMLCanvasElement) => { const o = canvasOf(cw, ch); ctx2d(o).drawImage(c, -b[0], -b[1]); return o; };
      canvas = crop(canvas); mask = mask ? crop(mask) : null;
      transform = { ...transform, x: transform.x + b[0] * sx, y: transform.y + b[1] * sy, w: cw * sx, h: ch * sy };
    }
    l.canvas = canvas; l.mask = dist.keepMask ? dist.mask : mask; l.transform = transform; l.rev++;
    app.changed('layers');
  }
  cancelDistort() {
    const dist = this.distort; if (!dist) return;
    this.distort = null;
    const l = dist.layer; l.canvas = dist.canvas; l.mask = dist.mask; l.transform = dist.transform; l.rev++;
    if (app.history?.undoLabel === 'Distort') app.history.undoStack.pop();
    app.changed('layers');
  }
  nudge(dx: number, dy: number) {
    const d = app.doc; if (!d) return;
    if (app.tool === 'move' || !d.selection) {
      const ids = d.selectedIds.length ? d.selectedIds : d.activeId ? [d.activeId] : [];
      if (app.history?.undoLabel !== 'Nudge') app.edit('Nudge');
      const a = app.active;
      if (a && app.maskTarget && a.mask && a.maskLinked === false) { const p = maskTransformOf(a); a.maskPlacement = { ...p, x: p.x + dx, y: p.y + dy }; a.rev++; app.emit('transform'); return; }
      for (const id of ids) { const l = getLayer(d, id); if (l) { l.transform = { ...l.transform, x: l.transform.x + dx, y: l.transform.y + dy }; } }
      app.emit('transform');
    } else { app.edit('Nudge Selection'); Sel.translateSelection(d, dx, dy); app.emit('selection'); }
  }

  // ---------- selections ----------
  finishLasso(mode: Sel.SelMode) {
    const d = app.doc!, pts = this.lasso; this.lasso = null;
    if (pts && pts.length >= 3) { app.edit('Polygonal Lasso'); Sel.combine(d, Sel.polygonSelection(d, pts, app.marqueeFeather), mode); app.emit('selection'); }
    app.needsRender = true;
  }
  /** Object Selection (ObjectSelection.swift): the object under the click. Vision finds separate instances; the web
   *  model finds salient objects, so this takes the connected part of the object mask that holds the click, looking
   *  again at the area around the click when the whole-image pass saw only background there. As in the Mac app the
   *  low-resolution mask is brought up to full size along the image's edges, thresholded, eroded or dilated by the
   *  Edge setting in whole-pixel steps, and (with Anti-alias) its traced outline is smoothed. */
  async objectClick(dpt: Pt, mode: Sel.SelMode) {
    const d = app.doc!, x = Math.floor(dpt[0]), y = Math.floor(dpt[1]);
    if (x < 0 || y < 0 || x >= d.width || y >= d.height) return;
    const src = canvasOf(d.width, d.height), sx = ctx2d(src);
    if (app.objectSel.sampleAll || !app.active?.canvas) sx.putImageData(app.renderer.readComposite(d), 0, 0);
    else { const a = app.active!, m = layerMatrix(a); sx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]); sx.drawImage(a.canvas!, 0, 0); }
    const found = await app.busyWith('Finding the object', async () => {
      let m = await objectMatte(src);
      if (m[y * d.width + x] < 0.5) {
        // Closer looks at squares around the click, half then a quarter of the canvas across.
        let hit: Float32Array | null = null;
        for (const frac of [2, 4]) {
          const side = Math.max(32, Math.round(Math.max(d.width, d.height) / frac));
          const cw = Math.min(side, d.width), ch = Math.min(side, d.height);
          const x0 = Math.round(Math.max(0, Math.min(d.width - cw, x - cw / 2))), y0 = Math.round(Math.max(0, Math.min(d.height - ch, y - ch / 2)));
          const crop = canvasOf(cw, ch); ctx2d(crop).drawImage(src, -x0, -y0);
          const local = await saliency(crop);
          if (local[(y - y0) * cw + (x - x0)] < 0.5) continue;
          hit = new Float32Array(d.width * d.height);
          for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) hit[(j + y0) * d.width + i + x0] = local[j * cw + i];
          break;
        }
        if (!hit) return null;
        m = hit;
      }
      const bin = new Uint8Array(m.length);
      for (let i = 0; i < m.length; i++) bin[i] = m[i] >= 0.5 ? 255 : 0;
      const off = Math.max(-10, Math.min(10, Math.round(app.objectSel.edgeOffset)));
      if (off) maskMorph(bin, d.width, d.height, Math.abs(off), off > 0);
      if (!bin[y * d.width + x]) return null;
      // The connected region under the click: flood-fill the thresholded mask with the original wand kernel.
      const img = new ImageData(d.width, d.height);
      for (let i = 0; i < bin.length; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = bin[i]; img.data[i * 4 + 3] = 255; }
      return wandMask(img, x, y, 0, 0, true);
    });
    if (found === undefined) return;
    if (!found) { toast('No object found there.'); return; }
    app.edit('Object Selection');
    Sel.combine(d, app.objectSel.antiAlias ? Sel.smoothedMaskSelection(d, found) : Sel.maskBytesToCanvas(d, found), mode);
    app.emit('selection');
  }
  wandClick(dpt: Pt, mode: Sel.SelMode) {
    if (app.wandMode === 'object') { void this.objectClick(dpt, mode); return; }
    const d = app.doc!;
    const x = Math.floor(dpt[0]), y = Math.floor(dpt[1]);
    if (x < 0 || y < 0 || x >= d.width || y >= d.height) return;
    let img: ImageData;
    if (app.wand.sampleAll || !app.active?.canvas) img = app.renderer.readComposite(d);
    else {
      const c = canvasOf(d.width, d.height), cx = ctx2d(c), a = app.active!, m = layerMatrix(a);
      cx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]); cx.drawImage(a.canvas!, 0, 0); img = cx.getImageData(0, 0, d.width, d.height);
    }
    const mask = wandMask(img, x, y, 0, Math.round(app.wand.tolerance), app.wand.contiguous);
    app.edit('Magic Wand');
    Sel.combine(d, Sel.maskBytesToCanvas(d, mask), mode);
    app.emit('selection');
  }

  // ---------- crop ----------
  cropDown(s: Pt, dpt: Pt) {
    const d = app.doc!;
    if (this.crop) {
      const c = this.crop, [cx, cy] = app.toScreen(c.x, c.y), z = app.project!.zoom;
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]]) {
        if (Math.hypot(cx + c.w * z * u - s[0], cy + c.h * z * v - s[1]) < 9) { this.drag = { kind: 'cropHandle', start: s, startDoc: dpt, data: { u, v, c0: { ...c } } }; return; }
      }
      if (dpt[0] >= c.x && dpt[0] <= c.x + c.w && dpt[1] >= c.y && dpt[1] <= c.y + c.h) { this.drag = { kind: 'cropMove', start: s, startDoc: dpt, data: { c0: { ...c } } }; return; }
    }
    void d;
    this.crop = { x: dpt[0], y: dpt[1], w: 0, h: 0 };
    this.drag = { kind: 'cropNew', start: s, startDoc: dpt };
  }
  ratio(): number | null {
    const r = app.crop.ratio; if (r === 'Free') return null;
    if (r === 'Original') return app.doc!.width / app.doc!.height;
    const [a, b] = r.split(':').map(Number); return a / b;
  }
  cropDrag(dr: NonNullable<CanvasController['drag']>, dpt: Pt, e: PointerEvent) {
    const ratio = this.ratio();
    if (dr.kind === 'cropNew') {
      let w = dpt[0] - dr.startDoc[0], h = dpt[1] - dr.startDoc[1];
      if (ratio) h = Math.sign(h || 1) * Math.abs(w) / ratio;
      let x0 = dr.startDoc[0], y0 = dr.startDoc[1];
      if (e.altKey) { x0 -= w; y0 -= h; w *= 2; h *= 2; }
      this.crop = { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + h), w: Math.abs(w), h: Math.abs(h) };
    } else if (dr.kind === 'cropMove') {
      const c0 = dr.data!.c0 as { x: number; y: number; w: number; h: number };
      this.crop = { ...c0, x: c0.x + dpt[0] - dr.startDoc[0], y: c0.y + dpt[1] - dr.startDoc[1] };
    } else {
      const { u, v, c0 } = dr.data! as { u: number; v: number; c0: { x: number; y: number; w: number; h: number } };
      let x0 = c0.x, y0 = c0.y, x1 = c0.x + c0.w, y1 = c0.y + c0.h;
      if (u === 0) x0 = dpt[0]; if (u === 1) x1 = dpt[0]; if (v === 0) y0 = dpt[1]; if (v === 1) y1 = dpt[1];
      if (e.altKey) { const cx = c0.x + c0.w / 2, cy = c0.y + c0.h / 2; if (u === 0) x1 = 2 * cx - x0; if (u === 1) x0 = 2 * cx - x1; if (v === 0) y1 = 2 * cy - y0; if (v === 1) y0 = 2 * cy - y1; }
      let c = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      if (ratio) { if (u === 0.5) c = { ...c, w: c.h * ratio }; else c = { ...c, h: c.w / ratio }; }
      // Snap to the canvas edges.
      const d = app.doc!, tol = 8 / app.project!.zoom;
      if (Math.abs(c.x) < tol) { c.w += c.x; c.x = 0; } if (Math.abs(c.y) < tol) { c.h += c.y; c.y = 0; }
      if (Math.abs(c.x + c.w - d.width) < tol) c.w = d.width - c.x; if (Math.abs(c.y + c.h - d.height) < tol) c.h = d.height - c.y;
      this.crop = c;
    }
    app.needsRender = true;
  }
  startCropFromSelection() {
    const d = app.doc; if (!d) return;
    const b = Sel.selectionBounds(d);
    this.crop = b ?? { x: 0, y: 0, w: d.width, h: d.height };
    app.needsRender = true;
  }
  applyCrop() { if (!this.crop) return; const c = this.crop; this.crop = null; app.cropTo(c); }
  cancelCrop() { this.crop = null; app.needsRender = true; }

  // ---------- painting ----------
  beginStroke(dpt: Pt, shift: boolean) {
    const d = app.doc!, a = app.active;
    if (!a || a.isGroup || a.adjustment && !(app.maskTarget && a.mask)) { toast('Select a pixel layer to paint on.'); return; }
    const onMask = app.maskTarget && !!a.mask;
    if (!onMask && !a.canvas) return;
    const tool = app.tool;
    if (tool === 'cloneStamp' && !this.cloneSource) { toast('Option-click to set the clone source first.'); return; }
    const label = tool === 'spotHealing' ? 'Spot Healing' : tool === 'cloneStamp' ? 'Clone Stamp' : tool === 'blur' ? (app.smearMode === 'blur' ? 'Blur' : app.smearMode === 'liquify' ? 'Liquify' : 'Smudge') : app.brush.mode === 'erase' ? 'Erase' : 'Brush';
    app.edit(label);
    const target = onMask ? app.ownMask(a) : app.ownPixels(a);
    const m = layerMatrix(a), inv = invert(m);
    const scale = Math.hypot(inv[0], inv[1]);
    const kind: Stroke['kind'] = tool === 'spotHealing' ? 'heal' : tool === 'cloneStamp' ? 'clone' : tool === 'blur' ? 'smear' : onMask ? 'mask' : app.brush.mode === 'erase' ? 'erase' : 'paint';
    const color = onMask ? app.grayCss(app.brush.mode === 'erase' ? app.bg : app.fg) : rgbCss(app.fg);
    this.stroke = { layer: a, target, orig: cloneCanvas(target), buffer: canvasOf(target.width, target.height),
      sel: Sel.selectionInLayer(d, a, target.width, target.height), inv, scale, last: null, smooth: null, kind, color, dirty: null };
    if (kind === 'smear' && app.smearMode !== 'blur') {
      // Smudge / Liquify: the Mac app's WarpStroke, running in wasm on the layer's own pixels.
      const r = imageDataOf(target);
      this.stroke.warp = new WarpSession(r, app.smearMode, Math.max(2, app.brush.size * scale), Math.min(0.98, Math.max(0, app.brush.hardness)), Math.min(1, Math.max(0.01, app.smearStrength)));
      const [lx, ly] = apply(inv, dpt[0], dpt[1]);
      this.stroke.warpLast = [lx, ly];
      if (app.smearMode === 'smudge') this.stroke.warp.pickUp(lx, ly);
      this.stroke.last = dpt; this.stroke.smooth = dpt;
      return;
    }
    if (kind === 'smear') {
      // BlurTool.blurSample: Blur paints a softened copy of the layer (or its mask), made when the stroke starts with
      // the Radius measured on the canvas, through the brush tip at the Strength; a new stroke softens further.
      const sigma = Math.min(Math.max(0.5, Math.min(50, app.blurRadius)) * scale, Math.max(target.width, target.height) / 2);
      const img = imageDataOf(target);
      if (onMask) for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
      gaussBlur(img, sigma, onMask);
      const soft = canvasOf(target.width, target.height); ctx2d(soft).putImageData(img, 0, 0);
      Object.assign(this.stroke, { kind: 'clone', source: soft, cloneOffset: [0, 0] as Pt, opacity: app.smearStrength });
    }
    if (kind === 'clone') {
      if (!this.cloneOffset || !app.clone.aligned) this.cloneOffset = [this.cloneSource![0] - dpt[0], this.cloneSource![1] - dpt[1]];
      this.stroke.cloneOffset = this.cloneOffset;
      if (app.clone.sampleAll) {
        // Sample the merged image, mapped onto this layer's grid.
        const img = app.renderer.readComposite(d), all = canvasOf(d.width, d.height); ctx2d(all).putImageData(img, 0, 0);
        const src = canvasOf(target.width, target.height), sx = ctx2d(src); sx.setTransform(inv[0], inv[1], inv[2], inv[3], inv[4], inv[5]); sx.drawImage(all, 0, 0);
        this.stroke.source = src;
      }
    }
    if (shift && this.lastStrokeEnd && kind !== 'smear') { this.stroke.last = null; this.dabLine(this.lastStrokeEnd, dpt); this.stroke.last = dpt; this.stroke.smooth = dpt; }
    else this.strokeTo(dpt, true);
  }
  strokeTo(dpt: Pt, first = false) {
    const st = this.stroke!;
    if (st.warp) { this.warpTo(dpt); return; }
    // Smoothing: the brush trails the pointer, as Compositor's smoothing slider does.
    const k = 1 - Math.min(0.95, app.brush.smoothing * 0.9);
    st.smooth = !st.smooth || first ? dpt : [st.smooth[0] + (dpt[0] - st.smooth[0]) * k, st.smooth[1] + (dpt[1] - st.smooth[1]) * k];
    const p = st.smooth;
    if (!st.last) { this.dab(p); st.last = p; }
    else this.dabLine(st.last, p);
    this.recomposite();
  }
  /** WarpStroke.append: dabs from the last point to this one, a fixed fraction of the brush apart. */
  warpTo(dpt: Pt) {
    const st = this.stroke!, w = st.warp!, from = st.warpLast!;
    const [px, py] = apply(st.inv, dpt[0], dpt[1]);
    const distance = Math.hypot(px - from[0], py - from[1]);
    const spacing = Math.max(1, w.diameter * (w.mode === 'smudge' ? 0.005 : 0.025));
    if (distance < spacing) return;
    const steps = Math.ceil(distance / spacing);
    let prev = from;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, next: Pt = [from[0] + (px - from[0]) * t, from[1] + (py - from[1]) * t];
      if (w.mode === 'smudge') w.smudge(next[0], next[1]); else w.push(prev[0], prev[1], next[0], next[1]);
      prev = next;
    }
    st.warpLast = [px, py];
    const r = w.radius + Math.ceil(w.diameter * w.strength) + 4;
    const x0 = Math.min(from[0], px) - r, y0 = Math.min(from[1], py) - r, x1 = Math.max(from[0], px) + r, y1 = Math.max(from[1], py) + r;
    const img = w.read(x0, y0, x1, y1);
    ctx2d(st.target).putImageData(img, Math.max(0, Math.floor(x0)), Math.max(0, Math.floor(y0)));
    st.layer.rev++; app.needsRender = true;
  }
  dabLine(from: Pt, to: Pt) {
    const st = this.stroke!;
    const r = app.brush.size / 2;
    const spacing = Math.max(0.5, r * (st.kind === 'smear' ? 0.25 : 0.12));
    const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (dist < spacing) return;
    const n = Math.floor(dist / spacing);
    for (let i = 1; i <= n; i++) { const t = i * spacing / dist; this.dab([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]); }
    st.last = [from[0] + (to[0] - from[0]) * n * spacing / dist, from[1] + (to[1] - from[1]) * n * spacing / dist];
    this.recomposite();
  }
  dab(p: Pt) {
    const st = this.stroke!;
    const [lx, ly] = apply(st.inv, p[0], p[1]);
    const r = Math.max(0.5, app.brush.size / 2 * st.scale), hard = app.brush.hardness;
    const grow = (x0: number, y0: number, x1: number, y1: number) => {
      const d0 = st.dirty; st.dirty = d0 ? [Math.min(d0[0], x0), Math.min(d0[1], y0), Math.max(d0[2], x1), Math.max(d0[3], y1)] : [x0, y0, x1, y1];
    };
    grow(lx - r - 2, ly - r - 2, lx + r + 2, ly + r + 2);
    if (st.kind === 'smear') { this.smearDab(lx, ly, r); return; }
    const b = ctx2d(st.buffer);
    if (st.kind === 'clone') {
      const off = st.cloneOffset!, [ox0, oy0] = apply(st.inv, p[0] + off[0], p[1] + off[1]);
      const size = Math.ceil(r * 2 + 2), tmp = canvasOf(size, size), tx = ctx2d(tmp);
      tx.drawImage(st.source ?? st.orig, -(ox0 - size / 2), -(oy0 - size / 2));
      tx.globalCompositeOperation = 'destination-in'; this.dabShape(tx, size / 2, size / 2, r, hard, 'rgba(0,0,0,1)');
      b.drawImage(tmp, lx - size / 2, ly - size / 2);
      return;
    }
    this.dabShape(b, lx, ly, r, hard, st.kind === 'heal' ? 'rgb(255,60,60)' : st.color);
  }
  dabShape(x: CanvasRenderingContext2D, cx: number, cy: number, r: number, hard: number, color: string) {
    x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2);
    if (hard >= 0.99) x.fillStyle = color;
    else {
      const g = x.createRadialGradient(cx, cy, r * hard, cx, cy, r);
      const solid = color.startsWith('rgb(') ? color.replace('rgb(', 'rgba(').replace(')', ',1)') : color;
      g.addColorStop(0, solid); g.addColorStop(1, solid.replace(/,\s*[\d.]+\)$/, ',0)'));
      x.fillStyle = g;
    }
    x.fill();
  }
  smearDab(lx: number, ly: number, r: number) {
    const st = this.stroke!, t = st.target, tx = ctx2d(t), size = Math.ceil(r * 2 + 4);
    const tmp = canvasOf(size, size), mx = ctx2d(tmp);
    const sx = lx - size / 2, sy = ly - size / 2;
    const prev = st.lastLayerPt ?? [lx, ly];
    mx.drawImage(t, -(prev[0] - size / 2), -(prev[1] - size / 2));
    st.lastLayerPt = [lx, ly];
    mx.globalCompositeOperation = 'destination-in'; this.dabShape(mx, size / 2, size / 2, r, app.brush.hardness * 0.8, 'rgba(0,0,0,1)');
    tx.save(); tx.globalAlpha = app.smearStrength;
    if (st.sel) { const clip = canvasOf(size, size), cx = ctx2d(clip); cx.drawImage(tmp, 0, 0); cx.globalCompositeOperation = 'destination-in'; cx.drawImage(st.sel, -sx, -sy); tx.drawImage(clip, sx, sy); }
    else tx.drawImage(tmp, sx, sy);
    tx.restore();
    st.layer.rev++;
  }
  recomposite() {
    const st = this.stroke!; if (!st.dirty) return;
    if (st.kind === 'smear' || st.kind === 'heal') { st.dirty = null; st.layer.rev++; app.needsRender = true; return; }
    const W = st.target.width, H = st.target.height;
    const x0 = Math.max(0, Math.floor(st.dirty[0])), y0 = Math.max(0, Math.floor(st.dirty[1])), x1 = Math.min(W, Math.ceil(st.dirty[2])), y1 = Math.min(H, Math.ceil(st.dirty[3]));
    st.dirty = null;
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0, h = y1 - y0;
    const t = ctx2d(st.target);
    t.clearRect(x0, y0, w, h); t.drawImage(st.orig, x0, y0, w, h, x0, y0, w, h);
    let src: CanvasImageSource = st.buffer, sx = x0, sy = y0;
    if (st.sel) { const tmp = canvasOf(w, h), tc = ctx2d(tmp); tc.drawImage(st.buffer, -x0, -y0); tc.globalCompositeOperation = 'destination-in'; tc.drawImage(st.sel, -x0, -y0); src = tmp; sx = 0; sy = 0; }
    t.save(); t.globalAlpha = st.opacity ?? app.brush.opacity;
    t.globalCompositeOperation = st.kind === 'erase' ? 'destination-out' : 'source-over';
    t.drawImage(src, sx, sy, w, h, x0, y0, w, h);
    t.restore();
    st.layer.rev++;
    app.needsRender = true;
  }
  endStroke() {
    const st = this.stroke!; this.stroke = null;
    if (st.warp) {
      st.warp.dispose();
      if (st.sel) {
        // Only what's inside the selection moves, as the Mac app's raster edit is clipped to it.
        const moved = cloneCanvas(st.target), mx = ctx2d(moved);
        mx.globalCompositeOperation = 'destination-in'; mx.drawImage(st.sel, 0, 0);
        const t = ctx2d(st.target); t.save(); t.globalCompositeOperation = 'copy'; t.drawImage(st.orig, 0, 0); t.restore();
        const inv = cloneCanvas(st.sel), ix = ctx2d(inv); ix.globalCompositeOperation = 'source-out'; ix.fillRect(0, 0, inv.width, inv.height);
        t.save(); t.globalCompositeOperation = 'destination-in'; t.drawImage(inv, 0, 0); t.restore();
        t.drawImage(moved, 0, 0);
      }
    }
    this.lastStrokeEnd = st.smooth;
    if (st.kind === 'heal') {
      const img = imageDataOf(st.target), bd = ctx2d(st.buffer).getImageData(0, 0, st.buffer.width, st.buffer.height).data;
      const cov = new Uint8Array(st.buffer.width * st.buffer.height);
      if (st.sel) { const sd = ctx2d(st.sel).getImageData(0, 0, st.sel.width, st.sel.height).data; for (let i = 0; i < cov.length; i++) cov[i] = bd[i * 4 + 3] * sd[i * 4 + 3] / 255; }
      else for (let i = 0; i < cov.length; i++) cov[i] = bd[i * 4 + 3];
      if (!spotHeal(img, cov, 1, 0, (Math.random() * 2 ** 32) >>> 0)) toast('Out of memory while healing.', 'error');
      ctx2d(st.target).putImageData(img, 0, 0);
    }
    if (st.kind !== 'mask') app.rasterize(st.layer);
    st.layer.rev++;
    app.changed('pixels');
  }

  // ---------- gradient ----------
  paintGradient(data: Record<string, unknown>) {
    const line = this.gradientLine!, l = data.layer as Layer, target = data.target as HTMLCanvasElement, orig = data.orig as HTMLCanvasElement, sel = data.sel as HTMLCanvasElement | null;
    const inv = invert(layerMatrix(l));
    const [x0, y0] = apply(inv, ...line[0]), [x1, y1] = apply(inv, ...line[1]);
    const onMask = app.maskTarget && !!l.mask;
    const c0 = onMask ? app.grayCss(app.fg) : rgbCss(app.fg), c1 = app.gradient.toTransparent ? rgbCss(app.fg, 0) : onMask ? app.grayCss(app.bg) : rgbCss(app.bg);
    const g = canvasOf(target.width, target.height), gx = ctx2d(g);
    const grad = app.gradient.kind === 'radial' ? gx.createRadialGradient(x0, y0, 0, x0, y0, Math.hypot(x1 - x0, y1 - y0)) : gx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, c0); grad.addColorStop(1, c1);
    gx.fillStyle = grad; gx.fillRect(0, 0, g.width, g.height);
    if (sel) { gx.globalCompositeOperation = 'destination-in'; gx.drawImage(sel, 0, 0); }
    const t = ctx2d(target);
    t.save(); t.globalCompositeOperation = 'copy'; t.drawImage(orig, 0, 0); t.restore();
    t.save(); t.globalAlpha = app.gradient.opacity; t.drawImage(g, 0, 0); t.restore();
    l.rev++; app.needsRender = true;
  }

  // ---------- shapes ----------
  finishShape() {
    const r = this.shapeRect; this.shapeRect = null;
    const d = app.doc!; if (!r) return;
    const k = app.shape.kind;
    let x = Math.min(r.a[0], r.b[0]), y = Math.min(r.a[1], r.b[1]), w = Math.abs(r.b[0] - r.a[0]), h = Math.abs(r.b[1] - r.a[1]);
    if ((k !== 'Line' && (w < 2 || h < 2)) || (k === 'Line' && Math.hypot(w, h) < 2)) { app.needsRender = true; return; }
    const style = { kind: k, red: app.fg.red, green: app.fg.green, blue: app.fg.blue, cornerRadius: app.shape.cornerRadius } as Layer['shape'] & object;
    if (k === 'Line') {
      const pad = app.shape.lineWidth; x -= pad; y -= pad; w += pad * 2; h += pad * 2;
      style.lineWidth = app.shape.lineWidth;
      style.start = { x: (r.a[0] - x) / w, y: (r.a[1] - y) / h }; style.end = { x: (r.b[0] - x) / w, y: (r.b[1] - y) / h };
    }
    app.edit(`Draw ${k}`);
    const canvas = renderShape(style, Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    const l = newPixelLayer(d, app.layerName(k), canvas, { x: Math.round(x), y: Math.round(y), w: canvas.width, h: canvas.height });
    l.shape = style;
    app.insertAboveActive(l); app.maskTarget = false;
    app.changed('layers');
  }

  // ---------- type ----------
  typeClick(dpt: Pt) {
    const d = app.doc!;
    const hit = [...d.layers].reverse().find(l => l.text && isEffectivelyVisible(d, l) && layerContains(l, ...dpt));
    if (hit) { app.setActive(hit.id); this.openTextEditor(hit, dpt); return; }
    this.openTextEditor(null, dpt);
  }
  openTextEditor(layer: Layer | null, dpt: Pt, selection?: [number, number]) {
    this.commitText();
    const p = app.project!;
    const style: NonNullable<Layer['text']> = structuredClone(layer?.text ?? { content: '', fontName: app.type.fontName, fontSize: app.type.fontSize, red: app.fg.red, green: app.fg.green, blue: app.fg.blue,
      alignment: app.type.alignment, tracking: app.type.tracking, leading: app.type.leading });
    const ta = document.createElement('textarea');
    ta.className = 'text-editor'; ta.value = style.content; ta.spellcheck = false;
    const scale = layer?.canvas ? layer.transform.w / layer.canvas.width : 1;
    const origin: Pt = layer ? [layer.transform.x, layer.transform.y] : [dpt[0] - TEXT_PADDING, dpt[1] - style.fontSize * 0.6 - TEXT_PADDING];
    const [sx, sy] = app.toScreen(origin[0] + TEXT_PADDING * scale, origin[1] + TEXT_PADDING * scale);
    const fs = style.fontSize * p.zoom * scale;
    Object.assign(ta.style, { left: `${sx}px`, top: `${sy}px`, fontSize: `${fs}px`, lineHeight: `${(style.leading || style.fontSize * 1.2) * p.zoom * scale}px`,
      color: rgbCss(style), textAlign: style.alignment.toLowerCase(), fontFamily: `"${style.fontName}", Helvetica, Arial, sans-serif`,
      letterSpacing: `${style.tracking * p.zoom * scale}px`, minWidth: `${Math.max(40, fs * 2)}px` });
    // Editing a text layer: the layer itself shows the letters live (with their color and font runs) under a
    // see-through editor that only draws the caret and selection.
    const original = layer ? { text: layer.text, canvas: layer.canvas, transform: { ...layer.transform } } : null;
    if (layer) { ta.style.color = 'transparent'; ta.style.caretColor = rgbCss(style); ta.classList.add('live'); }
    const autosize = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 4}px`; ta.style.width = 'auto'; ta.style.width = `${Math.max(ta.scrollWidth + 8, fs * 2)}px`; };
    const ctx = { layer, style, origin, scale, original };
    const live = () => { if (layer && ctx.style.content) this.showLiveText(layer, ctx.style, scale); };
    ta.addEventListener('input', () => { ctx.style = retargetRuns(ctx.style, ta.value); live(); autosize(); });
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.commitText(); }
      if (e.key === 'Escape') { e.preventDefault(); this.commitText(true); }
    });
    (ta as unknown as { _ctx: unknown })._ctx = ctx;
    this.stage.append(ta); this.textEditor = ta;
    requestAnimationFrame(() => { ta.focus(); autosize(); if (selection) ta.setSelectionRange(selection[0], selection[1]); });
  }
  private showLiveText(l: Layer, t: NonNullable<Layer['text']>, scale: number) {
    l.text = t; l.canvas = renderText(t);
    l.transform = { ...l.transform, w: l.canvas.width * scale, h: l.canvas.height * scale }; l.rev++; app.needsRender = true;
  }
  /** The Type options while text is being edited: color and font go to the selected letters (runs), the rest to all of it. */
  applyTextStyle(patch: Partial<NonNullable<Layer['text']>>): boolean {
    const ta = this.textEditor; if (!ta) return false;
    const ctx = (ta as unknown as { _ctx: { layer: Layer | null; style: NonNullable<Layer['text']>; scale: number } })._ctx;
    const sel: [number, number] = [ta.selectionStart, ta.selectionEnd];
    if (!ctx.layer) {
      // New text becomes a layer first, then takes the style like any other.
      this.commitText();
      const l = app.active; if (!l?.text) return true;
      this.openTextEditor(l, [l.transform.x, l.transform.y], sel);
      return this.applyTextStyle(patch);
    }
    const t = structuredClone(ctx.style);
    const { red, green, blue, fontName, ...rest } = patch;
    if (red !== undefined && green !== undefined && blue !== undefined) setTextColor(t, { red, green, blue }, sel[0], sel[1]);
    if (fontName) setTextFont(t, fontName, sel[0], sel[1]);
    Object.assign(t, rest);
    ctx.style = t;
    this.showLiveText(ctx.layer, t, ctx.scale);
    if (Object.keys(rest).length) { const l = ctx.layer; this.commitText(); this.openTextEditor(l, [l.transform.x, l.transform.y], sel); }
    else requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(sel[0], sel[1]); });
    return true;
  }
  commitText(cancel = false) {
    const ta = this.textEditor; if (!ta) return;
    this.textEditor = null;
    const { layer, style, origin, scale, original } = (ta as unknown as { _ctx: { layer: Layer | null; style: NonNullable<Layer['text']>; origin: Pt; scale: number;
      original: { text: Layer['text']; canvas: HTMLCanvasElement | null; transform: Transform } | null } })._ctx;
    ta.remove();
    if (layer && original) { layer.text = original.text; layer.canvas = original.canvas; layer.transform = original.transform; layer.rev++; }
    const content = ta.value;
    if (cancel || (!layer && !content.trim())) { app.needsRender = true; app.emit('layers'); return; }
    const d = app.doc!;
    const text = { ...style, content };
    if (layer) {
      if (!content.trim()) { app.setActive(layer.id); app.deleteLayers(); return; }
      if (JSON.stringify(text) !== JSON.stringify(original?.text)) app.updateText(layer, text); else { app.needsRender = true; app.emit('layers'); }
    } else {
      app.edit('Type');
      const canvas = renderText(text);
      const l = newPixelLayer(d, content.split('\n')[0].slice(0, 40) || 'Text', canvas, { x: Math.round(origin[0]), y: Math.round(origin[1]), w: canvas.width * scale, h: canvas.height * scale });
      l.text = text;
      app.insertAboveActive(l); app.maskTarget = false;
      app.changed('layers');
    }
  }

  // ---------- eyedropper ----------
  sample(dpt: Pt, toBackground: boolean) {
    const d = app.doc!;
    if (dpt[0] < 0 || dpt[1] < 0 || dpt[0] >= d.width || dpt[1] >= d.height) return;
    const [r, g, b, a] = app.renderer.readPixel(d, dpt[0], dpt[1]);
    if (!a) return;
    const c: RGB = { red: r / 255, green: g / 255, blue: b / 255 };
    if (toBackground) app.bg = c; else app.fg = c;
    app.emit('colors');
  }
  cancel() {
    if (this.distort) { this.cancelDistort(); return true; }
    if (this.textEditor) { this.commitText(true); return true; }
    if (this.lasso) { this.lasso = null; app.needsRender = true; return true; }
    if (this.crop) { this.cancelCrop(); return true; }
    return false;
  }
  commit() {
    if (this.distort) { this.commitDistort(); return true; }
    if (this.crop) { this.applyCrop(); return true; }
    if (this.lasso && app.lassoKind === 'polygonal') { this.finishLasso('replace'); return true; }
    return false;
  }
}

function layerUnit(l: Layer): Mat { return mulUnit(l); }
function mulUnit(l: Layer): Mat {
  const t = l.transform, r = t.rotation * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
  return [cos * t.w, sin * t.w, -sin * t.h, cos * t.h, cx - (cos * t.w - sin * t.h) / 2, cy - (sin * t.w + cos * t.h) / 2];
}
function alphaAt(l: Layer, dpt: Pt): number {
  if (!l.canvas) return 0;
  const [x, y] = apply(invert(layerMatrix(l)), dpt[0], dpt[1]);
  if (x < 0 || y < 0 || x >= l.canvas.width || y >= l.canvas.height) return 0;
  return ctx2d(l.canvas).getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3];
}
function isInside(d: { layers: Layer[] }, l: Layer, groupId: string): boolean {
  let p = l.parentId;
  while (p) { if (p === groupId) return true; p = d.layers.find(x => x.id === p)?.parentId ?? null; }
  return false;
}
