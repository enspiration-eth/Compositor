// The app's own pop-up menus in place of the browser's <select> (macOS-style NSPopUpButton): a button that opens a
// listbox with keyboard navigation (↑↓ Home End PageUp PageDown, Enter/Space, Escape, Tab), type-ahead, live preview
// where it helps (blend modes: data-preview), and a bottom sheet on phones. The native <select> stays in the page,
// transparent and out of the way, as the value: code keeps reading `select.value` and listening for 'change', and
// setting `select.value` updates the button.

const wrapped = new WeakMap<HTMLSelectElement, HTMLButtonElement>();
let uid = 0;
let openMenu: { close: (commit: boolean) => void; select: HTMLSelectElement } | null = null;

interface Item { kind: 'option'; opt: HTMLOptionElement; label: string; disabled: boolean } 
type Row = Item | { kind: 'sep' } | { kind: 'group'; label: string };
function rowsOf(s: HTMLSelectElement): Row[] {
  const rows: Row[] = [];
  for (const c of Array.from(s.children)) {
    if (c instanceof HTMLOptGroupElement) {
      rows.push({ kind: 'group', label: c.label });
      for (const o of Array.from(c.children)) if (o instanceof HTMLOptionElement) rows.push(optRow(o, c.disabled));
    } else if (c instanceof HTMLOptionElement) {
      if (c.disabled && /^[─—-]{3,}$/.test(c.textContent?.trim() ?? '')) { if (rows.length && rows[rows.length - 1].kind !== 'sep') rows.push({ kind: 'sep' }); }
      else if (!c.hidden) rows.push(optRow(c, false));
    }
  }
  return rows;
}
const optRow = (o: HTMLOptionElement, groupDisabled: boolean): Item => ({ kind: 'option', opt: o, label: o.label || o.textContent || '', disabled: o.disabled || groupDisabled });
const fire = (s: HTMLSelectElement, type: 'input' | 'change') => s.dispatchEvent(new Event(type, { bubbles: true }));
const isPhone = () => document.body.classList.contains('phone');

function sync(s: HTMLSelectElement) {
  const b = wrapped.get(s); if (!b) return;
  const o = s.selectedOptions[0];
  (b.firstElementChild as HTMLElement).textContent = o ? o.label || o.textContent || '' : '';
  b.disabled = s.disabled;
  b.hidden = s.hidden || s.style.display === 'none';
  if (s.title && !b.title) b.title = s.title;
  const lbl = s.getAttribute('aria-label'); if (lbl) b.setAttribute('aria-label', lbl);
}

