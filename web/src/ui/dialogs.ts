// Panels and sheets: UI/FilterSheet.swift, LevelsSheet.swift, CurvesControls.swift, HueSaturationSheet.swift,
// EffectsSheet.swift, NewCanvasSheet.swift, CanvasSizeSheet.swift, ImageSizeSheet.swift, JPEGExportSheet.swift.
import { app } from './app';
import { h, slider, select, checkbox, colorWell, button, toHex, floatingPanel, modal, toast, type Panel } from './dom';
import {
  type FilterKind, type FilterSettings, defaultFilterSettings, canvasOf, ctx2d, imageDataOf, COLOR_RANGES, DITHER_STYLES,
  curveValue, levelsTables, autoLevels, type AdjustmentRecord, adjustmentAsFilter, type CurvePoint, type ColorRangeName, defaultCameraRaw, crApplying, type CRGroup, CR_MIXER_NAMES, type CRPoint,
  rangeWeight, bandOf, setBandHandle, shiftBand, type CRCurve, defaultGeometry, bandCentered, bandInclude, bandExclude, sampledHue,
  crNeutralize, srgbDecode, crAutoBalance, crMixerWeights, crCurveRegion,
  LEVELS_AUTO, levelsSampling, normalizedRange, defaultLevels, type LevelsSampleMode, type LevelRange, type LevelsSettings,
  type RGB,
} from '../engine/adjustments';
import { download, type PsdConversion } from '../engine/files';
import { asShotSettings, developRaw, isAsShot, resetRaw, setRawDevelopHook, type RawImage } from '../engine/raw';
import { levelsHistogram, colorRangeMask, cameraRawScope, cameraRawClipOverlay, SCOPE_SIDE } from '../engine/kernels';
import { applyFilterAsync } from '../engine/filterPool';
import { SHORTCUTS, chordFor, chordLabel, chordOf, saveShortcuts, shortcutOverrides, shortcutProblem, type Chord } from './shortcuts';
import { type Layer, type EffectKey, EFFECT_NAMES, cloneCanvas, maskGridView, maskInLayerGrid, setMaskPlacement, invert, apply, pixelToDoc } from '../engine/document';
import * as Sel from '../engine/selection';
import { view, setView, addGuide, GRID_PRESETS, GRID_STYLES, GRID_DEFAULTS, type GridPreset, type GridStyle } from './guides';
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
      // Filled in place, so canvas tools armed before a rebuild keep editing the live settings.
      const cr = s.cameraRaw = Object.assign(s.cameraRaw ?? {}, { ...defaultCameraRaw(), ...s.cameraRaw });
      box.append(crScopeView(changed));
      const section = (title: string, build: (add: (el: HTMLElement) => void) => void) => {
        const d = h('details', { class: 'cr-section' }) as HTMLDetailsElement;
        d.open = crOpen.has(title);
        d.addEventListener('toggle', () => { if (d.open) crOpen.add(title); else crOpen.delete(title); });
        const sum = h('summary', {}, title);
        // The eye beside a section that changes something hides that group from the preview (and the result).
        const groups = CR_SECTION_GROUPS[title] ?? [];
        if (groups.length) {
          const shown = !groups.some(g => crHidden.has(g));
          const eye = h('button', { class: `cr-eye${shown ? '' : ' off'}`, title: `${shown ? 'Hide' : 'Show'} ${title} in the preview`, 'aria-label': `${shown ? 'Hide' : 'Show'} ${title}`,
            'data-group': title });
          eye.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); for (const g of groups) if (shown) crHidden.add(g); else crHidden.delete(g); changed(); rebuild(); });
          sum.append(h('span', { class: 'spacer' }), eye);
        }
        d.append(sum);
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
        add(sub('White Balance'));
        add(h('div', { class: 'row', title: 'Auto balances the average color. Custom follows Temperature and Tint.' }, h('span', { class: 'lbl' }, 'White Balance'),
          select(['Custom', 'Auto'], cr.whiteBalance ?? 'Custom', v => { cr.whiteBalance = v; if (v === 'Auto') crAutoWB(cr); changed(); rebuild(); }, { id: 'cr-wb' }),
          crArmButton('wb', '⊙', 'White Balance tool: click something neutral on the original layer', 'cr-wb-picker', rebuild, dpt => {
            const p = crSample(dpt); if (!p) return;
            const solved = crNeutralize(srgbDecode(p[0]), srgbDecode(p[1]), srgbDecode(p[2]));
            if (!solved) { toast('That color can’t be neutralized.'); return; }
            cr.temperature = crClamp(solved.temperature); cr.tint = crClamp(solved.tint); cr.whiteBalance = 'Custom'; changed(); rebuild();
          })));
        const wb = (key: 'temperature' | 'tint', label: string) => S(label, () => cr[key], v => { cr[key] = v; cr.whiteBalance = 'Custom'; }, -100, 100);
        add(wb('temperature', 'Temperature')); add(wb('tint', 'Tint'));
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
        add(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Targeted'), select(['Parametric', 'Point'], crCurveTarget, v => { crCurveTarget = v; }, { id: 'cr-curve-target-page' }),
          crTargetButton('curve', 'Drag up or down on the picture to move the curve for the tone under the pointer', 'cr-curve-target', rebuild, () => {
            const start = structuredClone(cr.curve);
            return (sample, delta) => {
              if (crCurveTarget === 'Parametric') { const key = crCurveRegion(start, sample.tone); cr.curve[key] = Math.min(100, Math.max(-100, start[key] + delta)); }
              else cr.curve.rgb = crNudged(start.rgb, sample.tone, delta / 100);
              changed();
            };
          })));
        add(sub('Point curve'));
        add(crCurveEditor(c, changed));
        add(k(c, 'refineSaturation', 'Refine saturation', -100, 100));
      });
      section('Color Mixer', add => {
        const m = cr.mixer;
        add(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Targeted'), select(['Hue', 'Saturation', 'Luminance'], crMixerTarget, v => { crMixerTarget = v; }, { id: 'cr-mixer-target-tab' }),
          crTargetButton('mixer', 'Drag up or down on the picture to adjust the color families under the pointer', 'cr-mixer-target', rebuild, sample => {
            const arr = crMixerTarget === 'Hue' ? m.hue : crMixerTarget === 'Saturation' ? m.saturation : m.luminance, start = [...arr], w = crMixerWeights(sample.hue);
            return (_s, delta) => { w.forEach((wt, i) => { if (wt > 0) arr[i] = Math.min(100, Math.max(-100, start[i] + delta * wt)); }); changed(); };
          })));
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
        add(sub('Sharpening')); add(k(d, 'sharpenAmount', 'Amount', 0, 150)); add(k(d, 'sharpenRadius', 'Radius', 0, 100)); add(k(d, 'sharpenDetail', 'Detail', 0, 100)); 
        // Option-drag Masking: the edge mask (adjust_camera_raw_sharpen_mask_overlay) while the pointer is down.
        const masking = k(d, 'sharpenMasking', 'Masking', 0, 100); masking.title = 'Limits sharpening to stronger edges. Hold Option (Alt) while dragging to see the mask.';
        masking.addEventListener('pointerdown', e => { if (e.altKey) { s.crSharpenMask = true; changed(); } });
        const maskOff = () => { if (s.crSharpenMask) { s.crSharpenMask = undefined; changed(); } };
        masking.addEventListener('pointerup', maskOff); masking.addEventListener('pointercancel', maskOff); add(masking);
        add(sub('Noise Reduction')); add(k(d, 'noiseLuminance', 'Luminance', 0, 100)); add(k(d, 'noiseLuminanceDetail', 'Detail', 0, 100)); add(k(d, 'noiseLuminanceContrast', 'Contrast', 0, 100));
        add(k(d, 'noiseColor', 'Color', 0, 100)); add(k(d, 'noiseColorDetail', 'Color detail', 0, 100)); add(k(d, 'noiseColorSmoothness', 'Smoothness', 0, 100));
      });
      section('Optics', add => {
        const o = cr.optics;
        add(h('div', { class: 'row' }, checkbox('Remove Chromatic Aberration', o.removeChromaticAberration, v => { o.removeChromaticAberration = v; changed(); })));
        add(h('div', { class: 'row' }, checkbox('Use Profile Corrections', o.enableLensProfile, v => { o.enableLensProfile = v; changed(); })));
        add(k(o, 'profileDistortion', 'Profile distortion', 0, 100)); add(k(o, 'profileVignetting', 'Profile vignetting', 0, 100));
        add(k(o, 'distortion', 'Distortion', -100, 100));
        add(sub('Defringe'));
        add(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Fringe Selector'), crArmButton('defringe', '⊙', 'Click a purple or green fringe on the layer', 'cr-defringe-picker', rebuild, dpt => {
          const p = crSample(dpt); if (!p) return;
          const hue = crHue(p[0], p[1], p[2]), span = 25;
          if (Math.abs(hue - 290) < Math.abs(hue - 90)) { o.purpleHueLow = Math.max(0, hue - span); o.purpleHueHigh = Math.min(360, hue + span); if (!o.purpleAmount) o.purpleAmount = 50; }
          else { o.greenHueLow = Math.max(0, hue - span); o.greenHueHigh = Math.min(360, hue + span); if (!o.greenAmount) o.greenAmount = 50; }
          changed(); rebuild();
        })));
        add(k(o, 'purpleAmount', 'Purple amount', 0, 100)); add(k(o, 'purpleHueLow', 'Purple hue from', 0, 360, 1, '°')); add(k(o, 'purpleHueHigh', 'Purple hue to', 0, 360, 1, '°'));
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
      box.append(h('div', { class: 'row' }, button('Reset All', () => { crDisarm(); s.cameraRaw = defaultCameraRaw(); changed(); rebuild(); })));
      break;
    }
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
        if (!hs.colorize && hs.range !== 'Master') inner.append(checkbox('Apply outside this range instead', !!hs.invertRange, v => { hs.invertRange = v; changed(); spec.draw(); }));
        inner.append(spec.el);
        spec.draw();
      };
      const spec = hueSpectrum(hs, () => { changed(); });
      if (!hs.colorize) box.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Range'), select(COLOR_RANGES, hs.range, v => { hs.range = v as ColorRangeName; draw(); rebuild(); }, { id: 'hs-range' })),
        hueSamplers(hs, () => { changed(); spec.draw(); }, () => { rebuild(); }));
      box.append(inner, checkbox('Colorize', hs.colorize, v => {
        hs.colorize = v; if (v) { hs.range = 'Master'; hs.adjustments = { Master: { hue: 0, saturation: 25, lightness: 0 } }; } else hs.adjustments = {};
        changed(); rebuild();
      }));
      draw();
      break;
    }
    case 'Curves': box.append(curvesEditor(s, changed)); break;
    case 'Levels': box.append(levelsEditor(s, changed, forAdjustmentLayer)); break;
    default: break;
  }
  return box;
}

/** The open filter's layer and its untouched pixels, for panels that sample or draw on the canvas. */
const CR_SECTION_GROUPS: Record<string, CRGroup[]> = { Basic: ['Light', 'Color'], Curve: ['Curve'], 'Color Mixer': ['Color Mixer'], 'Point Color': ['Color Mixer'],
  'Color Grading': ['Color Grading'], Detail: ['Detail'], Optics: ['Optics'], Geometry: ['Geometry'], Effects: ['Effects'], Calibration: ['Calibration'] };
