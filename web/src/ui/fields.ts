// Photoshop-style number fields (UI/NumericScrub.swift, everywhere a number is typed): drag the field or its label
// sideways to scrub (Shift ×10, Option/Alt ×0.1), arrow keys step it the same way, units are understood and shown,
// values clamp to the field's range, and a typed expression like 50*2 or (1920-40)/2 is worked out on Enter.
// Every <input type="number"> in the app is enhanced automatically (opt out with data-native), so the code that
// builds a dialog keeps reading `input.value` and listening for 'input' / 'change' as before: the field always holds a
// plain number by the time those listeners see it.

const enhanced = new WeakSet<HTMLInputElement>();
interface FieldState { min: number; max: number; step: number; decimals: number; unit: string; integer: boolean }

/** Evaluates + - * / ( ) and unary minus over numbers (no names, no eval). Returns NaN when it isn't arithmetic. */
export function evalExpression(src: string): number {
  const s = src.replace(/,/g, '.').replace(/[×x]/g, '*').replace(/÷/g, '/').replace(/\s+/g, '');
  let i = 0;
  const peek = () => s[i];
  const num = (): number => {
    if (peek() === '(') { i++; const v = expr(); if (peek() !== ')') throw 0; i++; return v; }
    if (peek() === '-') { i++; return -num(); }
    if (peek() === '+') { i++; return num(); }
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i)); if (!m) throw 0;
    i += m[0].length; return parseFloat(m[0]);
  };
  const term = (): number => { let v = num(); while (peek() === '*' || peek() === '/') { const op = s[i++], r = num(); v = op === '*' ? v * r : v / r; } return v; };
  const expr = (): number => { let v = term(); while (peek() === '+' || peek() === '-') { const op = s[i++], r = term(); v = op === '+' ? v + r : v - r; } return v; };
  try { if (!s) return NaN; const v = expr(); return i === s.length && Number.isFinite(v) ? v : NaN; } catch { return NaN; }
}

const UNIT_RE = /\s*(px|pixels?|%|percent|°|deg|degrees?|pt|in|cm|mm|ppi|dpi)\s*$/i;
/** The number a field's text means: a plain number, or an expression, with an optional unit at the end. */
export function parseFieldValue(text: string): number {
  const t = text.trim().replace(UNIT_RE, '');
  if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return parseFloat(t);
  return evalExpression(t);
}
const plainNumber = (t: string) => /^\s*[-+]?(\d+\.?\d*|\.\d+)?\s*$/.test(t);

function stateOf(i: HTMLInputElement): FieldState {
  const a = (n: string) => i.getAttribute(n);
  const min = a('min') !== null && a('min') !== '' ? +a('min')! : -Infinity, max = a('max') !== null && a('max') !== '' ? +a('max')! : Infinity;
  const stepAttr = a('data-step') ?? a('step');
  const step = stepAttr && stepAttr !== 'any' && +stepAttr > 0 ? +stepAttr : 1;
  const decimals = stepAttr === 'any' ? 2 : step < 1 ? Math.min(3, Math.max(1, Math.ceil(-Math.log10(step) - 1e-9))) : 0;
  return { min, max, step, decimals, unit: a('data-unit') ?? '', integer: stepAttr !== 'any' && step >= 1 && Number.isInteger(step) };
}
function format(v: number, st: FieldState): string {
  if (st.integer) return String(Math.round(v));
  const f = v.toFixed(st.decimals);
  return st.decimals && f.includes('.') ? f.replace(/\.?0+$/, '') : f;
}
const clamp = (v: number, st: FieldState) => Math.min(st.max, Math.max(st.min, v));

