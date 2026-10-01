// The window: ContentView.swift's layout (toolbar with project tabs, tool header, tool rail, canvas, Layers panel,
// status bar) plus the menu bar from CompositorApp.swift's commands, and the keyboard shortcuts.
import { app, TOOLS, type Tool } from './app';
import { CanvasController } from './tools';
import { h, icon, slider, select, checkbox, button, showMenu, closeMenus, toHex, fromHex, type MenuItem, toast } from './dom';
import { openFilter, editAdjustment, openEffects, newCanvasForm, showNewCanvas, showCanvasSize, showImageSize, showSelectionAmount, showExportJpeg, showGridSettings, showNewGuide, showShortcuts, closeOpenPanel, hasOpenPanel } from './dialogs';
import { fileToCanvas } from '../engine/files';
import { view, setView, clearGuides } from './guides';
import { newPixelLayer, renderText, BLEND_GROUPS, BLEND_MODES, EFFECT_NAMES, type EffectKey, type Layer, type BlendMode, childrenOf, ancestors, getLayer, isEffectivelyVisible } from '../engine/document';
import { ADJUSTMENT_KINDS, FILTER_MENU, IMAGE_ADJUSTMENTS, type FilterKind } from '../engine/adjustments';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';
let ctl: CanvasController;
const els: Record<string, HTMLElement> = {};