let crCtx: { layer: Layer; original: HTMLCanvasElement; current: () => HTMLCanvasElement } | null = null;
// Camera Raw's scope (CameraRawControls.histogram): histogram or vectorscope of the grade, the two clipping
// indicator triangles, and the RGB readout under the pointer.
let crScope: ReturnType<typeof cameraRawScope> | null = null;
let crScopeMode: 'Histogram' | 'Vectorscope' = 'Histogram';
let crShowShadows = false, crShowHighlights = false;
/** Panel groups hidden with their eye buttons (FilterEdit.showsCameraRaw…): left out of the preview and the result. */
const crHidden = new Set<CRGroup>();
let crScopeCanvas: HTMLCanvasElement | null = null, crReadoutEl: HTMLElement | null = null;
/** At most about a million pixels are counted; larger previews are sampled on a regular grid. */
function scopeSample(img: ImageData): ImageData {
  const n = img.width * img.height; if (n <= 1 << 20) return img;
  const step = Math.ceil(Math.sqrt(n / (1 << 20))), w = Math.ceil(img.width / step), hh = Math.ceil(img.height / step), o = new ImageData(w, hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) { const si = ((y * step) * img.width + x * step) * 4, di = (y * w + x) * 4; o.data[di] = img.data[si]; o.data[di + 1] = img.data[si + 1]; o.data[di + 2] = img.data[si + 2]; o.data[di + 3] = img.data[si + 3]; }
  return o;
}
const same = (a: Chord, b: Chord) => a.key === b.key && a.modifiers === b.modifiers;
function histPeak(bins: number[]) {
  const peak = Math.max(0, ...bins.filter(v => isFinite(v) && v > 0)); if (!peak) return 0;
  const interior = bins.slice(1, -1).filter(v => isFinite(v) && v > 0).sort((a, b) => a - b);
  return interior.length ? Math.min(peak, interior[Math.floor((interior.length - 1) * 0.95)] * 4) : peak;
}
function drawCrScope() {
  const cv = crScopeCanvas; if (!cv) return;
  const x = ctx2d(cv), W = cv.width, H = cv.height;
  x.clearRect(0, 0, W, H); x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(0, 0, W, H);
  cv.title = crScopeMode === 'Histogram'
    ? 'Tones from black on the left to white on the right: blacks, shadows, midtones, highlights, whites. Right-click to show the vectorscope.'
    : 'Hue around the wheel, saturation outward from the center. Right-click to show the histogram.';
  cv.setAttribute('aria-label', crScopeMode === 'Histogram' ? 'RGB histogram' : 'Vectorscope');
  cv.dataset.mode = crScopeMode;
  const sc = crScope; if (!sc) return;
  if (crScopeMode === 'Histogram') {
    const peak = Math.max(histPeak(sc.red), histPeak(sc.green), histPeak(sc.blue)); if (!(peak > 0)) return;
    x.globalCompositeOperation = 'lighter';
    for (const [bins, col] of [[sc.red, 'rgba(255,40,40,0.55)'], [sc.green, 'rgba(40,220,60,0.55)'], [sc.blue, 'rgba(60,100,255,0.55)']] as const) {
      x.beginPath(); x.moveTo(0, H);
      bins.forEach((v, i) => x.lineTo(i * W / bins.length, H - H * Math.min(1, Math.max(0, v / peak))));
      x.lineTo(W, H); x.closePath(); x.fillStyle = col; x.fill();
    }
    x.globalCompositeOperation = 'source-over';
  } else {
    let peak = 0; for (const v of sc.vectorscope) if (v > peak) peak = v;
    // The square plot, centered; rows count up from the bottom as in the Mac app.
    const side = Math.min(W, H), ox = (W - side) / 2, cell = side / SCOPE_SIDE;
    x.strokeStyle = 'rgba(255,255,255,0.18)'; x.beginPath(); x.arc(ox + side / 2, side / 2, side * 0.48, 0, Math.PI * 2); x.stroke();
    if (!(peak > 0)) return;
    sc.vectorscope.forEach((v, i) => {
      if (v <= 0) return;
      const col = i % SCOPE_SIDE, row = Math.floor(i / SCOPE_SIDE);
      x.fillStyle = `rgba(255,255,255,${0.15 + 0.85 * Math.min(1, v / peak)})`;
      x.fillRect(ox + col * cell, side - (row + 1) * cell, cell + 0.2, cell + 0.2);
    });
  }
}
/** Histogram, the clipping indicator triangles and the R G B readout, above Camera Raw's sections. */
function crScopeView(changed: () => void): HTMLElement {
  const cv = h('canvas', { width: 576, height: 220, id: 'cr-scope', style: 'width:100%;height:110px;display:block;border-radius:4px' }) as HTMLCanvasElement;
  cv.addEventListener('contextmenu', e => { e.preventDefault(); crScopeMode = crScopeMode === 'Histogram' ? 'Vectorscope' : 'Histogram'; drawCrScope(); });
  crScopeCanvas = cv;
  const tri = (shadows: boolean) => {
    const on = shadows ? crShowShadows : crShowHighlights;
    const b = button('▲', () => {
      if (shadows) crShowShadows = !crShowShadows; else crShowHighlights = !crShowHighlights;
      b.style.color = (shadows ? crShowShadows : crShowHighlights) ? (shadows ? '#3d7bff' : '#ff3b30') : 'rgba(255,255,255,0.55)';
      b.classList.toggle('on', shadows ? crShowShadows : crShowHighlights); changed();
    }, { class: `cr-clip-tri${on ? ' on' : ''}`, id: shadows ? 'cr-clip-shadows' : 'cr-clip-highlights',
      title: shadows ? 'Show clipped shadows in blue on the preview.' : 'Show clipped highlights in red on the preview.',
      'aria-label': shadows ? 'Shadow Clipping Indicator' : 'Highlight Clipping Indicator' });
    b.style.color = on ? (shadows ? '#3d7bff' : '#ff3b30') : 'rgba(255,255,255,0.55)';
    return b;
  };
  crReadoutEl = h('div', { class: 'cr-readout', id: 'cr-readout', title: 'Red, green, and blue of the pixel under the pointer.' }, 'R —   G —   B —');
  const wrap = h('div', { class: 'cr-scope' }, cv, h('div', { class: 'cr-scope-tris' }, tri(true), tri(false)));
  queueMicrotask(drawCrScope);
  return h('div', {}, wrap, crReadoutEl);
}

/** Document point → normalized 0…1 position on the filtered layer (y down), or null outside it. */
function layerUV(dpt: [number, number]): [number, number] | null {
  if (!crCtx) return null;
  const l = crCtx.layer, m = invert(pixelToDoc(l.transform, 1, 1)), [u, v] = apply(m, dpt[0], dpt[1]);
  return u >= 0 && v >= 0 && u <= 1 && v <= 1 ? [u, v] : null;
}
function uvToDoc(u: number, v: number): [number, number] { return apply(pixelToDoc(crCtx!.layer.transform, 1, 1), u, v); }

