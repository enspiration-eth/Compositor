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
  });

  await step('magic wand selection (wasm flood fill + trace)', async () => {
    await page.evaluate(() => { const { app } = window.compositor; app.setActive(app.doc.layers[0].id); });
    await page.click('.rail-btn[data-tool="wand"]');
    const [x, y] = await toScreen(800, 60); await page.mouse.click(x, y);
    assert((await st()).sel, 'selection exists');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/03-editor-selection.png` });
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
    console.log(`(manifest v${manifest.version}, ${manifest.layers.length} layers, ${Object.keys(files).length} entries) `);
    // Round-trip: reopen the saved project.
    await page.evaluate(async b64 => { const { app } = window.compositor; const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      await app.openFiles([new File([bytes], 'sample.comp.zip', { type: 'application/zip' })]); }, readFileSync(zipPath).toString('base64'));
    await page.waitForFunction(() => window.compositor.app.projects.length === 2);
    const s2 = await st(); assert(s2.layers === manifest.layers.length, 'reopened layers ' + s2.layers);
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
