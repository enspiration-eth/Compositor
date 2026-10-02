// Generates tests/fixtures/layers.psd with ag-psd: a background, a live type layer, Levels / Curves / Hue-Saturation
// adjustment layers, a layer with effects, a disabled unlinked mask, a clipped layer and a Multiply folder.
// Run: node tests/fixtures/make-psd.mjs
import { writePsdBuffer, initializeCanvas } from 'ag-psd';
import { writeFileSync } from 'node:fs';
initializeCanvas(() => { throw new Error('no canvas'); });
const W = 200, H = 120;
const img = (w, h, f) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b, a] = f(x, y); const i = (y * w + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; } return { width: w, height: h, data: d }; };
const psd = {
  width: W, height: H,
  imageData: img(W, H, () => [128, 128, 128, 255]),
  children: [
    { name: 'Background', left: 0, top: 0, right: W, bottom: H, imageData: img(W, H, x => [x, 100, 200 - x, 255]) },
    { name: 'Square', left: 20, top: 20, right: 60, bottom: 60, imageData: img(40, 40, () => [255, 200, 0, 255]),
      effects: { dropShadow: [{ enabled: true, size: { units: 'Pixels', value: 4 }, distance: { units: 'Pixels', value: 5 }, angle: 120, color: { r: 0, g: 0, b: 0 }, opacity: 0.6 }],
        stroke: [{ enabled: true, size: { units: 'Pixels', value: 2 }, position: 'outside', color: { r: 0, g: 0, b: 255 }, opacity: 1, fillType: 'color' }] } },
    { name: 'Clipped', left: 30, top: 30, right: 50, bottom: 50, clipping: true, imageData: img(20, 20, () => [0, 255, 0, 255]) },
    { name: 'Masked', left: 120, top: 20, right: 180, bottom: 80, imageData: img(60, 60, () => [255, 0, 255, 255]),
      mask: { left: 120, top: 20, right: 150, bottom: 80, defaultColor: 0, disabled: true, positionRelativeToLayer: true, imageData: img(30, 60, () => [255, 255, 255, 255]) } },
    { name: 'Title', left: 10, top: 80, right: 120, bottom: 110, imageData: img(110, 30, () => [0, 0, 0, 0]),
      text: { text: 'Hello PSD', transform: [1, 0, 0, 1, 12, 104], style: { font: { name: 'ArialMT' }, fontSize: 20, fillColor: { r: 255, g: 0, b: 0 } }, paragraphStyle: { justification: 'left' } } },
    { name: 'Badge', left: 140, top: 86, right: 190, bottom: 112, imageData: img(50, 26, () => [0, 160, 80, 255]),
      vectorFill: { type: 'color', color: { r: 0, g: 160, b: 80 } }, vectorStroke: { fillEnabled: true, strokeEnabled: false },
      vectorOrigination: { keyDescriptorList: [{ keyOriginType: 2, keyOriginResolution: 72,
        keyOriginShapeBoundingBox: { top: { units: 'Pixels', value: 86 }, left: { units: 'Pixels', value: 140 }, bottom: { units: 'Pixels', value: 112 }, right: { units: 'Pixels', value: 190 } },
        keyOriginRRectRadii: { topRight: { units: 'Pixels', value: 6 }, topLeft: { units: 'Pixels', value: 6 }, bottomLeft: { units: 'Pixels', value: 6 }, bottomRight: { units: 'Pixels', value: 6 } } }] },
      vectorMask: { paths: [{ open: false, operation: 'combine', fillRule: 'even-odd', knots: [
        { linked: true, points: [140, 86, 140, 86, 140, 86] }, { linked: true, points: [190, 86, 190, 86, 190, 86] },
        { linked: true, points: [190, 112, 190, 112, 190, 112] }, { linked: true, points: [140, 112, 140, 112, 140, 112] }] }] } },
    { name: 'Folder', blendMode: 'multiply', opened: true, children: [
      { name: 'Inside', left: 70, top: 60, right: 110, bottom: 100, imageData: img(40, 40, () => [200, 200, 255, 255]) },
    ] },
    { name: 'Levels 1', adjustment: { type: 'levels', rgb: { shadowInput: 20, highlightInput: 230, shadowOutput: 0, highlightOutput: 255, midtoneInput: 1.2 } } },
    { name: 'Curves 1', adjustment: { type: 'curves', rgb: [{ input: 0, output: 0 }, { input: 128, output: 150 }, { input: 255, output: 255 }] } },
    { name: 'Hue/Saturation 1', adjustment: { type: 'hue/saturation',
      master: { a: 0, b: 0, c: 0, d: 0, hue: 10, saturation: -20, lightness: 0 },
      reds: { a: 315, b: 345, c: 15, d: 45, hue: 0, saturation: 30, lightness: 0 },
      yellows: { a: 15, b: 45, c: 75, d: 105, hue: 0, saturation: 0, lightness: 0 }, greens: { a: 75, b: 105, c: 135, d: 165, hue: 0, saturation: 0, lightness: 0 },
      cyans: { a: 135, b: 165, c: 195, d: 225, hue: 0, saturation: 0, lightness: 0 }, blues: { a: 195, b: 225, c: 255, d: 285, hue: 0, saturation: 0, lightness: 0 },
      magentas: { a: 255, b: 285, c: 315, d: 345, hue: 0, saturation: 0, lightness: 0 } } },
    { name: 'Exposure 1', adjustment: { type: 'exposure', exposure: 1, offset: 0, gamma: 1 } },
  ],
};
const buf = writePsdBuffer(psd, { invalidateTextLayers: true });
writeFileSync(new URL('./layers.psd', import.meta.url), buf);
console.log('layers.psd', buf.length, 'bytes');
