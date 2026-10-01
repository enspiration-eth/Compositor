import { Renderer } from '../engine/render';
// The canvas and its tools: the web counterpart of Rendering/EditorCanvas.swift, BrushStroke.swift, CloneStamp.swift,
// BlurTool.swift, Gradient.swift, ShapeTool.swift, TypeTool.swift, Crop.swift and the selection tools. The GPU draws
// the document (engine/render.ts); a 2D overlay above it draws marching ants, transform handles, crop and cursors.
import { app, type Tool } from './app';
import { type Layer, type Mat, type Transform, layerMatrix, invert, apply, cloneCanvas, rgbCss, layerContains, layerCorners, renderShape,
  isEffectivelyVisible, newPixelLayer, renderText, TEXT_PADDING, getLayer } from '../engine/document';
import { canvasOf, ctx2d, imageDataOf, type RGB } from '../engine/adjustments';
import * as Sel from '../engine/selection';
import { wandMask, spotHeal } from '../engine/kernels';
import { toast } from './dom';

type Pt = [number, number];
interface Stroke {
  layer: Layer; target: HTMLCanvasElement; orig: HTMLCanvasElement; buffer: HTMLCanvasElement; sel: HTMLCanvasElement | null;
  inv: Mat; scale: number; last: Pt | null; smooth: Pt | null; kind: 'paint' | 'erase' | 'mask' | 'heal' | 'clone' | 'smear';
  color: string; cloneOffset?: Pt; dirty: [number, number, number, number] | null; lastLayerPt?: Pt;
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
  antsPhase = 0;

  constructor(stage: HTMLElement) {
    this.stage = stage;
    this.gl = document.createElement('canvas'); this.gl.className = 'gl-canvas';
    this.overlay = document.createElement('canvas'); this.overlay.className = 'overlay-canvas';
    stage.append(this.gl, this.overlay);
    app.renderer = new Renderer(this.gl);
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
    app.renderer.present(p.doc, p.zoom, p.ox, p.oy, this.dpr);
    this.drawOverlay();
  }
  drawOverlay() {
    const x = this.octx, p = app.project!, d = p.doc;
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, this.overlay.width, this.overlay.height);
    x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const S = (a: number, b: number) => app.toScreen(a, b);
    // canvas border
    const [bx, by] = S(0, 0); x.strokeStyle = 'rgba(0,0,0,0.6)'; x.lineWidth = 1; x.strokeRect(Math.round(bx) - 0.5, Math.round(by) - 0.5, d.width * p.zoom + 1, d.height * p.zoom + 1);
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
    if (app.tool === 'move' && a && !a.isGroup && !a.adjustment && isEffectivelyVisible(d, a)) {
      const cs = layerCorners(a).map(([u, v]) => S(u, v));
      x.save(); x.strokeStyle = '#4c8dff'; x.lineWidth = 1; x.beginPath(); cs.forEach((c, i) => i ? x.lineTo(...c) : x.moveTo(...c)); x.closePath(); x.stroke();
      for (const hp of this.handles(a)) { x.fillStyle = '#fff'; x.strokeStyle = '#4c8dff'; x.beginPath(); if (hp.kind === 'rotate') x.arc(hp.s[0], hp.s[1], 5, 0, Math.PI * 2); else x.rect(hp.s[0] - 4, hp.s[1] - 4, 8, 8); x.fill(); x.stroke(); }
      const top = this.handles(a).find(h0 => h0.kind === 'rotate');
      const mid = S(...apply(layerUnit(a), 0.5, 0));
      if (top) { x.beginPath(); x.moveTo(...mid); x.lineTo(...top.s); x.stroke(); }
      x.restore();
    }
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

