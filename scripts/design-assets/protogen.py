"""Sand masks for the main-interface prototype (white on alpha).

blob-0..5.png   irregular sand marks: an entity's 印记 (seeded per entity)
frame.png       dry-brush frame for a list cell, loaded where it starts
                (right edge, middle) and drier as it goes around
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

def frame(w=520, h=76, inset=5, thick=3.2, seed=7):
    rng = np.random.default_rng(seed)
    alpha = np.zeros((h, w))
    x0, y0, x1, y1 = inset, inset, w - inset, h - inset
    # Path: start at right-middle, go down, along the bottom to the left, up the
    # left side, along the top, and back down to the start.
    segs = [((x1, h / 2), (x1, y1)), ((x1, y1), (x0, y1)), ((x0, y1), (x0, y0)),
            ((x0, y0), (x1, y0)), ((x1, y0), (x1, h / 2))]
    lengths = [np.hypot(b[0] - a[0], b[1] - a[1]) for a, b in segs]
    total = sum(lengths)
    steps = int(total * 2)
    wob = periodic_noise(steps, 40, rng) - 0.5
    wid = periodic_noise(steps, 23, rng)
    yy, xx = np.mgrid[0:h, 0:w].astype(float)
    acc = 0.0; k = 0
    for (a, b), L in zip(segs, lengths):
        n = int(L * 2)
        for j in range(n):
            t = j / max(1, n)
            px = a[0] + (b[0] - a[0]) * t; py = a[1] + (b[1] - a[1]) * t
            s = (acc + L * t) / total           # 0 at the start, 1 at the end
            load = 1.0 - 0.55 * s               # the brush dries as it goes
            nx, ny = -(b[1] - a[1]) / L, (b[0] - a[0]) / L
            off = wob[k % steps] * 2.0
            px += nx * off; py += ny * off
            r = thick * (0.6 + 0.6 * wid[k % steps]) * (0.75 + 0.35 * load)
            x_lo, x_hi = int(max(0, px - r - 2)), int(min(w, px + r + 3))
            y_lo, y_hi = int(max(0, py - r - 2)), int(min(h, py + r + 3))
            sub = np.hypot(xx[y_lo:y_hi, x_lo:x_hi] - px, yy[y_lo:y_hi, x_lo:x_hi] - py)
            dab = np.clip((r - sub) / 1.2, 0, 1) * load
            alpha[y_lo:y_hi, x_lo:x_hi] = np.maximum(alpha[y_lo:y_hi, x_lo:x_hi], dab)
            k += 1
        acc += L
    grain = rng.random((h, w))
    dither = (grain < alpha * 1.1).astype(float) * (0.6 + 0.4 * rng.random((h, w)))
    out = alpha * 0.4 + dither * 0.6
    loose = (rng.random((h, w)) < 0.006) & (alpha < 0.05)
    near = np.zeros_like(alpha, bool)
    near[inset - 4:inset + 6, :] = True; near[h - inset - 6:h - inset + 4, :] = True
    near[:, inset - 4:inset + 6] = True; near[:, w - inset - 6:w - inset + 4] = True
    out = np.where(loose & near, 0.5, out)
    return out

write_png(OUT / "frame.png", frame())
print(sorted(p.name for p in OUT.iterdir()))
