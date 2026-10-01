// Object Selection helpers, from Compositor/Document/ObjectSelection.swift.
//
// edge_preserve_upsample stands in for Core Image's CIEdgePreserveUpsampleFilter, which the Mac app uses to bring
// Vision's low-resolution instance mask up to the image's size along the image's own edges: a joint bilateral
// upsample (each output pixel averages nearby low-resolution mask values, weighted by distance and by how close the
// guide image's luma there is to its own).
// mask_morph is ObjectSelection.adjusted: `steps` rounds of 3x3 erosion (or dilation) of a 0/255 mask.
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static float luma(const uint8_t *p) { return (0.299f * p[0] + 0.587f * p[1] + 0.114f * p[2]) / 255.f; }

int edge_preserve_upsample(const float *small, int sw, int sh, const uint8_t *guide, int w, int h, float *out,
                           float spatialSigma, float lumaSigma) {
  if (sw <= 0 || sh <= 0 || w <= 0 || h <= 0) return 0;
  // The guide's luma averaged over each low-resolution cell, so both sides of the comparison see the same detail.
  float *low = calloc((size_t)sw * sh, sizeof(float));
  int *count = calloc((size_t)sw * sh, sizeof(int));
  if (!low || !count) { free(low); free(count); return 0; }
  for (int y = 0; y < h; y++) {
    int cy = (int)((long long)y * sh / h);
    for (int x = 0; x < w; x++) {
      int cx = (int)((long long)x * sw / w);
      low[cy * sw + cx] += luma(guide + ((size_t)y * w + x) * 4); count[cy * sw + cx]++;
    }
  }
  for (int i = 0; i < sw * sh; i++) if (count[i]) low[i] /= count[i];
  float s2 = 2 * spatialSigma * spatialSigma, l2 = 2 * lumaSigma * lumaSigma;
  int reach = (int)ceilf(spatialSigma * 2);
  for (int y = 0; y < h; y++) {
    float v = (y + 0.5f) * sh / h - 0.5f;
    int v0 = (int)floorf(v);
    for (int x = 0; x < w; x++) {
      float u = (x + 0.5f) * sw / w - 0.5f;
      int u0 = (int)floorf(u);
      float L = luma(guide + ((size_t)y * w + x) * 4), sum = 0, wsum = 0, nearest = 0, best = 1e9f;
      for (int j = v0 - reach + 1; j <= v0 + reach; j++) {
        if (j < 0 || j >= sh) continue;
        for (int i = u0 - reach + 1; i <= u0 + reach; i++) {
          if (i < 0 || i >= sw) continue;
          float du = i - u, dv = j - v, d2 = du * du + dv * dv, dl = L - low[j * sw + i];
          float wt = expf(-d2 / s2 - dl * dl / l2);
          sum += wt * small[j * sw + i]; wsum += wt;
          if (d2 < best) { best = d2; nearest = small[j * sw + i]; }
        }
      }
      out[(size_t)y * w + x] = wsum > 1e-12f ? sum / wsum : nearest;
    }
  }
  free(low); free(count);
  return 1;
}

int mask_morph(uint8_t *mask, int w, int h, int steps, int erode) {
  uint8_t *src = malloc((size_t)w * h);
  if (!src) return 0;
  for (int s = 0; s < steps; s++) {
    memcpy(src, mask, (size_t)w * h);
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      uint8_t v = src[y * w + x];
      if (erode ? v == 0 : v != 0) continue;
      int hit = 0;
      for (int ny = y > 0 ? y - 1 : 0; ny <= (y < h - 1 ? y + 1 : h - 1) && !hit; ny++)
        for (int nx = x > 0 ? x - 1 : 0; nx <= (x < w - 1 ? x + 1 : w - 1); nx++)
          if (erode ? src[ny * w + nx] == 0 : src[ny * w + nx] != 0) { hit = 1; break; }
      if (hit) mask[y * w + x] = erode ? 0 : 255;
    }
  }
  free(src);
  return 1;
}
