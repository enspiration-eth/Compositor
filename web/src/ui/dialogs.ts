// Panels and sheets: UI/FilterSheet.swift, LevelsSheet.swift, CurvesControls.swift, HueSaturationSheet.swift,
// EffectsSheet.swift, NewCanvasSheet.swift, CanvasSizeSheet.swift, ImageSizeSheet.swift, JPEGExportSheet.swift.
import { app } from './app';
import { h, slider, select, checkbox, colorWell, button, floatingPanel, modal, toast, type Panel } from './dom';
import {
  type FilterKind, type FilterSettings, defaultFilterSettings, applyFilter, canvasOf, ctx2d, imageDataOf, COLOR_RANGES, DITHER_STYLES,
  curveValue, levelsTables, autoLevels, type AdjustmentRecord, adjustmentAsFilter, type CurvePoint, type ColorRangeName,
} from '../engine/adjustments';
import { levelsHistogram } from '../engine/kernels';
import { type Layer, type EffectKey, EFFECT_NAMES, cloneCanvas } from '../engine/document';
import * as Sel from '../engine/selection';
import { view, setView, addGuide } from './guides';

let openPanel: { panel: Panel; cancel: () => void } | null = null;
export function closeOpenPanel() { if (openPanel) { openPanel.cancel(); openPanel.panel.close(); openPanel = null; } }
export function hasOpenPanel() { return !!openPanel; }
let lastSettings = defaultFilterSettings();

const CHANNELS = ['RGB', 'Red', 'Green', 'Blue'] as const;

