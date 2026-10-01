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
const step = async (name, fn) => { process.stdout.write(`• ${name} … `); const t0 = Date.now(); await fn(); console.log(process.env.TIMING ? `ok (${Date.now() - t0} ms)` : 'ok'); };
const assert = (c, msg) => { if (!c) throw new Error('assertion failed: ' + msg); };
const st = () => page.evaluate(() => {
  const { app } = window.compositor; const d = app.doc;
  return d ? { layers: d.layers.length, names: d.layers.map(l => l.name), active: app.active?.name, blend: app.active?.blend,
    w: d.width, h: d.height, sel: !!d.selection, undo: app.history.undoStack.length, redo: app.history.redoStack.length } : null;
});
const pixel = (x, y) => page.evaluate(([x, y]) => { const { app } = window.compositor; return Array.from(app.renderer.readPixel(app.doc, x, y)); }, [x, y]);
const toScreen = (x, y) => page.evaluate(([x, y]) => { const { app } = window.compositor; const r = document.getElementById('stage').getBoundingClientRect(); const s = app.toScreen(x, y); return [s[0] + r.left, s[1] + r.top]; }, [x, y]);
const filterOk = async () => { await page.click('#filter-ok'); await page.waitForFunction(() => window.compositor.app.filtering === 0, null, { timeout: 60000 }); };
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
    await filterOk();
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
    await filterOk();
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
    await page.waitForSelector('#cr-point-color .pc-swatch');
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
    await filterOk();
    const r = await page.evaluate(() => { const { app, ctl } = window.compositor; const c = app.active.canvas;
      return { hook: !!app.canvasHook, px: Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data.filter((_, i) => i % 4000 === 0)), label: app.history.undoLabel }; });
    assert(!r.hook, 'canvas hook released');
    let diff = 0; for (let i = 0; i < before.length; i++) diff += Math.abs(before[i] - r.px[i]);
    assert(diff > 1000, 'camera raw geometry/curve/point color changed the layer ' + diff);
  });

  await step('Camera Raw: Auto/eyedropper white balance, defringe picker, targeted mixer, sharpen-mask view', async () => {
    await menu('Filter', 'Camera Raw Filter');
    await page.waitForSelector('#filter-panel');
    const sec = name => page.locator(`#filter-panel .cr-section:has(summary:text-is("${name}"))`);
    const open = async (name, on = true) => { const d = sec(name); if ((await d.evaluate(e => e.open)) !== on) await d.locator('summary').click(); };
    const val = async (name, i) => +(await sec(name).locator('.slider-row').nth(i).locator('input[type=number]').inputValue());
    await open('Basic');
    await page.selectOption('#cr-wb', 'Auto');
    await page.waitForTimeout(200);
    const autoT = await val('Basic', 0), autoTint = await val('Basic', 1);
    assert(autoT !== 0 || autoTint !== 0, `auto white balance moved temperature/tint ${autoT}/${autoTint}`);
    await page.click('#cr-wb-picker');
    const [sx, sy] = await toScreen(500, 420); await page.mouse.click(sx, sy);
    await page.waitForTimeout(200);
    const pickT = await val('Basic', 0);
    assert(Math.abs(pickT) <= 100 && Math.abs(autoT) <= 100 && (await page.inputValue('#cr-wb')) === 'Custom', `eyedropper set temperature ${pickT} (auto ${autoT})`);
    await page.click('#cr-wb-picker'); await open('Basic', false);
    // Targeted Color Mixer (saturation): drag upward on the sky.
    await open('Color Mixer');
    await page.click('#cr-mixer-target');
    await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx, sy - 120, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(200);
    const sats = []; for (let i = 8; i < 16; i++) sats.push(await val('Color Mixer', i));
    assert(sats.some(v => v > 0), 'targeted mixer raised a family saturation ' + sats);
    await page.click('#cr-mixer-target'); await open('Color Mixer', false);
    // Defringe eyedropper on the sky (blue → nearer the purple center).
    await open('Optics');
    await page.click('#cr-defringe-picker'); await page.mouse.click(sx, sy);
    await page.waitForTimeout(200);
    const purple = await page.evaluate(() => [...document.querySelectorAll('#filter-panel .slider-row')].filter(r => /Purple amount|Green amount/.test(r.textContent)).map(r => +r.querySelector('input[type=number]').value));
    assert(purple.includes(50), 'defringe picker set an amount ' + purple);
    await page.click('#cr-defringe-picker'); await open('Optics', false);
    // Option-drag Masking: the sharpen mask replaces the preview while held.
    await open('Detail');
    const row = sec('Detail').locator('.slider-row').nth(3).locator('input[type=range]');
    await row.dispatchEvent('pointerdown', { altKey: true, bubbles: true });
    await page.waitForFunction(() => { const c = window.compositor.app.active.canvas, d = c.getContext('2d').getImageData(c.width >> 1, 40, 1, 1).data; return d[0] === d[1] && d[1] === d[2]; }, null, { timeout: 20000 });
    await page.screenshot({ path: `${SHOTS}/14-camera-raw-sharpen-mask.png` });
    await row.dispatchEvent('pointerup', { bubbles: true });
    await page.waitForFunction(() => { const c = window.compositor.app.active.canvas, d = c.getContext('2d').getImageData(c.width >> 1, 40, 1, 1).data; return !(d[0] === d[1] && d[1] === d[2]); }, null, { timeout: 20000 });
    await open('Detail', false); await open('Color Mixer');
    await page.screenshot({ path: `${SHOTS}/14b-camera-raw-targeted.png` });
    await page.locator('#filter-panel button:text-is("Cancel")').click();
    assert(!(await page.evaluate(() => !!window.compositor.app.canvasHook)), 'canvas hook released');
  });

  await step('filters in Web Workers: strips match the whole-image result', async () => {
    const r = await page.evaluate(async () => {
      const { applyFilter, applyFilterAsync, poolSize, defaultFilterSettings } = window.compositor.filters;
      const c = window.compositor.app.doc.layers.find(l => l.name === 'Sky').canvas;
      const get = () => c.getContext('2d').getImageData(0, 0, c.width, c.height);
      const res = {};
      for (const [kind, patch] of [['Gaussian Blur', { radius: 12 }], ['Hue/Saturation', {}], ['Add Noise', { amount: 30 }], ['Motion Blur', { angle: 30, distance: 40 }]]) {
        const s = { ...defaultFilterSettings(), ...patch };
        if (kind === 'Hue/Saturation') s.hueSat.adjustments.Master = { hue: 90, saturation: 20, lightness: 0 };
        const ctx = { seed: 7, scale: 1 };
        const t0 = performance.now(); const a = await applyFilterAsync(kind, s, get(), ctx); const t1 = performance.now();
        const b = applyFilter(kind, s, get(), ctx); const t2 = performance.now();
        // Colors compared as premultiplied (a 1/255-alpha pixel's straight color is noise).
        let diff = 0; for (let i = 0; i < a.data.length; i++) { const al = (i & 3) === 3 ? 255 : Math.min(a.data[i | 3], b.data[i | 3]); diff = Math.max(diff, Math.abs(a.data[i] - b.data[i]) * al / 255); }
        res[kind] = { diff, workers: Math.round(t1 - t0), main: Math.round(t2 - t1) };
      }
      return { pool: poolSize(), res };
    });
    console.log('(pool', r.pool, JSON.stringify(r.res) + ')');
    for (const [k, v] of Object.entries(r.res)) assert(v.diff <= 2, `${k} strips differ by ${v.diff}`);
  });

  await step('Gaussian Blur filter', async () => {
    await page.evaluate(() => { const { app } = window.compositor; app.setActive(app.doc.layers[2].id); });
    await menu('Filter', 'Gaussian Blur');
    await page.waitForSelector('#filter-panel'); await filterOk();
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

  await step('Hue/Saturation eyedroppers (Sample / Add / Remove) and targeted drag', async () => {
    await page.evaluate(() => window.compositor.app.addAdjustmentLayer('Hue/Saturation'));
    await page.dblclick('.layer-row.active .layer-name');
    await page.waitForSelector('#filter-panel #hs-range');
    await page.selectOption('#hs-range', 'Blues');
    const hsv = () => page.evaluate(() => window.compositor.app.active.adjustment.hsvSettings);
    const sky = await pixel(800, 60);
    await page.click('#hs-sample');
    { const [x, y] = await toScreen(800, 60); await page.mouse.click(x, y); }
    const a = await hsv();
    const b = a.bands.Blues, mid = ((b[1] + ((b[2] - b[1] + 360) % 360) / 2) % 360);
    // The sky's own hue (from the composite below the adjustment).
    const max = Math.max(...sky.slice(0, 3)), min = Math.min(...sky.slice(0, 3)), d = max - min;
    let hue = max === sky[0] ? (sky[1] - sky[2]) / d : max === sky[1] ? 2 + (sky[2] - sky[0]) / d : 4 + (sky[0] - sky[1]) / d; hue = (hue * 60 + 360) % 360;
    assert(Math.abs(mid - hue) < 3, `Sample centered Blues on ${hue.toFixed(1)}: ${b}`);
    await page.click('#hs-remove');
    { const [x, y] = await toScreen(800, 60); await page.mouse.click(x, y); }
    const r = (await hsv()).bands.Blues;
    assert(JSON.stringify(r) !== JSON.stringify(b), 'Remove narrowed the band ' + r);
    await page.click('#hs-add');
    { const [x, y] = await toScreen(800, 60); await page.mouse.click(x, y); }
    const ad = (await hsv()).bands.Blues;
    assert(JSON.stringify(ad) !== JSON.stringify(r), 'Add widened it again ' + ad);
    // Targeted: drag right on the sky raises the saturation of the range that owns its color.
    await page.click('#hs-target');
    { const [x, y] = await toScreen(800, 60); await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 60, y, { steps: 5 }); await page.mouse.up(); }
    const t = await hsv();
    const owner = Object.entries(t.adjustments).find(([, v]) => v.saturation > 20);
    assert(owner && t.range === owner[0], 'targeted saturation ' + JSON.stringify(t.adjustments) + ' range ' + t.range);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/13-hue-sat-eyedroppers.png` });
    await page.click('#filter-panel button:has-text("Cancel")');
    assert(await page.evaluate(() => !window.compositor.app.canvasHook), 'eyedropper released');
    await page.evaluate(() => { const { app } = window.compositor; app.deleteLayers(); });
  });

  await step('adjustment layers recompute in the workers while the canvas keeps the last result', async () => {
    const r = await page.evaluate(async () => {
      const { app } = window.compositor;
      const sky = app.doc.layers.find(l => l.name === 'Sky');
      const before = app.renderer.frameKey;
      sky.transform = { ...sky.transform, x: sky.transform.x + 3 }; sky.rev++; app.needsRender = true;
      await new Promise(r => setTimeout(r, 1500));
      const exact = app.renderer.readPixel(app.doc, 800, 300);
      sky.transform = { ...sky.transform, x: sky.transform.x - 3 }; sky.rev++; app.needsRender = true;
      await new Promise(r => setTimeout(r, 1500));
      return { frames: app.renderer.frameKey - before, exact };
    });
    assert(r.frames >= 2, 'canvas redrew after the background result ' + JSON.stringify(r));
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

  await step('live shape: redrawn when scaled, style editable', async () => {
    await page.click('.rail-btn[data-tool="shape"]');
    await page.evaluate(() => { const { app } = window.compositor; app.shape.kind = 'Rectangle'; app.shape.cornerRadius = 40; app.emit('tool'); });
    const drag = async (a, b, mods = []) => { const [x0, y0] = await toScreen(...a), [x1, y1] = await toScreen(...b); for (const m of mods) await page.keyboard.down(m); await page.mouse.move(x0, y0); await page.mouse.down(); for (let i = 1; i <= 6; i++) await page.mouse.move(x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6); await page.mouse.up(); for (const m of mods) await page.keyboard.up(m); };
    await drag([1000, 600], [1200, 700]);
    const s0 = await page.evaluate(() => { const a = window.compositor.app.active; return { shape: a.shape?.kind, cw: a.canvas.width, t: a.transform }; });
    assert(s0.shape === 'Rectangle' && s0.cw === 200, 'shape drawn ' + JSON.stringify(s0));
    await page.click('.rail-btn[data-tool="move"]');
    await drag([s0.t.x + s0.t.w, s0.t.y + s0.t.h], [s0.t.x + s0.t.w + 200, s0.t.y + s0.t.h + 100]);
    const s1 = await page.evaluate(() => { const a = window.compositor.app.active; return { shape: !!a.shape, cw: a.canvas.width, ch: a.canvas.height, t: a.transform }; });
    assert(s1.shape && Math.abs(s1.cw - s1.t.w) <= 1 && Math.abs(s1.ch - s1.t.h) <= 1 && s1.cw > 300, 'shape redrawn at new size ' + JSON.stringify(s1));
    await page.click('.rail-btn[data-tool="shape"]');
    const r = page.locator('#shape-radius input[type=number], .slider-row:has-text("Corner Radius") input[type=number]').first(); await r.fill('5'); await r.press('Enter');
    const s2 = await page.evaluate(() => { const { app } = window.compositor; return { r: app.active.shape?.cornerRadius, label: app.history.undoLabel }; });
    assert(s2.r === 5 && s2.label === 'Corner Radius', 'corner radius edited ' + JSON.stringify(s2));
  });

  await step('layer effects (the Mac app\'s effect passes in wasm)', async () => {
    await page.evaluate(() => { const { app } = window.compositor; const a = app.active;
      a.effects = { stroke: { size: 10, red: 1, green: 0, blue: 0, opacity: 1, inside: false }, shadow: { angle: 90, distance: 30, blur: 0, red: 0, green: 0, blue: 1, opacity: 1 } }; a.rev++; app.changed('layers'); });
    await page.waitForTimeout(300);
    const t = await page.evaluate(() => window.compositor.app.active.transform);
    const cx = Math.round(t.x + t.w / 2), top = Math.round(t.y), bottom = Math.round(t.y + t.h);
    const ring = await pixel(cx, top - 5), shadow = await pixel(cx, bottom + 20), body = await pixel(cx, top + 20);
    assert(ring[0] > 200 && ring[1] < 60 && ring[2] < 60, 'outside stroke ' + ring);
    assert(shadow[2] > 200 && shadow[0] < 60, 'drop shadow ' + shadow);
    assert(body[1] > 150 && body[0] < 100, 'layer itself ' + body);
    await page.evaluate(() => { const { app } = window.compositor; const a = app.active;
      a.effects = { stroke: { size: 6, red: 1, green: 1, blue: 1, opacity: 1, inside: true }, innerShadow: { angle: 120, distance: 12, blur: 12, red: 0, green: 0, blue: 0, opacity: 0.8 },
        outerGlow: { size: 24, red: 1, green: 0.85, blue: 0.2, opacity: 0.9 }, shadow: { angle: 90, distance: 18, blur: 24, red: 0, green: 0, blue: 0, opacity: 0.6 } }; a.rev++; app.changed('layers'); });
    await page.waitForTimeout(300);
    const inside = await pixel(cx, top + 3), glow = await pixel(cx, top - 12);
    assert(inside[0] > 230 && inside[1] > 230 && inside[2] > 230, 'inside stroke ' + inside);
    assert(glow[0] > 150 && glow[1] > 120, 'outer glow ' + glow);
    await page.screenshot({ path: `${SHOTS}/12-layer-effects.png` });
  });

  await step('text color/font runs on selected letters', async () => {
    await page.click('.rail-btn[data-tool="type"]');
    { const [x, y] = await toScreen(300, 900); await page.mouse.click(x, y); }
    await page.waitForSelector('textarea.text-editor');
    // Keys typed before the editor takes focus would be tool shortcuts (slow CI machines).
    await page.waitForFunction(() => document.activeElement?.classList.contains('text-editor'));
    await page.keyboard.type('Live Type');
    await page.keyboard.press('Control+Enter');
    const t = await page.evaluate(() => window.compositor.app.active.transform);
    const [x, y] = await toScreen(t.x + t.w / 2, t.y + t.h / 2); await page.mouse.click(x, y);
    await page.waitForSelector('textarea.text-editor');
    await page.waitForFunction(() => document.activeElement?.classList.contains('text-editor'));
    assert(await page.evaluate(() => { const ta = document.querySelector('textarea.text-editor'); ta.setSelectionRange(0, 4); return ta.value === 'Live Type' && !!ta._ctx.layer; }), 'editing the existing text layer');
    await page.evaluate(() => { const w = document.getElementById('type-color'); w.value = '#ff2a2a'; w.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(100);
    await page.evaluate(() => { const ta = document.querySelector('textarea.text-editor'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
    await page.keyboard.type('!');
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SHOTS}/11-text-runs.png` });
    await page.keyboard.press('Control+Enter');
    const r = await page.evaluate(() => { const a = window.compositor.app.active; return { content: a.text.content, runs: a.text.colorRuns, label: window.compositor.app.history.undoLabel }; });
    assert(r.content.endsWith('!') && r.runs?.length === 1 && r.runs[0].location === 0 && r.runs[0].length === 4 && r.runs[0].red === 1, 'color run ' + JSON.stringify(r));
  });

  await step('magic wand selection (wasm flood fill + trace)', async () => {
    await page.evaluate(() => { const { app } = window.compositor; app.setActive(app.doc.layers[0].id); });
    await page.click('.rail-btn[data-tool="wand"]');
    const [x, y] = await toScreen(800, 60); await page.mouse.click(x, y);
    assert((await st()).sel, 'selection exists');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/03-editor-selection.png` });
  });

  await step('Expand / Contract / Feather selection and the Blur brush (wasm)', async () => {
    await page.evaluate(() => window.compositor.app.deselect());
    await page.click('.rail-btn[data-tool="marquee"]');
    const drag = async (a, b) => { const [x0, y0] = await toScreen(...a), [x1, y1] = await toScreen(...b); await page.mouse.move(x0, y0); await page.mouse.down(); for (let i = 1; i <= 6; i++) await page.mouse.move(x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6); await page.mouse.up(); };
    await drag([200, 200], [400, 300]);
    const stats = () => page.evaluate(() => { const s = window.compositor.app.doc.selection; if (!s) return null; const d = s.getContext('2d').getImageData(0, 0, s.width, s.height).data; let sum = 0, soft = 0; for (let i = 3; i < d.length; i += 4) { sum += d[i] / 255; if (d[i] > 0 && d[i] < 255) soft++; } return { sum: Math.round(sum), soft }; });
    const s0 = await stats();
    await page.evaluate(() => window.compositor.app.modifySelection('expand', 10));
    const s1 = await stats();
    // A 200×100 rectangle grown by 10 with round corners: 200·100 + 2·10·300 + π·100.
    assert(Math.abs(s1.sum - (s0.sum + 6000 + 314)) < 150, `expand ${s0.sum} -> ${s1.sum}`);
    await page.evaluate(() => window.compositor.app.modifySelection('contract', 20));
    const s2 = await stats();
    assert(Math.abs(s2.sum - 180 * 80) < 150, 'contract ' + s2.sum);
    await page.evaluate(() => window.compositor.app.modifySelection('feather', 8));
    const s3 = await stats();
    assert(s3.soft > 2000 && Math.abs(s3.sum - s2.sum) < 300, 'feather ' + JSON.stringify(s3));
    await page.evaluate(() => window.compositor.app.deselect());
    // Blur brush: paints a softened copy of the layer through the brush.
    await page.evaluate(() => { const { app } = window.compositor; app.setActive(app.doc.layers.find(l => l.name === 'Hills').id); app.smearMode = 'blur'; app.blurRadius = 20; app.smearStrength = 1; app.brush.size = 120; app.brush.hardness = 1; app.emit('tool'); });
    await page.click('.rail-btn[data-tool="blur"]');
    assert(await page.locator('#blur-radius').count() === 1, 'Radius control');
    const edge = await page.evaluate(() => { const c = window.compositor.app.active.canvas; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let y = 0; y < c.height; y++) if (d[(y * c.width + 700) * 4 + 3] > 128) return y; return -1; });
    const before = await pixel(700, edge - 4);
    await drag([660, edge], [740, edge]);
    const r = await page.evaluate(() => window.compositor.app.history.undoLabel);
    const after = await pixel(700, edge - 4);
    assert(r === 'Blur' && before.join() !== after.join(), `blur brush ${r} ${before} -> ${after}`);
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
    const count = () => page.evaluate(() => { const d = window.compositor.app.doc.selection.getContext('2d').getImageData(0, 0, 1600, 1000).data; let c = 0, soft = 0; for (let i = 3; i < d.length; i += 4) { if (d[i] > 127) c++; if (d[i] > 0 && d[i] < 255) soft++; } return { c, soft }; });
    const n = await count();
    assert(n.c > 15000 && n.c < 80000, 'object = the stroke, px ' + n.c);
    assert(n.soft > 100, 'anti-aliased, smoothed outline ' + n.soft);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/06-object-selection.png` });
    // Edge +4 erodes the hard mask; Anti-alias off keeps the raw pixel mask.
    await page.evaluate(() => { const { app } = window.compositor; app.deselect(); app.objectSel.edgeOffset = 4; app.objectSel.antiAlias = false; });
    await page.mouse.click(x, y);
    await page.waitForFunction(() => !window.compositor.app.busy && window.compositor.app.doc.selection, null, { timeout: 60000 });
    const e = await count();
    assert(e.soft === 0 && e.c < n.c && e.c > n.c * 0.4, 'eroded raw mask ' + JSON.stringify(e) + ' vs ' + n.c);
    await page.evaluate(() => { const { app } = window.compositor; app.objectSel.edgeOffset = 0; app.objectSel.antiAlias = true; });
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
    // The unlinked mask's own handles: scale from a corner, then rotate; the layer stays put.
    {
      const p = r.p, [cx, cy] = await toScreen(p.x, p.y), [ex, ey] = await toScreen(p.x + 300, p.y + 200);
      await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(ex, ey, { steps: 6 }); await page.mouse.up();
      const s1 = await page.evaluate(() => { const a = window.compositor.app.active; return { p: a.maskPlacement, t: JSON.stringify(a.transform) }; });
      assert(s1.t === t0 && s1.p.w < p.w - 150 && Math.abs(s1.p.w / s1.p.h - p.w / p.h) < 0.02, 'mask scaled alone ' + JSON.stringify(s1));
      const [tx, ty] = await toScreen(s1.p.x + s1.p.w / 2, s1.p.y), [rx, ry] = await toScreen(s1.p.x + s1.p.w / 2 + 300, s1.p.y + s1.p.h / 2 - 200);
      await page.mouse.move(tx, ty - 24); await page.mouse.down(); await page.mouse.move(rx, ry, { steps: 8 }); await page.mouse.up();
      const s2 = await page.evaluate(() => { const a = window.compositor.app.active; return { p: a.maskPlacement, t: JSON.stringify(a.transform), label: window.compositor.app.history.undoLabel }; });
      assert(s2.t === t0 && Math.abs(s2.p.rotation) > 20 && s2.label === 'Transform Layer Mask', 'mask rotated alone ' + JSON.stringify(s2));
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SHOTS}/15-mask-scale-rotate.png` });
      await page.evaluate(() => { window.compositor.app.undo(); window.compositor.app.undo(); });
      const back = await page.evaluate(() => window.compositor.app.active.maskPlacement);
      assert(Math.abs(back.w - p.w) < 0.01 && !back.rotation, 'undo restores the mask placement ' + JSON.stringify(back));
    }
    // Painting the moved mask happens in its own grid: it stays placed (not resampled into the layer's grid).
    {
      await page.evaluate(() => { const { app } = window.compositor; app.deselect(); app.fg = { red: 0, green: 0, blue: 0 }; app.brush.mode = 'paint'; app.brush.opacity = 1; app.brush.size = 60; });
      await page.click('.rail-btn[data-tool="brush"]');
      await drag([850, 700], [950, 800]);
      const m = await page.evaluate(() => { const { app } = window.compositor; const a = app.active, x = a.mask.getContext('2d');
        return { p: a.maskPlacement, w: a.mask.width, inside: Array.from(x.getImageData(500, 750, 1, 1).data), untouched: Array.from(x.getImageData(300, 900, 1, 1).data), label: app.history.undoLabel }; });
      assert(m.label === 'Brush' && Math.abs(m.p.x - r.p.x) < 0.01 && m.w === 1600 && m.inside[0] < 40 && m.untouched[0] > 200, 'painted in the mask grid ' + JSON.stringify(m));
      await page.evaluate(() => window.compositor.app.undo());
      await page.click('.rail-btn[data-tool="move"]');
    }
    // Now move the layer: the unlinked mask stays put on the document.
    await page.click('.layer-row.active .layer-name');
    await drag([500, 800], [500, 700]);
    const r2 = await page.evaluate(() => { const a = window.compositor.app.active; return { p: a.maskPlacement, t: a.transform }; });
    assert(Math.abs(r2.t.y - (JSON.parse(t0).y - 100)) <= 2 && Math.abs(r2.p.x - r.p.x) < 0.01 && Math.abs(r2.p.y - r.p.y) < 0.01, 'layer moved alone ' + JSON.stringify(r2));
    // Relink, then moving the layer carries the placed mask along.
    await page.click('.layer-row.active .mask-link');
    await drag([500, 700], [500, 750]);
    const r3 = await page.evaluate(() => { const { app } = window.compositor; const a = app.active; return { linked: a.maskLinked, x: a.maskPlacement?.x, y: a.maskPlacement?.y, ty: a.transform.y }; });
    assert(r3.linked === true && Math.abs(r3.ty - r2.t.y - 50) <= 8 /* may snap to another layer's edge */, 'relinked ' + JSON.stringify(r3));
    await page.evaluate(() => window.compositor.app.toggleMaskLink());
  });

  await step('Transform Selection (⌘T with a selection): lift, move, merge back as one undo step', async () => {
    await page.evaluate(() => { const { app } = window.compositor; app.deselect();
      const c = document.createElement('canvas'); c.width = 200; c.height = 200; const x = c.getContext('2d'); x.fillStyle = '#ff0000'; x.fillRect(0, 0, 200, 200);
      app.placeImage(c, 'Red Square', [200, 200]); });
    await page.click('.rail-btn[data-tool="marquee"]');
    { const [x0, y0] = await toScreen(100, 100), [x1, y1] = await toScreen(200, 300); await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 4 }); await page.mouse.up(); }
    const n0 = (await st()).layers;
    await page.keyboard.press('Control+t');
    await page.waitForFunction(() => !!window.compositor.app.floating);
    assert((await st()).layers === n0 + 1 && (await pixel(150, 200))[0] > 200, 'floating layer shows the lifted pixels');
    { const [x0, y0] = await toScreen(150, 200), [x1, y1] = await toScreen(450, 200); await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 6 }); await page.mouse.up(); }
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/16-transform-selection.png` });
    await page.keyboard.press('Enter');
    const r = await page.evaluate(() => { const { app } = window.compositor; const a = app.active; return { floating: !!app.floating, name: a.name, t: a.transform, label: app.history.undoLabel, n: app.doc.layers.length }; });
    const moved = await pixel(450, 200), cleared = await pixel(150, 200), kept = await pixel(250, 200);
    assert(!r.floating && r.name === 'Red Square' && r.label === 'Transform Selection' && r.n === n0 && Math.abs(r.t.w - 400) <= 3, 'merged back ' + JSON.stringify(r));
    assert(moved[0] > 200 && moved[1] < 60 && !(cleared[0] > 200 && cleared[1] < 60) && kept[0] > 200 && kept[1] < 60, `pixels moved ${moved} ${cleared} ${kept}`);
    await page.evaluate(() => window.compositor.app.undo());
    const back = await page.evaluate(() => ({ w: window.compositor.app.active.transform.w, n: window.compositor.app.doc.layers.length }));
    assert(back.w === 200 && back.n === n0 && (await pixel(150, 200))[0] > 200, 'one undo restores ' + JSON.stringify(back));
    // Escape cancels exactly.
    await page.keyboard.press('Control+t');
    await page.waitForFunction(() => !!window.compositor.app.floating);
    await page.keyboard.press('Escape');
    const c = await page.evaluate(() => ({ f: !!window.compositor.app.floating, n: window.compositor.app.doc.layers.length, w: window.compositor.app.active.transform.w }));
    assert(!c.f && c.n === n0 && c.w === 200 && (await pixel(150, 200))[0] > 200, 'escape restores ' + JSON.stringify(c));
    await page.evaluate(() => window.compositor.app.deselect());
    await page.click('.rail-btn[data-tool="move"]');
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
    assert(manifest.layers.some(l => l.text?.colorRuns?.length === 1), 'manifest text colorRuns');
    const hl = manifest.layers.find(l => l.adjustment?.hsvSettings);
    assert(hl && Array.isArray(hl.adjustment.hsvSettings.adjustments) && hl.adjustment.hsvSettings.adjustments.includes('Greens'), 'manifest hsvSettings (Mac encoding)');
    console.log(`(manifest v${manifest.version}, ${manifest.layers.length} layers, ${Object.keys(files).length} entries) `);
    // Save as .comp Folder… into a real directory handle (the origin-private file system stands in for the picker).
    const folder = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      await window.compositor.app.saveFolder(root);
      const out = [];
      const walk = async (d, pre) => { for await (const [n, h] of d.entries()) { if (h.kind === 'directory') await walk(h, pre + n + '/'); else out.push(pre + n); } };
      await walk(root, '');
      const pkg = [...(await (async () => { const a = []; for await (const [n] of root.entries()) a.push(n); return a; })())].find(n => n.endsWith('.comp'));
      const m = JSON.parse(await (await (await (await root.getDirectoryHandle(pkg)).getFileHandle('manifest.json')).getFile()).text());
      return { files: out.sort(), layers: m.layers.length };
    });
    assert(folder.layers === manifest.layers.length && folder.files.join() === Object.keys(files).filter(n => !n.endsWith('/')).sort().join(), 'folder package matches the zip ' + JSON.stringify(folder));
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