/** Straight RGB (0…1) of the original layer under a document point, or null off the layer or on a transparent pixel. */
function crSample(dpt: [number, number]): [number, number, number] | null {
  const uv = layerUV(dpt); if (!uv || !crCtx) return null;
  const o = crCtx.original, px = Math.min(o.width - 1, Math.floor(uv[0] * o.width)), py = Math.min(o.height - 1, Math.floor(uv[1] * o.height));
  const d = ctx2d(o).getImageData(px, py, 1, 1).data;
  return d[3] ? [d[0] / 255, d[1] / 255, d[2] / 255] : null;
}
const crClamp = (v: number) => Math.round(Math.min(100, Math.max(-100, v)) * 10) / 10;
/** White Balance › Auto (applyCameraRawAutoWhiteBalance): gray-world balance of the original layer. */
function crAutoWB(cr: NonNullable<FilterSettings['cameraRaw']>) {
  if (!crCtx) return;
  const o = crCtx.original, solved = crAutoBalance(ctx2d(o).getImageData(0, 0, o.width, o.height));
  if (solved) { cr.temperature = crClamp(solved.temperature); cr.tint = crClamp(solved.tint); } else toast('Auto white balance found nothing to balance.');
}
/** Camera Raw's canvas tools (White Balance and Defringe eyedroppers, the targeted Curve and Color Mixer drags). One is armed at a time. */
let crArmed: 'wb' | 'defringe' | 'curve' | 'mixer' | null = null;
let crCurveTarget: 'Parametric' | 'Point' = 'Parametric', crMixerTarget: 'Hue' | 'Saturation' | 'Luminance' = 'Saturation';
function crDisarm() { crArmed = null; app.canvasHook = null; app.needsRender = true; }
function crArmButton(mode: NonNullable<typeof crArmed>, label: string, tip: string, id: string, rebuild: () => void, click: (dpt: [number, number]) => void) {
  return button(label, () => {
    if (crArmed === mode) { crDisarm(); rebuild(); return; }
    crArmed = mode; app.canvasHook = { cursor: 'crosshair', down: dpt => click(dpt) }; rebuild();
  }, { class: `btn small${crArmed === mode ? ' on' : ''}`, title: `${tip}. Click again to stop.`, id });
}
/** hueDegrees: 0 for grays. */
function crHue(r: number, g: number, b: number) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
  if (c <= 1e-6) return 0;
  const hh = (mx === r ? (g - b) / c : mx === g ? 2 + (b - r) / c : 4 + (r - g) / c) * 60;
  return hh < 0 ? hh + 360 : hh;
}
/** CameraRawSampling (cameraRawSample): tone as Rec. 709 luma, hue in degrees. */
type CRSample = { tone: number; hue: number };
function crTargetButton(mode: 'curve' | 'mixer', tip: string, id: string, rebuild: () => void, begin: (s: CRSample) => (s: CRSample, delta: number) => void) {
  return button('↕', () => {
    if (crArmed === mode) { crDisarm(); rebuild(); return; }
    crArmed = mode;
    let drag: { y: number; sample: CRSample; apply: (s: CRSample, delta: number) => void } | null = null;
    app.canvasHook = { cursor: 'ns-resize',
      down: dpt => {
        const p = crSample(dpt); if (!p) return;
        const sample = { tone: 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2], hue: crHue(p[0], p[1], p[2]) };
        drag = { y: dpt[1], sample, apply: begin(sample) };
      },
      // dragCameraRaw: 0.35 per document point, upward positive.
      move: dpt => { if (drag) drag.apply(drag.sample, (drag.y - dpt[1]) * 0.35); },
      up: () => { if (drag) { drag = null; rebuild(); } } };
    rebuild();
  }, { class: `btn small${crArmed === mode ? ' on' : ''}`, title: `${tip}. Click again to stop.`, id });
}
/** CameraRawCurveSettings.nudged: move the point nearest the tone by `delta`. */
function crNudged(pts: CRPoint[], tone: number, delta: number): CRPoint[] {
  const p = pts.map(q => ({ ...q }));
  if (!p.length) return p;
  let best = 0; p.forEach((q, i) => { if (Math.abs(q.x - tone) < Math.abs(p[best].x - tone)) best = i; });
  p[best].y = Math.min(1, Math.max(0, p[best].y + delta));
  return p;
}

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
    sampling = true; crArmed = null;
    app.canvasHook = { cursor: 'crosshair', down: sampleAt };
    draw();
  };
  const draw = () => {
    box.replaceChildren();
    const sw = h('div', { class: 'row swatches' });
    pts.forEach((p, i) => {
      const b = h('button', { class: `pc-swatch${i === sel ? ' sel' : ''}`, title: `Point ${i + 1}`, style: `background:hsl(${p.hue},${Math.round(p.saturation * 100)}%,${Math.round(p.luminance * 100)}%)` });
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
    // A Camera Raw eyedropper or targeted tool keeps the canvas until it's switched off.
    if (g.upright === 'Guided' && !crArmed) hookOn(); else if (!crArmed && app.canvasHook?.draw) { app.canvasHook = null; app.needsRender = true; }
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

/** What Hue/Saturation's eyedroppers read: the filtered layer's own pixels, or (editing an adjustment layer) the
 *  composite below it. */
let hsSampleBelow: ImageData | null = null;
function hueAt(dpt: [number, number]): number | null {
  let px: Uint8ClampedArray;
  if (crCtx) {
    const uv = layerUV(dpt); if (!uv) return null;
    const o = crCtx.original, x = Math.min(o.width - 1, Math.floor(uv[0] * o.width)), y = Math.min(o.height - 1, Math.floor(uv[1] * o.height));
    px = ctx2d(o).getImageData(x, y, 1, 1).data;
  } else if (hsSampleBelow) {
    const x = Math.floor(dpt[0]), y = Math.floor(dpt[1]);
    if (x < 0 || y < 0 || x >= hsSampleBelow.width || y >= hsSampleBelow.height) return null;
    const i = (y * hsSampleBelow.width + x) * 4; px = hsSampleBelow.data.subarray(i, i + 4);
  } else return null;
  return px[3] ? sampledHue(px[0] / 255, px[1] / 255, px[2] / 255) : null;
}
/** HueSaturationSheet's eyedroppers (Sample / Add / Remove: re-center, widen or narrow the selected range's band from
 *  a color in the image) and the targeted-adjustment tool (drag on the image: the range owning that color's
 *  saturation, or its hue with ⌘/Ctrl). One stays armed until clicked again. */
let hsArmed: 'Sample' | 'Add' | 'Remove' | 'Target' | null = null;
function hueSamplers(hs: FilterSettings['hueSat'], changed: () => void, rebuild: () => void): HTMLElement {
  const row = h('div', { class: 'row hs-samplers' });
  const disarm = () => { hsArmed = null; if (app.canvasHook?.cursor === 'crosshair' || app.canvasHook?.cursor === 'ew-resize') app.canvasHook = null; };
  const arm = (mode: NonNullable<typeof hsArmed>) => {
    if (hsArmed === mode) { disarm(); rebuild(); return; }
    hsArmed = mode;
    if (mode === 'Target') {
      let drag: { range: ColorRangeName; hue: number; sat: number; x: number } | null = null;
      app.canvasHook = { cursor: 'ew-resize',
        down: (dpt, e) => {
          const hue = hueAt(dpt); if (hue === null) { toast('That color has no hue to target.'); return; }
          const range = (COLOR_RANGES.filter(r => r !== 'Master') as ColorRangeName[]).reduce((a, b) => rangeWeight(hs, b, hue) > rangeWeight(hs, a, hue) ? b : a, 'Reds' as ColorRangeName);
          hs.range = range;
          const adj = hs.adjustments[range] ?? (hs.adjustments[range] = { hue: 0, saturation: 0, lightness: 0 });
          drag = { range, hue: adj.hue, sat: adj.saturation, x: e.clientX };
          changed(); rebuild();
        },
        move: (_dpt, e) => {
          if (!drag) return;
          const adj = hs.adjustments[drag.range]!, delta = (e.clientX - drag.x) / 2;
          if (e.metaKey || e.ctrlKey) adj.hue = Math.min(180, Math.max(-180, drag.hue + delta));
          else adj.saturation = Math.min(100, Math.max(-100, drag.sat + delta));
          changed();
        },
        up: () => { if (drag) { drag = null; rebuild(); } } };
    } else {
      app.canvasHook = { cursor: 'crosshair', down: dpt => {
        if (hs.range === 'Master' || hs.colorize) { toast('Choose a color range first.'); return; }
        const hue = hueAt(dpt); if (hue === null) { toast('That color is too close to gray to have a hue.'); return; }
        const b = bandOf(hs, hs.range);
        const next = hsArmed === 'Sample' ? bandCentered(b, hue) : hsArmed === 'Add' ? bandInclude(b, hue) : bandExclude(b, hue);
        hs.bands = { ...(hs.bands ?? {}), [hs.range]: next };
        changed();
      } };
    }
    rebuild();
  };
  const tip: Record<string, string> = { Sample: 'Click the image to center this range on that color', Add: 'Click the image to widen this range to include that color',
    Remove: 'Click the image to narrow this range to exclude that color', Target: 'Drag on the image: right raises the saturation of the range under the pointer (⌘/Ctrl: hue)' };
  for (const [mode, label] of [['Sample', '⊙ Sample'], ['Add', '⊕ Add'], ['Remove', '⊖ Remove'], ['Target', '↔ Targeted']] as const) {
    const disabled = mode !== 'Target' && hs.range === 'Master';
    const b = button(label, () => arm(mode), { class: `btn small${hsArmed === mode ? ' on' : ''}`, title: tip[mode], id: `hs-${mode.toLowerCase()}` });
    if (disabled) (b as HTMLButtonElement).disabled = true;
    row.append(b);
  }
  return row;
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
  const cv = h('canvas', { width: size * 2, height: size * 2, class: 'curve-canvas', id: 'curve-canvas', style: `width:${size}px;height:${size}px` }) as HTMLCanvasElement;
  const x = cv.getContext('2d')!;
  let ch = CHANNELS.indexOf(s.curves.channel);
  let dragging = -1, selected = -1;
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
    pts.forEach((p, i) => { x.fillStyle = i === selected ? '#0a84ff' : '#fff'; x.beginPath(); x.arc(p.x * size / 255, size - p.y * size / 255, 4, 0, Math.PI * 2); x.fill(); });
    // CurvesControls: the selected point's input and output, and Remove point for an interior one.
    const sp = pts[selected];
    readout.textContent = sp ? `Input ${Math.round(sp.x)} · Output ${Math.round(sp.y)}` : '';
    remove.disabled = !(selected > 0 && selected < pts.length - 1);
  };
  const readout = h('span', { class: 'curve-readout', id: 'curve-readout' });
  const removePoint = () => { const pts = s.curves.channels[ch]; if (selected > 0 && selected < pts.length - 1) { pts.splice(selected, 1); selected = -1; draw(); changed(); } };
  const remove = button('Remove point', removePoint, { class: 'btn small', id: 'curve-remove' });
  cv.tabIndex = 0;
  cv.addEventListener('keydown', e => { if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); removePoint(); } });
  const toVal = (e: PointerEvent): CurvePoint => { const r = cv.getBoundingClientRect(); return { x: Math.round(Math.min(255, Math.max(0, (e.clientX - r.left) / r.width * 255))), y: Math.round(Math.min(255, Math.max(0, (1 - (e.clientY - r.top) / r.height) * 255))) }; };
  cv.addEventListener('pointerdown', e => {
    const v = toVal(e), pts = s.curves.channels[ch];
    // The nearest point within reach is picked up; elsewhere a click adds one (not at the ends or on top of another).
    let best = -1, bd = 14;
    pts.forEach((p, i) => { const dd = Math.hypot(p.x - v.x, p.y - v.y); if (dd < bd) { bd = dd; best = i; } });
    dragging = best;
    if (dragging < 0 && pts.length < 32 && v.x > 1 && v.x < 254 && pts.every(p => Math.abs(p.x - v.x) > 1)) { pts.push(v); pts.sort((a, b) => a.x - b.x); dragging = pts.indexOf(v); }
    selected = dragging;
    cv.setPointerCapture(e.pointerId); cv.focus(); draw(); changed();
  });
  cv.addEventListener('pointermove', e => {
    if (dragging < 0) return;
    const v = toVal(e), pts = s.curves.channels[ch];
    const lo = dragging === 0 ? 0 : pts[dragging - 1].x + 1, hi = dragging === pts.length - 1 ? 255 : pts[dragging + 1].x - 1;
    if (dragging === 0) v.x = 0; else if (dragging === pts.length - 1) v.x = 255; else v.x = Math.min(hi, Math.max(lo, v.x));
    // Dragging an interior point far off the graph removes it, as in Photoshop.
    const r = cv.getBoundingClientRect();
    if (dragging > 0 && dragging < pts.length - 1 && (e.clientY < r.top - 30 || e.clientY > r.bottom + 30)) { pts.splice(dragging, 1); dragging = -1; selected = -1; }
    else { pts[dragging] = v; selected = dragging; }
    draw(); changed();
  });
  cv.addEventListener('pointerup', () => { dragging = -1; });
  draw();
  const chSel = select([...CHANNELS], s.curves.channel, v => { s.curves.channel = v as 'RGB'; ch = CHANNELS.indexOf(v as 'RGB'); selected = -1; draw(); }, { id: 'curve-channel' });
  const reset = button('Reset curve', () => { s.curves.channels[ch] = [{ x: 0, y: 0 }, { x: 255, y: 255 }]; selected = -1; draw(); changed(); }, { id: 'curve-reset' });
  return h('div', {}, h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Channel'), chSel, reset), cv,
    h('p', { class: 'hint' }, 'Click to add a point. Drag to adjust. Delete, or drag off the graph, removes the selected point.'),
    h('div', { class: 'row curve-sel' }, readout, h('span', { style: 'flex:1' }), remove));
}

let currentHistogram: number[][] | null = null;
let lvArmed: LevelsSampleMode | null = null;
/** The untouched color under a document point: the filtered layer's original pixels, or for an adjustment layer the
 *  image below it. Unpremultiplied 0…1, or null off the image or where it's clear. */
function originalRGB(dpt: [number, number]): [number, number, number] | null {
  let px: Uint8ClampedArray;
  if (crCtx) {
    const uv = layerUV(dpt); if (!uv) return null;
    const o = crCtx.original, x = Math.floor(uv[0] * o.width), y = Math.floor(uv[1] * o.height);
    if (x < 0 || y < 0 || x >= o.width || y >= o.height) return null;
    px = ctx2d(o).getImageData(x, y, 1, 1).data;
  } else if (hsSampleBelow) {
    const x = Math.floor(dpt[0]), y = Math.floor(dpt[1]);
    if (x < 0 || y < 0 || x >= hsSampleBelow.width || y >= hsSampleBelow.height) return null;
    const i = (y * hsSampleBelow.width + x) * 4; px = hsSampleBelow.data.subarray(i, i + 4);
  } else return null;
  return px[3] ? [px[0]! / 255, px[1]! / 255, px[2]! / 255] : null;
}
/** LevelsSheet: histogram with the input black/gamma/white triangles, the output ramp with its two, numeric fields,
 *  Black/Gray/White eyedroppers that sample the original, the three Auto modes and Reset. */
