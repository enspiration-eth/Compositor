import './styles.css';
import { loadKernels } from './engine/kernels';
import { app } from './ui/app';
import { buildLayout, loadSample } from './ui/layout';

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
  catch (e) { root.innerHTML = `<div class="boot error">Compositor couldn’t start (it needs WebGL 2): ${(e as Error).message}</div>`; throw e; }
  app.emit('all');
  if (new URLSearchParams(location.search).has('sample')) await loadSample();
  window.addEventListener('beforeunload', e => { if (app.projects.some(p => p.doc.dirty)) { e.preventDefault(); e.returnValue = ''; } });
}
boot();