/** Sets the field to v (clamped and rounded to its step) and tells the app, like a typed value would. */
function commit(i: HTMLInputElement, v: number, events: ('input' | 'change')[] = ['input', 'change']) {
  const st = stateOf(i);
  if (!Number.isFinite(v)) return;
  v = clamp(v, st);
  if (st.integer) v = Math.round(v / st.step) * st.step;
  const text = format(v, st);
  const changed = i.value !== text;
  i.value = text;
  if (changed || events.includes('change')) for (const e of events) i.dispatchEvent(new Event(e, { bubbles: true }));
}
/** Resolves whatever was typed (an expression, a unit) into the plain number the app reads. */
function resolveTyped(i: HTMLInputElement) {
  const raw = i.value;
  if (raw.trim() === '') return;
  const v = parseFieldValue(raw);
  if (Number.isNaN(v)) { i.value = i.dataset.lastGood ?? ''; return; }
  const st = stateOf(i);
  let w = clamp(v, st); if (st.integer) w = Math.round(w / st.step) * st.step;
  i.value = format(w, st);
}
const stepFactor = (e: { shiftKey: boolean; altKey: boolean }) => (e.shiftKey ? 10 : 1) * (e.altKey ? 0.1 : 1);

// ---------- scrubbing ----------
function scrubFrom(i: HTMLInputElement, e: PointerEvent, from: HTMLElement, immediate: boolean) {
  if (i.disabled || i.readOnly || e.button !== 0) return;
  const st = stateOf(i);
  const start = parseFieldValue(i.value);
  const v0 = Number.isFinite(start) ? start : Number.isFinite(st.min) ? st.min : 0;
  const x0 = e.clientX, y0 = e.clientY, id = e.pointerId;
  let scrubbing = immediate, acc = 0, lastX = x0;
  // Per pixel: one step, or a 1/300 of the span for wide ranges with fine steps (opacity 0–1), so a short drag covers it.
  const span = st.max - st.min;
  const perPx = Number.isFinite(span) && span / st.step > 600 && !st.integer ? span / 300 : st.step;
  const begin = () => {
    scrubbing = true; i.dataset.lastGood = i.value;
    try { from.setPointerCapture(id); } catch { /* already released */ }
    document.body.classList.add('scrubbing'); i.classList.add('scrubbing');
    if (document.activeElement === i) i.blur();
  };
  // No native mousedown either way: it would focus the field and could start dragging its selected text, which ends
  // the pointer stream. A press that doesn't become a scrub focuses the field on release instead.
  e.preventDefault();
  if (immediate) begin();
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    if (!scrubbing) {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { end(); return; } // a vertical swipe scrolls the sheet
      if (Math.abs(dx) < (ev.pointerType === 'mouse' ? 3 : 8)) return;
      begin(); lastX = ev.clientX;
    }
    ev.preventDefault();
    acc += (ev.clientX - lastX) * perPx * stepFactor(ev); lastX = ev.clientX;
    commit(i, v0 + acc, ['input']);
  };
  const end = (ev?: PointerEvent) => {
    if (ev && ev.pointerId !== id) return;
    window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', end, true); window.removeEventListener('pointercancel', end, true);
    document.body.classList.remove('scrubbing'); i.classList.remove('scrubbing');
    if (scrubbing) {
      if (acc !== 0) i.dispatchEvent(new Event('change', { bubbles: true }));
      // The click that follows a drag must not put the caret in the field.
      const swallow = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener('click', swallow, { capture: true, once: true }); setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    } else if (ev && from === i && document.activeElement !== i && ev.type === 'pointerup') {
      i.focus(); i.select();
    }
  };
  window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', end, true); window.addEventListener('pointercancel', end, true);
}

