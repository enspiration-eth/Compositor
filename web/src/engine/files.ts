import { isTiffName, tiffToCanvas } from './tiff';
import { limitCanvas } from './limits';
import { parseRaw, rawDevelopHook, DevelopCancelled } from './raw';
// File formats. A Photoshop.eth project (.comp) is a folder: manifest.json + images/<UUID>.png (+ <UUID>.mask.png),
// exactly as IO/ProjectStore.swift writes it. Browsers can't save a package folder, so the web app saves the same
// folder zipped (Name.comp.zip, which unzips to Name.comp for the Mac app) and opens either a zip or a picked
// .comp folder. Images open through the browser's own decoders; PSDs through ag-psd (the Mac app has its own
// Swift PSD reader, IO/PSD, which depends on Core Graphics).
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type { Layer as PsdLayer } from 'ag-psd'; // ag-psd itself loads with the first PSD (readPsdFile).
import { type Doc, type Guide, type Layer, type BlendMode, type TextStyle, type Effects, type ShapeStyle, BLEND_MODES, newDoc, newPixelLayer, uuid, fullTransform, maskPlacementOf, renderText, renderShape, cssFont, cssFamilyGuess, TEXT_PADDING } from './document';
import { canvasOf, ctx2d, type AdjustmentRecord, type HueSaturationSettings, type ColorRangeName, hueSatToMac, hueSatFromMac, newAdjustment, normalizeRange, identityRange } from './adjustments';

export interface ManifestLayer {
  id: string; name: string; isVisible: boolean; imageFile?: string; parentID?: string; isGroup?: boolean; opacity?: number; blendMode?: string;
  maskFile?: string; maskEnabled?: boolean; maskSourceID?: string; adjustment?: AdjustmentRecord; shape?: unknown; effects?: unknown; text?: unknown;
  maskPlacement?: ManifestLayer['transform']; maskLinked?: boolean;
  transform: { origin: [number, number]; size: [number, number]; rotation: number; flipX: boolean; flipY: boolean; sampling: string };
}
export interface Manifest {
  format: string; version: number; colorSpace: string; documentID: string; width: number; height: number; resolution?: number;
  activeLayerID?: string | null; layers: ManifestLayer[]; guides?: unknown[];
}

async function canvasToPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('PNG encode failed')), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
async function maskToPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  // 8-bit grayscale without alpha is what the manifest asks for; browsers encode RGBA, so make it opaque gray.
  // (The Mac reader converts any PNG it reads to gray.)
  const o = canvasOf(c.width, c.height), x = ctx2d(o);
  x.fillStyle = '#000'; x.fillRect(0, 0, o.width, o.height); x.drawImage(c, 0, 0);
  return canvasToPng(o);
}
export async function bytesToCanvas(bytes: Uint8Array | Blob, type = 'image/png'): Promise<HTMLCanvasElement> {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' } as ImageBitmapOptions);
  const c = canvasOf(bmp.width, bmp.height);
  ctx2d(c).drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}
async function svgToCanvas(file: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    const w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
    const c = canvasOf(w, h); ctx2d(c).drawImage(img, 0, 0, w, h); return c;
  } finally { URL.revokeObjectURL(url); }
}

export async function writeComp(doc: Doc): Promise<Uint8Array> { return zipSync(await writeCompFiles(doc), { level: 0 }); }
/** The project package's files ("Name.comp/manifest.json", "Name.comp/images/…"), as the Mac app lays them out. */
export async function writeCompFiles(doc: Doc): Promise<Record<string, Uint8Array>> {
  const folder = (doc.name.replace(/\.comp$/i, '') || 'Untitled') + '.comp';
  const files: Record<string, Uint8Array> = {};
  const layers: ManifestLayer[] = [];
  for (const l of doc.layers) {
    const t = l.transform;
    const rec: ManifestLayer = {
      id: l.id, name: l.name, isVisible: l.visible, isGroup: l.isGroup || undefined, parentID: l.parentId ?? undefined,
      opacity: l.opacity, blendMode: l.blend,
      transform: { origin: [t.x, t.y], size: [t.w, t.h], rotation: t.rotation, flipX: t.flipX, flipY: t.flipY, sampling: t.sampling },
    };
    if (l.canvas && !l.adjustment && !l.isGroup) {
      rec.imageFile = `${l.id}.png`;
      files[`${folder}/images/${l.id}.png`] = await canvasToPng(l.canvas);
    }
    if (l.mask) {
      rec.maskFile = `${l.id}.mask.png`; rec.maskEnabled = l.maskEnabled;
      const mp = maskPlacementOf(l) ?? (l.maskLinked === false ? l.transform : undefined);
      if (mp && maskPlacementOf(l)) rec.maskPlacement = { origin: [mp.x, mp.y], size: [mp.w, mp.h], rotation: mp.rotation, flipX: mp.flipX, flipY: mp.flipY, sampling: mp.sampling };
      if (l.maskLinked === false) rec.maskLinked = false;
      files[`${folder}/images/${l.id}.mask.png`] = await maskToPng(l.mask);
    }
    if (l.clipTo) rec.maskSourceID = l.clipTo;
    if (l.adjustment) rec.adjustment = l.adjustment.hsvSettings ? { ...l.adjustment, hsvSettings: hueSatToMac(l.adjustment.hsvSettings) as never } : l.adjustment;
    if (l.text) rec.text = l.text;
    if (l.shape) rec.shape = l.shape;
    if (l.effects && Object.keys(l.effects).length) rec.effects = l.effects;
    layers.push(rec);
  }
  const manifest: Manifest = { format: 'com.compositor.project', version: 11, colorSpace: 'sRGB', documentID: doc.id, width: doc.width,
    height: doc.height, resolution: doc.resolution, activeLayerID: doc.activeId, layers, ...(doc.guides.length ? { guides: doc.guides.map(g => ({ id: g.id, axis: g.axis, position: g.position })) } : {}) };
  files[`${folder}/manifest.json`] = strToU8(JSON.stringify(manifest, null, 2));
  return files;
}
/** Writes the package as a real folder into a directory the user picked (File System Access API), replacing an
 *  existing package of that name, so the Mac app can open it directly. Returns the folder's name. */
