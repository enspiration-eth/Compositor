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
| Free Distort (`⌘`-drag a transform handle; perspective quad warp) | Swift / Core Image | New C kernel (`wasm/src/DistortPixels.c`, inverse homography + bilinear); ⌘-drag a corner with Move or Edit › Distort, Return applies, Esc cancels |
| Gaussian / motion blur (Core Image `CIGaussianBlur`, `CIMotionBlur`) | Core Image | New C kernels (`wasm/src/BlurPixels.c`), so filters can run in workers |
| Layer effects (`MetalLayerEffects.swift` compute kernels: stroke spread, shadow shift + blur, glows, `effects_compose`) | Swift + Metal | Translated to C (`wasm/src/EffectsPixels.c`), in the same wasm module |
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
  Liquify/Blur/Smudge (Liquify and Smudge run the Mac app's warp algorithm in wasm; Blur paints a softened copy of the
  layer, made at the start of the stroke with the Radius setting, through the brush, as `BlurTool.swift` does), gradient, shape, type, eyedropper, hand, zoom
- **Selections:** add/subtract/intersect, all, deselect, inverse, expand/contract (round corners via a Euclidean distance
  transform in wasm, as the Mac app's stroked-band path ops), feather (Gaussian of feather/2, edges extended), layer pixels, marching ants
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
  click as a fallback; otherwise it follows `ObjectSelection.swift`: the low-resolution mask is upsampled along the
  image's edges (a joint bilateral upsample in wasm standing in for `CIEdgePreserveUpsampleFilter`, sigma 5 / luma
  0.15), thresholded, eroded or dilated in whole-pixel steps by Edge (wasm `mask_morph`), and with Anti-alias the traced
  outline is simplified and Chaikin-smoothed. Touching objects that the model sees as one subject come out as one
  selection, and diffuse things such as glows aren't detected. The first use downloads about 4.5 MB of
  model plus a 14 MB runtime (about 3.5 MB gzipped).
- **Camera Raw:** the full pipeline and panel: editable point curves (RGB/Red/Green/Blue, plus presets), Point Color
  (sample up to eight colors from the image, shift and range sliders, Visualize), Geometry (Upright Off/Guided with
  guide lines drawn on the canvas, Vertical/Horizontal/Rotate/Aspect/Scale/Offset, Constrain Crop; the perspective
  warp runs in the wasm distort kernel) and the clipping view (Option/Alt-drag a Light slider, or the Clipping menu;
  it's the original kernel's `clipping` mode). White Balance Auto (gray-world) and the eyedropper (`neutralize`), the
  Defringe eyedropper, the targeted-adjustment drags for the Curve (parametric region or nearest point) and the Color
  Mixer (Hue/Saturation/Luminance families weighted by hue), and the sharpening mask (Option/Alt-drag Masking, the
  original `adjust_camera_raw_sharpen_mask_overlay` kernel) are ported too.
- **TIFF / RAW / HEIC import:** the Mac app uses ImageIO. The web build decodes TIFF (uncompressed, LZW, Deflate, PackBits, JPEG; 8/16-bit; alpha) and TIFF-based camera RAW (DNG, NEF, CR2, ARW, …) with [UTIF](https://github.com/photopea/UTIF.js) (MIT); RAW files without a decodable RGB image fall back to their largest embedded JPEG preview, and there is no RAW develop step. HEIC opens only in browsers that decode it natively (Safari). File › Export TIFF… writes an 8-bit RGBA TIFF.
- **PSD import** uses `ag-psd` instead of the app's Swift reader, so some adjustment/effect records may differ.
- **Unlinked / placed masks:** ported (link button between the thumbnails, Layer › Mask › Unlink Mask; with the mask selected the Move tool and arrow keys move it alone, and its own dashed box has scale and rotate handles; `maskPlacement`/`maskLinked` are read and written in `.comp`). Simplification: painting or filtering a mask that sits apart from its layer first resamples it into the layer’s pixel grid (the Mac app paints in the mask’s own grid).
- **Text and shapes stay live:** clicking a text layer with the Type tool edits it in place (the layer re-renders as you
  type); color and font apply to the selected letters as runs (the Mac app's `colorRuns`/`fontRuns`, saved in `.comp`),
  size/alignment/tracking to the whole layer. Shape layers redraw at their new size when scaled (corners keep their
  radius), and with a shape layer selected the Shape options edit its color, corner radius or line width. Differences:
  layout is canvas 2D instead of Core Text (line breaking and kerning can differ slightly) and
  gradients are rasterized. Size stays per layer, as in the Mac app.
- **Layer effects** run the Mac app's own effect passes (`MetalLayerEffects.swift`: coverage, sliding-window spread for
  the stroke, shifted and Gaussian-blurred coverage for shadows and glows, then `effects_compose`) translated to C and
  compiled to wasm (`wasm/src/EffectsPixels.c`), in the layer's own pixel units, with the layer mask applied before the
  effects as the Mac app does. Blurs wider than 64 px use three box passes of matching variance instead of the direct
  Gaussian loop. **Bloom / Glow** is still an approximation (a blurred copy screened over the image); Core Image's
  `CIBloom` kernel isn't public.
- **Performance:** filters run in a pool of Web Workers (one per core, up to 8), each with its own copy of the wasm
  module. Per-pixel filters and the blurs (with overlapping rows) are split into strips across the pool; filters that
  need the whole image (Camera Raw, lens correction, vignette) run in one worker so the page stays responsive, and Dither
  stays on the main thread. This uses transferred buffers, not SharedArrayBuffer: wasm threads need cross-origin
  isolation headers (COOP/COEP), which GitHub Pages can't send. Each kernel call is still single-threaded
  (`dispatch_apply` is serial). Adjustment layers are recomputed in the workers too: while a new result is on its way the
  canvas keeps showing the previous one, and exports, the eyedropper and other reads compute it exactly first.
- **Hue/Saturation:** all seven ranges, Invert Range and editable hue bands (drag the spectrum handles, or drag inside the band to slide it) on both the filter and adjustment layers, saved as the Mac app’s `hsvSettings`. The panel’s eyedroppers (Sample / Add / Remove re-center, widen or narrow the selected range’s band from a color in the image, as `HueBand.centered/include/exclude`) and the targeted-adjustment drag (saturation, or hue with ⌘/Ctrl, of the range owning the color under the pointer) are ported too.
- `.comp` projects are saved as a `.comp.zip` by default. In Chromium-based browsers (Chrome, Edge), File › Save as .comp
  Folder… writes the real package folder (File System Access API) that the Mac app opens directly; Safari and Firefox
  can't write folders, so there you unzip the `.comp.zip`.
- No Sparkle updates, Quick Look, or document-based windowing; tabs replace windows.
