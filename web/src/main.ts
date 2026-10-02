import './styles.css';
import { loadKernels } from './engine/kernels';
import { app } from './ui/app';
import { buildLayout, loadSample } from './ui/layout';

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
  if (new URLSearchParams(location.search).has('sample')) await loadSample();
  window.addEventListener('beforeunload', e => { if (app.projects.some(p => p.doc.dirty)) { e.preventDefault(); e.returnValue = ''; } });
}
boot().finally(() => splashShown.then(hideSplash));

// Installable PWA: the service worker (generated at build time) caches the app shell and the wasm engine.
// Automated test browsers skip it unless the URL asks for it with ?sw, so smoke runs always see fresh files.
if (import.meta.env.PROD && 'serviceWorker' in navigator && (!navigator.webdriver || new URLSearchParams(location.search).has('sw'))) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(e => console.warn('service worker:', e)); });
}
