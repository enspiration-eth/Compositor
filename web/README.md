# Compositor for the web

A browser port of [Compositor](../README.md), the native macOS image editor. It lives in `web/` on the `web` branch.
The Mac app's sources are not modified. The web build compiles the Mac app's own C pixel engine to WebAssembly and
re-implements the platform layers (AppKit/SwiftUI, Metal, Core Image) with web APIs.

**Live:** https://enspiration-eth.github.io/Compositor/ (add `?sample` to open the demo project directly)

## Architecture: a hybrid WebAssembly port

| Layer | Mac app | Web build |
|---|---|---|
| Pixel kernels (levels, hue/sat cube, gradient map, B&W, color balance, grain, noise, vignette, tonal contrast, lens correction, Camera Raw, magic wand flood fill + contour tracing, spot healing, content-aware fill, dither, alpha bounds) | C in `Compositor/Rendering/*.c` | **The same C files, compiled unchanged to WebAssembly** with Emscripten (`wasm/build.sh` → `src/wasm/pixels.{mjs,wasm}`) |
| Smudge and Liquify (`WarpStroke` CPU path in `Document/SmudgeLiquify.swift`) | Swift (+ Metal) | Translated line for line to C (`wasm/src/WarpPixels.c`) and compiled into the same wasm module |
| libdispatch / Blocks (used by `DitherPixels.c`) | system | Small shims in `wasm/shim/`: a serial `dispatch_apply` and the Blocks runtime symbols, so the C sources compile as-is |
| Settings, table builders (Levels, Curves Hermite spline, Hue/Sat cube, Exposure, Dither…) | Swift | Line-by-line TypeScript ports (`src/engine/adjustments.ts`) feeding the wasm kernels |
| Document model (layers, folders, masks, clipping, transforms, effects, text/shape metadata) | Swift + CoreGraphics | TypeScript (`src/engine/document.ts`), same field names as `manifest.json` |
| Compositor (24 blend modes, masks, clipping, pass-through folders, adjustment layers) | Metal + Core Image | WebGL2 + GLSL, using the same blend formulas (`src/engine/render.ts`) |
| `.comp` projects, PSD, image import/export | ImageIO, Swift PSD reader | `fflate` zip, `ag-psd`, browser image decoders (`src/engine/files.ts`) |
| UI | SwiftUI/AppKit | DOM + canvas, with the Mac layout: toolbar with tabs, tool header, tool rail, Layers panel, status bar, menu bar and shortcuts |

### Why not SwiftWasm for everything?
Almost every Swift file in `Compositor/Document` and `Compositor/IO` imports AppKit, CoreGraphics, CoreImage, Vision
or ImageIO. SwiftWasm offers none of these, so compiling the Swift core would mean writing replacements for Core Graphics,
Core Image and Vision first. That is far more code than the port, and it would still not be the original
implementation. The real pixel math already lives in portable C, so that is the part compiled to wasm. The Swift that
drives it (settings, LUT/table builders) is ported faithfully to TypeScript, and the platform layers are
re-implemented on WebGL2 and canvas.

Each kernel call premultiplies browser `ImageData` on the way in and un-premultiplies on the way out, because the C
code expects premultiplied RGBA, as the Mac app's `CGContext`s provide.

## Build

```sh
cd web
npm install
npm run build        # tsc --noEmit && vite build → web/dist
npm run dev          # local dev server
npm run test:e2e     # headless Chromium smoke test against `vite preview` (needs `npx playwright install chromium`)

# Optional: rebuild the wasm from the C sources (the built files are committed). Needs Emscripten (emsdk) on PATH.
npm run build:wasm
```

`BASE_PATH=/Compositor/ npm run build` builds for GitHub Pages. `.github/workflows/pages.yml` compiles the wasm from
source, builds, runs the smoke test and deploys on every push to `web`.

## What works

- **Projects:** multiple tabs; new canvas with presets; open/save `.comp` projects as a zip of the folder format
  (`manifest.json` v11 + `images/*.png` + masks, see `docs/project-format.md`); opening an unzipped `.comp` folder; drag
  and drop; paste; import PNG/JPEG/WebP/GIF/SVG/PSD (PSD layers via `ag-psd`); export PNG/JPEG with a quality preview
- **Layers:** pixel, text, shape and adjustment layers; folders, including pass-through; visibility, rename, reorder by
  drag, duplicate, layer via copy/cut, merge down/selected/group, delete
- **Compositing:** all 24 blend modes; opacity; layer masks (reveal/hide all, from selection, invert, apply, disable,
  delete); clipping masks; folder masks
- **Layer effects:** stroke, drop shadow, inner shadow, outer glow, inner glow, color overlay
- **Tools:** move/free transform (scale, rotate, flip), rectangle/ellipse marquee, lasso and polygonal lasso, magic wand
  (wasm), crop, brush/eraser (size, hardness, opacity, smoothing; paints on masks too), spot healing (wasm), clone stamp,
  Liquify/Blur/Smudge (Liquify and Smudge run the Mac app's warp algorithm in wasm), gradient, shape, type, eyedropper, hand, zoom
- **Selections:** add/subtract/intersect, all, deselect, inverse, expand, contract, feather, layer pixels, marching ants
  (traced by the wasm `wand_trace`), Content-Aware Fill (wasm)
- **Image adjustments, destructive or as adjustment layers:** Levels (histogram from wasm), Curves, Hue/Saturation, Exposure,
  Gradient Map, Black & White, Color Balance, Grain, Invert
- **Filters:** Gaussian Blur, Motion Blur, Add Noise, Vignette, Bloom/Glow, Dither, Tonal Contrast, Lens Correction,
  Camera Raw (basic, presence, color and effects sections)
- **Canvas:** canvas size with anchor, image size, trim, crop to selection, flip canvas, zoom/fit/100%, pixel grid at
  high zoom, checkerboard transparency
- **Undo/redo** with copy-on-write pixel snapshots; Mac keyboard shortcuts (⌘ on Mac, Ctrl elsewhere)

## Missing or simplified, and why

- **Remove Background, Select Subject, Object Selection:** these depend on Apple's Vision framework, which has no
  browser equivalent. They would need a bundled ML segmentation model.
- **Camera Raw:** only the sliders the shared C kernel implements in one pass. Curves, mixer, grading, detail and optics
  are absent.
- **RAW / HEIC / TIFF import:** these need ImageIO. The browser can only decode what its own image decoders support.
- **PSD import** uses `ag-psd` instead of the app's Swift reader, so some adjustment/effect records may differ.
- **Rulers/guides/grid, unlinked masks, perspective/free distort:** not ported yet.
- **Text:** styled as a single run (one font/size/color per layer, via canvas 2D instead of Core Text). Shapes and
  gradients are rasterized.
- **Layer effects and Bloom** are close approximations drawn with canvas 2D filters, not the Core Image pipeline.
- **Performance:** the wasm kernels run single-threaded (`dispatch_apply` is serial; no SharedArrayBuffer threads on
  GitHub Pages). Adjustment layers are recomputed on the CPU and cached.
- **Hue/Saturation adjustment layers** use the Master range only.
- `.comp` projects are saved as a `.comp.zip` (browsers can't write folder bundles). Unzip one to open it in the Mac app.
- No Sparkle updates, Quick Look, or document-based windowing; tabs replace windows.
