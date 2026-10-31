"""The resting glass line of a menu, as a tinted texture.

A glass rim elsewhere is a box-shadow ring cut by the glass texture through
`mask-image` on a pseudo-element. A menu scrolls, and a pseudo-element inside
a scroll container scrolls away with the rows, so the menu draws its rim as
a background instead (backgrounds stay put while the rows scroll). A
background cannot be masked or tinted by CSS, so this writes the texture
already tinted: the colour of clear glass, at the resting line's strength
(`--glass-edge` 33% × 1.8 × `.glass--rest`'s 0.85 = 50.5%), its alpha the
texture's own. Shown only in the menu's 1px border; see ui-controls.css.

Reads the committed `glass-thick.png` and writes, into the output directory
given:

- `glass-ring.png`: clear glass of the light themes (`--glass-clear` #b4b6ae);
- `glass-ring-dark.png`: clear glass of the dark themes (#6b6d67).

    python3 ringgen.py out/
"""
import struct
import sys
import zlib
from pathlib import Path

import numpy as np

DESIGN = Path(__file__).resolve().parents[2] / "src/assets/design"
OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
STRENGTH = 0.33 * 1.8 * 0.85


def read_alpha(path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, w, h = 8, b"", 0, 0
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            w, h, depth, colour = struct.unpack(">IIBB", body[:10])
            assert depth == 8 and colour == 6, "expects 8-bit RGBA"
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length
    raw = zlib.decompress(idat)
    stride = w * 4
    rows = np.zeros((h, stride), dtype=np.int32)
    prev = np.zeros(stride, dtype=np.int32)
    for y in range(h):
        line = raw[y * (stride + 1):(y + 1) * (stride + 1)]
        kind, cur = line[0], np.frombuffer(line[1:], dtype=np.uint8).astype(np.int32)
        out = np.zeros(stride, dtype=np.int32)
        for x in range(stride):
            left = out[x - 4] if x >= 4 else 0
            up = prev[x]
            corner = prev[x - 4] if x >= 4 else 0
            if kind == 0:
                pred = 0
            elif kind == 1:
                pred = left
            elif kind == 2:
                pred = up
            elif kind == 3:
                pred = (left + up) // 2
            else:
                p = left + up - corner
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - corner)
                pred = left if pa <= pb and pa <= pc else up if pb <= pc else corner
            out[x] = (cur[x] + pred) & 0xFF
        rows[y], prev = out, out
    return rows.reshape(h, w, 4)[..., 3].astype(np.float64) / 255


def write_png(path, rgba):
    h, w, _ = rgba.shape
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    path.write_bytes(png)


def tinted(alpha, hex_colour):
    h, w = alpha.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., 0] = int(hex_colour[1:3], 16)
    rgba[..., 1] = int(hex_colour[3:5], 16)
    rgba[..., 2] = int(hex_colour[5:7], 16)
    rgba[..., 3] = np.round(np.clip(alpha * STRENGTH, 0, 1) * 255).astype(np.uint8)
    return rgba


texture = read_alpha(DESIGN / "glass-thick.png")
write_png(OUT / "glass-ring.png", tinted(texture, "#b4b6ae"))
write_png(OUT / "glass-ring-dark.png", tinted(texture, "#6b6d67"))
print("glass-ring.png glass-ring-dark.png")
