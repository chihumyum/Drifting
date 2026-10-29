"""Generate grainy brush / sand textures for the Drifting material specimen.

Masks are white with alpha, tinted by CSS; covers are full colour.
"""
import struct
import sys
import zlib
from pathlib import Path

import numpy as np

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)


def write_png(path, rgba):
    h, w, _ = rgba.shape
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    path.write_bytes(png)


def smooth(t):
    return t * t * (3 - 2 * t)


def value_noise(h, w, cell, rng):
    gh, gw = h // cell + 3, w // cell + 3
    grid = rng.random((gh, gw))
    ys = np.arange(h) / cell
    xs = np.arange(w) / cell
    y0 = ys.astype(int)
    x0 = xs.astype(int)
    ty = smooth(ys - y0)[:, None]
    tx = smooth(xs - x0)[None, :]
    a = grid[y0][:, x0]
    b = grid[y0][:, x0 + 1]
    c = grid[y0 + 1][:, x0]
    d = grid[y0 + 1][:, x0 + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


def fbm(h, w, rng, cells=(64, 32, 16, 8), gain=0.5):
    total = np.zeros((h, w))
    amp = 1.0
    norm = 0.0
    for cell in cells:
        total += amp * value_noise(h, w, max(cell, 1), rng)
        norm += amp
        amp *= gain
    return total / norm


def noise1d(n, cell, rng):
    return value_noise(1, n, cell, rng)[0]


def periodic_noise(h, w, cell, rng):
    """Value noise that tiles horizontally: crossfade a 2w field onto itself."""
    n = value_noise(h, 2 * w, cell, rng)
    t = (np.arange(w) / w)[None, :]
    return n[:, w:] * (1 - t) + n[:, :w] * t


def mask_png(name, alpha):
    a = np.clip(alpha, 0, 1)
    rgba = np.zeros(a.shape + (4,), dtype=np.uint8)
    rgba[..., :3] = 255
    rgba[..., 3] = (a * 255).astype(np.uint8)
    write_png(OUT / name, rgba)


def aniso_noise(h, w, cell_y, cell_x, rng):
    """Value noise stretched along x: dry-brush skips run with the stroke."""
    gh, gw = h // cell_y + 3, w // cell_x + 3
    grid = rng.random((gh, gw))
    ys = np.arange(h) / cell_y
    xs = np.arange(w) / cell_x
    y0 = ys.astype(int)
    x0 = xs.astype(int)
    ty = smooth(ys - y0)[:, None]
    tx = smooth(xs - x0)[None, :]
    a = grid[y0][:, x0]
    b = grid[y0][:, x0 + 1]
    c = grid[y0 + 1][:, x0]
    d = grid[y0 + 1][:, x0 + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


def brush_stroke(w, h, rng, top, bottom, load_start=1.0, load_end=0.35, taper=(0.04, 0.10),
                 streak_cell=3, dry=0.55, keep=1.0, body=1.0):
    """A horizontal dry-brush stroke: ragged edges, fine bristle streaks, paper skips, grain.

    `keep` is the share of the dithered grains kept and `body` scales the
    continuous wash under them; with the same seed a thinner stroke keeps a
    subset of the full one's grains along the same path."""
    x = np.arange(w)[None, :] / w
    y = np.arange(h)[:, None]
    span = bottom - top
    # Ragged edges: slow wobble plus fine jitter.
    edge_t = (noise1d(w, 80, rng) - 0.5) * span * 0.30 + (noise1d(w, 6, rng) - 0.5) * span * 0.14
    edge_b = (noise1d(w, 70, rng) - 0.5) * span * 0.30 + (noise1d(w, 5, rng) - 0.5) * span * 0.14
    land = smooth(np.clip(x / taper[0], 0, 1))
    lift = smooth(np.clip((1 - x) / taper[1], 0, 1))
    half = span / 2 * (0.45 + 0.55 * land * lift)
    centre = (top + bottom) / 2 + ((edge_t + edge_b) / 2)[None, :]
    reach = half + ((edge_b - edge_t) / 2)[None, :]
    dist = np.abs(y - centre) / np.maximum(reach, 1)
    shape = np.clip((1.0 - dist) * 6, 0, 1)
    # Bristles: many fine streaks, each with its own load that drifts along x.
    streaks = aniso_noise(h, w, max(streak_cell - 1, 1), 60, rng)
    bristles = 0.45 + 0.55 * np.clip((streaks - 0.25) * 1.6, 0, 1)
    # Pigment runs out along the stroke and near the edges.
    load = (load_start + (load_end - load_start) * x) * (1 - 0.35 * dist ** 2)
    paper = aniso_noise(h, w, 2, 14, rng) * 0.6 + aniso_noise(h, w, 1, 5, rng) * 0.4
    covered = np.clip((load * (0.9 + 0.5 * dry) - paper * (0.55 + dry * 0.5)) * 5 + 0.5, 0, 1)
    density = shape * bristles * covered
    # Grain: part dithered, part continuous, so the colour reads as powder.
    grain = rng.random((h, w))
    dither = (grain < density * 1.15 * keep).astype(float) * (0.7 + 0.3 * rng.random((h, w)))
    alpha = density * 0.45 * body + dither * 0.55
    loose = (rng.random((h, w)) < 0.012 * keep) & (dist > 0.9) & (dist < 1.5)
    alpha = np.where(loose, np.maximum(alpha, 0.45 * rng.random((h, w)) + 0.2), alpha)
    return np.clip(alpha, 0, 1)


def sand_band(w, h, rng, intensity, phase):
    """A flowing band of sand across 12 chapters; intensity sets thickness per chapter."""
    xs = np.linspace(0, 1, w)
    keys = np.linspace(0, 1, len(intensity))
    level = np.interp(xs, keys, intensity)
    level = np.convolve(level, np.ones(41) / 41, mode="same")
    flow = (np.sin(xs * 2 * np.pi * 1.3 + phase) * 0.22 + (noise1d(w, 120, rng) - 0.5) * 0.4)
    centre = h / 2 + flow * h * 0.30
    thick = (h * 0.42) * (0.15 + 0.85 * level) + (noise1d(w, 25, rng) - 0.5) * 4
    y = np.arange(h)[:, None]
    dist = np.abs(y - centre[None, :]) / np.maximum(thick[None, :] / 2, 0.5)
    # Density falls off toward the edge; grains dither the falloff.
    density = np.clip(1.25 - dist, 0, 1) ** 1.3 * (0.35 + 0.65 * level[None, :])
    layers = 0.75 + 0.25 * np.sin((y - centre[None, :]) * 0.9 + value_noise(h, w, 30, rng) * 6)
    grains = rng.random((h, w))
    alpha = np.where(grains < density * layers, 0.62 + 0.38 * rng.random((h, w)), 0.0)
    alpha += density * 0.35
    stray = (rng.random((h, w)) < 0.012 * (0.3 + level[None, :])) & (dist < 2.2)
    alpha = np.where(stray, np.maximum(alpha, 0.5), alpha)
    return np.clip(alpha, 0, 1)


def hex_rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=float) / 255


def cover(w, h, rng, ground, colours, dark=False):
    """Flow-field strokes of sand in a book's storyline colours."""
    img = np.ones((h, w, 3)) * hex_rgb(ground)
    field = fbm(h, w, rng, cells=(120, 60, 30)) * np.pi * 3.2
    yy, xx = np.mgrid[0:h, 0:w]
    for idx, colour in enumerate(colours):
        pigment = hex_rgb(colour)
        acc = np.zeros((h, w))
        count = 70 if idx == 0 else 44
        for _ in range(count):
            x = rng.uniform(-0.1, 1.0) * w
            y = (rng.uniform(0.18, 0.92) if idx == 0 else rng.uniform(0.05, 0.95)) * h
            radius = rng.uniform(2.0, 5.0)
            for step in range(150):
                if not (0 <= x < w and 0 <= y < h):
                    break
                angle = field[int(y), int(x)] * 0.35 + 0.1
                x += np.cos(angle) * 2.2
                y += np.sin(angle) * 1.2
                for _ in range(5):
                    gx = int(x + rng.normal(0, radius))
                    gy = int(y + rng.normal(0, radius * 0.8))
                    if 0 <= gx < w and 0 <= gy < h:
                        acc[gy, gx] += rng.uniform(0.25, 0.7)
        acc = np.clip(acc * (1.0 if dark else 1.4), 0, 1)[..., None]
        if dark:
            img = img * (1 - acc * 0.92) + pigment * acc * 0.92
        else:
            # Pigment over paper: multiply-like, so overlaps deepen.
            img = img * (1 - acc * 0.94) + (img * pigment) * acc * 0.94
    paper = fbm(h, w, rng, cells=(4, 2)) - 0.5
    img = np.clip(img + paper[..., None] * (0.05 if not dark else 0.035), 0, 1)
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., :3] = (img * 255).astype(np.uint8)
    rgba[..., 3] = 255
    return rgba


