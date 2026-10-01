// Layer effects, translated from Compositor/Rendering/MetalLayerEffects.swift (the Metal compute kernels) and the
// CPU fallback in Compositor/Document/LayerEffects.swift (`extreme`, the sliding-window spread). Same passes, same
// order and the same compositing as `effects_compose`; the GPU's per-pixel loops become plain loops here.
//
// Pixels are premultiplied RGBA8, already padded by the effects' margin (LayerEffectsRenderer.margin).
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static float clampf(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }
static float mixf(float a, float b, float t) { return a + (b - a) * t; }

// LayerEffectsRenderer.extreme: the largest (or smallest) value within `reach` on each side, two sliding-window
// passes; outside the image counts as nothing.
static void extreme(const float *src, float *dst, float *pass, int *queue, int w, int h, int reach, int smallest) {
  for (int dir = 0; dir < 2; dir++) {
    const float *in = dir == 0 ? src : pass;
    float *out = dir == 0 ? pass : dst;
    int lines = dir == 0 ? h : w, count = dir == 0 ? w : h;
    int lineStep = dir == 0 ? w : 1, step = dir == 0 ? 1 : w;
    for (int line = 0; line < lines; line++) {
      int base = line * lineStep, head = 0, tail = 0, next = 0;
      for (int c = 0; c < count; c++) {
        int last = c + reach < count - 1 ? c + reach : count - 1;
        while (next <= last) {
          float v = in[base + next * step];
          while (tail > head) {
            float p = in[base + queue[tail - 1] * step];
            if (smallest ? p < v : p > v) break;
            tail--;
          }
          queue[tail++] = next++;
        }
        while (head < tail && queue[head] < c - reach) head++;
        int outside = c < reach || c + reach >= count;
        out[base + c * step] = smallest && outside ? 0.f : in[base + queue[head] * step];
      }
    }
  }
}

// effects_shift: moved by (dx, dy) with bilinear sampling; outside is nothing.
static void shift(const float *src, float *dst, int w, int h, float dx, float dy) {
  for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
    float sx = x - dx, sy = y - dy, v = 0;
    if (sx >= 0 && sy >= 0 && sx <= w - 1 && sy <= h - 1) {
      int x0 = (int)floorf(sx), y0 = (int)floorf(sy);
      int x1 = x0 + 1 < w ? x0 + 1 : w - 1, y1 = y0 + 1 < h ? y0 + 1 : h - 1;
      float fx = sx - x0, fy = sy - y0;
      v = mixf(mixf(src[y0 * w + x0], src[y0 * w + x1], fx), mixf(src[y1 * w + x0], src[y1 * w + x1], fx), fy);
    }
    dst[y * w + x] = v;
  }
}

// One running box pass along each line, edge pixels repeated (as the Gaussian's clamped samples are).
static void box_line(const float *in, float *out, int count, int step, int r, float *tmp) {
  for (int i = 0; i < count; i++) tmp[i] = in[i * step];
  float inv = 1.f / (2 * r + 1), acc = 0;
  for (int k = -r; k <= r; k++) acc += tmp[k < 0 ? 0 : k >= count ? count - 1 : k];
  for (int i = 0; i < count; i++) {
    out[i * step] = acc * inv;
    int add = i + r + 1, sub = i - r;
    acc += tmp[add >= count ? count - 1 : add] - tmp[sub < 0 ? 0 : sub];
  }
}

// effects_blur_rows + effects_blur_columns: a Gaussian of `sigma` reaching 3 sigma, samples clamped to the edge.
// Exact up to a reach of 64 pixels; past that three box passes of matching variance (the GPU's direct loop would take
// seconds on the CPU, and the difference is below 8-bit precision for blurs that wide).
static void blur(const float *src, float *dst, float *scratch, float *line, int w, int h, float sigma) {
  int radius = (int)roundf(sigma * 3); if (radius < 1) radius = 1;
  if (radius <= 64) {
    float *k = (float *)malloc(sizeof(float) * (2 * radius + 1)), sum = 0;
    for (int o = -radius; o <= radius; o++) { k[o + radius] = expf(-(float)(o * o) / (2 * sigma * sigma)); sum += k[o + radius]; }
    for (int i = 0; i <= 2 * radius; i++) k[i] /= sum;
    for (int y = 0; y < h; y++) {
      const float *row = src + y * w;
      for (int x = 0; x < w; x++) {
        float t = 0;
        for (int o = -radius; o <= radius; o++) { int s = x + o; s = s < 0 ? 0 : s >= w ? w - 1 : s; t += k[o + radius] * row[s]; }
        scratch[y * w + x] = t;
      }
    }
    for (int x = 0; x < w; x++) {
      for (int y = 0; y < h; y++) line[y] = scratch[y * w + x];
      for (int y = 0; y < h; y++) {
        float t = 0;
        for (int o = -radius; o <= radius; o++) { int s = y + o; s = s < 0 ? 0 : s >= h ? h - 1 : s; t += k[o + radius] * line[s]; }
        dst[y * w + x] = t;
      }
    }
    free(k);
    return;
  }
  // Three boxes: widths from the standard "boxes for Gauss" construction.
  float wIdeal = sqrtf(12 * sigma * sigma / 3 + 1);
  int wl = (int)floorf(wIdeal); if (wl % 2 == 0) wl--;
  int wu = wl + 2;
  float mIdeal = (12 * sigma * sigma - 3 * wl * wl - 4 * 3 * wl - 3 * 3) / (-4.f * wl - 4);
  int m = (int)roundf(mIdeal);
  float *tmp = line;
  memcpy(dst, src, sizeof(float) * w * h);
  for (int i = 0; i < 3; i++) {
    int r = ((i < m ? wl : wu) - 1) / 2;
    for (int y = 0; y < h; y++) box_line(dst + y * w, scratch + y * w, w, 1, r, tmp);
    for (int x = 0; x < w; x++) box_line(scratch + x, dst + x, h, w, r, tmp);
  }
}

