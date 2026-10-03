// The app's own color picker (ColorPickerSheet.swift): a saturation/brightness field, a vertical hue strip, new/current
// preview, RGB and hex entry, in a movable floating panel so the canvas stays visible and a click on it samples a color.
// Nothing is kept until OK; Cancel, Escape or the close button puts the original back.
import { h, floatingPanel, toHex, type Panel } from './dom';

export interface RGB { red: number; green: number; blue: number }
interface HSB { hue: number; saturation: number; brightness: number }

export function hsbToRgb({ hue, saturation, brightness }: HSB): RGB {
  const hh = ((hue % 360) + 360) % 360 / 60, c = brightness * saturation, x = c * (1 - Math.abs(hh % 2 - 1)), m = brightness - c;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.min(5, Math.floor(hh))]!;
  return { red: r + m, green: g + m, blue: b + m };
}
/** PickerHSB.setRGB: hue (and saturation, at black) are kept where RGB doesn't define them, so dragging through grays keeps the hue. */
export function setRGB(prev: HSB, c: RGB): HSB {
  const mx = Math.max(c.red, c.green, c.blue), mn = Math.min(c.red, c.green, c.blue), d = mx - mn;
  let hue = prev.hue, saturation = prev.saturation;
  if (mx > 0) saturation = d / mx;
  if (d > 0) {
    if (mx === c.red) hue = 60 * (((c.green - c.blue) / d) % 6);
    else if (mx === c.green) hue = 60 * ((c.blue - c.red) / d + 2);
    else hue = 60 * ((c.red - c.green) / d + 4);
    if (hue < 0) hue += 360;
  }
  return { hue, saturation, brightness: mx };
}
const quantize = (c: RGB): RGB => ({ red: Math.round(c.red * 255) / 255, green: Math.round(c.green * 255) / 255, blue: Math.round(c.blue * 255) / 255 });
export function parseHex(text: string): RGB | null {
  let s = text.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map(ch => ch + ch).join('');
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return { red: parseInt(s.slice(0, 2), 16) / 255, green: parseInt(s.slice(2, 4), 16) / 255, blue: parseInt(s.slice(4, 6), 16) / 255 };
}

export interface PickerOptions {
  title: string;
  color: RGB;
  /** Called as the working color moves (a dialog previews it); Cancel calls it once more with the original. */
  onChange?: (c: RGB) => void;
  /** OK hands over the chosen color; Cancel hands over null. */
  onDone: (c: RGB | null) => void;
  /** While this element is on the page the picker belongs to it; once it's gone (its dialog closed) the picker commits and closes. */
  owner?: HTMLElement;
}

interface Open { panel: Panel; sample: (c: RGB) => void; finish: (commit: boolean) => void; opts: PickerOptions }
let open: Open | null = null;

/** Whether a picker is open, so a click on the canvas samples for it instead of using the tool. */
export const pickerOpen = () => !!open;
export function sampleForPicker(c: RGB) { open?.sample(c); }
export function closeColorPicker(commit: boolean) { open?.finish(commit); }

