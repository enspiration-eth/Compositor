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
  // WebKit (like iOS Safari) logs the Chromium-only interactive-widget viewport key as an error; it's harmless there.
  page.on('console', m => { if (m.type() === 'error' && !/interactive-widget/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const cdp = useWebkit ? null : await context.newCDPSession(page);
  let shotN = 0;
  const slug = (useWebkit ? 'webkit-' : '') + dev.name.toLowerCase().replace(/\s+/g, '-');
  for (const f of readdirSync(SHOTS)) if (f.startsWith(`mobile-${slug}-`) && /^\d\d-/.test(f.slice(`mobile-${slug}-`.length))) rmSync(`${SHOTS}/${f}`);
  const shot = name => page.screenshot({ path: `${SHOTS}/mobile-${slug}-${String(++shotN).padStart(2, '0')}-${name}.png` });
  const step = async (name, fn) => { process.stdout.write(`• [${dev.name}] ${name} … `); await fn(); console.log('ok'); };
  // Multi-touch: real touch input through CDP in Chromium. WebKit has no such protocol, so there the same fingers are
  // dispatched as touch PointerEvents (what the app listens to) on whatever is under them.
  const touch = cdp ? (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 3, radiusY: 3, force: 1 })) })
    : (type, pts) => page.evaluate(([type, pts]) => {
      const live = window.__fingers ??= new Map();
      const fire = (kind, id, x, y, target) => target.dispatchEvent(new PointerEvent(kind, { bubbles: true, cancelable: true, composed: true, pointerId: 100 + id, pointerType: 'touch', isPrimary: id === 0,
        clientX: x, clientY: y, width: 6, height: 6, pressure: kind === 'pointerup' ? 0 : 0.5, buttons: kind === 'pointerup' ? 0 : 1, button: kind === 'pointermove' ? -1 : 0 }));
      if (type === 'touchEnd' || type === 'touchCancel') {
        const keep = new Set(pts.map((_, i) => i));
        for (const [id, f] of [...live]) if (!keep.has(id)) { fire(type === 'touchEnd' ? 'pointerup' : 'pointercancel', id, f.x, f.y, f.target); live.delete(id); }
        return;
      }
      pts.forEach(([x, y], id) => {
        const f = live.get(id);
        if (!f) { const target = document.elementFromPoint(x, y) ?? document.body; live.set(id, { x, y, target }); fire('pointerdown', id, x, y, target); }
        else if (f.x !== x || f.y !== y) { f.x = x; f.y = y; fire('pointermove', id, x, y, f.target); }
      });
    }, [type, pts]);
  const wait = ms => page.waitForTimeout(ms);
  const st = () => page.evaluate(() => { const { app } = window.compositor; const d = app.doc; return d ? { undo: app.history.undoStack.length, redo: app.history.redoStack.length, zoom: app.project.zoom, layers: d.layers.length, blend: app.active?.blend, sel: !!d.selection } : null; });
  const toScreen = (x, y) => page.evaluate(([x, y]) => { const { app } = window.compositor; const r = document.getElementById('stage').getBoundingClientRect(); const s = app.toScreen(x, y); return [s[0] + r.left, s[1] + r.top]; }, [x, y]);
  const pixel = (x, y) => page.evaluate(([x, y]) => { const { app } = window.compositor; return Array.from(app.renderer.readPixel(app.doc, x, y)); }, [x, y]);
  const inViewport = sel => page.evaluate(s => { const el = document.querySelector(s); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; }, sel);
  // Every visible custom pop-up shows its selected option's text, readable (not collapsed to the chevron).
  const selectsShowValues = async (where) => {
    const bad = await page.evaluate(() => [...document.querySelectorAll('.cs-button')].filter(b => !b.hidden && b.offsetParent && b.getBoundingClientRect().width > 0).flatMap(b => {
      const s = b.previousElementSibling, l = b.querySelector('.cs-label'), o = s?.selectedOptions?.[0];
      const want = o ? (o.label || o.textContent || '').trim() : '';
      const lw = l.getBoundingClientRect().width;
      return !want || l.textContent.trim() !== want || lw < Math.min(l.scrollWidth, 36) ? [{ id: b.id, text: l.textContent, want, lw: Math.round(lw), bw: Math.round(b.getBoundingClientRect().width) }] : [];
    }));
    assert(!bad.length, `${where}: custom selects without a readable value ${JSON.stringify(bad)}`);
  };
  // The finger rests a moment before lifting: a release at speed starts a fling, and Chromium spends the next tap on
  // stopping it instead of clicking.
  const menuItem = async (menu, label) => {
    if (dev.expect.compact) { await page.tap('#mobile-menu'); await page.tap(`.menu [data-id="menu-${menu}"]`); await page.waitForSelector('.menu [data-id="menu-back"]'); }
    else await page.tap(`.menubar-item[data-menu="${menu}"]`);
    await page.locator('.menu .menu-item', { hasText: label }).first().tap();
  };
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
      await selectsShowValues('welcome');
      await page.evaluate(() => document.querySelector('.rail-btn[data-tool="type"]')?.click()); await wait(150);
      await selectsShowValues('Type options on the welcome screen');
      await page.evaluate(() => document.querySelector('.rail-btn[data-tool="brush"]')?.click());
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
      for (const t of await page.evaluate(() => [...document.querySelectorAll('.rail-btn[data-tool]')].map(b => b.dataset.tool))) {
        await page.evaluate(t => document.querySelector(`.rail-btn[data-tool="${t}"]`).click(), t); await wait(80);
        await selectsShowValues(`${t} options`);
      }
      await page.evaluate(() => document.querySelector('.rail-btn[data-tool="brush"]').click());
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
      await step('slow drawing stays a stroke (no long-press menu)', async () => {
        await page.tap('.rail-btn[data-tool="brush"]');
        const before = await st();
        const [x, y] = await toScreen(400, 700);
        // 2 px every 40 ms for about a second: slower than the long-press timeout ever lets the finger rest.
        await touch('touchStart', [[x, y]]);
        for (let i = 1; i <= 25; i++) { await touch('touchMove', [[x + i * 2, y + (i % 2)]]); await wait(40); }
        await wait(120); await touch('touchEnd', []); await wait(150);
        assert(!(await page.locator('.menu [data-id="ctx-pick"]').count()), 'no context menu during a slow stroke');
        assert((await st()).undo === before.undo + 1, 'the slow stroke painted');
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
      if (dev.expect.compact) await step('options bar: a quick swipe across a field scrolls the bar; hold-then-drag scrubs it', async () => {
        await page.tap('.rail-btn[data-tool="brush"]'); await wait(200);
        const st = () => page.evaluate(() => { const b = document.querySelector('.tool-header'); return { sl: Math.round(b.scrollLeft), size: window.compositor.app.brush.size, fadeR: b.classList.contains('fade-r'), fadeL: b.classList.contains('fade-l'), gap: parseFloat(getComputedStyle(b).columnGap) }; });
        await page.evaluate(() => { document.querySelector('.tool-header').scrollLeft = 0; }); await wait(150);
        const a = await st();
        assert(a.gap >= 20, 'touch gap between fields ' + a.gap);
        assert(a.fadeR && !a.fadeL, 'right edge fade only at the start ' + JSON.stringify(a));
        const box = await page.locator('.tool-header .num-box.labeled').first().boundingBox();
        const y = box.y + box.height / 2, x = box.x + 30;
        if (!useWebkit) { // native scrolling needs real touch input (CDP); WebKit here only gets synthetic pointer events
          await touch('touchStart', [[x, y]]); for (let i = 1; i <= 8; i++) { await touch('touchMove', [[x - i * 25, y]]); await wait(16); } await touch('touchEnd', []); await wait(700);
          const b = await st();
          assert(b.sl > 60 && b.size === a.size, 'swipe scrolled the bar, value unchanged ' + JSON.stringify([a, b]));
          assert(b.fadeL, 'left fade once scrolled ' + JSON.stringify(b));
          await shot('inputs-v4-swiped');
          await page.evaluate(() => { document.querySelector('.tool-header').scrollLeft = 0; }); await wait(200);
        }
        await touch('touchStart', [[x, y]]); await wait(300);
        assert(await page.evaluate(() => !!document.querySelector('.tool-header .num-box.scrub-armed')), 'hold arms the field');
        for (let i = 1; i <= 8; i++) { await touch('touchMove', [[x + i * 6, y]]); await wait(30); } await wait(100); await touch('touchEnd', []); await wait(300);
        const c = await st();
        assert(c.size > a.size + 10 && c.sl === 0, 'hold-then-drag scrubbed without scrolling ' + JSON.stringify([a, c]));
        await page.evaluate(v => { window.compositor.app.brush.size = v; window.compositor.app.emit('tool'); }, a.size);
      });
      if (dev.expect.compact) await step('tool options: the cut-off row expands into wrapped rows', async () => {
        await page.tap('.rail-btn[data-tool="brush"]');
        assert(await page.isVisible('#tool-options-toggle'), 'chevron shown when options are cut off');
        const h0 = await page.evaluate(() => document.querySelector('.tool-header').getBoundingClientRect().height);
        await page.tap('#tool-options-toggle'); await wait(150);
        const r = await page.evaluate(() => { const hd = document.querySelector('.tool-header'); const kids = [...hd.children].map(c => c.getBoundingClientRect()); return { h: hd.getBoundingClientRect().height, right: Math.max(...kids.map(k => k.right)), vw: innerWidth, overflow: hd.scrollWidth - hd.clientWidth, pressure: !!document.getElementById('brush-pressure')?.getBoundingClientRect().width }; });
        assert(r.h > h0 + 20 && r.right <= r.vw + 1 && r.overflow <= 2 && r.pressure, 'expanded options all on screen ' + JSON.stringify({ h0, ...r }));
        await shot('tool-options');
        // Values and units share one box; a tap on a label opens its slider.
        const box = await page.evaluate(() => { const n = document.querySelector('.tool-header .slider-row .num-box'); const u = n?.querySelector('.unit'); return n && u ? { inside: n.contains(u), uw: u.getBoundingClientRect().right <= n.getBoundingClientRect().right } : null; });
        assert(box && box.inside && box.uw, 'unit inside the field box ' + JSON.stringify(box));
        // The Size box fits the value it holds (not the 4-digit maximum), and still shows it whole.
        // The Size value is as wide as the value it holds (not the 4-digit maximum), shown whole; the label sits inside the box.
        const sz = await page.evaluate(() => { const i = document.getElementById('brush-size'); return { input: i.getBoundingClientRect().width, fits: i.scrollWidth <= i.clientWidth + 1, v: i.value, label: !!i.parentElement.querySelector('.num-inlabel'), h: i.parentElement.getBoundingClientRect().height }; });
        assert(sz.fits && sz.input <= (sz.v.length <= 2 ? 34 : 44) && sz.label && sz.h >= 43, 'Size field ' + JSON.stringify(sz));
        // A drag anywhere on the labeled box scrubs; its slider button opens the popover.
        const ob = await page.locator('.tool-header .num-box', { hasText: 'Hardness' }).boundingBox();
        const hv0 = await page.evaluate(() => window.compositor.app.brush.hardness);
        await touch('touchStart', [[ob.x + 20, ob.y + ob.height / 2]]);
        for (let k = 1; k <= 8; k++) await touch('touchMove', [[ob.x + 20 - k * 6, ob.y + ob.height / 2]]);
        await touch('touchEnd', []); await wait(100);
        const hv1 = await page.evaluate(() => window.compositor.app.brush.hardness);
        assert(hv1 < hv0, `touch drag on the box scrubs: ${hv0} → ${hv1}`);
        await page.locator('.tool-header .num-box', { hasText: 'Opacity' }).locator('.num-pop-btn').tap(); await wait(150);
        assert(await page.isVisible('.num-popover input[type=range]'), 'slider button opens the popover');
        await shot('options-popover');
        await page.keyboard.press('Escape'); await wait(100);
        assert(!(await page.isVisible('.num-popover')), 'Escape closes the slider popover');
        await page.tap('#tool-options-toggle'); await wait(150);
        assert(await page.evaluate(() => document.querySelector('.tool-header').getBoundingClientRect().height) <= h0 + 1, 'collapsed again');
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
        if (dev.expect.phone) {
          // The fitted canvas moves above the sheet instead of hiding under it.
          await page.waitForFunction(() => window.compositor.app.viewInsetBottom > 0, null, { timeout: 3000 });
          const v = await page.evaluate(() => { const { app } = window.compositor; const p = app.project, s = document.getElementById('stage').getBoundingClientRect(), sh = document.querySelector('.floating-panel').getBoundingClientRect(); return { docBottom: s.top + p.oy + app.doc.height * p.zoom, sheetTop: sh.top }; });
          assert(v.docBottom <= v.sheetTop + 2, 'canvas fitted above the sheet ' + JSON.stringify(v));
        }
        await shot('filter-sheet');
        await page.evaluate(() => document.querySelector('.floating-panel .panel-close').click());
        if (dev.expect.phone) await page.waitForFunction(() => window.compositor.app.viewInsetBottom === 0, null, { timeout: 3000 });
      });
      await step('Layers drawer, blend mode tap-to-preview, long-press layer menu', async () => {
        if (dev.expect.compact) {
          await page.tap('#toggle-layers');
          await page.waitForFunction(() => { const r = document.querySelector('.layers-panel').getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top >= 0; }, null, { timeout: 3000 }).catch(() => {});
          assert(await inViewport('.layers-panel'), 'layers sheet on screen');
          await shot('layers');
        }
        await selectsShowValues('Layers panel');
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
      if (dev.expect.compact) await step('Layers sheet: drag the handle between detents, flick down, tap cycles, drag away dismisses', async () => {
        await page.tap('#toggle-layers'); await wait(400);
        const info = () => page.evaluate(() => { const el = document.querySelector('.layers-panel'); return { h: Math.round(el.getBoundingClientRect().height), detent: el.dataset.detent, open: document.body.classList.contains('layers-open') }; });
        const drag = async (dy, steps, ms, rest = 0) => { const hb = await page.locator('#layers-sheet-handle').boundingBox(); const x = hb.x + hb.width / 2, y = hb.y + hb.height / 2;
          await touch('touchStart', [[x, y]]); for (let i = 1; i <= steps; i++) { await touch('touchMove', [[x, y + dy * i / steps]]); await wait(ms); } await wait(rest); await touch('touchEnd', []); await wait(500); };
        const a = await info(); assert(a.open && a.detent === 'half', 'opens at half ' + JSON.stringify(a));
        await drag(-300, 15, 30); const b = await info(); assert(b.detent === 'full' && b.h > a.h + 100, 'dragged up to full ' + JSON.stringify(b));
        await shot('layers-sheet-full');
        await drag(250, 15, 30); const c = await info(); assert(c.detent === 'half', 'settles back at half ' + JSON.stringify(c));
        await drag(120, 4, 30); const d = await info(); assert(d.open && d.detent === 'peek' && d.h < c.h, 'flick down goes to peek ' + JSON.stringify(d));
        await page.tap('#layers-sheet-handle'); await wait(500); const e = await info(); assert(e.detent === 'half', 'tap cycles ' + JSON.stringify(e));
        await drag(500, 10, 20, 150); const f = await info(); assert(!f.open, 'dragged far down closes ' + JSON.stringify(f));
        const fit = await page.evaluate(() => { const r = document.getElementById('stage').getBoundingClientRect(); return r.height > 200; }); assert(fit, 'stage back to full height');
      });
      await step('dialogs fit: New Canvas, Image Size and Canvas Size (device caps)', async () => {
        await page.tap('#newCanvasToolbar');
        await page.waitForSelector('.modal #create-canvas');
        assert(await inViewport('.modal'), 'new canvas modal on screen');
        const fs = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('new-width')).fontSize));
        assert(fs >= 16, 'no iOS focus zoom: field font ' + fs);
        await shot('new-canvas');
        await page.fill('.modal #new-width', '8000'); await page.fill('.modal #new-height', '6000');
        assert(await page.isDisabled('.modal #create-canvas') && /Too big for this device/.test(await page.textContent('.modal #new-hint')), 'New Canvas: device size cap');
        await page.locator('.modal .modal-buttons button', { hasText: 'Cancel' }).tap();
        await menuItem('Image', 'Image Size…');
        await page.waitForSelector('#image-size-modal #image-width');
        assert(await inViewport('#image-size-modal'), 'Image Size on screen');
        await selectsShowValues('Image Size');
        await page.selectOption('#image-units', 'Pixels').catch(() => {});
        await page.fill('#image-width', '20000');
        assert(await page.isDisabled('#image-size-modal .modal-buttons .primary') && /this device/.test(await page.textContent('#image-result')), 'Image Size: device size cap');
        await shot('image-size-cap');
        await page.locator('#image-size-modal .modal-buttons button', { hasText: 'Cancel' }).tap();
        await menuItem('Image', 'Canvas Size…');
        await page.waitForSelector('.modal #canvas-width');
        assert(await inViewport('.modal'), 'Canvas Size on screen');
        await page.fill('#canvas-width', '20000');
        assert(await page.isDisabled('.modal .modal-buttons .primary') && /this device/.test(await page.textContent('#canvas-result')), 'Canvas Size: device size cap');
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
        // Installed, the app boots offline. (Playwright's WebKit can't reload offline at all: "internal error".)
        if (!useWebkit) await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => page.reload({ waitUntil: 'networkidle' }));
        if (!useWebkit) {
          await context.setOffline(true);
          await page.reload({ waitUntil: 'load' });
          await page.waitForSelector('#stage canvas', { timeout: 15000 });
          await context.setOffline(false);
        }
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
// Without WebGL 2 (old phones, blocklisted GPUs) the app says so instead of failing silently; the desktop layout is untouched.
if (!failed && !only) {
  try {
    process.stdout.write('• no WebGL 2: a clear message … ');
    const desc = { ...devices['Pixel 7'] }; delete desc.defaultBrowserType;
    const ctx = await browser.newContext(desc);
    await ctx.addInitScript(() => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return t === 'webgl2' ? null : g.call(this, t, ...a); }; });
    const page = await ctx.newPage();
    await page.goto(URL_, { waitUntil: 'networkidle' });
    const msg = await page.locator('.boot.error').textContent({ timeout: 15000 }).catch(() => '');
    await page.screenshot({ path: `${SHOTS}/mobile-no-webgl2.png` });
    await ctx.close();
    assert(/WebGL 2/.test(msg), 'no WebGL 2 message: ' + msg);
    console.log('ok');
    process.stdout.write('• desktop 1440×900 keeps the desktop layout … ');
    const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dp = await dctx.newPage();
    await dp.goto(URL_, { waitUntil: 'networkidle' });
    await dp.waitForSelector('#stage canvas');
    const d = await dp.evaluate(() => ({ cls: document.body.className, mod: !!document.getElementById('mod-bar')?.offsetParent, menu: !!document.getElementById('mobile-menu')?.offsetParent, layers: !!document.querySelector('.layers-panel')?.offsetParent }));
    await dctx.close();
    assert(!/\b(touch|compact|phone)\b/.test(d.cls) && !d.mod && !d.menu && d.layers, 'desktop layout ' + JSON.stringify(d));
    console.log('ok');
  } catch (e) { failed = true; console.log('FAILED\n  ' + e.message); }
}
await browser.close(); if (server) try { process.kill(-server.pid); } catch {}
if (failed) process.exit(1);
console.log('\nAll mobile checks passed. Screenshots: ' + SHOTS + '/mobile-*.png');
