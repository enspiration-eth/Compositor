// The editor session: the web counterpart of Document/EditorSession.swift and ProjectWorkspace.swift. Holds the open
// projects (tabs), tool state, colors, and every editing action the menus, keys and panels call.
import { noteRecent, recentFile, forgetRecent, type RecentEntry } from '../engine/recent';
import {
  type Doc, type Layer, type BlendMode, type Effects, type EffectKey, type Transform, History, newDoc, newPixelLayer, uuid, cloneCanvas,
  getLayer, descendants, ancestors, childrenOf, layerMatrix, solidMask, fullTransform, renderText, rgbCss, BLEND_MODES, invert, apply, renderShape,
  toggleMaskLink, maskGridView, maskTransformOf, maskInLayerGrid, eachTransform, pixelToDoc, mul, maskPlacementOf, setMaskPlacement,
} from '../engine/document';
import { Renderer } from '../engine/render';
import { canvasOf, ctx2d, imageDataOf, newAdjustment, type AdjustmentKind, type FilterKind, type FilterSettings, type RGB } from '../engine/adjustments';
import { applyFilterAsync } from '../engine/filterPool';
import * as Sel from '../engine/selection';
import { contentFill, alphaBounds } from '../engine/kernels';
import { writeComp, writeCompToDirectory, readCompZip, readCompFolder, readPsdFile, type PsdConversion, fileToCanvas, isImageFile, isPsd, isCompZip, download, canvasToBlob } from '../engine/files';
import { toast } from './dom';
import { subjectMatte, modelLoaded } from '../engine/segment';

export interface CanvasHook {
  cursor?: string;
  down?: (dpt: [number, number], e: PointerEvent) => void; move?: (dpt: [number, number], e: PointerEvent) => void; up?: (dpt: [number, number], e: PointerEvent) => void;
  draw?: (x: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number]) => void;
}
export type Tool = 'move' | 'marquee' | 'lasso' | 'wand' | 'crop' | 'brush' | 'spotHealing' | 'cloneStamp' | 'blur' | 'gradient' | 'shape' | 'type' | 'eyedropper' | 'hand' | 'zoom' | 'idle';
export const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: 'move', label: 'Move / Transform (V)', key: 'v' }, { id: 'marquee', label: 'Marquee (M)', key: 'm' }, { id: 'lasso', label: 'Lasso (L)', key: 'l' },
  { id: 'wand', label: 'Magic Wand (W)', key: 'w' }, { id: 'crop', label: 'Crop (C)', key: 'c' }, { id: 'brush', label: 'Brush (B) · Eraser (E)', key: 'b' },
  { id: 'spotHealing', label: 'Spot Healing Brush (J)', key: 'j' }, { id: 'cloneStamp', label: 'Clone Stamp (S) · Option-click sets the source', key: 's' },
  { id: 'blur', label: 'Liquify · Blur · Smudge (R)', key: 'r' }, { id: 'gradient', label: 'Gradient (G)', key: 'g' }, { id: 'shape', label: 'Shape (U) · Shift-U switches shape', key: 'u' },
  { id: 'type', label: 'Type (T)', key: 't' }, { id: 'eyedropper', label: 'Eyedropper (I)', key: 'i' }, { id: 'hand', label: 'Hand (H)', key: 'h' },
  { id: 'zoom', label: 'Zoom (Z)', key: 'z' },
];

export interface Project { doc: Doc; history: History; zoom: number; ox: number; oy: number; fitted: boolean }

export class App {
  projects: Project[] = [];
  current = -1;
  renderer!: Renderer;
  tool: Tool = 'brush';
  fg: RGB = { red: 0, green: 0, blue: 0 };
  bg: RGB = { red: 1, green: 1, blue: 1 };
  brush = { size: 40, hardness: 0.8, opacity: 1, smoothing: 0.1, mode: 'paint' as 'paint' | 'erase', pressure: true };
  marqueeKind: 'rectangle' | 'ellipse' = 'rectangle';
  marqueeFeather = 0;
  lassoKind: 'freehand' | 'polygonal' = 'freehand';
  wand = { tolerance: 32, contiguous: true, sampleAll: true };
  wandMode: 'wand' | 'object' = 'wand';
  objectSel = { sampleAll: true, edgeOffset: 0, antiAlias: true };
  busy = false;
  smearMode: 'liquify' | 'blur' | 'smudge' = 'blur';
  smearStrength = 0.5;
  /** BrushSettings.blurRadius: how far the Blur brush softens, in canvas pixels (0.5–50). */
  blurRadius = 5;
  clone = { aligned: true, sampleAll: false };
  gradient = { kind: 'linear' as 'linear' | 'radial', opacity: 1, toTransparent: false };
  shape = { kind: 'Rectangle' as 'Rectangle' | 'Ellipse' | 'Line', cornerRadius: 0, lineWidth: 6 };
  type = { fontName: 'Helvetica', fontSize: 72, alignment: 'Left' as 'Left' | 'Center' | 'Right', tracking: 0, leading: 0 };
  crop = { ratio: 'Free' };
  maskTarget = false;    // painting on the active layer's mask instead of its pixels
  listeners = new Set<(what: string) => void>();
  needsRender = true;
  /** A panel borrowing the canvas (Camera Raw's Point Color eyedropper, Upright guides): it gets the pointer before any tool. */
  canvasHook: CanvasHook | null = null;
  /** Eyedropper: show the sample ring while sampling. */
  get showsSampleRing() { return localStorage.getItem('compositor.sampleRing') !== '0'; }
  set showsSampleRing(v: boolean) { localStorage.setItem('compositor.sampleRing', v ? '1' : '0'); this.emit('tool'); }
  /** Move tool (TransformInspector): scale handles keep the aspect ratio (Shift turns it the other way). */
  locksTransformRatio = true;
  /** Off by default: a Move-tool press drags the active layer; hold ⌘ (or turn this on) to pick the layer under the pointer. */
  get transformAutoSelect() { return localStorage.getItem('compositor.autoSelect') === '1'; }
  set transformAutoSelect(v: boolean) { localStorage.setItem('compositor.autoSelect', v ? '1' : '0'); this.emit('tool'); }
  /** The Move tool's transform box and handles (⌘H). Hidden, a drag anywhere just moves the layer. */
  get showsTransformControls() { return localStorage.getItem('compositor.transformControls') !== '0'; }
  set showsTransformControls(v: boolean) { localStorage.setItem('compositor.transformControls', v ? '1' : '0'); this.emit('tool'); }

  get project(): Project | null { return this.projects[this.current] ?? null; }
  get doc(): Doc | null { return this.project?.doc ?? null; }
  get history(): History | null { return this.project?.history ?? null; }
  get active(): Layer | null { const d = this.doc; return d ? getLayer(d, d.activeId) : null; }

  on(fn: (what: string) => void) { this.listeners.add(fn); }
  emit(what: string) { this.needsRender = true; for (const f of this.listeners) f(what); }
  changed(what = 'doc') { if (this.doc) this.doc.dirty = true; this.emit(what); }