// params: see effects.ts (`layerEffectsWasm`): 6 groups of [r, g, b, opacity, on, a, b, c].
//   0 stroke (size, inside)   8 shadow (dx, dy, blur)   16 overlay   24 inner shadow (dx, dy, blur)
//   32 outer glow (size)      40 inner glow (size)
int layer_effects(const uint8_t *pixels, uint8_t *result, int width, int height, const float *p) {
  int n = width * height, big = width > height ? width : height;
  float *first = calloc(n, 4), *second = calloc(n, 4), *third = calloc(n, 4), *scratch = calloc(n, 4);
  float *inner = calloc(n, 4), *glow = calloc(n, 4), *innerGlow = calloc(n, 4), *line = calloc(big + 1, 4);
  int *queue = calloc(big + 1, sizeof(int));
  if (!first || !second || !third || !scratch || !inner || !glow || !innerGlow || !line || !queue) {
    free(first); free(second); free(third); free(scratch); free(inner); free(glow); free(innerGlow); free(line); free(queue);
    return 0;
  }
  for (int i = 0; i < n; i++) first[i] = pixels[i * 4 + 3] / 255.f;   // effects_alpha
  const float *st = p, *sh = p + 8, *ov = p + 16, *is = p + 24, *og = p + 32, *ig = p + 40;
  int hasStroke = st[4] > 0, strokeInside = st[6] > 0, hasShadow = sh[4] > 0, hasOverlay = ov[4] > 0;
  int hasInner = is[4] > 0, hasGlow = og[4] > 0, hasInnerGlow = ig[4] > 0;
  if (hasStroke) {
    int reach = (int)roundf(st[5]); if (reach < 1) reach = 1;
    extreme(first, second, scratch, queue, width, height, reach, strokeInside);
    for (int i = 0; i < n; i++) third[i] = clampf(strokeInside ? first[i] - second[i] : second[i] - first[i], 0, 1);   // effects_ring
  }
  if (hasShadow) {
    shift(first, second, width, height, sh[5], sh[6]);
    float sigma = sh[7] / 2;
    if (sigma > 0.01f) { memcpy(scratch, second, 4 * n); blur(scratch, second, glow, line, width, height, sigma); }
  }
  if (hasInner) {
    shift(first, scratch, width, height, is[5], is[6]);
    float sigma = is[7] / 2;
    if (sigma > 0.01f) { memcpy(inner, scratch, 4 * n); blur(inner, scratch, glow, line, width, height, sigma); }
    for (int i = 0; i < n; i++) inner[i] = clampf(first[i] * (1 - scratch[i]), 0, 1);   // effects_inside
  }
  if (hasGlow) {
    float sigma = og[5] / 2;
    if (sigma > 0.01f) blur(first, glow, scratch, line, width, height, sigma); else memcpy(glow, first, 4 * n);
  }
  if (hasInnerGlow) {
    float sigma = ig[5] / 2;
    if (sigma > 0.01f) blur(first, innerGlow, scratch, line, width, height, sigma); else memcpy(innerGlow, first, 4 * n);
    for (int i = 0; i < n; i++) innerGlow[i] = clampf(first[i] * (1 - innerGlow[i]), 0, 1);
  }
  // effects_compose: shadow behind, outer glow over it, an outside stroke over that, the pixels, then the color
  // overlay, inner glow, inner shadow and an inside stroke on top.
  for (int i = 0; i < n; i++) {
    float r = 0, g = 0, b = 0, a = 0, c;
    #define OVER(col, cov) do { c = (cov); r = (col)[0] * c + r * (1 - c); g = (col)[1] * c + g * (1 - c); b = (col)[2] * c + b * (1 - c); a = c + a * (1 - c); } while (0)
    if (hasShadow) { c = clampf(second[i] * sh[3], 0, 1); r = sh[0] * c; g = sh[1] * c; b = sh[2] * c; a = c; }
    if (hasGlow) OVER(og, clampf(glow[i] * (1 - first[i]) * og[3], 0, 1));
    float strokeCov = hasStroke ? clampf(third[i] * st[3], 0, 1) : 0;
    if (hasStroke && !strokeInside) OVER(st, strokeCov);
    const uint8_t *s = pixels + i * 4;
    float sa = s[3] / 255.f;
    r = s[0] / 255.f + r * (1 - sa); g = s[1] / 255.f + g * (1 - sa); b = s[2] / 255.f + b * (1 - sa); a = sa + a * (1 - sa);
    if (hasOverlay) OVER(ov, clampf(first[i] * ov[3], 0, 1));
    if (hasInnerGlow) OVER(ig, clampf(innerGlow[i] * ig[3], 0, 1));
    if (hasInner) OVER(is, clampf(inner[i] * is[3], 0, 1));
    if (hasStroke && strokeInside) OVER(st, strokeCov);
    #undef OVER
    uint8_t *o = result + i * 4;
    o[0] = (uint8_t)(clampf(r, 0, 1) * 255 + 0.5f); o[1] = (uint8_t)(clampf(g, 0, 1) * 255 + 0.5f);
    o[2] = (uint8_t)(clampf(b, 0, 1) * 255 + 0.5f); o[3] = (uint8_t)(clampf(a, 0, 1) * 255 + 0.5f);
  }
  free(first); free(second); free(third); free(scratch); free(inner); free(glow); free(innerGlow); free(line); free(queue);
  return 1;
}
