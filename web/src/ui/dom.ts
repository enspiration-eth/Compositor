// Small DOM helpers and the controls the Mac app builds with SwiftUI: sliders whose label scrubs the value
// (UI/NumericScrub.swift), pop-up menus, color wells, and floating panels (UI/FloatingPanel.swift).
type Attrs = Record<string, unknown> & { class?: string; style?: string };
import { colorSwatchButton } from './colorpicker';
import { menuShortcutLabel } from './shortcuts';
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
export function svg(path: string, size = 18, extra = ''): SVGSVGElement {
  const d = document.createElement('div');
  d.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${path}</svg>`;
  return d.firstElementChild as SVGSVGElement;
}
export const ICONS: Record<string, string> = {
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  move: '<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>',
  marquee: '<rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3 2.4"/>',
  marqueeEllipse: '<ellipse cx="12" cy="12" rx="8.5" ry="7.5" stroke-dasharray="3 2.4"/>',
  lasso: '<path d="M7 17c-3-1.5-4-4-3-6.5C5.5 6 10 4 14.5 4.5S21 8 20 11.5 14 17 10 16.5"/><path d="M7 17c-.5 1.5.5 3 2 3.5M10 16.5c-1.5-.5-3 0-3 .5"/>',
  polyLasso: '<path d="M4 15l3-10 8 2 5 7-8 3z"/><path d="M12 17l-2 4"/>',
  wand: '<path d="M4 20L15 9M14 4v3M19 9h-3M17.5 5.5l-2 2M18 3l.5 1.5M21 6l-1.5.5"/>',
  object: '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2.4"/><circle cx="12" cy="12" r="3.5"/>',
  crop: '<path d="M6 2v14a2 2 0 002 2h14M2 6h14a2 2 0 012 2v14"/>',
  brush: '<path d="M18.5 3.5l2 2L11 15l-2-2z"/><path d="M9 13c-2 0-3.5 1.5-3.5 3.5 0 1.5-1 2.5-2.5 3 3 1 7.5.5 8-3.5"/>',
  spotHealing: '<rect x="3" y="8" width="18" height="8" rx="4" transform="rotate(-45 12 12)"/><path d="M10.5 10.5h.01M13.5 13.5h.01M10.5 13.5h.01M13.5 10.5h.01"/>',
  cloneStamp: '<path d="M9 3h6l-1 7h-4z"/><path d="M5 13h14v3H5zM7 16v3h10v-3"/>',
  blur: '<path d="M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z"/>',
  gradient: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 14h16" /><path d="M4 17h16M4 11h16" stroke-opacity=".5"/>',
  shape: '<rect x="3" y="3" width="11" height="11" rx="1.5"/><circle cx="15.5" cy="15.5" r="5.5"/>',
  type: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  eyedropper: '<path d="M15 4l5 5-2 2-5-5zM13 6L4 15v5h5l9-9"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 013 0V11M11 10V4a1.5 1.5 0 013 0v6M14 10V5.5a1.5 1.5 0 013 0V13M17 9.5a1.5 1.5 0 013 0V14c0 4-3 7-7 7h-1c-3 0-4.5-1.5-6-4l-2.5-4a1.5 1.5 0 012.5-1.5L8 13"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  zoomIn: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M10.5 7.5v6M7.5 10.5h6"/>',
  zoomOut: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M7.5 10.5h6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4M6.6 6.6A17 17 0 002 12s3.5 7 10 7a10 10 0 005.4-1.6"/>',
  newLayer: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  folderPlus: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M12 10v6M9 13h6"/>',
  mask: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="4"/>',
  sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  adjust: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 000 18z" fill="currentColor"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  clip: '<path d="M7 7v6a5 5 0 0010 0V6a3 3 0 00-6 0v7a1 1 0 002 0V7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  swap: '<path d="M7 4l-3 3 3 3M4 7h11a3 3 0 013 3v1M17 20l3-3-3-3M20 17H9a3 3 0 01-3-3v-1"/>',
};
export function icon(name: string, size = 18) { return svg(ICONS[name] ?? '', size); }

export interface SliderOpts { label: string; min: number; max: number; step?: number; value: number; unit?: string; onInput: (v: number) => void; onCommit?: (v: number) => void; width?: number; id?: string }
/** A labeled slider with a number field; dragging the label scrubs the value as in Photoshop. */
export function slider(o: SliderOpts): HTMLElement {
  const step = o.step ?? 1;
  const decimals = step < 1 ? Math.min(3, Math.max(1, -Math.floor(Math.log10(step)))) : 0;
  const fmt = (v: number) => (decimals ? v.toFixed(decimals) : String(Math.round(v)));
  const range = h('input', { type: 'range', min: o.min, max: o.max, step, value: o.value, class: 'slider-range' }) as HTMLInputElement;
  const num = h('input', { type: 'number', min: o.min, max: o.max, step, value: fmt(o.value), class: 'slider-num', id: o.id }) as HTMLInputElement;
  const set = (v: number, commit = false) => {
    v = Math.min(o.max, Math.max(o.min, Math.round(v / step) * step));
    range.value = String(v); num.value = fmt(v); o.onInput(v); if (commit) o.onCommit?.(v);
  };
  range.addEventListener('input', () => set(+range.value));
  range.addEventListener('change', () => set(+range.value, true));
  num.addEventListener('change', () => set(+num.value, true));
  num.addEventListener('keydown', e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); });
  const label = h('label', { class: 'slider-label scrub', title: 'Drag to scrub' }, o.label);
  label.addEventListener('pointerdown', e => {
    const x0 = e.clientX, v0 = +range.value, span = o.max - o.min;
    label.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => set(v0 + (ev.clientX - x0) * span / 300 * (ev.shiftKey ? 0.1 : 1));
    const up = () => { label.removeEventListener('pointermove', move); label.removeEventListener('pointerup', up); o.onCommit?.(+range.value); };
    label.addEventListener('pointermove', move); label.addEventListener('pointerup', up);
  });
  return h('div', { class: 'slider-row', style: o.width ? `width:${o.width}px` : '' }, label, range, h('span', { class: 'slider-val' }, num, o.unit ? h('span', { class: 'unit' }, o.unit) : null));
}
export function select<T extends string | number>(options: (T | { label: string; value: T } | null)[], value: T, onChange: (v: T) => void, attrs: Attrs = {}): HTMLSelectElement {
  const s = h('select', { class: 'popup', ...attrs }) as HTMLSelectElement;
  let group: HTMLElement = s;
  for (const o of options) {
    if (o === null) { const sep = h('option', { disabled: true }, '──────────'); s.append(sep); group = s; continue; }
    const val = typeof o === 'object' ? o.value : o, label = typeof o === 'object' ? o.label : String(o);
    group.append(h('option', { value: String(val), selected: val === value }, label));
  }
  s.addEventListener('change', () => { const raw = s.value; onChange((typeof value === 'number' ? Number(raw) : raw) as T); });
  s.addEventListener('keydown', e => e.stopPropagation());
  return s;
}
export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void, id?: string): HTMLElement {
  const c = h('input', { type: 'checkbox', checked, id }) as HTMLInputElement;
  c.addEventListener('change', () => onChange(c.checked));
  return h('label', { class: 'check' }, c, label);
}
export const toHex = (c: { red: number; green: number; blue: number }) =>
  '#' + [c.red, c.green, c.blue].map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
export const fromHex = (hex: string) => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
export function colorWell(value: { red: number; green: number; blue: number }, onChange: (c: { red: number; green: number; blue: number }) => void, label?: string): HTMLElement {
  // The app's own picker (ColorPickerSheet), not the browser's: it previews live, samples the canvas, and Cancel restores.
  const i = colorSwatchButton(value, onChange, { title: label ? `${label} Color` : 'Color' });
  return label ? h('div', { class: 'well-row' }, h('span', {}, label), i) : i;
}
export function button(label: string | Node, onClick: () => void, attrs: Attrs = {}): HTMLButtonElement {
  const b = h('button', { class: 'btn', ...attrs }, label) as HTMLButtonElement;
  b.addEventListener('click', e => { e.preventDefault(); onClick(); });
  return b;
}

// ---------- floating panels (non-modal, draggable, like the Mac app's FloatingPanelController) ----------
export interface Panel { el: HTMLElement; body: HTMLElement; close: () => void; /** Centers (or right-aligns) it for its current size; a no-op once the user has dragged it. */ place: () => void }
let panelZ = 100;
export function floatingPanel(title: string, onClose: () => void, opts: { width?: number; right?: boolean; id?: string } = {}): Panel {
  const body = h('div', { class: 'panel-body' });
  const closeBtn = h('button', { class: 'panel-close', title: 'Close' }, icon('close', 12));
  const head = h('div', { class: 'panel-title' }, closeBtn, h('span', {}, title));
  const el = h('div', { class: 'floating-panel', id: opts.id, style: `width:${opts.width ?? 340}px; z-index:${++panelZ}` }, head, body);
  document.body.append(el);
  let dragged = false;
  // Placed right away for its current size, and once more on the next frame after its content is in, unless the user
  // has moved it by then. (Only the deferred placement used to run, so on a slow machine the panel could still jump
  // into place after a click aimed at it had been measured.)
  const place = () => {
    if (dragged || !el.isConnected) return;
    const r = el.getBoundingClientRect();
    if (opts.right) { el.style.left = `${window.innerWidth - r.width - 270}px`; el.style.top = '130px'; }
    else { el.style.left = `${Math.max(70, (window.innerWidth - r.width) / 2 - 120)}px`; el.style.top = `${Math.max(90, (window.innerHeight - r.height) / 2 - 60)}px`; }
  };
  place(); requestAnimationFrame(place);
  head.addEventListener('pointerdown', e => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragged = true;
    const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => { el.style.left = `${ev.clientX - dx}px`; el.style.top = `${Math.max(0, ev.clientY - dy)}px`; };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
    head.addEventListener('pointermove', move); head.addEventListener('pointerup', up);
  });
  el.addEventListener('pointerdown', () => { el.style.zIndex = String(++panelZ); });
  let closed = false;
  const close = () => { if (closed) return; closed = true; el.remove(); };
  closeBtn.addEventListener('click', () => { onClose(); close(); });
  return { el, body, close, place };
}
export function modal(title: string, content: HTMLElement, buttons: { label: string; primary?: boolean; onClick: () => boolean | void }[], id?: string): () => void {
  const back = h('div', { class: 'modal-back' });
  const close = () => { back.remove(); document.removeEventListener('keydown', onEscape, true); };
  const row = h('div', { class: 'modal-buttons' }, ...buttons.map(b => button(b.label, () => { if (b.onClick() !== false) close(); }, { class: b.primary ? 'btn primary' : 'btn' })));
  back.append(h('div', { class: 'modal', id }, h('h2', {}, title), content, row));
  back.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) { const p = buttons.find(b => b.primary); if (p && p.onClick() !== false) close(); }
  });
  // Escape cancels from anywhere in the sheet (selects and fields stop their own keys), except a shortcut being recorded.
  const onEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !back.isConnected || back !== [...document.querySelectorAll('.modal-back')].pop() || (e.target as HTMLElement).closest('.shortcut-recorder.recording, #color-picker')) return;
    e.preventDefault(); e.stopPropagation(); buttons.find(b => b.label === 'Cancel')?.onClick(); close();
  };
  document.addEventListener('keydown', onEscape, true);
  document.body.append(back);
  requestAnimationFrame(() => (back.querySelector('input, select, button.primary') as HTMLElement | null)?.focus());
  return close;
}
export function toast(message: string, kind: 'info' | 'error' = 'info') {
  const t = h('div', { class: `toast ${kind}` }, message);
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 5000 : 2600);
}
/** Menus open submenus in place on touch screens and narrow windows (see the mobile layout in styles.css). */
export function drillDownMenus() { return document.body.classList.contains('touch') || document.body.classList.contains('compact'); }
export interface MenuItem { label?: string; shortcut?: string; action?: () => void; disabled?: boolean; checked?: boolean; submenu?: MenuItem[]; separator?: boolean; id?: string }
let openMenu: HTMLElement | null = null;
export function closeMenus() { openMenu?.remove(); openMenu = null; document.querySelectorAll('.menubar .open').forEach(e => e.classList.remove('open')); }
export function showMenu(items: MenuItem[], x: number, y: number, nested = false): HTMLElement {
  if (!nested) closeMenus();
  const m = h('div', { class: 'menu', style: `left:${x}px; top:${y}px` });
  for (const it of items) {
    if (it.separator) { m.append(h('div', { class: 'menu-sep' })); continue; }
    const row = h('div', { class: `menu-item${it.disabled ? ' disabled' : ''}${it.submenu ? ' has-sub' : ''}`, 'data-id': it.id ?? it.label },
      h('span', { class: 'menu-check' }, it.checked ? '✓' : ''), h('span', { class: 'menu-label' }, it.label ?? ''),
      h('span', { class: 'menu-shortcut' }, it.submenu ? '▸' : menuShortcutLabel(it.shortcut ?? '')));
    if (it.submenu && drillDownMenus()) {
      // Touch and narrow screens: a submenu replaces its menu in place (with a Back row) instead of flying out to the
      // side, where it would leave the screen and need hover to reach.
      row.addEventListener('click', e => {
        e.stopPropagation(); if (it.disabled) return;
        const parent = { items, x, y };
        const back: MenuItem = { label: `‹ ${it.label ?? 'Back'}`, id: 'menu-back', action: () => { showMenu(parent.items, parent.x, parent.y); } };
        showMenu([back, { separator: true }, ...it.submenu!], x, y);
      });
    } else if (it.submenu) {
      let sub: HTMLElement | null = null;
      row.addEventListener('mouseenter', () => {
        m.querySelectorAll(':scope > .menu').forEach(s => s.remove());
        const r = row.getBoundingClientRect();
        sub = showMenu(it.submenu!, r.width - 4, r.top - m.getBoundingClientRect().top - 5, true);
        m.append(sub); sub.style.position = 'absolute';
      });
    } else {
      row.addEventListener('mouseenter', () => m.querySelectorAll(':scope > .menu').forEach(s => s.remove()));
      row.addEventListener('click', e => { e.stopPropagation(); if (it.disabled) return; closeMenus(); it.action?.(); });
    }
    m.append(row);
  }
  if (!nested) {
    if (drillDownMenus()) m.classList.add('drill');
    document.body.append(m); openMenu = m;
    const r = m.getBoundingClientRect();
    if (r.bottom > window.innerHeight) m.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`;
    if (r.right > window.innerWidth) m.style.left = `${Math.max(4, window.innerWidth - r.width - 4)}px`;
  }
  return m;
}
/** Opens a menu just above a button, its bottom edge 4 px over the button's top, as the layers footer's menus do. */
export function showMenuAbove(items: MenuItem[], anchor: DOMRect): HTMLElement {
  const m = showMenu(items, anchor.left, 0);
  m.style.top = `${Math.max(4, anchor.top - m.getBoundingClientRect().height - 4)}px`;
  return m;
}
document.addEventListener('pointerdown', e => { if (openMenu && !(e.target as HTMLElement).closest('.menu, .menubar-item')) closeMenus(); });