  // ---------- projects ----------
  addProject(doc: Doc) {
    this.projects.push({ doc, history: new History(), zoom: 1, ox: 0, oy: 0, fitted: false });
    this.current = this.projects.length - 1;
    this.maskTarget = false;
    this.emit('project');
  }
  newCanvas(width: number, height: number, name = 'Untitled') {
    const doc = newDoc(width, height, this.uniqueName(name));
    const layer = newPixelLayer(doc, 'Layer 1');
    doc.layers.push(layer); doc.activeId = layer.id; doc.selectedIds = [layer.id];
    this.addProject(doc);
  }
  uniqueName(base: string) {
    const names = new Set(this.projects.map(p => p.doc.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  }
  switchTo(i: number) { if (i >= 0 && i < this.projects.length) { this.current = i; this.maskTarget = false; this.emit('project'); } }
  closeProject(i = this.current) {
    const p = this.projects[i]; if (!p) return;
    if (p.doc.dirty && p.doc.layers.length && !confirm(`Close “${p.doc.name}” without saving?`)) return;
    this.projects.splice(i, 1);
    this.current = Math.min(this.current, this.projects.length - 1);
    this.emit('project');
  }

  /** Project tabs reorder by dragging (ProjectTabs.onReorder). */
  moveProject(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= this.projects.length || to >= this.projects.length) return;
    const cur = this.projects[this.current];
    const [p] = this.projects.splice(from, 1); this.projects.splice(to, 0, p!);
    this.current = cur ? this.projects.indexOf(cur) : this.current;
    this.emit('project');
  }
  /** ProjectWorkspace.copyLayers: layers (folders with all they hold) copied into another project, or a new one when
   *  `dest` is null, as one undo step there. Together they keep where they sit relative to each other, centered on the
   *  canvas. Returns false when there's nothing to do (the layers already live in that project). */
  copyLayersToProject(ids: string[], dest: number | null): boolean {
    const srcIdx = this.projects.findIndex(p => p.doc.layers.some(l => ids.includes(l.id)));
    if (srcIdx < 0 || dest === srcIdx || (dest !== null && !this.projects[dest])) return false;
    this.commitFloating();
    const src = this.projects[srcIdx]!.doc;
    const included = new Set(ids); for (const id of ids) for (const x of descendants(src, id)) included.add(x.id);
    const picked = src.layers.filter(l => included.has(l.id));
    const ids2 = new Map(picked.map(l => [l.id, uuid()]));
    if (dest === null) {
      const top = picked.filter(l => !l.parentId || !included.has(l.parentId));
      this.addProject(newDoc(src.width, src.height, this.uniqueName(top.length === 1 ? top[0]!.name : src.name)));
    } else this.switchTo(dest);
    const d = this.doc!;
    this.edit(ids.length > 1 ? 'Copy Layers' : 'Copy Layer');
    const copies: Layer[] = picked.map(l => ({ ...l, id: ids2.get(l.id)!, parentId: l.parentId && ids2.has(l.parentId) ? ids2.get(l.parentId)! : null,
      clipTo: l.clipTo && ids2.has(l.clipTo) ? ids2.get(l.clipTo)! : null,
      canvas: l.canvas ? cloneCanvas(l.canvas) : null, mask: l.mask ? cloneCanvas(l.mask) : null, transform: { ...l.transform },
      maskPlacement: l.maskPlacement ? { ...l.maskPlacement } : undefined, maskBase: l.maskBase ? { ...l.maskBase } : undefined,
      effects: l.effects ? structuredClone(l.effects) : undefined, adjustment: l.adjustment ? structuredClone(l.adjustment) : undefined,
      text: l.text ? structuredClone(l.text) : undefined, shape: l.shape ? structuredClone(l.shape) : undefined, rev: 1 }));
    // Centered as a whole on this canvas.
    const placed = copies.filter(l => l.canvas);
    if (placed.length) {
      const x0 = Math.min(...placed.map(l => l.transform.x)), y0 = Math.min(...placed.map(l => l.transform.y));
      const x1 = Math.max(...placed.map(l => l.transform.x + l.transform.w)), y1 = Math.max(...placed.map(l => l.transform.y + l.transform.h));
      const dx = Math.round(d.width / 2 - (x0 + x1) / 2), dy = Math.round(d.height / 2 - (y0 + y1) / 2);
      for (const l of copies) {
        l.transform.x += dx; l.transform.y += dy;
        if (l.maskPlacement) { l.maskPlacement.x += dx; l.maskPlacement.y += dy; }
        if (l.maskBase) { l.maskBase.x += dx; l.maskBase.y += dy; }
      }
    }
    d.layers.push(...copies);
    const tops = copies.filter(l => !l.parentId);
    d.activeId = tops[tops.length - 1]?.id ?? null; d.selectedIds = tops.map(l => l.id);
    this.maskTarget = false;
    this.changed('layers');
    return true;
  }

  // ---------- history ----------
  edit(label: string) { if (this.doc && this.history) this.history.push(this.doc, label); }
  undo() {
    if (!this.doc || !this.history) return;
    const l = this.history.undo(this.doc);
    // Undoing past the start of Transform Selection puts the pixels back: nothing floats any more.
    if (this.floating && this.history.undoStack.length < this.floating.depth) this.floating = null;
    if (l) { this.maskTarget = this.maskTarget && !!this.active?.mask; this.changed('history'); }
  }
  redo() { if (!this.doc || !this.history) return; const l = this.history.redo(this.doc); if (l) this.changed('history'); }
  ownPixels(l: Layer) { this.history!.ownLayer(l); return l.canvas!; }
  /** The mask's pixels, owned by this edit, in the mask's own grid (a placed mask isn't resampled). */
  ownMask(l: Layer) { this.history!.ownMask(l); return l.mask!; }
  /** EditorSession.toggleMaskLink. */
  toggleMaskLink(l = this.active) { if (!l?.mask) return; this.edit(l.maskLinked === false ? 'Link Layer Mask' : 'Unlink Layer Mask'); toggleMaskLink(l); this.changed('layers'); }

  // ---------- layers ----------
  setActive(id: string, extend = false) {
    const d = this.doc; if (!d) return;
    if (this.floating && id !== this.floating.floatId) this.commitFloating();
    if (extend) d.selectedIds = d.selectedIds.includes(id) ? d.selectedIds.filter(x => x !== id) : [...d.selectedIds, id];
    else d.selectedIds = [id];
    d.activeId = id;
    if (!getLayer(d, id)?.mask) this.maskTarget = false;
    this.emit('layers');
  }
  insertAboveActive(layer: Layer) {
    const d = this.doc!; const a = this.active;
    if (a) {
      const idx = d.layers.indexOf(a);
      if (a.isGroup) { layer.parentId = a.id; d.layers.splice(idx + 1 + 0, 0, layer); }
      else { layer.parentId = a.parentId; d.layers.splice(idx + 1, 0, layer); }
    } else d.layers.push(layer);
    d.activeId = layer.id; d.selectedIds = [layer.id];
  }
  layerName(base: string) {
    const names = new Set(this.doc!.layers.map(l => l.name));
    for (let i = 1; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  }
  addBlankLayer() {
    const d = this.doc; if (!d) return;
    this.edit('New Layer');
    this.insertAboveActive(newPixelLayer(d, this.layerName('Layer')));
    this.maskTarget = false;
    this.changed('layers');
  }
  addAdjustmentLayer(kind: AdjustmentKind) {
    const d = this.doc; if (!d) return;
    this.edit(`New ${kind} Layer`);
    const l: Layer = { id: uuid(), name: kind, visible: true, opacity: 1, blend: 'Normal', parentId: null, isGroup: false, canvas: null,
      transform: fullTransform(d), mask: null, maskEnabled: true, clipTo: null, rev: 1, adjustment: newAdjustment(kind) };
    this.insertAboveActive(l);
    this.changed('layers');
    return l;
  }
  groupSelected() {
    const d = this.doc; if (!d) return;
    const ids = d.selectedIds.length ? d.selectedIds : d.activeId ? [d.activeId] : [];
    this.edit('Group Layers');
    const g: Layer = { id: uuid(), name: this.layerName('Folder'), visible: true, opacity: 1, blend: 'Normal', parentId: null, isGroup: true, canvas: null,
      transform: fullTransform(d), mask: null, maskEnabled: true, clipTo: null, rev: 1 };
    const members = d.layers.filter(l => ids.includes(l.id));
    if (!members.length) { d.layers.push(g); }
    else {
      g.parentId = members[0].parentId;
      // Move members and their subtrees just below the new folder's slot, keeping order.
      const moving = new Set<string>(); for (const m of members) { moving.add(m.id); for (const x of descendants(d, m.id)) moving.add(x.id); }
      const top = Math.max(...members.map(m => d.layers.indexOf(m)));
      const moved = d.layers.filter(l => moving.has(l.id));
      const rest = d.layers.filter(l => !moving.has(l.id));
      const anchor = d.layers.slice(top + 1).find(l => !moving.has(l.id));
      const at = anchor ? rest.indexOf(anchor) : rest.length;
      for (const m of members) if (m.parentId === g.parentId) m.parentId = g.id;
      rest.splice(at, 0, ...moved, g);
      d.layers = rest;
    }
    d.activeId = g.id; d.selectedIds = [g.id];
    this.changed('layers');
  }
  /** Layer › Move Out of Folder (moveActiveLayerOutOfGroup): just above its folder, in the folder's parent. */
  moveOutOfFolder() {
    const d = this.doc, a = this.active; if (!d || !a?.parentId) return;
    this.edit('Move Out of Folder'); this.reorder(a.id, a.parentId, 'above');
  }
  ungroup() {
    const d = this.doc, a = this.active; if (!d || !a?.isGroup) return;
    this.edit('Ungroup Layers');
    for (const c of childrenOf(d, a.id)) c.parentId = a.parentId;
    d.layers = d.layers.filter(l => l !== a);
    d.activeId = d.layers[d.layers.length - 1]?.id ?? null; d.selectedIds = d.activeId ? [d.activeId] : [];
    this.changed('layers');
  }
  deleteLayers() {
    const d = this.doc; if (!d) return;
    if (this.maskTarget && this.active?.mask) { this.edit('Delete Mask'); this.active.mask = null; this.active.rev++; this.maskTarget = false; this.changed('layers'); return; }
    const ids = new Set(d.selectedIds.length ? d.selectedIds : d.activeId ? [d.activeId] : []);
    if (!ids.size) return;
    this.edit(ids.size > 1 ? 'Delete Layers' : 'Delete Layer');
    for (const id of [...ids]) for (const x of descendants(d, id)) ids.add(x.id);
    const idx = d.layers.findIndex(l => ids.has(l.id));
    d.layers = d.layers.filter(l => !ids.has(l.id));
    for (const l of d.layers) if (l.clipTo && ids.has(l.clipTo)) l.clipTo = null;
    const next = d.layers[Math.min(Math.max(0, idx - 1), d.layers.length - 1)];
    d.activeId = next?.id ?? null; d.selectedIds = next ? [next.id] : [];
    this.changed('layers');
  }
  duplicateLayer() {
    const d = this.doc, a = this.active; if (!d || !a) return;
    if (d.selection && a.canvas && !a.adjustment) { this.layerViaCopy(false); return; }
    this.edit('Duplicate Layer');
    const copy = (l: Layer, parent: string | null): Layer => ({ ...l, id: uuid(), parentId: parent, name: l === a ? `${l.name} copy` : l.name,
      canvas: l.canvas ? cloneCanvas(l.canvas) : null, mask: l.mask ? cloneCanvas(l.mask) : null, transform: { ...l.transform },
      effects: l.effects ? structuredClone(l.effects) : undefined, adjustment: l.adjustment ? structuredClone(l.adjustment) : undefined,
      text: l.text ? structuredClone(l.text) : undefined, shape: l.shape ? structuredClone(l.shape) : undefined, rev: 1 });
    const top = copy(a, a.parentId);
    const subtree = a.isGroup ? descendants(d, a.id) : [];
    const map = new Map([[a.id, top.id]]);
    const copies = subtree.map(l => { const c = copy(l, map.get(l.parentId!) ?? top.id); map.set(l.id, c.id); return c; });
    const end = d.layers.indexOf(a);
    d.layers.splice(end + 1, 0, ...copies, top);
    d.activeId = top.id; d.selectedIds = [top.id];
    this.changed('layers');
  }
  /** ⌘J with a selection: the selected pixels on a new layer. ⇧⌘J (cut) clears them from the original. */
  layerViaCopy(cut: boolean) {
    const d = this.doc, a = this.active; if (!d || !a?.canvas) return;
    const selL = Sel.selectionInLayer(d, a, a.canvas.width, a.canvas.height); if (!selL) return;
    this.edit(cut ? 'Layer via Cut' : 'Layer via Copy');
    const c = cloneCanvas(a.canvas), x = ctx2d(c);
    x.globalCompositeOperation = 'destination-in'; x.drawImage(selL, 0, 0);
    if (cut) { const t = ctx2d(this.ownPixels(a)); t.globalCompositeOperation = 'destination-out'; t.drawImage(selL, 0, 0); t.globalCompositeOperation = 'source-over'; }
    const l: Layer = { ...newPixelLayer(d, this.layerName('Layer'), c), transform: { ...a.transform }, parentId: a.parentId };
    d.layers.splice(d.layers.indexOf(a) + 1, 0, l);
    d.activeId = l.id; d.selectedIds = [l.id]; d.selection = null; d.selRev++;
    this.changed('layers');
  }
  moveLayer(delta: number) {
    const d = this.doc, a = this.active; if (!d || !a) return;
    const sibs = childrenOf(d, a.parentId);
    const i = sibs.indexOf(a), j = i + delta;
    if (j < 0 || j >= sibs.length) return;
    this.edit(delta > 0 ? 'Move Layer Up' : 'Move Layer Down');
    this.reorder(a.id, sibs[j].id, delta > 0 ? 'above' : 'below');
  }
  /** Drag and drop in the Layers panel: put `id` above/below/into `targetId`. */
  reorder(id: string, targetId: string, where: 'above' | 'below' | 'into') {
    const d = this.doc!; const l = getLayer(d, id), t = getLayer(d, targetId);
    if (!l || !t || l === t) return;
    if (l.isGroup && (t.id === l.id || descendants(d, l.id).includes(t))) return;
    const block = [...(l.isGroup ? descendants(d, l.id) : []), l];
    const set = new Set(block.map(x => x.id));
    const rest = d.layers.filter(x => !set.has(x.id));
    let at: number;
    if (where === 'into' && t.isGroup) { l.parentId = t.id; at = rest.indexOf(t); }
    else if (where === 'above') { l.parentId = t.parentId; at = rest.indexOf(t) + 1; }
    else { l.parentId = t.parentId; const first = t.isGroup ? descendants(d, t.id).map(x => rest.indexOf(x)).filter(i => i >= 0) : []; at = first.length ? Math.min(...first) : rest.indexOf(t); }
    rest.splice(at, 0, ...block);
    d.layers = rest;
    if (l.clipTo) { const sibs = childrenOf(d, l.parentId); const i = sibs.indexOf(l); if (!sibs.slice(0, i).some(s => s.id === l.clipTo)) l.clipTo = null; }
    this.changed('layers');
  }
  setLayerProp<K extends keyof Layer>(l: Layer, key: K, value: Layer[K], label: string, coalesce = false) {
    if (!coalesce || this.history?.undoLabel !== label + l.id) this.edit(coalesce ? label + l.id : label);
    l[key] = value;
    this.changed('layers');
  }
  toggleClip() {
    const d = this.doc, a = this.active; if (!d || !a || a.isGroup) return;
    const sibs = childrenOf(d, a.parentId), i = sibs.indexOf(a);
    this.edit(a.clipTo ? 'Release Clipping Mask' : 'Create Clipping Mask');
    if (a.clipTo) a.clipTo = null;
    else {
      const base = [...sibs.slice(0, i)].reverse().find(s => !s.clipTo && !s.isGroup);
      if (base) a.clipTo = base.id;
    }
    this.changed('layers');
  }
  mergeDown() {
    const d = this.doc, a = this.active; if (!d || !a) return;
    const sibs = childrenOf(d, a.parentId), i = sibs.indexOf(a), below = sibs[i - 1];
    if (!below || below.isGroup || !below.canvas || a.isGroup) { toast('Nothing to merge into below.'); return; }
    this.edit('Merge Down');
    const merged = this.flatten([below, a]);
    below.canvas = merged; below.transform = fullTransform(d); below.mask = null; below.text = undefined; below.shape = undefined; below.effects = undefined; below.rev++;
    below.blend = 'Normal'; below.opacity = 1; below.clipTo = null;
    d.layers = d.layers.filter(l => l !== a);
    for (const l of d.layers) if (l.clipTo === a.id) l.clipTo = below.id;
    d.activeId = below.id; d.selectedIds = [below.id];
    this.changed('layers');
  }
  mergeSelected() {
    const d = this.doc; if (!d) return;
    const ids = d.selectedIds;
    if (ids.length < 2) { const a = this.active; if (a?.isGroup) return this.mergeGroup(); return this.mergeDown(); }
    this.edit('Merge Layers');
    const layers = d.layers.filter(l => ids.includes(l.id) && !l.isGroup);
    const merged = this.flatten(layers);
    const top = layers[layers.length - 1];
    const l: Layer = { ...newPixelLayer(d, top.name, merged), parentId: top.parentId };
    const idx = d.layers.indexOf(top);
    d.layers.splice(idx + 1, 0, l);
    d.layers = d.layers.filter(x => !layers.includes(x));
    d.activeId = l.id; d.selectedIds = [l.id];
    this.changed('layers');
  }
  mergeGroup() {
    const d = this.doc, g = this.active; if (!d || !g?.isGroup) return;
    this.edit('Merge Group');
    const inner = descendants(d, g.id);
    const merged = this.flatten([g, ...inner]);
    const l: Layer = { ...newPixelLayer(d, g.name, merged), parentId: g.parentId };
    const idx = d.layers.indexOf(g);
    d.layers.splice(idx + 1, 0, l);
    const gone = new Set([g.id, ...inner.map(x => x.id)]);
    d.layers = d.layers.filter(x => !gone.has(x.id));
    d.activeId = l.id; d.selectedIds = [l.id];
    this.changed('layers');
  }
  /** Renders just these layers (with their modes, masks, effects) into one document-size canvas. */
  flatten(layers: Layer[]): HTMLCanvasElement {
    const d = this.doc!;
    const vis = new Set<string>(), anc = new Set<string>();
    for (const l of layers) {
      vis.add(l.id);
      if (l.isGroup) for (const x of descendants(d, l.id)) vis.add(x.id);
      for (const a of ancestors(d, l)) if (!layers.includes(a)) anc.add(a.id);
    }
    const temp: Doc = { ...d, layers: d.layers.map(l => anc.has(l.id) ? { ...l, visible: true, opacity: 1, mask: null }
      : vis.has(l.id) ? l : { ...l, visible: false }) };
    const img = this.renderer.readComposite(temp);
    this.renderer.invalidate();
    const c = canvasOf(d.width, d.height); ctx2d(c).putImageData(img, 0, 0); return c;
  }
  rasterize(l: Layer) { if (l.text || l.shape) { l.text = undefined; l.shape = undefined; } }

  // ---------- Transform Selection (FloatingSelection.swift) ----------
  /** The selected pixels lifted onto a temporary layer while ⌘T with a selection is open. `depth` is the undo stack
   *  size right after its "Transform Selection" step, so the whole thing collapses into that one step. */
  floating: { sourceId: string; floatId: string; original: Transform; pw: number; ph: number; depth: number } | null = null;
  get canTransformSelection() {
    const d = this.doc, a = this.active;
    return !!(d?.selection && a && a.canvas && !a.isGroup && !a.adjustment && !this.maskTarget && !this.floating);
  }
  beginSelectionTransform() {
    const d = this.doc!, src = this.active!;
    if (!this.canTransformSelection) return;
    const sel = d.selection!, [sx0, sy0, sx1, sy1] = alphaBounds(ctx2d(sel).getImageData(0, 0, sel.width, sel.height));
    // renderSelectedPixels: the layer's pixels inside the selection, in document pixels, over the selection's bounds.
    const m = layerMatrix(src), cs = [[0, 0], [src.canvas!.width, 0], [0, src.canvas!.height], [src.canvas!.width, src.canvas!.height]].map(([u, v]) => apply(m, u, v));
    const x0 = Math.max(sx0, Math.floor(Math.min(...cs.map(c => c[0])))), y0 = Math.max(sy0, Math.floor(Math.min(...cs.map(c => c[1]))));
    const x1 = Math.min(sx1, Math.ceil(Math.max(...cs.map(c => c[0])))), y1 = Math.min(sy1, Math.ceil(Math.max(...cs.map(c => c[1]))));
    if (x1 <= x0 || y1 <= y0) { toast('The selection doesn’t cover this layer.'); return; }
    const w = x1 - x0, h = y1 - y0, lifted = canvasOf(w, h), lx = ctx2d(lifted);
    lx.setTransform(m[0], m[1], m[2], m[3], m[4] - x0, m[5] - y0); lx.drawImage(src.canvas!, 0, 0); lx.setTransform(1, 0, 0, 1, 0, 0);
    lx.globalCompositeOperation = 'destination-in'; lx.drawImage(sel, -x0, -y0);
    if (this.isEmptyLayer(lifted)) { toast('No pixels are selected on this layer.'); return; }
    // Outer edit, closed by commitFloating (merge) or cancelFloating (restore).
    this.edit('Transform Selection');
    const own = this.ownPixels(src), inLayer = Sel.selectionInLayer(d, src, own.width, own.height)!;
    const ox = ctx2d(own); ox.save(); ox.globalCompositeOperation = 'destination-out'; ox.drawImage(inLayer, 0, 0); ox.restore();
    this.rasterize(src); src.rev++;
    const fl = newPixelLayer(d, 'Floating Selection', lifted, { x: x0, y: y0, w, h, rotation: 0 });
    fl.opacity = src.opacity; fl.blend = src.blend;
    this.insertAboveActive(fl);
    this.floating = { sourceId: src.id, floatId: fl.id, original: { ...fl.transform }, pw: w, ph: h, depth: this.history!.undoStack.length };
    this.tool = 'move';
    toast('Transform Selection: drag the handles · Return applies · Escape cancels');
    this.changed('layers'); this.emit('tool');
  }
  /** mergeFloatingTransform: the transformed pixels drawn back into their layer (growing it where they now reach past
   *  it), the selection moved with them, all as the one "Transform Selection" step. */
  commitFloating() {
    const f = this.floating, d = this.doc; if (!f || !d) return;
    this.floating = null;
    const fl = getLayer(d, f.floatId), src = getLayer(d, f.sourceId);
    const h = this.history!;
    const collapse = () => { h.undoStack.splice(f.depth); h.redoStack = []; };
    if (!fl || !src || !src.canvas || !fl.canvas) { if (fl) d.layers = d.layers.filter(l => l !== fl); collapse(); this.changed('layers'); return; }
    const W = src.canvas.width, H = src.canvas.height, toDoc = layerMatrix(src), toPix = invert(toDoc), fm = layerMatrix(fl);
    const corners = [[0, 0], [fl.canvas.width, 0], [0, fl.canvas.height], [fl.canvas.width, fl.canvas.height]].map(([u, v]) => apply(toPix, ...apply(fm, u, v)));
    const ex0 = Math.floor(Math.min(0, ...corners.map(c => c[0]))), ey0 = Math.floor(Math.min(0, ...corners.map(c => c[1])));
    const ex1 = Math.ceil(Math.max(W, ...corners.map(c => c[0]))), ey1 = Math.ceil(Math.max(H, ...corners.map(c => c[1])));
    const EW = ex1 - ex0, EH = ey1 - ey0;
    if (EW > 16384 || EH > 16384 || EW * EH > 268435456) { toast('The transformed selection is too large.', 'error'); this.floating = f; this.cancelFloating(); return; }
    const merged = canvasOf(EW, EH), mx = ctx2d(merged);
    mx.drawImage(src.canvas, -ex0, -ey0);
    const pm = mul([1, 0, 0, 1, -ex0, -ey0], mul(toPix, fm));
    mx.save(); mx.globalAlpha = 1; mx.imageSmoothingQuality = 'high'; mx.setTransform(pm[0], pm[1], pm[2], pm[3], pm[4], pm[5]); mx.drawImage(fl.canvas, 0, 0); mx.restore();
    // The selection follows the pixels (a distorted float takes its new outline from the moved pixels).
    let moved: HTMLCanvasElement | null = null;
    if (d.selection) {
      moved = canvasOf(d.width, d.height); const sx = ctx2d(moved);
      if (fl.canvas.width === f.pw && fl.canvas.height === f.ph) {
        const sm = mul(fm, invert(pixelToDoc(f.original, f.pw, f.ph)));
        sx.setTransform(sm[0], sm[1], sm[2], sm[3], sm[4], sm[5]); sx.drawImage(d.selection, 0, 0);
      } else { sx.setTransform(fm[0], fm[1], fm[2], fm[3], fm[4], fm[5]); sx.drawImage(fl.canvas, 0, 0); }
    }
    const placed = maskPlacementOf(src);
    if (src.mask && !placed && (EW !== W || EH !== H || ex0 || ey0)) {
      // A mask grows with the layer, revealing the new area.
      const g = canvasOf(EW, EH), gx = ctx2d(g); gx.fillStyle = '#fff'; gx.fillRect(0, 0, EW, EH); gx.drawImage(src.mask, -ex0, -ey0); src.mask = g;
    }
    const t = src.transform, sw = t.w / W, sh = t.h / H, nw = EW * sw, nh = EH * sh, c = apply(toDoc, ex0 + EW / 2, ey0 + EH / 2);
    src.canvas = merged; src.transform = { ...t, w: nw, h: nh, x: c[0] - nw / 2, y: c[1] - nh / 2 };
    if (placed) setMaskPlacement(src, placed);
    src.rev++;
    d.layers = d.layers.filter(l => l !== fl);
    if (moved) { d.selection = moved; d.selRev++; }
    d.activeId = src.id; d.selectedIds = [src.id];
    collapse();
    this.changed('layers'); this.emit('selection');
  }
  /** cancelFloatingTransform: the document exactly as before ⌘T. */
  cancelFloating() {
    const f = this.floating, d = this.doc, h = this.history; if (!f || !d || !h) return;
    this.floating = null;
    while (h.undoStack.length >= f.depth) h.undo(d);
    h.redoStack = [];
    this.changed('history'); this.emit('selection');
  }

  // ---------- masks ----------
  addMask(fromSelection = true, hide = false) {
    const d = this.doc, a = this.active; if (!d || !a || a.mask) return;
    this.edit('Add Layer Mask');
    const pw = a.canvas?.width ?? Math.round(a.transform.w), ph = a.canvas?.height ?? Math.round(a.transform.h);
    if (fromSelection && d.selection) {
      const m = solidMask(pw, ph, false), sel = Sel.selectionInLayer(d, a, pw, ph)!;
      const w = canvasOf(pw, ph), wx = ctx2d(w); wx.drawImage(sel, 0, 0); wx.globalCompositeOperation = 'source-in'; wx.fillStyle = '#fff'; wx.fillRect(0, 0, pw, ph);
      ctx2d(m).drawImage(w, 0, 0); a.mask = m;
      d.selection = null; d.selRev++;
    } else a.mask = solidMask(pw, ph, !hide);
    a.maskEnabled = true; a.rev++;
    this.maskTarget = true;
    this.changed('layers');
  }
  invertMask() {
    const a = this.active; if (!a?.mask) return;
    this.edit('Invert Mask');
    const m = this.ownMask(a), x = ctx2d(m);
    x.globalCompositeOperation = 'difference'; x.fillStyle = '#fff'; x.fillRect(0, 0, m.width, m.height); x.globalCompositeOperation = 'source-over';
    a.rev++; this.changed('pixels');
  }
  applyMask() {
    const a = this.active; if (!a?.mask || !a.canvas) return;
    this.edit('Apply Layer Mask');
    const c = this.ownPixels(a), x = ctx2d(c);
    const alpha = canvasOf(c.width, c.height), ax = ctx2d(alpha), md = ctx2d(maskInLayerGrid(a)!).getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < md.data.length; i += 4) { md.data[i + 3] = md.data[i]; }
    ax.putImageData(md, 0, 0);
    x.globalCompositeOperation = 'destination-in'; x.drawImage(alpha, 0, 0); x.globalCompositeOperation = 'source-over';
    a.mask = null; a.maskPlacement = a.maskBase = undefined; a.maskLinked = undefined; a.rev++; this.maskTarget = false; this.rasterize(a);
    this.changed('layers');
  }

  // ---------- selection ----------
  /** Runs `work` with a busy cursor and status, one at a time (the Mac app's isProjectBusy). */
  async busyWith<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
    if (this.busy) return undefined;
    this.busy = true; document.body.classList.add('busy');
    const t = setTimeout(() => toast(`${label}${modelLoaded() ? '' : ' (loading the subject model the first time)'}…`), 150);
    try { return await work(); }
    catch (e) { console.warn(e); toast(`${label} failed: ${(e as Error).message}`, 'error'); return undefined; }
    finally { clearTimeout(t); this.busy = false; document.body.classList.remove('busy'); }
  }
  /** Select → Subject (SubjectRemoval.swift selectSubject): the foreground of the canvas as shown, as a selection. */
  async selectSubject(mode: Sel.SelMode = 'replace') {
    const d = this.doc; if (!d) return;
    const shown = canvasOf(d.width, d.height); ctx2d(shown).putImageData(this.renderer.readComposite(d), 0, 0);
    const m = await this.busyWith('Finding the subject', () => subjectMatte(shown));
    if (!m || this.doc !== d) return;
    const bytes = new Uint8Array(m.length); let any = false;
    for (let i = 0; i < m.length; i++) if (m[i] >= 0.5) { bytes[i] = 255; any = true; }
    if (!any) { toast('No subject found.'); return; }
    this.edit('Select Subject'); Sel.combine(d, Sel.maskBytesToCanvas(d, bytes), mode); this.emit('selection');
  }
  selectAll() { const d = this.doc; if (!d) return; this.edit('Select All'); Sel.selectAll(d); this.emit('selection'); }
  deselect() { const d = this.doc; if (!d?.selection) return; this.edit('Deselect'); d.selection = null; d.selRev++; this.emit('selection'); }
  inverseSelection() { const d = this.doc; if (!d) return; this.edit('Inverse'); Sel.invertSelection(d); this.emit('selection'); }
  /** Select › Mask's Black Areas (loadMaskSelection): the mask's pixels darker than 50% gray, where the mask sits. */
  selectMaskBlack(l = this.active) {
    const d = this.doc; if (!d || !l?.mask) return;
    const m = l.mask, md = ctx2d(m).getImageData(0, 0, m.width, m.height);
    let any = false;
    for (let i = 0; i < md.data.length; i += 4) { const dark = md.data[i] < 128; any ||= dark; md.data[i] = md.data[i + 1] = md.data[i + 2] = 255; md.data[i + 3] = dark ? 255 : 0; }
    if (!any) { toast('The mask has no black areas.'); return; }
    const src = canvasOf(m.width, m.height); ctx2d(src).putImageData(md, 0, 0);
    const c = canvasOf(d.width, d.height), x = ctx2d(c), t = pixelToDoc(maskTransformOf(l), m.width, m.height);
    x.imageSmoothingEnabled = false; x.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]); x.drawImage(src, 0, 0);
    this.edit('Load Mask Selection'); d.selection = c; d.selRev++; this.emit('selection');
  }
  selectLayerPixels() { const d = this.doc, a = this.active; if (!d || !a) return; this.edit("Select Layer's Pixels"); Sel.layerPixelsSelection(d, a); this.emit('selection'); }
  modifySelection(op: 'expand' | 'contract' | 'feather', amount: number) {
    const d = this.doc; if (!d?.selection) return;
    this.edit(op[0].toUpperCase() + op.slice(1) + ' Selection');
    if (op === 'feather') Sel.featherSelection(d, amount); else Sel.growSelection(d, op === 'expand' ? amount : -amount);
    this.emit('selection');
  }

  // ---------- pixel edits ----------
  /** Writes through the selection: `paint` draws into a copy that is then kept only where selected. */
  editPixels(label: string, paint: (x: CanvasRenderingContext2D, c: HTMLCanvasElement, layer: Layer) => void, clipToSelection = true) {
    const d = this.doc, a = this.active; if (!d || !a) return;
    const target = this.maskTarget && a.mask ? 'mask' : 'pixels';
    if (target === 'pixels' && !a.canvas) { toast('Select a pixel layer first.'); return; }
    this.edit(label);
    const c = target === 'mask' ? this.ownMask(a) : this.ownPixels(a);
    const sel = clipToSelection ? Sel.selectionInLayer(d, target === 'mask' ? maskGridView(a) : a, c.width, c.height) : null;
    if (!sel) { const x = ctx2d(c); x.save(); paint(x, c, a); x.restore(); }
    else {
      const work = cloneCanvas(c), wx = ctx2d(work);
      wx.save(); paint(wx, work, a); wx.restore();
      // result = work inside selection, original outside
      const inside = canvasOf(c.width, c.height), ix = ctx2d(inside);
      ix.drawImage(work, 0, 0); ix.globalCompositeOperation = 'destination-in'; ix.drawImage(sel, 0, 0);
      const x = ctx2d(c); x.save(); x.globalCompositeOperation = 'destination-out'; x.drawImage(sel, 0, 0); x.globalCompositeOperation = 'source-over'; x.drawImage(inside, 0, 0); x.restore();
    }
    if (target === 'pixels') this.rasterize(a);
    a.rev++;
    this.changed('pixels');
  }
  fill(color: RGB) {
    const a = this.active;
    const css = this.maskTarget && a?.mask ? this.grayCss(color) : rgbCss(color);
    this.editPixels('Fill', (x, c) => { x.fillStyle = css; x.fillRect(0, 0, c.width, c.height); });
  }
  grayCss(c: RGB) { const g = Math.round((0.299 * c.red + 0.587 * c.green + 0.114 * c.blue) * 255); return `rgb(${g},${g},${g})`; }
  clearSelected() {
    const d = this.doc, a = this.active; if (!d || !a) return;
    if (!d.selection) { this.deleteLayers(); return; }
    if (this.maskTarget && a.mask) { this.editPixels('Clear', (x, c) => { x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height); }); return; }
    this.editPixels('Clear', (x, c) => x.clearRect(0, 0, c.width, c.height));
  }
  contentAwareFill() {
    const d = this.doc, a = this.active; if (!d || !a?.canvas) return;
    if (!d.selection) { toast('Content-Aware Fill needs a selection.'); return; }
    const sel = Sel.selectionInLayer(d, a, a.canvas.width, a.canvas.height)!;
    const sd = ctx2d(sel).getImageData(0, 0, sel.width, sel.height).data, mask = new Uint8Array(sel.width * sel.height);
    for (let i = 0; i < mask.length; i++) mask[i] = sd[i * 4 + 3] > 127 ? 255 : 0;
    this.edit('Content-Aware Fill');
    const c = this.ownPixels(a), img = imageDataOf(c);
    const r = contentFill(img, mask);
    if (r !== 1) { this.undo(); toast(r === 0 ? 'No source pixels to fill from.' : 'Out of memory.', 'error'); return; }
    ctx2d(c).putImageData(img, 0, 0); a.rev++; this.rasterize(a);
    this.changed('pixels');
  }
  /** Runs a filter/adjustment over the active layer (through the selection), in the filter workers. */
  filtering = 0;
  async runFilter(kind: FilterKind, s: FilterSettings, seed: number, label = kind) {
    const d = this.doc, a = this.active; if (!d || !a) return;
    const onMask = this.maskTarget && !!a.mask;
    if (!onMask && !a.canvas) { toast('Select a pixel layer first.'); return; }
    const src = onMask ? a.mask! : a.canvas!;
    const scale = src.width / (onMask ? maskTransformOf(a) : a.transform).w;
    this.filtering++; document.body.classList.add('busy');
    try {
      const out = await applyFilterAsync(kind, s, imageDataOf(src), { seed, scale: isFinite(scale) && scale > 0 ? scale : 1,
        canvasFrame: this.isEmptyLayer(src) ? this.canvasFrameIn(onMask ? maskGridView(a) : a, src) : undefined });
      // The layer changed while the filter ran (another edit, undo): applying the result would overwrite that.
      if (this.doc !== d || this.active !== a || (onMask ? a.mask : a.canvas) !== src) { toast(`${label} was not applied: the layer changed.`); return; }
      this.editPixels(label, x => x.putImageData(out, 0, 0));
    } catch (e) { toast(`${label} failed: ${(e as Error).message}`, 'error'); }
    finally { if (--this.filtering === 0 && !this.busy) document.body.classList.remove('busy'); }
  }
  isEmptyLayer(c: HTMLCanvasElement) { const b = alphaBounds(imageDataOf(c)); return b[2] <= b[0] || b[3] <= b[1]; }
  canvasFrameIn(l: Layer, c: HTMLCanvasElement): [number, number, number, number] {
    const inv = invert(layerMatrix(l)); const [x0, y0] = apply(inv, 0, 0); const [x1, y1] = apply(inv, this.doc!.width, this.doc!.height);
    return [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)]; void c;
  }
  invertPixels() {
    const a = this.active; if (!a) return;
    if (a.adjustment) return;
    this.editPixels(this.maskTarget ? 'Invert Mask' : 'Invert', (x, c) => {
      if (this.maskTarget) { x.globalCompositeOperation = 'difference'; x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); return; }
      const img = x.getImageData(0, 0, c.width, c.height), dd = img.data;
      for (let i = 0; i < dd.length; i += 4) { dd[i] = 255 - dd[i]; dd[i + 1] = 255 - dd[i + 1]; dd[i + 2] = 255 - dd[i + 2]; }
      x.putImageData(img, 0, 0);
    });
  }

  // ---------- transforms ----------
  flipLayers(horizontal: boolean) {
    const d = this.doc; if (!d) return;
    const ids = d.selectedIds.length ? d.selectedIds : d.activeId ? [d.activeId] : [];
    this.edit(horizontal ? 'Flip Layer Horizontal' : 'Flip Layer Vertical');
    for (const id of ids) { const l = getLayer(d, id); if (!l) continue; if (horizontal) l.transform.flipX = !l.transform.flipX; else l.transform.flipY = !l.transform.flipY; }
    this.changed('layers');
  }
  flipCanvas(horizontal: boolean) {
    const d = this.doc; if (!d) return;
    this.edit(horizontal ? 'Flip Canvas Horizontal' : 'Flip Canvas Vertical');
    for (const l of d.layers) eachTransform(l, t => {
      if (horizontal) { t.x = d.width - t.x - t.w; t.flipX = !t.flipX; t.rotation = -t.rotation; }
      else { t.y = d.height - t.y - t.h; t.flipY = !t.flipY; t.rotation = -t.rotation; }
    });
    if (d.selection) { const c = canvasOf(d.width, d.height), x = ctx2d(c); x.translate(horizontal ? d.width : 0, horizontal ? 0 : d.height); x.scale(horizontal ? -1 : 1, horizontal ? 1 : -1); x.drawImage(d.selection, 0, 0); d.selection = c; d.selRev++; }
    this.changed('layers');
  }
  setTransform(l: Layer, t: Transform, label = 'Transform', coalesce = false) {
    if (!coalesce) this.edit(label);
    l.transform = t; this.redrawShape(l); this.changed('transform');
  }
  /** CanvasResizer: the anchor keeps a point fixed (whole pixels; floor puts an odd extra pixel right/bottom). A fill
   *  color adds a bottom "Canvas Extension" layer covering only the added area. */
  canvasSize(w: number, h: number, ax: number, ay: number, fill?: { red: number; green: number; blue: number } | null) {
    const d = this.doc; if (!d) return;
    const dx = Math.floor((w - d.width) * ax), dy = Math.floor((h - d.height) * ay);
    if (w === d.width && h === d.height && !dx && !dy) return;
    this.edit('Canvas Size');
    for (const l of d.layers) eachTransform(l, t => { t.x += dx; t.y += dy; });
    for (const g of d.guides) g.position += g.axis === 'vertical' ? dx : dy;
    if (d.selection) { const c = canvasOf(w, h); ctx2d(c).drawImage(d.selection, dx, dy); d.selection = c; d.selRev++; }
    if (fill && (w > d.width || h > d.height)) {
      const c = canvasOf(w, h), x = ctx2d(c);
      x.fillStyle = `rgb(${Math.round(fill.red * 255)},${Math.round(fill.green * 255)},${Math.round(fill.blue * 255)})`; x.fillRect(0, 0, w, h);
      x.clearRect(dx, dy, d.width, d.height);
      const l = newPixelLayer(d, 'Canvas Extension', c, { x: 0, y: 0, w, h });
      d.layers.unshift(l);
    }
    d.width = w; d.height = h;
    this.fit(); this.changed('canvas');
  }
  /** ImageResizer: resamples every layer (Sampling) and scales guides; without resampling only the resolution changes. */
  imageSize(w: number, h: number, opts: { resolution?: number; sampling?: 'High quality' | 'Smooth' | 'Nearest'; resample?: boolean } = {}) {
    const d = this.doc; if (!d) return;
    if (opts.resample === false) {
      if (opts.resolution && opts.resolution !== d.resolution) { this.edit('Image Size'); d.resolution = opts.resolution; this.changed('canvas'); }
      return;
    }
    this.edit('Image Size');
    if (opts.resolution) d.resolution = opts.resolution;
    const smooth = opts.sampling !== 'Nearest', quality: ImageSmoothingQuality = opts.sampling === 'Smooth' ? 'medium' : 'high';
    for (const g of d.guides) g.position *= g.axis === 'vertical' ? w / d.width : h / d.height;
    const sx = w / d.width, sy = h / d.height;
    for (const l of d.layers) {
      eachTransform(l, t => { t.x *= sx; t.y *= sy; t.w *= sx; t.h *= sy; });
      // Resample pixels so the stored image matches its new size (as the Mac app does).
      if (l.canvas && !l.isGroup) {
        const nw = Math.max(1, Math.round(l.canvas.width * sx)), nh = Math.max(1, Math.round(l.canvas.height * sy));
        const c = canvasOf(nw, nh), x = ctx2d(c); x.imageSmoothingEnabled = smooth; x.imageSmoothingQuality = quality; x.drawImage(l.canvas, 0, 0, nw, nh); l.canvas = c;
        if (l.mask && !l.maskPlacement) { const m = canvasOf(nw, nh), mx = ctx2d(m); mx.imageSmoothingEnabled = smooth; mx.imageSmoothingQuality = quality; mx.drawImage(l.mask, 0, 0, nw, nh); l.mask = m; }
        if (l.text) l.text = { ...l.text, fontSize: l.text.fontSize * sx, boxSize: l.text.boxSize ? { width: l.text.boxSize.width * sx, height: l.text.boxSize.height * sy } : undefined };
      }
      l.rev++;
    }
    if (d.selection) { const c = canvasOf(w, h); ctx2d(c).drawImage(d.selection, 0, 0, w, h); d.selection = c; d.selRev++; }
    d.width = w; d.height = h;
    this.fit(); this.changed('canvas');
  }
  cropTo(r: { x: number; y: number; w: number; h: number }) {
    const d = this.doc; if (!d) return;
    const w = Math.max(1, Math.round(r.w)), h = Math.max(1, Math.round(r.h)), x0 = Math.round(r.x), y0 = Math.round(r.y);
    this.edit('Crop');
    for (const l of d.layers) eachTransform(l, t => { t.x -= x0; t.y -= y0; });
    if (d.selection) { const c = canvasOf(w, h); ctx2d(c).drawImage(d.selection, -x0, -y0); d.selection = Sel.isEmpty(c) ? null : c; d.selRev++; }
    d.width = w; d.height = h;
    this.fit(); this.changed('canvas');
  }
  /** Image › Trim… (ImageTrim.calculateTrimRect): cut away the edges that are transparent, or the color of the top
   *  left or bottom right pixel, on the chosen sides. */
  trim(o: { basedOn?: 'Transparent Pixels' | 'Top Left Pixel Color' | 'Bottom Right Pixel Color'; top?: boolean; bottom?: boolean; left?: boolean; right?: boolean; tolerance?: number } = {}) {
    const d = this.doc; if (!d) return;
    const basedOn = o.basedOn ?? 'Transparent Pixels', sides = { top: o.top ?? true, bottom: o.bottom ?? true, left: o.left ?? true, right: o.right ?? true };
    const img = this.renderer.readComposite(d), W = img.width, H = img.height, p = img.data;
    let x0: number, y0: number, x1: number, y1: number;
    if (basedOn === 'Transparent Pixels') [x0, y0, x1, y1] = alphaBounds(img);
    else {
      // Premultiplied, as the Mac app compares them.
      const s = basedOn === 'Top Left Pixel Color' ? 0 : (W * H - 1) * 4, tol = o.tolerance ?? 0;
      const pm = (i: number, c: number) => c === 3 ? p[i + 3] : Math.round(p[i + c] * p[i + 3] / 255);
      const t = [0, 1, 2, 3].map(c => pm(s, c));
      const match = (x: number, y: number) => { const i = (y * W + x) * 4; for (let c = 0; c < 4; c++) if (Math.abs(pm(i, c) - t[c]) > tol) return false; return true; };
      x0 = W; x1 = 0; y0 = H; y1 = 0;
      for (let y = 0; y < H; y++) {
        let first = 0; while (first < W && match(first, y)) first++;
        if (first === W) continue;
        let last = W; while (last > first && match(last - 1, y)) last--;
        x0 = Math.min(x0, first); x1 = Math.max(x1, last); y0 = Math.min(y0, y); y1 = y + 1;
      }
    }
    if (x1 <= x0 || y1 <= y0) { toast('No content remained after trimming.'); return; }
    const r = { x: sides.left ? x0 : 0, y: sides.top ? y0 : 0, x1: sides.right ? x1 : W, y1: sides.bottom ? y1 : H };
    if (r.x === 0 && r.y === 0 && r.x1 === W && r.y1 === H) { toast('Nothing to trim.'); return; }
    this.cropTo({ x: r.x, y: r.y, w: r.x1 - r.x, h: r.y1 - r.y });
  }

  // ---------- effects ----------
  addEffect(key: EffectKey) {
    const a = this.active; if (!a || a.isGroup || a.adjustment) return;
    this.edit(`Add ${key}`);
    const e: Effects = a.effects ? structuredClone(a.effects) : {};
    const defaults: Effects = {
      stroke: { size: 4, red: 0, green: 0, blue: 0, opacity: 1, inside: false },
      shadow: { angle: 90, distance: 20, blur: 20, red: 0, green: 0, blue: 0, opacity: 0.5 },
      colorOverlay: { red: this.fg.red, green: this.fg.green, blue: this.fg.blue, opacity: 1 },
      innerShadow: { angle: 90, distance: 10, blur: 10, red: 0, green: 0, blue: 0, opacity: 0.5 },
      outerGlow: { size: 20, red: 1, green: 1, blue: 1, opacity: 0.75 },
      innerGlow: { size: 10, red: 1, green: 1, blue: 1, opacity: 0.75 },
    };
    (e as Record<string, unknown>)[key] = (e as Record<string, unknown>)[key] ?? defaults[key];
    a.effects = e; a.rev++;
    this.changed('layers');
  }

  // ---------- shapes ----------
  /** ShapeTool.redrawShape: a shape layer scaled to a new size draws its shape again at that size, so a rounded corner
   *  keeps its radius instead of stretching. Part of the edit that changed the size. */
  redrawShape(l: Layer) {
    if (!l.shape || !l.canvas) return;
    const w = Math.max(1, Math.round(Math.abs(l.transform.w))), h = Math.max(1, Math.round(Math.abs(l.transform.h)));
    if ((w === l.canvas.width && h === l.canvas.height) || w * h > 64e6) return;
    // A mask that follows the layer's pixel grid stays exactly where it is while that grid changes size.
    if (l.mask && !l.maskPlacement) { l.maskPlacement = { ...l.transform }; l.maskBase = { ...l.transform }; }
    l.canvas = renderShape(l.shape, w, h); l.rev++;
  }
  /** Edit a live shape's style (color, corner radius, line width), redrawn at its current size. */
  updateShape(l: Layer, style: NonNullable<Layer['shape']>, label = 'Edit Shape') {
    if (this.history?.undoLabel !== label) this.edit(label);
    const w = Math.max(1, Math.round(Math.abs(l.transform.w))), h = Math.max(1, Math.round(Math.abs(l.transform.h)));
    if (l.mask && !l.maskPlacement && l.canvas && (l.canvas.width !== w || l.canvas.height !== h)) { l.maskPlacement = { ...l.transform }; l.maskBase = { ...l.transform }; }
    l.shape = style; l.canvas = renderShape(style, w, h); l.rev++;
    this.changed('pixels');
  }

  // ---------- text ----------
  updateText(l: Layer, text: NonNullable<Layer['text']>, label = 'Edit Text') {
    this.edit(label);
    const scale = l.canvas ? l.transform.w / l.canvas.width : 1;
    l.text = text; l.canvas = renderText(text);
    const cx = l.transform.x, cy = l.transform.y;
    l.transform = { ...l.transform, x: cx, y: cy, w: l.canvas.width * scale, h: l.canvas.height * scale };
    l.rev++;
    this.changed('layers');
  }

  // ---------- view ----------
  stageSize = { w: 800, h: 600 };
  /** How much of the stage's bottom a sheet covers (phones: filter panels, the Layers sheet); Fit centers above it. */
  viewInsetBottom = 0;
  fit() {
    const p = this.project; if (!p) return;
    // Phones keep the canvas big; a bottom sheet covering part of the stage (viewInsetBottom) is left out.
    const w = this.stageSize.w, h = Math.max(80, this.stageSize.h - this.viewInsetBottom), pad = Math.min(w, h) < 600 ? 12 : 40;
    p.zoom = Math.min(1, Math.min((w - pad * 2) / p.doc.width, (h - pad * 2) / p.doc.height));
    if (!isFinite(p.zoom) || p.zoom <= 0) p.zoom = 1;
    p.ox = (w - p.doc.width * p.zoom) / 2; p.oy = (h - p.doc.height * p.zoom) / 2;
    p.fitted = true;
    this.emit('view');
  }
  zoomTo(z: number, cx = this.stageSize.w / 2, cy = this.stageSize.h / 2) {
    const p = this.project; if (!p) return;
    z = Math.min(64, Math.max(0.01, z));
    const dx = (cx - p.ox) / p.zoom, dy = (cy - p.oy) / p.zoom;
    p.zoom = z; p.ox = cx - dx * z; p.oy = cy - dy * z; p.fitted = false;
    this.emit('view');
  }
  zoomStep(dir: number, cx?: number, cy?: number) {
    const p = this.project; if (!p) return;
    const steps = [0.01, 0.02, 0.03, 0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 64];
    const z = p.zoom;
    const next = dir > 0 ? steps.find(s => s > z * 1.001) ?? 64 : [...steps].reverse().find(s => s < z * 0.999) ?? 0.01;
    this.zoomTo(next, cx, cy);
  }
  toDoc(sx: number, sy: number): [number, number] { const p = this.project!; return [(sx - p.ox) / p.zoom, (sy - p.oy) / p.zoom]; }
  toScreen(x: number, y: number): [number, number] { const p = this.project!; return [x * p.zoom + p.ox, y * p.zoom + p.oy]; }

  // ---------- files ----------
  /** `handle`: the file's handle when it came from one (Open Recent), so Save writes back to it. */
  /** Set by the dialogs module: the PSD conversion sheet. */
  confirmConversions: ((title: string, confirmTitle: string, conversions: PsdConversion[]) => Promise<boolean>) | null = null;
  async openFiles(files: File[], asLayers = false, handle?: FileSystemFileHandle) {
    for (const f of files) {
      try {
        if (isCompZip(f)) {
          const doc = await readCompZip(new Uint8Array(await f.arrayBuffer()), f.name); if (handle) doc.fileHandle = handle;
          this.addProject(doc); this.fit(); void noteRecent(f.name, handle ? { handle } : { blob: f });
        }
        else if (isPsd(f)) {
          // PSDConversionSheet: what had to change is listed first, and nothing opens unless you continue.
          const { doc, conversions } = await readPsdFile(await f.arrayBuffer(), f.name);
          if (conversions.length && this.confirmConversions && !await this.confirmConversions(`Open “${f.name}”?`, 'Import', conversions)) continue;
          this.addProject(doc); this.fit(); void noteRecent(f.name, { blob: f });
        }
        else if (isImageFile(f)) {
          const c = await fileToCanvas(f);
          const name = f.name.replace(/\.[^.]+$/, '');
          if (asLayers && this.doc) this.placeImage(c, name);
          else {
            const doc = newDoc(c.width, c.height, this.uniqueName(name));
            const l = newPixelLayer(doc, name, c); doc.layers.push(l); doc.activeId = l.id; doc.selectedIds = [l.id];
            this.addProject(doc); this.fit();
          }
        } else toast(`Can’t open ${f.name}: unsupported format.`, 'error');
      } catch (e) { if ((e as Error).name === 'AbortError') continue; console.warn(e); toast(`Couldn’t open ${f.name}: ${(e as Error).message}`, 'error'); }
    }
  }
  /** File › Open Recent. An entry whose file is gone is dropped from the list. */
  async openRecent(e: RecentEntry) {
    let f: File;
    try { f = await recentFile(e); }
    catch (err) { console.warn(err); toast(`Couldn’t open “${e.name}”. It may have been moved or deleted.`, 'error'); await forgetRecent(e.key); return; }
    await this.openFiles([f], false, e.handle);
  }
  async openFolder(list: FileList) {
    try { const doc = await readCompFolder(list); this.addProject(doc); this.fit(); }
    catch (e) { toast(`Couldn’t open project: ${(e as Error).message}`, 'error'); }
  }
  /** Imports an image as a new layer, centered, scaled down to fit the canvas if larger (Photoshop.eth's import). */
  placeImage(c: HTMLCanvasElement, name: string, at?: [number, number]) {
    const d = this.doc!;
    this.edit('Import Image');
    const s = Math.min(1, d.width / c.width, d.height / c.height);
    const w = c.width * s, h = c.height * s;
    const cx = at ? at[0] : d.width / 2, cy = at ? at[1] : d.height / 2;
    const l = newPixelLayer(d, name, c, { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w: Math.round(w), h: Math.round(h) });
    this.insertAboveActive(l);
    this.maskTarget = false;
    this.changed('layers');
  }
  async save() {
    const d = this.doc; if (!d) return;
    this.commitFloating();
    const bytes = await writeComp(d);
    const name = `${d.name || 'Untitled'}.comp.zip`;
    const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> };
    if (w.showSaveFilePicker && !(window as unknown as { __noPicker?: boolean }).__noPicker) {
      try {
        const handle = (d.fileHandle as FileSystemFileHandle | undefined) ?? await w.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Photoshop.eth project (zipped)', accept: { 'application/zip': ['.zip'] } }] });
        const wr = await handle.createWritable(); await wr.write(bytes as unknown as BufferSource); await wr.close();
        d.fileHandle = handle; void noteRecent(handle.name, { handle });
      } catch (e) { if ((e as Error).name === 'AbortError') return; download(bytes, name, 'application/zip'); void noteRecent(name, { blob: new Blob([bytes as BlobPart], { type: 'application/zip' }) }); }
    } else { download(bytes, name, 'application/zip'); void noteRecent(name, { blob: new Blob([bytes as BlobPart], { type: 'application/zip' }) }); }
    d.dirty = false; toast(`Saved ${name}`); this.emit('saved');
  }
  /** File › Save as .comp Folder… (Chromium): the Mac app's package layout written into a picked directory. */
  async saveFolder(dir?: FileSystemDirectoryHandle) {
    const d = this.doc; if (!d) return;
    this.commitFloating();
    const w = window as unknown as { showDirectoryPicker?: (o: unknown) => Promise<FileSystemDirectoryHandle> };
    if (!dir) {
      if (!w.showDirectoryPicker) { toast('This browser can’t write folders. Use Save (a zipped .comp) instead.', 'error'); return; }
      try { dir = await w.showDirectoryPicker({ mode: 'readwrite', id: 'compositor-projects' }); } catch (e) { if ((e as Error).name === 'AbortError') return; throw e; }
    }
    const name = await writeCompToDirectory(d, dir);
    d.dirty = false; toast(`Saved ${name} (folder)`); this.emit('saved');
  }
  async saveAs() { const d = this.doc; if (!d) return; d.fileHandle = undefined; await this.save(); }
  async exportImage(type: 'png' | 'jpeg', quality = 0.92, matte: RGB = { red: 1, green: 1, blue: 1 }) {
    const d = this.doc; if (!d) return;
    this.commitFloating();
    const img = this.renderer.readComposite(d);
    const c = canvasOf(d.width, d.height), x = ctx2d(c);
    if (type === 'jpeg') { x.fillStyle = `rgb(${Math.round(matte.red * 255)},${Math.round(matte.green * 255)},${Math.round(matte.blue * 255)})`; x.fillRect(0, 0, c.width, c.height); const t = canvasOf(d.width, d.height); ctx2d(t).putImageData(img, 0, 0); x.drawImage(t, 0, 0); }
    else x.putImageData(img, 0, 0);
    const blob = await canvasToBlob(c, `image/${type}`, quality);
    download(blob, `${d.name || 'Untitled'}.${type === 'png' ? 'png' : 'jpg'}`);
  }
  async exportTiff() {
    const d = this.doc; if (!d) return;
    this.commitFloating();
    const { canvasToTiff } = await import('../engine/tiff');
    download(await canvasToTiff(this.renderer.readComposite(d)), `${d.name || 'Untitled'}.tif`, 'image/tiff');
  }
  async copyMerged() {
    const d = this.doc; if (!d) return;
    const img = this.renderer.readComposite(d);
    let c = canvasOf(d.width, d.height); ctx2d(c).putImageData(img, 0, 0);
    const b = Sel.selectionBounds(d);
    if (b && d.selection) { const t = canvasOf(b.w, b.h), tx = ctx2d(t); tx.drawImage(c, -b.x, -b.y); tx.globalCompositeOperation = 'destination-in'; tx.drawImage(d.selection, -b.x, -b.y); c = t; }
    try { const blob = await canvasToBlob(c, 'image/png'); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Copied merged'); }
    catch { toast('Clipboard is not available in this browser context.', 'error'); }
  }
  clipboardLayer: Layer | null = null;
  async copy(cut = false) {
    const d = this.doc, a = this.active; if (!d || !a) return;
    if (d.selection && a.canvas) {
      const sel = Sel.selectionInLayer(d, a, a.canvas.width, a.canvas.height)!;
      const c = cloneCanvas(a.canvas), x = ctx2d(c); x.globalCompositeOperation = 'destination-in'; x.drawImage(sel, 0, 0);
      this.clipboardLayer = { ...a, id: uuid(), canvas: c, mask: null, name: `${a.name} copy`, text: undefined, shape: undefined, transform: { ...a.transform }, rev: 1 };
      if (cut) this.clearSelected();
      try { const blob = await canvasToBlob(c, 'image/png'); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); } catch { /* in-app clipboard still works */ }
    } else {
      this.clipboardLayer = { ...a, id: uuid(), canvas: a.canvas ? cloneCanvas(a.canvas) : null, mask: a.mask ? cloneCanvas(a.mask) : null, transform: { ...a.transform }, rev: 1, parentId: null };
      if (cut) this.deleteLayers();
    }
  }
  /** Pastes an image from the system clipboard: as a new layer when a document is open, otherwise as a new document
   *  sized exactly to the image (scaled down only where the device's canvas limits require it), with the image as its
   *  only layer. */
  async pasteImage(blob: Blob) {
    const type = blob.type || 'image/png';
    const c = await fileToCanvas(new File([blob], 'Pasted image', { type }));
    if (this.doc) { this.placeImage(c, 'Pasted'); return; }
    const doc = newDoc(c.width, c.height, this.uniqueName('Pasted'));
    const l = newPixelLayer(doc, 'Pasted', c); doc.layers.push(l); doc.activeId = l.id; doc.selectedIds = [l.id];
    this.addProject(doc); this.fit();
  }
  /** Edit › Paste (and the welcome screen's Paste button): reads the clipboard with the async Clipboard API. */
  async paste() {
    const d = this.doc;
    let denied = false;
    if (!(this.clipboardLayer && d)) {
      try {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          const type = it.types.find(t => t.startsWith('image/'));
          if (type) { await this.pasteImage(await it.getType(type)); return; }
        }
      } catch (e) { denied = (e as Error).name !== 'DataError'; /* fall back to the in-app clipboard */ }
    }
    if (this.clipboardLayer && d) {
      this.edit('Paste');
      const l = { ...this.clipboardLayer, id: uuid(), canvas: this.clipboardLayer.canvas ? cloneCanvas(this.clipboardLayer.canvas) : null, transform: { ...this.clipboardLayer.transform }, rev: 1, clipTo: null };
      this.insertAboveActive(l); this.changed('layers');
    } else if (!d) {
      toast(denied ? 'Couldn’t read the clipboard here. Press ⌘V / Ctrl+V instead, or allow clipboard access.' : 'There’s no image on the clipboard.', denied ? 'error' : undefined);
    }
  }
  blendIndex(mode: BlendMode, delta: number): BlendMode { const i = BLEND_MODES.indexOf(mode); return BLEND_MODES[(i + delta + BLEND_MODES.length) % BLEND_MODES.length]; }
}
export const app = new App();