function levelsEditor(s: FilterSettings, changed: () => void, forAdjustment = false): HTMLElement {
  const W = 300;
  const cv = h('canvas', { width: W * 2, height: 300, class: 'histo', id: 'levels-histogram', style: `width:${W}px;height:150px;cursor:default`,
    title: 'Linear histogram with automatic vertical scaling. Tall spikes may extend beyond the graph; all tones from 0 to 255 remain included.' }) as HTMLCanvasElement;
  let ch = CHANNELS.indexOf(s.levels.channel);
  const cur = () => s.levels.ranges[ch]!;
  const drawHist = () => {
    const x = cv.getContext('2d')!; x.clearRect(0, 0, cv.width, cv.height); x.fillStyle = '#1b1b1b'; x.fillRect(0, 0, cv.width, cv.height);
    const bins = currentHistogram?.[ch]; if (!bins) { x.fillStyle = '#999'; x.font = '22px system-ui'; x.fillText('Loading histogram…', 14, 34); return; }
    // LevelsHistogramDisplay.scale: linear, but isolated spikes are capped at four times the typical peak.
    const peakAll = Math.max(0, ...bins.filter(v => v > 0)), interior = bins.slice(1, 255).filter(v => v > 0).sort((a, b) => a - b);
    const peak = interior.length ? Math.min(peakAll, interior[Math.floor((interior.length - 1) * 0.95)]! * 4) : peakAll;
    if (!(peak > 0)) return;
    x.fillStyle = ['#9a9a9a', '#ff5f57', '#34c759', '#4c8dff'][ch]!;
    const bw = cv.width / 256;
    for (let i = 0; i < 256; i++) { const hgt = Math.min(1, bins[i]! / peak) * cv.height; x.fillRect(i * bw, cv.height - hgt, bw + 0.2, hgt); }
  };
  // Triangle handles (LevelsSheet.handles): drag along 0…255.
  const handleRow = (output: boolean) => {
    const row = h('div', { class: 'lv-handles', id: output ? 'levels-output-handles' : 'levels-input-handles', style: `width:${W}px` });
    const names = output ? ['Output black', 'Output white'] : ['Input black', 'Gamma', 'Input white'];
    const tris = names.map((n, i) => {
      const t = h('div', { class: `lv-tri ${i === 0 ? 'k' : i === names.length - 1 ? 'w' : 'g'}`, title: n, 'aria-label': n });
      t.addEventListener('pointerdown', e => {
        e.preventDefault(); t.setPointerCapture(e.pointerId);
        const mv = (ev: PointerEvent) => {
          const r0 = row.getBoundingClientRect(), v = Math.min(255, Math.max(0, (ev.clientX - r0.left) / r0.width * 255)), r = cur();
          if (output) { if (i === 0) r.outputBlack = Math.round(v); else r.outputWhite = Math.round(v); }
          else if (i === 0) r.black = Math.min(r.white - 1, Math.round(v));
          else if (i === 2) r.white = Math.max(r.black + 1, Math.round(v));
          else { const f = Math.min(0.999, Math.max(0.001, (v - r.black) / (r.white - r.black))); r.gamma = Math.round(Math.log(f) / Math.log(0.5) * 100) / 100; }
          Object.assign(r, normalizedRange(r)); sync(); changed();
        };
        const up = () => { t.removeEventListener('pointermove', mv); t.removeEventListener('pointerup', up); };
        t.addEventListener('pointermove', mv); t.addEventListener('pointerup', up);
      });
      row.append(t); return t;
    });
    const place = () => {
      const r = cur(), pos = output ? [r.outputBlack, r.outputWhite] : [r.black, r.black + (r.white - r.black) * Math.pow(0.5, r.gamma), r.white];
      tris.forEach((t, i) => { t.style.left = `${pos[i]! / 255 * 100}%`; });
    };
    return { row, place };
  };
  const inH = handleRow(false), outH = handleRow(true);
  const field = (name: string, key: keyof LevelRange, decimals: number) => {
    const i = h('input', { type: 'number', class: 'dim', step: decimals ? 0.01 : 1, min: key === 'gamma' ? 0.1 : 0, max: key === 'gamma' ? 9.99 : 255, id: `levels-${name.toLowerCase().replace(/ /g, '-')}` }) as HTMLInputElement;
    i.addEventListener('change', () => { const r = cur(); r[key] = +i.value; Object.assign(r, normalizedRange(r)); sync(); changed(); });
    i.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') i.blur(); });
    return { el: h('label', { class: 'lv-field' }, h('span', {}, name), i), set: () => { if (document.activeElement !== i) i.value = cur()[key].toFixed(decimals); } };
  };
  const fields = [field('Input black', 'black', 0), field('Gamma', 'gamma', 2), field('Input white', 'white', 0), field('Output black', 'outputBlack', 0), field('Output white', 'outputWhite', 0)];
  function sync() { inH.place(); outH.place(); fields.forEach(f => f.set()); }
  const chSel = select([...CHANNELS], s.levels.channel, v => { s.levels.channel = v as 'RGB'; ch = CHANNELS.indexOf(v as 'RGB'); drawHist(); sync(); }, { id: 'levels-channel' });
  const setAll = (n: LevelsSettings) => { s.levels.ranges = n.ranges.map(r => ({ ...r })); sync(); changed(); };
  // Sample: the eyedroppers set the black, gray or white point from a click on the original (all three channels together).
  const sampleRow = h('div', { class: 'row lv-sample' }, h('span', { class: 'lbl small' }, 'Sample'));
  const sampleHint = h('p', { class: 'hint', id: 'levels-sample-hint' });
  const sampleBtns = (['Black', 'Gray', 'White'] as LevelsSampleMode[]).map(m => {
    const b = button(`⌖ ${m}`, () => {
      lvArmed = lvArmed === m ? null : m;
      if (lvArmed) app.canvasHook = { cursor: 'crosshair', down: dpt => {
        const rgb = originalRGB(dpt); if (!rgb || !lvArmed) return;
        setAll(levelsSampling(s.levels, rgb, lvArmed));
      } };
      else if (app.canvasHook?.cursor === 'crosshair') app.canvasHook = null;
      showArmed();
    }, { class: 'btn small', id: `levels-sample-${m.toLowerCase()}`, title: `Click the original layer to set ${m.toLowerCase()}` });
    sampleRow.append(b); return b;
  });
  const showArmed = () => {
    sampleBtns.forEach((b, i) => b.classList.toggle('on', lvArmed === (['Black', 'Gray', 'White'] as const)[i]));
    sampleHint.textContent = lvArmed ? `Click the ${forAdjustment ? 'image' : 'original layer'} to set ${lvArmed.toLowerCase()}. Click the eyedropper again to stop.` : '';
  };
  showArmed();
  const autoRow = h('div', { class: 'row lv-auto' }, h('span', { class: 'lbl small' }, 'Auto'),
    ...LEVELS_AUTO.map(m => button(m, () => { if (!currentHistogram) return; lvArmed = null; if (app.canvasHook?.cursor === 'crosshair') app.canvasHook = null; showArmed(); setAll(autoLevels(currentHistogram, m)); },
      { class: 'btn small', id: `levels-auto-${m.split(' ')[0]!.toLowerCase()}${m.includes('neutral') ? '-neutral' : ''}` })));
  const reset = button('Reset', () => { lvArmed = null; if (app.canvasHook?.cursor === 'crosshair') app.canvasHook = null; showArmed(); setAll(defaultLevels()); }, { class: 'btn small', id: 'levels-reset' });
  const caption = h('p', { class: 'hint' }, forAdjustment ? 'Underlying pixels · alpha-weighted histogram' : app.doc?.selection ? 'Original pixels · selection and alpha-weighted histogram' : 'Original pixels · alpha-weighted histogram');
  drawHist(); sync();
  return h('div', { class: 'levels' },
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Channel'), chSel, h('span', { style: 'flex:1' }), reset),
    cv, inH.row,
    h('div', { class: 'row lv-fields' }, fields[0]!.el, fields[1]!.el, fields[2]!.el),
    h('div', { class: 'lv-ramp', style: `width:${W}px` }), outH.row,
    h('div', { class: 'row lv-fields' }, fields[3]!.el, fields[4]!.el),
    sampleRow, sampleHint, autoRow, caption);
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
  const original = onMask ? a.mask! : a.canvas!;
  // A mask is filtered in its own grid, where it sits (maskGridView).
  const grid = onMask ? maskGridView(a) : a;
  const sel = Sel.selectionInLayer(d, grid, original.width, original.height);
  if (kind === 'Levels') currentHistogram = levelsHistogram(imageDataOf(original));
  let preview = true, pending = false;
  const setCanvas = (c: HTMLCanvasElement) => { if (onMask) a.mask = c; else a.canvas = c; a.rev++; app.needsRender = true; };
  // The preview runs in the filter workers; a result that arrives after a newer one was asked for, or after the panel
  // closed, is dropped.
  let generation = 0, closed = false, running = false, again = false;
  const render = async () => {
    pending = false;
    if (closed) return;
    if (!preview) { generation++; setCanvas(original); return; }
    if (running) { again = true; return; }
    running = true;
    const mine = ++generation;
    try {
      const img = imageDataOf(original);
      const scale = original.width / grid.transform.w;
      const out = await applyFilterAsync(kind, kind === 'Camera Raw Filter' ? { ...s, cameraRaw: crApplying(s.cameraRaw, crHidden) } : s, img, { seed, scale: isFinite(scale) && scale > 0 ? scale : 1, canvasFrame: kind === 'Vignette' && app.isEmptyLayer(original) ? app.canvasFrameIn(grid, original) : undefined });
      if (closed || mine !== generation) return;
      if (kind === 'Camera Raw Filter') {
        // The scope counts the grade itself, without the Option-drag views or the indicator paint.
        if (!s.crClipping && !s.crSharpenMask && s.crVisualize === undefined) { crScope = cameraRawScope(scopeSample(out)); drawCrScope(); }
        cameraRawClipOverlay(out, crShowShadows, crShowHighlights);
      }
      let c = canvasOf(out.width, out.height); ctx2d(c).putImageData(out, 0, 0);
      if (sel) { const r = cloneCanvas(original), rx = ctx2d(r); const inside = canvasOf(c.width, c.height), ix = ctx2d(inside); ix.drawImage(c, 0, 0); ix.globalCompositeOperation = 'destination-in'; ix.drawImage(sel, 0, 0); rx.globalCompositeOperation = 'destination-out'; rx.drawImage(sel, 0, 0); rx.globalCompositeOperation = 'source-over'; rx.drawImage(inside, 0, 0); c = r; }
      setCanvas(c);
    } catch (e) { console.error(e); toast(`Preview failed: ${(e as Error).message}`, 'error'); }
    finally {
      running = false;
      // Settings that changed while this preview was being made: one more, with the latest.
      if (again && !closed) { again = false; void render(); }
    }
  };
  const changed = () => { if (!pending) { pending = true; requestAnimationFrame(() => void render()); } };
  const title = kind === 'Camera Raw Filter' ? 'Camera Raw Filter' : kind;
  crCtx = { layer: grid, original, current: () => (onMask ? a.mask : a.canvas) ?? original };
  crScope = null; crHidden.clear();
  // The R G B readout follows the pointer over the preview.
  const stageEl = document.getElementById('stage');
  const onHover = (e: PointerEvent) => {
    if (!crReadoutEl || !crCtx || kind !== 'Camera Raw Filter') return;
    const r = stageEl!.getBoundingClientRect(), uv = layerUV(app.toDoc(e.clientX - r.left, e.clientY - r.top));
    const c = crCtx.current();
    if (!uv) { crReadoutEl.textContent = 'R —   G —   B —'; return; }
    const px = ctx2d(c).getImageData(Math.min(c.width - 1, Math.floor(uv[0] * c.width)), Math.min(c.height - 1, Math.floor(uv[1] * c.height)), 1, 1).data;
    crReadoutEl.textContent = px[3] ? `R ${px[0]}   G ${px[1]}   B ${px[2]}` : 'R —   G —   B —';
  };
  if (kind === 'Camera Raw Filter') stageEl?.addEventListener('pointermove', onHover);
  const endHooks = () => { stageEl?.removeEventListener('pointermove', onHover); crScopeCanvas = null; crReadoutEl = null; closed = true; generation++; hsArmed = null; crArmed = null; lvArmed = null; app.canvasHook = null; s.crClipping = undefined; s.crVisualize = undefined; s.crSharpenMask = undefined; crCtx = null; app.needsRender = true; };
  const panel = floatingPanel(title, () => { endHooks(); setCanvas(original); openPanel = null; }, { width: kind === 'Camera Raw Filter' ? 320 : 340, right: kind === 'Camera Raw Filter', id: 'filter-panel' });
  const body = h('div');
  const rebuild = () => body.replaceChildren(controls(kind, s, changed, rebuild));
  rebuild();
  const ok = button('OK', () => {
    endHooks();
    setCanvas(original);
    openPanel = null; panel.close();
    lastSettings = structuredClone(s);
    app.runFilter(kind, kind === 'Camera Raw Filter' ? { ...s, cameraRaw: crApplying(s.cameraRaw, crHidden) } : s, seed);
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
  if (kind === 'Hue/Saturation' || kind === 'Levels') {
    // The eyedroppers read the image below the adjustment.
    const d = app.doc!, idx = d.layers.indexOf(l);
    hsSampleBelow = app.renderer.readComposite({ ...d, layers: d.layers.map((x, i) => i < idx ? x : { ...x, visible: false }) });
    app.renderer.invalidate();
  }
  const release = () => { hsSampleBelow = null; hsArmed = null; lvArmed = null; app.canvasHook = null; app.needsRender = true; };
  const changed = () => { filterToAdjustment(kind, settings, l.adjustment!); l.adjustment = { ...l.adjustment! }; app.needsRender = true; };
  const panel = floatingPanel(rec.kind, () => { release(); l.adjustment = before; app.history?.undoStack.pop(); app.changed('layers'); openPanel = null; }, { id: 'filter-panel' });
  const body = h('div');
  const rebuild = () => body.replaceChildren(controls(kind, settings, changed, rebuild, true));
  rebuild();
  panel.body.append(body, h('div', { class: 'panel-footer' }, h('span', { class: 'spacer' }),
    button('Cancel', () => { release(); l.adjustment = before; app.history?.undoStack.pop(); openPanel = null; panel.close(); app.changed('layers'); }),
    button('OK', () => { release(); openPanel = null; panel.close(); app.changed('layers'); }, { class: 'btn primary', id: 'filter-ok' })));
  openPanel = { panel, cancel: () => { release(); l.adjustment = before; } };
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
  const dim = (i: HTMLInputElement) => { const v = i.value.trim(); return /^\d+$/.test(v) && +v >= 1 && +v <= 30000 ? +v : null; };
  const valid = () => dim(w) !== null && dim(hh) !== null;
  for (const i of [w, hh]) {
    i.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') create(); });
    i.addEventListener('input', () => sync());
  }
  // The preset the fields match is shown (Custom otherwise); choosing one fills them in.
  const preset = select([{ label: 'Custom', value: 'Custom' }, ...PRESETS.map(p => p ? { label: `${p.title}  ·  ${p.width} × ${p.height}`, value: p.title } : null)], '1080p', v => {
    const p = PRESETS.find(x => x?.title === v); if (p) { w.value = String(p.width); hh.value = String(p.height); } sync();
  }, { id: 'new-preset' });
  const hint = h('p', { class: 'hint', id: 'new-hint' });
  const create = () => {
    if (!valid()) return;
    onCreate(dim(w)!, dim(hh)!);
  };
  const createBtn = button('Create canvas', create, { class: 'btn primary', id: 'create-canvas' });
  function sync() {
    const ok = valid();
    hint.textContent = ok ? 'Transparent canvas · sRGB' : 'Enter whole numbers from 1 to 30,000 pixels.';
    hint.classList.toggle('warn', !ok); createBtn.disabled = !ok;
    preset.value = PRESETS.find(p => p && String(p.width) === w.value.trim() && String(p.height) === hh.value.trim())?.title ?? 'Custom';
  }
  sync();
  // An image on the clipboard suggests its size (NewCanvasSheet.clipboardDimensions), when the page may already read it.
  void (async () => {
    try {
      const perm = await navigator.permissions?.query({ name: 'clipboard-read' as PermissionName });
      if (perm?.state !== 'granted' || !navigator.clipboard?.read) return;
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find(t => t.startsWith('image/')); if (!type) continue;
        const bmp = await createImageBitmap(await item.getType(type));
        if (bmp.width >= 1 && bmp.height >= 1 && bmp.width <= 30000 && bmp.height <= 30000 && w.value === '1920' && hh.value === '1080') {
          w.value = String(bmp.width); hh.value = String(bmp.height); sync();
        }
        bmp.close(); return;
      }
    } catch { /* no clipboard access: keep the default */ }
  })();
  return h('div', { class: 'new-canvas' }, h('h2', {}, 'New canvas'),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Size'), preset),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Width'), w, h('span', { class: 'unit' }, 'px')),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Height'), hh, h('span', { class: 'unit' }, 'px')),
    hint,
    h('div', { class: 'modal-buttons' }, extra ?? '', createBtn));
}
export function showNewCanvas() {
  let close = () => {};
  const form = newCanvasForm((w, hh) => { close(); app.newCanvas(w, hh); app.fit(); });
  close = modal('', form, [{ label: 'Cancel', onClick: () => {} }]);
}
const UNITS = ['Pixels', 'Percent', 'Inches', 'Centimeters'] as const;
type Unit = typeof UNITS[number];
/** ByteCountFormatter, memory style. */
function fmtBytes(n: number) {
  const u = ['bytes', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return i ? `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}` : `${n} bytes`;
}
const fmtNum = (v: number) => String(Math.round(v * 1000) / 1000);
/** CanvasSizeSheet: units, relative sizes, the aspect lock, the anchor and the extension color. */
export function showCanvasSize() {
  const d = app.doc; if (!d) return;
  const W0 = d.width, H0 = d.height, res = d.resolution || 72;
  // CanvasSizeDraft: pixels are kept; fields show them in the chosen unit, relative to the current size if asked.
  const dr = { width: W0, height: H0, relative: false, locked: false, unit: 'Pixels' as Unit };
  const shown = (wAxis: boolean) => {
    const o = wAxis ? W0 : H0, px = (wAxis ? dr.width : dr.height) - (dr.relative ? o : 0);
    return dr.unit === 'Percent' ? px / o * 100 : dr.unit === 'Inches' ? px / res : dr.unit === 'Centimeters' ? px / res * 2.54 : px;
  };
  const set = (v: number, wAxis: boolean) => {
    const o = wAxis ? W0 : H0;
    const px = dr.unit === 'Percent' ? v / 100 * o : dr.unit === 'Inches' ? v * res : dr.unit === 'Centimeters' ? v / 2.54 * res : v;
    const fin = px + (dr.relative ? o : 0);
    if (wAxis) { dr.width = fin; if (dr.locked) dr.height = fin * H0 / W0; } else { dr.height = fin; if (dr.locked) dr.width = fin * W0 / H0; }
  };
  const valid = () => isFinite(dr.width) && isFinite(dr.height) && Math.round(dr.width) >= 1 && Math.round(dr.width) <= 30000 && Math.round(dr.height) >= 1 && Math.round(dr.height) <= 30000;
  const w = h('input', { type: 'number', class: 'dim', id: 'canvas-width', step: 'any' }) as HTMLInputElement;
  const hh = h('input', { type: 'number', class: 'dim', id: 'canvas-height', step: 'any' }) as HTMLInputElement;
  const unitLbl = [h('span', { class: 'unit' }), h('span', { class: 'unit' })];
  const result = h('p', { class: 'hint', id: 'canvas-result' });
  const refresh = (skip?: HTMLInputElement) => {
    if (skip !== w) w.value = fmtNum(shown(true)); if (skip !== hh) hh.value = fmtNum(shown(false));
    unitLbl.forEach(u => { u.textContent = { Pixels: 'px', Percent: '%', Inches: 'in', Centimeters: 'cm' }[dr.unit]; });
    const ok = valid(); result.classList.toggle('warn', !ok);
    result.textContent = ok ? `New: ${Math.round(dr.width)} × ${Math.round(dr.height)} pixels · ${fmtBytes(Math.round(dr.width) * Math.round(dr.height) * 4)} uncompressed` : 'Final dimensions must be 1–30,000 pixels per side.';
  };
  w.addEventListener('input', () => { if (w.value !== '' && isFinite(+w.value)) { set(+w.value, true); refresh(w); } });
  hh.addEventListener('input', () => { if (hh.value !== '' && isFinite(+hh.value)) { set(+hh.value, false); refresh(hh); } });
  const ANCHORS = ['Top left', 'Top center', 'Top right', 'Middle left', 'Center', 'Middle right', 'Bottom left', 'Bottom center', 'Bottom right'];
  let anchor = 4;
  const grid = h('div', { class: 'anchor-grid' }), anchorName = h('div', { class: 'anchor-name' });
  const drawGrid = () => {
    grid.replaceChildren(...ANCHORS.map((n, i) => { const b = h('button', { class: `anchor${i === anchor ? ' on' : ''}`, title: n, 'aria-label': n, 'data-anchor': String(i) }); b.addEventListener('click', () => { anchor = i; drawGrid(); }); return b; }));
    anchorName.textContent = ANCHORS[anchor];
  };
  drawGrid();
  let ext = 'Transparent', custom = { red: 1, green: 1, blue: 1 };
  const customRow = h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Extension color'), colorWell(custom, c => { custom = c; }));
  customRow.style.display = 'none';
  refresh();
  modal('Canvas Size', h('div', { class: 'canvas-size' },
    h('p', {}, `Current: ${W0} × ${H0} pixels`), h('p', { class: 'hint' }, `${fmtBytes(W0 * H0 * 4)} uncompressed RGBA canvas`), h('hr'),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Units'), select([...UNITS], dr.unit, v => { dr.unit = v as Unit; refresh(); }, { id: 'canvas-units' })),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Width'), w, unitLbl[0]),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Height'), hh, unitLbl[1]),
    checkbox('Relative to current dimensions', false, v => { dr.relative = v; refresh(); }, 'canvas-relative'),
    checkbox('Lock original aspect ratio', false, v => { dr.locked = v; if (v) set(shown(true), true); refresh(); }, 'canvas-locked'),
    result,
    h('div', { class: 'row anchor-row' }, h('span', { class: 'lbl' }, 'Anchor'), grid,
      h('div', { class: 'anchor-note' }, anchorName, h('p', { class: 'hint' }, 'Keeps this point fixed. Artwork is not scaled; cropped content remains outside the canvas.'))),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Canvas extension'), select(['Transparent', 'Foreground', 'Background', 'Black', 'White', 'Custom'], ext, v => { ext = v; customRow.style.display = v === 'Custom' ? '' : 'none'; }, { id: 'canvas-extension' })),
    customRow),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'OK', primary: true, onClick: () => {
      if (!valid()) return false;
      const fill = ext === 'Transparent' ? null : ext === 'Foreground' ? app.fg : ext === 'Background' ? app.bg : ext === 'Black' ? { red: 0, green: 0, blue: 0 } : ext === 'White' ? { red: 1, green: 1, blue: 1 } : custom;
      app.canvasSize(Math.round(dr.width), Math.round(dr.height), (anchor % 3) / 2, Math.floor(anchor / 3) / 2, fill);
    } }], 'canvas-size-modal');
}
/** Image › Trim… (TrimSheet.swift): what to trim by, and which edges. */
export function showTrim() {
  if (!app.doc) return;
  const opts = { basedOn: 'Transparent Pixels' as 'Transparent Pixels' | 'Top Left Pixel Color' | 'Bottom Right Pixel Color', top: true, bottom: true, left: true, right: true };
  const radios = h('div', { class: 'trim-based-on' }, ...(['Transparent Pixels', 'Top Left Pixel Color', 'Bottom Right Pixel Color'] as const).map(v => {
    const r = h('input', { type: 'radio', name: 'trim-based-on', value: v, checked: v === opts.basedOn }) as HTMLInputElement;
    r.addEventListener('change', () => { if (r.checked) opts.basedOn = v; });
    return h('label', { class: 'check' }, r, v);
  }));
  const side = (k: 'top' | 'bottom' | 'left' | 'right', label: string) => checkbox(label, true, v => { opts[k] = v; }, `trim-${k}`);
  modal('Trim', h('div', {}, h('div', { class: 'group-title' }, 'Based On'), radios, h('div', { class: 'group-title' }, 'Trim Away'),
    h('div', { class: 'row' }, side('top', 'Top'), side('left', 'Left')), h('div', { class: 'row' }, side('bottom', 'Bottom'), side('right', 'Right'))),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'OK', primary: true, onClick: () => { if (!opts.top && !opts.bottom && !opts.left && !opts.right) return false; app.trim(opts); } }]);
}
/** ImageSizeSheet: units, the aspect lock, resolution, Resample (off: print size only) and Sampling. */
export function showImageSize() {
  const d = app.doc; if (!d) return;
  const W0 = d.width, H0 = d.height;
  const st = { width: W0, height: H0, resolution: d.resolution || 72, last: d.resolution || 72, locked: true, resample: true, unit: 'Pixels' as Unit, sampling: 'High quality' as 'High quality' | 'Smooth' | 'Nearest' };
  const valid = () => isFinite(st.width) && isFinite(st.height) && isFinite(st.resolution) && st.resolution >= 1 && st.resolution <= 9600
    && Math.round(st.width) >= 1 && Math.round(st.width) <= 30000 && Math.round(st.height) >= 1 && Math.round(st.height) <= 30000
    && (!st.resample || Math.round(st.width) * Math.round(st.height) <= 100_000_000);
  const display = (px: number, o: number) => st.unit === 'Percent' ? px / o * 100 : st.unit === 'Inches' ? px / st.resolution : st.unit === 'Centimeters' ? px / st.resolution * 2.54 : px;
  const setDim = (v: number, isW: boolean) => {
    if (!(isFinite(v) && v > 0)) return;
    if ((st.unit === 'Inches' || st.unit === 'Centimeters') && !(st.resolution > 0)) return;
    if (!st.resample) { st.resolution = (isW ? st.width : st.height) / v * (st.unit === 'Centimeters' ? 2.54 : 1); st.last = st.resolution; return; }
    const o = isW ? W0 : H0;
    const px = st.unit === 'Percent' ? v / 100 * o : st.unit === 'Inches' ? v * st.resolution : st.unit === 'Centimeters' ? v / 2.54 * st.resolution : v;
    if (isW) { if (st.locked) st.height = px * st.height / st.width; st.width = px; } else { if (st.locked) st.width = px * st.width / st.height; st.height = px; }
  };
  const w = h('input', { type: 'number', class: 'dim', id: 'image-width', step: 'any' }) as HTMLInputElement;
  const hh = h('input', { type: 'number', class: 'dim', id: 'image-height', step: 'any' }) as HTMLInputElement;
  const resIn = h('input', { type: 'number', class: 'dim', id: 'image-resolution', step: 'any' }) as HTMLInputElement;
  const unitSel = h('select', { id: 'image-units' }) as HTMLSelectElement;
  const lockBox = checkbox('Lock aspect ratio', true, v => { st.locked = v; }, 'image-lock');
  const samplingRow = h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Sampling'), select(['High quality', 'Smooth', 'Nearest'], st.sampling, v => { st.sampling = v as typeof st.sampling; }, { id: 'image-sampling' }));
  const note = h('p', { class: 'hint' }), result = h('p', { class: 'hint', id: 'image-result' });
  const refresh = (skip?: HTMLInputElement) => {
    const units = UNITS.filter(u => st.resample || (u !== 'Pixels' && u !== 'Percent'));
    if (unitSel.options.length !== units.length) unitSel.replaceChildren(...units.map(u => h('option', { value: u }, u)));
    unitSel.value = st.unit;
    if (skip !== w) w.value = fmtNum(display(st.width, W0)); if (skip !== hh) hh.value = fmtNum(display(st.height, H0)); if (skip !== resIn) resIn.value = fmtNum(st.resolution);
    (lockBox.querySelector('input') as HTMLInputElement).disabled = !st.resample; (lockBox.querySelector('input') as HTMLInputElement).checked = st.locked;
    samplingRow.style.display = st.resample ? '' : 'none';
    note.textContent = st.resample ? 'Resizes layer pixels and applies existing transforms. Undo restores the originals.' : 'Only print dimensions and resolution change. Pixels stay unchanged.';
    const ok = valid(); result.classList.toggle('warn', !ok);
    result.textContent = ok ? `Result: ${Math.round(st.width)} × ${Math.round(st.height)} pixels` : 'Use 1–30,000 pixels per side, up to 100 megapixels, and 1–9,600 pixels/inch.';
    const btn = document.querySelector('#image-size-modal .modal-buttons .primary') as HTMLButtonElement | null; if (btn) btn.disabled = !ok;
  };
  unitSel.addEventListener('change', () => { st.unit = unitSel.value as Unit; refresh(); });
  w.addEventListener('input', () => { if (w.value !== '') { setDim(+w.value, true); refresh(w); } });
  hh.addEventListener('input', () => { if (hh.value !== '') { setDim(+hh.value, false); refresh(hh); } });
  resIn.addEventListener('input', () => {
    const v = +resIn.value; st.resolution = v;
    if (isFinite(v) && v > 0) {
      if (st.resample && (st.unit === 'Inches' || st.unit === 'Centimeters')) { st.width *= v / st.last; st.height *= v / st.last; }
      st.last = v;
    }
    refresh(resIn);
  });
  const resampleBox = checkbox('Resample', true, v => {
    st.resample = v;
    if (!v) { st.width = W0; st.height = H0; st.locked = true; if (st.unit === 'Pixels' || st.unit === 'Percent') st.unit = 'Inches'; }
    refresh();
  }, 'image-resample');
  modal('Image Size', h('div', { class: 'image-size' },
    h('p', { class: 'hint' }, `Current: ${W0} × ${H0} pixels`),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Units'), unitSel),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Width'), w), h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Height'), hh),
    lockBox,
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Resolution'), resIn, h('span', { class: 'unit' }, 'pixels/inch')),
    resampleBox, samplingRow, note, result),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'Resize', primary: true, onClick: () => {
      if (!valid()) return false;
      app.imageSize(Math.round(st.width), Math.round(st.height), { resolution: st.resolution, sampling: st.sampling, resample: st.resample });
    } }], 'image-size-modal');
  refresh();
}
export function showSelectionAmount(op: 'expand' | 'contract' | 'feather') {
  const i = h('input', { type: 'number', value: op === 'feather' ? 10 : 5, min: 1, max: 500, class: 'dim' }) as HTMLInputElement;
  modal(`${op[0].toUpperCase()}${op.slice(1)} Selection`, h('div', { class: 'row' }, h('span', { class: 'lbl' }, op === 'feather' ? 'Radius' : 'By'), i, h('span', { class: 'unit' }, 'px')),
    [{ label: 'Cancel', onClick: () => {} }, { label: 'OK', primary: true, onClick: () => app.modifySelection(op, Math.max(1, +i.value)) }]);
}
/** JPEGExportSheet: the encoded JPEG itself as the preview (Fit, zoom steps, 100% shows every pixel and artifact),
 *  quality remembered from the last export, a background color for transparency, and the file's size. */
