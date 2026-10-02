# Writes bayer.dng: a tiny uncompressed DNG (RGGB mosaic, 128×96, 12-bit) whose camera sees linear sRGB.
# Left half a red patch, right half 18% gray, so a develop can be checked for hue and neutrality.
import struct
W, H, WHITE = 128, 96, 4095
def scene(x, y):
    return (0.5, 0.05, 0.05) if x < W // 2 else (0.18, 0.18, 0.18)
pix = bytearray()
for y in range(H):
    for x in range(W):
        c = [[0, 1], [1, 2]][y & 1][x & 1]
        pix += struct.pack('<H', round(scene(x, y)[c] * WHITE))
xyz_to_srgb = [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.2040, 1.0570]
entries = []  # (tag, type, count, payload bytes)
def add(tag, typ, vals):
    fmt = {1: 'B', 3: 'H', 4: 'I', 5: 'II', 10: 'ii'}[typ]
    if typ in (5, 10):
        data = b''.join(struct.pack('<' + fmt, round(v * 10000), 10000) for v in vals)
    else:
        data = b''.join(struct.pack('<' + fmt, v) for v in vals)
    entries.append((tag, typ, len(vals), data))
n_tags = 20
ifd_size = 2 + n_tags * 12 + 4
pix_off = 8 + ifd_size
extra_off = pix_off + len(pix)
add(254, 4, [0]); add(256, 3, [W]); add(257, 3, [H]); add(258, 3, [16]); add(259, 3, [1]); add(262, 3, [32803])
add(273, 4, [pix_off]); add(274, 3, [1]); add(277, 3, [1]); add(278, 3, [H]); add(279, 4, [len(pix)]); add(284, 3, [1])
add(33421, 3, [2, 2]); add(33422, 1, [0, 1, 1, 2]); add(50706, 1, [1, 4, 0, 0]); add(50714, 3, [0]); add(50717, 3, [WHITE])
add(50721, 10, xyz_to_srgb); add(50728, 5, [1, 1, 1]); add(50778, 3, [21])
assert len(entries) == n_tags
ifd = struct.pack('<H', n_tags); extra = bytearray()
for tag, typ, count, data in entries:
    if len(data) <= 4:
        ifd += struct.pack('<HHI', tag, typ, count) + data.ljust(4, b'\0')
    else:
        ifd += struct.pack('<HHII', tag, typ, count, extra_off + len(extra)); extra += data
        if len(extra) % 2: extra += b'\0'
ifd += struct.pack('<I', 0)
out = b'II*\0' + struct.pack('<I', 8) + ifd + pix + extra
open(__file__.replace('make-dng.py', 'bayer.dng'), 'wb').write(out)
print(len(out))
