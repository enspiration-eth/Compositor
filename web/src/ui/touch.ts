// Touch and stylus support for phones and tablets: on-screen modifier keys (the Shift / Option / ⌘ behaviours the
// tools rely on), long-press, and the device helpers the layout and canvas use. The canvas gestures themselves
// (pinch, two- and three-finger taps, palm rejection) live in CanvasController.
import { h } from './dom';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
/** Latched on-screen modifiers, applied to canvas and layer-list pointer events. */
export const touchMods = { shift: false, alt: false, meta: false };
let onModsChange: (() => void) | null = null;
export const anyTouchMod = () => touchMods.shift || touchMods.alt || touchMods.meta;
/** The event with the on-screen modifiers folded into shiftKey / altKey / metaKey (ctrlKey too off the Mac). */
export function withMods<T extends MouseEvent>(e: T): T {
  if (!anyTouchMod()) return e;
  return new Proxy(e, {
    get(t, k) {
      if (k === 'shiftKey') return t.shiftKey || touchMods.shift;
      if (k === 'altKey') return t.altKey || touchMods.alt;
      if (k === 'metaKey') return t.metaKey || (touchMods.meta && isMac);
      if (k === 'ctrlKey') return t.ctrlKey || (touchMods.meta && !isMac);
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}
/** Is this a device whose main pointer is a finger (phones, tablets)? */
export const coarsePointer = () => matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1 && !matchMedia('(pointer: fine)').matches;

/** The floating ⇧ ⌥ ⌘ keys over the canvas on touch devices. Tap to latch, tap again to release. */
export function modifierBar(): HTMLElement {
  const keys: [keyof typeof touchMods, string, string][] = [['shift', '⇧', 'Shift: constrain, add to selection'], ['alt', '⌥', 'Option: subtract, duplicate, sample'], ['meta', isMac ? '⌘' : 'Ctrl', isMac ? 'Command' : 'Control']];
  const bar = h('div', { class: 'mod-bar', id: 'mod-bar' });
  const render = () => bar.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.classList.toggle('on', touchMods[b.dataset.key as keyof typeof touchMods]));
  for (const [key, label, title] of keys) {
    const b = h('button', { class: 'mod-key', 'data-key': key, title, 'aria-pressed': 'false' }, label) as HTMLButtonElement;
    b.addEventListener('pointerdown', e => e.stopPropagation());
    b.addEventListener('click', e => { e.stopPropagation(); touchMods[key] = !touchMods[key]; b.setAttribute('aria-pressed', String(touchMods[key])); render(); onModsChange?.(); });
    bar.append(b);
  }
  onModsChange = render;
  return bar;
}
export function clearTouchMods() { touchMods.shift = touchMods.alt = touchMods.meta = false; onModsChange?.(); }

/** Drops the click that a lifted finger is about to produce, wherever it lands (a menu just opened under it). */
export function swallowNextClick(ms = 350) {
  const stop = (e: Event) => { e.stopPropagation(); e.preventDefault(); done(); };
  const done = () => { document.removeEventListener('click', stop, true); clearTimeout(t); };
  document.addEventListener('click', stop, true);
  const t = window.setTimeout(done, ms);
}
/** After a long-press: the click from lifting that finger (wherever it lands, e.g. on the menu that just opened under it) is dropped. */
export function swallowClickOnLift(pointerId: number) {
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    document.removeEventListener('pointerup', up, true); document.removeEventListener('pointercancel', up, true);
    swallowNextClick();
  };
  document.addEventListener('pointerup', up, true); document.addEventListener('pointercancel', up, true);
}
/** Long-press (touch or pen held still ~0.5 s) calls `cb`; a context-menu event from the browser does too, once. */
export function longPress(el: HTMLElement, cb: (x: number, y: number, target: HTMLElement) => void, ms = 500) {
  let timer = 0, sx = 0, sy = 0, fired = false;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    fired = false; sx = e.clientX; sy = e.clientY; cancel();
    const target = e.target as HTMLElement;
    timer = window.setTimeout(() => { timer = 0; navigator.vibrate?.(10); cb(sx, sy, target); fired = true; swallowClickOnLift(e.pointerId); }, ms);
  });
  el.addEventListener('pointermove', e => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave'] as const) el.addEventListener(t, cancel);
  // Android fires contextmenu on long-press as well: let the timer's menu be the only one.
  el.addEventListener('contextmenu', e => { if (fired) { e.preventDefault(); e.stopPropagation(); } }, true);
}
