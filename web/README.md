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
| Remove Background's matte refinement (`GuidedMatte.swift` guided filter, Shift Edge, Contrast) | Swift + Core Image | Translated to C (`wasm/src/MattePixels.c`), in the same wasm module |
| Subject detection (Remove Background, Select Subject, Object Selection) | Apple Vision | U²-Net-p (Apache-2.0, `public/models/u2netp.onnx`) on onnxruntime-web's WebAssembly backend, loaded on first use only |
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

## Deploy anywhere (one command)

From the repository root of the `web` branch:

```sh
npm install && npm start      # builds web/ and serves it on $PORT (default 3000), bound to 0.0.0.0
```

Point Render, Railway, Fly, Heroku or any Node host at the repo (branch `web`). Use `npm install` (or
`npm install && npm run build`) as the build command and `npm start` as the start command. Node 20 or newer is
required (`engines` in the root `package.json`).

- `postinstall` installs the web app's dependencies, including dev dependencies (Vite, TypeScript), even when `NODE_ENV=production`.
- `npm start` runs a zero-dependency Node server (`web/server.mjs`). It builds `web/dist` first if it's missing. It
  serves `.wasm` as `application/wasm`, gives hashed assets long cache lifetimes, falls back to `index.html` for unknown
  routes, and answers `/healthz`.
- The compiled WebAssembly (`web/src/wasm/pixels.wasm`) is committed, so Emscripten is not needed at deploy time.
- GitHub Pages deploys via `.github/workflows/pages.yml` on every push to `web`.

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
  (traced by the wasm `wand_trace`), Content-Aware Fill (wasm), Select Subject and Object Selection (on-device ML)
- **Image adjustments, destructive or as adjustment layers:** Levels (histogram from wasm), Curves, Hue/Saturation, Exposure,
  Gradient Map, Black & White, Color Balance, Grain, Invert
- **Filters:** Gaussian Blur, Motion Blur, Add Noise, Vignette, Bloom/Glow, Dither, Tonal Contrast, Lens Correction,
  Camera Raw with all of the Mac panel's processing sections (Basic, Curve, Color Mixer, Color Grading, Detail, Optics, Effects with Glow, Calibration), each
  running the Mac app's C kernel, Remove Background (Basic/Advanced with Refine Edges,
  Contrast, Shift Edge; adds a layer mask)
- **Rulers, guides and grid:** rulers you drag guides out of (⌘R); guides saved in the project's manifest, moved
  or deleted with the Move tool, locked or cleared, or added by position; a layout grid with Grid Settings (⌘'); Snap
  (⇧⌘;) to guides, grid, layers and document bounds for move, marquee, crop and shape
- **Canvas:** canvas size with anchor, image size, trim, crop to selection, flip canvas, zoom/fit/100%, pixel grid at
  high zoom, checkerboard transparency
- **Undo/redo** with copy-on-write pixel snapshots; Mac keyboard shortcuts (⌘ on Mac, Ctrl elsewhere)

## Missing or simplified, and why

- **Remove Background, Select Subject, Object Selection** run on an open salient-object model (U²-Net-p) instead of
  Apple Vision. The model is good at clear foreground subjects, but it doesn't separate instances the way Vision does.
  Object Selection takes the connected part of the subject mask under the click, with closer looks around the
  click as a fallback, and diffuse things such as glows aren't detected. The first use downloads about 4.5 MB of
  model plus a 14 MB runtime (about 3.5 MB gzipped).
- **Camera Raw:** the processing is complete, but the panel is simplified. The point curve is chosen from presets (no
  draggable editor), there's no Point Color picker, no Geometry (Upright/perspective) section, no targeted
  adjustment tool and no clipping overlays.
- **RAW / HEIC / TIFF import:** these need ImageIO. The browser can only decode what its own image decoders support.
- **PSD import** uses `ag-psd` instead of the app's Swift reader, so some adjustment/effect records may differ.
- **Unlinked masks, perspective/free distort:** not ported yet.
- **Text:** styled as a single run (one font/size/color per layer, via canvas 2D instead of Core Text). Shapes and
  gradients are rasterized.
- **Layer effects and Bloom** are close approximations drawn with canvas 2D filters, not the Core Image pipeline.
- **Performance:** the wasm kernels run single-threaded (`dispatch_apply` is serial; no SharedArrayBuffer threads on
  GitHub Pages). Adjustment layers are recomputed on the CPU and cached.
- **Hue/Saturation adjustment layers** use the Master range only.
- `.comp` projects are saved as a `.comp.zip` (browsers can't write folder bundles). Unzip one to open it in the Mac app.
- No Sparkle updates, Quick Look, or document-based windowing; tabs replace windows.
