import { chromium, devices } from 'playwright';
const [base, tag] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const out = n => `/workspace/compositor-shots/inputs-v3-${tag}-${n}.png`;
for (const [name, ctxOpts] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['phone', { ...devices['iPhone 15'] }]]) {
  const ctx = await b.newContext(ctxOpts); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(base); await p.waitForFunction(() => window.compositor?.app); await p.waitForTimeout(600);
  await p.getByText('Try a sample').click(); await p.waitForFunction(() => window.compositor.app.doc?.layers.length === 4);
  await p.evaluate(() => document.querySelector('.rail-btn[data-tool="brush"]').click()); await p.waitForTimeout(400);
  let hb = await p.locator('.tool-header').boundingBox();
  await p.screenshot({ path: out(`options-bar-${name}`), clip: { x: 0, y: hb.y, width: name === 'phone' ? 393 : 1100, height: hb.height } });
  if (name === 'phone' && await p.locator('#tool-options-toggle').isVisible()) {
    await p.tap('#tool-options-toggle'); await p.waitForTimeout(200); hb = await p.locator('.tool-header').boundingBox();
    await p.screenshot({ path: out('options-expanded-phone'), clip: { x: 0, y: hb.y, width: 393, height: hb.height } });
    await p.tap('#tool-options-toggle');
  }
  if (name === 'desktop') {
    await p.evaluate(() => document.querySelector('.rail-btn[data-tool="move"]').click()); await p.waitForTimeout(300);
    hb = await p.locator('.tool-header').boundingBox();
    await p.screenshot({ path: out('options-bar-transform'), clip: { x: 0, y: hb.y, width: 1440, height: hb.height } });
    await p.keyboard.press('Control+Alt+c'); await p.waitForSelector('#canvas-width'); await p.waitForTimeout(200);
    await p.locator('.modal').screenshot({ path: out('canvas-size') }); await p.keyboard.press('Escape');
  }
  console.log(name, errs); await ctx.close();
}
await b.close();
