// Mobile and touch smoke test: the production build in Playwright device emulation (iPhone 15, Pixel 7, iPad Pro 11,
// a landscape phone), with real touch input through the Chrome DevTools protocol (taps, pinch, two- and three-finger
// taps, long-press). Usage: npm run build && npm run test:mobile  (SHOTS=dir for the mobile-*.png screenshots;
// MOBILE_BROWSER=webkit runs the layout checks in WebKit, without the multi-touch steps CDP is needed for).
import { chromium, webkit, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PORT = process.env.PREVIEW_PORT || '4175';
const URL_ = process.env.URL || `http://localhost:${PORT}/`;
const SHOTS = process.env.SHOTS || '/workspace/compositor-shots';
mkdirSync(SHOTS, { recursive: true });
let server;
if (!process.env.URL) {
  server = spawn('npx', ['vite', 'preview', '--port', PORT, '--strictPort'], { stdio: 'pipe', detached: true });
  await new Promise((res, rej) => {
    server.stdout.on('data', d => { if (String(d).includes(PORT)) res(); });
    server.on('exit', c => rej(new Error('preview exited ' + c)));
    setTimeout(() => rej(new Error('preview timeout')), 20000);
  });
}
const isWebkit = process.env.MOBILE_BROWSER === 'webkit';
const engine = isWebkit ? webkit : chromium;
const browser = await engine.launch(isWebkit ? {} : { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const assert = (c, msg) => { if (!c) throw new Error('assertion failed: ' + msg); };
const errors = [];
let failed = false;

// MOBILE_ONLY="<substring>[|…]" runs just the matching device checks.
const ONLY = process.env.MOBILE_ONLY ? process.env.MOBILE_ONLY.split('|') : null;
async function device(name, desc, fn) {
  if (ONLY && !ONLY.some(o => name.includes(o))) return;
  process.stdout.write(`• ${name} … `);
  const { defaultBrowserType, ...opts } = desc;
  const ctx = await browser.newContext({ ...opts, ...(isWebkit ? { isMobile: undefined } : {}) });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`${name} pageerror: ${e.stack || e.message}`));
  try {
    await page.goto(URL_, { waitUntil: 'networkidle' });
    await page.waitForSelector('#stage canvas.gl-canvas');
    const cdp = isWebkit ? null : await ctx.newCDPSession(page);
    await fn(page, cdp);
    console.log('ok');
  } catch (e) {
    failed = true; console.log('FAILED\n  ' + e.message);
    await page.screenshot({ path: `${SHOTS}/mobile-failure-${name.replace(/\W+/g, '-')}.png` }).catch(() => {});
  }
  await ctx.close();
}

// ---------- helpers ----------
const fits = page => page.evaluate(() => {
  const vw = innerWidth, vh = innerHeight, sw = document.documentElement.scrollWidth, sh = document.documentElement.scrollHeight;
  const stage = document.getElementById('stage').getBoundingClientRect();
  return { vw, vh, sw, sh, stageW: stage.width, stageH: stage.height, compact: document.documentElement.classList.contains('compact'), touch: document.documentElement.classList.contains('touch') };
});
const st = page => page.evaluate(() => { const { app } = window.compositor; return { zoom: app.project?.zoom, undo: app.history?.undoStack.length, redo: app.history?.redoStack.length, layers: app.doc?.layers.length, tool: app.tool }; });
const stageCenter = page => page.evaluate(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
const touch = (cdp, type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 })) });
const wait = ms => new Promise(r => setTimeout(r, ms));
async function fingerDrag(cdp, from, to, steps = 8) {
  await touch(cdp, 'touchStart', [from]);
  for (let i = 1; i <= steps; i++) { await touch(cdp, 'touchMove', [[from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps]]); await wait(16); }
  await touch(cdp, 'touchEnd', []);
}
async function multiTap(cdp, pts) { await touch(cdp, 'touchStart', pts); await wait(60); await touch(cdp, 'touchEnd', []); await wait(80); }
async function tap(page, sel) { await page.locator(sel).first().scrollIntoViewIfNeeded(); const b = await page.locator(sel).first().boundingBox(); assert(b, 'no ' + sel); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); await wait(250); }
async function loadSample(page) {
  await tap(page, 'button:has-text("Try a sample")');
  await page.waitForFunction(() => window.compositor.app.doc?.layers.length >= 4);
  await wait(400);
}
const minTarget = page => page.evaluate(() => {
  // The smallest finger target among the primary controls (rail tools, toolbar buttons, layer footer, mod keys).
  const els = [...document.querySelectorAll('.rail-btn, .toolbar .tb-btn, .mod-key')].filter(e => e.offsetParent);
  return Math.min(...els.map(e => { const r = e.getBoundingClientRect(); return Math.max(r.width, r.height) >= 40 ? Math.min(r.width, r.height) : Math.min(r.width, r.height); }));
});