/** Builds the controls for one filter kind, mutating `s` and calling `changed` on every edit. */
function controls(kind: FilterKind, s: FilterSettings, changed: () => void, rebuild: () => void, forAdjustmentLayer = false): HTMLElement {
  const box = h('div', { class: 'controls' });
  const sl = (label: string, get: () => number, set: (v: number) => void, min: number, max: number, step = 1, unit = '') =>
    box.append(slider({ label, min, max, step, unit, value: get(), onInput: v => { set(v); changed(); } }));
  switch (kind) {
    case 'Gaussian Blur': sl('Radius', () => s.radius, v => s.radius = v, 0.1, 250, 0.1, 'px'); break;
    case 'Motion Blur': sl('Angle', () => s.angle, v => s.angle = v, -90, 90, 1, '°'); sl('Distance', () => s.distance, v => s.distance = v, 1, 1000, 1, 'px'); break;
    case 'Add Noise':
      sl('Amount', () => s.amount, v => s.amount = v, 0.1, 400, 0.1, '%');
      box.append(h('div', { class: 'row' }, select(['Uniform', 'Gaussian'], s.gaussian ? 'Gaussian' : 'Uniform', v => { s.gaussian = v === 'Gaussian'; changed(); }),
        checkbox('Monochromatic', s.monochromatic, v => { s.monochromatic = v; changed(); })));
      break;
    case 'Vignette':
      sl('Amount', () => s.vignetteAmount, v => s.vignetteAmount = v, 0, 100); sl('Midpoint', () => s.vignetteMidpoint, v => s.vignetteMidpoint = v, 0, 100);
      sl('Roundness', () => s.vignetteRoundness, v => s.vignetteRoundness = v, -100, 100); sl('Feather', () => s.vignetteFeather, v => s.vignetteFeather = v, 0, 100);
      sl('Highlights', () => s.vignetteHighlights, v => s.vignetteHighlights = v, 0, 100);
      box.append(colorWell(s.vignetteColor, c => { s.vignetteColor = c; changed(); }, 'Color'));
      break;
    case 'Bloom / Glow': sl('Amount', () => s.bloomAmount, v => s.bloomAmount = v, 0, 100); sl('Radius', () => s.bloomRadius, v => s.bloomRadius = v, 1, 150, 1, 'px'); break;
    case 'Tonal Contrast':
      sl('Amount', () => s.tonalAmount, v => s.tonalAmount = v, 0, 100); sl('Detail', () => s.tonalRadius, v => s.tonalRadius = v, 1, 100, 1, 'px');
      sl('Shadows', () => s.tonalShadows, v => s.tonalShadows = v, -100, 100); sl('Midtones', () => s.tonalMidtones, v => s.tonalMidtones = v, -100, 100);
      sl('Highlights', () => s.tonalHighlights, v => s.tonalHighlights = v, -100, 100);
      break;
    case 'Lens Correction': sl('Remove Distortion', () => s.distortion, v => s.distortion = v, -100, 100); break;
    case 'Dither': {
      const ds = s.dither;
      box.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Style'), select(DITHER_STYLES.map((l, i) => ({ label: l, value: i })), ds.style, v => { ds.style = v; changed(); rebuild(); })));
      if (ds.style !== 9 && ds.style !== 10) {
        sl('Pixel Size', () => ds.pixelSize, v => ds.pixelSize = v, 1, 32, 1, 'px');
        box.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Pixel'), select(['Square', 'Dot'], ds.pixelShape, v => { ds.pixelShape = v as 'Square'; changed(); })));
      }
      if (ds.style <= 4) sl('Levels', () => ds.levels, v => ds.levels = v, 2, 8);
      if (ds.style <= 1) sl('Diffusion', () => ds.diffusion, v => ds.diffusion = v, 0, 100, 1, '%');
      if (ds.style >= 5 && ds.style <= 8) { sl('Cell Size', () => ds.cellSize, v => ds.cellSize = v, 4, 64, 1, 'px'); if (ds.style <= 7) sl('Angle', () => ds.angle, v => ds.angle = v, -90, 90, 1, '°'); }
      if (ds.style === 9) {
        sl('Text Size', () => ds.textSize, v => ds.textSize = v, 6, 64, 1, 'px');
        const t = h('input', { type: 'text', value: ds.characters, class: 'text-field' }) as HTMLInputElement;
        t.addEventListener('input', () => { ds.characters = t.value; changed(); }); t.addEventListener('keydown', e => e.stopPropagation());
        box.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Characters'), t));
      }
      if (ds.style === 10) { sl('Line Spacing', () => ds.lineSpacing, v => ds.lineSpacing = v, 2, 32, 1, 'px'); sl('Dots', () => ds.dots, v => ds.dots = v, 0, 100, 1, '%'); sl('Wobble', () => ds.wobble, v => ds.wobble = v, 0, 64, 1, 'px'); }
      sl('Density', () => ds.density, v => ds.density = v, -100, 100); sl('Contrast', () => ds.contrast, v => ds.contrast = v, -100, 100);
      box.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Colors'), select(['Black & White', 'Two Colors', 'Original'], ds.colors, v => { ds.colors = v as 'Original'; changed(); rebuild(); })));
      if (ds.colors === 'Two Colors') box.append(h('div', { class: 'row' }, colorWell(ds.dark, c => { ds.dark = c; changed(); }, 'Dark'), colorWell(ds.light, c => { ds.light = c; changed(); }, 'Light')));
      if (ds.style >= 5 && ds.style <= 9) box.append(checkbox('Light on dark', ds.lightOnDark, v => { ds.lightOnDark = v; changed(); }));
      break;
    }
    case 'Camera Raw Filter': {
      const cr = s.cameraRaw;
      const group = (title: string) => box.append(h('div', { class: 'group-title' }, title));
      const c = (label: string, key: keyof typeof cr, min: number, max: number, step = 1) => sl(label, () => cr[key] as number, v => { (cr[key] as number) = v; }, min, max, step);
      group('White Balance'); c('Temperature', 'temperature', -100, 100); c('Tint', 'tint', -100, 100);
      group('Light'); c('Exposure', 'exposure', -5, 5, 0.05); c('Contrast', 'contrast', -100, 100); c('Highlights', 'highlights', -100, 100);
      c('Shadows', 'shadows', -100, 100); c('Whites', 'whites', -100, 100); c('Blacks', 'blacks', -100, 100);
      group('Presence'); c('Texture', 'texture', -100, 100); c('Clarity', 'clarity', -100, 100); c('Dehaze', 'dehaze', -100, 100);
      c('Vibrance', 'vibrance', -100, 100); c('Saturation', 'saturation', -100, 100);
      group('Vignette'); c('Amount', 'vignetteAmount', -100, 100); c('Midpoint', 'vignetteMidpoint', 0, 100); c('Roundness', 'vignetteRoundness', -100, 100);
      c('Feather', 'vignetteFeather', 0, 100); c('Highlights', 'vignetteHighlights', 0, 100);
      group('Grain'); c('Amount', 'grainAmount', 0, 100); c('Size', 'grainSize', 0, 100); c('Roughness', 'grainRoughness', 0, 100);
      break;
    }
    case 'Remove Background':
      box.append(h('p', { class: 'note' }, 'Remove Background uses Apple’s Vision subject detection on the Mac. Browsers have no equivalent built in, so this filter isn’t available on the web yet.'));
      break;
    case 'Exposure':
      sl('Exposure', () => s.exposure.exposure, v => s.exposure.exposure = v, -20, 20, 0.01); sl('Offset', () => s.exposure.offset, v => s.exposure.offset = v, -0.5, 0.5, 0.001);
      sl('Gamma', () => s.exposure.gamma, v => s.exposure.gamma = v, 0.01, 9.99, 0.01);
      break;
    case 'Gradient Map':
      box.append(h('div', { class: 'row' }, colorWell(s.gradientMap.shadows, c => { s.gradientMap.shadows = c; changed(); }, 'Shadows'),
        colorWell(s.gradientMap.highlights, c => { s.gradientMap.highlights = c; changed(); }, 'Highlights')),
        checkbox('Reverse', s.gradientMap.reversed, v => { s.gradientMap.reversed = v; changed(); }));
      break;
    case 'Grain': sl('Amount', () => s.grain.amount, v => s.grain.amount = v, 0, 100); sl('Size', () => s.grain.size, v => s.grain.size = v, 0.5, 20, 0.1);
      sl('Roughness', () => s.grain.roughness, v => s.grain.roughness = v, 0, 100); break;
    case 'Black & White': {
      const b = s.blackWhite;
      for (const [label, key] of [['Reds', 'reds'], ['Yellows', 'yellows'], ['Greens', 'greens'], ['Cyans', 'cyans'], ['Blues', 'blues'], ['Magentas', 'magentas']] as const)
        sl(label, () => b[key], v => b[key] = v, -200, 300, 1, '%');
      box.append(checkbox('Tint', b.tint, v => { b.tint = v; changed(); }));
      sl('Hue', () => b.tintHue, v => b.tintHue = v, 0, 360, 1, '°'); sl('Saturation', () => b.tintSaturation, v => b.tintSaturation = v, 0, 100, 1, '%');
      break;
    }
    case 'Color Balance': {
      const cb = s.colorBalance;
      let tone: 'shadow' | 'mid' | 'highlight' = (box as unknown as { _tone?: 'mid' })._tone ?? 'mid';
      const inner = h('div');
      const draw = () => {
        inner.replaceChildren();
        for (const [label, suffix] of [['Cyan / Red', 'CyanRed'], ['Magenta / Green', 'MagentaGreen'], ['Yellow / Blue', 'YellowBlue']] as const) {
          const key = `${tone}${suffix}` as keyof typeof cb;
          inner.append(slider({ label, min: -100, max: 100, value: cb[key] as number, onInput: v => { (cb[key] as number) = v; changed(); } }));
        }
      };
      box.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Tone'), select([{ label: 'Shadows', value: 'shadow' }, { label: 'Midtones', value: 'mid' }, { label: 'Highlights', value: 'highlight' }], tone, v => { tone = v as 'mid'; draw(); })), inner,
        checkbox('Preserve Luminosity', cb.preserveLuminosity, v => { cb.preserveLuminosity = v; changed(); }));
      draw();
      break;
    }
    case 'Hue/Saturation': {
      const hs = s.hueSat;
      const inner = h('div');
      const draw = () => {
        inner.replaceChildren();
        const adj = hs.adjustments[hs.range] ?? (hs.adjustments[hs.range] = { hue: 0, saturation: 0, lightness: 0 });
        inner.append(
          slider({ label: 'Hue', min: hs.colorize ? 0 : -180, max: hs.colorize ? 360 : 180, value: adj.hue, unit: '°', onInput: v => { adj.hue = v; changed(); }, id: 'hs-hue' }),
          slider({ label: 'Saturation', min: hs.colorize ? 0 : -100, max: 100, value: adj.saturation, onInput: v => { adj.saturation = v; changed(); }, id: 'hs-sat' }),
          slider({ label: 'Lightness', min: -100, max: 100, value: adj.lightness, onInput: v => { adj.lightness = v; changed(); } }),
          h('div', { class: 'spectrum' }));
      };
      if (!forAdjustmentLayer) box.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Range'), select(COLOR_RANGES, hs.range, v => { hs.range = v as ColorRangeName; draw(); })));
      box.append(inner, checkbox('Colorize', hs.colorize, v => {
        hs.colorize = v; if (v) { hs.range = 'Master'; hs.adjustments = { Master: { hue: 0, saturation: 25, lightness: 0 } }; } else hs.adjustments = {};
        changed(); draw();
      }));
      draw();
      break;
    }
    case 'Curves': box.append(curvesEditor(s, changed)); break;
    case 'Levels': box.append(levelsEditor(s, changed)); break;
    default: break;
  }
  return box;
}