def dunes(w, h, rng, base, amp, phase, density_scale):
    """Soft dunes of sand for the empty state; tiles horizontally so it can drift."""
    xs = np.arange(w) / w
    ridge = (base + np.sin(xs * 2 * np.pi + phase) * amp
             + np.sin(xs * 4 * np.pi + phase * 1.7) * amp * 0.35
             + (periodic_noise(1, w, 160, rng)[0] - 0.5) * amp * 0.8)
    y = np.arange(h)[:, None]
    below = (y - ridge[None, :] * h) / h
    density = np.clip(below * 3.0 + 0.15, 0, 1) * density_scale
    density *= 0.75 + 0.25 * np.sin(y * 0.55 + periodic_noise(h, w, 50, rng) * 8)
    grains = rng.random((h, w))
    alpha = np.where(grains < density, 0.55 + 0.45 * rng.random((h, w)), 0.0)
    edge = np.abs(below) < 0.02
    alpha = np.where(edge & (rng.random((h, w)) < 0.35), np.maximum(alpha, 0.7), alpha)
    return np.clip(alpha, 0, 1)


rng = np.random.default_rng(11)
mask_png("hl.png", brush_stroke(720, 64, rng, top=10, bottom=56, load_end=0.5, taper=(0.03, 0.14), dry=0.7))
# The swash a comment anchor shows while its card is pointed at: the same
# stroke (its own generator from the same seed), two grains in three kept and
# a thinner wash, so the words read through it.
mask_png("hl-hot.png", brush_stroke(720, 64, np.random.default_rng(11), top=10, bottom=56, load_end=0.5,
                                    taper=(0.03, 0.14), dry=0.7, keep=0.65, body=0.75))
