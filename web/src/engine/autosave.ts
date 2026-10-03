// Crash-safe autosave. iOS Safari kills a background tab's web content process when memory runs short and reloads the
// page when the user comes back; without this every open document would be gone. Each open project is kept in
// IndexedDB as a .comp package (the same zip File › Save writes) with its tab order and view, written when the tab is
// hidden, on pagehide, and every few seconds of idle after an edit. The next launch restores whatever a page that
// is no longer running left behind. Each page holds a Web Lock for its session, so a second open tab of the app
// doesn't take documents that are still open in the first.

export interface AutosaveEntry {
  id: string; session: string; order: number; current: boolean; name: string; dirty: boolean; time: number;
  bytes: ArrayBuffer; view: { zoom: number; ox: number; oy: number; fitted: boolean }; fileHandle?: unknown;
}

const DB = 'compositor-autosave', STORE = 'docs', LOCK = 'pseth-session-';
export const sessionId = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
let locked: Promise<boolean> | null = null;

/** Holds this page's session lock for as long as the page lives. */
export function holdSessionLock(): Promise<boolean> {
  if (locked) return locked;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) return (locked = Promise.resolve(false));
  locked = new Promise(res => {
    locks.request(LOCK + sessionId, () => { res(true); return new Promise(() => {}); }).catch(() => res(false));
  });
  return locked;
}
async function liveSessions(): Promise<Set<string> | null> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks?.query) return null;
  try {
    const q = await locks.query();
    return new Set([...(q.held ?? []), ...(q.pending ?? [])].map(l => l.name ?? '').filter(n => n.startsWith(LOCK)).map(n => n.slice(LOCK.length)));
  } catch { return null; }
}

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  return dbp ??= new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' }); };
    r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); dbp = null; }; res(r.result); };
    r.onerror = () => { dbp = null; rej(r.error); };
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode), r = fn(t.objectStore(STORE));
    t.oncomplete = () => res(r ? r.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}

export async function putEntry(e: AutosaveEntry) { await tx('readwrite', s => { s.put(e); }); }
/** Rewrites the order/current flags of this session's entries and drops the ones whose project was closed. */
export async function syncSession(open: { id: string; order: number; current: boolean; name: string; dirty: boolean }[]) {
  const byId = new Map(open.map(o => [o.id, o]));
  await tx('readwrite', s => {
    const r = s.openCursor();
    r.onsuccess = () => {
      const c = r.result; if (!c) return;
      const e = c.value as AutosaveEntry;
      if (e.session === sessionId) {
        const o = byId.get(e.id);
        if (!o) c.delete();
        else if (o.order !== e.order || o.current !== e.current || o.name !== e.name || o.dirty !== e.dirty) c.update({ ...e, ...o });
      }
      c.continue();
    };
  });
}
/** Entries left by pages that are no longer running, in tab order. */
export async function orphanedEntries(): Promise<AutosaveEntry[]> {
  const all = ((await tx<AutosaveEntry[]>('readonly', s => s.getAll())) ?? []);
  let live = await liveSessions();
  // Right after a reload the old page's lock can outlive it by a moment; look once more before leaving its entries.
  if (live && all.some(e => e.session !== sessionId && live!.has(e.session))) { await new Promise(r => setTimeout(r, 600)); live = await liveSessions(); }
  return all.filter(e => e.session !== sessionId && (!live || !live.has(e.session))).sort((a, b) => a.session === b.session ? a.order - b.order : a.session < b.session ? -1 : 1);
}
export async function deleteEntries(ids: string[]) { if (ids.length) await tx('readwrite', s => { for (const id of ids) s.delete(id); }); }