export function buildLayout(root: HTMLElement) {
  els.menubar = h('div', { class: 'menubar' });
  els.tabs = h('div', { class: 'tabs' });
  els.toolbar = h('div', { class: 'toolbar' },
    h('button', { class: 'tb-btn', title: `New canvas (${MOD}N)`, id: 'newCanvasToolbar', onclick: () => showNewCanvas() }, icon('plus', 16)),
    els.tabs, h('div', { class: 'spacer' }),
    h('button', { class: 'tb-btn text', title: `Fit canvas in window (${MOD}0)`, onclick: () => app.fit() }, 'Fit'),
    h('button', { class: 'tb-btn text', title: `Actual pixels (${MOD}1)`, onclick: () => app.zoomTo(1) }, '100%'),
    h('div', { class: 'tb-group' },
      h('button', { class: 'tb-btn', title: `Zoom in (${MOD}+)`, onclick: () => app.zoomStep(1) }, icon('zoomIn', 16)),
      h('button', { class: 'tb-btn', title: `Zoom out (${MOD}−)`, onclick: () => app.zoomStep(-1) }, icon('zoomOut', 16))));
  els.header = h('div', { class: 'tool-header' });
  els.rail = h('div', { class: 'tool-rail' });
  els.stage = h('div', { class: 'stage', id: 'stage' });
  els.welcome = h('div', { class: 'welcome' });
  els.layers = h('div', { class: 'layers-panel' });
  els.status = h('div', { class: 'status-bar' });
  els.fileInput = h('input', { type: 'file', multiple: true, accept: 'image/*,.psd,.psb,.zip,.comp,.svg', style: 'display:none', id: 'file-input' });
  els.folderInput = h('input', { type: 'file', style: 'display:none', id: 'folder-input' });
  (els.folderInput as HTMLInputElement).setAttribute('webkitdirectory', '');
  root.append(els.menubar, els.toolbar, els.header,
    h('div', { class: 'main' }, els.rail, h('div', { class: 'stage-wrap' }, els.stage, els.welcome), h('div', { class: 'resize-edge' }), els.layers),
    els.status, els.fileInput, els.folderInput);
  ctl = new CanvasController(els.stage);
  (window as unknown as { compositor: unknown }).compositor = { app, ctl };
  buildMenubar(); buildRail();
  els.fileInput.addEventListener('change', () => {
    const inp = els.fileInput as HTMLInputElement, files = Array.from(inp.files ?? []);
    app.openFiles(files, inp.dataset.mode === 'import'); inp.value = '';
  });
  els.folderInput.addEventListener('change', () => { const inp = els.folderInput as HTMLInputElement; if (inp.files?.length) app.openFolder(inp.files); inp.value = ''; });
  setupResize(); setupDrop(); setupKeys();
  app.on(what => refresh(what));
  refresh('all');
  // Render loop: the GPU composites only when something changed; marching ants animate.
  let lastAnts = 0;
  const loop = (t: number) => {
    if (app.doc?.selection || ctl.marquee || ctl.lasso) { if (t - lastAnts > 120) { ctl.antsPhase = (ctl.antsPhase + 1) % 8; lastAnts = t; app.needsRender = true; } }
    if (app.needsRender) { app.needsRender = false; try { ctl.frame(); } catch (e) { console.error(e); } }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
export function openFileDialog(mode: 'open' | 'import') { const i = els.fileInput as HTMLInputElement; i.dataset.mode = mode; i.click(); }

function refresh(what: string) {
  if (what === 'view' || what === 'transform-live') { renderStatus(); if (what === 'transform-live') renderHeader(); return; }
  renderTabs(); renderHeader(); renderStatus(); renderLayers(); renderRail(); renderWelcome();
  document.title = app.doc ? `${app.doc.name}${app.doc.dirty ? ' — Edited' : ''} — Compositor` : 'Compositor';
}

// ---------- menu bar ----------
function buildMenubar() {
  const menus: [string, () => MenuItem[]][] = [
    ['Compositor', () => [
      { label: 'About Compositor', action: () => toast('Compositor for the web — a port of robbietilton/Compositor (MIT). Pixel kernels: original C, compiled to WebAssembly.') },
      { separator: true }, { label: 'Keyboard Shortcuts…', action: showShortcuts },
    ]],
    ['File', () => [
      { label: 'New Canvas…', shortcut: `${MOD}N`, action: showNewCanvas },
      { label: 'Open…', shortcut: `${MOD}O`, action: () => openFileDialog('open') },
      { label: 'Open Project Folder (.comp)…', action: () => els.folderInput.click() },
      { label: 'Import Images…', shortcut: `⇧${MOD}O`, action: () => openFileDialog('import'), disabled: !app.doc },
      { separator: true },
      { label: 'Save', shortcut: `${MOD}S`, action: () => app.save(), disabled: !app.doc },
      { label: 'Save As…', shortcut: `⇧${MOD}S`, action: () => app.saveAs(), disabled: !app.doc },
      { separator: true },
      { label: 'Export PNG…', shortcut: `⇧${MOD}E`, action: () => app.exportImage('png'), disabled: !app.doc },
      { label: 'Export JPEG…', shortcut: `⌥⇧${MOD}S`, action: showExportJpeg, disabled: !app.doc },
      { separator: true },
      { label: 'Close Project', shortcut: `${MOD}W`, action: () => app.closeProject(), disabled: !app.doc },
    ]],
    ['Edit', () => [
      { label: app.history?.undoLabel ? `Undo ${app.history.undoLabel.replace(/[0-9A-F-]{36}$/, '')}` : 'Undo', shortcut: `${MOD}Z`, action: () => app.undo(), disabled: !app.history?.undoLabel },
      { label: app.history?.redoLabel ? `Redo ${app.history.redoLabel.replace(/[0-9A-F-]{36}$/, '')}` : 'Redo', shortcut: `⇧${MOD}Z`, action: () => app.redo(), disabled: !app.history?.redoLabel },
      { separator: true },
      { label: 'Cut', shortcut: `${MOD}X`, action: () => app.copy(true), disabled: !app.active },
      { label: 'Copy', shortcut: `${MOD}C`, action: () => app.copy(), disabled: !app.active },
      { label: 'Copy Merged', shortcut: `⇧${MOD}C`, action: () => app.copyMerged(), disabled: !app.doc },
      { label: 'Paste', shortcut: `${MOD}V`, action: () => app.paste() },
      { separator: true },
      { label: 'Fill with Foreground Color', shortcut: '⌥⌫', action: () => app.fill(app.fg), disabled: !app.active },
      { label: 'Fill with Background Color', shortcut: `${MOD}⌫`, action: () => app.fill(app.bg), disabled: !app.active },
      { label: 'Clear Selection Pixels', shortcut: '⌫', action: () => app.clearSelected(), disabled: !app.doc?.selection },
      { label: 'Content-Aware Fill…', shortcut: '⇧⌫', action: () => app.contentAwareFill(), disabled: !app.doc?.selection },
      { separator: true },
      { label: 'Free Transform', shortcut: `${MOD}T`, action: () => selectTool('move'), disabled: !app.active },
      { label: 'Keyboard Shortcuts…', action: showShortcuts },
    ]],
    ['Image', () => [
      { label: 'Curves…', shortcut: `${MOD}M`, action: () => openFilter('Curves'), disabled: !app.active },
      { label: 'Levels…', shortcut: `${MOD}L`, action: () => openFilter('Levels'), disabled: !app.active },
      { label: 'Hue/Saturation…', shortcut: `${MOD}U`, action: () => openFilter('Hue/Saturation'), disabled: !app.active },
      ...IMAGE_ADJUSTMENTS.map(k => ({ label: `${k}…`, action: () => openFilter(k), disabled: !app.active })),
      { label: 'Invert', shortcut: `${MOD}I`, action: () => app.invertPixels(), disabled: !app.active },
      { separator: true },
      { label: 'Canvas Size…', shortcut: `⌥${MOD}C`, action: showCanvasSize, disabled: !app.doc },
      { label: 'Image Size…', shortcut: `⌥${MOD}I`, action: showImageSize, disabled: !app.doc },
      { label: 'Trim', action: () => app.trim(), disabled: !app.doc },
      { label: 'Crop to Selection', action: () => { selectTool('crop'); ctl.startCropFromSelection(); }, disabled: !app.doc },
      { separator: true },
      { label: 'Flip Canvas Horizontal', action: () => app.flipCanvas(true), disabled: !app.doc },
      { label: 'Flip Canvas Vertical', action: () => app.flipCanvas(false), disabled: !app.doc },
    ]],
    ['Layer', () => {
      const a = app.active;
      return [
        { label: 'New Blank Layer', shortcut: `⇧${MOD}N`, action: () => app.addBlankLayer(), disabled: !app.doc },
        { label: 'New Adjustment Layer', submenu: ADJUSTMENT_KINDS.map(k => ({ label: k, action: () => { const l = app.addAdjustmentLayer(k); if (l && k !== 'Invert') editAdjustment(l); } })), disabled: !app.doc },
        { label: 'Edit Adjustment…', action: () => a && editAdjustment(a), disabled: !a?.adjustment },
        { label: 'Layer Effects', submenu: (Object.keys(EFFECT_NAMES) as EffectKey[]).map(k => ({ label: `${EFFECT_NAMES[k]}…`, action: () => { app.addEffect(k); if (app.active) openEffects(app.active, k); } })), disabled: !a || a.isGroup || !!a.adjustment },
        { separator: true },
        { label: 'Duplicate Layer / Layer via Copy', shortcut: `${MOD}J`, action: () => app.duplicateLayer(), disabled: !a },
        { label: 'Layer via Cut', shortcut: `⇧${MOD}J`, action: () => app.layerViaCopy(true), disabled: !a?.canvas || !app.doc?.selection },
        { label: 'Delete Layer', action: () => app.deleteLayers(), disabled: !a },
        { label: 'Rename Layer…', action: () => a && renameLayer(a), disabled: !a },
        { separator: true },
        { label: 'Group Selected Layers', shortcut: `${MOD}G`, action: () => app.groupSelected(), disabled: !app.doc },
        { label: 'Ungroup Layers', shortcut: `⇧${MOD}G`, action: () => app.ungroup(), disabled: !a?.isGroup },
        { label: a?.clipTo ? 'Release Clipping Mask' : 'Create Clipping Mask', shortcut: `⌥${MOD}G`, action: () => app.toggleClip(), disabled: !a || a.isGroup },
        { separator: true },
        { label: 'Layer Mask', submenu: [
          { label: 'Reveal All', action: () => app.addMask(false, false), disabled: !!a?.mask },
          { label: 'Hide All', action: () => app.addMask(false, true), disabled: !!a?.mask },
          { label: 'Reveal Selection', action: () => app.addMask(true), disabled: !!a?.mask || !app.doc?.selection },
          { separator: true },
          { label: a?.maskEnabled === false ? 'Enable Mask' : 'Disable Mask', action: () => a && app.setLayerProp(a, 'maskEnabled', !a.maskEnabled, 'Toggle Mask'), disabled: !a?.mask },
          { label: 'Invert Mask', action: () => app.invertMask(), disabled: !a?.mask },
          { label: 'Apply Mask', action: () => app.applyMask(), disabled: !a?.mask || !a.canvas },
          { label: 'Delete Mask', action: () => { if (a?.mask) { app.maskTarget = true; app.deleteLayers(); } }, disabled: !a?.mask },
        ], disabled: !a || a.isGroup },
        { separator: true },
        { label: 'Merge Down / Merge Layers', shortcut: `${MOD}E`, action: () => app.mergeSelected(), disabled: !a },
        { label: 'Merge Group', action: () => app.mergeGroup(), disabled: !a?.isGroup },
        { separator: true },
        { label: 'Move Layer Up', shortcut: `${MOD}]`, action: () => app.moveLayer(1), disabled: !a },
        { label: 'Move Layer Down', shortcut: `${MOD}[`, action: () => app.moveLayer(-1), disabled: !a },
        { separator: true },
        { label: 'Flip Layer Horizontal', action: () => app.flipLayers(true), disabled: !a },
        { label: 'Flip Layer Vertical', action: () => app.flipLayers(false), disabled: !a },
      ];
    }],
    ['Select', () => [
      { label: 'All', shortcut: `${MOD}A`, action: () => app.selectAll(), disabled: !app.doc },
      { label: 'Deselect', shortcut: `${MOD}D`, action: () => app.deselect(), disabled: !app.doc?.selection },
      { label: 'Inverse', shortcut: `⇧${MOD}I`, action: () => app.inverseSelection(), disabled: !app.doc },
      { separator: true },
      { label: "Layer's Pixels", action: () => app.selectLayerPixels(), disabled: !app.active?.canvas },
      { separator: true },
      { label: 'Expand…', action: () => showSelectionAmount('expand'), disabled: !app.doc?.selection },
      { label: 'Contract…', action: () => showSelectionAmount('contract'), disabled: !app.doc?.selection },
      { label: 'Feather…', action: () => showSelectionAmount('feather'), disabled: !app.doc?.selection },
      { separator: true },
      { label: 'Subject', action: () => app.selectSubject(), disabled: !app.doc },
    ]],
    ['Filter', () => [
      ...FILTER_MENU.map(k => ({ label: `${k}…`, action: () => openFilter(k as FilterKind), disabled: !app.active })),
      { separator: true }, { label: 'Content-Aware Fill', action: () => app.contentAwareFill(), disabled: !app.doc?.selection },
    ]],
    ['View', () => [
      { label: 'Fit Canvas', shortcut: `${MOD}0`, action: () => app.fit(), disabled: !app.doc },
      { label: 'Actual Pixels', shortcut: `${MOD}1`, action: () => app.zoomTo(1), disabled: !app.doc },
      { label: 'Zoom In', shortcut: `${MOD}+`, action: () => app.zoomStep(1), disabled: !app.doc },
      { label: 'Zoom Out', shortcut: `${MOD}−`, action: () => app.zoomStep(-1), disabled: !app.doc },
      { label: 'Pixel Grid (800% and above)', checked: view.pixelGrid, action: () => setView('pixelGrid', !view.pixelGrid) },
      { separator: true },
      { label: 'Show', submenu: [
        { label: 'Grid', shortcut: `${MOD}'`, checked: view.grid, action: () => setView('grid', !view.grid), disabled: !app.doc },
        { label: 'Guides', shortcut: `${MOD};`, checked: view.guides, action: () => setView('guides', !view.guides), disabled: !app.doc },
      ] },
      { label: 'Grid Settings…', action: () => showGridSettings(), disabled: !app.doc },
      { label: 'Rulers', shortcut: `${MOD}R`, checked: view.rulers, action: () => setView('rulers', !view.rulers), disabled: !app.doc },
      { separator: true },
      { label: 'Snap', shortcut: `⇧${MOD};`, checked: view.snap, action: () => setView('snap', !view.snap), disabled: !app.doc },
      { label: 'Snap To', submenu: [
        { label: 'Guides', checked: view.snapGuides, action: () => setView('snapGuides', !view.snapGuides) },
        { label: 'Grid', checked: view.snapGrid, action: () => setView('snapGrid', !view.snapGrid) },
        { label: 'Layers', checked: view.snapLayers, action: () => setView('snapLayers', !view.snapLayers) },
        { label: 'Document Bounds', checked: view.snapBounds, action: () => setView('snapBounds', !view.snapBounds) },
      ] },
      { separator: true },
      { label: 'New Guide…', action: () => showNewGuide(), disabled: !app.doc },
      { label: 'Lock Guides', shortcut: `⌥${MOD};`, checked: view.lockGuides, action: () => setView('lockGuides', !view.lockGuides), disabled: !app.doc },
      { label: 'Clear Guides', action: () => clearGuides(), disabled: !app.doc?.guides.length },
    ]],
  ];
  for (const [title, items] of menus) {
    const item = h('div', { class: 'menubar-item', 'data-menu': title }, title);
    item.addEventListener('pointerdown', e => {
      e.preventDefault();
      const wasOpen = item.classList.contains('open');
      closeMenus();
      if (wasOpen) return;
      const r = item.getBoundingClientRect();
      showMenu(items(), r.left, r.bottom);
      item.classList.add('open');
    });
    item.addEventListener('mouseenter', () => {
      if (!document.querySelector('.menubar .open') || item.classList.contains('open')) return;
      closeMenus(); const r = item.getBoundingClientRect(); showMenu(items(), r.left, r.bottom); item.classList.add('open');
    });
    if (title === 'Compositor') item.classList.add('app-name');
    els.menubar.append(item);
  }
  els.menubar.append(h('div', { class: 'spacer' }), h('div', { class: 'menubar-note' }, 'Compositor for the web'));
}

// ---------- tool rail ----------
function buildRail() { renderRail(); }
export function selectTool(t: Tool) {
  if (t === app.tool && t === 'marquee') app.marqueeKind = app.marqueeKind === 'rectangle' ? 'ellipse' : 'rectangle';
  if (ctl.crop && t !== 'crop') ctl.cancelCrop();
  if (ctl.lasso && t !== 'lasso') ctl.lasso = null;
  if (ctl.textEditor && t !== 'type') ctl.commitText();
  app.tool = t;
  if (t === 'crop' && app.doc && !ctl.crop) ctl.startCropFromSelection();
  app.emit('tool');
}
function renderRail() {
  const r = els.rail; r.replaceChildren();
  for (const t of TOOLS) {
    const name = t.id === 'marquee' && app.marqueeKind === 'ellipse' ? 'marqueeEllipse' : t.id === 'lasso' && app.lassoKind === 'polygonal' ? 'polyLasso' : t.id;
    const b = h('button', { class: `rail-btn${app.tool === t.id ? ' on' : ''}`, title: t.label, 'aria-label': t.label, 'data-tool': t.id }, icon(name, 18));
    b.addEventListener('click', () => selectTool(t.id));
    r.append(b);
  }
  // Foreground/background color wells (ColorPaletteControls.swift).
  const fg = h('input', { type: 'color', value: toHex(app.fg), class: 'swatch fg', title: 'Foreground color' }) as HTMLInputElement;
  const bg = h('input', { type: 'color', value: toHex(app.bg), class: 'swatch bg', title: 'Background color' }) as HTMLInputElement;
  fg.addEventListener('input', () => { app.fg = fromHex(fg.value); });
  bg.addEventListener('input', () => { app.bg = fromHex(bg.value); });
  fg.addEventListener('change', () => app.emit('colors')); bg.addEventListener('change', () => app.emit('colors'));
  const swap = h('button', { class: 'swap', title: 'Swap colors (X)' }, icon('swap', 11));
  swap.addEventListener('click', () => { [app.fg, app.bg] = [app.bg, app.fg]; app.emit('colors'); });
  const reset = h('button', { class: 'reset-colors', title: 'Default colors (D)' });
  reset.addEventListener('click', () => { app.fg = { red: 0, green: 0, blue: 0 }; app.bg = { red: 1, green: 1, blue: 1 }; app.emit('colors'); });
  r.append(h('div', { class: 'palette' }, bg, fg, swap, reset));
}

// ---------- tool header (BrushControls.swift, LassoControls.swift, etc.) ----------
function renderHeader() {
  const hd = els.header;
  if (hd.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT' && (document.activeElement as HTMLInputElement).type !== 'checkbox') return;
  hd.replaceChildren();
  const title = (t: string) => h('span', { class: 'hdr-title' }, t);
  const seg = <T extends string>(opts: [T, string][], cur: T, set: (v: T) => void) => h('div', { class: 'segmented' }, ...opts.map(([v, l]) => {
    const b = h('button', { class: v === cur ? 'on' : '' }, l); b.addEventListener('click', () => { set(v); app.emit('tool'); }); return b;
  }));
  const t = app.tool, a = app.active;
  switch (t) {
    case 'move': {
      hd.append(title('Move'));
      if (a && !a.isGroup && !a.adjustment) {
        const tr = a.transform;
        const field = (label: string, get: () => number, set: (v: number) => void, unit = 'px') => {
          const i = h('input', { type: 'number', value: Math.round(get() * 10) / 10, class: 'hdr-num' }) as HTMLInputElement;
          i.addEventListener('change', () => { const tt = { ...a.transform }; app.edit('Transform'); set(+i.value); app.emit('transform'); void tt; });
          i.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') i.blur(); });
          return h('label', { class: 'hdr-field' }, h('span', {}, label), i, h('span', { class: 'unit' }, unit));
        };
        hd.append(field('X', () => tr.x, v => a.transform.x = v), field('Y', () => tr.y, v => a.transform.y = v),
          field('W', () => tr.w, v => { a.transform.w = Math.max(1, v); }), field('H', () => tr.h, v => { a.transform.h = Math.max(1, v); }),
          field('Angle', () => tr.rotation, v => a.transform.rotation = v, '°'),
          button('Flip H', () => app.flipLayers(true)), button('Flip V', () => app.flipLayers(false)),
          select(['High quality', 'Smooth', 'Nearest'], tr.sampling, v => { app.edit('Sampling'); a.transform.sampling = v; a.rev++; app.emit('transform'); }));
      }
      break;
    }
    case 'brush': case 'spotHealing': case 'cloneStamp': case 'blur': {
      hd.append(title(t === 'brush' ? (app.brush.mode === 'erase' ? 'Eraser' : 'Brush') : t === 'spotHealing' ? 'Spot Healing' : t === 'cloneStamp' ? 'Clone Stamp' : 'Smear'));
      if (t === 'brush') hd.append(seg([['paint', 'Paint'], ['erase', 'Erase']], app.brush.mode, v => app.brush.mode = v));
      if (t === 'blur') hd.append(seg([['liquify', 'Liquify'], ['blur', 'Blur'], ['smudge', 'Smudge']], app.smearMode, v => app.smearMode = v));
      hd.append(slider({ label: 'Size', min: 1, max: 1000, value: app.brush.size, unit: 'px', width: 210, onInput: v => { app.brush.size = v; app.needsRender = true; }, id: 'brush-size' }),
        slider({ label: 'Hardness', min: 0, max: 100, value: Math.round(app.brush.hardness * 100), unit: '%', width: 190, onInput: v => app.brush.hardness = v / 100 }));
      if (t === 'blur') hd.append(slider({ label: 'Strength', min: 1, max: 100, value: Math.round(app.smearStrength * 100), unit: '%', width: 190, onInput: v => app.smearStrength = v / 100 }));
      else if (t !== 'spotHealing') hd.append(slider({ label: 'Opacity', min: 1, max: 100, value: Math.round(app.brush.opacity * 100), unit: '%', width: 190, onInput: v => app.brush.opacity = v / 100, id: 'brush-opacity' }));
      if (t === 'brush') hd.append(slider({ label: 'Smoothing', min: 0, max: 100, value: Math.round(app.brush.smoothing * 100), unit: '%', width: 200, onInput: v => app.brush.smoothing = v / 100 }));
      if (t === 'cloneStamp') hd.append(checkbox('Aligned', app.clone.aligned, v => app.clone.aligned = v), checkbox('Sample all layers', app.clone.sampleAll, v => app.clone.sampleAll = v));
      if (app.maskTarget && a?.mask) hd.append(h('span', { class: 'badge' }, 'Painting on mask'));
      break;
    }
    case 'marquee': case 'lasso': case 'wand': {
      hd.append(title(t === 'marquee' ? 'Marquee' : t === 'lasso' ? 'Lasso' : 'Magic Wand'));
      if (t === 'marquee') hd.append(seg([['rectangle', 'Rectangle'], ['ellipse', 'Ellipse']], app.marqueeKind, v => app.marqueeKind = v));
      if (t === 'lasso') hd.append(seg([['freehand', 'Freehand'], ['polygonal', 'Polygonal']], app.lassoKind, v => { app.lassoKind = v; ctl.lasso = null; }));
      if (t === 'wand') hd.append(seg([['wand', 'Magic Wand'], ['object', 'Object']], app.wandMode, v => { app.wandMode = v; app.emit('tool'); }));
      if (t === 'wand' && app.wandMode === 'wand') hd.append(slider({ label: 'Tolerance', min: 0, max: 255, value: app.wand.tolerance, width: 210, onInput: v => app.wand.tolerance = v }),
        checkbox('Contiguous', app.wand.contiguous, v => app.wand.contiguous = v), checkbox('Sample all layers', app.wand.sampleAll, v => app.wand.sampleAll = v));
      if (t === 'wand' && app.wandMode === 'object') hd.append(checkbox('Sample all layers', app.objectSel.sampleAll, v => app.objectSel.sampleAll = v),
        slider({ label: 'Edge', min: -10, max: 10, value: app.objectSel.edgeOffset, unit: 'px', width: 170, onInput: v => app.objectSel.edgeOffset = v }),
        button('Select Subject', () => app.selectSubject()));
      if (t !== 'wand') hd.append(slider({ label: 'Feather', min: 0, max: 100, value: app.marqueeFeather, unit: 'px', width: 190, onInput: v => app.marqueeFeather = v }));
      hd.append(button('Select All', () => app.selectAll()), button('Deselect', () => app.deselect()), button('Inverse', () => app.inverseSelection()),
        button('Expand…', () => showSelectionAmount('expand')), button('Contract…', () => showSelectionAmount('contract')), button('Feather…', () => showSelectionAmount('feather')));
      break;
    }
    case 'gradient':
      hd.append(title('Gradient'), seg([['linear', 'Linear'], ['radial', 'Radial']], app.gradient.kind, v => app.gradient.kind = v),
        slider({ label: 'Opacity', min: 1, max: 100, value: Math.round(app.gradient.opacity * 100), unit: '%', width: 190, onInput: v => app.gradient.opacity = v / 100 }),
        checkbox('Foreground to transparent', app.gradient.toTransparent, v => app.gradient.toTransparent = v));
      break;
    case 'shape':
      hd.append(title('Shape'), seg([['Rectangle', 'Rectangle'], ['Ellipse', 'Ellipse'], ['Line', 'Line']], app.shape.kind, v => app.shape.kind = v));
      if (app.shape.kind === 'Rectangle') hd.append(slider({ label: 'Corner Radius', min: 0, max: 500, value: app.shape.cornerRadius, unit: 'px', width: 230, onInput: v => app.shape.cornerRadius = v }));
      if (app.shape.kind === 'Line') hd.append(slider({ label: 'Line Width', min: 1, max: 200, value: app.shape.lineWidth, unit: 'px', width: 210, onInput: v => app.shape.lineWidth = v }));
      break;
    case 'type': {
      hd.append(title('Type'));
      const fonts = ['Helvetica', 'Helvetica Neue', 'Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Menlo', 'Verdana', 'Trebuchet MS', 'Impact', 'Futura', 'Avenir', 'Gill Sans'];
      const textLayer = a?.text ? a : null;
      const style = textLayer?.text ?? { ...app.type, red: app.fg.red, green: app.fg.green, blue: app.fg.blue };
      const set = (patch: Record<string, unknown>) => {
        Object.assign(app.type, patch);
        if (textLayer?.text) app.updateText(textLayer, { ...textLayer.text, ...patch });
      };
      hd.append(select(fonts.includes(style.fontName) ? fonts : [style.fontName, ...fonts], style.fontName, v => set({ fontName: v })),
        slider({ label: 'Size', min: 4, max: 1000, value: Math.round(style.fontSize), unit: 'px', width: 200, onInput: () => {}, onCommit: v => set({ fontSize: v }) }),
        seg([['Left', 'Left'], ['Center', 'Center'], ['Right', 'Right']], style.alignment, v => set({ alignment: v })),
        slider({ label: 'Tracking', min: -50, max: 200, value: style.tracking, width: 190, onInput: () => {}, onCommit: v => set({ tracking: v }) }));
      if (textLayer) { const w = h('input', { type: 'color', value: toHex(style), class: 'well' }) as HTMLInputElement; w.addEventListener('change', () => set({ ...fromHex(w.value) })); hd.append(w); }
      break;
    }
    case 'eyedropper': hd.append(title('Eyedropper'), h('span', { class: 'hint' }, 'Click to pick the foreground color · Option-click for background')); break;
    case 'crop': {
      hd.append(title('Crop'), h('span', { class: 'lbl' }, 'Ratio'), select(['Free', 'Original', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'], app.crop.ratio, v => { app.crop.ratio = v; }),
        button('Apply', () => ctl.applyCrop(), { class: 'btn primary', id: 'crop-apply' }), button('Cancel', () => { ctl.cancelCrop(); }));
      break;
    }
    case 'hand': case 'zoom':
      hd.append(title(t === 'hand' ? 'Hand' : 'Zoom'), button('Fit', () => app.fit()), button('100%', () => app.zoomTo(1)), button('Zoom In', () => app.zoomStep(1)), button('Zoom Out', () => app.zoomStep(-1)));
      break;
    default: hd.append(title('Select a tool'));
  }
}

// ---------- status bar ----------
function renderStatus() {
  const d = app.doc, p = app.project;
  const hints: Record<string, string> = {
    marquee: 'Drag a shape · Shift add · Option subtract · Drag inside to move · Delete clears · ⌘D deselect',
    lasso: app.lassoKind === 'freehand' ? 'Drag to select · Drag inside to move · Shift add · Option subtract · ⌘D deselect' : 'Click corners · Click start, double-click or Enter to close · Escape cancel',
    brush: (app.brush.mode === 'erase' ? 'Drag to erase' : 'Drag to paint') + ' · [ ] size · Shift-[ ] hardness · 1–0 opacity · Shift-click straight line · Space to pan',
    wand: app.wandMode === 'object' ? 'Click an object to select it · Shift add · Option subtract' : 'Click to select similar colors · Shift add · Option subtract · ⌘D deselect',
    blur: (app.smearMode === 'blur' ? 'Drag to soften' : app.smearMode === 'liquify' ? 'Drag to push pixels' : 'Drag to smudge') + ' · [ ] size · Space to pan',
    cloneStamp: 'Option-click to set the source · Drag to clone · [ ] size · Space to pan',
    spotHealing: 'Drag over blemishes to heal · [ ] size · Space to pan',
    type: 'Click to add text · Click text to edit · ⌘Return finish · Escape cancel',
    shape: 'Drag to draw a shape on a new layer · Shift constrains · Option from center',
    gradient: 'Drag to draw · Shift 45° · Release to apply',
    crop: 'Drag to crop · Enter apply · Escape cancel · Space to pan',
    move: 'Drag to move · Handles to resize · Circle to rotate · ⌘-click picks a layer · Option-drag duplicates · Arrows nudge',
    hand: 'Drag to pan · Double-click to fit', zoom: 'Click to zoom in · Option-click to zoom out · Drag to zoom smoothly',
    eyedropper: 'Click to pick a color · Option-click for background', idle: 'No tool selected',
  };
  els.status.replaceChildren(
    ...(d && p ? [h('span', { class: 'mono', id: 'zoomStatus' }, `${Math.round(p.zoom * 1000) / 10}%`), h('span', { id: 'canvasDimensions' }, `${d.width} × ${d.height} px`), h('span', {}, 'sRGB · Transparent')] : [h('span', {}, 'Ready when you are')]),
    h('span', { class: 'spacer' }), h('span', { class: 'hint' }, hints[app.tool] ?? ''));
}

// ---------- tabs ----------
function renderTabs() {
  els.tabs.replaceChildren(...app.projects.map((p, i) => {
    const close = h('button', { class: 'tab-close', title: 'Close project' }, icon('close', 10));
    close.addEventListener('click', e => { e.stopPropagation(); app.closeProject(i); });
    const t = h('div', { class: `tab${i === app.current ? ' on' : ''}` }, close, h('span', { class: 'tab-name' }, p.doc.name + (p.doc.dirty ? ' •' : '')));
    t.addEventListener('click', () => app.switchTo(i));
    return t;
  }));
}

// ---------- welcome (NewCanvasSheet) ----------
function renderWelcome() {
  const w = els.welcome;
  if (app.doc) { w.style.display = 'none'; return; }
  w.style.display = '';
  if (w.childElementCount) return;
  const extra = h('div', { class: 'welcome-actions' },
    button('Open project', () => openFileDialog('open')), button('Import image', () => openFileDialog('open')),
    button('Try a sample', () => loadSample()));
  w.append(h('div', { class: 'welcome-card' }, newCanvasForm((W, H) => { app.newCanvas(W, H); app.fit(); }, extra),
    h('p', { class: 'hint center' }, 'Drop images, PSDs or .comp.zip projects anywhere.')));
}
export async function loadSample() {
  // A generated sample: a sky gradient, a sun, hills and type, as separate layers.
  app.newCanvas(1600, 1000, 'Sample');
  const d = app.doc!;
  const l0 = d.layers[0]; l0.name = 'Sky';
  const x = l0.canvas!.getContext('2d')!;
  const g = x.createLinearGradient(0, 0, 0, 1000); g.addColorStop(0, '#1d2b64'); g.addColorStop(0.6, '#f8a36b'); g.addColorStop(1, '#f6d365');
  x.fillStyle = g; x.fillRect(0, 0, 1600, 1000);
  const sun = newPixelLayer(d, 'Sun'); const sx = sun.canvas!.getContext('2d')!;
  const rg = sx.createRadialGradient(1100, 560, 10, 1100, 560, 220); rg.addColorStop(0, '#fff6d8'); rg.addColorStop(0.5, '#ffd36b'); rg.addColorStop(1, 'rgba(255,170,80,0)');
  sx.fillStyle = rg; sx.beginPath(); sx.arc(1100, 560, 220, 0, Math.PI * 2); sx.fill();
  sun.blend = 'Screen';
  const hills = newPixelLayer(d, 'Hills'); const hx = hills.canvas!.getContext('2d')!;
  hx.fillStyle = '#2d3a4a'; hx.beginPath(); hx.moveTo(0, 760);
  for (let i = 0; i <= 1600; i += 20) hx.lineTo(i, 760 - Math.sin(i / 180) * 70 - Math.sin(i / 57) * 18);
  hx.lineTo(1600, 1000); hx.lineTo(0, 1000); hx.fill();
  hx.fillStyle = '#1a2230'; hx.beginPath(); hx.moveTo(0, 860);
  for (let i = 0; i <= 1600; i += 20) hx.lineTo(i, 860 - Math.cos(i / 140) * 50);
  hx.lineTo(1600, 1000); hx.lineTo(0, 1000); hx.fill();
  const text = { content: 'Compositor', fontName: 'Helvetica Neue', fontSize: 120, red: 1, green: 1, blue: 1, alignment: 'Left' as const, tracking: 0, leading: 0 };
  const tc = renderText(text);
  const tl = newPixelLayer(d, 'Compositor', tc, { x: 120, y: 120, w: tc.width, h: tc.height }); tl.text = text;
  tl.effects = { shadow: { angle: 120, distance: 8, blur: 16, red: 0, green: 0, blue: 0, opacity: 0.45 } };
  d.layers.push(sun, hills, tl);
  d.activeId = tl.id; d.selectedIds = [tl.id]; d.dirty = false;
  app.fit(); app.emit('layers');
}

// ---------- Layers panel (LayersPanel.swift, NativeLayerList.swift, LayerAppearanceControls.swift) ----------
let renaming: string | null = null;
function renameLayer(l: Layer) { renaming = l.id; renderLayers(); }
function renderLayers() {
  const panel = els.layers;
  if (panel.contains(document.activeElement) && (document.activeElement as HTMLElement).classList.contains('rename')) return;
  const d = app.doc, a = app.active;
  panel.replaceChildren();
  panel.append(h('div', { class: 'layers-head' }, h('span', { class: 'panel-name' }, 'Layers'), h('span', { class: 'count', id: 'layerCount' }, String(d?.layers.length ?? 0))));
  // Appearance: blend mode + opacity for the active layer.
  const appearance = h('div', { class: 'appearance' });
  if (a) {
    const opts: (BlendMode | null)[] = [];
    BLEND_GROUPS.forEach((g, i) => { if (i) opts.push(null); opts.push(...g); });
    const blend = select(opts, a.blend, v => app.setLayerProp(a, 'blend', v as BlendMode, 'Blend Mode'), { id: 'blend-mode', disabled: a.isGroup });
    appearance.append(blend, slider({ label: 'Opacity', min: 0, max: 100, value: Math.round(a.opacity * 100), unit: '%', id: 'layer-opacity',
      onInput: v => { if (app.history?.undoLabel !== 'Opacity' + a.id) app.edit('Opacity' + a.id); a.opacity = v / 100; app.needsRender = true; },
      onCommit: () => app.emit('layers') }));
  } else appearance.append(h('span', { class: 'hint' }, 'No layer selected'));
  panel.append(appearance);
  const list = h('div', { class: 'layer-list', id: 'layer-list' });
  if (!d || !d.layers.length) {
    list.append(h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('folder', 26)), h('div', {}, 'No layers yet'),
      h('div', { class: 'hint' }, d ? 'Import an image or add a blank layer.' : 'Create a canvas or import an image.')));
  } else {
    const rows: HTMLElement[] = [];
    const walk = (parent: string | null, depth: number) => {
      const kids = childrenOf(d, parent).slice().reverse();
      for (const l of kids) {
        rows.push(layerRow(l, depth));
        if (l.isGroup && !l.collapsed) walk(l.id, depth + 1);
      }
    };
    walk(null, 0);
    list.append(...rows);
  }
  panel.append(list);
  const fx = h('button', { class: 'foot-btn', title: 'Layer effects', disabled: !a || a.isGroup || !!a.adjustment }, icon('sparkles', 16));
  fx.addEventListener('click', e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); showMenu((Object.keys(EFFECT_NAMES) as EffectKey[]).map(k => ({ label: `${EFFECT_NAMES[k]}…`, action: () => { app.addEffect(k); if (app.active) openEffects(app.active, k); } })), r.left, r.top - 200); });
  const adj = h('button', { class: 'foot-btn', title: 'New adjustment layer', disabled: !d, id: 'add-adjustment' }, icon('adjust', 16));
  adj.addEventListener('click', e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); showMenu(ADJUSTMENT_KINDS.map(k => ({ label: k, action: () => { const l = app.addAdjustmentLayer(k); if (l && k !== 'Invert') editAdjustment(l); } })), r.left, r.top - 330); });
  const mask = h('button', { class: 'foot-btn', title: 'Layer mask', disabled: !a || a.isGroup, id: 'mask-btn' }, icon('mask', 16));
  mask.addEventListener('click', e => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (!a) return;
    if (!a.mask) { app.addMask(true); return; }
    showMenu([{ label: a.maskEnabled ? 'Disable Mask' : 'Enable Mask', action: () => app.setLayerProp(a, 'maskEnabled', !a.maskEnabled, 'Toggle Mask') },
      { label: 'Invert Mask', action: () => app.invertMask() }, { label: 'Apply Mask', action: () => app.applyMask(), disabled: !a.canvas },
      { label: 'Delete Mask', action: () => { app.maskTarget = true; app.deleteLayers(); } }], r.left, r.top - 130);
  });
  panel.append(h('div', { class: 'layers-foot' },
    h('button', { class: 'foot-btn', title: `New blank layer (⇧${MOD}N)`, disabled: !d, id: 'addBlankLayer', onclick: () => app.addBlankLayer() }, icon('newLayer', 16)),
    h('button', { class: 'foot-btn', title: `Group selected layers (${MOD}G)`, disabled: !d, onclick: () => app.groupSelected() }, icon('folderPlus', 16)),
    mask, fx, adj, h('span', { class: 'spacer' }),
    h('button', { class: 'foot-btn', title: 'Delete selected layer', disabled: !a, id: 'deleteLayer', onclick: () => app.deleteLayers() }, icon('trash', 16))));
}
const thumbCache = new WeakMap<HTMLCanvasElement, { rev: number; url: string }>();
function thumb(c: HTMLCanvasElement, rev: number, key: string): HTMLElement {
  const box = h('div', { class: 'thumb' });
  const cached = thumbCache.get(c);
  let url = cached && cached.rev === rev ? cached.url : '';
  if (!url) {
    const s = Math.min(1, 36 / c.width, 28 / c.height), t = document.createElement('canvas');
    t.width = Math.max(1, Math.round(c.width * s * 2)); t.height = Math.max(1, Math.round(c.height * s * 2));
    t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height);
    url = t.toDataURL(); thumbCache.set(c, { rev, url });
  }
  box.append(h('img', { src: url, alt: key }));
  return box;
}
function layerRow(l: Layer, depth: number): HTMLElement {
  const d = app.doc!;
  const selected = d.selectedIds.includes(l.id), active = d.activeId === l.id;
  const eye = h('button', { class: `eye${l.visible ? '' : ' off'}`, title: l.visible ? 'Hide layer' : 'Show layer' }, icon(l.visible ? 'eye' : 'eyeOff', 14));
  eye.addEventListener('click', e => { e.stopPropagation(); app.setLayerProp(l, 'visible', !l.visible, l.visible ? 'Hide Layer' : 'Show Layer'); });
  const parts: (Node | string)[] = [eye, h('span', { class: 'indent', style: `width:${depth * 14}px` })];
  if (l.isGroup) {
    const dis = h('button', { class: `disclosure${l.collapsed ? '' : ' open'}` }, icon('chevron', 10));
    dis.addEventListener('click', e => { e.stopPropagation(); l.collapsed = !l.collapsed; renderLayers(); });
    parts.push(dis, h('div', { class: 'thumb icon' }, icon('folder', 18)));
  } else if (l.adjustment) parts.push(h('div', { class: 'thumb icon' }, icon('adjust', 16)));
  else if (l.canvas) parts.push(thumb(l.canvas, l.rev, l.name));
  if (l.clipTo) parts.unshift(h('span', { class: 'clip-mark', title: 'Clipped to the layer below' }, '↳'));
  if (l.mask) {
    const mt = thumb(l.mask, l.rev, 'mask');
    mt.classList.add('mask-thumb'); if (app.maskTarget && active) mt.classList.add('target'); if (!l.maskEnabled) mt.classList.add('disabled');
    mt.title = 'Click to paint on the mask · Shift-click to disable it';
    mt.addEventListener('click', e => { e.stopPropagation(); if (e.shiftKey) { app.setLayerProp(l, 'maskEnabled', !l.maskEnabled, 'Toggle Mask'); return; } app.setActive(l.id); app.maskTarget = true; app.emit('layers'); });
    parts.push(mt);
  }
  let name: HTMLElement;
  if (renaming === l.id) {
    const inp = h('input', { class: 'rename', value: l.name }) as HTMLInputElement;
    const done = (save: boolean) => { if (renaming !== l.id) return; renaming = null; if (save && inp.value.trim() && inp.value !== l.name) app.setLayerProp(l, 'name', inp.value.trim(), 'Rename Layer'); else renderLayers(); };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
    requestAnimationFrame(() => { inp.focus(); inp.select(); });
    name = inp;
  } else name = h('span', { class: 'layer-name' }, l.name);
  parts.push(name);
  if (l.effects && Object.keys(l.effects).length) {
    const fxb = h('button', { class: 'fx', title: 'Edit layer effects' }, 'fx');
    fxb.addEventListener('click', e => { e.stopPropagation(); app.setActive(l.id); openEffects(l); });
    parts.push(fxb);
  }
  const row = h('div', { class: `layer-row${selected ? ' sel' : ''}${active ? ' active' : ''}${isEffectivelyVisible(d, l) ? '' : ' hidden'}`, draggable: true, 'data-id': l.id }, ...parts);
  row.addEventListener('click', e => {
    if (e.altKey && !l.isGroup) { app.setActive(l.id); app.toggleClip(); return; }
    app.setActive(l.id, e.shiftKey || e.metaKey || e.ctrlKey);
    if (!(e.target as HTMLElement).closest('.mask-thumb')) app.maskTarget = false;
    app.emit('layers');
  });
  row.addEventListener('dblclick', e => { e.stopPropagation(); if (l.adjustment) editAdjustment(l); else renameLayer(l); });
  row.addEventListener('contextmenu', e => {
    e.preventDefault(); app.setActive(l.id);
    showMenu([
      { label: 'Rename', action: () => renameLayer(l) }, { label: 'Duplicate', action: () => app.duplicateLayer() }, { label: 'Delete', action: () => app.deleteLayers() },
      { separator: true },
      { label: l.clipTo ? 'Release Clipping Mask' : 'Create Clipping Mask', action: () => app.toggleClip(), disabled: l.isGroup },
      { label: 'Merge Down', action: () => app.mergeDown(), disabled: l.isGroup },
      ...(l.isGroup ? [{ label: 'Merge Group', action: () => app.mergeGroup() }, { label: 'Ungroup', action: () => app.ungroup() }] : []),
      { label: 'Group', action: () => app.groupSelected() },
      { separator: true },
      { label: 'Add Mask', action: () => app.addMask(true), disabled: !!l.mask || l.isGroup },
      ...(l.adjustment ? [{ label: 'Edit Adjustment…', action: () => editAdjustment(l) }] : []),
      ...(l.text || l.shape ? [{ label: 'Rasterize', action: () => { app.edit('Rasterize'); app.rasterize(l); app.changed('layers'); } }] : []),
      { label: "Select Layer's Pixels", action: () => app.selectLayerPixels(), disabled: !l.canvas },
    ], e.clientX, e.clientY);
  });
  // Drag and drop to reorder; drop on the middle of a folder to put the layer inside. Option-drag duplicates.
  row.addEventListener('dragstart', e => { e.dataTransfer!.setData('text/x-layer', l.id); e.dataTransfer!.effectAllowed = 'copyMove'; });
  row.addEventListener('dragover', e => {
    if (!e.dataTransfer!.types.includes('text/x-layer')) return;
    e.preventDefault();
    const r = row.getBoundingClientRect(), y = (e.clientY - r.top) / r.height;
    row.classList.remove('drop-above', 'drop-below', 'drop-into');
    row.classList.add(l.isGroup && y > 0.3 && y < 0.7 ? 'drop-into' : y < 0.5 ? 'drop-above' : 'drop-below');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below', 'drop-into'));
  row.addEventListener('drop', e => {
    e.preventDefault();
    const id = e.dataTransfer!.getData('text/x-layer');
    const where = row.classList.contains('drop-into') ? 'into' : row.classList.contains('drop-above') ? 'above' : 'below';
    row.classList.remove('drop-above', 'drop-below', 'drop-into');
    if (!id || id === l.id) return;
    if (e.altKey) { app.setActive(id); app.duplicateLayer(); }
    const moving = e.altKey ? app.doc!.activeId! : id;
    app.edit('Move Layer');
    app.reorder(moving, l.id, where);
  });
  void ancestors; void getLayer; void BLEND_MODES;
  return row;
}

// ---------- panel resizing ----------
function setupResize() {
  const edge = document.querySelector('.resize-edge') as HTMLElement;
  let w = +(localStorage.getItem('layersPanelWidth') ?? 252);
  const apply = () => { els.layers.style.width = `${w}px`; };
  apply();
  edge.addEventListener('pointerdown', e => {
    edge.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = w;
    const move = (ev: PointerEvent) => { w = Math.min(352, Math.max(202, w0 - (ev.clientX - x0))); apply(); };
    const up = () => { edge.removeEventListener('pointermove', move); edge.removeEventListener('pointerup', up); localStorage.setItem('layersPanelWidth', String(w)); };
    edge.addEventListener('pointermove', move); edge.addEventListener('pointerup', up);
  });
}
function setupDrop() {
  const wrap = document.querySelector('.stage-wrap') as HTMLElement;
  document.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); wrap.classList.add('drop'); } });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) wrap.classList.remove('drop'); });
  document.addEventListener('drop', e => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault(); wrap.classList.remove('drop');
    const files = Array.from(e.dataTransfer.files);
    const images = files.filter(f => /^image\//.test(f.type) && !/\.ps[db]$/i.test(f.name));
    const others = files.filter(f => !images.includes(f));
    if (app.doc && images.length) {
      // Dropped on an open canvas: import as layers at the drop point.
      const r = els.stage.getBoundingClientRect();
      const at = app.toDoc(e.clientX - r.left, e.clientY - r.top);
      (async () => { for (const f of images) { app.placeImage(await fileToCanvas(f), f.name.replace(/\.[^.]+$/, ''), at); } })();
    } else app.openFiles(images);
    if (others.length) app.openFiles(others);
  });
  document.addEventListener('paste', e => {
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    const f = Array.from(e.clipboardData?.files ?? []).find(x => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); if (app.doc) import('../engine/files').then(async m => app.placeImage(await m.fileToCanvas(f), 'Pasted')); else app.openFiles([f]); }
  });
}