// ---------- slider popover (for bounded fields that have no slider of their own) ----------
let openPopover: { el: HTMLElement; close: () => void } | null = null;
function sliderPopover(i: HTMLInputElement, anchor: HTMLElement) {
  if (openPopover) { const same = openPopover.el.dataset.for === i.id && i.id; openPopover.close(); if (same) return; }
  const st = stateOf(i);
  const range = document.createElement('input');
  range.type = 'range'; range.min = String(st.min); range.max = String(st.max); range.step = st.integer ? String(st.step) : 'any';
  range.value = String(parseFieldValue(i.value) || st.min); range.setAttribute('aria-label', i.getAttribute('aria-label') ?? 'Value');
  const el = document.createElement('div'); el.className = 'num-popover'; el.dataset.for = i.id; el.append(range);
  document.body.append(el);
  const r = anchor.getBoundingClientRect(), w = 200;
  el.style.left = `${Math.max(6, Math.min(innerWidth - w - 6, r.right - w))}px`;
  el.style.top = r.bottom + 46 > innerHeight ? `${r.top - 40}px` : `${r.bottom + 4}px`;
  range.addEventListener('input', () => commit(i, +range.value, ['input']));
  range.addEventListener('change', () => i.dispatchEvent(new Event('change', { bubbles: true })));
  const outside = (e: PointerEvent) => { if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter') { e.stopPropagation(); close(); i.focus(); } };
  const close = () => { el.remove(); window.removeEventListener('pointerdown', outside, true); el.removeEventListener('keydown', key); if (openPopover?.el === el) openPopover = null; };
  setTimeout(() => window.addEventListener('pointerdown', outside, true));
  el.addEventListener('keydown', key);
  openPopover = { el, close };
  range.focus();
}

/** Makes one input a scrubby number field. `opts.popover` adds the slider button (default: bounded fields only). */
export function numberField(i: HTMLInputElement, opts: { label?: HTMLElement | null; popover?: boolean; unit?: string } = {}) {
  if (enhanced.has(i)) return i;
  enhanced.add(i);
  if (i.type === 'number') { i.type = 'text'; if (!i.hasAttribute('inputmode')) i.setAttribute('inputmode', stateOf(i).integer && stateOf(i).min >= 0 ? 'numeric' : 'decimal'); }
  if (opts.unit) i.dataset.unit = opts.unit;
  i.classList.add('num-field'); i.autocomplete = 'off'; i.spellcheck = false;
  i.setAttribute('role', 'spinbutton');
  const syncAria = () => {
    const st = stateOf(i), v = parseFieldValue(i.value);
    if (Number.isFinite(st.min)) i.setAttribute('aria-valuemin', String(st.min)); if (Number.isFinite(st.max)) i.setAttribute('aria-valuemax', String(st.max));
    if (Number.isFinite(v)) i.setAttribute('aria-valuenow', String(v)); else i.removeAttribute('aria-valuenow');
  };
  syncAria();
  if (!i.title) i.title = 'Drag sideways to change · Shift ×10 · Alt fine · ↑↓ step · type 50*2';
  i.addEventListener('focus', () => { i.dataset.lastGood = i.value; });
  i.addEventListener('pointerdown', e => { if (document.activeElement !== i) scrubFrom(i, e, i, false); });
  i.addEventListener('keydown', e => {
    // The canvas shortcuts must not fire while typing a number; Enter and Escape still reach the dialog (default
    // button, Cancel) unless Escape is undoing an edit here first.
    if (e.key !== 'Enter' && e.key !== 'Escape') e.stopPropagation();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      const st = stateOf(i), cur = parseFieldValue(i.value);
      const base = Number.isFinite(cur) ? cur : Number.isFinite(st.min) ? st.min : 0;
      const dir = e.key === 'ArrowUp' || e.key === 'PageUp' ? 1 : -1, big = e.key.startsWith('Page') ? 10 : 1;
      commit(i, base + dir * st.step * big * stepFactor(e));
      i.select();
    } else if (e.key === 'Enter') {
      resolveTyped(i); i.dispatchEvent(new Event('change', { bubbles: true })); i.dataset.lastGood = i.value; i.select();
    } else if (e.key === 'Escape' && i.dataset.lastGood !== undefined && i.value !== i.dataset.lastGood) {
      e.preventDefault(); e.stopPropagation(); i.value = i.dataset.lastGood; for (const t of ['input', 'change']) i.dispatchEvent(new Event(t, { bubbles: true })); i.select();
    }
  });
  i.addEventListener('change', syncAria); i.addEventListener('input', syncAria);
  // Label scrubbing: the field's <label>, or one pointing at it.
  const label = opts.label ?? (i.closest('label') as HTMLElement | null) ?? (i.id ? document.querySelector<HTMLElement>(`label[for="${CSS.escape(i.id)}"]`) : null)
    ?? (i.parentElement?.querySelectorAll('input:not([type=hidden]):not([type=checkbox])').length === 1 ? i.parentElement.querySelector<HTMLElement>(':scope > .lbl') : null);
  if (label && !label.classList.contains('scrub') && !label.dataset.scrubFor) {
    label.dataset.scrubFor = '1'; label.classList.add('scrub-label');
    label.addEventListener('pointerdown', e => {
      const t = e.target as HTMLElement;
      if (t === i || t.closest('input, select, button, textarea')) return;
      scrubFrom(i, e, label, e.pointerType === 'mouse');
    });
    label.addEventListener('click', e => { if ((e.target as HTMLElement) !== i) e.preventDefault(); }); // don't focus-jump after a scrub
  }
  // One bordered box holds the value and its unit (muted, right after the number), sized to fit them.
  const next = i.nextElementSibling as HTMLElement | null;
  const unitEl = next?.classList.contains('unit') ? next : opts.unit || i.dataset.unit ? Object.assign(document.createElement('span'), { className: 'unit', textContent: opts.unit || i.dataset.unit }) : null;
  const box = document.createElement('span');
  box.className = 'num-box';
  i.before(box); box.append(i);
  if (unitEl) { box.append(unitEl); box.classList.add('has-unit'); }
  box.addEventListener('pointerdown', e => { if (e.target !== i && !(e.target as HTMLElement).closest('button')) { if (document.activeElement === i) e.preventDefault(); else scrubFrom(i, e, i, false); } });
  const st = stateOf(i);
  const chars = Math.min(7, Math.max(2, ...[st.min, st.max].filter(Number.isFinite).map(v => format(v, st).length), Number.isFinite(st.max) ? 0 : st.integer ? 5 : 6));
  i.style.width = `calc(${chars}ch + ${unitEl ? 8 : 14}px)`;
  const inSlider = !!i.closest('.slider-row') && !i.closest('.tool-header');
  if (opts.popover ?? (!inSlider && Number.isFinite(st.min) && Number.isFinite(st.max) && st.max - st.min > 0 && (st.max - st.min <= 1000 || !!i.closest('.tool-header')) && !i.dataset.noPopover)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'num-pop-btn'; b.tabIndex = -1; b.setAttribute('aria-label', 'Show slider'); b.title = 'Slider';
    b.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (!i.disabled) sliderPopover(i, b); });
    box.append(b); box.classList.add('has-pop');
    // On touch screens the options bar hides the small slider button; a tap on the label (one that doesn't scrub) opens it.
    const lbl = i.closest('.tool-header') ? i.closest('.slider-row')?.querySelector<HTMLElement>('.slider-label') ?? label : null;
    if (lbl) {
      let x0 = 0, y0 = 0;
      lbl.addEventListener('pointerdown', e => { x0 = e.clientX; y0 = e.clientY; });
      lbl.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse' && Math.hypot(e.clientX - x0, e.clientY - y0) < 6 && !i.disabled) sliderPopover(i, box); });
    }
  }
  return i;
}

/** Every number field and select in the app goes through here, now and as dialogs and panels are built. */
export function installFieldEnhancer(root: HTMLElement = document.body, extra?: (root: ParentNode) => void) {
  const scan = (n: ParentNode) => {
    for (const i of n.querySelectorAll<HTMLInputElement>('input[type="number"]:not([data-native])')) numberField(i);
    extra?.(n);
  };
  scan(root);
  new MutationObserver(list => {
    for (const m of list) for (const n of m.addedNodes) if (n instanceof HTMLElement) {
      if (n.matches('input[type="number"]:not([data-native])')) numberField(n as HTMLInputElement);
      scan(n);
    }
  }).observe(root, { childList: true, subtree: true });
  // While an expression is half typed ("50*"), the app's own 'input' listeners must not see it; on 'change' (blur) it
  // is resolved first. These run before any listener on the field itself.
  window.addEventListener('input', e => {
    const i = e.target as HTMLInputElement;
    if (enhanced.has(i) && e.isTrusted && !plainNumber(i.value)) e.stopImmediatePropagation();
  }, true);
  window.addEventListener('change', e => {
    const i = e.target as HTMLInputElement;
    if (enhanced.has(i) && !plainNumber(i.value)) resolveTyped(i);
  }, true);
}
