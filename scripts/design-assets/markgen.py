"""Tint the dry highlight swash for highlighted text in notes.

A highlight (`<mark>`) can run over several lines, and only a background is
drawn once per line fragment (`box-decoration-break: clone`); a background
image cannot be tinted by CSS, so the swash is coloured here instead of in a
mask. Reads the committed `sand/hl.png` and writes `hl-mark.png` (light
theme) and `hl-mark-dark.png` beside the output directory given.

    python3 markgen.py out/
"""
import struct
import sys
import zlib
from pathlib import Path

import numpy as np

SOURCE = Path(__file__).resolve().parents[2] / "src/assets/design/sand/hl.png"
OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)

# The note highlight yellow (hsl(46 92% 56%)) and a deeper ochre that keeps
# light text readable on the dark page, each with the swash's strength.
TINTS = {
    "hl-mark.png": ((245, 196, 41), 0.62),
    "hl-mark-dark.png": ((171, 133, 35), 0.5),
}


def read_rgba(path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, w = 8, b"", 0
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
    return rows.reshape(h, w, 4).astype(np.uint8)


def write_png(path, rgba):
    h, w, _ = rgba.shape
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    path.write_bytes(png)


alpha = read_rgba(SOURCE)[..., 3].astype(np.float64) / 255
for name, (rgb, strength) in TINTS.items():
    rgba = np.zeros(alpha.shape + (4,), dtype=np.uint8)
    rgba[..., :3] = rgb
    rgba[..., 3] = np.clip(alpha * strength * 255, 0, 255).astype(np.uint8)
    write_png(OUT / name, rgba)
