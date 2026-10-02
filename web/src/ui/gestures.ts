// Touch and pen input for the canvas, on Pointer Events. The mouse goes straight to the CanvasController as before.
//  · One finger uses the current tool. Its pointerdown is held back for a moment (or until it moves), so that a second
//    finger landing just after turns the touch into a pinch instead of a stray dab.
//  · Two fingers pinch to zoom and drag to pan; a second finger arriving mid-stroke cancels the stroke.
//  · A quick two-finger tap undoes, a three-finger tap redoes.
//  · A long press (one finger held still) opens the canvas context menu.
//  · A double tap is the double-click (close a polygonal lasso, apply a crop, fit with the Hand, 100% with Zoom).
//  · A pen draws with pressure. Once a pen has been seen, fingers only pan and zoom (Procreate-style), and touches
//    while the pen is on the glass, right after it lifts, or with a palm-sized contact are ignored (palm rejection).
import { app } from './app';
import type { CanvasController } from './tools';
import { toast } from './dom';

type Pt = [number, number];
interface TouchPt { id: number; x: number; y: number; x0: number; y0: number }
const TAP_SLOP = 10, HOLD_MS = 500, FLUSH_MS = 120, DOUBLE_TAP_MS = 320, TAP_MS = 350, PALM_AREA = 40 * 40, PEN_GRACE_MS = 400;

/** The kind of the last pointer that touched the canvas: 'mouse', 'touch' or 'pen'. */
export let lastPointerType = 'mouse';
export const pen = { seen: false, down: false, lastUp: 0 };

export interface GestureHooks { contextMenu: (clientX: number, clientY: number) => void }

