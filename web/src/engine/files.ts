// File formats. A Compositor project (.comp) is a folder: manifest.json + images/<UUID>.png (+ <UUID>.mask.png),
// exactly as IO/ProjectStore.swift writes it. Browsers can't save a package folder, so the web app saves the same
// folder zipped (Name.comp.zip, which unzips to Name.comp for the Mac app) and opens either a zip or a picked
// .comp folder. Images open through the browser's own decoders; PSDs through ag-psd (the Mac app has its own
// Swift PSD reader, IO/PSD, which depends on Core Graphics).
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { readPsd, type Layer as PsdLayer } from 'ag-psd';
import { type Doc, type Guide, type Layer, type BlendMode, BLEND_MODES, newDoc, newPixelLayer, uuid, fullTransform } from './document';
import { canvasOf, ctx2d, type AdjustmentRecord } from './adjustments';

export interface ManifestLayer {
  id: string; name: string; isVisible: boolean; imageFile?: string; parentID?: string; isGroup?: boolean; opacity?: number; blendMode?: string;
  maskFile?: string; maskEnabled?: boolean; maskSourceID?: string; adjustment?: AdjustmentRecord; shape?: unknown; effects?: unknown; text?: unknown;
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

export async function writeComp(doc: Doc): Promise<Uint8Array> {
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
      files[`${folder}/images/${l.id}.mask.png`] = await maskToPng(l.mask);
    }
    if (l.clipTo) rec.maskSourceID = l.clipTo;
    if (l.adjustment) rec.adjustment = l.adjustment;
    if (l.text) rec.text = l.text;
    if (l.shape) rec.shape = l.shape;
    if (l.effects && Object.keys(l.effects).length) rec.effects = l.effects;
    layers.push(rec);
  }
  const manifest: Manifest = { format: 'com.compositor.project', version: 11, colorSpace: 'sRGB', documentID: doc.id, width: doc.width,
    height: doc.height, resolution: doc.resolution, activeLayerID: doc.activeId, layers, ...(doc.guides.length ? { guides: doc.guides.map(g => ({ id: g.id, axis: g.axis, position: g.position })) } : {}) };
  files[`${folder}/manifest.json`] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(files, { level: 0 });
}

/** Reads a project from a map of relative paths ("manifest.json", "images/X.png") to bytes. */
export async function readCompFiles(files: Map<string, Uint8Array>, name: string): Promise<Doc> {
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) throw new Error('This project has no manifest.json.');
  const m = JSON.parse(strFromU8(manifestBytes)) as Manifest;
  if (m.format !== 'com.compositor.project') throw new Error('Not a Compositor project.');
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
      adjustment: r.adjustment, text: r.text as Layer['text'], shape: r.shape as Layer['shape'], effects: r.effects as Layer['effects'],
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
        if (mc.width !== pw || mc.height !== ph) { const s = canvasOf(pw, ph); ctx2d(s).drawImage(mc, 0, 0, pw, ph); layer.mask = s; } else layer.mask = mc;
      }
    }
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
export async function readPsdFile(bytes: ArrayBuffer, name: string): Promise<Doc> {
  const psd = readPsd(bytes, { skipThumbnail: true });
  const doc = newDoc(psd.width, psd.height, name.replace(/\.ps[db]$/i, ''));
  const walk = (children: PsdLayer[] | undefined, parent: string | null) => {
    for (const pl of children ?? []) {
      const blend = PSD_BLEND[pl.blendMode ?? 'normal'] ?? 'Normal';
      if (pl.children) {
        const g: Layer = { id: uuid(), name: pl.name ?? 'Folder', visible: !pl.hidden, opacity: pl.opacity ?? 1, blend: 'Normal', parentId: parent, isGroup: true,
          canvas: null, transform: fullTransform(doc), mask: null, maskEnabled: true, clipTo: null, rev: 1 };
        doc.layers.push(g);
        walk(pl.children, g.id);
        continue;
      }
      const c = pl.canvas as HTMLCanvasElement | undefined;
      const w = Math.max(1, (pl.right ?? 0) - (pl.left ?? 0)), h = Math.max(1, (pl.bottom ?? 0) - (pl.top ?? 0));
      const canvas = c ?? canvasOf(w, h);
      const l = newPixelLayer(doc, pl.name ?? 'Layer', canvas, { x: pl.left ?? 0, y: pl.top ?? 0, w: canvas.width, h: canvas.height });
      l.visible = !pl.hidden; l.opacity = pl.opacity ?? 1; l.blend = blend; l.parentId = parent;
      if (pl.clipping) {
        const base = [...doc.layers].reverse().find(x => x.parentId === parent && !x.clipTo && !x.isGroup);
        if (base) l.clipTo = base.id;
      }
      if (pl.mask?.canvas && !pl.mask.disabled) {
        // PSD masks have their own bounds; redraw them onto the layer's pixel grid (outside = default color).
        const mk = canvasOf(canvas.width, canvas.height), mx = ctx2d(mk);
        const dc = pl.mask.defaultColor ?? 255;
        mx.fillStyle = `rgb(${dc},${dc},${dc})`; mx.fillRect(0, 0, mk.width, mk.height);
        mx.drawImage(pl.mask.canvas as HTMLCanvasElement, (pl.mask.left ?? 0) - (pl.left ?? 0), (pl.mask.top ?? 0) - (pl.top ?? 0));
        l.mask = mk;
      }
      doc.layers.push(l);
    }
  };
  // ag-psd lists children top to bottom; Compositor stores bottom to top.
  const reverseAll = (ls?: PsdLayer[]): PsdLayer[] | undefined => ls ? [...ls].reverse().map(x => ({ ...x, children: reverseAll(x.children) })) : undefined;
  walk(reverseAll(psd.children), null);
  if (!doc.layers.length && psd.canvas) doc.layers.push(newPixelLayer(doc, 'Background', psd.canvas as HTMLCanvasElement));
  doc.activeId = doc.layers.filter(l => !l.isGroup).pop()?.id ?? null;
  doc.selectedIds = doc.activeId ? [doc.activeId] : [];
  return doc;
}

export async function fileToCanvas(file: File): Promise<HTMLCanvasElement> {
  if (/\.svg$/i.test(file.name) || file.type === 'image/svg+xml') return svgToCanvas(file);
  return bytesToCanvas(file);
}
export function isImageFile(f: File) { return /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i.test(f.name); }
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
