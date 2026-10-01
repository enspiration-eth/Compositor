// Panels and sheets: UI/FilterSheet.swift, LevelsSheet.swift, CurvesControls.swift, HueSaturationSheet.swift,
// EffectsSheet.swift, NewCanvasSheet.swift, CanvasSizeSheet.swift, ImageSizeSheet.swift, JPEGExportSheet.swift.
import { app } from './app';
import { h, slider, select, checkbox, colorWell, button, floatingPanel, modal, toast, type Panel } from './dom';
import {
  type FilterKind, type FilterSettings, defaultFilterSettings, applyFilter, canvasOf, ctx2d, imageDataOf, COLOR_RANGES, DITHER_STYLES,
  curveValue, levelsTables, autoLevels, type AdjustmentRecord, adjustmentAsFilter, type CurvePoint, type ColorRangeName, defaultCameraRaw, CR_MIXER_NAMES, type CRPoint,
  rangeWeight, bandOf, setBandHandle, shiftBand, type CRCurve, defaultGeometry,
} from '../engine/adjustments';
import { levelsHistogram } from '../engine/kernels';
import { type Layer, type EffectKey, EFFECT_NAMES, cloneCanvas, bakeMask, maskInLayerGrid, setMaskPlacement, invert, apply, pixelToDoc } from '../engine/document';
import * as Sel from '../engine/selection';
import { view, setView, addGuide } from './guides';
import { subjectMatte, matteToMask, defaultMatte, type MatteSettings } from '../engine/segment';