export async function writeCompToDirectory(doc: Doc, dir: FileSystemDirectoryHandle): Promise<string> {
  const files = await writeCompFiles(doc), folder = Object.keys(files)[0].split('/')[0];
  try { await dir.removeEntry(folder, { recursive: true }); } catch { /* not there yet */ }
  for (const [path, bytes] of Object.entries(files)) {
    const parts = path.split('/'); let d = dir;
    for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create: true });
    const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    await w.write(bytes as unknown as BufferSource); await w.close();
  }
  return folder;
}

/** Reads a project from a map of relative paths ("manifest.json", "images/X.png") to bytes. */
export async function readCompFiles(files: Map<string, Uint8Array>, name: string): Promise<Doc> {
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) throw new Error('This project has no manifest.json.');
  const m = JSON.parse(strFromU8(manifestBytes)) as Manifest;
  if (m.format !== 'com.compositor.project') throw new Error('Not a Photoshop.eth project.');
  if (!(m.version >= 1 && m.version <= 11)) throw new Error(`Unsupported project version ${m.version}.`);
  if (!(m.width >= 1 && m.height >= 1 && m.width <= 30000 && m.height <= 30000)) throw new Error('Invalid canvas size.');
  const doc = newDoc(m.width, m.height, name.replace(/\.comp(\.zip)?$/i, ''));
  doc.id = m.documentID ?? doc.id; doc.resolution = m.resolution ?? 72;
  doc.guides = (Array.isArray(m.guides) ? m.guides : []).slice(0, 1000).flatMap(g0 => {
    const g = g0 as Partial<Guide>;
    return (g.axis === 'horizontal' || g.axis === 'vertical') && Number.isFinite(g.position) ? [{ id: String(g.id ?? uuid()), axis: g.axis, position: Number(g.position) }] : [];
  });
  for (const r of m.layers) {
    const t = r.transform;
    const layer: Layer = {
      id: r.id, name: r.name, visible: r.isVisible !== false, opacity: r.opacity ?? 1,
      blend: (BLEND_MODES.includes(r.blendMode as BlendMode) ? r.blendMode : 'Normal') as BlendMode,
      parentId: r.parentID ?? null, isGroup: !!r.isGroup, canvas: null,
      transform: { x: t.origin[0], y: t.origin[1], w: t.size[0], h: t.size[1], rotation: t.rotation ?? 0, flipX: !!t.flipX, flipY: !!t.flipY,
        sampling: (t.sampling as 'High quality') ?? 'High quality' },
      mask: null, maskEnabled: r.maskEnabled ?? true, clipTo: r.maskSourceID ?? null, rev: 1,
      adjustment: r.adjustment && (r.adjustment.hsvSettings ? { ...r.adjustment, hsvSettings: hueSatFromMac(r.adjustment.hsvSettings) } : r.adjustment), text: r.text as Layer['text'], shape: r.shape as Layer['shape'], effects: r.effects as Layer['effects'],
    };
    if (r.imageFile) {
      const bytes = files.get(`images/${r.imageFile}`);
      if (!bytes) throw new Error(`Missing image ${r.imageFile}.`);
      layer.canvas = await bytesToCanvas(bytes);
    } else if (!r.isGroup && !r.adjustment) {
      layer.canvas = canvasOf(Math.max(1, Math.round(t.size[0])), Math.max(1, Math.round(t.size[1])));
    }
    if (r.maskFile) {
      const bytes = files.get(`images/${r.maskFile}`);
      if (bytes) {
        const mc = await bytesToCanvas(bytes);
        // A mask has the layer's pixel size; a 1×1 uniform mask is stretched to it.
        const pw = layer.canvas?.width ?? Math.round(t.size[0]), ph = layer.canvas?.height ?? Math.round(t.size[1]);
        const mp = r.maskPlacement;
        if (mp && Array.isArray(mp.origin) && Array.isArray(mp.size) && mp.size[0] > 0 && mp.size[1] > 0) {
          layer.maskPlacement = { x: mp.origin[0], y: mp.origin[1], w: mp.size[0], h: mp.size[1], rotation: mp.rotation ?? 0, flipX: !!mp.flipX, flipY: !!mp.flipY, sampling: (mp.sampling as 'High quality') ?? 'High quality' };
          layer.mask = mc;
        } else if (mc.width !== pw || mc.height !== ph) { const s = canvasOf(pw, ph); ctx2d(s).drawImage(mc, 0, 0, pw, ph); layer.mask = s; } else layer.mask = mc;
      }
    }
    if (r.maskLinked === false && layer.mask) { layer.maskLinked = false; layer.maskPlacement ??= { ...layer.transform }; }
    else if (layer.maskPlacement) layer.maskBase = { ...layer.transform };
    doc.layers.push(layer);
  }
  doc.activeId = m.activeLayerID && doc.layers.some(l => l.id === m.activeLayerID) ? m.activeLayerID : doc.layers[doc.layers.length - 1]?.id ?? null;
  doc.selectedIds = doc.activeId ? [doc.activeId] : [];
  return doc;
}
export async function readCompZip(bytes: Uint8Array, name: string): Promise<Doc> {
  const entries = unzipSync(bytes);
  const files = new Map<string, Uint8Array>();
  // Accept the package at the zip root or inside one top-level folder (Name.comp/...).
  const manifestPath = Object.keys(entries).find(k => k.endsWith('manifest.json') && !k.includes('__MACOSX'));
  if (!manifestPath) throw new Error('No manifest.json in this archive.');
  const prefix = manifestPath.slice(0, -'manifest.json'.length);
  for (const [k, v] of Object.entries(entries)) if (k.startsWith(prefix)) files.set(k.slice(prefix.length), v);
  return readCompFiles(files, name);
}
/** A .comp folder picked with <input webkitdirectory>. */
export async function readCompFolder(list: FileList): Promise<Doc> {
  const files = new Map<string, Uint8Array>();
  let root = '';
  for (const f of Array.from(list)) {
    const rel = (f as File & { webkitRelativePath: string }).webkitRelativePath || f.name;
    if (rel.endsWith('/manifest.json') || rel === 'manifest.json') root = rel.slice(0, -'manifest.json'.length);
  }
  for (const f of Array.from(list)) {
    const rel = (f as File & { webkitRelativePath: string }).webkitRelativePath || f.name;
    if (rel.startsWith(root)) files.set(rel.slice(root.length), new Uint8Array(await f.arrayBuffer()));
  }
  const name = root.replace(/\/$/, '').split('/').pop() || 'Project';
  return readCompFiles(files, name);
}

