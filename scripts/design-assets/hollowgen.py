"""Hollow kind marks (white on alpha): the mark a preview tab shows in the dock.

Reads the solid marks already in src/assets/design/sand/ and writes, next to
each, a `-hollow` variant that keeps only the sand along the shape's edge:
  filled seals (blob-0..5, square, star)  edge = mark minus the mark eroded
  thin strokes (dash, slip, spiral, corner)  edge = mark dilated minus the mark
so the rim keeps the stroke's own dry, uneven grain. Usage:
  python3 hollowgen.py <sand-dir>
"""
import struct, sys, zlib
from pathlib import Path
import numpy as np

SAND = Path(sys.argv[1])

def read_png(path):
    data = path.read_bytes()
    w, h = struct.unpack(">II", data[16:24])
    i, idat = 8, b""
    while i < len(data):
        length = struct.unpack(">I", data[i:i + 4])[0]
        if data[i + 4:i + 8] == b"IDAT":
            idat += data[i + 8:i + 8 + length]
        i += 12 + length
    raw = zlib.decompress(idat)
    stride = w * 4 + 1
    rows = [np.frombuffer(raw[y * stride + 1:(y + 1) * stride], np.uint8) for y in range(h)]
    return np.stack(rows).reshape(h, w, 4)[..., 3].astype(np.float64) / 255

def write_png(path, alpha):
    a = (np.clip(alpha, 0, 1) * 255).astype(np.uint8)
    h, w = a.shape
    rgba = np.zeros((h, w, 4), np.uint8); rgba[..., :3] = 255; rgba[..., 3] = a
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

def disk_filter(a, r, op):
    """Grey-level erosion (np.minimum) or dilation (np.maximum) over a disk."""
    h, w = a.shape
    pad = np.pad(a, r)
    out = a.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy > r * r:
                continue
            out = op(out, pad[r + dy:r + dy + h, r + dx:r + dx + w])
    return out

FILLED = {f"blob-{i}": 0.2 for i in range(6)} | {"mark-square": 0.2, "mark-star": 0.16}
STROKES = {"mark-dash": 0.09, "mark-slip": 0.09, "mark-spiral": 0.05, "mark-corner": 0.07}

for name, share in FILLED.items():
    a = read_png(SAND / f"{name}.png")
    r = max(1, round(share * min(a.shape)))
    write_png(SAND / f"{name}-hollow.png", a - disk_filter(a, r, np.minimum))
for name, share in STROKES.items():
    a = read_png(SAND / f"{name}.png")
    r = max(1, round(share * max(a.shape)))
    write_png(SAND / f"{name}-hollow.png", disk_filter(a, r, np.maximum) - a)
