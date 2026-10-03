// Phones and tablets: the body classes the responsive layout keys off (styles.css), on-screen Shift/Option/Command
// toggles, long press as the context-menu (and tooltip) gesture outside the canvas, and the Layers drawer.
import { h, icon } from './dom';
import { toast } from './dom';
import { app } from './app';
import { blocksTouchPan } from './fields';

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
export function setLayersOpen(open: boolean) {
  if (open && !document.body.classList.contains('layers-open') && layersSheet) layersSheet.reset();
  document.body.classList.toggle('layers-open', open);
}
let layersSheet: { reset: () => void } | null = null;

// ---------- draggable bottom sheet (phones) ----------
// Like an iOS sheet: drag the grab handle or the header and the sheet follows the finger between detents (peek, half,
// full); a flick up expands, a flick down shrinks or, from the peek (or dragged well below it), dismisses; it snaps
// with a little spring; a tap on the handle cycles the detents. The content keeps scrolling inside whatever height it
// has, so nothing is ever cut off.
export type Detent = 'peek' | 'half' | 'full';
export function makeSheetDraggable(sheet: HTMLElement, grabAreas: HTMLElement[], opts: { dismiss: () => void; active: () => boolean; detents?: Detent[]; initial?: Detent }) {
  const detents = opts.detents ?? ['peek', 'half', 'full'];
  const vvh = () => window.visualViewport?.height ?? innerHeight;
  const heightOf = (d: Detent) => {
    const top = parseFloat(getComputedStyle(document.body).getPropertyValue('--sat') || '0') || 0;
    return d === 'peek' ? Math.min(170, vvh() * 0.3) : d === 'half' ? Math.min(vvh() * 0.64, 560) : vvh() - Math.max(44, top + 12);
  };
  let detent: Detent = opts.initial ?? 'half';
  const apply = (animate: boolean) => {
    sheet.classList.toggle('sheet-anim', animate);
    sheet.style.setProperty('--sheet-h', `${Math.round(heightOf(detent))}px`);
    sheet.style.removeProperty('--sheet-drag');
    sheet.dataset.detent = detent;
  };
  const reset = () => { detent = opts.initial ?? 'half'; apply(false); };
  reset();
  window.addEventListener('resize', () => apply(false));
  const handle = grabAreas[0];
  const attach = (area: HTMLElement) => {
    area.style.touchAction = 'none';
    area.addEventListener('pointerdown', e => {
      if (!opts.active() || e.button !== 0) return;
      if (area !== handle && (e.target as HTMLElement).closest('button, input, select, [contenteditable], .cs-button')) return;
      const id = e.pointerId, y0 = e.clientY, h0 = heightOf(detent);
      const samples: [number, number][] = [[e.timeStamp, e.clientY]];
      let moved = false;
      try { area.setPointerCapture(id); } catch { /* gone */ }
      sheet.classList.remove('sheet-anim');
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        const dy = ev.clientY - y0;
        if (!moved && Math.abs(dy) < 6) return;
        if (!moved) sheet.classList.add('sheet-dragging');
        moved = true;
        samples.push([ev.timeStamp, ev.clientY]); if (samples.length > 6) samples.shift();
        let hgt = h0 - dy;
        const max = heightOf('full');
        if (hgt > max) hgt = max + (hgt - max) * 0.25; // rubber band past the top
        const min = heightOf(detents[0]);
        if (hgt < min) { sheet.style.setProperty('--sheet-h', `${Math.round(min)}px`); sheet.style.setProperty('--sheet-drag', `${Math.round(min - hgt)}px`); }
        else { sheet.style.setProperty('--sheet-h', `${Math.round(hgt)}px`); sheet.style.removeProperty('--sheet-drag'); }
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        area.removeEventListener('pointermove', move); area.removeEventListener('pointerup', up); area.removeEventListener('pointercancel', up);
        sheet.classList.remove('sheet-dragging');
        if (!moved) {
          if (area === handle && ev.type === 'pointerup') { detent = detents[(detents.indexOf(detent) + 1) % detents.length]; apply(true); }
          return;
        }
        const [t0, yA] = samples[0], v = (ev.clientY - yA) / Math.max(1, ev.timeStamp - t0); // px/ms, down is positive
        const hNow = h0 - (ev.clientY - y0);
        const order = detents.map(d => [d, heightOf(d)] as const);
        const lowest = order[0][1];
        if (hNow < lowest * 0.55 || (v > 0.9 && detent === detents[0]) || (v > 1.6 && hNow < heightOf('half'))) { apply(true); opts.dismiss(); return; }
        if (Math.abs(v) > 0.5) {
          // A flick goes one detent in its direction from where the finger let go.
          const above = order.filter(([, hh]) => hh > hNow + 1), below = order.filter(([, hh]) => hh < hNow - 1);
          const pick = v < 0 ? above[0] ?? order[order.length - 1] : below[below.length - 1] ?? order[0];
          detent = pick[0];
        } else detent = order.reduce((a, b) => Math.abs(b[1] - hNow) < Math.abs(a[1] - hNow) ? b : a)[0];
        apply(true);
      };
      area.addEventListener('pointermove', move); area.addEventListener('pointerup', up); area.addEventListener('pointercancel', up);
    });
  };
  grabAreas.forEach(attach);
  handle.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); detent = detents[(detents.indexOf(detent) + 1) % detents.length]; apply(true); }
    else if (e.key === 'Escape') opts.dismiss();
  });
  return { reset, attach, get detent() { return detent; }, set: (d: Detent) => { detent = d; apply(true); } };
}
/** The Layers panel as a draggable sheet on phones. */
export function installLayersSheet(panel: HTMLElement) {
  const grab = h('button', { class: 'sheet-handle', type: 'button', 'aria-label': 'Resize the Layers sheet (tap to cycle sizes)', id: 'layers-sheet-handle' });
  panel.prepend(grab);
  const sheet = makeSheetDraggable(panel, [grab], { dismiss: () => setLayersOpen(false), active: () => document.body.classList.contains('phone') });
  // The header is a grab area too (the panel is re-rendered, so it's picked up whenever a new one appears).
  const pick = () => { if (grab.parentElement !== panel || panel.firstElementChild !== grab) panel.prepend(grab); const hd = panel.querySelector<HTMLElement>('.layers-head'); if (hd && !hd.dataset.grab) { hd.dataset.grab = '1'; sheet.attach(hd); } };
  pick(); new MutationObserver(pick).observe(panel, { childList: true, subtree: true });
  layersSheet = sheet;
}
export function toggleLayers() { setLayersOpen(!document.body.classList.contains('layers-open')); }