export function showExportJpeg() {
  const d = app.doc; if (!d) return;
  app.commitFloating();
  const QKEY = 'jpegExportQuality';
  const saved = Number(localStorage.getItem(QKEY));
  let q = Number.isFinite(saved) && localStorage.getItem(QKEY) !== null ? Math.min(100, Math.max(0, saved)) : 85;
  let matte: RGB = { red: 1, green: 1, blue: 1 };
  let zoom: number | null = null; // null fits; 1 is 100% (one JPEG pixel per screen pixel)
  const STEPS = [0.25, 0.5, 1, 2, 4, 8], FW = 560, FH = 330, dpr = window.devicePixelRatio || 1;
  const img = app.renderer.readComposite(d);
  const layer = canvasOf(d.width, d.height); ctx2d(layer).putImageData(img, 0, 0);
  const src = canvasOf(d.width, d.height), sx = ctx2d(src);
  const shown = h('canvas', { class: 'jpeg-image' }) as HTMLCanvasElement;
  shown.width = d.width; shown.height = d.height;
  const frame = h('div', { class: 'jpeg-frame', id: 'jpeg-frame', style: `width:${FW}px;height:${FH}px`, title: 'Drag or scroll to move around; double-click switches between Fit and 100%' }, shown);
  const busy = h('div', { class: 'jpeg-busy' }, 'Updating…');
  frame.append(busy);
  const status = h('span', { class: 'jpeg-size', id: 'jpeg-size' }, 'Updating…');
  let blob: Blob | null = null, token = 0, timer = 0;
  const fitZoom = () => Math.min(FW / (d.width / dpr), FH / (d.height / dpr));
  const shownZoom = () => zoom ?? fitZoom();
  const pct = h('span', { class: 'hint', id: 'jpeg-zoom' });
  const fitBtn = button('Fit', () => setZoom(null), { id: 'jpeg-fit' });
  const zin = button('+', () => stepZoom(1), { id: 'jpeg-zoom-in', title: 'Zoom in' }), zout = button('−', () => stepZoom(-1), { id: 'jpeg-zoom-out', title: 'Zoom out' });
  const next = (dir: number) => { const z = shownZoom(); return dir > 0 ? STEPS.find(s => s > z * 1.001) : [...STEPS].reverse().find(s => s < z * 0.999); };
  const stepZoom = (dir: number) => { const n = next(dir); if (n) setZoom(n); };
  function setZoom(z: number | null) {
    // Zooming keeps the middle of the view on the same part of the image.
    const before = shownZoom(), fx = (frame.scrollLeft + frame.clientWidth / 2) / Math.max(1, shown.clientWidth), fy = (frame.scrollTop + frame.clientHeight / 2) / Math.max(1, shown.clientHeight);
    zoom = z; layout();
    if (z !== null) { frame.scrollLeft = fx * shown.clientWidth - frame.clientWidth / 2; frame.scrollTop = fy * shown.clientHeight - frame.clientHeight / 2; }
    void before;
  }
  function layout() {
    const z = shownZoom(), w = d!.width / dpr * z, hh = d!.height / dpr * z;
    shown.style.width = `${w}px`; shown.style.height = `${hh}px`;
    shown.style.imageRendering = zoom !== null && z >= 1 ? 'pixelated' : 'auto';
    frame.classList.toggle('zoomed', zoom !== null);
    shown.style.margin = `${Math.max(0, (FH - hh) / 2)}px ${Math.max(0, (FW - w) / 2)}px`;
    fitBtn.disabled = zoom === null; zin.disabled = !next(1); zout.disabled = !next(-1);
    pct.textContent = `${Math.round(z * 100)}%`;
  }
  frame.addEventListener('dblclick', () => setZoom(zoom === null ? 1 : null));
  frame.addEventListener('pointerdown', e => {
    if (zoom === null) return;
    const x0 = e.clientX, y0 = e.clientY, l0 = frame.scrollLeft, t0 = frame.scrollTop; frame.setPointerCapture(e.pointerId); frame.classList.add('grabbing');
    const mv = (ev: PointerEvent) => { frame.scrollLeft = l0 - (ev.clientX - x0); frame.scrollTop = t0 - (ev.clientY - y0); };
    const up = () => { frame.removeEventListener('pointermove', mv); frame.removeEventListener('pointerup', up); frame.classList.remove('grabbing'); };
    frame.addEventListener('pointermove', mv); frame.addEventListener('pointerup', up);
  });
  const okRef: { b?: HTMLButtonElement } = {};
  const encode = () => {
    const my = ++token; blob = null; busy.style.display = ''; status.textContent = 'Updating…'; if (okRef.b) okRef.b.disabled = true;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      sx.fillStyle = toHex(matte); sx.fillRect(0, 0, d.width, d.height); sx.drawImage(layer, 0, 0);
      src.toBlob(b => {
        if (my !== token || !b) return;
        blob = b; status.textContent = b.size < 1024 * 1024 ? `${Math.max(1, Math.round(b.size / 1000))} KB` : `${(b.size / 1e6).toFixed(1)} MB`;
        createImageBitmap(b).then(bmp => { if (my !== token) return; ctx2d(shown).drawImage(bmp, 0, 0); busy.style.display = 'none'; if (okRef.b) okRef.b.disabled = false; });
      }, 'image/jpeg', q / 100);
    }, 200);
  };
  const matteWell = colorWell(matte, c => { matte = c; encode(); });
  const body = h('div', { class: 'jpeg-export' },
    h('div', { class: 'row jpeg-tools' }, pct, fitBtn, zin, zout),
    frame,
    slider({ label: 'Quality', min: 0, max: 100, value: q, unit: '%', id: 'jpeg-quality', onInput: v => { q = v; encode(); } }),
    h('div', { class: 'row' }, h('span', { class: 'lbl wide' }, 'Background for transparency'), matteWell),
    h('div', { class: 'row jpeg-info' }, h('span', { class: 'hint' }, `${d.width.toLocaleString()} × ${d.height.toLocaleString()} px · sRGB`), status));
  modal('Export JPEG', body, [{ label: 'Cancel', onClick: () => {} }, { label: 'Export…', primary: true, onClick: () => {
    if (!blob) return false;
    localStorage.setItem(QKEY, String(q));
    download(blob, `${d.name || 'Untitled'}.jpg`);
  } }], 'jpeg-modal');
  okRef.b = document.querySelector('#jpeg-modal .modal-buttons .btn.primary') as HTMLButtonElement;
  layout(); encode();
}
/** RawDevelopSheet: a RAW holds more range than a layer, so what to keep is chosen here. The preview develops a quick
 *  superpixel copy while the sliders move; Import develops the full frame once (demosaiced in wasm). */
