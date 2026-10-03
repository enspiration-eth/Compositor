// KeyboardShortcuts.swift: every shortcut can be reassigned (Photoshop.eth › Keyboard Shortcuts…). Overrides are kept
// in localStorage under the Mac app's key; key events are translated back to the default chord at the canvas
// boundary (canvasEvent / textEvent), so the handlers keep testing the defaults.

/** One key plus modifier bits: 1 Command (Ctrl off the Mac), 2 Option/Alt, 4 Control (Mac), 8 Shift. */
export interface Chord { key: string; modifiers: number }
export type ShortcutGroup = 'Menus' | 'Canvas & Layers' | 'Text Editing';
export interface ShortcutDef { title: string; group: ShortcutGroup; original: Chord; id: string }

export const isMacPlatform = /Mac|iPhone|iPad/.test(navigator.platform);
const LEFT = '\uf702', RIGHT = '\uf703', DOWN = '\uf701', UP = '\uf700', DEL = '\x7f', RET = '\r', ESC = '\x1b', TAB = '\t';
const same = (a: Chord, b: Chord) => a.key === b.key && a.modifiers === b.modifiers;

export const SHORTCUTS: ShortcutDef[] = (() => {
  const out: ShortcutDef[] = [];
  const add = (title: string, key: string, modifiers = 0, group: ShortcutGroup = 'Canvas & Layers') => out.push({ title, group, original: { key, modifiers }, id: `${group}:${title}` });
  const menu = (title: string, key: string, modifiers: number) => add(title, key, modifiers, 'Menus');
  menu('Undo', 'z', 1); menu('Redo', 'z', 9); menu('New Canvas', 'n', 1); menu('Open Project', 'o', 1); menu('Import Images', 'o', 9);
  menu('Save', 's', 1); menu('Save As', 's', 9); menu('Export PNG', 'e', 9); menu('Export JPEG', 's', 11); menu('Close Project', 'w', 1);
  menu('Fit Canvas', '0', 1); menu('Actual Pixels', '1', 1); menu('Zoom In', '=', 1); menu('Zoom Out', '-', 1); menu('Show Transform Controls', 'h', 1);
  menu('Cut', 'x', 1); menu('Copy', 'c', 1); menu('Copy Merged', 'c', 9); menu('Paste', 'v', 1);
  menu('Fill with Foreground', DEL, 2); menu('Fill with Background', DEL, 1); menu('Content-Aware Fill', DEL, 8);
  menu('Select All', 'a', 1); menu('Deselect', 'd', 1); menu('Inverse Selection', 'i', 9); menu('Select Subject', 'a', 3);
  menu('Curves', 'm', 1); menu('Levels', 'l', 1); menu('Hue/Saturation', 'u', 1); menu('Invert Pixels / Mask', 'i', 1);
  menu('Canvas Size', 'c', 3); menu('Image Size', 'i', 3); menu('Transform Layer / Selection', 't', 1);
  menu('Duplicate / Layer via Copy', 'j', 1); menu('Layer via Cut', 'j', 9); menu('Toggle Clipping Mask', 'g', 3); menu('Group Layers', 'g', 1);
  menu('Ungroup Layers', 'g', 9); menu('New Blank Layer', 'n', 9); menu('Move Layer Up', ']', 1); menu('Move Layer Down', '[', 1);
  menu('Merge Layers', 'e', 1); menu('Show Grid', "'", 1); menu('Show Guides', ';', 1); menu('Show Rulers', 'r', 1); menu('Snap', ';', 9);
  menu('Lock Guides', ';', 3); menu('Tool Options Bar', 'o', 3);
  for (const [title, key] of [['Select tool', 'a'], ['Move / Transform tool', 'v'], ['Hand tool', 'h'], ['Zoom tool', 'z'], ['Brush tool', 'b'], ['Eraser', 'e'],
    ['Spot Healing', 'j'], ['Clone Stamp', 's'], ['Type tool', 't'], ['Gradient tool', 'g'], ['Shape tool', 'u'], ['Eyedropper tool', 'i'],
    ['Marquee / cycle shape', 'm'], ['Magic', 'w'], ['Lasso / cycle mode', 'l'], ['Blur / Smudge / Liquify', 'r'], ['Crop tool', 'c'],
    ['Swap foreground/background', 'x'], ['Reset colors', 'd'], ['Cycle tool mode', TAB], ['Temporary Hand tool (hold)', ' '],
    ['Delete selection / layer / effect / lasso point', DEL], ['Apply current canvas operation', RET], ['Cancel current canvas operation', ESC],
    ['Decrease brush size', '['], ['Increase brush size', ']']]) add(title, key);
  add('Decrease brush hardness', '[', 8); add('Increase brush hardness', ']', 8); add('Previous blend mode', '-', 8); add('Next blend mode', '=', 8);
  add('Cycle shape kind', 'u', 8);
  for (let d = 0; d <= 9; d++) add(`Opacity digit ${d} (type two for exact %)`, String(d));
  for (const [dir, key] of [['Left', LEFT], ['Right', RIGHT], ['Up', UP], ['Down', DOWN]]) {
    add(`Nudge ${dir} 1 px`, key); add(`Nudge ${dir} 10 px`, key, 8);
  }
  add('Finish editing text', RET, 1, 'Text Editing');
  for (const [title, key] of [['Decrease tracking', LEFT], ['Increase tracking', RIGHT], ['Decrease leading', UP], ['Increase leading', DOWN]]) {
    add(title, key, 2, 'Text Editing'); add(`${title} by 10`, key, 10, 'Text Editing');
  }
  return out;
})();