  // ---------- pointer ----------
  down(e: PointerEvent) {
    if (this.textEditor && e.target !== this.textEditor) { this.commitText(); }
    const p = app.project; if (!p) return;
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    this.stage.setPointerCapture(e.pointerId);
    const s = this.local(e), dpt = app.toDoc(...s);
    this.pointer = s;
    if (e.button === 1 || this.spaceDown || app.tool === 'hand') { this.drag = { kind: 'pan', start: s, startDoc: dpt, data: { ox: p.ox, oy: p.oy } }; return; }
    if (e.button !== 0) return;
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
    const p = app.project; const s = this.local(e); this.pointer = s; app.needsRender = true;
    if (!p) return;
    const dpt = app.toDoc(...s), dr = this.drag;
    this.updateCursor(s);
    if (this.stroke && e.buttons & 1) {
      const events = (e.getCoalescedEvents?.() ?? [e]);
      for (const ev of events) this.strokeTo(app.toDoc(...this.local(ev)));
      return;
    }
    if (!dr) return;
    switch (dr.kind) {
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
    const p = app.project; const dr = this.drag; this.drag = null;
    if (this.stroke) { this.endStroke(); return; }
    if (!p || !dr) return;
    const d = p.doc;
    switch (dr.kind) {
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
      case 'move': if (dr.data!.moved) app.emit('transform'); else app.history?.undoStack.pop(); return;
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
    if (this.spaceDown || t === 'hand') c = this.drag?.kind === 'pan' ? 'grabbing' : 'grab';
    else if (t === 'zoom') c = 'zoom-in';
    else if (['brush', 'spotHealing', 'cloneStamp', 'blur'].includes(t)) c = 'none';
    else if (['marquee', 'lasso', 'wand', 'crop', 'gradient', 'shape', 'eyedropper'].includes(t)) c = 'crosshair';
    else if (t === 'type') c = 'text';
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
    let a = app.active;
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
    const hit = data.hit as ReturnType<CanvasController['handles']>[number] | null;
    const layers = data.layers as Layer[], starts = data.starts as Transform[];
    if (!hit) {
      let dx = dpt[0] - dr.startDoc[0], dy = dpt[1] - dr.startDoc[1];
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      // Snap the primary layer's edges and center to the canvas edges and center (Compositor's Snap To document bounds).
      const d = app.doc!, st = starts[layers.indexOf(data.layer as Layer)] ?? starts[0];
      const tol = 6 / app.project!.zoom;
      const snap = (pos: number, size: number, total: number) => {
        for (const [edge, target] of [[pos, 0], [pos + size, total], [pos + size / 2, total / 2], [pos, total / 2], [pos + size, total / 2]] as [number, number][])
          if (Math.abs(edge - target) < tol) return target - edge;
        return 0;
      };
      if (st && st.rotation % 360 === 0) { dx += snap(st.x + dx, st.w, d.width); dy += snap(st.y + dy, st.h, d.height); }
      layers.forEach((l, i) => { l.transform = { ...starts[i], x: Math.round(starts[i].x + dx), y: Math.round(starts[i].y + dy) }; });
    } else {
      const l = data.layer as Layer, t0 = starts[layers.indexOf(l)] ?? (l.transform);
      const c0: Pt = [t0.x + t0.w / 2, t0.y + t0.h / 2], r = t0.rotation * Math.PI / 180;
      if (hit.kind === 'rotate') {
        const a0 = Math.atan2(dr.startDoc[1] - c0[1], dr.startDoc[0] - c0[0]), a1 = Math.atan2(dpt[1] - c0[1], dpt[0] - c0[0]);
        let deg = t0.rotation + (a1 - a0) * 180 / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        l.transform = { ...t0, rotation: Math.round(deg * 10) / 10 };
      } else {
        const loc = (q: Pt): Pt => { const dx = q[0] - c0[0], dy = q[1] - c0[1]; return [dx * Math.cos(r) + dy * Math.sin(r) + t0.w / 2, -dx * Math.sin(r) + dy * Math.cos(r) + t0.h / 2]; };
        const lp = loc(dpt), ax = 1 - hit.u, ay = 1 - hit.v, A: Pt = [ax * t0.w, ay * t0.h];
        let w = hit.u === 0.5 ? t0.w : Math.max(1, hit.u > ax ? lp[0] - A[0] : A[0] - lp[0]);
        let hh = hit.v === 0.5 ? t0.h : Math.max(1, hit.v > ay ? lp[1] - A[1] : A[1] - lp[1]);
        const corner = hit.u !== 0.5 && hit.v !== 0.5;
        if (corner && !e.shiftKey) { const k = Math.max(w / t0.w, hh / t0.h); w = t0.w * k; hh = t0.h * k; }
        if (e.altKey) { // from the center
          const nl = (t0.w - w) / 2, nt = (t0.h - hh) / 2; void nl; void nt;
          l.transform = { ...t0, x: c0[0] - w / 2, y: c0[1] - hh / 2, w, h: hh };
        } else {
          const left = hit.u === 0.5 ? (t0.w - w) / 2 : hit.u > ax ? A[0] : A[0] - w;
          const top = hit.v === 0.5 ? (t0.h - hh) / 2 : hit.v > ay ? A[1] : A[1] - hh;
          const cl: Pt = [left + w / 2 - t0.w / 2, top + hh / 2 - t0.h / 2];
          const nc: Pt = [c0[0] + cl[0] * Math.cos(r) - cl[1] * Math.sin(r), c0[1] + cl[0] * Math.sin(r) + cl[1] * Math.cos(r)];
          l.transform = { ...t0, x: nc[0] - w / 2, y: nc[1] - hh / 2, w, h: hh };
        }
      }
    }
    app.needsRender = true; app.emit('transform-live');
  }
  nudge(dx: number, dy: number) {
    const d = app.doc; if (!d) return;
    if (app.tool === 'move' || !d.selection) {
      const ids = d.selectedIds.length ? d.selectedIds : d.activeId ? [d.activeId] : [];
      if (app.history?.undoLabel !== 'Nudge') app.edit('Nudge');
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
  wandClick(dpt: Pt, mode: Sel.SelMode) {
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
    const label = tool === 'spotHealing' ? 'Spot Healing' : tool === 'cloneStamp' ? 'Clone Stamp' : tool === 'blur' ? (app.smearMode === 'blur' ? 'Blur' : 'Smudge') : app.brush.mode === 'erase' ? 'Erase' : 'Brush';
    app.edit(label);
    const target = onMask ? app.ownMask(a) : app.ownPixels(a);
    const m = layerMatrix(a), inv = invert(m);
    const scale = Math.hypot(inv[0], inv[1]);
    const kind: Stroke['kind'] = tool === 'spotHealing' ? 'heal' : tool === 'cloneStamp' ? 'clone' : tool === 'blur' ? 'smear' : onMask ? 'mask' : app.brush.mode === 'erase' ? 'erase' : 'paint';
    const color = onMask ? app.grayCss(app.brush.mode === 'erase' ? app.bg : app.fg) : rgbCss(app.fg);
    this.stroke = { layer: a, target, orig: cloneCanvas(target), buffer: canvasOf(target.width, target.height),
      sel: Sel.selectionInLayer(d, a, target.width, target.height), inv, scale, last: null, smooth: null, kind, color, dirty: null };
    if (kind === 'clone') {
      if (!this.cloneOffset || !app.clone.aligned) this.cloneOffset = [this.cloneSource![0] - dpt[0], this.cloneSource![1] - dpt[1]];
      this.stroke.cloneOffset = this.cloneOffset;
      if (app.clone.sampleAll) {
        // Sample the merged image, mapped onto this layer's grid.
        const img = app.renderer.readComposite(d), all = canvasOf(d.width, d.height); ctx2d(all).putImageData(img, 0, 0);
        const src = canvasOf(target.width, target.height), sx = ctx2d(src); sx.setTransform(inv[0], inv[1], inv[2], inv[3], inv[4], inv[5]); sx.drawImage(all, 0, 0);
        this.stroke.orig = src;
      }
    }
    if (shift && this.lastStrokeEnd && kind !== 'smear') { this.stroke.last = null; this.dabLine(this.lastStrokeEnd, dpt); this.stroke.last = dpt; this.stroke.smooth = dpt; }
    else this.strokeTo(dpt, true);
  }
  strokeTo(dpt: Pt, first = false) {
    const st = this.stroke!;
    // Smoothing: the brush trails the pointer, as Compositor's smoothing slider does.
    const k = 1 - Math.min(0.95, app.brush.smoothing * 0.9);
    st.smooth = !st.smooth || first ? dpt : [st.smooth[0] + (dpt[0] - st.smooth[0]) * k, st.smooth[1] + (dpt[1] - st.smooth[1]) * k];
    const p = st.smooth;
    if (!st.last) { this.dab(p); st.last = p; }
    else this.dabLine(st.last, p);
    this.recomposite();
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
      tx.drawImage(st.orig, -(ox0 - size / 2), -(oy0 - size / 2));
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
    if (app.smearMode === 'blur') {
      mx.filter = `blur(${Math.max(0.6, r / 5)}px)`; mx.drawImage(t, -sx, -sy); mx.filter = 'none';
    } else {
      const prev = st.lastLayerPt ?? [lx, ly];
      mx.drawImage(t, -(prev[0] - size / 2), -(prev[1] - size / 2));
    }
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
    t.save(); t.globalAlpha = app.brush.opacity;
    t.globalCompositeOperation = st.kind === 'erase' ? 'destination-out' : 'source-over';
    t.drawImage(src, sx, sy, w, h, x0, y0, w, h);
    t.restore();
    st.layer.rev++;
    app.needsRender = true;
  }
  endStroke() {
    const st = this.stroke!; this.stroke = null;
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
  openTextEditor(layer: Layer | null, dpt: Pt) {
    this.commitText();
    const p = app.project!;
    const style = layer?.text ?? { content: '', fontName: app.type.fontName, fontSize: app.type.fontSize, red: app.fg.red, green: app.fg.green, blue: app.fg.blue,
      alignment: app.type.alignment, tracking: app.type.tracking, leading: app.type.leading };
    const ta = document.createElement('textarea');
    ta.className = 'text-editor'; ta.value = style.content; ta.spellcheck = false;
    const scale = layer?.canvas ? layer.transform.w / layer.canvas.width : 1;
    const origin: Pt = layer ? [layer.transform.x, layer.transform.y] : [dpt[0] - TEXT_PADDING, dpt[1] - style.fontSize * 0.6 - TEXT_PADDING];
    const [sx, sy] = app.toScreen(origin[0] + TEXT_PADDING * scale, origin[1] + TEXT_PADDING * scale);
    const fs = style.fontSize * p.zoom * scale;
    Object.assign(ta.style, { left: `${sx}px`, top: `${sy}px`, fontSize: `${fs}px`, lineHeight: `${(style.leading || style.fontSize * 1.2) * p.zoom * scale}px`,
      color: rgbCss(style), textAlign: style.alignment.toLowerCase(), fontFamily: `"${style.fontName}", Helvetica, Arial, sans-serif`,
      letterSpacing: `${style.tracking * p.zoom * scale}px`, minWidth: `${Math.max(40, fs * 2)}px` });
    if (layer) layer.visible = false, app.needsRender = true;
    const autosize = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 4}px`; ta.style.width = 'auto'; ta.style.width = `${Math.max(ta.scrollWidth + 8, fs * 2)}px`; };
    ta.addEventListener('input', autosize);
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.commitText(); }
      if (e.key === 'Escape') { e.preventDefault(); this.commitText(true); }
    });
    (ta as unknown as { _ctx: unknown })._ctx = { layer, style, origin, scale };
    this.stage.append(ta); this.textEditor = ta;
    requestAnimationFrame(() => { ta.focus(); autosize(); });
  }
  commitText(cancel = false) {
    const ta = this.textEditor; if (!ta) return;
    this.textEditor = null;
    const { layer, style, origin, scale } = (ta as unknown as { _ctx: { layer: Layer | null; style: NonNullable<Layer['text']>; origin: Pt; scale: number } })._ctx;
    ta.remove();
    if (layer) layer.visible = true;
    const content = ta.value;
    if (cancel || (!layer && !content.trim())) { app.needsRender = true; app.emit('layers'); return; }
    const d = app.doc!;
    const text = { ...style, content };
    if (layer) {
      if (!content.trim()) { app.setActive(layer.id); app.deleteLayers(); return; }
      app.updateText(layer, text);
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
    if (this.textEditor) { this.commitText(true); return true; }
    if (this.lasso) { this.lasso = null; app.needsRender = true; return true; }
    if (this.crop) { this.cancelCrop(); return true; }
    return false;
  }
  commit() {
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