export function showRawDevelop(name: string, raw: RawImage): Promise<HTMLCanvasElement | null> {
  return new Promise(resolve => {
    let st = asShotSettings(raw);
    const FW = 560, FH = 340;
    const prev = h('canvas', { class: 'raw-preview', id: 'raw-preview' }) as HTMLCanvasElement;
    const spin = h('div', { class: 'jpeg-busy', id: 'raw-busy' }, 'Developing…');
    const frame = h('div', { class: 'raw-frame', style: `width:${FW}px;height:${FH}px` }, prev, spin);
    let token = 0, timer = 0, first = true;
    const refresh = () => {
      const my = ++token; spin.style.display = '';
      clearTimeout(timer);
      // Just enough to coalesce a burst of slider changes.
      timer = window.setTimeout(async () => {
        const c = await developRaw(raw, st, 1000);
        if (my !== token) return;
        const k = Math.min(FW / c.width, FH / c.height);
        prev.width = Math.round(c.width * k * devicePixelRatio); prev.height = Math.round(c.height * k * devicePixelRatio);
        prev.style.width = `${Math.round(c.width * k)}px`; prev.style.height = `${Math.round(c.height * k)}px`;
        const x = ctx2d(prev); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, prev.width, prev.height);
        spin.style.display = 'none'; first = false;
      }, first ? 0 : 60);
    };
    const sliders = h('div', { class: 'controls' });
    const reset = button('Reset', () => { st = resetRaw(st); build(); refresh(); }, { id: 'raw-reset' });
    const build = () => {
      const sl = (label: string, key: 'exposure' | 'temperature' | 'tint' | 'boost', min: number, max: number, step: number, unit: string) =>
        slider({ label, min, max, step, unit, value: st[key], id: `raw-${key}`, width: 470, onInput: v => { st = { ...st, [key]: v }; reset.disabled = isAsShot(st); refresh(); } });
      sliders.replaceChildren(sl('Exposure', 'exposure', -3, 3, 0.01, 'EV'), sl('Temperature', 'temperature', 2000, 12000, 1, 'K'), sl('Tint', 'tint', -150, 150, 1, ''), sl('Boost', 'boost', 0, 1, 0.01, ''));
      reset.disabled = isAsShot(st);
    };
    build();
    const info = h('p', { class: 'hint' }, `${raw.width.toLocaleString()} × ${raw.height.toLocaleString()} sensor pixels · as shot ${st.asShotTemperature} K, tint ${st.asShotTint}`);
    let settled = false;
    const close = modal(`Develop “${name}”`, h('div', { class: 'raw-develop' }, frame, sliders, h('div', { class: 'row' }, reset, h('span', { style: 'flex:1' }), info)), [
      { label: 'Cancel', onClick: () => { if (!settled) { settled = true; token++; resolve(null); } } },
      { label: 'Import', primary: true, onClick: () => {
        if (settled) return;
        settled = true; token++;
        const busy = toastBusy('Developing the full frame…');
        developRaw(raw, st).then(c => { busy(); close(); resolve(c); }, e => { busy(); close(); toast(`Couldn’t develop ${name}: ${(e as Error).message}`, 'error'); resolve(null); });
        return false;
      } },
    ], 'raw-modal');
    refresh();
  });
}
function toastBusy(text: string) {
  const t = h('div', { class: 'toast info show', id: 'busy-toast' }, text); document.body.append(t);
  return () => t.remove();
}
setRawDevelopHook(showRawDevelop);