// ---------- keyboard (KeyboardShortcuts.swift defaults) ----------
function setupKeys() {
  window.addEventListener('keydown', e => {
    const tgt = e.target as HTMLElement;
    if (tgt.closest('input:not([type=range]):not([type=checkbox]), textarea, select')) return;
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    const run = (f: () => void) => { e.preventDefault(); f(); };
    if (e.key === ' ' && !mod) { if (!ctl.spaceDown) { ctl.spaceDown = true; ctl.updateCursor(ctl.pointer ?? [0, 0]); } e.preventDefault(); return; }
    if (mod) {
      if (k === 'z') return run(() => e.shiftKey ? app.redo() : app.undo());
      if (k === 'y') return run(() => app.redo());
      if (k === 'n') return run(() => e.shiftKey ? app.addBlankLayer() : showNewCanvas());
      if (k === 'o') return run(() => openFileDialog(e.shiftKey ? 'import' : 'open'));
      if (k === 's') return run(() => e.altKey && e.shiftKey ? showExportJpeg() : e.shiftKey ? app.saveAs() : app.save());
      if (k === 'e') return run(() => e.shiftKey ? app.exportImage('png') : app.mergeSelected());
      if (k === 'w') return run(() => app.closeProject());
      if (k === '0') return run(() => app.fit());
      if (e.key === "'" || e.code === 'Quote') return run(() => setView('grid', !view.grid));
      if (e.key === ';' || e.key === ':' || e.code === 'Semicolon') return run(() => e.shiftKey ? setView('snap', !view.snap) : e.altKey ? setView('lockGuides', !view.lockGuides) : setView('guides', !view.guides));
      if (k === 'r' && !e.shiftKey) return run(() => setView('rulers', !view.rulers));
      if (k === '1') return run(() => app.zoomTo(1));
      if (k === '=' || k === '+') return run(() => app.zoomStep(1));
      if (k === '-') return run(() => app.zoomStep(-1));
      if (k === 'a') return run(() => app.selectAll());
      if (k === 'd') return run(() => app.deselect());
      if (k === 'i') return run(() => e.shiftKey ? app.inverseSelection() : e.altKey ? showImageSize() : app.invertPixels());
      if (k === 'l') return run(() => openFilter('Levels'));
      if (k === 'm') return run(() => openFilter('Curves'));
      if (k === 'u') return run(() => openFilter('Hue/Saturation'));
      if (k === 'j') return run(() => e.shiftKey ? app.layerViaCopy(true) : app.duplicateLayer());
      if (k === 'g') return run(() => e.altKey ? app.toggleClip() : e.shiftKey ? app.ungroup() : app.groupSelected());
      if (k === 't') return run(() => selectTool('move'));
      if (k === 'c' && e.altKey) return run(() => showCanvasSize());
      if (k === 'c') return run(() => e.shiftKey ? app.copyMerged() : app.copy());
      if (k === 'x') return run(() => app.copy(true));
      if (k === 'v') return; // native paste event handles images; fall through to app.paste for layers
      if (k === ']') return run(() => app.moveLayer(1));
      if (k === '[') return run(() => app.moveLayer(-1));
      if (e.key === 'Backspace' || e.key === 'Delete') return run(() => app.fill(app.bg));
      return;
    }
    if (e.key === 'Escape') { if (hasOpenPanel()) return run(() => closeOpenPanel()); if (ctl.cancel()) return run(() => {}); return; }
    if (e.key === 'Enter') { if (ctl.commit()) e.preventDefault(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (ctl.lasso && app.lassoKind === 'polygonal') return run(() => { ctl.lasso!.pop(); if (ctl.lasso!.length < 2) ctl.lasso = null; app.needsRender = true; });
      if (e.altKey) return run(() => app.fill(app.fg));
      if (e.shiftKey) return run(() => app.contentAwareFill());
      return run(() => app.clearSelected());
    }
    if (e.key.startsWith('Arrow')) {
      const step = e.shiftKey ? 10 : 1;
      const [dx, dy] = e.key === 'ArrowLeft' ? [-step, 0] : e.key === 'ArrowRight' ? [step, 0] : e.key === 'ArrowUp' ? [0, -step] : [0, step];
      return run(() => ctl.nudge(dx, dy));
    }
    if (e.key === 'Tab' && app.tool === 'shape') return run(() => { app.shape.kind = app.shape.kind === 'Rectangle' ? 'Ellipse' : app.shape.kind === 'Ellipse' ? 'Line' : 'Rectangle'; app.emit('tool'); });
    if (e.key === 'Tab' && app.tool === 'blur') return run(() => { app.smearMode = app.smearMode === 'liquify' ? 'blur' : app.smearMode === 'blur' ? 'smudge' : 'liquify'; app.emit('tool'); });
    if (k === '[' || k === ']' || e.key === '{' || e.key === '}') {
      const up = k === ']' || e.key === '}';
      if (e.shiftKey) app.brush.hardness = Math.min(1, Math.max(0, app.brush.hardness + (up ? 0.25 : -0.25)));
      else { const s = app.brush.size; app.brush.size = Math.min(1000, Math.max(1, up ? s + (s < 10 ? 1 : s < 50 ? 5 : s < 200 ? 10 : 50) : s - (s <= 10 ? 1 : s <= 50 ? 5 : s <= 200 ? 10 : 50))); }
      return run(() => app.emit('tool'));
    }
    if (/^[0-9]$/.test(e.key)) {
      const v = e.key === '0' ? 1 : +e.key / 10;
      if (['brush', 'cloneStamp'].includes(app.tool)) { app.brush.opacity = v; return run(() => app.emit('tool')); }
      if (app.tool === 'blur') { app.smearStrength = v; return run(() => app.emit('tool')); }
      if (app.tool === 'gradient') { app.gradient.opacity = v; return run(() => app.emit('tool')); }
      if (app.tool === 'move' && app.active) return run(() => app.setLayerProp(app.active!, 'opacity', v, 'Opacity'));
      return;
    }
    if (e.shiftKey && (e.key === '+' || e.key === '=' || e.key === '_' || e.key === '-') && app.active) {
      const a = app.active; return run(() => app.setLayerProp(a, 'blend', app.blendIndex(a.blend, e.key === '+' || e.key === '=' ? 1 : -1), 'Blend Mode'));
    }
    if (k === 'x') return run(() => { [app.fg, app.bg] = [app.bg, app.fg]; app.emit('colors'); });
    if (k === 'd') return run(() => { app.fg = { red: 0, green: 0, blue: 0 }; app.bg = { red: 1, green: 1, blue: 1 }; app.emit('colors'); });
    if (k === 'e') return run(() => { app.brush.mode = 'erase'; selectTool('brush'); });
    if (k === 'b') return run(() => { app.brush.mode = 'paint'; selectTool('brush'); });
    if (k === 'a') return run(() => selectTool('idle'));
    if (k === 'u' && e.shiftKey) return run(() => { app.shape.kind = app.shape.kind === 'Rectangle' ? 'Ellipse' : app.shape.kind === 'Ellipse' ? 'Line' : 'Rectangle'; selectTool('shape'); });
    if (k === 'l' && app.tool === 'lasso') return run(() => { app.lassoKind = app.lassoKind === 'freehand' ? 'polygonal' : 'freehand'; ctl.lasso = null; app.emit('tool'); });
    const t = TOOLS.find(x => x.key === k);
    if (t) return run(() => selectTool(t.id));
  });
  window.addEventListener('keyup', e => { if (e.key === ' ') { ctl.spaceDown = false; ctl.updateCursor(ctl.pointer ?? [0, 0]); } });
  document.addEventListener('paste', e => { if (!(e.target as HTMLElement).closest('input, textarea') && !e.clipboardData?.files.length) app.paste(); });
}