const STORAGE = 'keyboardShortcuts.v1';
let overrides: Record<string, Chord> = {};
try { const saved = JSON.parse(localStorage.getItem(STORAGE) ?? '{}'); if (!shortcutProblem(saved)) overrides = saved; } catch { /* defaults */ }

export function shortcutOverrides(): Readonly<Record<string, Chord>> { return overrides; }
export function chordFor(d: ShortcutDef, values: Record<string, Chord> = overrides): Chord { return values[d.id] ?? d.original; }
export function saveShortcuts(values: Record<string, Chord>): boolean {
  if (shortcutProblem(values)) return false;
  overrides = { ...values }; localStorage.setItem(STORAGE, JSON.stringify(overrides)); return true;
}
/** ShortcutSettings.problem: one key per chord, text shortcuts need a modifier, and no clashes. */
export function shortcutProblem(values: Record<string, Chord>): string | null {
  const assigned = new Map<string, string>();
  for (const d of SHORTCUTS) {
    const c = chordFor(d, values);
    if (!c || typeof c.key !== 'string' || [...c.key].length !== 1 || !(c.modifiers >= 0 && c.modifiers <= 15)) return 'Choose a single key with optional modifiers.';
    if (d.group === 'Text Editing' && !(c.modifiers & 7)) return 'Text-editing shortcuts need Command, Option, or Control so they do not replace normal typing.';
    if ([{ key: 'q', modifiers: 1 }, { key: ',', modifiers: 1 }, { key: 'm', modifiers: 3 }].some(r => same(r, c))) return `${chordLabel(c)} is reserved by the system.`;
    const k = `${c.modifiers}:${c.key}`, other = assigned.get(k);
    if (other) return `${chordLabel(c)} is assigned to both ${other} and ${d.title}.`;
    assigned.set(k, d.title);
  }
  return null;
}

const SPECIAL_LABEL: Record<string, string> = { [DEL]: 'Delete', [RET]: 'Return', [ESC]: 'Esc', [TAB]: 'Tab', ' ': 'Space', [LEFT]: '←', [RIGHT]: '→', [DOWN]: '↓', [UP]: '↑' };
export function chordLabel(c: Chord): string {
  const k = SPECIAL_LABEL[c.key] ?? c.key.toUpperCase();
  if (isMacPlatform) return (c.modifiers & 4 ? '⌃' : '') + (c.modifiers & 2 ? '⌥' : '') + (c.modifiers & 8 ? '⇧' : '') + (c.modifiers & 1 ? '⌘' : '') + k;
  return (c.modifiers & 1 ? 'Ctrl+' : '') + (c.modifiers & 2 ? 'Alt+' : '') + (c.modifiers & 8 ? 'Shift+' : '') + k;
}

const CODE_KEYS: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-', Quote: "'", Semicolon: ';', Comma: ',', Period: '.',
  Slash: '/', Backslash: '\\', Backquote: '`', Space: ' ', NumpadAdd: '=', NumpadSubtract: '-' };