/** PSDConversionSheet: the Photoshop features an import converts, listed per layer before anything is applied. */
export function showPsdConversions(title: string, confirmTitle: string, conversions: PsdConversion[]): Promise<boolean> {
  return new Promise(resolve => {
    const list = h('div', { class: 'psd-conversions', id: 'psd-conversions' }, ...conversions.map(c =>
      h('div', { class: 'psd-conversion' }, h('div', { class: 'psd-layer' }, c.layerName), h('div', { class: 'psd-message' }, c.message))));
    const body = h('div', {}, h('p', { class: 'hint' }, 'Compositor will convert these Photoshop features. Nothing is applied until you continue.'), list);
    modal(title, body, [
      { label: 'Cancel', onClick: () => resolve(false) },
      { label: confirmTitle, primary: true, onClick: () => resolve(true) },
    ], 'psd-modal');
  });
}
app.confirmConversions = showPsdConversions;
/** KeyboardShortcutsSheet: click a shortcut, press its new chord; changes apply on Save. */
export function showShortcuts() {
  const draft: Record<string, Chord> = { ...shortcutOverrides() };
  let recording: string | null = null, search = '';
  const list = h('div', { class: 'shortcut-list editable', id: 'shortcut-list' });
  const problemEl = h('div', { class: 'shortcut-problem', id: 'shortcut-problem' });
  const searchEl = h('input', { type: 'search', placeholder: 'Search shortcuts', class: 'shortcut-search', id: 'shortcut-search' }) as HTMLInputElement;
  searchEl.addEventListener('input', () => { search = searchEl.value.trim().toLowerCase(); draw(); });
  const update = () => {
    const p = shortcutProblem(draft); problemEl.textContent = p ?? ''; problemEl.style.display = p ? '' : 'none';
    const save = document.getElementById('shortcuts-save') as HTMLButtonElement | null; if (save) save.disabled = !!recording || !!p;
  };
  const draw = () => {
    const rows: HTMLElement[] = [];
    for (const group of ['Menus', 'Canvas & Layers', 'Text Editing'] as const) {
      const defs = SHORTCUTS.filter(d => d.group === group && (!search || d.title.toLowerCase().includes(search)));
      if (!defs.length) continue;
      rows.push(h('div', { class: 'group-title' }, group));
      for (const d of defs) {
        const rec = h('button', { class: `shortcut-recorder${recording === d.id ? ' recording' : ''}${draft[d.id] ? ' changed' : ''}`, 'data-id': d.id,
          'aria-label': recording === d.id ? 'Press a shortcut' : chordLabel(chordFor(d, draft)) }, recording === d.id ? 'Press keys…' : chordLabel(chordFor(d, draft))) as HTMLButtonElement;
        rec.addEventListener('click', () => { recording = d.id; draw(); (list.querySelector('.shortcut-recorder.recording') as HTMLElement | null)?.focus(); });
        rec.addEventListener('keydown', e => {
          if (recording !== d.id) return;
          e.preventDefault(); e.stopPropagation();
          const c = chordOf(e); if (!c) return;
          if (same(c, d.original)) delete draft[d.id]; else draft[d.id] = c;
          recording = null; draw();
        });
        rows.push(h('div', { class: 'shortcut-row' }, h('span', {}, d.title), rec));
      }
    }
    list.replaceChildren(...rows);
    update();
  };
  const body = h('div', { class: 'shortcuts-editor' },
    h('p', { class: 'hint' }, 'Click a shortcut, then press its new key combination. Changes apply when you save.'), searchEl, list, problemEl,
    h('details', { class: 'shortcut-notes' }, h('summary', {}, 'Contextual keys & mouse gestures'),
      h('p', { class: 'hint' }, 'Text fields keep the browser’s standard editing keys. Numeric fields use Up/Down. Option (Alt) temporarily selects the eyedropper in painting tools. Shift constrains shapes and movement or adds to a selection; Option subtracts from selections or draws from the center. Option-drag duplicates layers; Option-click at a layer boundary toggles clipping. Command-click a thumbnail loads its selection. Control bypasses snapping. Modifier-and-mouse gestures are fixed.')));
  draw();
  const close = modal('Keyboard Shortcuts', body, [
    { label: 'Restore Defaults', onClick: () => { recording = null; for (const k of Object.keys(draft)) delete draft[k]; draw(); return false; } },
    { label: 'Cancel', onClick: () => {} },
    { label: 'Save', primary: true, onClick: () => { if (recording || shortcutProblem(draft)) return false; saveShortcuts(draft); toast('Keyboard shortcuts saved.'); } },
  ], 'shortcuts-modal');
  void close;
  // The modal's buttons: Save gets an id so it can be disabled while recording or on a conflict.
  const btns = document.querySelectorAll('#shortcuts-modal .modal-buttons button');
  (btns[2] as HTMLElement | undefined)?.setAttribute('id', 'shortcuts-save');
  (btns[0] as HTMLElement | undefined)?.classList.add('left');
  update();
}

