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

// Selection › Expand / Contract (Selection.swift resizeSelection): the outline grown or shrunk by `amount` pixels with
// round corners — the union with (or removal of) a round-capped band `amount` wide on each side of the outline, which
// is a Euclidean dilation (erosion) by a disk. Done with an exact Euclidean distance transform (Felzenszwalb &
// Huttenlocher) on the selection's alpha, with a one-pixel anti-aliased edge. Contracting also pulls away from the
// canvas edges, as the Mac app's does.
static void edt_1d(const float *f, float *d, int *v, double *z, int n) {
  int k = 0; v[0] = 0; z[0] = -1e300; z[1] = 1e300;
  for (int q = 1; q < n; q++) {
    double s;
    for (;;) {
      int p = v[k];
      s = (((double)f[q] + (double)q * q) - ((double)f[p] + (double)p * p)) / (2.0 * q - 2.0 * p);
      if (s <= z[k] && k > 0) { k--; continue; }
      break;
    }
    if (s <= z[k]) { v[0] = q; z[0] = -1e300; z[1] = 1e300; k = 0; continue; }   // only when k == 0
    k++; v[k] = q; z[k] = s; z[k + 1] = 1e300;
  }
  k = 0;
  for (int q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    double dq = (double)(q - v[k]);
    d[q] = (float)(dq * dq + f[v[k]]);
  }
}
// Squared distance from every pixel to the nearest pixel where `inside` is set (pad = 1 adds a ring of such pixels
// just outside the image, so distances also count the canvas edge).
static int edt(const uint8_t *inside, int w, int h, int pad, float *out) {
  int W = w + 2 * pad, H = h + 2 * pad, n = W > H ? W : H;
  float *g = malloc(sizeof(float) * W * H), *f = malloc(sizeof(float) * n), *d = malloc(sizeof(float) * n);
  double *z = malloc(sizeof(double) * (n + 1));
  int *v = malloc(sizeof(int) * n);
  if (!g || !f || !d || !z || !v) { free(g); free(f); free(d); free(z); free(v); return 0; }
  const float INF = 1e20f;
  for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
    int ix = x - pad, iy = y - pad;
    int on = (ix < 0 || iy < 0 || ix >= w || iy >= h) ? 1 : inside[iy * w + ix];
    g[y * W + x] = on ? 0 : INF;
  }
  for (int x = 0; x < W; x++) {
    for (int y = 0; y < H; y++) f[y] = g[y * W + x];
    edt_1d(f, d, v, z, H);
    for (int y = 0; y < H; y++) g[y * W + x] = d[y];
  }
  for (int y = 0; y < H; y++) {
    edt_1d(g + y * W, d, v, z, W);
    memcpy(g + y * W, d, sizeof(float) * W);
  }
  for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) out[y * w + x] = g[(y + pad) * W + x + pad];
  free(g); free(f); free(d); free(z); free(v);
  return 1;
}

int mask_grow(uint8_t *alpha, int w, int h, float amount) {
  int n = w * h;
  uint8_t *inside = malloc(n);
  float *dist = malloc(sizeof(float) * n);
  if (!inside || !dist) { free(inside); free(dist); return 0; }
  int grow = amount > 0;
  // Expand: distance to the selection. Contract: distance to what is not selected (and to past the canvas edge).
  for (int i = 0; i < n; i++) inside[i] = grow ? alpha[i] >= 128 : alpha[i] < 128;
  if (!edt(inside, w, h, grow ? 0 : 1, dist)) { free(inside); free(dist); return 0; }
  float r = grow ? amount : -amount;
  for (int i = 0; i < n; i++) {
    float d = sqrtf(dist[i]);
    // Coverage of a pixel whose center is `d` from the nearest selected (unselected) center, edge at `r + 0.5`.
    float c = r + 0.5f - d + 0.5f; c = c < 0 ? 0 : c > 1 ? 1 : c;
    if (grow) { float a = alpha[i] / 255.f; a = a > c ? a : c; alpha[i] = (uint8_t)(a * 255 + 0.5f); }
    else { float a = alpha[i] / 255.f, keep = 1 - c; a = a < keep ? a : keep; alpha[i] = (uint8_t)(a * 255 + 0.5f); }
  }
  free(inside); free(dist);
  return 1;
}
