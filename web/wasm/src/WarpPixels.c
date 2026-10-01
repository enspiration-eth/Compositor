// Smudge and Liquify, translated line for line from Compositor/Document/SmudgeLiquify.swift (WarpStroke's CPU path) so
// the web build runs the Mac app's algorithm in WebAssembly. Pixels are premultiplied RGBA8, top-left rows.
#include <math.h>
#include <stdint.h>
#include <stdlib.h>

static float *carried = 0, *scratch = 0;
static int carriedCap = 0, scratchCap = 0;

static float *grow(float **buf, int *cap, int n) {
  if (*cap < n) { free(*buf); *buf = (float *)malloc(sizeof(float) * (size_t)n); *cap = *buf ? n : 0; }
  return *buf;
}
static inline uint8_t clamp8(float v) { v = roundf(v); return (uint8_t)(v < 0 ? 0 : v > 255 ? 255 : v); }

/// How much a dab moves pixels at a distance `u` (0 center, 1 rim) from its center.
static inline float warp_weight(float u, float h) {
  if (u >= 1) return 0;
  if (u <= h) return 1;
  float t = (1 - u) / (1 - h);
  return t * t * (3 - 2 * t);
}

/// Smudge: picks up the (2r+1)² square under the brush at the start of a stroke.
int warp_pick_up(const uint8_t *pixels, int width, int height, float cx_, float cy_, int r) {
  int side = 2 * r + 1;
  float *c = grow(&carried, &carriedCap, side * side * 4);
  if (!c) return 0;
  for (int i = 0; i < side * side * 4; i++) c[i] = 0;
  int cx = (int)roundf(cx_), cy = (int)roundf(cy_);
  for (int dy = -r; dy <= r; dy++) {
    int y = cy + dy; if (y < 0 || y >= height) continue;
    for (int dx = -r; dx <= r; dx++) {
      int x = cx + dx; if (x < 0 || x >= width) continue;
      int p = (y * width + x) * 4, q = ((dy + r) * side + dx + r) * 4;
      for (int k = 0; k < 4; k++) c[q + k] = pixels[p + k];
    }
  }
  return 1;
}

void warp_smudge(uint8_t *pixels, int width, int height, float cx_, float cy_, int r, float diameter, float hardness, float strength) {
  if (!carried) return;
  int side = 2 * r + 1;
  int cx = (int)roundf(cx_), cy = (int)roundf(cy_);
  float keep = strength, invR = 1 / (diameter / 2);
  for (int dy = -r; dy <= r; dy++) {
    int y = cy + dy; if (y < 0 || y >= height) continue;
    for (int dx = -r; dx <= r; dx++) {
      int x = cx + dx; if (x < 0 || x >= width) continue;
      float w = warp_weight(sqrtf((float)(dx * dx + dy * dy)) * invR, hardness);
      if (w <= 0) continue;
      int p = (y * width + x) * 4, q = ((dy + r) * side + dx + r) * 4;
      for (int k = 0; k < 4; k++) {
        float under = pixels[p + k];
        float painted = under + (carried[q + k] - under) * w * keep;
        uint8_t out = clamp8(painted);
        pixels[p + k] = out;
        carried[q + k] = painted;
      }
    }
  }
}

/// Forward warp: pixels under the brush move with it, most at its center, fading to none at its rim.
void warp_push(uint8_t *pixels, int width, int height, float ax, float ay, float bx, float by, int r, float diameter, float hardness, float strength) {
  float mx = (bx - ax) * strength, my = (by - ay) * strength;
  int margin = (int)ceilf(fmaxf(fabsf(mx), fabsf(my))) + 2;
  int cx = (int)roundf(bx), cy = (int)roundf(by);
  int x0 = cx - r - margin; if (x0 < 0) x0 = 0;
  int x1 = cx + r + margin; if (x1 > width - 1) x1 = width - 1;
  int y0 = cy - r - margin; if (y0 < 0) y0 = 0;
  int y1 = cy + r + margin; if (y1 > height - 1) y1 = height - 1;
  if (x0 > x1 || y0 > y1) return;
  int cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  float *s = grow(&scratch, &scratchCap, cw * ch * 4);
  if (!s) return;
  for (int y = 0; y < ch; y++)
    for (int x = 0; x < cw; x++) {
      int p = ((y + y0) * width + x + x0) * 4, q = (y * cw + x) * 4;
      for (int k = 0; k < 4; k++) s[q + k] = pixels[p + k];
    }
  float invR = 1 / (diameter / 2);
  for (int dy = -r; dy <= r; dy++) {
    int y = cy + dy; if (y < y0 || y > y1) continue;
    for (int dx = -r; dx <= r; dx++) {
      int x = cx + dx; if (x < x0 || x > x1) continue;
      float w = warp_weight(sqrtf((float)(dx * dx + dy * dy)) * invR, hardness);
      if (w <= 0) continue;
      float sx = fminf((float)(cw - 1), fmaxf(0, (float)(x - x0) - mx * w));
      float sy = fminf((float)(ch - 1), fmaxf(0, (float)(y - y0) - my * w));
      int ix = (int)sx; if (ix > cw - 2) ix = cw - 2;
      int iy = (int)sy; if (iy > ch - 2) iy = ch - 2;
      if (ix < 0 || iy < 0) continue;
      float fx = sx - ix, fy = sy - iy;
      int p = (y * width + x) * 4;
      int s00 = (iy * cw + ix) * 4, s10 = s00 + 4, s01 = s00 + cw * 4, s11 = s01 + 4;
      for (int k = 0; k < 4; k++) {
        float top = s[s00 + k] + (s[s10 + k] - s[s00 + k]) * fx;
        float bottom = s[s01 + k] + (s[s11 + k] - s[s01 + k]) * fx;
        pixels[p + k] = clamp8(top + (bottom - top) * fy);
      }
    }
  }
}