function curvesEditor(s: FilterSettings, changed: () => void): HTMLElement {
  const size = 256;
  const cv = h('canvas', { width: size * 2, height: size * 2, class: 'curve-canvas', style: `width:${size}px;height:${size}px` }) as HTMLCanvasElement;
  const x = cv.getContext('2d')!;
  let ch = CHANNELS.indexOf(s.curves.channel);
  let dragging = -1;
  const colors = ['#ddd', '#ff5a5a', '#4cd964', '#4c8dff'];
  const draw = () => {
    x.setTransform(2, 0, 0, 2, 0, 0); x.clearRect(0, 0, size, size);
    x.fillStyle = '#1b1b1b'; x.fillRect(0, 0, size, size);
    x.strokeStyle = '#333'; x.lineWidth = 1; x.beginPath();
    for (let i = 1; i < 4; i++) { x.moveTo(i * size / 4, 0); x.lineTo(i * size / 4, size); x.moveTo(0, i * size / 4); x.lineTo(size, i * size / 4); }
    x.stroke(); x.strokeStyle = '#444'; x.beginPath(); x.moveTo(0, size); x.lineTo(size, 0); x.stroke();
    const pts = s.curves.channels[ch];
    x.strokeStyle = colors[ch]; x.lineWidth = 1.5; x.beginPath();
    for (let i = 0; i <= 255; i++) { const y = curveValue(pts, i); i ? x.lineTo(i * size / 255, size - y * size / 255) : x.moveTo(0, size - y * size / 255); }
    x.stroke();
    for (const p of pts) { x.fillStyle = '#fff'; x.fillRect(p.x * size / 255 - 3, size - p.y * size / 255 - 3, 6, 6); }
  };
  const toVal = (e: PointerEvent): CurvePoint => { const r = cv.getBoundingClientRect(); return { x: Math.round(Math.min(255, Math.max(0, (e.clientX - r.left) / r.width * 255))), y: Math.round(Math.min(255, Math.max(0, (1 - (e.clientY - r.top) / r.height) * 255))) }; };
  cv.addEventListener('pointerdown', e => {
    const v = toVal(e), pts = s.curves.channels[ch];
    dragging = pts.findIndex(p => Math.hypot(p.x - v.x, p.y - v.y) < 8);
    if (dragging < 0 && pts.length < 32) { pts.push(v); pts.sort((a, b) => a.x - b.x); dragging = pts.indexOf(v); }
    cv.setPointerCapture(e.pointerId); draw(); changed();
  });
  cv.addEventListener('pointermove', e => {
    if (dragging < 0) return;
    const v = toVal(e), pts = s.curves.channels[ch];
    const lo = dragging === 0 ? 0 : pts[dragging - 1].x + 1, hi = dragging === pts.length - 1 ? 255 : pts[dragging + 1].x - 1;
    if (dragging === 0) v.x = 0; else if (dragging === pts.length - 1) v.x = 255; else v.x = Math.min(hi, Math.max(lo, v.x));
    // Dragging an interior point far off the graph removes it, as in Photoshop.
    const r = cv.getBoundingClientRect();
    if (dragging > 0 && dragging < pts.length - 1 && (e.clientY < r.top - 30 || e.clientY > r.bottom + 30)) { pts.splice(dragging, 1); dragging = -1; }
    else pts[dragging] = v;
    draw(); changed();
  });
  cv.addEventListener('pointerup', () => { dragging = -1; });
  draw();
  const chSel = select([...CHANNELS], s.curves.channel, v => { s.curves.channel = v as 'RGB'; ch = CHANNELS.indexOf(v as 'RGB'); draw(); });
  const reset = button('Reset', () => { s.curves.channels[ch] = [{ x: 0, y: 0 }, { x: 255, y: 255 }]; draw(); changed(); });
  return h('div', {}, h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Channel'), chSel, reset), cv, h('p', { class: 'hint' }, 'Click to add a point · drag points · drag off the graph to remove'));
}

let currentHistogram: number[][] | null = null;
function levelsEditor(s: FilterSettings, changed: () => void): HTMLElement {
  const cv = h('canvas', { width: 512, height: 200, class: 'histo', style: 'width:256px;height:100px' }) as HTMLCanvasElement;
  let ch = CHANNELS.indexOf(s.levels.channel);
  const drawHist = () => {
    const x = cv.getContext('2d')!; x.clearRect(0, 0, 512, 200); x.fillStyle = '#1b1b1b'; x.fillRect(0, 0, 512, 200);
    const bins = currentHistogram?.[ch]; if (!bins) return;
    const sorted = [...bins.slice(1, 255)].sort((a, b) => a - b), peak = Math.min(Math.max(...bins), (sorted[Math.floor(sorted.length * 0.95)] || 1) * 4) || 1;
    x.fillStyle = ['#ccc', '#ff6b6b', '#5cd97a', '#6b9dff'][ch];
    for (let i = 0; i < 256; i++) { const hgt = Math.min(1, bins[i] / peak) * 200; x.fillRect(i * 2, 200 - hgt, 2, hgt); }
  };
  const inner = h('div');
  const draw = () => {
    const r = s.levels.ranges[ch];
    inner.replaceChildren(
      slider({ label: 'Input Black', min: 0, max: 254, value: r.black, onInput: v => { r.black = v; changed(); } }),
      slider({ label: 'Gamma', min: 0.1, max: 9.99, step: 0.01, value: r.gamma, onInput: v => { r.gamma = v; changed(); } }),
      slider({ label: 'Input White', min: 1, max: 255, value: r.white, onInput: v => { r.white = v; changed(); } }),
      slider({ label: 'Output Black', min: 0, max: 255, value: r.outputBlack, onInput: v => { r.outputBlack = v; changed(); } }),
      slider({ label: 'Output White', min: 0, max: 255, value: r.outputWhite, onInput: v => { r.outputWhite = v; changed(); } }));
    drawHist();
  };
  draw();
  const chSel = select([...CHANNELS], s.levels.channel, v => { s.levels.channel = v as 'RGB'; ch = CHANNELS.indexOf(v as 'RGB'); draw(); });
  const auto = button('Auto', () => { if (currentHistogram) { const a = autoLevels(currentHistogram); s.levels.ranges = a.ranges; draw(); changed(); } });
  void levelsTables;
  return h('div', {}, h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Channel'), chSel, auto), cv, inner);
}

function filterToAdjustment(kind: FilterKind, s: FilterSettings, a: AdjustmentRecord) {
  a.levels = s.levels; a.curves = s.curves;
  const m = s.hueSat.adjustments.Master ?? { hue: 0, saturation: 0, lightness: 0 };
  a.hue = m.hue; a.saturation = m.saturation; a.lightness = m.lightness; a.colorize = s.hueSat.colorize;
  if (kind === 'Exposure') a.exposureSettings = s.exposure;
  if (kind === 'Gradient Map') a.gradientMapSettings = s.gradientMap;
  if (kind === 'Grain') a.grainSettings = { ...s.grain, seed: a.grainSettings?.seed ?? 0 };
  if (kind === 'Black & White') a.blackWhiteSettings = s.blackWhite;
  if (kind === 'Color Balance') a.colorBalanceSettings = s.colorBalance;
  if (kind === 'Gaussian Blur') a.blurRadius = s.radius;
  if (kind === 'Motion Blur') { a.motionAngle = s.angle; a.motionDistance = s.distance; }
  if (kind === 'Add Noise') { a.noiseAmount = s.amount; a.noiseGaussian = s.gaussian; a.noiseMonochromatic = s.monochromatic; }
}

/** Opens a filter or adjustment. On an adjustment layer of the same kind it edits that layer live instead. */
export function openFilter(kind: FilterKind) {
  closeOpenPanel();
  const d = app.doc, a = app.active;
  if (!d || !a) { toast('Open an image first.'); return; }
  if (kind === 'Content-Aware Fill') { app.contentAwareFill(); return; }
  if (a.adjustment) {
    if (a.adjustment.kind === kind) return editAdjustment(a);
    toast('Select a pixel layer to filter, or add an adjustment layer.'); return;
  }
  const onMask = app.maskTarget && !!a.mask;
  if (!onMask && !a.canvas) { toast('Select a pixel layer first.'); return; }
  if (a.text || a.shape) { /* filtering rasterizes, as in the Mac app */ }
  const s: FilterSettings = structuredClone(lastSettings);
  if (kind === 'Curves') s.curves = defaultFilterSettings().curves;
  if (kind === 'Levels') s.levels = defaultFilterSettings().levels;
  if (kind === 'Hue/Saturation') s.hueSat = defaultFilterSettings().hueSat;
  const seed = (Math.random() * 2 ** 32) >>> 0;
  const original = onMask ? a.mask! : a.canvas!;
  const sel = Sel.selectionInLayer(d, a, original.width, original.height);
  if (kind === 'Levels') currentHistogram = levelsHistogram(imageDataOf(original));
  let preview = true, pending = false;
  const setCanvas = (c: HTMLCanvasElement) => { if (onMask) a.mask = c; else a.canvas = c; a.rev++; app.needsRender = true; };
  const render = () => {
    pending = false;
    if (!preview || kind === 'Remove Background') { setCanvas(original); return; }
    try {
      const img = imageDataOf(original);
      const scale = original.width / a.transform.w;
      const out = applyFilter(kind, s, img, { seed, scale: isFinite(scale) && scale > 0 ? scale : 1, canvasFrame: kind === 'Vignette' && app.isEmptyLayer(original) ? app.canvasFrameIn(a, original) : undefined });
      let c = canvasOf(out.width, out.height); ctx2d(c).putImageData(out, 0, 0);
      if (sel) { const r = cloneCanvas(original), rx = ctx2d(r); const inside = canvasOf(c.width, c.height), ix = ctx2d(inside); ix.drawImage(c, 0, 0); ix.globalCompositeOperation = 'destination-in'; ix.drawImage(sel, 0, 0); rx.globalCompositeOperation = 'destination-out'; rx.drawImage(sel, 0, 0); rx.globalCompositeOperation = 'source-over'; rx.drawImage(inside, 0, 0); c = r; }
      setCanvas(c);
    } catch (e) { console.error(e); toast(`Preview failed: ${(e as Error).message}`, 'error'); }
  };
  const changed = () => { if (!pending) { pending = true; requestAnimationFrame(render); } };
  const title = kind === 'Camera Raw Filter' ? 'Camera Raw Filter' : kind;
  const panel = floatingPanel(title, () => { setCanvas(original); openPanel = null; }, { width: kind === 'Camera Raw Filter' ? 320 : 340, right: kind === 'Camera Raw Filter', id: 'filter-panel' });
  const body = h('div');
  const rebuild = () => body.replaceChildren(controls(kind, s, changed, rebuild));
  rebuild();
  const ok = button('OK', () => {
    setCanvas(original);
    openPanel = null; panel.close();
    if (kind === 'Remove Background') return;
    lastSettings = structuredClone(s);
    app.runFilter(kind, s, seed);
  }, { class: 'btn primary', id: 'filter-ok' });
  const cancel = button('Cancel', () => { setCanvas(original); openPanel = null; panel.close(); });
  panel.body.append(body, h('div', { class: 'panel-footer' }, checkbox('Preview', true, v => { preview = v; changed(); }), h('span', { class: 'spacer' }), cancel, ok));
  openPanel = { panel, cancel: () => setCanvas(original) };
  changed();
}

export function editAdjustment(l: Layer) {
  closeOpenPanel();
  const rec = l.adjustment!;
  if (rec.kind === 'Invert') { toast('Invert has no settings.'); return; }
  app.edit(`Edit ${rec.kind}`);
  const before = structuredClone(rec);
  const { kind, settings } = adjustmentAsFilter(rec);
  if (kind === 'Levels') {
    // Histogram of what the adjustment sees: everything below it.
    const d = app.doc!, idx = d.layers.indexOf(l);
    const img = app.renderer.readComposite({ ...d, layers: d.layers.map((x, i) => i < idx ? x : { ...x, visible: false }) });
    app.renderer.invalidate();
    currentHistogram = levelsHistogram(img);
  }
  const changed = () => { filterToAdjustment(kind, settings, l.adjustment!); l.adjustment = { ...l.adjustment! }; app.needsRender = true; };
  const panel = floatingPanel(rec.kind, () => { l.adjustment = before; app.history?.undoStack.pop(); app.changed('layers'); openPanel = null; }, { id: 'filter-panel' });
  const body = h('div');
  const rebuild = () => body.replaceChildren(controls(kind, settings, changed, rebuild, true));
  rebuild();
  panel.body.append(body, h('div', { class: 'panel-footer' }, h('span', { class: 'spacer' }),
    button('Cancel', () => { l.adjustment = before; app.history?.undoStack.pop(); openPanel = null; panel.close(); app.changed('layers'); }),
    button('OK', () => { openPanel = null; panel.close(); app.changed('layers'); }, { class: 'btn primary', id: 'filter-ok' })));
  openPanel = { panel, cancel: () => { l.adjustment = before; } };
}

export function openEffects(l: Layer, focus?: EffectKey) {
  closeOpenPanel();
  if (!l.effects) return;
  app.edit('Layer Effects');
  const before = structuredClone(l.effects);
  const panel = floatingPanel('Layer Effects', () => { l.effects = before; app.history?.undoStack.pop(); app.changed('layers'); openPanel = null; }, { id: 'effects-panel' });
  const body = h('div');
  let current: EffectKey = focus ?? (Object.keys(l.effects)[0] as EffectKey) ?? 'shadow';
  const changed = () => { l.effects = { ...l.effects }; l.rev++; app.needsRender = true; };
  const draw = () => {
    body.replaceChildren();
    const list = h('div', { class: 'effect-list' });
    for (const key of Object.keys(EFFECT_NAMES) as EffectKey[]) {
      const e = l.effects![key] as { enabled?: boolean } | undefined;
      const row = h('div', { class: `effect-row${key === current ? ' sel' : ''}` },
        checkbox('', !!e && e.enabled !== false, v => { if (!l.effects![key]) app.addEffect(key); else (l.effects![key] as { enabled?: boolean }).enabled = v; changed(); draw(); }),
        h('span', {}, EFFECT_NAMES[key]));
      row.addEventListener('click', ev => { if ((ev.target as HTMLElement).tagName === 'INPUT') return; current = key; if (!l.effects![key]) { app.history?.undoStack.pop(); app.addEffect(key); app.edit('Layer Effects'); } draw(); });
      list.append(row);
    }
    const e = l.effects![current] as Record<string, number | boolean> | undefined;
    const params = h('div', { class: 'controls' });
    if (e) {
      const sl = (label: string, key: string, min: number, max: number, step = 1, unit = '') => params.append(slider({ label, min, max, step, unit, value: e[key] as number, onInput: v => { e[key] = v; changed(); } }));
      params.append(colorWell({ red: e.red as number, green: e.green as number, blue: e.blue as number }, c => { e.red = c.red; e.green = c.green; e.blue = c.blue; changed(); }, 'Color'));
      sl('Opacity', 'opacity', 0, 1, 0.01);
      if ('size' in e) sl('Size', 'size', 0, 250, 1, 'px');
      if ('angle' in e) { sl('Angle', 'angle', -180, 180, 1, '°'); sl('Distance', 'distance', 0, 500, 1, 'px'); sl('Blur', 'blur', 0, 250, 1, 'px'); }
      if ('inside' in e) params.append(checkbox('Inside', !!e.inside, v => { e.inside = v; changed(); }));
      params.append(button('Remove Effect', () => { delete (l.effects as Record<string, unknown>)[current]; changed(); draw(); }));
    }
    body.append(h('div', { class: 'effects-split' }, list, params));
  };
  draw();
  panel.body.append(body, h('div', { class: 'panel-footer' }, h('span', { class: 'spacer' }),
    button('Cancel', () => { l.effects = before; l.rev++; app.history?.undoStack.pop(); openPanel = null; panel.close(); app.changed('layers'); }),
    button('OK', () => { openPanel = null; panel.close(); app.changed('layers'); }, { class: 'btn primary' })));
  openPanel = { panel, cancel: () => { l.effects = before; l.rev++; } };
}

// ---------- sheets ----------
export const PRESETS: ({ title: string; width: number; height: number } | null)[] = [
  { title: '4K', width: 3840, height: 2160 }, { title: '1440p', width: 2560, height: 1440 }, { title: '1080p', width: 1920, height: 1080 }, null,
  { title: 'iPhone 18 Pro', width: 1206, height: 2622 }, { title: 'iPhone 18 Pro Max', width: 1320, height: 2868 }, { title: 'MacBook Pro 14"', width: 3024, height: 1964 },
  { title: 'MacBook Pro 16"', width: 3456, height: 2234 }, { title: 'Studio Display', width: 5120, height: 2880 }, null,
  { title: 'Instagram Square', width: 1080, height: 1080 }, { title: 'Instagram Portrait', width: 1080, height: 1350 }, { title: 'Instagram Story', width: 1080, height: 1920 },
  { title: 'YouTube Thumb', width: 1080, height: 608 },
];
export function newCanvasForm(onCreate: (w: number, h: number) => void, extra?: HTMLElement): HTMLElement {
  const w = h('input', { type: 'number', value: 1920, min: 1, max: 30000, id: 'new-width', class: 'dim' }) as HTMLInputElement;
  const hh = h('input', { type: 'number', value: 1080, min: 1, max: 30000, id: 'new-height', class: 'dim' }) as HTMLInputElement;
  for (const i of [w, hh]) i.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') create(); });
  const preset = select([{ label: 'Custom', value: 'Custom' }, ...PRESETS.map(p => p ? { label: `${p.title}  ·  ${p.width} × ${p.height}`, value: p.title } : null)], '1080p', v => {
    const p = PRESETS.find(x => x?.title === v); if (p) { w.value = String(p.width); hh.value = String(p.height); }
  });
  const create = () => {
    const W = Math.round(+w.value), H = Math.round(+hh.value);
    if (!(W >= 1 && H >= 1 && W <= 30000 && H <= 30000)) { toast('Enter whole numbers from 1 to 30,000 pixels.', 'error'); return; }
    onCreate(W, H);
  };
  const createBtn = button('Create canvas', create, { class: 'btn primary', id: 'create-canvas' });
  return h('div', { class: 'new-canvas' }, h('h2', {}, 'New canvas'),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Size'), preset),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Width'), w, h('span', { class: 'unit' }, 'px')),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Height'), hh, h('span', { class: 'unit' }, 'px')),
    h('p', { class: 'hint' }, 'Transparent canvas · sRGB'),
    h('div', { class: 'modal-buttons' }, extra ?? '', createBtn));
}
export function showNewCanvas() {
  let close = () => {};
  const form = newCanvasForm((w, hh) => { close(); app.newCanvas(w, hh); app.fit(); });
  close = modal('', form, [{ label: 'Cancel', onClick: () => {} }]);
}
export function showCanvasSize() {
  const d = app.doc; if (!d) return;
  const w = h('input', { type: 'number', value: d.width, class: 'dim' }) as HTMLInputElement, hh = h('input', { type: 'number', value: d.height, class: 'dim' }) as HTMLInputElement;
  let anchor = [0.5, 0.5];
  const grid = h('div', { class: 'anchor-grid' });
  const drawGrid = () => { grid.replaceChildren(...[0, 0.5, 1].flatMap(v => [0, 0.5, 1].map(u => { const b = h('button', { class: `anchor${u === anchor[0] && v === anchor[1] ? ' on' : ''}` }); b.addEventListener('click', () => { anchor = [u, v]; drawGrid(); }); return b; }))); };
  drawGrid();
  modal('Canvas Size', h('div', {}, h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Width'), w, h('span', { class: 'unit' }, 'px')),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Height'), hh, h('span', { class: 'unit' }, 'px')), h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Anchor'), grid)),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'OK', primary: true, onClick: () => { const W = Math.round(+w.value), H = Math.round(+hh.value); if (!(W >= 1 && H >= 1 && W <= 30000 && H <= 30000)) return false; app.canvasSize(W, H, anchor[0], anchor[1]); } }]);
}
export function showImageSize() {
  const d = app.doc; if (!d) return;
  const w = h('input', { type: 'number', value: d.width, class: 'dim' }) as HTMLInputElement, hh = h('input', { type: 'number', value: d.height, class: 'dim' }) as HTMLInputElement;
  let lock = true;
  w.addEventListener('input', () => { if (lock) hh.value = String(Math.round(+w.value * d.height / d.width)); });
  hh.addEventListener('input', () => { if (lock) w.value = String(Math.round(+hh.value * d.width / d.height)); });
  modal('Image Size', h('div', {}, h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Width'), w, h('span', { class: 'unit' }, 'px')),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Height'), hh, h('span', { class: 'unit' }, 'px')), checkbox('Constrain proportions', true, v => lock = v)),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'OK', primary: true, onClick: () => { const W = Math.round(+w.value), H = Math.round(+hh.value); if (!(W >= 1 && H >= 1 && W <= 30000 && H <= 30000)) return false; app.imageSize(W, H); } }]);
}
export function showSelectionAmount(op: 'expand' | 'contract' | 'feather') {
  const i = h('input', { type: 'number', value: op === 'feather' ? 10 : 5, min: 1, max: 500, class: 'dim' }) as HTMLInputElement;
  modal(`${op[0].toUpperCase()}${op.slice(1)} Selection`, h('div', { class: 'row' }, h('span', { class: 'lbl' }, op === 'feather' ? 'Radius' : 'By'), i, h('span', { class: 'unit' }, 'px')),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'OK', primary: true, onClick: () => app.modifySelection(op, Math.max(1, +i.value)) }]);
}
export function showExportJpeg() {
  const d = app.doc; if (!d) return;
  let q = 92;
  const prev = h('canvas', { class: 'jpeg-preview' }) as HTMLCanvasElement;
  const size = h('span', { class: 'hint' });
  const img = app.renderer.readComposite(d);
  const src = canvasOf(d.width, d.height); { const x = ctx2d(src); x.fillStyle = '#fff'; x.fillRect(0, 0, d.width, d.height); const t = canvasOf(d.width, d.height); ctx2d(t).putImageData(img, 0, 0); x.drawImage(t, 0, 0); }
  const s = Math.min(1, 360 / d.width, 240 / d.height);
  prev.width = Math.round(d.width * s); prev.height = Math.round(d.height * s);
  const update = () => src.toBlob(b => {
    if (!b) return; size.textContent = `${(b.size / 1024).toFixed(0)} KB`;
    createImageBitmap(b).then(bmp => { ctx2d(prev).drawImage(bmp, 0, 0, prev.width, prev.height); });
  }, 'image/jpeg', q / 100);
  update();
  modal('Export JPEG', h('div', {}, prev, slider({ label: 'Quality', min: 1, max: 100, value: q, unit: '%', onInput: v => q = v, onCommit: update }), size),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'Export', primary: true, onClick: () => { app.exportImage('jpeg', q / 100); } }]);
}
export function showShortcuts() {
  const rows: [string, string][] = [
    ['Move / Transform', 'V'], ['Marquee (cycle shape)', 'M'], ['Lasso (cycle mode)', 'L'], ['Magic Wand', 'W'], ['Crop', 'C'], ['Brush / Eraser', 'B / E'],
    ['Spot Healing', 'J'], ['Clone Stamp', 'S'], ['Smear', 'R'], ['Gradient', 'G'], ['Shape (cycle kind: ⇧U)', 'U'], ['Type', 'T'], ['Eyedropper', 'I'],
    ['Hand (hold Space)', 'H'], ['Zoom', 'Z'], ['No tool', 'A'], ['Swap / reset colors', 'X / D'], ['Brush size / hardness', '[ ]  ⇧[ ⇧]'], ['Opacity', '1 … 0'],
    ['Undo / Redo', '⌘Z / ⇧⌘Z'], ['New / Open / Save', '⌘N / ⌘O / ⌘S'], ['Export PNG / JPEG', '⇧⌘E / ⌥⇧⌘S'], ['Select All / Deselect / Inverse', '⌘A / ⌘D / ⇧⌘I'],
    ['Levels / Curves / Hue-Sat / Invert', '⌘L / ⌘M / ⌘U / ⌘I'], ['Duplicate (Layer via Copy)', '⌘J'], ['Group / Ungroup', '⌘G / ⇧⌘G'], ['Clipping Mask', '⌥⌘G'],
    ['Merge', '⌘E'], ['New Layer', '⇧⌘N'], ['Fill FG / BG / Content-Aware', '⌥⌫ / ⌘⌫ / ⇧⌫'], ['Fit / 100% / Zoom', '⌘0 / ⌘1 / ⌘+ ⌘−'],
    ['Canvas Size / Image Size', '⌥⌘C / ⌥⌘I'], ['Free Transform', '⌘T'], ['Blend mode next / previous', '⇧= / ⇧−'],
  ];
  modal('Keyboard Shortcuts', h('div', { class: 'shortcut-list' }, ...rows.map(([a, b]) => h('div', { class: 'shortcut-row' }, h('span', {}, a), h('kbd', {}, b)))), [{ label: 'Done', primary: true, onClick: () => {} }]);
}