export function openColorPicker(opts: PickerOptions) {
  open?.finish(false);
  const original = quantize(opts.color);
  let hsb = setRGB({ hue: 0, saturation: 0, brightness: 0 }, original);
  const color = () => quantize(hsbToRgb(hsb));
  // Phones: a smaller field on short screens so the whole sheet (values and buttons too) fits without scrolling.
  const SIZE = document.body.classList.contains('compact') ? (() => { const vh = window.visualViewport?.height ?? innerHeight; return Math.round(Math.max(150, Math.min(256, Math.min(vh * 0.72, vh - 60) - 252))); })() : 256;

  let done = false;
  const finish = (commit: boolean) => {
    if (done) return; done = true;
    clearInterval(watch); document.removeEventListener('keydown', onKey, true);
    if (open?.panel === panel) open = null;
    panel.close();
    if (!commit) opts.onChange?.(original);
    opts.onDone(commit ? color() : null);
  };
  const panel = floatingPanel(opts.title, () => finish(false), { width: 500, id: 'color-picker' });
  // Above a dialog it was opened from.
  const overDialog = !!document.querySelector('.modal-back');
  const lift = () => { if (overDialog) panel.el.style.zIndex = String(Math.max(600, +panel.el.style.zIndex || 0)); };
  lift(); panel.el.addEventListener('pointerdown', lift);

  const sbMarker = h('div', { class: 'cp-marker' });
  const field = h('div', { class: 'cp-field', id: 'cp-field', style: `width:${SIZE}px;height:${SIZE}px`, 'aria-label': 'Saturation and brightness' }, sbMarker);
  const hueArrows = h('div', { class: 'cp-hue-arrows' });
  const hue = h('div', { class: 'cp-hue', id: 'cp-hue', style: `height:${SIZE}px`, 'aria-label': 'Hue' }, h('div', { class: 'cp-hue-strip' }), hueArrows);
  const newSwatch = h('div', { class: 'cp-new', title: 'New color', id: 'cp-new' });
  const curSwatch = h('div', { class: 'cp-current', title: 'Current color (click to go back to it)', style: `background:${toHex(original)}` });
  curSwatch.addEventListener('click', () => { hsb = setRGB(hsb, original); update(); });
  const ok = h('button', { class: 'btn primary', id: 'cp-ok' }, 'OK'), cancel = h('button', { class: 'btn', id: 'cp-cancel' }, 'Cancel');
  ok.addEventListener('click', () => finish(true)); cancel.addEventListener('click', () => finish(false));

  const chan = (label: string, key: keyof RGB) => {
    const i = h('input', { type: 'number', min: 0, max: 255, step: 1, class: 'dim', id: `cp-${label.toLowerCase()}`, 'aria-label': ({ R: 'Red', G: 'Green', B: 'Blue' } as Record<string, string>)[label] }) as HTMLInputElement;
    i.addEventListener('input', () => {
      if (i.value === '') return;
      const c = color(); c[key] = Math.min(255, Math.max(0, Math.round(+i.value))) / 255;
      hsb = setRGB(hsb, c); update(i);
    });
    i.dataset.noPopover = '1'; // the field and the hue strip are the sliders here
    return { row: h('label', { class: 'cp-row cp-chan' }, h('span', {}, label), i), i, key };
  };
  const chans = [chan('R', 'red'), chan('G', 'green'), chan('B', 'blue')];
  const hex = h('input', { type: 'text', class: 'cp-hex', id: 'cp-hex', spellcheck: 'false', 'aria-label': 'Hex color' }) as HTMLInputElement;
  const commitHex = () => { const c = parseHex(hex.value); if (c) hsb = setRGB(hsb, c); update(); };
  hex.addEventListener('change', commitHex);
  hex.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitHex(); } });
  const hint = h('div', { class: 'hint cp-hint' }, document.querySelector('.modal-back') ? '' : 'Click the canvas to sample');

  // R, G, B side by side as labeled fields ([R   255]); the hex field on its own full-width row below.
  const hexBox = h('label', { class: 'cp-row cp-hexrow' }, h('div', { class: 'num-box labeled cp-hexbox' }, h('span', { class: 'num-inlabel' }, '#'), hex));
  const side = h('div', { class: 'cp-side' },
    h('div', { class: 'cp-top' }, h('div', { class: 'cp-preview' }, newSwatch, curSwatch), h('div', { class: 'cp-buttons' }, ok, cancel)),
    hint);
  const fields = h('div', { class: 'cp-fields' }, ...chans.map(c => c.row), hexBox);
  // Phones: field and hue strip, the values, then one row with the swatch and the buttons at the bottom of the sheet.
  if (document.body.classList.contains('compact')) panel.body.append(h('div', { class: 'cp' }, field, hue), fields, side);
  else panel.body.append(h('div', { class: 'cp' }, field, hue, side), fields);
  panel.place(); // in place before anything can be clicked

  function update(except?: HTMLElement) {
    const c = color();
    field.style.background = `linear-gradient(to bottom, transparent, #000), linear-gradient(to right, #fff, ${toHex(hsbToRgb({ hue: hsb.hue, saturation: 1, brightness: 1 }))})`;
    sbMarker.style.left = `${hsb.saturation * SIZE}px`; sbMarker.style.top = `${(1 - hsb.brightness) * SIZE}px`;
    hueArrows.style.top = `${(1 - hsb.hue / 360) * SIZE}px`;
    newSwatch.style.background = toHex(c);
    for (const ch of chans) if (ch.i !== except) ch.i.value = String(Math.round(c[ch.key] * 255));
    if (except !== hex && document.activeElement !== hex) hex.value = toHex(c).slice(1).toUpperCase();
    if (except === hex) hex.value = toHex(c).slice(1).toUpperCase();
    opts.onChange?.(c);
  }
  const drag = (el: HTMLElement, at: (x: number, y: number) => void) => el.addEventListener('pointerdown', e => {
    e.preventDefault(); el.setPointerCapture(e.pointerId);
    const go = (ev: PointerEvent) => { const r = el.getBoundingClientRect(); at(Math.min(1, Math.max(0, (ev.clientX - r.left) / SIZE)), Math.min(1, Math.max(0, (ev.clientY - r.top) / SIZE))); update(); };
    go(e);
    const up = () => { el.removeEventListener('pointermove', go); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', go); el.addEventListener('pointerup', up);
  });
  drag(field, (x, y) => { hsb = { ...hsb, saturation: x, brightness: 1 - y }; });
  drag(hue, (_x, y) => { hsb = { ...hsb, hue: (1 - y) * 360 }; });

  // Return accepts and Escape cancels while the picker has focus (a field's Return just applies it).
  const onKey = (e: KeyboardEvent) => {
    // Keys typed into the picker stay there; with nothing else focused, Return and Escape still answer it.
    const inside = panel.el.contains(e.target as Node), idle = e.target === document.body;
    if (!inside && !(idle && (e.key === 'Escape' || e.key === 'Enter'))) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    else if (e.key === 'Enter' && e.target !== hex) { e.preventDefault(); e.stopPropagation(); if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur(); finish(true); }
    else e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);
  const watch = setInterval(() => { if (opts.owner && !opts.owner.isConnected) finish(true); }, 250);

  open = { panel, opts, finish, sample: c => { hsb = setRGB(hsb, quantize(c)); update(); } };
  update();
  // OK takes the focus (Return accepts) unless a field already has it: on a slow frame the user (or a test) may be typing into one by now,
  // and moving the focus would turn their Return into OK.
  requestAnimationFrame(() => { if (!done && !panel.el.contains(document.activeElement)) ok.focus(); });
}

/** A color swatch button that opens the picker (DialogColorSwatch): the color follows the picker as it moves and keeps the one chosen. */
export function colorSwatchButton(value: RGB, onChange: (c: RGB) => void, opts: { title: string; id?: string; cls?: string; live?: boolean }): HTMLButtonElement {
  let current = { ...value };
  const b = h('button', { class: opts.cls ?? 'well', id: opts.id, title: opts.title, 'aria-label': opts.title, type: 'button' }) as HTMLButtonElement;
  const paint = (c: RGB) => { b.style.setProperty('--well', toHex(c)); };
  paint(current);
  b.addEventListener('mousedown', e => e.preventDefault()); // keeps a text selection where it is
  b.addEventListener('click', e => {
    e.preventDefault();
    openColorPicker({
      title: `Color Picker (${opts.title})`, color: current, owner: opts.live === false ? undefined : b,
      onChange: opts.live === false ? undefined : c => { paint(c); onChange(c); },
      onDone: c => { if (c) { current = c; paint(c); if (opts.live === false) onChange(c); } else paint(current); },
    });
  });
  return b;
}
