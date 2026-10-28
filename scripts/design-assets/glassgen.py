"""Generate tileable textures for uneven, hand-made glass.

thick.png   where the glass is thicker (tinted by CSS, so denser colour)
light.png   light bent by cords and bubbles (white, used as is)
caustic.png light focused by the glass onto the desk (tinted by CSS)
All are white with alpha and tile in both directions.
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)


def write_png(path, rgba):
    import struct
    import zlib
    h, w, _ = rgba.shape
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    path.write_bytes(png)


def mask_png(name, alpha):
    a = np.clip(alpha, 0, 1)
    rgba = np.zeros(a.shape + (4,), dtype=np.uint8)
    rgba[..., :3] = 255
    rgba[..., 3] = (a * 255).astype(np.uint8)
    write_png(OUT / name, rgba)


def smooth(t):
    return t * t * (3 - 2 * t)


def tile_noise(n, cell, rng):
    """Value noise on an n x n torus."""
    g = n // cell
    grid = rng.random((g, g))
    coords = np.arange(n) / cell
    i0 = coords.astype(int) % g
    i1 = (i0 + 1) % g
    t = smooth(coords - np.floor(coords))
    ty, tx = t[:, None], t[None, :]
    a, b = grid[i0][:, i0], grid[i0][:, i1]
    c, d = grid[i1][:, i0], grid[i1][:, i1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


def tile_fbm(n, rng, cells, gain=0.55):
    total, amp, norm = np.zeros((n, n)), 1.0, 0.0
    for cell in cells:
        total += amp * tile_noise(n, cell, rng)
        norm += amp
        amp *= gain
    return total / norm


def wrap_grad(f):
    gy = (np.roll(f, -1, 0) - np.roll(f, 1, 0)) / 2
    gx = (np.roll(f, -1, 1) - np.roll(f, 1, 1)) / 2
    return gx, gy


def bubbles(n, rng, count):
    """Small trapped air: a bright rim, a hot spot up-left, a clear centre."""
    out = np.zeros((n, n))
    yy, xx = np.mgrid[0:n, 0:n]
    for _ in range(count):
        cx, cy = rng.uniform(0, n, 2)
        r = rng.uniform(0.9, 3.4)
        dx = (xx - cx + n / 2) % n - n / 2
        dy = (yy - cy + n / 2) % n - n / 2
        d = np.hypot(dx, dy)
        rim = np.exp(-((d - r) / 0.55) ** 2) * 0.75
        spot = np.exp(-(np.hypot(dx + r * 0.35, dy + r * 0.35) / (0.35 + r * 0.18)) ** 2) * 0.9
        out = np.maximum(out, np.maximum(rim, spot))
    return out


rng = np.random.default_rng(23)
N = 320

# Thickness: slow swells plus horizontal cords, as in hand-drawn sheet glass.
swell = tile_fbm(N, rng, (160, 80, 40))
warp = tile_fbm(N, rng, (80, 40))
y = np.arange(N)[:, None] / N
cords = 0.5 + 0.5 * np.sin(y * 2 * np.pi * 6 + warp * 10)
lo, hi = np.percentile(swell, [20, 92])
thick = smooth(np.clip((swell - lo) / (hi - lo), 0, 1)) * 0.75 + cords ** 7 * 0.4
mask_png("glass-thick.png", 0.12 + 0.88 * np.clip(thick, 0, 1) * 0.9)

# Light: the slope of the thickness bends light; lit from the upper left.
gx, gy = wrap_grad(thick)
lit = -(gx * 0.55 + gy * 0.85)
lit = np.clip(lit / np.percentile(np.abs(lit), 99.3), 0, 1) ** 1.6
light = np.maximum(lit * 0.75, bubbles(N, rng, 22))
mask_png("glass-light.png", light)

# Caustics: light folded by the glass into a soft net on the desk.
M = 256
n1 = tile_fbm(M, rng, (64, 32, 16))
n2 = tile_fbm(M, rng, (128, 64, 32))
net = (1 - np.abs(np.sin(n1 * np.pi * 7))) ** 5 + (1 - np.abs(np.sin(n2 * np.pi * 5))) ** 5 * 0.6
mask_png("glass-caustic.png", np.clip(net * 0.95, 0, 1))
print(sorted(p.name for p in OUT.iterdir()))