export function installCanvasGestures(ctl: CanvasController, stage: HTMLElement, hooks: GestureHooks) {
  const touches = new Map<number, TouchPt>();
  let pending: { e: PointerEvent; timer: number } | null = null;
  let toolId: number | null = null;
  let hold = 0;
  const ignored = new Set<number>();
  let gesture: { d0: number; m0: Pt; z0: number; ox0: number; oy0: number; t0: number; moved: number; fingers: number; n: number } | null = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  let swallowClickUntil = 0;
  document.addEventListener('click', e => {
    if (performance.now() < swallowClickUntil) { e.preventDefault(); e.stopPropagation(); }
    swallowClickUntil = 0;
  }, { capture: true });
  // A new touch anywhere ends the window, so the menu's rows answer the next tap.
  document.addEventListener('pointerdown', () => { if (swallowClickUntil && !touches.size) swallowClickUntil = 0; }, { capture: true });

  const clearHold = () => { if (hold) clearTimeout(hold); hold = 0; };
  const flush = () => {
    if (!pending) return;
    const e = pending.e; clearTimeout(pending.timer); pending = null;
    toolId = e.pointerId; ctl.down(e);
  };
  const dropPending = () => { if (pending) { clearTimeout(pending.timer); pending = null; } };
  const pts = () => [...touches.values()];
  const centroid = (list: TouchPt[]): Pt => ctl.local({ clientX: list.reduce((a, t) => a + t.x, 0) / list.length, clientY: list.reduce((a, t) => a + t.y, 0) / list.length });
  const spread = (list: TouchPt[]) => list.length < 2 ? 0 : Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y);
  /** (Re)starts the pinch/pan from the fingers down now, keeping the gesture's tap bookkeeping. */
  const baseline = () => {
    const p = app.project, list = pts();
    const prev = gesture;
    gesture = { d0: spread(list), m0: centroid(list), z0: p?.zoom ?? 1, ox0: p?.ox ?? 0, oy0: p?.oy ?? 0,
      t0: prev?.t0 ?? performance.now(), moved: prev?.moved ?? 0, fingers: Math.max(prev?.fingers ?? 0, list.length), n: list.length };
  };
  const applyGesture = () => {
    const g = gesture!, p = app.project, list = pts();
    if (list.length !== g.n) baseline();
    if (!p || !list.length) return;
    const m = centroid(list), d = spread(list);
    const z = list.length >= 2 && g.d0 > 0 ? Math.min(64, Math.max(0.01, g.z0 * d / g.d0)) : g.z0;
    const dx = (g.m0[0] - g.ox0) / g.z0, dy = (g.m0[1] - g.oy0) / g.z0;
    p.zoom = z; p.ox = m[0] - dx * z; p.oy = m[1] - dy * z; p.fitted = false;
    g.moved = Math.max(g.moved, Math.hypot(m[0] - g.m0[0], m[1] - g.m0[1]), Math.abs(d - g.d0));
    app.emit('view');
  };
  const startGesture = () => {
    clearHold(); dropPending();
    if (toolId !== null) { ctl.abortInteraction(); toolId = null; }
    baseline();
  };
  const longPress = (id: number) => {
    hold = 0;
    const t = touches.get(id);
    if (!t || touches.size !== 1 || gesture || Math.hypot(t.x - t.x0, t.y - t.y0) > TAP_SLOP) return;
    dropPending();
    if (toolId !== null) { ctl.abortInteraction(); toolId = null; }
    ignored.add(id);
    navigator.vibrate?.(10);
    // The finger lifting would click whatever opened under it (the menu's first row).
    swallowClickUntil = performance.now() + 1000;
    hooks.contextMenu(t.x, t.y);
  };
  const isPalm = (e: PointerEvent) => pen.down || performance.now() - pen.lastUp < PEN_GRACE_MS || (pen.seen && e.width * e.height > PALM_AREA);

  stage.addEventListener('pointerdown', e => {
    lastPointerType = e.pointerType;
    if (e.pointerType === 'mouse') { ctl.down(e); return; }
    if (e.pointerType === 'pen') {
      if (!pen.seen) {
        pen.seen = true; document.body.classList.add('pen-mode');
        toast('Pen detected: draw with the pen; pan and zoom with your fingers.');
      }
      pen.down = true;
      // A palm that landed just before the pen: drop whatever it started.
      if (touches.size) { dropPending(); clearHold(); if (toolId !== null) { ctl.abortInteraction(); toolId = null; } gesture = null; for (const id of touches.keys()) ignored.add(id); }
      ctl.down(e); return;
    }
    e.preventDefault();
    if (isPalm(e)) { ignored.add(e.pointerId); return; }
    touches.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    if (touches.size === 1 && !gesture) {
      if (pen.seen) { baseline(); return; } // With a pen around, a finger pans.
      pending = { e, timer: window.setTimeout(flush, FLUSH_MS) };
      const id = e.pointerId; hold = window.setTimeout(() => longPress(id), HOLD_MS);
    } else startGesture();
  });
  stage.addEventListener('pointermove', e => {
    if (e.pointerType !== 'touch') { ctl.move(e); return; }
    const t = touches.get(e.pointerId); if (!t) return;
    t.x = e.clientX; t.y = e.clientY;
    if (gesture) { applyGesture(); return; }
    if (ignored.has(e.pointerId)) return;
    const moved = Math.hypot(t.x - t.x0, t.y - t.y0);
    if (moved > TAP_SLOP) clearHold();
    if (pending && pending.e.pointerId === e.pointerId && moved > 6) flush();
    if (toolId === e.pointerId) ctl.move(e);
  });
  const end = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') {
      if (e.pointerType === 'pen') { pen.down = false; pen.lastUp = performance.now(); }
      ctl.up(e); return;
    }
    const wasIgnored = ignored.delete(e.pointerId);
    if (!touches.has(e.pointerId)) return;
    touches.delete(e.pointerId); clearHold();
    if (gesture) {
      if (touches.size) { baseline(); return; }
      const g = gesture; gesture = null;
      if (e.type === 'pointerup' && performance.now() - g.t0 < TAP_MS && g.moved < TAP_SLOP) {
        if (g.fingers === 2) { const label = app.history?.undoLabel; app.undo(); if (label) toast(`Undo ${label.replace(/[0-9A-F-]{36}$/, '')}`); }
        else if (g.fingers === 3) { const label = app.history?.redoLabel; app.redo(); if (label) toast(`Redo ${label.replace(/[0-9A-F-]{36}$/, '')}`); }
      }
      return;
    }
    if (wasIgnored) return;
    if (pending && pending.e.pointerId === e.pointerId) {
      if (e.type === 'pointercancel') { dropPending(); return; }
      // A tap: the tool gets its down and up together.
      flush(); ctl.up(e); toolId = null;
      const now = performance.now();
      if (now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) { lastTap.t = 0; ctl.dblclick(e); }
      else lastTap = { t: now, x: e.clientX, y: e.clientY };
      return;
    }
    if (toolId === e.pointerId) { ctl.up(e); toolId = null; }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  // iOS Safari's own pinch (page zoom) and the long-press callout.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) stage.addEventListener(type, ev => ev.preventDefault());
  stage.addEventListener('touchstart', ev => { if (ev.touches.length > 1 && ev.cancelable) ev.preventDefault(); }, { passive: false });
  return { get active() { return touches.size > 0; } };
}
