"""Sand masks for the main-interface prototype (white on alpha).

blob-0..5.png   irregular sand marks: an entity's 印记 (seeded per entity)

The frame round a selected cell is drawn at run time for the cell's own size
(src/renderer/lib/sand-frame.ts).
"""
import struct, sys, zlib
from pathlib import Path
import numpy as np

OUT = Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)

def write_png(path, alpha):
    a = (np.clip(alpha, 0, 1) * 255).astype(np.uint8)
    h, w = a.shape
    rgba = np.zeros((h, w, 4), np.uint8); rgba[..., :3] = 255; rgba[..., 3] = a
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

def smooth(t): return t * t * (3 - 2 * t)

def periodic_noise(n, k, rng):
    """1-D periodic value noise with k knots, sampled at n points."""
    knots = rng.random(k)
    x = np.arange(n) / n * k
    i0 = x.astype(int) % k; i1 = (i0 + 1) % k
    t = smooth(x - np.floor(x))
    return knots[i0] * (1 - t) + knots[i1] * t

def blob(seed, size=96):
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:size, 0:size].astype(float)
    cx = size / 2 + rng.uniform(-3, 3); cy = size / 2 + rng.uniform(-3, 3)
    ang = (np.arctan2(yy - cy, xx - cx) + np.pi) / (2 * np.pi)
    n = 720
    rad = 0.30 + 0.07 * (periodic_noise(n, 5, rng) - 0.5) * 2 + 0.035 * (periodic_noise(n, 13, rng) - 0.5) * 2
    stretch = rng.uniform(0.82, 1.0)
    r = rad[(ang * n).astype(int) % n] * size
    d = np.hypot((xx - cx), (yy - cy) / stretch) / r
    body = np.clip((1.0 - d) * 4.5, 0, 1)
    grain = rng.random((size, size))
    dither = (grain < body * 1.05).astype(float) * (0.65 + 0.35 * rng.random((size, size)))
    alpha = body * 0.5 + dither * 0.5
    loose = (rng.random((size, size)) < 0.02) & (d > 0.95) & (d < 1.35)
    alpha = np.where(loose, np.maximum(alpha, 0.5 * rng.random((size, size)) + 0.25), alpha)
    return alpha

for i in range(6):
    write_png(OUT / f"blob-{i}.png", blob(100 + i))

print(sorted(p.name for p in OUT.iterdir()))