const SHIFTED_BASE: Record<string, string> = { '{': '[', '}': ']', '+': '=', '_': '-', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '|': '\\', '~': '`',
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0' };
/** ShortcutChord(event); null for a lone modifier key. */
export function chordOf(e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): Chord | null {
  if (['Shift', 'Meta', 'Control', 'Alt', 'CapsLock', 'OS', 'Fn'].includes(e.key)) return null;
  const modifiers = (e.metaKey || (!isMacPlatform && e.ctrlKey) ? 1 : 0) | (e.altKey ? 2 : 0) | (isMacPlatform && e.ctrlKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  const special: Record<string, string> = { Backspace: DEL, Delete: DEL, Enter: RET, Escape: ESC, Tab: TAB, ' ': ' ', ArrowLeft: LEFT, ArrowRight: RIGHT, ArrowDown: DOWN, ArrowUp: UP };
  let key = special[e.key];
  // Option (and Shift) change the typed character, so letters, digits and punctuation come from the key's position then.
  if (!key && (e.altKey || [...e.key].length !== 1)) {
    const m = /^Key([A-Z])$/.exec(e.code) ?? /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
    key = m ? m[1].toLowerCase() : CODE_KEYS[e.code];
  }
  if (!key && [...e.key].length === 1) key = SHIFTED_BASE[e.key] ?? e.key.toLowerCase();
  return key ? { key, modifiers } : null;
}

const SPECIAL_KEY: Record<string, string> = { [DEL]: 'Backspace', [RET]: 'Enter', [ESC]: 'Escape', [TAB]: 'Tab', ' ': ' ', [LEFT]: 'ArrowLeft', [RIGHT]: 'ArrowRight', [DOWN]: 'ArrowDown', [UP]: 'ArrowUp' };
const SHIFTED: Record<string, string> = { '[': '{', ']': '}', '=': '+', '-': '_' };
export interface KeyLike { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; target: EventTarget | null; repeat: boolean; preventDefault(): void }
/** ShortcutChord.event(like:): the key event the default chord would have produced. */
function eventFor(c: Chord, e: KeyboardEvent): KeyLike {
  const shift = !!(c.modifiers & 8);
  const key = SPECIAL_KEY[c.key] ?? (shift ? (SHIFTED[c.key] ?? c.key.toUpperCase()) : c.key);
  return { key, code: '', metaKey: !!(c.modifiers & 1) && isMacPlatform, ctrlKey: (!!(c.modifiers & 1) && !isMacPlatform) || !!(c.modifiers & 4), altKey: !!(c.modifiers & 2),
    shiftKey: shift, target: e.target, repeat: e.repeat, preventDefault: () => e.preventDefault() };
}

/** ShortcutSettings.canvasEvent (menus included, since one handler serves both here): the event to act on, or null to ignore it. */
export function translateCanvasKey(e: KeyboardEvent): KeyLike | null {
  if (!Object.keys(overrides).length) return e;
  const input = chordOf(e); if (!input) return e;
  const defs = SHORTCUTS.filter(d => d.group !== 'Text Editing');
  const hit = defs.find(d => same(chordFor(d), input));
  if (hit) return same(hit.original, input) ? e : eventFor(hit.original, e);
  if (defs.some(d => same(d.original, input) && !same(chordFor(d), input))) return null;
  // Letter tools also take Shift: follow the base assignment unless Shift has its own command.
  if (input.modifiers === 8) {
    const plain = { key: input.key, modifiers: 0 };
    const d = defs.find(x => x.group !== 'Menus' && x.original.modifiers === 0 && same(chordFor(x), plain));
    if (d) return eventFor({ key: d.original.key, modifiers: 8 }, e);
    if (defs.some(x => x.group !== 'Menus' && same(x.original, plain) && !same(chordFor(x), plain))) return null;
  }
  return e;
}
/** ShortcutSettings.textEvent: the text group plus Esc, inside the text editor. */
export function translateTextKey(e: KeyboardEvent): KeyLike | null {
  if (!Object.keys(overrides).length) return e;
  const input = chordOf(e); if (!input) return e;
  const defs = SHORTCUTS.filter(d => d.group === 'Text Editing' || same(d.original, { key: ESC, modifiers: 0 }));
  const hit = defs.find(d => same(chordFor(d), input));
  if (hit) return same(hit.original, input) ? e : eventFor(hit.original, e);
  if (defs.some(d => same(d.original, input) && !same(chordFor(d), input))) return null;
  return e;
}

/** A menu's default shortcut text (⇧⌘S, Ctrl+S, ⌫ …) shown as currently assigned. */
export function menuShortcutLabel(s: string): string {
  if (!Object.keys(overrides).length || !s) return s;
  let rest = s, modifiers = 0;
  for (;;) {
    if (rest.startsWith('⌃')) { modifiers |= 4; rest = rest.slice(1); } else if (rest.startsWith('⌥')) { modifiers |= 2; rest = rest.slice(1); }
    else if (rest.startsWith('⇧')) { modifiers |= 8; rest = rest.slice(1); } else if (rest.startsWith('⌘')) { modifiers |= 1; rest = rest.slice(1); }
    else if (rest.startsWith('Ctrl+')) { modifiers |= 1; rest = rest.slice(5); } else break;
  }
  const key = ({ '⌫': DEL, '+': '=', '−': '-' } as Record<string, string>)[rest] ?? rest.toLowerCase();
  const d = SHORTCUTS.find(x => x.group === 'Menus' && same(x.original, { key, modifiers }));
  return d && !same(chordFor(d), d.original) ? chordLabel(chordFor(d)) : s;
}