// GridSettingsSheet.swift: the layout grid's spacing and subdivisions.
/** GridSettingsSheet: every change shows on the canvas at once; Cancel puts back what was there. */
export function showGridSettings() {
  const keys = ['gridSpacing', 'gridSubdivisions', 'gridPreset', 'gridCustom', 'gridStyle', 'gridOpacity', 'grid'] as const;
  const saved = Object.fromEntries(keys.map(k => [k, structuredClone(view[k])])) as Pick<typeof view, typeof keys[number]>;
  const st = { spacing: view.gridSpacing, subdivisions: view.gridSubdivisions, preset: view.gridPreset, custom: { ...view.gridCustom }, style: view.gridStyle, opacity: view.gridOpacity };
  const valid = () => st.spacing >= 2 && st.spacing <= 4096 && st.subdivisions >= 1 && st.subdivisions <= 64 && st.subdivisions <= st.spacing && Number.isInteger(st.spacing) && Number.isInteger(st.subdivisions);
  const hint = h('p', { class: 'hint', id: 'grid-hint' });
  const preview = () => {
    hint.textContent = valid() ? `A subdivision every ${+(st.spacing / st.subdivisions).toFixed(2)} pixels.`
      : 'Use gridlines every 2–4,096 pixels and 1–64 subdivisions, no more than the pixels between gridlines.';
    hint.classList.toggle('warn', !valid());
    if (!valid()) return;
    view.gridSpacing = st.spacing; view.gridSubdivisions = st.subdivisions; view.gridPreset = st.preset; view.gridCustom = { ...st.custom };
    view.gridStyle = st.style; view.gridOpacity = st.opacity; view.grid = true; app.needsRender = true;
  };
  const body = h('div', { class: 'grid-settings' });
  const build = () => {
    const presetSel = select(Object.keys(GRID_PRESETS), st.preset, v => { st.preset = v as GridPreset; preview(); build(); }, { id: 'grid-color' });
    const shown = GRID_PRESETS[st.preset] ? { red: GRID_PRESETS[st.preset]![0], green: GRID_PRESETS[st.preset]![1], blue: GRID_PRESETS[st.preset]![2] } : st.custom;
    // The swatch shows whichever color is in use; picking one there makes that the Custom color.
    const well = colorWell(shown, c => { st.custom = c; st.preset = 'Custom'; presetSel.value = 'Custom'; preview(); });
    (well as HTMLElement).title = 'Choose a custom grid color';
    const num = (id: string, v: number, min: number, max: number, set: (n: number) => void) => {
      const i = h('input', { type: 'number', value: v, min, max, class: 'dim', id }) as HTMLInputElement;
      i.addEventListener('input', () => { set(Math.round(+i.value)); preview(); });
      return i;
    };
    body.replaceChildren(
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Color'), presetSel, well),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Style'), select(Object.keys(GRID_STYLES), st.style, v => { st.style = v as GridStyle; preview(); }, { id: 'grid-style' })),
      slider({ label: 'Opacity', min: 1, max: 100, value: st.opacity, unit: '%', onInput: v => { st.opacity = Math.round(v); preview(); } }),
      h('hr'),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Gridline every'), num('grid-spacing', st.spacing, 2, 4096, n => { st.spacing = n; }), h('span', { class: 'unit' }, 'px')),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Subdivisions'), num('grid-subdivisions', st.subdivisions, 1, 64, n => { st.subdivisions = n; })),
      hint);
    preview();
  };
  build();
  const restore = () => { for (const k of keys) (view as unknown as Record<string, unknown>)[k] = structuredClone(saved[k]); app.needsRender = true; };
  modal('Grid Settings', body, [
    { label: 'Restore Defaults', onClick: () => { Object.assign(st, { spacing: GRID_DEFAULTS.gridSpacing, subdivisions: GRID_DEFAULTS.gridSubdivisions, preset: GRID_DEFAULTS.gridPreset,
      style: GRID_DEFAULTS.gridStyle, opacity: GRID_DEFAULTS.gridOpacity }); build(); return false; } },
    { label: 'Cancel', onClick: () => { restore(); } },
    { label: 'OK', primary: true, onClick: () => {
      if (!valid()) return false;
      restore();
      setView('gridSpacing', st.spacing); setView('gridSubdivisions', st.subdivisions); setView('gridPreset', st.preset); setView('gridCustom', { ...st.custom });
      setView('gridStyle', st.style); setView('gridOpacity', st.opacity); if (!view.grid) setView('grid', true);
    } }], 'grid-settings-modal');
  document.querySelector('#grid-settings-modal .modal-buttons button')?.classList.add('left');
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
// Select › Color Range (ColorRangeSelection.swift + ColorRangeSheet.swift): every pixel near the colors clicked on the
// canvas, anywhere in the image (all layers as shown). The selection updates live; OK keeps it as one undo step,
// Cancel puts back the one there was.
export function openColorRange() {
  closeOpenPanel();
  const d = app.doc; if (!d) return;
  const image = app.renderer.readComposite(d), original = d.selection;
  const st = { fuzziness: 40, invert: false, mode: 'Replace' as 'Replace' | 'Add' | 'Remove', include: [] as number[], exclude: [] as number[] };
  const PW = 292, PH = 200, k = Math.min(PW / d.width, PH / d.height);
  const pv = h('canvas', { width: Math.max(1, Math.round(d.width * k * 2)), height: Math.max(1, Math.round(d.height * k * 2)), id: 'color-range-preview',
    style: `width:${Math.round(d.width * k)}px;height:${Math.round(d.height * k)}px;background:#000;display:block;margin:0 auto;border:1px solid #ffffff33` }) as HTMLCanvasElement;
  const hint = h('p', { class: 'hint' });
  let mask: Uint8Array | null = null;
  const setSel = (c: HTMLCanvasElement | null) => { d.selection = c; d.selRev++; app.emit('selection'); };
  const update = () => {
    hint.textContent = st.include.length ? 'Shift-click adds a color, Option-click takes one away.' : 'Click the image to pick the color to select.';
    const px = ctx2d(pv); px.fillStyle = '#000'; px.fillRect(0, 0, pv.width, pv.height);
    if (!st.include.length) { mask = null; setSel(original); return; }
    mask = colorRangeMask(image, st.include, st.exclude, st.fuzziness, st.invert);
    const full = canvasOf(d.width, d.height), fx = ctx2d(full), img = fx.createImageData(d.width, d.height);
    for (let i = 0; i < mask.length; i++) { const v = mask[i]; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
    fx.putImageData(img, 0, 0); px.imageSmoothingQuality = 'medium'; px.drawImage(full, 0, 0, pv.width, pv.height);
    setSel(mask.some(v => v) ? Sel.maskBytesToCanvas(d, mask) : null);
  };
  // The straight color under the click, averaged over the 3 × 3 pixels around it.
  const colorAt = (dpt: [number, number]): number[] | null => {
    const x = Math.floor(dpt[0]), y = Math.floor(dpt[1]);
    if (x < 0 || y < 0 || x >= d.width || y >= d.height) return null;
    const sums = [0, 0, 0, 0];
    for (let j = y - 1; j <= y + 1; j++) for (let i = x - 1; i <= x + 1; i++) {
      if (i < 0 || j < 0 || i >= d.width || j >= d.height) continue;
      const o = (j * d.width + i) * 4, a = image.data[o + 3];
      for (let c = 0; c < 3; c++) sums[c] += image.data[o + c] * a / 255; sums[3] += a;
    }
    return sums[3] > 0 ? [0, 1, 2].map(c => Math.min(255, Math.round(sums[c] * 255 / sums[3]))) : null;
  };
  const prevHook = app.canvasHook;
  app.canvasHook = { cursor: 'crosshair', down: (dpt, e) => {
    const c = colorAt(dpt); if (!c) return;
    const mode = e.altKey ? 'Remove' : e.shiftKey ? 'Add' : st.mode;
    if (mode === 'Replace') { st.include = c; st.exclude = []; } else if (mode === 'Add') st.include = [...st.include, ...c]; else st.exclude = [...st.exclude, ...c];
    update();
  } };
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return; done = true;
    app.canvasHook = prevHook; openPanel = null;
    const result = d.selection;
    d.selection = original; d.selRev++;
    if (keep && st.include.length) { app.edit('Color Range'); d.selection = result; d.selRev++; }
    app.emit('selection');
  };
  const panel = floatingPanel('Color Range', () => finish(false), { width: 340, id: 'color-range-panel' });
  const modes = h('div', { class: 'row hs-samplers' });
  const drawModes = () => {
    modes.replaceChildren(...(['Replace', 'Add', 'Remove'] as const).map(m => button(m === 'Replace' ? '⊙ Pick' : m === 'Add' ? '⊕ Add' : '⊖ Remove', () => { st.mode = m; drawModes(); },
      { class: `btn small${st.mode === m ? ' on' : ''}`, id: `cr-range-${m.toLowerCase()}`, title: m === 'Replace' ? 'Click the image to select that color' : m === 'Add' ? 'Click the image to add that color to the selection' : 'Click the image to take that color out of the selection' })));
  };
  drawModes();
  const fz = slider({ label: 'Fuzziness', min: 0, max: 200, step: 1, value: st.fuzziness, onInput: v => { st.fuzziness = Math.round(v); update(); } });
  fz.title = 'How far a color may be from the picked ones and still be selected';
  const inv = checkbox('Invert', false, v => { st.invert = v; update(); }, 'color-range-invert');
  inv.title = 'Select everything except those colors, such as all but a green screen';
  const ok = button('OK', () => { finish(true); panel.close(); }, { class: 'btn primary', id: 'color-range-ok' });
  const cancel = button('Cancel', () => { finish(false); panel.close(); });
  panel.body.append(h('div', { class: 'controls' }, modes, pv, hint, fz, inv), h('div', { class: 'panel-footer' }, h('span', { class: 'spacer' }), cancel, ok));
  openPanel = { panel, cancel: () => finish(false) };
  update();
}

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