async function phoneChecks(page, cdp, tag) {
  let f = await fits(page);
  assert(f.compact && f.touch, 'phone layout on ' + JSON.stringify(f));
  assert(f.sw <= f.vw + 1, 'no horizontal overflow on the welcome screen ' + JSON.stringify(f));
  const card = await page.locator('.welcome-card').boundingBox();
  assert(card && card.x >= 0 && card.x + card.width <= f.vw + 1, 'New canvas card fits ' + JSON.stringify(card));
  await page.screenshot({ path: `${SHOTS}/mobile-${tag}-welcome.png` });
  // Phones cap documents at 4096 × 4096 worth of pixels.
  await page.fill('#new-width', '8000'); await page.fill('#new-height', '6000');
  assert(await page.isDisabled('#create-canvas') && /Too large for this device/.test(await page.textContent('#new-hint')), 'device size limit');
  await page.fill('#new-width', '1920'); await page.fill('#new-height', '1080');
  assert(!(await page.isDisabled('#create-canvas')), 'normal sizes allowed');
  await loadSample(page);
  f = await fits(page);
  let s = await st(page);
  assert(f.stageW >= f.vw - 20 && f.stageH > 200, 'stage fills the width ' + JSON.stringify(f));
  assert(s.zoom > 0.1 && s.zoom < 1, 'fitted zoom ' + s.zoom);
  assert(f.sw <= f.vw + 1, 'no horizontal overflow with a document ' + JSON.stringify(f));
  const mt = await minTarget(page);
  assert(mt >= 36, 'touch targets at least 36 px (44 for tools): ' + mt);
  const rail = await page.locator('.rail-btn').first().boundingBox();
  assert(rail.width >= 44 && rail.height >= 44, 'tool buttons are 44 px ' + JSON.stringify(rail));
  await page.screenshot({ path: `${SHOTS}/mobile-${tag}-sample.png` });

  // Layers bottom sheet.
  assert(!(await page.locator('.layers-panel').isVisible()) || (await page.locator('.layers-sheet').boundingBox()).y >= f.vh - 2, 'layers sheet starts closed');
  await tap(page, '#layers-toggle');
  await wait(300);
  const sheet = await page.locator('.layers-sheet').boundingBox();
  assert(await page.evaluate(() => document.documentElement.classList.contains('layers-open')), 'layers sheet opens');
  assert(sheet.y > 0 && sheet.y + sheet.height <= f.vh + 1 && sheet.width <= f.vw + 1, 'layers sheet inside the viewport ' + JSON.stringify(sheet));
  assert(await page.locator('.layer-row').count() >= 4, 'layer rows in the sheet');
  const row = await page.locator('.layer-row').first().boundingBox();
  assert(row.height >= 44, 'layer rows are 44 px+ ' + row.height);
  await page.screenshot({ path: `${SHOTS}/mobile-${tag}-layers.png` });
  // Long-press a layer row: its context menu.
  await touch(cdp, 'touchStart', [[row.x + row.width / 2, row.y + row.height / 2]]); await wait(750); await touch(cdp, 'touchEnd', []); await wait(200);
  assert(await page.locator('.menu .menu-item').count() > 3, 'long-press on a layer row opens its menu');
  const mb = await page.locator('.menu').first().boundingBox();
  assert(mb.x >= 0 && mb.x + mb.width <= f.vw + 1 && mb.y >= 0 && mb.y + mb.height <= f.vh + 1, 'row menu fits ' + JSON.stringify(mb));
  await page.screenshot({ path: `${SHOTS}/mobile-${tag}-layer-menu.png` });
  assert(await page.evaluate(() => !document.querySelector('.rename')), 'lifting the finger did not pick the menu item under it');
  await tap(page, '.hdr-title'); // a tap outside closes the menu
  // Blend mode popup without hover: a tap previews, a second tap keeps.
  const b0 = await page.evaluate(() => ({ blend: window.compositor.app.active.blend, undo: window.compositor.app.history.undoStack.length }));
  await tap(page, '.blend-popup');
  assert(await page.locator('#blend-list').count() === 1, 'blend list opens');
  await tap(page, '#blend-list .menu-item[data-id="Multiply"]');
  let b1 = await page.evaluate(() => ({ blend: window.compositor.app.active.blend, open: !!document.getElementById('blend-list') }));
  assert(b1.open && b1.blend === 'Multiply', 'first tap previews ' + JSON.stringify(b1));
  await page.screenshot({ path: `${SHOTS}/mobile-${tag}-blend-preview.png` });
  await tap(page, '#blend-list .menu-item[data-id="Multiply"]');
  b1 = await page.evaluate(() => ({ blend: window.compositor.app.active.blend, open: !!document.getElementById('blend-list'), undo: window.compositor.app.history.undoStack.length }));
  assert(!b1.open && b1.blend === 'Multiply' && b1.undo === b0.undo + 1, 'second tap keeps ' + JSON.stringify([b0, b1]));
  await page.evaluate(() => window.compositor.app.undo());
  await tap(page, '.sheet-handle');
  await wait(300);
  assert(!(await page.evaluate(() => document.documentElement.classList.contains('layers-open'))), 'handle closes the sheet');

  // Menus: they fit, and submenus drill down with a back item.
  await tap(page, '.menubar-item[data-menu="Layer"]');
  let m = await page.locator('.menu').first().boundingBox();
  assert(m && m.x >= 0 && m.x + m.width <= f.vw + 1 && m.y + m.height <= f.vh + 1, 'Layer menu fits ' + JSON.stringify(m));
  await tap(page, '.menu .menu-item.has-sub');
  assert(await page.locator('.menu .menu-item[data-id="menu-back"]').count() === 1, 'submenu replaces the menu with a back item');
  m = await page.locator('.menu').first().boundingBox();
  assert(m.x >= 0 && m.x + m.width <= f.vw + 1, 'submenu fits ' + JSON.stringify(m));
  await page.screenshot({ path: `${SHOTS}/mobile-${tag}-submenu.png` });
  await tap(page, '.menu .menu-item[data-id="menu-back"]');
  assert(await page.locator('.menu .menu-item.has-sub').count() >= 1, 'back to the parent menu');
  await tap(page, '.hdr-title'); // a tap outside closes the menu

  // A dialog fits: Image › Canvas Size….
  await page.evaluate(() => window.compositor.app.doc && null);
  await tap(page, '.menubar-item[data-menu="Image"]');
  await tap(page, '.menu .menu-item:has-text("Canvas Size")');
  const modal = await page.locator('.modal').first().boundingBox();
  assert(modal && modal.x >= 0 && modal.x + modal.width <= f.vw + 1 && modal.y + modal.height <= f.vh + 1, 'dialog fits ' + JSON.stringify(modal));
  await page.screenshot({ path: `${SHOTS}/mobile-${tag}-dialog.png` });
  await page.keyboard.press('Escape'); await wait(200);

  if (!cdp) return;
  // One finger paints with the brush.
  await tap(page, '.rail-btn[data-tool="brush"]');
  await page.evaluate(() => { const { app } = window.compositor; app.brush.size = 40; });
  const [cx, cy] = await stageCenter(page);
  s = await st(page);
  await fingerDrag(cdp, [cx - 80, cy - 20], [cx + 60, cy + 30]);
  await wait(200);
  const s1 = await st(page);
  assert(s1.undo === s.undo + 1, 'one finger painted a stroke ' + JSON.stringify([s, s1]));
  // Two-finger tap undoes, three-finger tap redoes.
  await multiTap(cdp, [[cx - 40, cy], [cx + 40, cy]]);
  let s2 = await st(page);
  assert(s2.undo === s.undo && s2.redo === s1.redo + 1, 'two-finger tap undid ' + JSON.stringify([s1, s2]));
  await multiTap(cdp, [[cx - 60, cy], [cx, cy], [cx + 60, cy]]);
  s2 = await st(page);
  assert(s2.undo === s1.undo, 'three-finger tap redid ' + JSON.stringify(s2));
  // Pinch out zooms in about the fingers, and doesn't paint.
  const z0 = s2.zoom;
  await touch(cdp, 'touchStart', [[cx - 30, cy], [cx + 30, cy]]);
  for (let i = 1; i <= 10; i++) { await touch(cdp, 'touchMove', [[cx - 30 - 8 * i, cy], [cx + 30 + 8 * i, cy]]); await wait(16); }
  await touch(cdp, 'touchEnd', []); await wait(200);
  let s3 = await st(page);
  assert(s3.zoom > z0 * 1.8 && s3.undo === s2.undo, 'pinch zoomed in without painting ' + JSON.stringify({ z0, s3 }));
  await page.screenshot({ path: `${SHOTS}/mobile-${tag}-pinched.png` });
  // Two-finger drag pans.
  const o0 = await page.evaluate(() => window.compositor.app.project.ox);
  await touch(cdp, 'touchStart', [[cx - 40, cy], [cx + 40, cy]]);
  for (let i = 1; i <= 8; i++) { await touch(cdp, 'touchMove', [[cx - 40 + 10 * i, cy], [cx + 40 + 10 * i, cy]]); await wait(16); }
  await touch(cdp, 'touchEnd', []); await wait(150);
  const o1 = await page.evaluate(() => window.compositor.app.project.ox);
  assert(Math.abs(o1 - o0 - 80) < 6, 'two-finger drag panned ' + (o1 - o0));
  // Long-press on the canvas: the canvas menu; Fit on Screen.
  await touch(cdp, 'touchStart', [[cx, cy]]); await wait(800); await touch(cdp, 'touchEnd', []); await wait(200);
  assert(await page.locator('.menu .menu-item[data-id="lp-fit"]').count() === 1, 'long-press canvas menu');
  const s4 = await st(page);
  assert(s4.undo === s3.undo, 'long-press left no brush dab ' + JSON.stringify([s3, s4]));
  await page.screenshot({ path: `${SHOTS}/mobile-${tag}-longpress.png` });
  await tap(page, '.menu .menu-item[data-id="lp-fit"]');
  assert(Math.abs((await st(page)).zoom - z0) < 0.02, 'Fit on Screen');
  // On-screen Shift: with the marquee, Shift adds a second rectangle to the selection.
  await tap(page, '.rail-btn[data-tool="marquee"]');
  await fingerDrag(cdp, [cx - 100, cy - 60], [cx - 30, cy]);
  const selCount = () => page.evaluate(() => { const c = window.compositor.app.doc.selection; if (!c) return 0; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 127) n++; return n; });
  const c1 = await selCount();
  await wait(400); // not a double tap
  await tap(page, '.mod-key[data-key="shift"]');
  assert(await page.locator('.mod-key[data-key="shift"].on').count() === 1, 'Shift latched ' + await page.evaluate(() => JSON.stringify({ menus: document.querySelectorAll('.menu').length, at: (() => { const b = document.querySelector('.mod-key[data-key="shift"]').getBoundingClientRect(); const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return e?.className + ' ' + e?.tagName; })(), modal: !!document.querySelector('.modal') })));
  await fingerDrag(cdp, [cx + 20, cy + 10], [cx + 90, cy + 60]);
  const c2 = await selCount();
  await tap(page, '.mod-key[data-key="shift"]');
  assert(c1 > 0 && c2 > c1 * 1.4, 'on-screen Shift added to the selection ' + JSON.stringify({ c1, c2 }));
  await page.screenshot({ path: `${SHOTS}/mobile-${tag}-shift-select.png` });
}

