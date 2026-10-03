// Crash-safe autosave and background memory release (the iOS Safari "page reloads when I come back" bug).
// Run against a build: URL=http://localhost:4194/Compositor/ [BROWSER=webkit] node tests/autosave.mjs
import { chromium, webkit } from 'playwright';
const URL_ = process.env.URL ?? 'http://localhost:4173/';
const useWebkit = process.env.BROWSER === 'webkit';
const browser = await (useWebkit ? webkit : chromium).launch(useWebkit ? {} : { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const assert = (c, m) => { if (!c) throw new Error('assertion failed: ' + m); };
const step = async (name, fn) => { process.stdout.write(`• ${name} … `); await fn(); console.log('ok'); };
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept()); // beforeunload with unsaved work
const ready = () => page.waitForFunction(() => window.compositor?.autosave);
const state = () => page.evaluate(() => { const { app } = window.compositor; return { n: app.projects.length, current: app.current, names: app.projects.map(p => p.doc.name), layers: app.projects.map(p => p.doc.layers.length), dirty: app.projects.map(p => p.doc.dirty) }; });
const pixel = (x, y) => page.evaluate(([x, y]) => { const { app } = window.compositor; return Array.from(app.renderer.readPixel(app.doc, x, y)); }, [x, y]);
const stored = () => page.evaluate(() => new Promise(res => { const r = indexedDB.open('compositor-autosave'); r.onsuccess = () => { const d = r.result; if (!d.objectStoreNames.contains('docs')) { d.close(); return res(0); } const q = d.transaction('docs').objectStore('docs').count(); q.onsuccess = () => { d.close(); res(q.result); }; }; }));
let failed = false;
try {
  await step('open the sample and a painted canvas; autosave writes both while idle', async () => {
    await page.goto(URL_, { waitUntil: 'networkidle' }); await ready();
    await page.getByText('Try a sample').click();
    await page.waitForFunction(() => window.compositor.app.doc?.layers.length === 4);
    await page.evaluate(() => {
      const { app } = window.compositor;
      app.newCanvas(320, 200, 'Painted');
      const l = app.active, c = app.ownPixels(l), x = c.getContext('2d');
      x.fillStyle = '#ff0000'; x.fillRect(40, 40, 100, 60); l.name = 'Red box'; app.changed('pixels');
    });
    const s = await state();
    assert(s.n === 2 && s.current === 1, 'two projects ' + JSON.stringify(s));
    // Idle autosave: within a few seconds without input.
    const t0 = Date.now();
    while ((await stored()) < 2 && Date.now() - t0 < 10000) await page.waitForTimeout(250);
    assert((await stored()) === 2, 'both stored: ' + await stored());
  });
  let before;
  await step('reload (what iOS does after killing the tab): both documents come back, pixels and names intact', async () => {
    before = await state();
    await page.evaluate(() => { window.__notReloaded = true; });
    await page.reload({ waitUntil: 'networkidle' }); await ready();
    await page.waitForFunction(() => window.compositor.app.projects.length >= 2, null, { timeout: 10000 });
    const after = await state();
    assert(!(await page.evaluate(() => window.__notReloaded)), 'it really reloaded');
    assert(JSON.stringify(after.names) === JSON.stringify(before.names), 'names ' + JSON.stringify([before, after]));
    assert(JSON.stringify(after.layers) === JSON.stringify(before.layers), 'layers ' + JSON.stringify([before, after]));
    assert(after.current === before.current, 'current tab ' + JSON.stringify([before, after]));
    assert(after.dirty[1] === true, 'still unsaved');
    const name = await page.evaluate(() => window.compositor.app.projects[1].doc.layers.at(-1).name);
    assert(name === 'Red box', 'layer name ' + name);
    const px = await pixel(80, 60), out = await pixel(250, 150);
    assert(px[0] > 240 && px[1] < 15 && px[3] > 240, 'painted pixel ' + px);
    assert(out[0] < 15 || out[3] < 15, 'unpainted pixel ' + out);
    assert(await page.locator('.toast', { hasText: 'Restored 2 documents' }).count() === 1, 'restore toast');
    assert((await stored()) === 2, 'entries adopted, not duplicated: ' + await stored());
  });
  await step('background: GPU caches and old undo steps are released; the canvas redraws the same', async () => {
    const before = await pixel(80, 60);
    await page.evaluate(() => window.compositor.autosave.releaseBackgroundMemory());
    const after = await pixel(80, 60);
    assert(JSON.stringify(before) === JSON.stringify(after), 'same pixel ' + JSON.stringify([before, after]));
  });
  await step('WebGL context lost and restored: no reload, the canvas comes back', async () => {
    await page.evaluate(() => { window.__notReloaded = true; });
    const ok = await page.evaluate(async () => {
      const { app } = window.compositor; const ext = app.renderer.gl.getExtension('WEBGL_lose_context'); if (!ext) return 'no-ext';
      const T = ms => new Promise(r => setTimeout(() => r('timeout'), ms)); if (app.renderer.gl.isContextLost()) return 'already-lost';
      const lost = Promise.race([new Promise(r => app.renderer.canvas.addEventListener('webglcontextlost', () => r('lost'), { once: true })), T(5000)]);
      ext.loseContext(); if (await lost === 'timeout') return 'no lost event'; await new Promise(r => setTimeout(r, 200)); // restoring from inside the lost event's dispatch is ignored
      const back = Promise.race([new Promise(r => app.renderer.canvas.addEventListener('webglcontextrestored', () => r('back'), { once: true })), T(5000)]);
      ext.restoreContext(); if (await back === 'timeout') return 'no restored event'; await new Promise(r => setTimeout(r, 300));
      return 'ok';
    });
    assert(await page.evaluate(() => window.__notReloaded), 'no reload');
    if (ok === 'ok') { const px = await pixel(80, 60); assert(px[0] > 240 && px[1] < 15, 'redrawn after restore ' + px); }
    else throw new Error('context loss: ' + ok);
  });
  await step('a second tab does not take documents that are still open in the first', async () => {
    const p2 = await context.newPage(); p2.on('dialog', d => d.accept());
    await p2.goto(URL_, { waitUntil: 'networkidle' }); await p2.waitForFunction(() => window.compositor?.autosave);
    await p2.waitForTimeout(1000);
    const n = await p2.evaluate(() => window.compositor.app.projects.length);
    await p2.close();
    assert(n === 0, 'second tab restored ' + n);
  });
  await step('going to the background saves at once (no idle wait) and frees memory', async () => {
    const times = () => page.evaluate(() => new Promise(res => { const r = indexedDB.open('compositor-autosave'); r.onsuccess = () => { const d = r.result; const q = d.transaction('docs').objectStore('docs').getAll(); q.onsuccess = () => { d.close(); res(q.result.map(e => e.time).sort().at(-1)); }; }; }));
    const t0 = await times();
    await page.evaluate(() => {
      const { app } = window.compositor; const l = app.active, c = app.ownPixels(l); c.getContext('2d').fillRect(0, 0, 10, 10); app.changed('pixels');
      window.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch' })); // a finger is still down: idle saving would wait
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(700);
    const t1 = await times();
    await page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' })); });
    assert(t1 > t0, 'saved on hidden ' + [t0, t1]);
  });
  await step('closing a document drops its autosave; the next launch restores only what was open', async () => {
    await page.evaluate(() => { const { app } = window.compositor; app.projects[0].doc.dirty = false; app.closeProject(0); });
    const t0 = Date.now();
    while ((await stored()) !== 1 && Date.now() - t0 < 10000) await page.waitForTimeout(250);
    assert((await stored()) === 1, 'one left: ' + await stored());
    await page.reload({ waitUntil: 'networkidle' }); await ready();
    await page.waitForFunction(() => window.compositor.app.projects.length >= 1, null, { timeout: 10000 });
    const s = await state();
    assert(s.n === 1 && s.names[0] === 'Painted', 'restored ' + JSON.stringify(s));
  });
  await step('no automatic reload on the code paths that could have caused one', async () => {
    const src = await page.evaluate(async () => { const urls = [...document.scripts].map(s => s.src).filter(Boolean); let t = ''; for (const u of urls) t += await (await fetch(u)).text(); t += await (await fetch(new URL('sw.js', location.href))).text(); return t; });
    const reloads = (src.match(/location\.reload\(\)/g) ?? []).length;
    assert(reloads <= 1, 'only the user-confirmed update reload: ' + reloads);
    assert(!/install[^]{0,200}skipWaiting\(\)\)/.test(src), 'no skipWaiting on install');
  });
  assert(!errors.length, 'page errors:\n' + errors.join('\n'));
} catch (e) { failed = true; console.log('\nFAILED:', e.message); await page.screenshot({ path: '/tmp/autosave-failure.png' }).catch(() => {}); }
await browser.close();
if (failed) process.exit(1);
console.log('Autosave checks passed.');