let openPanel: { panel: Panel; cancel: () => void } | null = null;
const crOpen = new Set<string>(['Basic']);
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
      // Camera Raw's panel sections (CameraRawPanel.swift): Basic, Curve, Color Mixer, Color Grading, Detail, Optics,
      // Effects and Calibration, each driving the Mac app's C kernels.
      const cr = s.cameraRaw = { ...defaultCameraRaw(), ...s.cameraRaw };
      const section = (title: string, build: (add: (el: HTMLElement) => void) => void) => {
        const d = h('details', { class: 'cr-section' }) as HTMLDetailsElement;
        d.open = crOpen.has(title);
        d.addEventListener('toggle', () => { if (d.open) crOpen.add(title); else crOpen.delete(title); });
        d.append(h('summary', {}, title));
        const inner = h('div', { class: 'controls' }); build(el => inner.append(el)); d.append(inner); box.append(d);
      };
      const S = (label: string, get: () => number, set: (v: number) => void, min: number, max: number, step = 1, unit = '', clip = 0) => {
        const el = slider({ label, min, max, step, unit, value: get(), onInput: v => { set(v); changed(); } });
        // Option-drag a Light slider: the clipping view (CameraRawClipping) while the pointer is down.
        if (clip) {
          el.addEventListener('pointerdown', e => { if (e.altKey) { s.crClipping = clip; changed(); } });
          const off = () => { if (s.crClipping === clip && clipSel.value === 'Off') { s.crClipping = undefined; changed(); } };
          el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off);
        }
        return el;
      };
      const clipSel = select(['Off', 'Highlights', 'Shadows'], ['Off', 'Highlights', 'Shadows'][s.crClipping ?? 0] ?? 'Off', v => { s.crClipping = ['Off', 'Highlights', 'Shadows'].indexOf(v) || undefined; changed(); }, { id: 'cr-clipping' });
      const sub = (t: string) => h('div', { class: 'group-title' }, t);
      const k = <T extends object>(o: T, key: keyof T, label: string, min: number, max: number, step = 1, unit = '') =>
        S(label, () => o[key] as unknown as number, v => { (o[key] as unknown as number) = v; }, min, max, step, unit);
      section('Basic', add => {
        add(sub('White Balance')); add(k(cr, 'temperature', 'Temperature', -100, 100)); add(k(cr, 'tint', 'Tint', -100, 100));
        add(sub('Light'));
        add(h('div', { class: 'row', title: 'Or hold Option (Alt) while dragging Exposure, Highlights, Whites, Shadows or Blacks' }, h('span', { class: 'lbl' }, 'Clipping'), clipSel));
        const kc = (key: 'exposure' | 'highlights' | 'shadows' | 'whites' | 'blacks', label: string, min: number, max: number, step: number, clip: number) =>
          S(label, () => cr[key], v => { cr[key] = v; }, min, max, step, '', clip);
        add(kc('exposure', 'Exposure', -5, 5, 0.05, 1)); add(k(cr, 'contrast', 'Contrast', -100, 100)); add(kc('highlights', 'Highlights', -100, 100, 1, 1));
        add(kc('shadows', 'Shadows', -100, 100, 1, 2)); add(kc('whites', 'Whites', -100, 100, 1, 1)); add(kc('blacks', 'Blacks', -100, 100, 1, 2));
        add(sub('Presence')); add(k(cr, 'texture', 'Texture', -100, 100)); add(k(cr, 'clarity', 'Clarity', -100, 100)); add(k(cr, 'dehaze', 'Dehaze', -100, 100));
        add(k(cr, 'vibrance', 'Vibrance', -100, 100)); add(k(cr, 'saturation', 'Saturation', -100, 100));
      });
      section('Curve', add => {
        const c = cr.curve;
        add(sub('Parametric')); add(k(c, 'highlights', 'Highlights', -100, 100)); add(k(c, 'lights', 'Lights', -100, 100)); add(k(c, 'darks', 'Darks', -100, 100)); add(k(c, 'shadows', 'Shadows', -100, 100));
        add(k(c, 'shadowSplit', 'Shadow split', 5, 90)); add(k(c, 'darkSplit', 'Midtone split', 7, 95)); add(k(c, 'lightSplit', 'Light split', 9, 98));
        add(sub('Point curve'));
        add(crCurveEditor(c, changed));
        add(k(c, 'refineSaturation', 'Refine saturation', -100, 100));
      });
      section('Color Mixer', add => {
        const m = cr.mixer;
        for (const [tab, arr] of [['Hue', m.hue], ['Saturation', m.saturation], ['Luminance', m.luminance]] as const) {
          add(sub(tab)); CR_MIXER_NAMES.forEach((n, i) => add(S(n, () => arr[i], v => { arr[i] = v; }, -100, 100)));
        }
      });
      section('Point Color', add => { add(crPointColor(cr, s, changed)); });
      section('Color Grading', add => {
        const g = cr.grading;
        for (const [name, w] of [['Shadows', g.shadows], ['Midtones', g.midtones], ['Highlights', g.highlights], ['Global', g.global]] as const) {
          add(sub(name)); add(k(w, 'hue', 'Hue', 0, 360, 1, '°')); add(k(w, 'saturation', 'Saturation', 0, 100)); add(k(w, 'luminance', 'Luminance', -100, 100));
        }
        add(sub('Wheels')); add(k(g, 'blending', 'Blending', 0, 100)); add(k(g, 'balance', 'Balance', -100, 100));
      });
      section('Detail', add => {
        const d = cr.detail;
        add(sub('Sharpening')); add(k(d, 'sharpenAmount', 'Amount', 0, 150)); add(k(d, 'sharpenRadius', 'Radius', 0, 100)); add(k(d, 'sharpenDetail', 'Detail', 0, 100)); add(k(d, 'sharpenMasking', 'Masking', 0, 100));
        add(sub('Noise Reduction')); add(k(d, 'noiseLuminance', 'Luminance', 0, 100)); add(k(d, 'noiseLuminanceDetail', 'Detail', 0, 100)); add(k(d, 'noiseLuminanceContrast', 'Contrast', 0, 100));
        add(k(d, 'noiseColor', 'Color', 0, 100)); add(k(d, 'noiseColorDetail', 'Color detail', 0, 100)); add(k(d, 'noiseColorSmoothness', 'Smoothness', 0, 100));
      });
      section('Optics', add => {
        const o = cr.optics;
        add(h('div', { class: 'row' }, checkbox('Remove Chromatic Aberration', o.removeChromaticAberration, v => { o.removeChromaticAberration = v; changed(); })));
        add(h('div', { class: 'row' }, checkbox('Use Profile Corrections', o.enableLensProfile, v => { o.enableLensProfile = v; changed(); })));
        add(k(o, 'profileDistortion', 'Profile distortion', 0, 100)); add(k(o, 'profileVignetting', 'Profile vignetting', 0, 100));
        add(k(o, 'distortion', 'Distortion', -100, 100));
        add(sub('Defringe')); add(k(o, 'purpleAmount', 'Purple amount', 0, 100)); add(k(o, 'purpleHueLow', 'Purple hue from', 0, 360, 1, '°')); add(k(o, 'purpleHueHigh', 'Purple hue to', 0, 360, 1, '°'));
        add(k(o, 'greenAmount', 'Green amount', 0, 100)); add(k(o, 'greenHueLow', 'Green hue from', 0, 360, 1, '°')); add(k(o, 'greenHueHigh', 'Green hue to', 0, 360, 1, '°'));
        add(sub('Vignette')); add(k(o, 'vignetteAmount', 'Amount', -100, 100)); add(k(o, 'vignetteMidpoint', 'Midpoint', 0, 100));
      });
      section('Geometry', add => { add(crGeometry(cr, changed)); });
      section('Effects', add => {
        add(sub('Glow')); add(h('div', { class: 'row' }, select(['Diffusion', 'Bloom', 'Halation'], ['Diffusion', 'Bloom', 'Halation'][cr.glowStyle] ?? 'Diffusion', v => { cr.glowStyle = ['Diffusion', 'Bloom', 'Halation'].indexOf(v); changed(); })));
        add(k(cr, 'glow', 'Amount', 0, 100)); add(k(cr, 'glowRange', 'Range', -100, 100)); add(k(cr, 'glowSpread', 'Spread', -100, 100)); add(k(cr, 'glowWarmth', 'Warmth', -100, 100));
        add(sub('Post-Crop Vignetting')); add(h('div', { class: 'row' }, select(['Highlight Priority', 'Color Priority', 'Paint Overlay'], ['Highlight Priority', 'Color Priority', 'Paint Overlay'][cr.vignetteStyle] ?? 'Highlight Priority', v => { cr.vignetteStyle = ['Highlight Priority', 'Color Priority', 'Paint Overlay'].indexOf(v); changed(); })));
        add(k(cr, 'vignetteAmount', 'Amount', -100, 100)); add(k(cr, 'vignetteMidpoint', 'Midpoint', 0, 100)); add(k(cr, 'vignetteRoundness', 'Roundness', -100, 100));
        add(k(cr, 'vignetteFeather', 'Feather', 0, 100)); add(k(cr, 'vignetteHighlights', 'Highlights', 0, 100));
        add(sub('Grain')); add(k(cr, 'grainAmount', 'Amount', 0, 100)); add(k(cr, 'grainSize', 'Size', 0, 100)); add(k(cr, 'grainRoughness', 'Roughness', 0, 100));
      });
      section('Calibration', add => {
        const c = cr.calibration;
        add(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Process'), select(['Version 1', 'Version 2', 'Version 3', 'Version 4', 'Version 5', 'Version 6'], `Version ${c.process}`, v => { c.process = +v.slice(-1); changed(); })));
        add(k(c, 'shadowTint', 'Shadows tint', -100, 100));
        add(sub('Red Primary')); add(k(c, 'redHue', 'Hue', -100, 100)); add(k(c, 'redSaturation', 'Saturation', -100, 100));
        add(sub('Green Primary')); add(k(c, 'greenHue', 'Hue', -100, 100)); add(k(c, 'greenSaturation', 'Saturation', -100, 100));
        add(sub('Blue Primary')); add(k(c, 'blueHue', 'Hue', -100, 100)); add(k(c, 'blueSaturation', 'Saturation', -100, 100));
      });
      box.append(h('div', { class: 'row' }, button('Reset All', () => { s.cameraRaw = defaultCameraRaw(); changed(); rebuild(); })));
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
          slider({ label: 'Hue', min: hs.colorize ? 0 : -180, max: hs.colorize ? 360 : 180, value: adj.hue, unit: '°', onInput: v => { adj.hue = v; changed(); spec.draw(); }, id: 'hs-hue' }),
          slider({ label: 'Saturation', min: hs.colorize ? 0 : -100, max: 100, value: adj.saturation, onInput: v => { adj.saturation = v; changed(); spec.draw(); }, id: 'hs-sat' }),
          slider({ label: 'Lightness', min: -100, max: 100, value: adj.lightness, onInput: v => { adj.lightness = v; changed(); spec.draw(); } }));
        if (!hs.colorize && hs.range !== 'Master') inner.append(checkbox('Invert Range', !!hs.invertRange, v => { hs.invertRange = v; changed(); spec.draw(); }));
        inner.append(spec.el);
        spec.draw();
      };
      const spec = hueSpectrum(hs, () => { changed(); });
      if (!hs.colorize) box.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Range'), select(COLOR_RANGES, hs.range, v => { hs.range = v as ColorRangeName; draw(); }, { id: 'hs-range' })));
      box.append(inner, checkbox('Colorize', hs.colorize, v => {
        hs.colorize = v; if (v) { hs.range = 'Master'; hs.adjustments = { Master: { hue: 0, saturation: 25, lightness: 0 } }; } else hs.adjustments = {};
        changed(); rebuild();
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

/** The open filter's layer and its untouched pixels, for panels that sample or draw on the canvas. */
let crCtx: { layer: Layer; original: HTMLCanvasElement } | null = null;
/** Document point → normalized 0…1 position on the filtered layer (y down), or null outside it. */
function layerUV(dpt: [number, number]): [number, number] | null {
  if (!crCtx) return null;
  const l = crCtx.layer, m = invert(pixelToDoc(l.transform, 1, 1)), [u, v] = apply(m, dpt[0], dpt[1]);
  return u >= 0 && v >= 0 && u <= 1 && v <= 1 ? [u, v] : null;
}
function uvToDoc(u: number, v: number): [number, number] { return apply(pixelToDoc(crCtx!.layer.transform, 1, 1), u, v); }

/** Camera Raw's point curve (CameraRawCurveSettings rgb/red/green/blue, 0…1): click to add, drag, drag off to remove. */
function crCurveEditor(c: CRCurve, changed: () => void): HTMLElement {
  const size = 240, chans = ['RGB', 'Red', 'Green', 'Blue'] as const, keys = ['rgb', 'red', 'green', 'blue'] as const;
  let ch = 0, dragging = -1;
  const cv = h('canvas', { width: size * 2, height: size * 2, class: 'curve-canvas', id: 'cr-curve', style: `width:${size}px;height:${size}px;touch-action:none` }) as HTMLCanvasElement;
  const x = cv.getContext('2d')!, colors = ['#ddd', '#ff5a5a', '#4cd964', '#4c8dff'];
  const pts = () => c[keys[ch]];
  const value = (p: CRPoint[], t: number) => curveValue(p.map(q => ({ x: q.x * 255, y: q.y * 255 })), t * 255) / 255;
  const draw = () => {
    x.setTransform(2, 0, 0, 2, 0, 0); x.clearRect(0, 0, size, size); x.fillStyle = '#1b1b1b'; x.fillRect(0, 0, size, size);
    x.strokeStyle = '#333'; x.lineWidth = 1; x.beginPath();
    for (let i = 1; i < 4; i++) { x.moveTo(i * size / 4, 0); x.lineTo(i * size / 4, size); x.moveTo(0, i * size / 4); x.lineTo(size, i * size / 4); }
    x.stroke(); x.strokeStyle = '#444'; x.beginPath(); x.moveTo(0, size); x.lineTo(size, 0); x.stroke();
    keys.forEach((k0, i) => {
      if (i === ch || (c[k0].length === 2 && c[k0][0].y === 0 && c[k0][1].y === 1)) return;
      x.strokeStyle = colors[i] + '66'; x.beginPath();
      for (let t = 0; t <= 64; t++) { const y = value(c[k0], t / 64); t ? x.lineTo(t / 64 * size, size - y * size) : x.moveTo(0, size - y * size); }
      x.stroke();
    });
    x.strokeStyle = colors[ch]; x.lineWidth = 1.5; x.beginPath();
    for (let t = 0; t <= 128; t++) { const y = value(pts(), t / 128); t ? x.lineTo(t / 128 * size, size - y * size) : x.moveTo(0, size - y * size); }
    x.stroke();
    for (const p of pts()) { x.fillStyle = '#fff'; x.fillRect(p.x * size - 3, size - p.y * size - 3, 6, 6); }
  };
  const at = (e: PointerEvent): CRPoint => { const r = cv.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)) }; };
  cv.addEventListener('pointerdown', e => {
    const v = at(e), p = [...pts()];
    dragging = p.findIndex(q => Math.hypot(q.x - v.x, q.y - v.y) < 0.04);
    if (dragging < 0 && p.length < 16) { p.push(v); p.sort((a, b) => a.x - b.x); dragging = p.indexOf(v); }
    c[keys[ch]] = p; cv.setPointerCapture(e.pointerId); draw(); changed();
  });
  cv.addEventListener('pointermove', e => {
    if (dragging < 0) return;
    const v = at(e), p = [...pts()], r = cv.getBoundingClientRect();
    if (dragging === 0) v.x = 0; else if (dragging === p.length - 1) v.x = 1;
    else v.x = Math.min(p[dragging + 1].x - 0.01, Math.max(p[dragging - 1].x + 0.01, v.x));
    if (dragging > 0 && dragging < p.length - 1 && (e.clientY < r.top - 30 || e.clientY > r.bottom + 30)) { p.splice(dragging, 1); dragging = -1; }
    else p[dragging] = v;
    c[keys[ch]] = p; draw(); changed();
  });
  cv.addEventListener('pointerup', () => { dragging = -1; });
  const presets: Record<string, CRPoint[]> = { Linear: [{ x: 0, y: 0 }, { x: 1, y: 1 }], 'Medium Contrast': [{ x: 0, y: 0 }, { x: 0.25, y: 0.18 }, { x: 0.75, y: 0.82 }, { x: 1, y: 1 }],
    'Strong Contrast': [{ x: 0, y: 0 }, { x: 0.25, y: 0.10 }, { x: 0.75, y: 0.90 }, { x: 1, y: 1 }] };
  const chSel = select([...chans], 'RGB', v => { ch = chans.indexOf(v as 'RGB'); draw(); }, { id: 'cr-curve-channel' });
  const preset = select(['Preset…', ...Object.keys(presets)], 'Preset…', v => { if (presets[v]) { c[keys[ch]] = presets[v].map(q => ({ ...q })); draw(); changed(); } preset.value = 'Preset…'; });
  draw();
  return h('div', {}, h('div', { class: 'row' }, chSel, preset, button('Reset', () => { c[keys[ch]] = [{ x: 0, y: 0 }, { x: 1, y: 1 }]; draw(); changed(); })), cv,
    h('p', { class: 'hint' }, 'Click to add a point · drag points · drag off the graph to remove'));
}