const PSD_BLEND: Record<string, BlendMode> = {
  'normal': 'Normal', 'darken': 'Darken', 'multiply': 'Multiply', 'color burn': 'Color Burn', 'linear burn': 'Linear Burn', 'lighten': 'Lighten',
  'screen': 'Screen', 'color dodge': 'Color Dodge', 'linear dodge': 'Linear Dodge (Add)', 'overlay': 'Overlay', 'soft light': 'Soft Light',
  'hard light': 'Hard Light', 'vivid light': 'Vivid Light', 'linear light': 'Linear Light', 'pin light': 'Pin Light', 'hard mix': 'Hard Mix',
  'difference': 'Difference', 'exclusion': 'Exclusion', 'subtract': 'Subtract', 'divide': 'Divide', 'hue': 'Hue', 'saturation': 'Saturation',
  'color': 'Color', 'luminosity': 'Luminosity',
};
/** PSDConversion: what an import had to change, shown before the document opens (PSDConversionSheet). */
export interface PsdConversion { layerName: string; message: string }
const PSD_TEXT_NOTES = {
  rasterized: 'Editable Photoshop text becomes pixels and can’t be retyped.',
  firstStyle: 'Only the first text style was kept.',
  warp: 'The Photoshop text warp was omitted.',
  faux: 'Faux bold or faux italic was omitted.',
  justify: 'Full justification was imported as left alignment.',
};
type PsdColor = { r?: number; g?: number; b?: number; fr?: number; fg?: number; fb?: number; k?: number } | undefined;
const psdRGB = (c: PsdColor, fb = { red: 0, green: 0, blue: 0 }) => {
  if (!c) return fb;
  if (c.fr !== undefined) return { red: Math.min(1, Math.max(0, c.fr)), green: Math.min(1, Math.max(0, c.fg ?? 0)), blue: Math.min(1, Math.max(0, c.fb ?? 0)) };
  if (c.r !== undefined) return { red: Math.min(255, Math.max(0, c.r)) / 255, green: Math.min(255, Math.max(0, c.g ?? 0)) / 255, blue: Math.min(255, Math.max(0, c.b ?? 0)) / 255 };
  return fb;
};
/** A font the browser can't draw falls back silently; measuring against two generic families tells. */
function fontAvailable(name: string): boolean {
  const x = ctx2d(canvasOf(4, 4)), sample = 'mmmmmmmmmmlli10WQ@';
  return (['monospace', 'serif'] as const).some(g => { x.font = `40px ${g}`; const a = x.measureText(sample).width; x.font = `40px "${name}", "${cssFamilyGuess(name)}", ${g}`; return x.measureText(sample).width !== a; });
}
/** PSDText.placement: uniform scale, rotation and an optional vertical flip; shear or uneven scale returns null. */
function psdTextPlacement(m: number[]) {
  const [xx, xy, yx, yy, tx, ty] = m;
  if (![xx, xy, yx, yy, tx, ty].every(Number.isFinite)) return null;
  const scaleX = Math.hypot(xx, yx); if (scaleX <= 1e-6) return null;
  const cosR = xx / scaleX, sinR = yx / scaleX;
  const localX = cosR * xy + sinR * yy, localY = -sinR * xy + cosR * yy, scaleY = Math.abs(localY);
  if (scaleY <= 1e-6) return null;
  const largest = Math.max(scaleX, scaleY);
  if (Math.abs(localX) > 0.02 * largest || Math.abs(scaleX - scaleY) > 0.02 * largest) return null;
  const ySign = localY < 0 ? -1 : 1, k = scaleX;
  const map = (x: number, y: number): [number, number] => [cosR * k * x - sinR * k * ySign * y + tx, sinR * k * x + cosR * k * ySign * y + ty];
  return { scale: k, rotation: Math.atan2(sinR, cosR) * 180 / Math.PI, flipY: localY < 0, tx, ty, map };
}
/** PSDText.parse + render: a type layer as live text, placed so its anchor lands where Photoshop put it. */
function psdTextLayer(doc: Doc, pl: PsdLayer, notes: string[]): Layer | null {
  const td = pl.text; if (!td?.text) return null;
  if (td.orientation === 'vertical') return null;
  const placed = psdTextPlacement(td.transform ?? [1, 0, 0, 1, pl.left ?? 0, pl.top ?? 0]); if (!placed) return null;
  if (td.warp?.style && td.warp.style !== 'none') notes.push(PSD_TEXT_NOTES.warp);
  const content = td.text.replace(/^[\ufeff\0]+|\0+$/g, '').replace(/\r\n?/g, '\n');
  if (!content || content.length > 100000) return null;
  const runs = td.styleRuns?.length ? td.styleRuns : [{ length: content.length, style: td.style ?? {} }];
  const first = { ...td.style, ...runs[0].style };
  const points = first.fontSize ?? 12; if (!(points > 0)) return null;
  const fontSize = Math.min(2000, Math.max(1, points * placed.scale));
  const rgb = psdRGB(first.fillColor as PsdColor);
  const t: TextStyle = { content, fontName: first.font?.name || 'Helvetica', fontSize, ...rgb, alignment: 'Left',
    tracking: Math.min(1000, Math.max(-100, (first.tracking ?? 0) * fontSize / 1000)),
    leading: first.autoLeading === false && (first.leading ?? 0) > 0 ? Math.min(5000, (first.leading ?? 0) * placed.scale) : 0 };
  if (first.fauxBold || first.fauxItalic) notes.push(PSD_TEXT_NOTES.faux);
  // Runs differing only in color or face become the layer's color and font runs; anything else keeps the first style.
  const colorRuns: NonNullable<TextStyle['colorRuns']> = [], fontRuns: NonNullable<TextStyle['fontRuns']> = [];
  let pos = 0, otherDiff = false;
  for (const r of runs) {
    const st = { ...td.style, ...r.style }, len = Math.max(0, Math.min(r.length, content.length - pos));
    const c = psdRGB(st.fillColor as PsdColor, rgb), f = st.font?.name || t.fontName;
    if (len && (c.red !== t.red || c.green !== t.green || c.blue !== t.blue)) colorRuns.push({ location: pos, length: len, ...c });
    if (len && f !== t.fontName) fontRuns.push({ location: pos, length: len, fontName: f });
    if ((st.fontSize ?? points) !== points || (st.tracking ?? 0) !== (first.tracking ?? 0) || !!st.fauxBold !== !!first.fauxBold || !!st.fauxItalic !== !!first.fauxItalic
      || (st.leading ?? 0) !== (first.leading ?? 0) || (st.horizontalScale ?? 1) !== (first.horizontalScale ?? 1)) otherDiff = true;
    pos += len;
  }
  if (colorRuns.length) t.colorRuns = colorRuns;
  if (fontRuns.length) t.fontRuns = fontRuns;
  if (otherDiff) notes.push(PSD_TEXT_NOTES.firstStyle);
  const just = td.paragraphStyle?.justification ?? td.paragraphStyleRuns?.[0]?.style?.justification ?? 'left';
  if (just === 'right') t.alignment = 'Right'; else if (just === 'center') t.alignment = 'Center';
  else if (just !== 'left') notes.push(PSD_TEXT_NOTES.justify);
  for (const name of new Set([t.fontName, ...fontRuns.map(r => r.fontName)]))
    if (!fontAvailable(name)) notes.push(`The font “${name}” isn’t installed, so the text was drawn with the system font.`);
  let anchorDoc: [number, number] = [placed.tx, placed.ty], frame = false;
  const bb = td.boxBounds;
  if (td.shapeType === 'box' && bb && bb.length >= 4 && bb[2] - bb[0] > 1 && bb[3] - bb[1] > 1) {
    t.boxSize = { width: (bb[2] - bb[0]) * placed.scale + TEXT_PADDING * 2, height: (bb[3] - bb[1]) * placed.scale + TEXT_PADDING * 2 };
    anchorDoc = placed.map(bb[0], bb[1]); frame = true;
  }
  const canvas = renderText(t);
  const w = canvas.width, h = canvas.height;
  let ax = TEXT_PADDING, ay = TEXT_PADDING;
  if (!frame) {
    const meas = ctx2d(canvasOf(4, 4)); meas.font = cssFont(t);
    const m = meas.measureText(content.split('\n')[0] || 'H');
    const asc = m.emHeightAscent ?? m.fontBoundingBoxAscent ?? fontSize * 0.8, desc = m.emHeightDescent ?? m.fontBoundingBoxDescent ?? fontSize * 0.2;
    const lh = t.leading > 0 ? t.leading : fontSize * 1.2;
    ay = TEXT_PADDING + lh / 2 + (asc - desc) / 2;
    ax = t.alignment === 'Center' ? w / 2 : t.alignment === 'Right' ? w - TEXT_PADDING : TEXT_PADDING;
  }
  // PSDText.layerTransform: flip, then rotate about the center, so the image anchor lands on the document anchor.
  let lx = ax - w / 2, ly = ay - h / 2; if (placed.flipY) ly = -ly;
  const r = placed.rotation * Math.PI / 180;
  const cx = anchorDoc[0] - (lx * Math.cos(r) - ly * Math.sin(r)), cy = anchorDoc[1] - (lx * Math.sin(r) + ly * Math.cos(r));
  const l = newPixelLayer(doc, pl.name ?? 'Text', canvas, { x: cx - w / 2, y: cy - h / 2, w, h, rotation: placed.rotation, flipY: placed.flipY });
  l.text = t;
  return l;
}
/** PSDVector.live: a rectangle, rounded rectangle or ellipse filled with a solid color becomes a live shape layer. */
function psdShapeLayer(doc: Doc, pl: PsdLayer, notes: string[]): Layer | null {
  const fill = pl.vectorFill, stroke = pl.vectorStroke;
  if (!fill || fill.type !== 'color' || stroke?.fillEnabled === false) return null;
  const keys = pl.vectorOrigination?.keyDescriptorList ?? [];
  if (keys.length !== 1) return null;
  const k = keys[0], type = k.keyOriginType;
  if (type !== 1 && type !== 2 && type !== 5) return null;
  const bb = k.keyOriginShapeBoundingBox; if (!bb) return null;
  const x0 = bb.left.value, y0 = bb.top.value, x1 = bb.right.value, y1 = bb.bottom.value;
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 - x0 < 1 || y1 - y0 < 1) return null;
  let cornerRadius = 0;
  if (type !== 5 && k.keyOriginRRectRadii) {
    const r = k.keyOriginRRectRadii, radii = [r.topLeft, r.topRight, r.bottomRight, r.bottomLeft].map(v => v?.value ?? 0);
    if (Math.max(...radii) - Math.min(...radii) > 0.5) return null;
    cornerRadius = Math.max(...radii);
  }
  const x = Math.floor(x0), y = Math.floor(y0), w = Math.max(1, Math.ceil(x1) - x), h = Math.max(1, Math.ceil(y1) - y);
  const style: ShapeStyle = { kind: type === 5 ? 'Ellipse' : 'Rectangle', ...psdRGB(fill.color as PsdColor), cornerRadius };
  if (stroke?.strokeEnabled) notes.push('The Photoshop stroke isn’t supported on shape layers and was omitted.');
  const l = newPixelLayer(doc, pl.name ?? 'Shape', renderShape(style, w, h), { x, y, w, h });
  l.shape = style;
  return l;
}
/** PSDAdjustments.parse: Levels, Curves and Hue/Saturation become adjustment layers. */
function psdAdjustment(a: NonNullable<PsdLayer['adjustment']>): AdjustmentRecord | null {
  if (a.type === 'levels') {
    const rec = newAdjustment('Levels');
    const chans = [a.rgb, a.red, a.green, a.blue];
    rec.levels.ranges = chans.map(c => c ? normalizeRange({ black: c.shadowInput, white: c.highlightInput, outputBlack: c.shadowOutput, outputWhite: c.highlightOutput, gamma: c.midtoneInput }) : identityRange());
    return rec;
  }
  if (a.type === 'curves') {
    const rec = newAdjustment('Curves');
    [a.rgb, a.red, a.green, a.blue].forEach((c, i) => {
      if (!c || c.length < 2) return;
      const pts = c.map(p => ({ x: Math.min(255, Math.max(0, p.input)), y: Math.min(255, Math.max(0, p.output)) })).sort((p, q) => p.x - q.x);
      if (pts[0].x !== 0) pts.unshift({ x: 0, y: pts[0].y });
      if (pts[pts.length - 1].x !== 255) pts.push({ x: 255, y: pts[pts.length - 1].y });
      rec.curves.channels[i] = pts;
    });
    return rec;
  }
  if (a.type === 'hue/saturation' && a.master) {
    const rec = newAdjustment('Hue/Saturation');
    // ag-psd reads 'hue2' as seven 14-byte records; the first one's fields are Colorize (high byte of a), its hue,
    // saturation and lightness (b, c, d), then the Master's.
    const colorize = (a.master.a >> 8 & 0xff) !== 0;
    const hs: HueSaturationSettings = { range: 'Master', colorize, adjustments: {} };
    hs.adjustments.Master = colorize ? { hue: a.master.b, saturation: a.master.c, lightness: a.master.d } : { hue: a.master.hue, saturation: a.master.saturation, lightness: a.master.lightness };
    if (!colorize) {
      const names: [ColorRangeName, keyof typeof a][] = [['Reds', 'reds'], ['Yellows', 'yellows'], ['Greens', 'greens'], ['Cyans', 'cyans'], ['Blues', 'blues'], ['Magentas', 'magentas']];
      hs.bands = {};
      for (const [name, key] of names) {
        const c = a[key] as { a: number; b: number; c: number; d: number; hue: number; saturation: number; lightness: number } | undefined; if (!c) continue;
        const deg = (v: number) => ((v % 360) + 360) % 360;
        hs.bands[name] = [deg(c.a), deg(c.b), deg(c.c), deg(c.d)];
        if (c.hue || c.saturation || c.lightness) hs.adjustments[name] = { hue: c.hue, saturation: c.saturation, lightness: c.lightness };
      }
    }
    rec.hsvSettings = hs;
    rec.hue = hs.adjustments.Master!.hue; rec.saturation = hs.adjustments.Master!.saturation; rec.lightness = hs.adjustments.Master!.lightness; rec.colorize = colorize;
    return rec;
  }
  return null;
}
/** Photoshop layer effects the editor draws (one of each); the rest are reported. */
function psdEffects(fx: NonNullable<PsdLayer['effects']>, notes: string[]): Effects | undefined {
  if (fx.disabled) { notes.push('Layer effects were turned off in Photoshop and were discarded.'); return undefined; }
  const px = (v?: { value: number; units: string }) => Math.max(0, Math.min(250, v?.value ?? 0));
  const e: Effects = {}; const dropped: string[] = [];
  const sh = fx.dropShadow?.filter(x => x.enabled !== false) ?? [];
  if (sh[0]) e.shadow = { angle: sh[0].angle ?? 120, distance: px(sh[0].distance), blur: px(sh[0].size), ...psdRGB(sh[0].color as PsdColor), opacity: sh[0].opacity ?? 0.75 };
  const ish = fx.innerShadow?.filter(x => x.enabled !== false) ?? [];
  if (ish[0]) e.innerShadow = { angle: ish[0].angle ?? 120, distance: px(ish[0].distance), blur: px(ish[0].size), ...psdRGB(ish[0].color as PsdColor), opacity: ish[0].opacity ?? 0.75 };
  const st = fx.stroke?.filter(x => x.enabled !== false) ?? [];
  if (st[0]) {
    if (st[0].fillType && st[0].fillType !== 'color') dropped.push('a gradient or pattern stroke');
    else e.stroke = { size: px(st[0].size), ...psdRGB(st[0].color as PsdColor), opacity: st[0].opacity ?? 1, inside: st[0].position === 'inside' };
    if (st[0].position === 'center') notes.push('A centered stroke was imported as an outside stroke.');
  }
  const fill = fx.solidFill?.filter(x => x.enabled !== false) ?? [];
  if (fill[0]) e.colorOverlay = { ...psdRGB(fill[0].color as PsdColor), opacity: fill[0].opacity ?? 1 };
  if (fx.outerGlow && fx.outerGlow.enabled !== false) e.outerGlow = { size: px(fx.outerGlow.size), ...psdRGB(fx.outerGlow.color as PsdColor, { red: 1, green: 1, blue: 0.75 }), opacity: fx.outerGlow.opacity ?? 0.75 };
  if (fx.innerGlow && fx.innerGlow.enabled !== false) e.innerGlow = { size: px(fx.innerGlow.size), ...psdRGB(fx.innerGlow.color as PsdColor, { red: 1, green: 1, blue: 0.75 }), opacity: fx.innerGlow.opacity ?? 0.75 };
  if (sh.length > 1 || ish.length > 1 || st.length > 1 || fill.length > 1) dropped.push('repeated effects beyond the first');
  if (fx.bevel?.enabled !== undefined ? fx.bevel.enabled : fx.bevel) dropped.push('Bevel & Emboss');
  if (fx.satin && fx.satin.enabled !== false) dropped.push('Satin');
  if (fx.gradientOverlay?.some(x => x.enabled !== false)) dropped.push('Gradient Overlay');
  if (fx.patternOverlay && fx.patternOverlay.enabled !== false) dropped.push('Pattern Overlay');
  if (dropped.length) notes.push(`Some layer effects were discarded (${dropped.join(', ')}), so the appearance may differ.`);
  return Object.keys(e).length ? e : undefined;
}
export async function readPsdFile(bytes: ArrayBuffer, name: string): Promise<{ doc: Doc; conversions: PsdConversion[] }> {
  const { readPsd } = await import('ag-psd');
  const psd = readPsd(bytes, { skipThumbnail: true });
  const doc = newDoc(psd.width, psd.height, name.replace(/\.ps[db]$/i, ''));
  const conversions: PsdConversion[] = [];
  const walk = (children: PsdLayer[] | undefined, parent: string | null) => {
    for (const pl of children ?? []) {
      const lname = pl.name ?? 'Layer', notes: string[] = [];
      const blend = PSD_BLEND[pl.blendMode ?? 'normal'];
      if (pl.children) {
        if (pl.blendMode && pl.blendMode !== 'pass through' && pl.blendMode !== 'normal')
          notes.push(`Folder blend mode “${pl.blendMode}” isn’t supported. The folder will be pass-through.`);
        notes.forEach(message => conversions.push({ layerName: lname, message }));
        const g: Layer = { id: uuid(), name: pl.name ?? 'Folder', visible: !pl.hidden, opacity: pl.opacity ?? 1, blend: 'Normal', parentId: parent, isGroup: true,
          canvas: null, transform: fullTransform(doc), mask: null, maskEnabled: true, clipTo: null, rev: 1, collapsed: pl.opened === false };
        doc.layers.push(g);
        walk(pl.children, g.id);
        continue;
      }
      if (!blend && pl.blendMode && pl.blendMode !== 'pass through') notes.push(`Blend mode “${pl.blendMode}” isn’t supported and will be applied as Normal.`);
      let l: Layer | null = null;
      if (pl.adjustment) {
        const rec = psdAdjustment(pl.adjustment);
        if (!rec) { notes.push('This adjustment type isn’t supported and was skipped.'); notes.forEach(message => conversions.push({ layerName: lname, message })); continue; }
        notes.push('Adjustment parameters may not match Photoshop exactly.');
        l = { id: uuid(), name: lname, visible: !pl.hidden, opacity: pl.opacity ?? 1, blend: blend ?? 'Normal', parentId: parent, isGroup: false, canvas: null,
          transform: fullTransform(doc), mask: null, maskEnabled: true, clipTo: null, rev: 1, adjustment: rec };
      } else if (pl.text) {
        l = psdTextLayer(doc, pl, notes);
        if (!l) notes.push(PSD_TEXT_NOTES.rasterized);
      }
      else if (pl.vectorOrigination || pl.vectorFill) l = psdShapeLayer(doc, pl, notes);
      if (pl.placedLayer) notes.push('The smart object was rasterized. Linked contents can’t be edited.');
      if (!l && (pl.vectorMask || pl.vectorFill)) notes.push('Vector shape was rasterized to pixels.');
      const c = pl.canvas as HTMLCanvasElement | undefined;
      if (!l) {
        const w = Math.max(1, (pl.right ?? 0) - (pl.left ?? 0)), h = Math.max(1, (pl.bottom ?? 0) - (pl.top ?? 0));
        const canvas = c ?? canvasOf(w, h);
        l = newPixelLayer(doc, lname, canvas, { x: pl.left ?? 0, y: pl.top ?? 0, w: canvas.width, h: canvas.height });
      }
      l.visible = !pl.hidden; l.opacity = pl.opacity ?? 1; l.blend = blend ?? 'Normal'; l.parentId = parent;
      if (pl.effects && !l.adjustment) l.effects = psdEffects(pl.effects, notes);
      if (pl.clipping) {
        const base = [...doc.layers].reverse().find(x => x.parentId === parent && !x.clipTo);
        if (base && !base.isGroup && !base.adjustment && !l.adjustment) l.clipTo = base.id;
        else notes.push('This clipping mask’s base isn’t supported, so clipping was skipped.');
      }
      if (pl.mask?.canvas && l.canvas && !l.text && !l.shape) {
        // PSD masks have their own bounds; redraw them onto the layer's pixel grid (outside = default color).
        const mk = canvasOf(l.canvas.width, l.canvas.height), mx = ctx2d(mk);
        const dc = pl.mask.defaultColor ?? 255;
        mx.fillStyle = `rgb(${dc},${dc},${dc})`; mx.fillRect(0, 0, mk.width, mk.height);
        mx.drawImage(pl.mask.canvas as HTMLCanvasElement, (pl.mask.left ?? 0) - (pl.left ?? 0), (pl.mask.top ?? 0) - (pl.top ?? 0));
        l.mask = mk; l.maskEnabled = !pl.mask.disabled;
        if (pl.mask.positionRelativeToLayer) l.maskLinked = false;
      } else if (pl.mask?.canvas && l.adjustment) {
        const mk = canvasOf(doc.width, doc.height), mx = ctx2d(mk);
        const dc = pl.mask.defaultColor ?? 255;
        mx.fillStyle = `rgb(${dc},${dc},${dc})`; mx.fillRect(0, 0, mk.width, mk.height);
        mx.drawImage(pl.mask.canvas as HTMLCanvasElement, pl.mask.left ?? 0, pl.mask.top ?? 0);
        l.mask = mk; l.maskEnabled = !pl.mask.disabled;
      } else if (pl.mask?.canvas) notes.push('The layer mask couldn’t be converted and was skipped.');
      notes.forEach(message => conversions.push({ layerName: lname, message }));
      doc.layers.push(l);
    }
  };
  // ag-psd keeps the file's order, bottom to top (it unshifts while reading the records from the top), as Photoshop.eth stores layers.
  walk(psd.children, null);
  if (!doc.layers.length && psd.canvas) doc.layers.push(newPixelLayer(doc, 'Background', psd.canvas as HTMLCanvasElement));
  doc.activeId = doc.layers.filter(l => !l.isGroup).pop()?.id ?? null;
  doc.selectedIds = doc.activeId ? [doc.activeId] : [];
  return { doc, conversions };
}

