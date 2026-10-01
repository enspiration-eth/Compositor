// Remove Background's matte refinements, translated from Compositor/Document/GuidedMatte.swift (He, Sun & Tang's guided
// filter) and SubjectRemoval.swift's `refined` (Shift Edge, Contrast, done there with Core Image filters).
// Masks and guides are 0–1 floats, row-major.
#include <math.h>
#include <stdlib.h>
#include <string.h>

/// Mean over a (2r+1)² square, as two running-sum passes. `tmp` holds width*height floats.
static void box(const float *src, float *out, float *tmp, int width, int height, int radius) {
  float span = (float)(radius * 2 + 1);
  for (int y = 0; y < height; y++) {
    int row = y * width; float sum = 0;
    for (int x = -radius; x <= radius; x++) { int xx = x < 0 ? 0 : x > width - 1 ? width - 1 : x; sum += src[row + xx]; }
    for (int x = 0; x < width; x++) {
      tmp[row + x] = sum / span;
      int a = x - radius; a = a < 0 ? 0 : a > width - 1 ? width - 1 : a;
      int b = x + radius + 1; b = b < 0 ? 0 : b > width - 1 ? width - 1 : b;
      sum -= src[row + a]; sum += src[row + b];
    }
  }
  for (int x = 0; x < width; x++) {
    float sum = 0;
    for (int y = -radius; y <= radius; y++) { int yy = y < 0 ? 0 : y > height - 1 ? height - 1 : y; sum += tmp[yy * width + x]; }
    for (int y = 0; y < height; y++) {
      out[y * width + x] = sum / span;
      int a = y - radius; a = a < 0 ? 0 : a > height - 1 ? height - 1 : a;
      int b = y + radius + 1; b = b < 0 ? 0 : b > height - 1 ? height - 1 : b;
      sum -= tmp[a * width + x]; sum += tmp[b * width + x];
    }
  }
}

/// GuidedMatte.filter: `mask` refined by `guide` in place. Returns 0 when out of memory.
int matte_guided_filter(float *mask, const float *guide, int width, int height, int radius, float epsilon) {
  size_t n = (size_t)width * height;
  float *buf = (float *)malloc(sizeof(float) * n * 7);
  if (!buf) return 0;
  float *meanGuide = buf, *meanMask = buf + n, *a = buf + 2 * n, *b = buf + 3 * n, *meanSq = buf + 4 * n, *meanProd = buf + 5 * n, *tmp = buf + 6 * n;
  box(guide, meanGuide, tmp, width, height, radius);
  box(mask, meanMask, tmp, width, height, radius);
  for (size_t i = 0; i < n; i++) { a[i] = guide[i] * guide[i]; b[i] = guide[i] * mask[i]; }
  box(a, meanSq, tmp, width, height, radius);
  box(b, meanProd, tmp, width, height, radius);
  for (size_t i = 0; i < n; i++) {
    float variance = meanSq[i] - meanGuide[i] * meanGuide[i];
    float covariance = meanProd[i] - meanGuide[i] * meanMask[i];
    a[i] = covariance / (variance + epsilon);
    b[i] = meanMask[i] - a[i] * meanGuide[i];
  }
  box(a, meanSq, tmp, width, height, radius);   // mean slope
  box(b, meanProd, tmp, width, height, radius); // mean offset
  for (size_t i = 0; i < n; i++) { float v = meanSq[i] * guide[i] + meanProd[i]; mask[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  free(buf);
  return 1;
}

/// Shift Edge: a Gaussian blur (three box passes of matching variance) then a hard threshold at the matching level,
/// which moves the edge by the blur's reach. Negative shrinks, positive grows.
int matte_shift_edge(float *mask, int width, int height, float shift) {
  if (shift == 0) return 1;
  size_t n = (size_t)width * height;
  float *buf = (float *)malloc(sizeof(float) * n * 2);
  if (!buf) return 0;
  float sigma = fabsf(shift) / 2;
  // Box radius whose three passes approximate the Gaussian: variance of one box is ((2r+1)^2 - 1) / 12.
  int r = (int)floorf((sqrtf(4 * sigma * sigma + 1) - 1) / 2 + 0.5f);
  if (r < 1) r = 1;
  for (int pass = 0; pass < 3; pass++) { box(mask, buf, buf + n, width, height, r); memcpy(mask, buf, sizeof(float) * n); }
  float level = shift < 0 ? 0.75f : 0.25f, scale = 1 / 0.001f;
  for (size_t i = 0; i < n; i++) {
    float v = mask[i]; v = v < level ? level : v > level + 0.001f ? level + 0.001f : v;
    v = (v - level) * scale; mask[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  free(buf);
  return 1;
}

/// Contrast: 0 leaves the mask as it is; 100 is a hard cut at the middle.
void matte_contrast(float *mask, int count, float amount) {
  if (amount <= 0) return;
  float strength = amount / 100, slope = 1 / fmaxf(0.02f, 1 - strength * 0.98f), bias = (1 - slope) / 2;
  for (int i = 0; i < count; i++) { float v = mask[i] * slope + bias; mask[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
}
