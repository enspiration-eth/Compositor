// File › Open Recent (RecentProjects.swift). macOS keeps that list for the Mac app; here it lives in IndexedDB.
// Each entry keeps the project's file handle when the browser gave us one (Chromium's save/open pickers), so
// reopening reads the file as it is now and Save writes back to it; otherwise it keeps a copy of the bytes as they
// were last opened or saved. Ten projects at most, newest first.

export interface RecentEntry { key: string; name: string; fileName: string; time: number; handle?: FileSystemFileHandle; blob?: Blob }

const DB = 'compositor', STORE = 'recent', LIMIT = 10;
let cache: RecentEntry[] = [];
const listeners = new Set<() => void>();

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'key' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode), s = t.objectStore(STORE), r = fn(s);
    t.oncomplete = () => { d.close(); res(r ? r.result : undefined); }; t.onerror = () => { d.close(); rej(t.error); };
  });
}

/** The list as last loaded, newest first (menus are built synchronously). */
export function recentProjects(): readonly RecentEntry[] { return cache; }
export function onRecentChange(fn: () => void) { listeners.add(fn); }
export async function loadRecent() {
  try { cache = ((await tx<RecentEntry[]>('readonly', s => s.getAll())) ?? []).sort((a, b) => b.time - a.time); }
  catch { cache = []; }
  listeners.forEach(f => f());
}
/** Notes a project that was just opened or saved, by handle or by bytes. */
export async function noteRecent(fileName: string, from: { handle?: FileSystemFileHandle; blob?: Blob }) {
  const name = fileName.replace(/\.comp\.zip$|\.comp$|\.zip$|\.psd$/i, '');
  try {
    const dupes: string[] = [];
    for (const e of cache) {
      if (e.fileName === fileName && !e.handle && !from.handle) dupes.push(e.key);
      else if (from.handle && e.handle && await from.handle.isSameEntry(e.handle)) dupes.push(e.key);
    }
    const entry: RecentEntry = { key: `${Date.now()}-${Math.random().toString(36).slice(2)}`, name, fileName, time: Date.now(), ...(from.handle ? { handle: from.handle } : { blob: from.blob }) };
    const stale = [...dupes, ...cache.filter(e => !dupes.includes(e.key)).slice(LIMIT - 1).map(e => e.key)];
    await tx('readwrite', s => { for (const k of stale) s.delete(k); s.put(entry); });
  } catch (e) { console.warn('recent projects', e); }
  await loadRecent();
}
export async function forgetRecent(key: string) { try { await tx('readwrite', s => s.delete(key)); } catch { /* ignore */ } await loadRecent(); }
export async function clearRecent() { try { await tx('readwrite', s => s.clear()); } catch { /* ignore */ } await loadRecent(); }
/** The entry's file as it is now; a handle asks for read permission again if the browser dropped it. */
export async function recentFile(e: RecentEntry): Promise<File> {
  if (e.handle) {
    const h = e.handle as FileSystemFileHandle & { queryPermission?: (o: object) => Promise<string>; requestPermission?: (o: object) => Promise<string> };
    if (h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted' && h.requestPermission) await h.requestPermission({ mode: 'readwrite' });
    return h.getFile();
  }
  if (!e.blob) throw new Error('nothing stored');
  return new File([e.blob], e.fileName, { type: e.blob.type });
}