// GridSettingsSheet.swift: the layout grid's spacing and subdivisions.
export function showGridSettings() {
  const sp = h('input', { type: 'number', value: view.gridSpacing, min: 1, max: 10000, class: 'dim', id: 'grid-spacing' }) as HTMLInputElement;
  const sub = h('input', { type: 'number', value: view.gridSubdivisions, min: 1, max: 100, class: 'dim', id: 'grid-subdivisions' }) as HTMLInputElement;
  modal('Grid Settings', h('div', {},
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Gridline every'), sp, h('span', { class: 'unit' }, 'px')),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Subdivisions'), sub)),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'OK', primary: true, onClick: () => {
      setView('gridSpacing', Math.min(10000, Math.max(1, Math.round(+sp.value || 64))));
      setView('gridSubdivisions', Math.min(100, Math.max(1, Math.round(+sub.value || 1))));
      if (!view.grid) setView('grid', true);
    } }]);
}
export function showNewGuide() {
  const d = app.doc; if (!d) return;
  let axis: 'horizontal' | 'vertical' = 'vertical';
  const pos = h('input', { type: 'number', value: Math.round(d.width / 2), class: 'dim' }) as HTMLInputElement;
  const seg = h('div', { class: 'segmented' });
  const draw = () => { seg.replaceChildren(...(['horizontal', 'vertical'] as const).map(a => h('button', { class: a === axis ? 'on' : '', onclick: () => { axis = a; pos.value = String(Math.round((a === 'vertical' ? d.width : d.height) / 2)); draw(); } }, a === 'vertical' ? 'Vertical' : 'Horizontal'))); };
  draw();
  modal('New Guide', h('div', {}, h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Orientation'), seg),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Position'), pos, h('span', { class: 'unit' }, 'px'))),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'OK', primary: true, onClick: () => { addGuide(axis, +pos.value || 0); } }]);
}
