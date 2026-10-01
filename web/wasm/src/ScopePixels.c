// Camera Raw's vectorscope (CameraRawScope.make in CameraRaw.swift), translated to C for the web port.
// `rgba` is premultiplied RGBA8, `scope` is side×side doubles (zeroed by the caller), row y = 0 at the top of
// the data. Fully transparent and neutral pixels are skipped; each pixel adds its alpha.
#include <math.h>
#include <stddef.h>
#include <stdint.h>

void camera_raw_vectorscope(const uint8_t *rgba, size_t count, int side, double *scope) {
    for (size_t i = 0; i < count; ++i) {
        const uint8_t *p = rgba + i * 4;
        double alpha = p[3];
        if (alpha == 0) continue;
        double r = fmin(1, p[0] / alpha), g = fmin(1, p[1] / alpha), b = fmin(1, p[2] / alpha);
        double mx = fmax(r, fmax(g, b)), mn = fmin(r, fmin(g, b)), chroma = mx - mn;
        if (chroma <= 1e-4 || mx <= 1e-4) continue;
        double hue;
        if (mx == r) hue = (g - b) / chroma;
        else if (mx == g) hue = 2 + (b - r) / chroma;
        else hue = 4 + (r - g) / chroma;
        hue /= 6;
        if (hue < 0) hue += 1;
        double angle = hue * 2 * M_PI, saturation = chroma / mx;
        double px = 0.5 + cos(angle) * saturation * 0.48, py = 0.5 + sin(angle) * saturation * 0.48;
        int col = (int)(px * side), row = (int)(py * side);
        if (col < 0) col = 0; if (col > side - 1) col = side - 1;
        if (row < 0) row = 0; if (row > side - 1) row = side - 1;
        scope[row * side + col] += alpha / 255;
    }
}