export async function fileToCanvas(file: File): Promise<HTMLCanvasElement> {
  return limitCanvas(await decodeFileToCanvas(file), file.name);
}
async function decodeFileToCanvas(file: File): Promise<HTMLCanvasElement> {
  if (/\.svg$/i.test(file.name) || file.type === 'image/svg+xml') return svgToCanvas(file);
  if (isTiffName(file.name, file.type)) {
    // A RAW with a Bayer mosaic is developed in the Develop sheet (RawDevelopSheet); anything else uses its RGB image or preview.
    const buf = await file.arrayBuffer();
    if (!/\.tiff?$/i.test(file.name) && rawDevelopHook) {
      const raw = await parseRaw(buf);
      if (raw) { const c = await rawDevelopHook(file.name, raw); if (!c) throw new DevelopCancelled(); return c; }
    }
    return tiffToCanvas(buf);
  }
  try { return await bytesToCanvas(file); }
  catch (e) {
    // ImageIO reads HEIC/HEIF everywhere on the Mac; browsers other than Safari can't, so libheif (wasm) does it, loaded on first use.
    if (isHeif(file)) return heifToCanvas(new Uint8Array(await file.arrayBuffer()));
    throw e;
  }
}
const isHeif = (f: File) => /\.(hei[cf]|avci)$/i.test(f.name) || /hei[cf]/i.test(f.type);
type HeifImage = { get_width(): number; get_height(): number; display(d: { data: Uint8ClampedArray; width: number; height: number }, cb: (r: unknown) => void): void; free?(): void };
let heifLib: Promise<{ HeifDecoder: new () => { decode(b: Uint8Array): HeifImage[] } }> | null = null;
export async function heifToCanvas(bytes: Uint8Array): Promise<HTMLCanvasElement> {
  heifLib ??= import('libheif-js/libheif-wasm/libheif-bundle.mjs').then(m => (m.default as () => never)());
  let lib;
  try { lib = await heifLib; } catch { heifLib = null; throw new Error('The HEIC decoder couldn’t be loaded.'); }
  const images = new lib.HeifDecoder().decode(bytes);
  const im = images[0]; if (!im) throw new Error('This HEIC file has no image Photoshop.eth can read.');
  const w = im.get_width(), h = im.get_height();
  const c = canvasOf(w, h), x = ctx2d(c), id = x.createImageData(w, h);
  await new Promise<void>((res, rej) => im.display({ data: id.data, width: w, height: h }, r => r ? res() : rej(new Error('The HEIC image couldn’t be decoded.'))));
  x.putImageData(id, 0, 0);
  for (const i of images) i.free?.();
  return c;
}
export function isImageFile(f: File) { return /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|hei[cf])$/i.test(f.name) || isTiffName(f.name, f.type); }
export function isPsd(f: File) { return /\.ps[db]$/i.test(f.name); }
export function isCompZip(f: File) { return /\.(comp\.zip|zip|comp)$/i.test(f.name); }

export function download(bytes: Uint8Array | Blob, filename: string, type = 'application/octet-stream') {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
export function canvasToBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('encode failed')), type, quality));
}
