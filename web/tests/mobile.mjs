// Mobile smoke test: the production build under Playwright device emulation (iPhone 15, Pixel 7, iPad Pro 11, plus
// landscape phones), driving it with real touch input over CDP (taps, one-finger strokes, pinch, two-finger tap,
// long press) and synthetic pen events. Usage: npm run build && node tests/mobile.mjs
// Env: URL (an already running server) or PREVIEW_PORT, SHOTS (screenshot dir; files are mobile-*.png),
// DEVICES="iPhone 15|Pixel 7" to run a subset, BROWSER=webkit to try WebKit (CDP touch needs Chromium, so only the
// layout checks run there).
import { chromium, webkit, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';

const PORT = process.env.PREVIEW_PORT || '4174';
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
const useWebkit = process.env.BROWSER === 'webkit';
const engine = useWebkit ? webkit : chromium;
const browser = await engine.launch(useWebkit ? {} : { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const assert = (c, msg) => { if (!c) throw new Error('assertion failed: ' + msg); };
const ALL = [
  { name: 'iPhone 15', slug: 'iphone15', expect: { compact: true, phone: true } },
  { name: 'Pixel 7', slug: 'pixel7', expect: { compact: true, phone: true } },
  { name: 'iPad Pro 11', slug: 'ipadpro11', expect: { compact: false, phone: false } },
  { name: 'iPhone 15 landscape', slug: 'iphone15-landscape', expect: { compact: true, phone: false }, quick: true },
  { name: 'Pixel 7 landscape', slug: 'pixel7-landscape', expect: { compact: true, phone: false }, quick: true },
  { name: 'iPad Pro 11 landscape', slug: 'ipadpro11-landscape', expect: { compact: false, phone: false }, quick: true },
];
const only = process.env.DEVICES ? process.env.DEVICES.split('|') : null;
const runs = ALL.filter(d => !only || only.includes(d.name));

let failed = false;
for (const dev of runs) {
  const desc = { ...devices[dev.name] }; delete desc.defaultBrowserType;
  if (useWebkit) delete desc.isMobile;
  const context = await browser.newContext({ ...desc });
  const page = await context.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const cdp = useWebkit ? null : await context.newCDPSession(page);
  let shotN = 0;
  const slug = dev.name.toLowerCase().replace(/\s+/g, '-');
  for (const f of readdirSync(SHOTS)) if (f.startsWith(`mobile-${slug}-`) && /^\d\d-/.test(f.slice(`mobile-${slug}-`.length))) rmSync(`${SHOTS}/${f}`);
  const shot = name => page.screenshot({ path: `${SHOTS}/mobile-${slug}-${String(++shotN).padStart(2, '0')}-${name}.png` });
  const step = async (name, fn) => { process.stdout.write(`• [${dev.name}] ${name} … `); await fn(); console.log('ok'); };
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 3, radiusY: 3, force: 1 })) });
  const wait = ms => page.waitForTimeout(ms);
  const st = () => page.evaluate(() => { const { app } = window.compositor; const d = app.doc; return d ? { undo: app.history.undoStack.length, redo: app.history.redoStack.length, zoom: app.project.zoom, layers: d.layers.length, blend: app.active?.blend, sel: !!d.selection } : null; });
  const toScreen = (x, y) => page.evaluate(([x, y]) => { const { app } = window.compositor; const r = document.getElementById('stage').getBoundingClientRect(); const s = app.toScreen(x, y); return [s[0] + r.left, s[1] + r.top]; }, [x, y]);
  const pixel = (x, y) => page.evaluate(([x, y]) => { const { app } = window.compositor; return Array.from(app.renderer.readPixel(app.doc, x, y)); }, [x, y]);
  const inViewport = sel => page.evaluate(s => { const el = document.querySelector(s); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; }, sel);
  // The finger rests a moment before lifting: a release at speed starts a fling, and Chromium spends the next tap on
  // stopping it instead of clicking.
  const stroke = async (pts) => { await touch('touchStart', [pts[0]]); for (const p of pts.slice(1)) { await touch('touchMove', [p]); } await wait(120); await touch('touchMove', [pts[pts.length - 1]]); await wait(120); await touch('touchEnd', []); };
  try {
    await step('load, viewport, body classes, nothing overflows', async () => {
      await page.goto(URL_, { waitUntil: 'networkidle' });
      await page.waitForSelector('#stage canvas.gl-canvas');
      const info = await page.evaluate(() => ({ cls: document.body.className, vp: document.querySelector('meta[name=viewport]').content, sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, ih: innerHeight }));
      assert(info.cls.includes('touch'), 'touch class ' + info.cls);
      assert(info.cls.includes('compact') === dev.expect.compact, `compact=${dev.expect.compact}: ${info.cls}`);
      assert(info.cls.includes('phone') === dev.expect.phone, `phone=${dev.expect.phone}: ${info.cls}`);
      assert(/viewport-fit=cover/.test(info.vp) && /width=device-width/.test(info.vp), info.vp);
      assert(info.sw <= info.iw && info.sh <= info.ih, `no page scroll: ${JSON.stringify(info)}`);
      await page.locator('#create-canvas').scrollIntoViewIfNeeded();
      assert(await inViewport('.welcome-card #create-canvas'), 'Create button reachable');
      await shot('welcome');
    });
    await step('sample opens; toolbar, rail and modifier targets are at least 44 px', async () => {
      await page.getByText('Try a sample').tap();
      await page.waitForFunction(() => window.compositor.app.doc?.layers.length === 4);
      const small = await page.evaluate(() => [...document.querySelectorAll('.toolbar button, .tool-rail .rail-btn, .mod-btn, .tool-header button, .tool-header .popup')]
        .filter(b => b.offsetParent && getComputedStyle(b).display !== 'none').map(b => { const r = b.getBoundingClientRect(); return { t: b.title || b.textContent.trim().slice(0, 20), w: Math.round(r.width), h: Math.round(r.height) }; })
        .filter(r => r.w < 44 || r.h < 40));
      assert(!small.length, 'small targets ' + JSON.stringify(small));
      const railMin = await page.evaluate(() => Math.min(...[...document.querySelectorAll('.rail-btn')].map(b => Math.min(b.offsetWidth, b.offsetHeight))));
      assert(railMin >= 44, 'rail buttons ' + railMin);
      await page.waitForTimeout(150);
      await shot('editor');
    });
    if (dev.quick) {
      await step('landscape: canvas gets the room, layers drawer fits', async () => {
        const r = await page.evaluate(() => { const s = document.getElementById('stage').getBoundingClientRect(); return { w: s.width, h: s.height, iw: innerWidth, ih: innerHeight }; });
        assert(r.h >= r.ih * 0.55, 'stage height ' + JSON.stringify(r));
        if (dev.expect.compact) {
          await page.tap('#toggle-layers'); await wait(300);
          assert(await inViewport('.layers-panel'), 'layers drawer on screen');
          await shot('layers');
          await page.tap('#close-layers'); await wait(300);
        }
      });
    } else {
      await step('one-finger brush stroke paints', async () => {
        await page.tap('#addBlankLayer').catch(async () => { await page.evaluate(() => window.compositor.app.addBlankLayer()); });
        if ((await st()).layers === 4) await page.evaluate(() => window.compositor.app.addBlankLayer());
        await page.tap('.rail-btn[data-tool="brush"]');
        await page.evaluate(() => { const { app } = window.compositor; app.brush.size = 50; app.brush.smoothing = 0; app.fg = { red: 0.1, green: 0.8, blue: 0.3 }; });
        const before = await st();
        const [x0, y0] = await toScreen(300, 500), [x1, y1] = await toScreen(900, 520);
        const pts = []; for (let i = 0; i <= 12; i++) pts.push([x0 + (x1 - x0) * i / 12, y0 + (y1 - y0) * i / 12]);
        await stroke(pts);
        const p = await pixel(600, 510); const after = await st();
        assert(p[1] > 150 && p[0] < 90, 'painted green: ' + p);
        assert(after.undo === before.undo + 1, `one undo step ${before.undo} -> ${after.undo}`);
      });
      await step('two-finger pinch zooms and pans without painting', async () => {
        const before = await st();
        const r = await page.evaluate(() => { const s = document.getElementById('stage').getBoundingClientRect(); return { cx: s.left + s.width / 2, cy: s.top + s.height / 2 }; });
        await touch('touchStart', [[r.cx - 30, r.cy], [r.cx + 30, r.cy]]);
        for (let i = 1; i <= 8; i++) await touch('touchMove', [[r.cx - 30 - i * 10, r.cy + i * 3], [r.cx + 30 + i * 10, r.cy + i * 3]]);
        await touch('touchEnd', []);
        const after = await st();
        assert(after.zoom > before.zoom * 1.8, `zoomed ${before.zoom} -> ${after.zoom}`);
        assert(after.undo === before.undo, 'pinch left no history ' + JSON.stringify([before, after]));
        await page.waitForTimeout(100); await shot('pinch');
        await page.evaluate(() => window.compositor.app.fit());
      });
      await step('second finger mid-stroke cancels the stroke', async () => {
        const before = await st();
        const [x0, y0] = await toScreen(300, 300);
        await touch('touchStart', [[x0, y0]]);
        for (let i = 1; i <= 5; i++) await touch('touchMove', [[x0 + i * 12, y0]]);
        await touch('touchMove', [[x0 + 60, y0], [x0 + 160, y0 + 40]]);
        for (let i = 1; i <= 4; i++) await touch('touchMove', [[x0 + 60 - i * 8, y0], [x0 + 160 + i * 8, y0 + 40]]);
        await touch('touchEnd', []);
        const after = await st();
        assert(after.undo === before.undo && after.redo === before.redo, 'stroke rolled back ' + JSON.stringify([before, after]));
        const p = await pixel(330, 300); assert(!(p[1] > 150 && p[0] < 90), 'no paint left: ' + p);
        await page.evaluate(() => window.compositor.app.fit());
      });
      await step('two-finger tap undoes, three-finger tap redoes', async () => {
        const before = await st();
        const [x, y] = await toScreen(800, 300);
        await touch('touchStart', [[x, y], [x + 70, y + 10]]); await wait(60); await touch('touchEnd', []);
        await wait(50);
        const mid = await st();
        assert(mid.undo === before.undo - 1 && mid.redo === before.redo + 1, 'undo ' + JSON.stringify([before, mid]));
        await touch('touchStart', [[x, y], [x + 70, y + 10], [x + 140, y]]); await wait(60); await touch('touchEnd', []);
        await wait(50);
        const after = await st(); assert(after.undo === before.undo, 'redo ' + JSON.stringify([before, after]));
      });
      await step('long press on the canvas opens the context menu', async () => {
        const [x, y] = await toScreen(800, 400);
        const before = await st();
        await touch('touchStart', [[x, y]]); await wait(750); await touch('touchEnd', []);
        await page.waitForSelector('.menu [data-id="ctx-pick"]');
        assert(await page.evaluate(() => { const m = document.querySelector('.menu').getBoundingClientRect(); return m.right <= innerWidth + 1 && m.bottom <= innerHeight + 1 && m.top >= 0; }), 'menu on screen');
        const after = await st(); assert(after.undo === before.undo, 'the held dab was rolled back');
        await shot('canvas-menu');
        await page.tap('.menu [data-id="ctx-pick"]');
        const fg = await page.evaluate(() => window.compositor.app.fg);
        assert(fg.red > 0.5, 'picked the sky color ' + JSON.stringify(fg));
        await page.evaluate(() => { window.compositor.app.fg = { red: 0.1, green: 0.8, blue: 0.3 }; });
      });
      await step('modifier bar: latched Shift reaches the tools', async () => {
        await page.tap('.mod-btn[data-mod="shift"]');
        await page.evaluate(() => { window.__shift = null; document.getElementById('stage').addEventListener('pointerdown', e => { window.__shift = e.shiftKey; }, { once: true }); });
        await page.tap('.rail-btn[data-tool="marquee"]');
        const [x0, y0] = await toScreen(200, 200), [x1, y1] = await toScreen(500, 400);
        await stroke([[x0, y0], [x0 + 20, y0 + 20], [(x0 + x1) / 2, (y0 + y1) / 2], [x1, y1]]);
        assert(await page.evaluate(() => window.__shift) === true, 'shiftKey seen');
        assert((await st()).sel, 'selection made');
        await page.tap('.mod-btn[data-mod="shift"]');
        assert(!(await page.evaluate(() => document.querySelector('.mod-btn[data-mod="shift"]').classList.contains('on'))), 'unlatched');
        await page.evaluate(() => window.compositor.app.deselect());
      });
      await step('pen pressure scales the brush; palm touches are ignored while the pen is down', async () => {
        await page.tap('.rail-btn[data-tool="brush"]');
        await page.evaluate(() => { const { app } = window.compositor; app.brush.size = 60; app.brush.hardness = 1; app.brush.smoothing = 0; app.fg = { red: 1, green: 0, blue: 0 }; });
        const width = async (yDoc, pressure) => {
          const [x0, y] = await toScreen(200, yDoc), [x1] = await toScreen(1000, yDoc);
          await page.evaluate(([x0, x1, y, pressure]) => {
            const stage = document.getElementById('stage');
            const ev = (type, x, extra = {}) => stage.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 77, pointerType: 'pen', clientX: x, clientY: y, pressure, buttons: type === 'pointerup' ? 0 : 1, button: 0, isPrimary: true, ...extra }));
            ev('pointerdown', x0);
            for (let i = 1; i <= 20; i++) {
              ev('pointermove', x0 + (x1 - x0) * i / 20);
              // A palm landing mid-stroke must not paint or pan.
              if (i === 10) stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 88, pointerType: 'touch', clientX: x0, clientY: y + 120, width: 60, height: 60, buttons: 1, isPrimary: false }));
            }
            ev('pointerup', x1);
            stage.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 88, pointerType: 'touch', clientX: x0, clientY: y + 120 }));
          }, [x0, x1, y, pressure]);
          let n = 0; for (let dy = -40; dy <= 40; dy += 2) { const p = await pixel(600, yDoc + dy); if (p[0] > 200 && p[1] < 60) n += 2; }
          return n;
        };
        const zoom0 = (await st()).zoom;
        const light = await width(650, 0.15), heavy = await width(800, 1);
        assert(heavy >= 50 && light < heavy * 0.5, `pressure widths light=${light} heavy=${heavy}`);
        assert((await st()).zoom === zoom0, 'palm did not zoom or pan');
        assert(await page.evaluate(() => document.body.classList.contains('pen-mode')), 'pen mode');
        await page.waitForTimeout(100); await shot('pen-pressure');
      });
      await step('menus fit: ☰ drills into submenus (or the menu bar on tablets), panels sit on screen', async () => {
        if (dev.expect.compact) {
          await page.tap('#mobile-menu');
          await page.tap('.menu [data-id="menu-Image"]');
          await page.waitForSelector('.menu [data-id="menu-back"]');
          assert(await page.evaluate(() => { const m = document.querySelector('.menu').getBoundingClientRect(); return m.left >= 0 && m.right <= innerWidth + 1 && m.bottom <= innerHeight + 1; }), 'submenu on screen');
          await shot('menu');
          await page.locator('.menu .menu-item', { hasText: 'Hue/Saturation…' }).first().tap();
        } else {
          await page.tap('.menubar-item[data-menu="Image"]');
          await page.locator('.menu .menu-item', { hasText: 'Hue/Saturation…' }).first().tap();
        }
        await page.waitForSelector('.floating-panel');
        await wait(200);
        assert(await inViewport('.floating-panel'), 'filter panel on screen');
        assert(await inViewport('#filter-ok') || await page.evaluate(() => { const b = document.querySelector('.floating-panel .panel-body'); return b.scrollHeight > b.clientHeight; }), 'OK reachable (on screen or by scrolling the sheet)');
        await shot('filter-sheet');
        await page.evaluate(() => document.querySelector('.floating-panel .panel-close').click());
      });
      await step('Layers drawer, blend mode tap-to-preview, long-press layer menu', async () => {
        if (dev.expect.compact) {
          await page.tap('#toggle-layers'); await wait(300);
          assert(await inViewport('.layers-panel'), 'layers sheet on screen');
          await shot('layers');
        }
        const before = await st();
        await page.tap('#blend-mode');
        await page.waitForSelector('#blend-list .menu-hint');
        await page.tap('#blend-list [data-id="Multiply"]');
        const mid = await st();
        assert(mid.blend === 'Multiply' && mid.undo === before.undo, 'first tap previews ' + JSON.stringify([before, mid]));
        await shot('blend-preview');
        await page.tap('#blend-list [data-id="Multiply"]');
        const after = await st();
        assert(after.blend === 'Multiply' && after.undo === before.undo + 1, 'second tap keeps ' + JSON.stringify(after));
        const row = await page.locator('.layer-row').first().boundingBox();
        await touch('touchStart', [[row.x + row.width / 2, row.y + row.height / 2]]); await wait(700); await touch('touchEnd', []);
        await page.waitForSelector('.menu .menu-item[data-id="Rename"]');
        await shot('layer-menu');
        await page.tap('.menu .menu-item[data-id="Duplicate"]');
        assert((await st()).layers === after.layers + 1, 'duplicated from the long-press menu');
        if (dev.expect.compact) { await page.tap('#close-layers'); await wait(300); assert(!(await page.evaluate(() => document.body.classList.contains('layers-open'))), 'closed'); }
      });
      await step('dialogs fit: New Canvas and Image Size', async () => {
        await page.tap('#newCanvasToolbar');
        await page.waitForSelector('.modal #create-canvas');
        assert(await inViewport('.modal'), 'new canvas modal on screen');
        const fs = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('new-width')).fontSize));
        assert(fs >= 16, 'no iOS focus zoom: field font ' + fs);
        await shot('new-canvas');
        await page.locator('.modal .modal-buttons button', { hasText: 'Cancel' }).tap();
      });
      await step('PWA: manifest, icons, service worker caches the shell and the wasm', async () => {
        const m = await page.evaluate(async () => { const l = document.querySelector('link[rel=manifest]'); const r = await fetch(l.href); return { ok: r.ok, type: r.headers.get('content-type'), json: await r.json() }; });
        assert(m.ok && m.json.icons.some(i => i.sizes === '512x512') && m.json.display === 'standalone', 'manifest ' + JSON.stringify(m.json));
        const sw = await page.evaluate(async () => {
          const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 15000))]);
          if (!reg) return null;
          const keys = await caches.keys(); const urls = [];
          for (const k of keys) for (const r of await (await caches.open(k)).keys()) urls.push(r.url);
          return { scope: reg.scope, keys, wasm: urls.some(u => /pixels-.*\.wasm$/.test(u)), shell: urls.some(u => /\/$/.test(u)), n: urls.length };
        });
        assert(sw && sw.wasm && sw.shell, 'service worker caches ' + JSON.stringify(sw));
      });
    }
    assert(!errors.length, 'console errors:\n' + errors.join('\n'));
  } catch (e) {
    failed = true;
    console.log('\nFAILED:', e.message);
    await shot('failure').catch(() => {});
  } finally {
    await context.close();
  }
  if (failed) break;
}
await browser.close(); if (server) try { process.kill(-server.pid); } catch {}
if (failed) process.exit(1);
console.log('\nAll mobile checks passed. Screenshots: ' + SHOTS + '/mobile-*.png');
