// Phones and tablets: the body classes the responsive layout keys off (styles.css), on-screen Shift/Option/Command
// toggles, long press as the context-menu (and tooltip) gesture outside the canvas, and the Layers drawer.
import { h } from './dom';
import { toast } from './dom';

const COMPACT = '(max-width: 820px), (max-height: 500px)';
const PHONE = '(max-width: 600px) and (orientation: portrait)';
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** True on touch screens (phones, tablets, touch laptops): bigger hit targets, the modifier bar, drill-down menus. */
export const isTouch = () => matchMedia('(any-pointer: coarse)').matches || navigator.maxTouchPoints > 0;
export const isCompact = () => matchMedia(COMPACT).matches;
export const isPhonePortrait = () => matchMedia(PHONE).matches;

function syncBodyClasses() {
  const b = document.body.classList;
  b.toggle('touch', isTouch());
  b.toggle('compact', isCompact());
  b.toggle('phone', isPhonePortrait());
  if (!isCompact()) b.remove('layers-open');
  // The visual viewport shrinks under the on-screen keyboard; --vvh lets sheets stay above it.
  document.documentElement.style.setProperty('--vvh', `${Math.round(window.visualViewport?.height ?? window.innerHeight)}px`);
}

// ---------- on-screen modifier keys ----------
/** Latched modifiers from the on-screen bar: while one is on, every pointer event and click reports it held. */
export const mods = { shift: false, alt: false, meta: false };
const MOD_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'dblclick', 'contextmenu', 'mousedown', 'mousemove', 'mouseup'];
function installModifierOverrides() {
  for (const type of MOD_EVENTS) window.addEventListener(type, e => {
    if (!mods.shift && !mods.alt && !mods.meta) return;
    if ((e.target as Element | null)?.closest?.('.mod-bar')) return;
    // Own properties shadow the event's read-only getters, so the tools see the keys as held.
    if (mods.shift) Object.defineProperty(e, 'shiftKey', { value: true });
    if (mods.alt) Object.defineProperty(e, 'altKey', { value: true });
    if (mods.meta) { Object.defineProperty(e, 'metaKey', { value: true }); Object.defineProperty(e, 'ctrlKey', { value: true }); }
  }, { capture: true });
}
export function modifierBar(): HTMLElement {
  const keys: [keyof typeof mods, string, string][] = [
    ['shift', '⇧', 'Shift: add to a selection, constrain proportions and angles, straight brush lines'],
    ['alt', isMac ? '⌥' : 'Alt', 'Option: subtract from a selection, draw from the center, sample a clone source, duplicate while moving'],
    ['meta', isMac ? '⌘' : 'Ctrl', 'Command: pick a layer by tapping it with Move, add layers to the selection'],
  ];
  const bar = h('div', { class: 'mod-bar', id: 'mod-bar', role: 'toolbar', 'aria-label': 'Modifier keys' });
  for (const [k, label, title] of keys) {
    const b = h('button', { class: 'mod-btn', 'data-mod': k, title, 'aria-pressed': 'false', 'aria-label': title.split(':')[0] }, label);
    b.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      mods[k] = !mods[k];
      b.classList.toggle('on', mods[k]); b.setAttribute('aria-pressed', String(mods[k]));
    });
    bar.append(b);
  }
  return bar;
}

// ---------- long press outside the canvas ----------
// iOS Safari never fires contextmenu for touch, and Android does only on some elements. A still, held finger
// dispatches one (the layer rows' menu, for instance); where nothing handles it, the element's tooltip shows instead,
// the tap alternative to hovering for a title.
function installLongPress() {
  let timer = 0, start: { x: number; y: number; target: Element; id: number } | null = null, firedAt = 0, swallowClickUntil = 0;
  const cancel = () => { if (timer) clearTimeout(timer); timer = 0; start = null; };
  document.addEventListener('pointerdown', e => {
    cancel(); swallowClickUntil = 0; // a new touch: the menu that opened answers it
    if (e.pointerType === 'mouse' || !(e.target instanceof Element)) return;
    if (e.target.closest('#stage, input, textarea, select, .mod-bar')) return;
    start = { x: e.clientX, y: e.clientY, target: e.target, id: e.pointerId };
    timer = window.setTimeout(() => {
      const s = start; timer = 0; start = null; if (!s || !s.target.isConnected) return;
      firedAt = performance.now(); swallowClickUntil = firedAt + 800;
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: s.x, clientY: s.y, button: 2 });
      (ev as MouseEvent & { synthetic?: boolean }).synthetic = true;
      s.target.dispatchEvent(ev);
      if (!ev.defaultPrevented) {
        const tip = s.target.closest('[title]')?.getAttribute('title');
        if (tip) toast(tip); else swallowClickUntil = 0;
      }
      navigator.vibrate?.(10);
    }, 500);
  }, { capture: true });
  document.addEventListener('pointermove', e => { if (start && e.pointerId === start.id && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); }, { capture: true });
  document.addEventListener('pointerup', cancel, { capture: true });
  document.addEventListener('pointercancel', cancel, { capture: true });
  document.addEventListener('contextmenu', e => {
    if ((e as MouseEvent & { synthetic?: boolean }).synthetic) return;
    // The browser's own long-press menu event came first: let it through (and eat the click of the lifting finger).
    if (timer) { cancel(); firedAt = performance.now(); swallowClickUntil = firedAt + 800; return; }
    if (performance.now() - firedAt < 1500) { e.preventDefault(); e.stopImmediatePropagation(); } // Ours already fired.
  }, { capture: true });
  // The finger lifting after a long press would also click whatever is under it.
  document.addEventListener('click', e => {
    if (performance.now() < swallowClickUntil) { e.preventDefault(); e.stopPropagation(); }
    swallowClickUntil = 0;
  }, { capture: true });
}

// ---------- Layers drawer ----------
export function setLayersOpen(open: boolean) { document.body.classList.toggle('layers-open', open); }
export function toggleLayers() { setLayersOpen(!document.body.classList.contains('layers-open')); }

export function setupMobile() {
  syncBodyClasses();
  for (const q of [COMPACT, PHONE, '(any-pointer: coarse)']) matchMedia(q).addEventListener('change', syncBodyClasses);
  window.addEventListener('resize', syncBodyClasses);
  window.visualViewport?.addEventListener('resize', syncBodyClasses);
  installModifierOverrides();
  installLongPress();
  // No page zoom from a pinch outside the canvas either (iOS ignores user-scalable=no), nor from double taps.
  for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, e => e.preventDefault());
  document.addEventListener('touchmove', e => { if (e.touches.length > 1 && e.cancelable) e.preventDefault(); }, { passive: false });
  const backdrop = h('div', { class: 'sheet-backdrop', id: 'sheet-backdrop' });
  backdrop.addEventListener('click', () => setLayersOpen(false));
  document.body.append(backdrop);
}
