// Headless smoke test: serves the production build with `vite preview`, drives the real UI in Chromium, and fails on
// any console error or broken core action. Usage: npm run build && npm run test:e2e  (SHOTS=dir to save screenshots)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

const URL_ = process.env.URL || 'http://localhost:4173/';
const SHOTS = process.env.SHOTS || '/workspace/compositor-shots';
mkdirSync(SHOTS, { recursive: true });

let server;
if (!process.env.URL) {
  server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { stdio: 'pipe', detached: true });
  await new Promise((res, rej) => {
    server.stdout.on('data', d => { if (String(d).includes('4173')) res(); });
    server.on('exit', c => rej(new Error('preview exited ' + c)));
    setTimeout(() => rej(new Error('preview timeout')), 20000);
  });
}

const errors = [];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
const step = async (name, fn) => { process.stdout.write(`• ${name} … `); await fn(); console.log('ok'); };
const assert = (c, msg) => { if (!c) throw new Error('assertion failed: ' + msg); };
const st = () => page.evaluate(() => {
  const { app } = window.compositor; const d = app.doc;
  return d ? { layers: d.layers.length, names: d.layers.map(l => l.name), active: app.active?.name, blend: app.active?.blend,
    w: d.width, h: d.height, sel: !!d.selection, undo: app.history.undoStack.length, redo: app.history.redoStack.length } : null;
});
const pixel = (x, y) => page.evaluate(([x, y]) => { const { app } = window.compositor; return Array.from(app.renderer.readPixel(app.doc, x, y)); }, [x, y]);
const toScreen = (x, y) => page.evaluate(([x, y]) => { const { app } = window.compositor; const r = document.getElementById('stage').getBoundingClientRect(); const s = app.toScreen(x, y); return [s[0] + r.left, s[1] + r.top]; }, [x, y]);
const menu = async (top, item) => { await page.click(`.menubar-item[data-menu="${top}"]`); await page.locator('.menu .menu-item', { hasText: item }).first().click(); };