/** Replaces one native select with the custom pop-up (keeps the select as the model). */
export function selectMenu(s: HTMLSelectElement): HTMLButtonElement {
  const have = wrapped.get(s); if (have) return have;
  if (s.multiple || (s.size > 1)) return s as unknown as HTMLButtonElement;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `${s.className} cs-button`.trim();
  b.setAttribute('role', 'combobox'); b.setAttribute('aria-haspopup', 'listbox'); b.setAttribute('aria-expanded', 'false');
  b.id = s.id ? `${s.id}-button` : `cs-${++uid}`;
  b.append(Object.assign(document.createElement('span'), { className: 'cs-label' }));
  b.insertAdjacentHTML('beforeend', '<svg class="cs-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9.5l5-5 5 5M7 14.5l5 5 5-5"/></svg>');
  if (s.getAttribute('style')) b.setAttribute('style', s.getAttribute('style')!);
  // A <label for=select> names the button too.
  if (s.id) { const l = document.querySelector(`label[for="${CSS.escape(s.id)}"]`); if (l) { l.id ||= `${b.id}-label`; b.setAttribute('aria-labelledby', l.id); l.setAttribute('for', b.id); } }
  else if (!s.getAttribute('aria-label')) { const l = s.parentElement?.querySelector(':scope > .lbl, :scope > .slider-label'); if (l?.textContent) b.setAttribute('aria-label', l.textContent.trim()); }
  s.classList.add('cs-native'); s.tabIndex = -1; s.setAttribute('aria-hidden', 'true');
  s.after(b);
  wrapped.set(s, b);
  // `select.value = …` and friends update the button.
  const proto = HTMLSelectElement.prototype;
  for (const k of ['value', 'selectedIndex', 'disabled'] as const) {
    const d = Object.getOwnPropertyDescriptor(proto, k)!;
    Object.defineProperty(s, k, { configurable: true, get() { return d.get!.call(this); }, set(v) { d.set!.call(this, v); sync(s); } });
  }
  new MutationObserver(() => sync(s)).observe(s, { childList: true, subtree: true, attributes: true, characterData: true, attributeFilter: ['disabled', 'selected', 'hidden', 'style', 'label', 'title'] });
  s.addEventListener('change', () => sync(s)); s.addEventListener('input', () => sync(s));
  sync(s);

  // Closed: ↑↓ step through the options (like the Mac pop-up with the keyboard), letters jump, Space/Enter/Alt+↓ open.
  let typed = '', typedAt = 0;
  const typeAhead = (key: string, from: number, items: Item[]) => {
    const now = performance.now(); typed = now - typedAt > 700 ? key : typed + key; typedAt = now;
    const q = typed.toLowerCase(), n = items.length;
    const start = typed.length === 1 ? from + 1 : from;
    for (let k = 0; k < n; k++) { const it = items[(start + k) % n]; if (!it.disabled && it.label.toLowerCase().startsWith(q)) return it; }
    return null;
  };
  b.addEventListener('keydown', e => {
    if (openMenu?.select === s) return;
    const items = rowsOf(s).filter((r): r is Item => r.kind === 'option');
    const cur = items.findIndex(it => it.opt.selected);
    const choose = (it: Item | undefined | null) => { if (!it || it.disabled || it.opt.selected) return; it.opt.selected = true; sync(s); fire(s, 'input'); fire(s, 'change'); };
    if ((e.key === 'ArrowDown' && e.altKey) || e.key === 'Enter' || e.key === ' ' || e.key === 'F4') { e.preventDefault(); e.stopPropagation(); open(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      for (let i = cur + dir; i >= 0 && i < items.length; i += dir) if (!items[i].disabled) { choose(items[i]); break; }
      return;
    }
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); e.stopPropagation(); const list = e.key === 'Home' ? items : [...items].reverse(); choose(list.find(it => !it.disabled)); return; }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { e.stopPropagation(); choose(typeAhead(e.key, cur, items)); }
  });
  b.addEventListener('click', e => { e.preventDefault(); if (openMenu?.select === s) openMenu.close(false); else open(); });

  function open() {
    if (s.disabled) return;
    openMenu?.close(false);
    const rows = rowsOf(s);
    const items = rows.filter((r): r is Item => r.kind === 'option');
    const original = s.value;
    const preview = s.hasAttribute('data-preview');
    const phone = isPhone();
    const list = document.createElement('div');
    list.className = `cs-list${phone ? ' cs-sheet' : ''}`; list.id = `${b.id}-list`;
    list.setAttribute('role', 'listbox'); list.tabIndex = -1;
    const lb = b.getAttribute('aria-labelledby'); if (lb) list.setAttribute('aria-labelledby', lb); else if (b.getAttribute('aria-label')) list.setAttribute('aria-label', b.getAttribute('aria-label')!);
    const els = new Map<Item, HTMLElement>();
    let active: Item | null = items.find(it => it.opt.selected) ?? items.find(it => !it.disabled) ?? null;
    rows.forEach((r, n) => {
      if (r.kind === 'sep') { list.append(Object.assign(document.createElement('div'), { className: 'cs-sep', role: 'separator' })); return; }
      if (r.kind === 'group') { const g = document.createElement('div'); g.className = 'cs-group'; g.textContent = r.label; g.setAttribute('role', 'presentation'); list.append(g); return; }
      const el = document.createElement('div');
      el.className = 'cs-option'; el.id = `${b.id}-opt-${n}`; el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', String(r.opt.selected)); if (r.disabled) el.setAttribute('aria-disabled', 'true');
      el.dataset.value = r.opt.value;
      el.append(Object.assign(document.createElement('span'), { className: 'cs-check', textContent: r.opt.selected ? '✓' : '' }), Object.assign(document.createElement('span'), { textContent: r.label }));
      els.set(r, el); list.append(el);
      el.addEventListener('pointermove', ev => { if (ev.pointerType === 'mouse' && !r.disabled && active !== r) setActive(r, false); });
      el.addEventListener('click', ev => { ev.stopPropagation(); if (r.disabled) return; setActive(r, false); close(true); });
    });
    const back = document.createElement('div'); back.className = `cs-back${phone ? ' sheet' : ''}`;
    back.addEventListener('pointerdown', ev => { if (ev.target === back) { ev.preventDefault(); close(false); } });
    back.append(list);
    if (phone) {
      const title = document.createElement('div'); title.className = 'cs-sheet-title';
      title.textContent = (lb && document.getElementById(lb)?.textContent) || b.getAttribute('aria-label') || b.title || '';
      if (title.textContent) list.prepend(title);
    }
    document.body.append(back);
    if (!phone) {
      const r = b.getBoundingClientRect();
      list.style.minWidth = `${Math.max(r.width, 120)}px`;
      const lh = list.offsetHeight, lw = list.offsetWidth;
      // Like the Mac pop-up: the chosen item sits over the button when there's room, otherwise below (or above) it.
      const sel = active ? els.get(active) : null;
      let top = sel ? r.top - sel.offsetTop - 3 : r.bottom + 2;
      if (top < 6 || top + lh > innerHeight - 6) top = r.bottom + 2 + lh <= innerHeight - 6 ? r.bottom + 2 : Math.max(6, Math.min(innerHeight - lh - 6, r.top - lh - 2));
      list.style.top = `${top}px`; list.style.left = `${Math.max(6, Math.min(innerWidth - lw - 6, r.left))}px`;
      list.style.maxHeight = `${innerHeight - 12}px`;
    }
    b.setAttribute('aria-expanded', 'true'); b.setAttribute('aria-controls', list.id); b.classList.add('open');
    function setActive(it: Item | null, scroll = true) {
      if (active) els.get(active)?.classList.remove('active');
      active = it;
      if (!it) { b.removeAttribute('aria-activedescendant'); return; }
      const el = els.get(it)!; el.classList.add('active');
      b.setAttribute('aria-activedescendant', el.id); list.setAttribute('aria-activedescendant', el.id);
      if (scroll) el.scrollIntoView({ block: 'nearest' });
      if (preview && !it.disabled && s.value !== it.opt.value) { it.opt.selected = true; sync(s); fire(s, 'change'); }
    }
    setActive(active, true);
    const move = (dir: number, from = active ? items.indexOf(active) : -1) => {
      for (let i = from + dir; i >= 0 && i < items.length; i += dir) if (!items[i].disabled) { setActive(items[i]); return; }
    };
    const page = () => Math.max(1, Math.floor(list.clientHeight / 26) - 1);
    const key = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); return; }
      if (k === 'Enter' || k === ' ' && !typed) { e.preventDefault(); e.stopPropagation(); close(true); return; }
      if (k === 'Tab') { close(true); return; }
      if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); if (e.altKey) { close(true); return; } move(k === 'ArrowDown' ? 1 : -1); return; }
      if (k === 'Home') { e.preventDefault(); e.stopPropagation(); move(1, -1); return; }
      if (k === 'End') { e.preventDefault(); e.stopPropagation(); move(-1, items.length); return; }
      if (k === 'PageDown' || k === 'PageUp') { e.preventDefault(); e.stopPropagation(); const d = k === 'PageDown' ? 1 : -1; const i = Math.max(0, Math.min(items.length - 1, (active ? items.indexOf(active) : 0) + d * page())); move(-d, i + d); return; }
      if (k.length === 1 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); e.stopPropagation(); const it = typeAhead(k, active ? items.indexOf(active) : -1, items); if (it) setActive(it); return; }
      e.stopPropagation();
    };
    window.addEventListener('keydown', key, true);
    const onResize = () => close(false);
    window.addEventListener('resize', onResize);
    if (!phone) b.focus(); else list.focus({ preventScroll: true });
    let done = false;
    function close(commit: boolean) {
      if (done) return; done = true;
      window.removeEventListener('keydown', key, true); window.removeEventListener('resize', onResize);
      back.remove(); b.setAttribute('aria-expanded', 'false'); b.removeAttribute('aria-activedescendant'); b.removeAttribute('aria-controls'); b.classList.remove('open');
      if (openMenu?.select === s) openMenu = null;
      const want = commit && active && !active.disabled ? active.opt.value : original;
      if (s.value !== want) { s.value = want; sync(s); if (!preview) fire(s, 'input'); fire(s, 'change'); }
      else if (!preview && want !== original) { fire(s, 'input'); fire(s, 'change'); }
      b.focus({ preventScroll: true });
    }
    openMenu = { close, select: s };
  }
  return b;
}

/** Enhances every select under `root` (skip one with data-native). */
export function enhanceSelects(root: ParentNode) {
  const found = root instanceof HTMLSelectElement ? [root] : Array.from(root.querySelectorAll<HTMLSelectElement>('select'));
  for (const s of found) if (!s.hasAttribute('data-native') && !wrapped.has(s)) selectMenu(s);
}
/** Removes buttons whose select left the page (the code that built it replaced or removed it). */
export function pruneSelectButtons(removed: Node) {
  if (!(removed instanceof HTMLElement)) return;
  const sels = removed instanceof HTMLSelectElement ? [removed] : Array.from(removed.querySelectorAll('select'));
  for (const s of sels) { const b = wrapped.get(s); if (b && !s.isConnected && b.isConnected) b.remove(); }
}
