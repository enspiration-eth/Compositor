// Free Distort's resampling (Document/Distort.swift): the Mac app warps a layer into its four dragged corners with
// Core Image's CIPerspectiveTransform when the shape is convex, and as two affine triangles when a corner is pulled
// past its neighbours. This does the same arithmetic by inverse mapping with bilinear sampling, premultiplied RGBA8.
// `c` holds the image's own corners (top-left, top-right, bottom-right, bottom-left) as x,y pairs in output pixels.
#include <math.h>
#include <stdint.h>
#include <stddef.h>

static inline void sample(const uint8_t *src, int sw, int sh, double x, double y, uint8_t *out) {
  // Pixel centers at +0.5; outside the image counts as transparent, which softens the warped edge by a pixel.
  x -= 0.5; y -= 0.5;
  int x0 = (int)floor(x), y0 = (int)floor(y);
  double fx = x - x0, fy = y - y0, acc[4] = {0, 0, 0, 0};
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    int xx = x0 + i, yy = y0 + j;
    if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
    double w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
    const uint8_t *p = src + ((size_t)yy * sw + xx) * 4;
    for (int k = 0; k < 4; k++) acc[k] += p[k] * w;
  }
  for (int k = 0; k < 4; k++) { double v = acc[k] + 0.5; out[k] = (uint8_t)(v < 0 ? 0 : v > 255 ? 255 : v); }
}

/// DistortWarp.homography's matrix (unit square → corners), returned row-major in m[9].
static void homography(const double *c, double *m) {
  double sx = c[0] - c[2] + c[4] - c[6], sy = c[1] - c[3] + c[5] - c[7], g = 0, h = 0;
  if (fabs(sx) > 1e-9 || fabs(sy) > 1e-9) {
    double dx1 = c[2] - c[4], dx2 = c[6] - c[4], dy1 = c[3] - c[5], dy2 = c[7] - c[5], den = dx1 * dy2 - dx2 * dy1;
    if (fabs(den) > 1e-12) { g = (sx * dy2 - dx2 * sy) / den; h = (dx1 * sy - sx * dy1) / den; }
  }
  m[0] = c[2] - c[0] + g * c[2]; m[1] = c[6] - c[0] + h * c[6]; m[2] = c[0];
  m[3] = c[3] - c[1] + g * c[3]; m[4] = c[7] - c[1] + h * c[7]; m[5] = c[1];
  m[6] = g; m[7] = h; m[8] = 1;
}
static int invert3(const double *m, double *r) {
  double a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
  double A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  if (fabs(det) < 1e-15) return 0;
  r[0] = A / det; r[1] = -(b * i - c * h) / det; r[2] = (b * f - c * e) / det;
  r[3] = B / det; r[4] = (a * i - c * g) / det; r[5] = -(a * f - c * d) / det;
  r[6] = C / det; r[7] = -(a * h - b * g) / det; r[8] = (a * e - b * d) / det;
  return 1;
}

static int convex(const double *c) {
  double sign = 0;
  for (int i = 0; i < 4; i++) {
    const double *a = c + 2 * i, *b = c + 2 * ((i + 1) % 4), *d = c + 2 * ((i + 2) % 4);
    double cross = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (fabs(cross) <= 0.01) return 0;
    if (sign == 0) sign = cross < 0 ? -1 : 1; else if ((cross < 0) != (sign < 0)) return 0;
  }
  return 1;
}

/// Barycentric inverse of one triangle: maps output (x, y) to source pixels; returns 0 when outside the triangle.
static int tri(const double *P, const double *S, double x, double y, double *sx, double *sy) {
  double d = (P[3] - P[5]) * (P[0] - P[4]) + (P[4] - P[2]) * (P[1] - P[5]);
  if (fabs(d) < 1e-12) return 0;
  double l1 = ((P[3] - P[5]) * (x - P[4]) + (P[4] - P[2]) * (y - P[5])) / d;
  double l2 = ((P[5] - P[1]) * (x - P[4]) + (P[0] - P[4]) * (y - P[5])) / d;
  double l3 = 1 - l1 - l2, eps = -1e-6;
  if (l1 < eps || l2 < eps || l3 < eps) return 0;
  *sx = l1 * S[0] + l2 * S[2] + l3 * S[4]; *sy = l1 * S[1] + l2 * S[3] + l3 * S[5];
  return 1;
}

/// Returns 1 when warped in perspective, 2 when as two triangles (a folded shape), 0 when the corners are unusable.
int distort_warp(const uint8_t *src, int sw, int sh, uint8_t *dst, int dw, int dh, const double *c) {
  for (size_t i = 0; i < (size_t)dw * dh * 4; i++) dst[i] = 0;
  if (convex(c)) {
    double m[9], inv[9];
    homography(c, m);
    if (!invert3(m, inv)) return 0;
    for (int y = 0; y < dh; y++) for (int x = 0; x < dw; x++) {
      double px = x + 0.5, py = y + 0.5, w = inv[6] * px + inv[7] * py + inv[8];
      if (fabs(w) < 1e-12) continue;
      double u = (inv[0] * px + inv[1] * py + inv[2]) / w, v = (inv[3] * px + inv[4] * py + inv[5]) / w;
      double ex = 1.0 / sw, ey = 1.0 / sh; // keep the half-pixel soft rim just outside the shape
      if (u < -ex || v < -ey || u > 1 + ex || v > 1 + ey) continue;
      sample(src, sw, sh, u * sw, v * sh, dst + ((size_t)y * dw + x) * 4);
    }
    return 1;
  }
  // Two triangles meeting along the top-left → bottom-right diagonal, each with its own affine map.
  double S1[6] = {0, 0, sw, 0, sw, sh}, P1[6] = {c[0], c[1], c[2], c[3], c[4], c[5]};
  double S2[6] = {0, 0, sw, sh, 0, sh}, P2[6] = {c[0], c[1], c[4], c[5], c[6], c[7]};
  for (int y = 0; y < dh; y++) for (int x = 0; x < dw; x++) {
    double sx, sy, px = x + 0.5, py = y + 0.5;
    if (tri(P1, S1, px, py, &sx, &sy) || tri(P2, S2, px, py, &sx, &sy)) sample(src, sw, sh, sx, sy, dst + ((size_t)y * dw + x) * 4);
  }
  return 2;
}