/** Camera Raw › Color Mixer › Point Color: sample up to eight colors from the image and shift each one. */
function crPointColor(cr: NonNullable<FilterSettings['cameraRaw']>, s: FilterSettings, changed: () => void): HTMLElement {
  const box = h('div', { id: 'cr-point-color' });
  const pts = cr.mixer.points ??= [];
  let sel = pts.length - 1, sampling = false;
  const sampleAt = (dpt: [number, number]) => {
    const uv = layerUV(dpt); if (!uv || !crCtx) return;
    const o = crCtx.original, px = Math.min(o.width - 1, Math.floor(uv[0] * o.width)), py = Math.min(o.height - 1, Math.floor(uv[1] * o.height));
    const d = ctx2d(o).getImageData(px, py, 1, 1).data; if (!d[3]) return;
    // CameraRawSampling: hue from the color wheel, saturation as chroma / max, luminance as (max + min) / 2.
    const r = d[0] / 255, g = d[1] / 255, b = d[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
    let hue = 0;
    if (c > 1e-6) { hue = mx === r ? (g - b) / c : mx === g ? 2 + (b - r) / c : 4 + (r - g) / c; hue /= 6; if (hue < 0) hue += 1; }
    const color = { hue: hue * 360, saturation: mx ? c / mx : 0, luminance: (mx + mn) / 2, hueShift: 0, saturationShift: 0, luminanceShift: 0, hueRange: 30, saturationRange: 0.4, luminanceRange: 0.4 };
    if (pts[sel]) pts[sel] = { ...color, hueShift: pts[sel].hueShift, saturationShift: pts[sel].saturationShift, luminanceShift: pts[sel].luminanceShift };
    else if (pts.length < 8) { pts.push(color); sel = pts.length - 1; }
    sampling = false; app.canvasHook = null; draw(); changed();
  };
  const arm = (replace: boolean) => {
    if (!replace) sel = -1;
    sampling = true;
    app.canvasHook = { cursor: 'crosshair', down: sampleAt };
    draw();
  };
  const draw = () => {
    box.replaceChildren();
    const sw = h('div', { class: 'row swatches' });
    pts.forEach((p, i) => {
      const b = h('button', { class: `swatch${i === sel ? ' sel' : ''}`, title: `Point ${i + 1}`, style: `background:hsl(${p.hue},${Math.round(p.saturation * 100)}%,${Math.round(p.luminance * 100)}%)` });
      b.addEventListener('click', () => { sel = i; s.crVisualize = s.crVisualize !== undefined ? i : undefined; draw(); changed(); });
      sw.append(b);
    });
    const add = button(sampling ? 'Click the image…' : '+ Sample color', () => arm(false), { id: 'cr-point-sample', class: `btn${sampling ? ' primary' : ''}` });
    if (pts.length >= 8) add.setAttribute('disabled', '');
    sw.append(add);
    box.append(sw);
    const p = pts[sel];
    if (!p) { box.append(h('p', { class: 'hint' }, 'Sample a color from the image, then shift its hue, saturation and luminance.')); return; }
    const sl = (label: string, key: keyof typeof p, min: number, max: number, step = 1, scale = 1) =>
      slider({ label, min, max, step, value: (p[key] as number) * scale, onInput: v => { (p[key] as number) = v / scale; changed(); } });
    box.append(sl('Hue Shift', 'hueShift', -100, 100), sl('Sat Shift', 'saturationShift', -100, 100), sl('Lum Shift', 'luminanceShift', -100, 100),
      h('div', { class: 'group-title' }, 'Range'), sl('Hue', 'hueRange', 5, 180), sl('Saturation', 'saturationRange', 5, 100, 1, 100), sl('Luminance', 'luminanceRange', 5, 100, 1, 100),
      h('div', { class: 'row' },
        checkbox('Visualize range', s.crVisualize === sel, v => { s.crVisualize = v ? sel : undefined; changed(); }),
        button('Resample', () => arm(true)),
        button('Delete', () => { pts.splice(sel, 1); if (s.crVisualize !== undefined) s.crVisualize = undefined; sel = Math.min(sel, pts.length - 1); draw(); changed(); })));
  };
  draw();
  return box;
}

/** Camera Raw › Geometry (CameraRawGeometrySettings): Upright Off/Guided, the manual transform and Constrain Crop. */
function crGeometry(cr: NonNullable<FilterSettings['cameraRaw']>, changed: () => void): HTMLElement {
  const g = cr.geometry ??= defaultGeometry();
  const box = h('div', { id: 'cr-geometry' });
  let draft: [number, number, number, number] | null = null;
  const hookOn = () => {
    // Upright › Guided: drag lines along edges that should be straight (up to four), as in Camera Raw.
    app.canvasHook = {
      cursor: 'crosshair',
      down: dpt => { const uv = layerUV(dpt); draft = uv ? [uv[0], uv[1], uv[0], uv[1]] : null; },
      move: dpt => { if (!draft) return; const uv = layerUV(dpt); if (uv) { draft[2] = uv[0]; draft[3] = uv[1]; } app.needsRender = true; },
      up: () => {
        if (draft && Math.hypot(draft[2] - draft[0], draft[3] - draft[1]) > 0.01) {
          if (g.guides.length >= 4) g.guides.shift();
          // Stored y up from the bottom, as the Mac app does.
          g.guides.push({ startX: draft[0], startY: 1 - draft[1], endX: draft[2], endY: 1 - draft[3] });
          g.upright = 'Guided'; changed(); draw();
        }
        draft = null;
      },
      draw: (x, S) => {
        if (!crCtx) return;
        x.strokeStyle = '#ffd400'; x.lineWidth = 2; x.setLineDash([]);
        const line = (a: [number, number], b: [number, number]) => { const p = S(...uvToDoc(...a)), q = S(...uvToDoc(...b)); x.beginPath(); x.moveTo(...p); x.lineTo(...q); x.stroke();
          for (const r of [p, q]) { x.beginPath(); x.arc(r[0], r[1], 3.5, 0, Math.PI * 2); x.fillStyle = '#ffd400'; x.fill(); } };
        for (const gd of g.guides) line([gd.startX, 1 - gd.startY], [gd.endX, 1 - gd.endY]);
        if (draft) line([draft[0], draft[1]], [draft[2], draft[3]]);
      },
    };
    app.needsRender = true;
  };
  const draw = () => {
    box.replaceChildren();
    if (g.upright === 'Guided') hookOn(); else if (app.canvasHook?.draw) { app.canvasHook = null; app.needsRender = true; }
    const sl = (label: string, key: 'vertical' | 'horizontal' | 'rotate' | 'aspect' | 'scale' | 'offsetX' | 'offsetY', min: number, max: number, step = 1) =>
      slider({ label, min, max, step, value: g[key], onInput: v => { g[key] = v; changed(); } });
    box.append(
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Upright'), select(['Off', 'Guided'], g.upright, v => { g.upright = v as 'Off'; changed(); draw(); }, { id: 'cr-upright' }),
        h('span', { class: 'lbl' }, 'Projection'), select(['Perspective', 'Rectilinear'], g.projection, v => { g.projection = v as 'Perspective'; changed(); })));
    if (g.upright === 'Guided') box.append(h('p', { class: 'hint' }, `Drag on the image along edges that should be straight (${g.guides.length}/4).`),
      h('div', { class: 'row' }, button('Clear Guides', () => { g.guides = []; changed(); draw(); })));
    box.append(sl('Vertical', 'vertical', -100, 100), sl('Horizontal', 'horizontal', -100, 100), sl('Rotate', 'rotate', -45, 45, 0.1), sl('Aspect', 'aspect', -100, 100),
      sl('Scale', 'scale', -100, 100), sl('Offset X', 'offsetX', -100, 100), sl('Offset Y', 'offsetY', -100, 100),
      checkbox('Constrain Crop', g.constrainCrop, v => { g.constrainCrop = v; changed(); }));
  };
  draw();
  return box;
}