mask_png("ul.png", brush_stroke(720, 26, rng, top=4, bottom=22, load_start=1.0, load_end=0.3,
                                taper=(0.05, 0.25), streak_cell=2, dry=0.75))
intensities = {
    "band-main.png": [0.7, 0.85, 0.8, 0.9, 0.95, 0.9, 1.0, 0.95, 0.6, 0.85, 1.0, 1.0],
    "band-love.png": [0.0, 0.05, 0.55, 0.9, 0.7, 0.15, 0.05, 0.6, 1.0, 0.85, 0.2, 0.05],
    "band-tide.png": [0.05, 0.6, 0.55, 0.1, 0.05, 0.5, 0.7, 0.15, 0.05, 0.2, 0.75, 0.8],
}
for i, (name, levels) in enumerate(intensities.items()):
    mask_png(name, sand_band(1200, 60, rng, levels, phase=i * 1.7))
books = {
    "cover-fog": ["#46639F", "#7FA996", "#CDB36A"],
    "cover-tide": ["#A85443", "#C98A58", "#A29D95"],
    "cover-shore": ["#71638F", "#CDB36A", "#7FA996"],
}
for name, colours in books.items():
    write_png(OUT / f"{name}.png", cover(240, 320, rng, "#F3EEE6", colours))
    write_png(OUT / f"{name}-dark.png", cover(240, 320, rng, "#22201E", colours, dark=True))
mask_png("dune-back.png", dunes(640, 220, rng, base=0.45, amp=0.08, phase=0.4, density_scale=0.55))
mask_png("dune-front.png", dunes(640, 220, rng, base=0.62, amp=0.10, phase=2.3, density_scale=0.85))
print(sorted(p.name for p in OUT.iterdir()))
