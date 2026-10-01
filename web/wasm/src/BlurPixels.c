// Gaussian and motion blur for the web build. The Mac app gets these from Core Image (CIGaussianBlur, CIMotionBlur);
// the browser's canvas `filter: blur()` isn't available in workers or Safari, so they are plain C here and run in the
// same wasm module as the original kernels, one strip of rows per worker.
//
// Pixels are premultiplied RGBA8 (as every kernel here). `clamp` = 1 extends the edge pixels outward
// (clampedToExtent), 0 treats everything outside the buffer as transparent.
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static void box_pass(const float *in, float *out, int count, int stride, int r, int clamp, float *tmp) {
  for (int i = 0; i < count; i++) for (int c = 0; c < 4; c++) tmp[i * 4 + c] = in[i * stride + c];
  double inv = 1.0 / (2 * r + 1), acc[4] = {0, 0, 0, 0};
#define AT(k, c) ((k) < 0 ? (clamp ? tmp[(c)] : 0.f) : (k) >= count ? (clamp ? tmp[(count - 1) * 4 + (c)] : 0.f) : tmp[(k) * 4 + (c)])
  for (int k = -r; k <= r; k++) for (int c = 0; c < 4; c++) acc[c] += AT(k, c);
  for (int i = 0; i < count; i++) {
    for (int c = 0; c < 4; c++) {
      out[i * stride + c] = (float)(acc[c] * inv);
      acc[c] += AT(i + r + 1, c) - AT(i - r, c);
    }
  }
#undef AT
}

static void gauss_pass(const float *in, float *out, int count, int stride, const float *k, int r, int clamp, float *tmp) {
  for (int i = 0; i < count; i++) for (int c = 0; c < 4; c++) tmp[i * 4 + c] = in[i * stride + c];
  for (int i = 0; i < count; i++) {
    float a0 = 0, a1 = 0, a2 = 0, a3 = 0;
    for (int o = -r; o <= r; o++) {
      int s = i + o;
      if (s < 0 || s >= count) { if (!clamp) continue; s = s < 0 ? 0 : count - 1; }
      float w = k[o + r]; const float *p = tmp + s * 4;
      a0 += w * p[0]; a1 += w * p[1]; a2 += w * p[2]; a3 += w * p[3];
    }
    float *q = out + i * stride; q[0] = a0; q[1] = a1; q[2] = a2; q[3] = a3;
  }
}

// A Gaussian of standard deviation `sigma` reaching 3 sigma: the direct kernel up to a reach of 24 pixels, three box
// passes of the same variance past that (what browsers and Core Image do for wide blurs too).
int gauss_blur(uint8_t *pixels, int w, int h, float sigma, int clamp) {
  if (sigma <= 0.05f || w <= 0 || h <= 0) return 1;
  int n = w * h, big = w > h ? w : h;
  float *buf = malloc(sizeof(float) * 4 * n), *tmp = malloc(sizeof(float) * 4 * (big + 1));
  if (!buf || !tmp) { free(buf); free(tmp); return 0; }
  for (int i = 0; i < 4 * n; i++) buf[i] = pixels[i];
  int radius = (int)ceilf(sigma * 3);
  if (radius <= 24) {
    float *k = malloc(sizeof(float) * (2 * radius + 1)), sum = 0;
    for (int o = -radius; o <= radius; o++) { k[o + radius] = expf(-(float)(o * o) / (2 * sigma * sigma)); sum += k[o + radius]; }
    for (int i = 0; i <= 2 * radius; i++) k[i] /= sum;
    for (int y = 0; y < h; y++) gauss_pass(buf + y * w * 4, buf + y * w * 4, w, 4, k, radius, clamp, tmp);
    for (int x = 0; x < w; x++) gauss_pass(buf + x * 4, buf + x * 4, h, w * 4, k, radius, clamp, tmp);
    free(k);
  } else {
    float wIdeal = sqrtf(12 * sigma * sigma / 3 + 1);
    int wl = (int)floorf(wIdeal); if (wl % 2 == 0) wl--;
    int wu = wl + 2, m = (int)roundf((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4.f * wl - 4));
    for (int pass = 0; pass < 3; pass++) {
      int r = ((pass < m ? wl : wu) - 1) / 2;
      for (int y = 0; y < h; y++) box_pass(buf + y * w * 4, buf + y * w * 4, w, 4, r, clamp, tmp);
      for (int x = 0; x < w; x++) box_pass(buf + x * 4, buf + x * 4, h, w * 4, r, clamp, tmp);
    }
  }
  for (int i = 0; i < 4 * n; i++) { float v = buf[i] + 0.5f; pixels[i] = v < 0 ? 0 : v > 255 ? 255 : (uint8_t)v; }
  // Premultiplied: color can't exceed alpha.
  for (int i = 0; i < n; i++) { uint8_t a = pixels[i * 4 + 3]; for (int c = 0; c < 3; c++) if (pixels[i * 4 + c] > a) pixels[i * 4 + c] = a; }
  free(buf); free(tmp);
  return 1;
}

// The average of `samples` copies spread evenly along a streak of `length` pixels at `angle` (radians, y down),
// sampled bilinearly; outside the buffer is transparent.
int motion_blur(const uint8_t *src, uint8_t *dst, int w, int h, float dx, float dy, float length, int samples) {
  if (samples < 2) samples = 2;
  for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
    float acc[4] = {0, 0, 0, 0};
    for (int i = 0; i < samples; i++) {
      float t = ((float)i / (samples - 1) - 0.5f) * length;
      float sx = x - t * dx, sy = y - t * dy;
      int x0 = (int)floorf(sx), y0 = (int)floorf(sy);
      float fx = sx - x0, fy = sy - y0;
      for (int j = 0; j < 4; j++) {
        int xx = x0 + (j & 1), yy = y0 + (j >> 1);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        float wgt = ((j & 1) ? fx : 1 - fx) * ((j >> 1) ? fy : 1 - fy);
        const uint8_t *p = src + (yy * w + xx) * 4;
        acc[0] += wgt * p[0]; acc[1] += wgt * p[1]; acc[2] += wgt * p[2]; acc[3] += wgt * p[3];
      }
    }
    uint8_t *q = dst + (y * w + x) * 4;
    for (int c = 0; c < 4; c++) { float v = acc[c] / samples + 0.5f; q[c] = v > 255 ? 255 : (uint8_t)v; }
  }
  return 1;
}