/** The Hue/Saturation spectrum (UI/HueSaturationSheet.swift): the input hues over what they become, with the selected
 *  range's band — drag a handle to move a falloff or range edge, drag between them to slide the whole band. */
function hueSpectrum(hs: FilterSettings['hueSat'], changed: () => void) {
  const W = 300, H = 46;
  const cv = h('canvas', { width: W * 2, height: H * 2, class: 'hue-spectrum', id: 'hs-spectrum', style: `width:${W}px;height:${H}px;touch-action:none;cursor:ew-resize` }) as HTMLCanvasElement;
  const x = cv.getContext('2d')!;
  const X = (deg: number) => (deg / 360) * W;
  const draw = () => {
    x.setTransform(2, 0, 0, 2, 0, 0); x.clearRect(0, 0, W, H);
    for (let px = 0; px < W; px++) {
      const deg = px / W * 360;
      x.fillStyle = `hsl(${deg},100%,50%)`; x.fillRect(px, 6, 1, 12);
      let dh = 0, ds = 0, dl = 0;
      if (hs.colorize) { const c = hs.adjustments.Master ?? { hue: 0, saturation: 25, lightness: 0 }; x.fillStyle = `hsl(${c.hue},${c.saturation}%,${50 + c.lightness / 2}%)`; }
      else {
        for (const [name, a] of Object.entries(hs.adjustments) as [ColorRangeName, { hue: number; saturation: number; lightness: number }][]) {
          if (!a) continue; const w = rangeWeight(hs, name, deg); dh += a.hue * w; ds += a.saturation * w; dl += a.lightness * w;
        }
        x.fillStyle = `hsl(${deg + dh},${Math.max(0, Math.min(100, 100 + ds))}%,${Math.max(0, Math.min(100, 50 + dl / 2))}%)`;
      }
      x.fillRect(px, 26, 1, 12);
    }
    if (hs.range === 'Master' || hs.colorize) return;
    const b = bandOf(hs, hs.range);
    x.fillStyle = 'rgba(255,255,255,0.18)';
    const seg = (a: number, z: number, y: number, hh: number) => { if (z >= a) x.fillRect(X(a), y, X(z) - X(a), hh); else { x.fillRect(X(a), y, W - X(a), hh); x.fillRect(0, y, X(z), hh); } };
    seg(b[1], b[2], 19, 6);
    x.fillStyle = 'rgba(255,255,255,0.08)'; seg(b[0], b[1], 19, 6); seg(b[2], b[3], 19, 6);
    b.forEach((d, i) => {
      x.fillStyle = '#fff'; x.strokeStyle = '#222'; x.lineWidth = 1;
      x.beginPath();
      if (i === 1 || i === 2) x.rect(X(d) - 3, 18, 6, 8); else { x.moveTo(X(d), 18); x.lineTo(X(d) - 4, 26); x.lineTo(X(d) + 4, 26); x.closePath(); }
      x.fill(); x.stroke();
    });
  };
  let drag: { i: number; deg0: number; band0: [number, number, number, number] } | null = null;
  const degAt = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); return Math.max(0, Math.min(360, (e.clientX - r.left) / r.width * 360)); };
  cv.addEventListener('pointerdown', e => {
    if (hs.range === 'Master' || hs.colorize) return;
    const deg = degAt(e), b = bandOf(hs, hs.range);
    let i = -1, best = 8 / W * 360;
    b.forEach((d, k) => { const dd = Math.min(Math.abs(d - deg), 360 - Math.abs(d - deg)); if (dd < best) { best = dd; i = k; } });
    drag = { i, deg0: deg, band0: [...b] as [number, number, number, number] };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    const deg = degAt(e);
    const nb = drag.i >= 0 ? setBandHandle(bandOf(hs, hs.range), drag.i, deg) : shiftBand(drag.band0, deg - drag.deg0);
    hs.bands = { ...(hs.bands ?? {}), [hs.range]: nb }; draw(); changed();
  });
  cv.addEventListener('pointerup', () => { drag = null; });
  return { el: h('div', { class: 'row spectrum-row' }, cv), draw };
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
  if (kind === 'Hue/Saturation') a.hsvSettings = structuredClone(s.hueSat);
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
  if (kind === 'Remove Background') { openRemoveBackground(); return; }
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
  if (onMask) bakeMask(a);
  const original = onMask ? a.mask! : a.canvas!;
  const sel = Sel.selectionInLayer(d, a, original.width, original.height);
  if (kind === 'Levels') currentHistogram = levelsHistogram(imageDataOf(original));
  let preview = true, pending = false;
  const setCanvas = (c: HTMLCanvasElement) => { if (onMask) a.mask = c; else a.canvas = c; a.rev++; app.needsRender = true; };
  const render = () => {
    pending = false;
    if (!preview) { setCanvas(original); return; }
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
  crCtx = { layer: a, original };
  const endHooks = () => { app.canvasHook = null; s.crClipping = undefined; s.crVisualize = undefined; crCtx = null; app.needsRender = true; };
  const panel = floatingPanel(title, () => { endHooks(); setCanvas(original); openPanel = null; }, { width: kind === 'Camera Raw Filter' ? 320 : 340, right: kind === 'Camera Raw Filter', id: 'filter-panel' });
  const body = h('div');
  const rebuild = () => body.replaceChildren(controls(kind, s, changed, rebuild));
  rebuild();
  const ok = button('OK', () => {
    endHooks();
    setCanvas(original);
    openPanel = null; panel.close();
    lastSettings = structuredClone(s);
    app.runFilter(kind, s, seed);
  }, { class: 'btn primary', id: 'filter-ok' });
  const cancel = button('Cancel', () => { endHooks(); setCanvas(original); openPanel = null; panel.close(); });
  panel.body.append(body, h('div', { class: 'panel-footer' }, checkbox('Preview', true, v => { preview = v; changed(); }), h('span', { class: 'spacer' }), cancel, ok));
  openPanel = { panel, cancel: () => { endHooks(); setCanvas(original); } };
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

// Remove Background (SubjectRemoval.swift): a layer mask that hides everything but the subject. Basic is the model's
// mask as it comes; Advanced refines it (Refine Edges = guided filter, Contrast, Shift Edge), all in wasm.
let lastMatte: MatteSettings = defaultMatte();
export function openRemoveBackground() {
  const d = app.doc, a = app.active;
  if (!d || !a?.canvas || a.adjustment || a.isGroup) { toast('Select a pixel layer first.'); return; }
  const layer = a, original = a.canvas, s: MatteSettings = { ...lastMatte };
  let preview = true, current: Float32Array | null = null, token = 0, closed = false;
  const status = h('p', { class: 'hint', id: 'rb-status' }, 'Finding the subject…');
  const setCanvas = (c: HTMLCanvasElement) => { layer.canvas = c; layer.rev++; app.needsRender = true; };
  const render = async () => {
    const my = ++token;
    try {
      // The preview refines on a copy at most 1400 px across, as the Mac app's does, so sliders stay responsive.
      const m = await app.busyWith('Finding the subject', () => subjectMatte(original, s, 1400)) ?? null;
      if (closed || my !== token || !m) return;
      current = m; status.textContent = '';
      if (!preview) { setCanvas(original); return; }
      const c = cloneCanvas(original), x = ctx2d(c), alpha = canvasOf(c.width, c.height), ax = ctx2d(alpha), img = ax.createImageData(c.width, c.height);
      for (let i = 0; i < m.length; i++) { img.data[i * 4 + 3] = Math.round(m[i] * 255); }
      ax.putImageData(img, 0, 0); x.globalCompositeOperation = 'destination-in'; x.drawImage(alpha, 0, 0);
      setCanvas(c);
    } catch (e) { status.textContent = (e as Error).message; }
  };
  const panel = floatingPanel('Remove Background', () => { closed = true; setCanvas(original); openPanel = null; }, { width: 340, id: 'filter-panel' });
  const body = h('div');
  const rebuild = () => {
    const advanced = s.quality === 'Advanced';
    const segc = h('div', { class: 'segmented' }, ...(['Basic', 'Advanced'] as const).map(q => h('button', { class: q === s.quality ? 'on' : '', onclick: () => { s.quality = q; rebuild(); void render(); } }, q)));
    body.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Quality'), segc));
    if (advanced) body.append(h('div', { class: 'controls' },
      slider({ label: 'Refine Edges', min: 0, max: 40, value: s.refineEdges, onInput: v => { s.refineEdges = v; }, onCommit: () => void render() }),
      slider({ label: 'Contrast', min: 0, max: 100, value: s.matteContrast, onInput: v => { s.matteContrast = v; }, onCommit: () => void render() }),
      slider({ label: 'Shift Edge', min: -10, max: 10, value: s.shiftEdge, unit: 'px', onInput: v => { s.shiftEdge = v; }, onCommit: () => void render() })));
    body.append(status, h('p', { class: 'hint' }, 'Hides the background with a layer mask. Subject detection runs on your device (U²-Net in WebAssembly).'));
  };
  rebuild();
  const ok = button('OK', async () => {
    const opts = { ...s };
    closed = true; setCanvas(original); openPanel = null; panel.close();
    lastMatte = opts;
    const m = await app.busyWith('Removing the background', () => subjectMatte(original, opts));
    if (!m || layer.canvas !== original) return;
    app.edit('Remove Background');
    let mask = matteToMask(m, original.width, original.height);
    if (layer.mask) {
      // Both masks hide: what either one hides stays hidden.
      const c = cloneCanvas(maskInLayerGrid(layer)!); setMaskPlacement(layer, undefined);
      const x = ctx2d(c); x.globalCompositeOperation = 'multiply'; x.drawImage(mask, 0, 0, c.width, c.height); mask = c;
    }
    layer.mask = mask; layer.maskEnabled = true; layer.rev++;
    app.changed('layers');
  }, { class: 'btn primary', id: 'filter-ok' });
  const cancel = button('Cancel', () => { closed = true; setCanvas(original); openPanel = null; panel.close(); });
  panel.body.append(body, h('div', { class: 'panel-footer' }, checkbox('Preview', true, v => { preview = v; if (!v) setCanvas(original); else void render(); }), h('span', { class: 'spacer' }), cancel, ok));
  openPanel = { panel, cancel: () => { closed = true; setCanvas(original); } };
  void current;
  void render();
}
