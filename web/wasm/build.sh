#!/usr/bin/env bash
# Compiles Compositor's original C pixel kernels (../../Compositor/Rendering/*.c, used verbatim, never copied)
# to WebAssembly with Emscripten. Output: web/src/wasm/pixels.mjs + pixels.wasm.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../../Compositor/Rendering"
out="$here/../src/wasm"
mkdir -p "$out"
exports='_malloc,_free,_levels_apply,_levels_histogram,_cube_apply,_noise_add,_noise_add_at,_wand_mask,_wand_trace,_color_range_mask,_spot_heal,_heal_coverage_bounds,_content_fill,_adjust_gradient_map,_adjust_grain,_adjust_black_white,_adjust_color_balance,_adjust_camera_raw,_adjust_camera_raw_effects,_adjust_camera_raw_curve_color,_adjust_camera_raw_detail,_adjust_camera_raw_optics,_adjust_camera_raw_calibration,_adjust_camera_raw_sharpen_mask_overlay,_adjust_colored_vignette,_adjust_tonal_contrast,_lens_distort,_dither_apply,_dither_dots,_brush_alpha_bounds,_rgba_clamp_premultiplied,_warp_pick_up,_warp_smudge,_warp_push,_matte_guided_filter,_matte_shift_edge,_matte_contrast,_distort_warp,_layer_effects,_gauss_blur,_motion_blur,_edge_preserve_upsample,_mask_morph,_mask_grow'
emcc -O3 -fblocks -I"$here/shim" -I"$src" \
  "$src/AdjustPixels.c" "$src/BrushPixels.c" "$src/ContentFill.c" "$src/DitherPixels.c" "$src/HealPixels.c" \
  "$src/LensPixels.c" "$src/LevelsPixels.c" "$src/NoisePixels.c" "$src/WandPixels.c" "$here/src/WarpPixels.c" "$here/src/MattePixels.c" "$here/src/DistortPixels.c" "$here/src/EffectsPixels.c" "$here/src/BlurPixels.c" "$here/src/ObjectPixels.c" "$here/shim/blocks_runtime.c" \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web,worker,node -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=4GB \
  -s INITIAL_MEMORY=64MB -s FILESYSTEM=0 -s EXPORT_NAME=createPixels \
  -s "EXPORTED_FUNCTIONS=[$exports]" -s 'EXPORTED_RUNTIME_METHODS=["HEAPU8","HEAPF32","HEAPF64","HEAP32","HEAPU32"]' \
  -o "$out/pixels.mjs"
echo "built $out/pixels.mjs"