try {
  await step('load app (wasm + WebGL2)', async () => {
    await page.goto(URL_, { waitUntil: 'networkidle' });
    await page.waitForSelector('#stage canvas.gl-canvas');
    assert(await page.evaluate(() => !!window.compositor), 'window.compositor');
  });
  await step('welcome screen screenshot', async () => { await page.screenshot({ path: `${SHOTS}/01-welcome.png` }); });

  await step('new canvas via dialog', async () => {
    await page.fill('#new-width', '1200'); await page.fill('#new-height', '800');
    await page.click('#create-canvas');
    const s = await st(); assert(s && s.w === 1200 && s.h === 800 && s.layers === 1, JSON.stringify(s));
    await page.evaluate(() => window.compositor.app.closeProject());
  });

  await step('open sample project', async () => {
    await page.getByText('Try a sample').click();
    await page.waitForFunction(() => window.compositor.app.doc?.layers.length === 4);
  });

  await step('add layer + paint with brush', async () => {
    await page.click('#addBlankLayer');
    let s = await st(); assert(s.layers === 5, 'layer added');
    await page.click('.rail-btn[data-tool="brush"]');
    await page.evaluate(() => { const { app } = window.compositor; app.brush.size = 60; app.fg = { red: 0.1, green: 0.8, blue: 0.3 }; });
    const [x0, y0] = await toScreen(200, 500), [x1, y1] = await toScreen(700, 560);
    await page.mouse.move(x0, y0); await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(x0 + (x1 - x0) * i / 20, y0 + (y1 - y0) * i / 20);
    await page.mouse.up();
    const p = await pixel(450, 530); assert(p[1] > 150 && p[0] < 80, 'painted green at stroke: ' + p);
  });

  await step('blend mode change', async () => {
    await page.selectOption('#blend-mode', 'Multiply');
    assert((await st()).blend === 'Multiply', 'multiply');
  });

  await step('undo / redo', async () => {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+z`); assert((await st()).blend === 'Normal', 'undo blend');
    await page.keyboard.press(`${mod}+z`); const p = await pixel(450, 530); assert(!(p[1] > 150 && p[0] < 80), 'stroke undone ' + p);
    await page.keyboard.press(`${mod}+Shift+z`); await page.keyboard.press(`${mod}+Shift+z`);
    const s = await st(); assert(s.blend === 'Multiply', 'redo blend');
  });

  await step('Hue/Saturation filter (wasm cube kernel)', async () => {
    await page.evaluate(() => { const { app } = window.compositor; app.setActive(app.doc.layers[0].id); });
    const before = await pixel(100, 100);
    await menu('Image', 'Hue/Saturation');
    await page.waitForSelector('#filter-panel');
    const hue = page.locator('#filter-panel .slider-row').first().locator('input[type=number]');
    await hue.fill('120'); await hue.press('Enter');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/02-filter-panel.png` });
    await page.click('#filter-ok');
    const after = await pixel(100, 100);
    assert(before.join() !== after.join(), `hue changed ${before} -> ${after}`);
  });

  await step('Camera Raw: Color Grading + Detail + Calibration (wasm)', async () => {
    const before = await pixel(100, 100);
    await menu('Filter', 'Camera Raw Filter');
    await page.waitForSelector('#filter-panel');
    const sec = name => page.locator(`#filter-panel .cr-section:has(summary:text-is("${name}"))`);
    await sec('Color Grading').locator('summary').click();
    const setRow = async (section, i, v) => { const n = sec(section).locator('.slider-row').nth(i).locator('input[type=number]'); await n.fill(String(v)); await n.press('Enter'); };
    await setRow('Color Grading', 0, 200); await setRow('Color Grading', 1, 80);   // shadows hue / saturation
    await sec('Detail').locator('summary').click(); await setRow('Detail', 0, 120); // sharpen amount
    await sec('Calibration').locator('summary').click(); await setRow('Calibration', 5, -60); // blue saturation
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/02b-camera-raw.png` });
    await page.click('#filter-ok');
    const after = await pixel(100, 100);
    assert(before.join() !== after.join(), `camera raw changed ${before} -> ${after}`);
  });

  await step('Camera Raw: point curve, Point Color, Geometry, clipping view', async () => {
    await page.evaluate(() => { const { app } = window.compositor; app.setActive(app.doc.layers.find(l => l.name === 'Sky').id); });
    const before = await page.evaluate(() => { const c = window.compositor.app.active.canvas; return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data.filter((_, i) => i % 4000 === 0)); });
    await menu('Filter', 'Camera Raw Filter');
    await page.waitForSelector('#filter-panel');
    const sec = name => page.locator(`#filter-panel .cr-section:has(summary:text-is("${name}"))`);
    const open = async (name, on = true) => { const d = sec(name); if ((await d.evaluate(e => e.open)) !== on) await d.locator('summary').click(); };
    // Point curve: add a point in the middle and lift it.
    await open('Curve');
    const cb = await page.locator('#cr-curve').boundingBox();
    await page.mouse.move(cb.x + cb.width * 0.5, cb.y + cb.height * 0.5); await page.mouse.down();
    await page.mouse.move(cb.x + cb.width * 0.5, cb.y + cb.height * 0.3, { steps: 4 }); await page.mouse.up();
    await open('Curve', false);
    // Point Color: sample the sky, push its hue.
    await open('Point Color');
    await page.click('#cr-point-sample');
    const [sx, sy] = await toScreen(800, 60); await page.mouse.click(sx, sy);
    await page.waitForSelector('#cr-point-color .swatch');
    const hs = page.locator('#cr-point-color .slider-row').first().locator('input[type=number]'); await hs.fill('80'); await hs.press('Enter');
    await open('Point Color', false);
    // Geometry: vertical perspective + a guided line.
    await open('Geometry');
    const gv = page.locator('#cr-geometry .slider-row').first().locator('input[type=number]'); await gv.fill('40'); await gv.press('Enter');
    await page.selectOption('#cr-upright', 'Guided');
    const [g0x, g0y] = await toScreen(300, 200), [g1x, g1y] = await toScreen(1300, 260);
    await page.mouse.move(g0x, g0y); await page.mouse.down(); await page.mouse.move(g1x, g1y, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/10-camera-raw-geometry.png` });
    // Clipping view (Highlights), then back off.
    await open('Basic');
    await page.selectOption('#cr-clipping', 'Highlights');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/10b-camera-raw-clipping.png` });
    await page.selectOption('#cr-clipping', 'Off');
    await page.click('#filter-ok');
    const r = await page.evaluate(() => { const { app, ctl } = window.compositor; const c = app.active.canvas;
      return { hook: !!app.canvasHook, px: Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data.filter((_, i) => i % 4000 === 0)), label: app.history.undoLabel }; });
    assert(!r.hook, 'canvas hook released');
    let diff = 0; for (let i = 0; i < before.length; i++) diff += Math.abs(before[i] - r.px[i]);
    assert(diff > 1000, 'camera raw geometry/curve/point color changed the layer ' + diff);
  });

  await step('Gaussian Blur filter', async () => {
    await page.evaluate(() => { const { app } = window.compositor; app.setActive(app.doc.layers[2].id); });
    await menu('Filter', 'Gaussian Blur');
    await page.waitForSelector('#filter-panel'); await page.click('#filter-ok');
    assert((await st()).undo > 0, 'blur recorded');
  });

  await step('adjustment layer (Levels via wasm)', async () => {
    const n = (await st()).layers;
    await page.evaluate(() => window.compositor.app.addAdjustmentLayer('Levels'));
    await page.waitForTimeout(200);
    if (await page.locator('#filter-panel').count()) await page.click('#filter-ok');
    assert((await st()).layers === n + 1, 'adjustment added');
    // It must actually change the composite (regression: adjustment layers once drew to the screen, not the layer buffer).
    const before = await pixel(800, 300);
    await page.evaluate(() => { const a = window.compositor.app.active; window.__lv = a.adjustment; a.adjustment = { ...a.adjustment, levels: { channel: 'RGB', ranges: [{ black: 60, gamma: 1, white: 200, outputBlack: 0, outputWhite: 255 }, ...a.adjustment.levels.ranges.slice(1)] } }; window.compositor.app.needsRender = true; });
    const after = await pixel(800, 300);
    assert(before.join() !== after.join(), `levels layer changed the composite ${before} -> ${after}`);
    await page.evaluate(() => { const a = window.compositor.app.active; a.adjustment = window.__lv; window.compositor.app.needsRender = true; });
  });

  await step('Hue/Saturation adjustment layer: Greens range + band edit', async () => {
    // Pick a clearly green spot of the composite.
    let gp = null;
    for (const [x, y] of [[60, 640], [60, 560], [1500, 640], [800, 700], [300, 620], [1550, 560]]) { const p = await pixel(x, y); if (p[1] > p[0] + 30 && p[1] > p[2] + 10) { gp = [x, y]; break; } }
    assert(gp, 'found a green pixel');
    const g0 = await pixel(...gp), s0 = await pixel(800, 20);
    await page.evaluate(() => window.compositor.app.addAdjustmentLayer('Hue/Saturation'));
    await page.dblclick('.layer-row.active .layer-name');
    await page.waitForSelector('#filter-panel #hs-range');
    await page.selectOption('#hs-range', 'Greens');
    const hue = page.locator('#filter-panel .slider-row').first().locator('input[type=number]');
    await hue.fill('180'); await hue.press('Enter');
    // Slide the Greens band a little (drag inside it).
    const box = await page.locator('#hs-spectrum').boundingBox();
    const bx = box.x + box.width * (120 / 360), by = box.y + 22;
    await page.mouse.move(bx, by); await page.mouse.down(); await page.mouse.move(bx + box.width * 10 / 360, by, { steps: 4 }); await page.mouse.up();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/09-hue-sat-ranges.png` });
    await page.click('#filter-ok');
    const a = await page.evaluate(() => window.compositor.app.active.adjustment.hsvSettings);
    assert(a && a.adjustments.Greens?.hue === 180 && a.bands?.Greens && Math.abs(a.bands.Greens[1] - 115) < 4, 'hsvSettings ' + JSON.stringify(a));
    const g1 = await pixel(...gp), s1 = await pixel(800, 20);
    assert(g0.join() !== g1.join() && Math.abs(s0[2] - s1[2]) <= 2, `greens shifted ${g0}->${g1}, sky kept ${s0}->${s1}`);
    // Hide it again so later steps see the original colors (it is still saved with the project).
    await page.evaluate(() => { const { app } = window.compositor; app.active.visible = false; app.changed('layers'); });
  });

  await step('Liquify push (wasm warp kernel)', async () => {
    await page.evaluate(() => { const { app } = window.compositor; app.setActive(app.doc.layers.find(l => l.name === 'Hills').id); app.smearMode = 'liquify'; app.smearStrength = 0.6; app.brush.size = 220; });
    await page.click('.rail-btn[data-tool="blur"]');
    const alphaAt = () => page.evaluate(() => { const { app } = window.compositor; return app.active.canvas.getContext('2d').getImageData(800, 770, 1, 1).data[3]; });
    const before = await alphaAt();
    const [x0, y0] = await toScreen(800, 900), [x1, y1] = await toScreen(800, 640);
    await page.mouse.move(x0, y0); await page.mouse.down();
    for (let i = 1; i <= 15; i++) await page.mouse.move(x0, y0 + (y1 - y0) * i / 15);
    await page.mouse.up();
    const after = await alphaAt();
    assert(before === 0 && after > 0, `hill pushed up: alpha ${before} -> ${after}`);
    assert((await st()).undo > 0, 'liquify recorded');
  });

  await step('rulers, grid, guides + snapping', async () => {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.evaluate(() => localStorage.removeItem('compositor.view'));
    await menu('View', 'Rulers');
    await page.waitForSelector('.ruler-x', { state: 'visible' });
    await page.keyboard.press(`${mod}+'`); // grid
    // Drag a vertical guide out of the left ruler to x≈400.
    const ry = await page.locator('.ruler-y').boundingBox();
    const [gx, gy] = await toScreen(400, 300);
    await page.mouse.move(ry.x + 9, gy); await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(ry.x + 9 + (gx - ry.x - 9) * i / 10, gy);
    await page.mouse.up();
    const guides = await page.evaluate(() => window.compositor.app.doc.guides);
    assert(guides.length === 1 && guides[0].axis === 'vertical' && Math.abs(guides[0].position - 400) <= 8, 'guide ' + JSON.stringify(guides));
    await page.keyboard.press(`${mod}+'`); // grid off so the guide is the nearest target
    // Move the text layer so its left edge lands within snapping distance of the guide.
    await page.click('.rail-btn[data-tool="move"]');
    const info = await page.evaluate(() => { const { app } = window.compositor; const l = app.doc.layers.find(x => x.name === 'Compositor'); app.setActive(l.id); return { x: l.transform.x, y: l.transform.y, w: l.transform.w, h: l.transform.h }; });
    const gpos = guides[0].position;
    const [sx, sy] = await toScreen(info.x + info.w / 2, info.y + info.h / 2);
    const [tx] = await toScreen(info.x + info.w / 2 + (gpos - info.x) + 3, 0);
    await page.mouse.move(sx, sy); await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(sx + (tx - sx) * i / 10, sy + 40 * i / 10);
    await page.mouse.up();
    const nx = await page.evaluate(() => window.compositor.app.active.transform.x);
    assert(nx === gpos, `snapped to guide: x=${nx} guide=${gpos}`);
    await page.waitForTimeout(200);
    await page.keyboard.press(`${mod}+'`);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SHOTS}/04-rulers-guides-grid.png` });
    await page.keyboard.press(`${mod}+'`);
  });

  await step('Free Distort (wasm perspective warp)', async () => {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.evaluate(() => { const { app } = window.compositor; app.setActive(app.doc.layers.find(l => l.name === 'Compositor').id); });
    await page.click('.rail-btn[data-tool="move"]');
    const c = await page.evaluate(() => { const { app } = window.compositor; const t = app.active.transform; return [t.x + t.w, t.y, t.w, t.h]; });
    const [x0, y0] = await toScreen(c[0], c[1]), [x1, y1] = await toScreen(c[0] + 160, c[1] - 90);
    await page.keyboard.down(mod);
    await page.mouse.move(x0, y0); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8);
    await page.mouse.up(); await page.keyboard.up(mod);
    assert(await page.evaluate(() => !!window.compositor.ctl.distort), 'distort session');
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SHOTS}/07-free-distort.png` });
    await page.keyboard.press('Enter');
    const s = await page.evaluate(() => { const { app, ctl } = window.compositor; return { active: !!ctl.distort, label: app.history.undoLabel, t: app.active.transform }; });
    assert(!s.active && s.label === 'Distort' && Math.abs(s.t.w - c[2]) > 30 && s.t.y !== c[1], 'distort applied ' + JSON.stringify({ s, c }));
  });

  await step('magic wand selection (wasm flood fill + trace)', async () => {
    await page.evaluate(() => { const { app } = window.compositor; app.setActive(app.doc.layers[0].id); });
    await page.click('.rail-btn[data-tool="wand"]');
    const [x, y] = await toScreen(800, 60); await page.mouse.click(x, y);
    assert((await st()).sel, 'selection exists');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/03-editor-selection.png` });
  });

  await step('Select Subject (U²-Net in onnxruntime wasm)', async () => {
    await page.evaluate(() => window.compositor.app.deselect());
    await menu('Select', 'Subject');
    await page.waitForFunction(() => !window.compositor.app.busy && window.compositor.app.history.undoLabel === 'Select Subject', null, { timeout: 90000 });
    assert((await st()).sel, 'subject selected');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/05-select-subject.png` });
  });

  await step('Object Selection click', async () => {
    await page.evaluate(() => { const { app } = window.compositor; app.deselect(); app.wandMode = 'object'; app.emit('tool'); });
    await page.click('.rail-btn[data-tool="wand"]');
    const [x, y] = await toScreen(450, 530); await page.mouse.click(x, y);
    await page.waitForFunction(() => !window.compositor.app.busy && window.compositor.app.history.undoLabel === 'Object Selection', null, { timeout: 60000 });
    const n = await page.evaluate(() => { const d = window.compositor.app.doc.selection.getContext('2d').getImageData(0, 0, 1600, 1000).data; let c = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 127) c++; return c; });
    assert(n > 15000 && n < 80000, 'object = the stroke, px ' + n);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/06-object-selection.png` });
    await page.evaluate(() => { const { app } = window.compositor; app.wandMode = 'wand'; app.deselect(); });
  });

  await step('Remove Background panel → layer mask', async () => {
    await page.evaluate(() => { const { app } = window.compositor; app.setActive(app.doc.layers.find(l => l.name === 'Sun').id); });
    await menu('Filter', 'Remove Background');
    await page.waitForSelector('#filter-panel');
    await page.click('#filter-panel .segmented button:has-text("Advanced")');
    await page.waitForFunction(() => !window.compositor.app.busy && document.getElementById('rb-status')?.textContent === '', null, { timeout: 60000 });
    await page.click('#filter-ok');
    await page.waitForFunction(() => window.compositor.app.active.mask && window.compositor.app.history.undoLabel === 'Remove Background', null, { timeout: 60000 });
  });

  await step('unlinked layer mask moves on its own', async () => {
    await page.evaluate(() => { const { app } = window.compositor; app.setActive(app.doc.layers.find(l => l.name === 'Hills').id); });
    await page.click('.rail-btn[data-tool="marquee"]');
    const drag = async (a, b) => { const [x0, y0] = await toScreen(...a), [x1, y1] = await toScreen(...b); await page.mouse.move(x0, y0); await page.mouse.down(); for (let i = 1; i <= 6; i++) await page.mouse.move(x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6); await page.mouse.up(); };
    await drag([200, 500], [800, 1000]);
    await page.evaluate(() => window.compositor.app.addMask(true));
    const t0 = await page.evaluate(() => JSON.stringify(window.compositor.app.active.transform));
    await page.click('.layer-row.active .mask-link');
    assert(await page.evaluate(() => window.compositor.app.active.maskLinked === false), 'unlinked');
    await page.click('.layer-row.active .mask-thumb');
    await page.click('.rail-btn[data-tool="move"]');
    await drag([500, 800], [900, 800]);
    const r = await page.evaluate(() => { const a = window.compositor.app.active; return { p: a.maskPlacement, t: JSON.stringify(a.transform), label: window.compositor.app.history.undoLabel }; });
    assert(r.label === 'Transform Layer Mask' && r.t === t0 && Math.abs(r.p.x - (JSON.parse(t0).x + 400)) <= 2, 'mask moved alone ' + JSON.stringify(r));
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/08-unlinked-mask.png` });
    // Now move the layer: the unlinked mask stays put on the document.
    await page.click('.layer-row.active .layer-name');
    await drag([500, 800], [500, 700]);
    const r2 = await page.evaluate(() => { const a = window.compositor.app.active; return { p: a.maskPlacement, t: a.transform }; });
    assert(Math.abs(r2.t.y - (JSON.parse(t0).y - 100)) <= 2 && Math.abs(r2.p.x - r.p.x) < 0.01 && Math.abs(r2.p.y - r.p.y) < 0.01, 'layer moved alone ' + JSON.stringify(r2));
    // Relink, then moving the layer carries the placed mask along.
    await page.click('.layer-row.active .mask-link');
    await drag([500, 700], [500, 750]);
    const r3 = await page.evaluate(() => { const { app } = window.compositor; const a = app.active; return { linked: a.maskLinked, x: a.maskPlacement?.x, y: a.maskPlacement?.y, ty: a.transform.y }; });
    assert(r3.linked === true && Math.abs(r3.ty - r2.t.y - 50) <= 2, 'relinked ' + JSON.stringify(r3));
    await page.evaluate(() => window.compositor.app.toggleMaskLink());
  });

  await step('export PNG + save .comp', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.compositor.app.exportImage('png'))]);
    assert(/\.png$/.test(dl.suggestedFilename()), dl.suggestedFilename());
    await page.evaluate(() => { window.__noPicker = true; });
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.compositor.app.save())]);
    assert(/\.comp/.test(dl2.suggestedFilename()), dl2.suggestedFilename());
    const zipPath = `${SHOTS}/sample.comp.zip`; await dl2.saveAs(zipPath);
    const { unzipSync, strFromU8 } = await import('fflate');
    const files = unzipSync(new Uint8Array(readFileSync(zipPath)));
    const manifestName = Object.keys(files).find(n => n.endsWith('manifest.json'));
    const manifest = JSON.parse(strFromU8(files[manifestName]));
    assert(manifest.layers?.length >= 5, 'manifest layers ' + manifest.layers?.length);
    assert(manifest.guides?.length === 1, 'manifest guides');
    const ml = manifest.layers.find(l => l.maskLinked === false);
    assert(ml && ml.maskPlacement?.origin?.length === 2, 'manifest unlinked mask placement');
    const hl = manifest.layers.find(l => l.adjustment?.hsvSettings);
    assert(hl && Array.isArray(hl.adjustment.hsvSettings.adjustments) && hl.adjustment.hsvSettings.adjustments.includes('Greens'), 'manifest hsvSettings (Mac encoding)');
    console.log(`(manifest v${manifest.version}, ${manifest.layers.length} layers, ${Object.keys(files).length} entries) `);
    // Round-trip: reopen the saved project.
    await page.evaluate(async b64 => { const { app } = window.compositor; const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      await app.openFiles([new File([bytes], 'sample.comp.zip', { type: 'application/zip' })]); }, readFileSync(zipPath).toString('base64'));
    await page.waitForFunction(() => window.compositor.app.projects.length === 2);
    const s2 = await st(); assert(s2.layers === manifest.layers.length, 'reopened layers ' + s2.layers);
    assert(await page.evaluate(() => window.compositor.app.doc.layers.some(l => l.maskLinked === false && l.maskPlacement)), 'reopened unlinked mask');
    assert(await page.evaluate(() => window.compositor.app.doc.layers.some(l => l.adjustment?.hsvSettings?.adjustments?.Greens?.hue === 180)), 'reopened hsv ranges');
  });

  await step('TIFF import (LZW, Deflate+alpha, 16-bit gray) + TIFF export', async () => {
    const fx = new URL('./fixtures/', import.meta.url);
    for (const [name, check] of [['gradient-lzw.tif', 'rgb'], ['rgba-deflate.tif', 'alpha'], ['gray16.tif', 'gray']]) {
      const b64 = readFileSync(new URL(name, fx)).toString('base64');
      const r = await page.evaluate(async ([b64, name]) => {
        const { app } = window.compositor; const n = app.projects.length;
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        await app.openFiles([new File([bytes], name, { type: 'image/tiff' })]);
        if (app.projects.length !== n + 1) return { err: 'no project' };
        const d = app.doc, l = d.layers.find(x => x.canvas);
        const px = (x, y) => Array.from(l.canvas.getContext('2d').getImageData(x, y, 1, 1).data);
        return { w: d.width, h: d.height, a: px(10, 10), b: px(80, 50) };
      }, [b64, name]);
      assert(!r.err && r.w === 96 && r.h === 64, name + ' ' + JSON.stringify(r));
      if (check === 'rgb') assert(Math.abs(r.a[0] - 26) < 4 && Math.abs(r.b[1] - 199) < 4 && r.a[2] === 200, name + ' px ' + JSON.stringify(r));
      if (check === 'alpha') assert(r.a[3] === 255 && r.b[3] === 128, name + ' alpha ' + JSON.stringify(r));
      if (check === 'gray') assert(Math.abs(r.b[0] - 212) < 4 && r.b[0] === r.b[1], name + ' gray ' + JSON.stringify(r));
    }
    const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.compositor.app.exportTiff())]);
    assert(/\.tif$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  });

  assert(errors.length === 0, 'console errors:\n' + errors.join('\n'));
  console.log('\nAll smoke checks passed. Screenshots in ' + SHOTS);
} catch (e) {
  await page.screenshot({ path: `${SHOTS}/failure.png` }).catch(() => {});
  console.error('\nFAILED:', e.message, errors.length ? '\n' + errors.join('\n') : '');
  process.exitCode = 1;
} finally {
  await browser.close(); if (server) try { process.kill(-server.pid); } catch {}
}