try {
  await device('iPhone 15 portrait', devices['iPhone 15'], (p, c) => phoneChecks(p, c, 'iphone15'));
  await device('Pixel 7 portrait', devices['Pixel 7'], (p, c) => phoneChecks(p, c, 'pixel7'));
  await device('iPhone 15 landscape', devices['iPhone 15 landscape'], async page => {
    const f = await fits(page);
    assert(f.compact && f.sw <= f.vw + 1, 'landscape phone layout ' + JSON.stringify(f));
    await loadSample(page);
    const g = await fits(page);
    assert(g.stageW > 300 && g.stageH > 120, 'landscape stage ' + JSON.stringify(g));
    await page.screenshot({ path: `${SHOTS}/mobile-iphone15-landscape.png` });
  });
  await device('iPad Pro 11 portrait', devices['iPad Pro 11'], async (page, cdp) => {
    const f = await fits(page);
    assert(!f.compact && f.touch && f.sw <= f.vw + 1, 'tablet keeps the desktop layout with touch targets ' + JSON.stringify(f));
    await loadSample(page);
    const g = await fits(page);
    assert(g.stageW > 400, 'tablet stage ' + JSON.stringify(g));
    assert(await page.locator('.layers-panel').isVisible(), 'layers panel docked');
    const rail = await page.locator('.rail-btn').first().boundingBox();
    assert(rail.width >= 44, 'tablet tool buttons 44 px');
    await page.screenshot({ path: `${SHOTS}/mobile-ipadpro11-sample.png` });
    if (cdp) {
      const [cx, cy] = await stageCenter(page);
      const z0 = (await st(page)).zoom;
      await touch(cdp, 'touchStart', [[cx - 50, cy], [cx + 50, cy]]);
      for (let i = 1; i <= 8; i++) { await touch(cdp, 'touchMove', [[cx - 50 + 4 * i, cy], [cx + 50 - 4 * i, cy]]); await wait(16); }
      await touch(cdp, 'touchEnd', []); await wait(150);
      assert((await st(page)).zoom < z0 * 0.8, 'pinch in zooms out');
    }
  });
  await device('iPad Pro 11 landscape', devices['iPad Pro 11 landscape'], async page => {
    await loadSample(page);
    const f = await fits(page);
    assert(!f.compact && f.sw <= f.vw + 1 && f.stageW > 600, 'tablet landscape ' + JSON.stringify(f));
    await page.screenshot({ path: `${SHOTS}/mobile-ipadpro11-landscape.png` });
  });
  // Stylus: pen pressure scales the brush and a finger on the canvas pans while a pen is in use (palm rejection).
  await device('iPad Pro 11 Apple Pencil', devices['iPad Pro 11'], async page => {
    await loadSample(page);
    await tap(page, '.rail-btn[data-tool="brush"]');
    const r = await page.evaluate(async () => {
      const { app } = window.compositor, stage = document.getElementById('stage'), b = stage.getBoundingClientRect();
      app.brush.size = 80; app.addBlankLayer();
      const fire = (type, x, y, o) => stage.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: b.left + x, clientY: b.top + y, buttons: type === 'pointerup' ? 0 : 1, button: 0, isPrimary: true, ...o }));
      const ink = () => { const c = app.active.canvas.getContext('2d'); const d = c.getImageData(0, 0, c.canvas.width, c.canvas.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; };
      const stroke = (y, pressure, id) => { const o = { pointerType: 'pen', pointerId: id, pressure }; fire('pointerdown', 100, y, o); for (let x = 110; x <= 300; x += 10) fire('pointermove', x, y, o); fire('pointerup', 300, y, { ...o, pressure: 0 }); };
      const before = ink(); stroke(b.height / 2 - 60, 0.15, 11); const light = ink() - before;
      const mid = ink(); stroke(b.height / 2 + 60, 1, 12); const heavy = ink() - mid;
      // A palm touching down while the pen is down is ignored.
      const u0 = app.history.undoStack.length;
      fire('pointerdown', 150, 40, { pointerType: 'pen', pointerId: 13, pressure: 0.5 });
      fire('pointerdown', 250, 300, { pointerType: 'touch', pointerId: 14, isPrimary: false });
      fire('pointermove', 260, 320, { pointerType: 'touch', pointerId: 14, isPrimary: false });
      fire('pointerup', 260, 320, { pointerType: 'touch', pointerId: 14, isPrimary: false });
      fire('pointerup', 150, 40, { pointerType: 'pen', pointerId: 13, pressure: 0 });
      const u1 = app.history.undoStack.length;
      // After the pen, one finger pans instead of painting.
      const ox = app.project.ox;
      fire('pointerdown', 200, 200, { pointerType: 'touch', pointerId: 15 }); fire('pointermove', 260, 200, { pointerType: 'touch', pointerId: 15 }); fire('pointerup', 260, 200, { pointerType: 'touch', pointerId: 15 });
      return { light, heavy, palmUndo: u1 - u0, panned: app.project.ox - ox, undo: app.history.undoStack.length - u1 };
    });
    assert(r.light > 0 && r.heavy > r.light * 2.5, 'pen pressure scales the brush ' + JSON.stringify(r));
    assert(r.palmUndo === 1, 'the palm touch added nothing (just the pen dab) ' + JSON.stringify(r));
    assert(Math.abs(r.panned - 60) < 2 && r.undo === 0, 'a finger pans once a pen is in use ' + JSON.stringify(r));
    assert(await page.locator('#brush-pressure').count() === 1, 'Pen Pressure option in the brush header');
    await page.screenshot({ path: `${SHOTS}/mobile-ipadpro11-pencil.png` });
  });
  // Without WebGL 2 (old phones, blocklisted GPUs) the app says so instead of failing silently.
  {
    process.stdout.write('• no WebGL 2 … ');
    const { defaultBrowserType, ...opts } = devices['Pixel 7'];
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript(() => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return t === 'webgl2' ? null : g.call(this, t, ...a); }; });
    const page = await ctx.newPage();
    page.on('pageerror', () => {}); // the boot error is expected
    await page.goto(URL_, { waitUntil: 'networkidle' });
    const msg = await page.locator('.boot.error').textContent({ timeout: 15000 }).catch(() => '');
    await page.screenshot({ path: `${SHOTS}/mobile-no-webgl2.png` });
    await ctx.close();
    if (/WebGL 2/.test(msg)) console.log('ok'); else { failed = true; console.log('FAILED\n  no WebGL 2 message: ' + msg); }
  }
  // The desktop layout is unchanged: no compact class, no modifier bar, docked layers panel.
  await device('desktop 1440×900', { viewport: { width: 1440, height: 900 } }, async page => {
    const f = await fits(page);
    assert(!f.compact && !f.touch, 'desktop layout ' + JSON.stringify(f));
    await loadSample(page).catch(async () => { await page.getByText('Try a sample').click(); await page.waitForFunction(() => window.compositor.app.doc?.layers.length >= 4); });
    assert(!(await page.locator('#mod-bar').isVisible()) && !(await page.locator('#layers-toggle').isVisible()) && await page.locator('.layers-panel').isVisible(), 'no touch UI on desktop');
  });
  // The PWA: manifest, icons, and the service worker caching the shell and the wasm.
  await device('PWA (manifest + service worker)', devices['Pixel 7'], async page => {
    const man = await page.evaluate(async () => { const l = document.querySelector('link[rel=manifest]'); const r = await fetch(l.href); return { ok: r.ok, type: r.headers.get('content-type'), json: await r.json() }; });
    assert(man.ok && man.json.name && man.json.icons.some(i => i.sizes === '512x512') && man.json.display === 'standalone', 'manifest ' + JSON.stringify(man.json));
    if (isWebkit) return;
    await page.goto(URL_ + '?sw', { waitUntil: 'networkidle' });
    const sw = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++) await new Promise(r => setTimeout(r, 100));
      const keys = await caches.keys(); let urls = [];
      for (const k of keys) urls = urls.concat((await (await caches.open(k)).keys()).map(r => r.url));
      return { scope: reg.scope, controlled: !!navigator.serviceWorker.controller, keys, wasm: urls.some(u => u.endsWith('.wasm') && u.includes('pixels')), heif: urls.some(u => u.includes('libheif')), n: urls.length };
    });
    assert(sw.controlled && sw.wasm && !sw.heif && sw.n > 5, 'service worker caches the shell and the wasm ' + JSON.stringify(sw));
    // Offline reload still boots.
    page.on('requestfailed', r => console.log('  offline miss:', r.url()));
    await page.context().setOffline(true);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#stage canvas.gl-canvas', { timeout: 15000 });
    await page.context().setOffline(false);
  });
  assert(errors.length === 0, 'console errors:\n' + errors.join('\n'));
  if (failed) throw new Error('a device check failed');
  console.log('\nAll mobile checks passed. Screenshots in ' + SHOTS + '/mobile-*.png');
} catch (e) {
  console.error('\nFAILED:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close(); if (server) try { process.kill(-server.pid); } catch {}
}
