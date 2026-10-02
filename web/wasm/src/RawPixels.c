// Web-only: develops a camera RAW's Bayer mosaic (DNG CFA data) into display RGBA, standing in for Core Image's
// CIRAWFilter behind the Mac app's RawDevelopSheet. Steps: black/white levels, white balance (clipped so blown
// highlights stay neutral), demosaic (Malvar-He-Cutler 5x5, or 2x2 superpixels for the quick preview), the camera to
// linear sRGB matrix, exposure, a tone curve whose strength is Boost, and sRGB encoding.
#include <stdint.h>
#include <stdlib.h>
#include <math.h>

static inline int clampi(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }
static inline float srgb_encode(float v) {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    return v <= 0.0031308f ? v * 12.92f : 1.055f * powf(v, 1.f / 2.4f) - 0.055f;
}

typedef struct { const float *plane; int w, h; } Plane;
static inline float at(const Plane *p, int x, int y) {
    // Mirrored by two, so the neighbor keeps the same CFA color.
    if (x < 0) x = -x; else if (x >= p->w) x = 2 * (p->w - 1) - x;
    if (y < 0) y = -y; else if (y >= p->h) y = 2 * (p->h - 1) - y;
    x = clampi(x, 0, p->w - 1); y = clampi(y, 0, p->h - 1);
    return p->plane[(size_t)y * p->w + x];
}

#define TONE_SIZE 16384
/// Linear light to the 8-bit output: sRGB encoding, then Boost — 0 is flat (the encoded scene values), 1 adds the
/// S-shaped contrast of a camera rendering. Made once per develop, so the pixels only look it up.
static uint8_t tone[TONE_SIZE + 1];
static void make_tone(float boost) {
    for (int i = 0; i <= TONE_SIZE; i++) {
        float y = srgb_encode((float)i / TONE_SIZE);
        float s = y * y * (3.f - 2.f * y);
        y = y + boost * 0.55f * (s - y);
        tone[i] = (uint8_t)clampi((int)lrintf(y * 255.f), 0, 255);
    }
}
/// The final per-pixel color: matrix, exposure, then the tone table.
static inline void finish(const float *rgbIn, const float *m, float gain, uint8_t *o) {
    for (int c = 0; c < 3; c++) {
        float v = (m[c * 3] * rgbIn[0] + m[c * 3 + 1] * rgbIn[1] + m[c * 3 + 2] * rgbIn[2]) * gain;
        int i = v <= 0 ? 0 : v >= 1 ? TONE_SIZE : (int)(v * TONE_SIZE + 0.5f);
        o[c] = tone[i];
    }
    o[3] = 255;
}

/// src: w×h sensor values. cfa: the 2×2 pattern (0 red, 1 green, 2 blue) as [y0x0, y0x1, y1x0, y1x1].
/// wb: per-channel white-balance multipliers (the smallest 1). m: white-balanced camera RGB to linear sRGB, row-major.
/// half: n > 0 makes a superpixel image for previews from every nth 2×2 block, (w/2/n)×(h/2/n); 0 demosaics at full
/// size. out: RGBA8.
void raw_develop(const uint16_t *src, int w, int h, const uint8_t *cfa, float black, float white, const float *wb,
                 const float *m, float gain, float boost, int half, uint8_t *out) {
    const float scale = 1.f / fmaxf(1.f, white - black);
    make_tone(boost);
    if (half) {
        int n = half, ow = w / 2 / n, oh = h / 2 / n;
        for (int yy = 0; yy < oh; yy++) for (int xx = 0; xx < ow; xx++) {
            int y = yy * n, x = xx * n;
            float acc[3] = {0, 0, 0}; int n[3] = {0, 0, 0};
            for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++) {
                int c = cfa[dy * 2 + dx];
                float v = ((float)src[(size_t)(y * 2 + dy) * w + x * 2 + dx] - black) * scale;
                acc[c] += v < 0 ? 0 : v; n[c]++;
            }
            float rgb[3];
            for (int c = 0; c < 3; c++) { float v = n[c] ? acc[c] / n[c] : 0; v *= wb[c]; rgb[c] = v > 1 ? 1 : v; }
            finish(rgb, m, gain, out + ((size_t)yy * ow + xx) * 4);
        }
        return;
    }
    float *plane = (float *)malloc((size_t)w * h * sizeof(float));
    if (!plane) return;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
        int c = cfa[(y & 1) * 2 + (x & 1)];
        float v = ((float)src[(size_t)y * w + x] - black) * scale;
        v = (v < 0 ? 0 : v) * wb[c];
        plane[(size_t)y * w + x] = v > 1 ? 1 : v;
    }
    Plane P = { plane, w, h };
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
        int c = cfa[(y & 1) * 2 + (x & 1)];
        float C = at(&P, x, y), rgb[3];
        rgb[c] = C;
        float axial = at(&P, x - 2, y) + at(&P, x + 2, y) + at(&P, x, y - 2) + at(&P, x, y + 2);
        if (c == 1) {
            // Green site: the other two from the row and the column, which hold one each.
            int rowColor = cfa[(y & 1) * 2 + ((x + 1) & 1)], colColor = cfa[((y + 1) & 1) * 2 + (x & 1)];
            float diag = at(&P, x - 1, y - 1) + at(&P, x + 1, y - 1) + at(&P, x - 1, y + 1) + at(&P, x + 1, y + 1);
            float horiz = 5 * C + 4 * (at(&P, x - 1, y) + at(&P, x + 1, y)) - (at(&P, x - 2, y) + at(&P, x + 2, y)) - diag
                        + 0.5f * (at(&P, x, y - 2) + at(&P, x, y + 2));
            float vert = 5 * C + 4 * (at(&P, x, y - 1) + at(&P, x, y + 1)) - (at(&P, x, y - 2) + at(&P, x, y + 2)) - diag
                       + 0.5f * (at(&P, x - 2, y) + at(&P, x + 2, y));
            rgb[rowColor] = horiz / 8; rgb[colColor] = vert / 8;
        } else {
            // Red or blue site: green from the cross, the opposite color from the diagonals.
            float cross = at(&P, x - 1, y) + at(&P, x + 1, y) + at(&P, x, y - 1) + at(&P, x, y + 1);
            float diag = at(&P, x - 1, y - 1) + at(&P, x + 1, y - 1) + at(&P, x - 1, y + 1) + at(&P, x + 1, y + 1);
            rgb[1] = (4 * C + 2 * cross - axial) / 8;
            rgb[2 - c] = (6 * C + 2 * diag - 1.5f * axial) / 8;
        }
        for (int k = 0; k < 3; k++) rgb[k] = rgb[k] < 0 ? 0 : rgb[k] > 1 ? 1 : rgb[k];
        finish(rgb, m, gain, out + ((size_t)y * w + x) * 4);
    }
    free(plane);
}
