import './styles.css';
import { loadKernels } from './engine/kernels';
import { app } from './ui/app';
import { buildLayout, loadSample } from './ui/layout';
import { flushAutosave, installAutosave, pauseAutosave, releaseBackgroundMemory, restoreAutosave } from './ui/autosave';

// The launch splash (index.html): up for at least two seconds and until the app has started; a click dismisses it.
const splash = document.getElementById('splash');
const splashShown = new Promise(r => setTimeout(r, 2000));
function hideSplash() {
  if (!splash || splash.classList.contains('out')) return;
  splash.classList.add('out');
  setTimeout(() => splash.remove(), 250);
}
splash?.addEventListener('click', hideSplash);
if (navigator.webdriver) splash?.remove(); // Smoke tests click straight away.

async function boot() {
  const root = document.getElementById('app')!;
  try {
    await loadKernels();
  } catch (e) {
    root.innerHTML = `<div class="boot error">Couldn’t load the WebAssembly pixel engine: ${(e as Error).message}</div>`;
    throw e;
  }
  root.innerHTML = '';
  try { buildLayout(root); }
  catch (e) { root.innerHTML = `<div class="boot error">Photoshop.eth couldn’t start (it needs WebGL 2): ${(e as Error).message}</div>`; throw e; }
  app.emit('all');
  installAutosave();
  Object.assign((window as unknown as { compositor: object }).compositor, { autosave: { flush: flushAutosave, releaseBackgroundMemory } });
  await restoreAutosave();
  if (new URLSearchParams(location.search).has('sample')) await loadSample();
  window.addEventListener('beforeunload', e => { if (!updating && app.projects.some(p => p.doc.dirty)) { e.preventDefault(); e.returnValue = ''; } });
}
let updating = false;
boot().finally(() => splashShown.then(hideSplash));

// Installable app (manifest.webmanifest) that starts offline: the service worker caches the shell and the wasm.
// A new deploy never takes over a running page by itself (that could reload it, or pull the old build's lazy chunks
// out of the cache under it): the new worker waits, and the page offers a reload. Taking it is the user's choice, and
// the open documents are autosaved first so they come back after the reload.
if ('serviceWorker' in navigator && import.meta.env.PROD && /^https?:$/.test(location.protocol)) {
  const sw = navigator.serviceWorker;
  let requested = false, lastCheck = Date.now();
  const offer = (w: ServiceWorker) => {
    // Just launched: this page already runs the new build (index.html is fetched network first),
    // so take the update quietly, no reload needed.
    if (performance.now() < 20e3) { requested = false; w.postMessage({ type: 'skip-waiting' }); return; }
    import('./ui/dom').then(m => m.toast('An update to Photoshop.eth is available.', 'info', { label: 'Reload', id: 'update-reload', run: () => {
      requested = true; updating = true;
      void flushAutosave().then(() => { pauseAutosave(); w.postMessage({ type: 'skip-waiting' }); });
    } }));
  };
  const watch = (reg: ServiceWorkerRegistration) => {
    if (reg.waiting && sw.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing; if (!w) return;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && sw.controller) offer(w); });
    });
    // Look for a new deploy when the app comes back to the front, at most every 30 minutes. Only looks: see offer().
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - lastCheck > 30 * 60e3) { lastCheck = Date.now(); reg.update().catch(() => {}); }
    });
  };
  window.addEventListener('load', () => { sw.register(`${import.meta.env.BASE_URL}sw.js`).then(watch).catch(e => console.warn('service worker', e)); });
  sw.addEventListener('controllerchange', () => { if (requested) location.reload(); });
}
