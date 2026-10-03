// Keeps open documents safe across an iOS Safari tab reload (see engine/autosave.ts), and gives the GPU, the undo
// history and the worker heaps back while the page is in the background so that reload happens less often.
import { app, type Project } from './app';
import { toast } from './dom';
import { readCompZip, writeComp } from '../engine/files';
import { limits } from '../engine/limits';
import { releaseFilterPool } from '../engine/filterPool';
import { releaseSegmenter } from '../engine/segment';
import { deleteEntries, holdSessionLock, orphanedEntries, putEntry, sessionId, syncSession, type AutosaveEntry } from '../engine/autosave';

const keys = new WeakMap<Project, string>();
const savedSig = new WeakMap<Project, string>();
const pngCaches = new WeakMap<Project, Map<string, Uint8Array>>();
let lastInput = 0, pointersDown = 0, metaSig = '', running: Promise<void> | null = null, again = false, enabled = true;
const IDLE_MS = 1500, TICK_MS = 2000;

const keyOf = (p: Project) => { let k = keys.get(p); if (!k) { k = `${sessionId}:${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`; keys.set(p, k); } return k; };
/** Everything the .comp package records, cheaply: pixel changes show up as layer revisions. */
function sigOf(p: Project) {
  const d = p.doc;
  return `${d.name}|${d.width}x${d.height}|${d.resolution}|${d.activeId}|${JSON.stringify(d.guides)}|` + d.layers.map(l =>
    `${l.id}:${l.rev}:${l.name}:${l.visible}:${l.opacity}:${l.blend}:${l.parentId}:${l.isGroup}:${l.clipTo}:${!!l.mask}:${l.maskEnabled}:${l.maskLinked}:${JSON.stringify(l.transform)}:${JSON.stringify(l.maskPlacement ?? null)}` +
    `:${l.adjustment ? JSON.stringify(l.adjustment) : ''}:${l.text ? JSON.stringify(l.text) : ''}:${l.shape ? JSON.stringify(l.shape) : ''}:${l.effects ? JSON.stringify(l.effects) : ''}`).join(';');
}
const metaOf = () => app.projects.map((p, i) => ({ id: keyOf(p), order: i, current: i === app.current, name: p.doc.name, dirty: p.doc.dirty }));

async function saveProject(p: Project, order: number) {
  const sig = sigOf(p);
  if (savedSig.get(p) === sig) return;
  let cache = pngCaches.get(p); if (!cache) { cache = new Map(); pngCaches.set(p, cache); }
  const bytes = await writeComp(p.doc, cache);
  if (!app.projects.includes(p)) return; // closed meanwhile
  const e: AutosaveEntry = { id: keyOf(p), session: sessionId, order, current: app.project === p, name: p.doc.name, dirty: p.doc.dirty, time: Date.now(),
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, view: { zoom: p.zoom, ox: p.ox, oy: p.oy, fitted: p.fitted } };
  if (p.doc.fileHandle) e.fileHandle = p.doc.fileHandle;
  try { await putEntry(e); }
  catch (err) { if (!e.fileHandle) throw err; delete e.fileHandle; await putEntry(e); } // a handle the browser can't store
  savedSig.set(p, sig);
}
/** Writes every project that changed since its last autosave and drops the ones that were closed. */
export function flushAutosave(): Promise<void> {
  if (!enabled) return Promise.resolve();
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      do {
        again = false;
        const projects = [...app.projects];
        for (let i = 0; i < projects.length; i++) await saveProject(projects[i], i);
        const meta = metaOf(), ms = JSON.stringify(meta);
        if (ms !== metaSig) { await syncSession(meta); metaSig = ms; }
      } while (again);
    } catch (err) { console.warn('autosave', err); }
    finally { running = null; }
  })();
  return running;
}
const idle = () => !pointersDown && performance.now() - lastInput > IDLE_MS && !app.busy;

/** Gives back memory that can be rebuilt: GPU textures and caches, older undo steps on phones, idle worker heaps. */
export function releaseBackgroundMemory() {
  try { app.renderer.releaseMemory(); app.needsRender = true; } catch (err) { console.warn(err); }
  if (limits.mobile) app.projects.forEach((p, i) => p.history.trim(i === app.current ? 10 : 2, i === app.current ? 10 : 0));
  releaseFilterPool();
  if (!app.busy) releaseSegmenter();
}

/** Restores the documents a page that is no longer running left behind (a Safari tab reload, a crash, a closed tab
 *  with unsaved work). Returns how many came back. */
export async function restoreAutosave(): Promise<number> {
  await holdSessionLock();
  let entries: AutosaveEntry[];
  try { entries = await orphanedEntries(); } catch (err) { console.warn('autosave', err); return 0; }
  if (!entries.length) return 0;
  const first = app.projects.length;
  let current: Project | null = null;
  const adopted: AutosaveEntry[] = [], dead: string[] = [];
  for (const e of entries) {
    try {
      const doc = await readCompZip(new Uint8Array(e.bytes), e.name);
      doc.name = app.uniqueName(e.name); doc.dirty = e.dirty;
      if (e.fileHandle) doc.fileHandle = e.fileHandle;
      app.addProject(doc);
      const p = app.project!;
      if (e.view.fitted) app.fit(); else { p.zoom = e.view.zoom; p.ox = e.view.ox; p.oy = e.view.oy; p.fitted = false; }
      if (e.current) current = p;
      // Take the entry over as is (no re-encoding): same bytes under this page's session.
      const key = keyOf(p); savedSig.set(p, sigOf(p));
      adopted.push({ ...e, id: key, session: sessionId, name: doc.name, order: app.projects.length - 1 });
      dead.push(e.id);
    } catch (err) { console.warn('autosave: could not restore', e.name, err); dead.push(e.id); }
  }
  try { for (const a of adopted) await putEntry(a); await deleteEntries(dead); } catch (err) { console.warn('autosave', err); }
  if (current) app.switchTo(app.projects.indexOf(current));
  const n = app.projects.length - first;
  if (n) toast(n === 1 ? `Restored “${app.projects[first].doc.name}” from your last session` : `Restored ${n} documents from your last session`);
  return n;
}

export function installAutosave() {
  void holdSessionLock();
  const input = () => { lastInput = performance.now(); };
  window.addEventListener('pointerdown', () => { pointersDown++; input(); }, true);
  const up = () => { pointersDown = Math.max(0, pointersDown - 1); input(); };
  window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
  window.addEventListener('keydown', input, true);
  setInterval(() => { if (document.visibilityState === 'visible' && idle()) void flushAutosave(); }, TICK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { pointersDown = 0; void flushAutosave(); releaseBackgroundMemory(); }
    else app.needsRender = true;
  });
  // pagehide: the last chance (bfcache or unload). The write may not finish, which is why hidden and idle save too.
  window.addEventListener('pagehide', () => { void flushAutosave(); });
  window.addEventListener('pageshow', e => { if ((e as PageTransitionEvent).persisted) app.needsRender = true; });
}
/** Test hook and for a deliberate reload after an update: stop writing (the state is already saved). */
export function pauseAutosave() { enabled = false; }