// ---------- tool options bar ----------
// On narrow screens the options of a tool rarely fit one row. The row scrolls sideways, and a chevron at its end
// (shown only when something is cut off) expands it into wrapped rows; the choice sticks across tools.
export function toolOptionsWrap(header: HTMLElement): HTMLElement {
  const btn = h('button', { class: 'tool-options-toggle', id: 'tool-options-toggle', type: 'button', 'aria-label': 'Show all tool options', 'aria-expanded': 'false', title: 'All tool options' }, icon('chevronDown', 18)) as HTMLButtonElement;
  const sync = () => {
    const open = document.body.classList.contains('tool-options-open');
    btn.hidden = !document.body.classList.contains('compact') || (!open && header.scrollWidth <= header.clientWidth + 2);
    btn.setAttribute('aria-expanded', String(open)); btn.setAttribute('aria-label', open ? 'Show fewer tool options' : 'Show all tool options');
    fades();
  };
  // Edge fades where the row continues: left once scrolled, right while more is cut off.
  const fades = () => {
    const over = !document.body.classList.contains('tool-options-open') && header.scrollWidth > header.clientWidth + 2;
    header.classList.toggle('fade-l', over && header.scrollLeft > 2);
    header.classList.toggle('fade-r', over && header.scrollLeft + header.clientWidth < header.scrollWidth - 2);
  };
  header.addEventListener('scroll', fades, { passive: true });
  header.addEventListener('touchmove', e => { if (blocksTouchPan() && e.cancelable) e.preventDefault(); }, { passive: false });
  btn.addEventListener('click', () => { document.body.classList.toggle('tool-options-open'); sync(); });
  new ResizeObserver(sync).observe(header);
  new MutationObserver(() => requestAnimationFrame(sync)).observe(header, { childList: true, subtree: true });
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  return h('div', { class: 'tool-header-wrap' }, header, btn);
}

// ---------- keep the fitted canvas above bottom sheets ----------
function watchSheets() {
  let raf = 0;
  const update = () => {
    raf = 0;
    const stage = document.getElementById('stage'); if (!stage) return;
    const sr = stage.getBoundingClientRect();
    let inset = 0;
    if (document.body.classList.contains('compact')) {
      const sheets = [...document.querySelectorAll<HTMLElement>('.floating-panel')];
      if (document.body.classList.contains('layers-open') && document.body.classList.contains('phone')) sheets.push(document.querySelector('.layers-panel') as HTMLElement);
      for (const el of sheets) {
        const r = el.getBoundingClientRect();
        // Only sheets along the bottom that span the width (landscape side panels don't count).
        if (r.width >= sr.width * 0.8 && r.top > sr.top && r.top < sr.bottom) inset = Math.max(inset, sr.bottom - r.top);
      }
    }
    inset = Math.round(inset);
    if (inset === app.viewInsetBottom) return;
    app.viewInsetBottom = inset;
    if (app.project?.fitted) app.fit();
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => requestAnimationFrame(update)); };
  new MutationObserver(schedule).observe(document.body, { childList: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', schedule);
  document.addEventListener('transitionend', schedule);
}

export function setupMobile() {
  watchSheets();
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
