"""Storyline marks and the dock's spread wash (white on alpha).

mark-wave/knot/spiral/fork/stones/ridge.png  a storyline's small sand shape,
                                             drawn as one loaded dry stroke
spread.png                                   sand pushed outward under a pill:
                                             dense at the rim, thin in the middle
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

def noise1(n, k, rng):
    knots = rng.random(k + 1)
    x = np.linspace(0, k, n)
    i0 = np.minimum(x.astype(int), k - 1)
    t = smooth(x - i0)
    return knots[i0] * (1 - t) + knots[i0 + 1] * t

def resample(pts, step=0.6):
    """Evenly spaced points along a polyline (pixel units)."""
    pts = np.asarray(pts, float)
    seg = np.hypot(*np.diff(pts, axis=0).T)
    s = np.concatenate([[0], np.cumsum(seg)])
    n = max(2, int(s[-1] / step))
    u = np.linspace(0, s[-1], n)
    return np.stack([np.interp(u, s, pts[:, 0]), np.interp(u, s, pts[:, 1])], 1)

def catmull(points, per=24):
    p = np.asarray(points, float)
    p = np.vstack([p[0], p, p[-1]])
    out = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        for t in np.linspace(0, 1, per, endpoint=False):
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(p[-2])
    return np.array(out)

def brush(alpha, pts, thick, rng, load0=1.0, dry=0.5, taper=(0.08, 0.18)):
    """One dry stroke: heavy where it lands, drier and thinner as it goes."""
    h, w = alpha.shape
    pts = resample(pts)
    n = len(pts)
    wid = noise1(n, max(3, n // 40), rng)
    wob = noise1(n, max(3, n // 30), rng) - 0.5
    yy, xx = np.mgrid[0:h, 0:w].astype(float)
    tan = np.gradient(pts, axis=0); tan /= np.maximum(1e-6, np.hypot(*tan.T))[:, None]
    for k, (px, py) in enumerate(pts):
        s = k / (n - 1)
        load = load0 * (1.0 - dry * s)
        a_in = smooth(min(1.0, s / taper[0])) if taper[0] > 0 else 1.0
        a_out = smooth(min(1.0, (1 - s) / taper[1])) if taper[1] > 0 else 1.0
        r = thick * (0.65 + 0.5 * wid[k]) * (0.55 + 0.45 * min(a_in, a_out)) * (0.8 + 0.3 * load)
        px += -tan[k, 1] * wob[k] * 1.2; py += tan[k, 0] * wob[k] * 1.2
        x_lo, x_hi = int(max(0, px - r - 2)), int(min(w, px + r + 3))
        y_lo, y_hi = int(max(0, py - r - 2)), int(min(h, py + r + 3))
        if x_lo >= x_hi or y_lo >= y_hi: continue
        d = np.hypot(xx[y_lo:y_hi, x_lo:x_hi] - px, yy[y_lo:y_hi, x_lo:x_hi] - py)
        dab = np.clip((r - d) / 1.1, 0, 1) * load
        alpha[y_lo:y_hi, x_lo:x_hi] = np.maximum(alpha[y_lo:y_hi, x_lo:x_hi], dab)

def grain(alpha, rng, loose=0.012):
    h, w = alpha.shape
    g = rng.random((h, w))
    dither = (g < alpha * 1.12).astype(float) * (0.6 + 0.4 * rng.random((h, w)))
    out = alpha * 0.38 + dither * 0.62
    # A few loose grains thrown just past the stroke.
    near = np.zeros_like(alpha, bool)
    from_edge = (alpha > 0.02)
    for dy in (-2, -1, 0, 1, 2):
        for dx in (-2, -1, 0, 1, 2):
            near |= np.roll(np.roll(from_edge, dy, 0), dx, 1)
    toss = (rng.random((h, w)) < loose) & near & (alpha < 0.02)
    return np.where(toss, 0.35 + 0.3 * rng.random((h, w)), out)

W, H = 64, 48           # shown at 16×12, four pixels per CSS pixel
TH = 4.2                # stroke radius in mask pixels

def U(x, y): return (x * W, y * H)

def mark_wave(rng):
    xs = np.linspace(0.06, 0.94, 80)
    pts = [U(x, 0.5 + 0.2 * np.sin((x - 0.06) / 0.88 * 2 * np.pi * 1.5)) for x in xs]
    a = np.zeros((H, W)); brush(a, pts, TH, rng); return a

def mark_knot(rng):
    t = np.linspace(-np.pi + 0.15, np.pi - 0.05, 180)
    x = t - 2.6 * np.sin(t); y = -2.6 * np.cos(t)
    x = (x - x.min()) / (x.max() - x.min()); y = (y - y.min()) / (y.max() - y.min())
    pts = [U(0.08 + 0.84 * a, 0.16 + 0.68 * b) for a, b in zip(x, y)]
    a = np.zeros((H, W)); brush(a, pts, TH * 0.74, rng); return a

def mark_spiral(rng):
    th = np.linspace(0.2, 3.4 * np.pi, 220)
    r = 0.035 + 0.034 * th
    pts = [U(0.5 + r[i] * np.cos(th[i]) * 0.95, 0.5 + r[i] * np.sin(th[i]) * 1.22) for i in range(len(th))]
    a = np.zeros((H, W)); brush(a, pts, TH * 0.88, rng, taper=(0.25, 0.1)); return a

def mark_fork(rng):
    a = np.zeros((H, W))
    stem = catmull([(0.06, 0.58), (0.28, 0.56), (0.46, 0.54)])
    up = catmull([(0.44, 0.54), (0.62, 0.42), (0.78, 0.26), (0.94, 0.2)])
    down = catmull([(0.44, 0.55), (0.64, 0.66), (0.8, 0.78), (0.94, 0.8)])
    brush(a, [U(*p) for p in np.vstack([stem, up])], TH, rng, taper=(0.1, 0.22))
    brush(a, [U(*p) for p in down], TH * 0.85, rng, load0=0.9, taper=(0.0, 0.3))
    return a

def mark_stones(rng):
    a = np.zeros((H, W))
    yy, xx = np.mgrid[0:H, 0:W].astype(float)
    for (cx, cy, rr) in ((0.19, 0.7, 0.24), (0.5, 0.5, 0.2), (0.8, 0.3, 0.165)):
        px, py = U(cx, cy)
        ang = np.arctan2(yy - py, xx - px)
        wob = 1 + 0.12 * np.sin(3 * ang + rng.uniform(0, 6)) + 0.06 * np.sin(5 * ang + rng.uniform(0, 6))
        d = np.hypot(xx - px, (yy - py) * 1.08) / (rr * W * 0.5 * wob)
        a = np.maximum(a, np.clip((1 - d) * 3.2, 0, 1) * rng.uniform(0.82, 1.0))
    return a

def mark_ridge(rng):
    pts = catmull([(0.05, 0.78), (0.28, 0.3), (0.46, 0.6), (0.68, 0.22), (0.95, 0.72)], per=30)
    a = np.zeros((H, W)); brush(a, [U(*p) for p in pts], TH * 0.95, rng); return a

MARKS = {"wave": mark_wave, "knot": mark_knot, "spiral": mark_spiral,
         "fork": mark_fork, "stones": mark_stones, "ridge": mark_ridge}
for i, (name, fn) in enumerate(MARKS.items()):
    rng = np.random.default_rng(300 + i)
    write_png(OUT / f"mark-{name}.png", grain(fn(rng), rng))

def spread(w=240, h=72, seed=41):
    """Sand under a pill after the glass lands: pushed to the rim."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(float) + 0.5
    r = h / 2
    cx = np.clip(xx, r, w - r)
    d_center = np.hypot(xx - cx, yy - r)          # distance from the pill's spine
    inside = r - d_center                          # distance to the rim, inside
    ring = np.exp(-np.clip(inside, 0, None) / 5.0)
    ang_noise = noise1(w, 9, rng)[None, :] * 0.5 + 0.75
    body = np.where(inside > 0, 0.05 + 0.95 * ring * ang_noise, 0)
    body *= np.clip(inside / 1.5, 0, 1)
    g = rng.random((h, w))
    dither = (g < body * 1.1).astype(float) * (0.55 + 0.45 * rng.random((h, w)))
    return body * 0.35 + dither * 0.65

write_png(OUT / "spread.png", spread())
print(sorted(p.name for p in OUT.iterdir()))

def mark_diamond(seed=331, size=48):
    """An element category's mark: a small sand gem, loaded and a little ragged."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:size, 0:size].astype(float) + 0.5
    c = size / 2
    ang = np.arctan2(yy - c, xx - c)
    wob = 1 + 0.07 * np.sin(5 * ang + rng.uniform(0, 6)) + 0.05 * np.sin(9 * ang + rng.uniform(0, 6))
    d = (np.abs(xx - c) / (size * 0.30) + np.abs(yy - c) / (size * 0.42)) / wob
    body = np.clip((1 - d) * 5.0, 0, 1) * (0.85 + 0.15 * rng.random((size, size)))
    return grain(body, rng, loose=0.02)

write_png(OUT / "mark-diamond.png", mark_diamond())

def frame_box(size=240, inset=12, thick=2.4, seed=57):
    """A sand frame for a box of any size, cut into nine slices: four dry
    strokes, one per side, each with its own load, overlapping at the corners."""
    rng = np.random.default_rng(seed)
    a = np.zeros((size, size))
    lo, hi = inset, size - inset
    sides = [((lo - 3, lo), (hi + 3, lo)), ((hi, lo - 3), (hi, hi + 3)),
             ((hi + 3, hi), (lo - 3, hi)), ((lo, hi + 3), (lo, lo - 3))]
    for (x0, y0), (x1, y1) in sides:
        pts = [(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t) for t in np.linspace(0, 1, 120)]
        brush(a, pts, thick, rng, load0=rng.uniform(0.85, 1.0), dry=0.25, taper=(0.03, 0.05))
    return grain(a, rng, loose=0.01)

write_png(OUT / "frame-box.png", frame_box())

def mark_dash(seed=377, w=64, h=24):
    """A short loaded stroke: lands heavy, lifts off a little drier."""
    rng = np.random.default_rng(seed)
    a = np.zeros((h, w))
    pts = [(6 + 52 * t, 12.5 - 1.2 * np.sin(t * np.pi)) for t in np.linspace(0, 1, 60)]
    brush(a, pts, 4.6, rng, load0=1.0, dry=0.35, taper=(0.12, 0.3))
    return grain(a, rng, loose=0.01)

write_png(OUT / "mark-dash.png", mark_dash())

def mark_square(seed=411, size=48):
    """An element's mark: a small square seal pressed in sand, edges a little
    ragged, turned a few degrees off true."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:size, 0:size].astype(float) + 0.5
    c = size / 2
    th = np.deg2rad(rng.uniform(3, 6))
    u = (xx - c) * np.cos(th) + (yy - c) * np.sin(th)
    v = -(xx - c) * np.sin(th) + (yy - c) * np.cos(th)
    half = size * 0.33
    edge_u = half * (1 + 0.05 * np.sin(v / size * 19 + rng.uniform(0, 6)))
    edge_v = half * (1 + 0.05 * np.sin(u / size * 17 + rng.uniform(0, 6)))
    d = np.maximum(np.abs(u) / edge_u, np.abs(v) / edge_v)
    body = np.clip((1 - d) * 7.0, 0, 1) * (0.86 + 0.14 * rng.random((size, size)))
    return grain(body, rng, loose=0.015)

def mark_corner(seed=419, size=48):
    """An element category's mark: one stroke down and along, the corner of
    the sand box the category draws round its elements."""
    rng = np.random.default_rng(seed)
    a = np.zeros((size, size))
    pts = [(12, 9)] + [(12, 9 + 27 * t) for t in np.linspace(0.05, 1, 30)] + [(12 + 26 * t, 36) for t in np.linspace(0.05, 1, 30)]
    brush(a, pts, 3.6, rng, load0=1.0, dry=0.3, taper=(0.08, 0.2))
    return grain(a, rng, loose=0.01)

write_png(OUT / "mark-square.png", mark_square())
write_png(OUT / "mark-corner.png", mark_corner())

def mark_slip(seed=431, w=24, h=56):
    """A material's mark: one upright stroke, a slip of paper tucked into the
    book. Lands heavy at the top, leans a hair, lifts off drier."""
    rng = np.random.default_rng(seed)
    a = np.zeros((h, w))
    pts = [(12.5 + 1.6 * t, 6 + 44 * t) for t in np.linspace(0, 1, 60)]
    brush(a, pts, 4.4, rng, load0=1.0, dry=0.35, taper=(0.1, 0.28))
    return grain(a, rng, loose=0.01)

write_png(OUT / "mark-slip.png", mark_slip())

def mark_fold(seed=443, w=72, h=40):
    """The whole book's mark: one stroke folded back and forth, a folding
    book (经折装) seen edge-on. Sharp turns, so it never reads as a wave."""
    rng = np.random.default_rng(seed)
    a = np.zeros((h, w))
    xs = [6, 20, 34, 48, 62]
    ys = [30, 10, 30, 10, 30]
    pts = []
    for i in range(len(xs) - 1):
        for t in np.linspace(0, 1, 18, endpoint=False):
            pts.append((xs[i] + (xs[i + 1] - xs[i]) * t, ys[i] + (ys[i + 1] - ys[i]) * t))
    pts.append((xs[-1], ys[-1]))
    brush(a, pts, 5.0, rng, load0=1.0, dry=0.12, taper=(0.04, 0.1))
    return grain(a, rng, loose=0.01)

write_png(OUT / "mark-fold.png", mark_fold())

def mark_folding_book(seed=457, w=88, h=56):
    """The whole book's mark, drawn as the thing itself: a folding book
    (经折装) standing open, four leaves turning one way then the other.
    Lines only: the top and bottom edges zigzag and every fold is its own
    upright stroke; no shading, no depth."""
    rng = np.random.default_rng(seed)
    a = np.zeros((h, w))
    xs = [8, 26, 44, 62, 80]
    top = [10, 16, 10, 16, 10]
    bot = [42, 48, 42, 48, 42]
    yy, xx = np.mgrid[0:h, 0:w].astype(float)
    def line(p0, p1, n=24):
        return [(p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t) for t in np.linspace(0, 1, n)]
    edge_top = sum((line((xs[i], top[i]), (xs[i + 1], top[i + 1]))[:-1] for i in range(4)), []) + [(xs[-1], top[-1])]
    edge_bot = sum((line((xs[i], bot[i]), (xs[i + 1], bot[i + 1]))[:-1] for i in range(4)), []) + [(xs[-1], bot[-1])]
    brush(a, edge_top, 2.5, rng, load0=1.0, dry=0.25, taper=(0.04, 0.08))
    brush(a, edge_bot, 2.5, rng, load0=0.95, dry=0.25, taper=(0.04, 0.08))
    for i, x in enumerate(xs):
        brush(a, line((x, top[i] - 1), (x, bot[i] + 1), 20), 2.3 if i in (0, 4) else 2.0, rng, load0=rng.uniform(0.85, 1.0), dry=0.2, taper=(0.06, 0.12))
    return grain(a, rng, loose=0.008)

write_png(OUT / "mark-fold.png", mark_folding_book())

def mark_star(seed=467, size=56):
    """The whole book's mark: an asterisk of short strokes thrown out from one
    centre, each loaded where it starts and lifting off at its tip, the
    lengths a little uneven so it reads as handmade."""
    rng = np.random.default_rng(seed)
    a = np.zeros((size, size))
    c = size / 2
    rays = 8
    base = 0.0
    for k in range(rays):
        ang = base + k * 2 * np.pi / rays + rng.uniform(-0.05, 0.05)
        r0 = rng.uniform(2.5, 4.5)
        r1 = size * rng.uniform(0.36, 0.45)
        pts = [(c + np.cos(ang) * r, c + np.sin(ang) * r) for r in np.linspace(r0, r1, 22)]
        brush(a, pts, 3.3, rng, load0=rng.uniform(0.9, 1.0), dry=0.3, taper=(0.05, 0.35))
    yy, xx = np.mgrid[0:size, 0:size].astype(float)
    a = np.maximum(a, np.clip((4.2 - np.hypot(xx - c, yy - c)) / 1.2, 0, 1))
    return grain(a, rng, loose=0.01)

write_png(OUT / "mark-star.png", mark_star())

def mark_star_blunt(seed=479, size=56):
    """The whole book's star, blunt and rough: eight thick rays that stop
    short with round, dry ends instead of points, edges left ragged."""
    rng = np.random.default_rng(seed)
    a = np.zeros((size, size))
    c = size / 2
    for k in range(8):
        ang = k * np.pi / 4 + rng.uniform(-0.1, 0.1)
        r1 = size * rng.uniform(0.33, 0.39)
        pts = [(c + np.cos(ang) * r, c + np.sin(ang) * r) for r in np.linspace(2.0, r1, 18)]
        brush(a, pts, 4.6, rng, load0=rng.uniform(0.9, 1.0), dry=0.22, taper=(0.03, 0.06))
    yy, xx = np.mgrid[0:size, 0:size].astype(float)
    a = np.maximum(a, np.clip((6.0 - np.hypot(xx - c, yy - c)) / 1.4, 0, 1))
    return grain(a, rng, loose=0.03)

write_png(OUT / "mark-star.png", mark_star_blunt())

def mark_star_thick(seed=487, size=64):
    """The whole book's star, thick and rough: eight broad rays with blunt,
    dry ends and ragged edges, loose grains thrown round them."""
    rng = np.random.default_rng(seed)
    a = np.zeros((size, size))
    c = size / 2
    for k in range(8):
        ang = k * np.pi / 4 + rng.uniform(-0.12, 0.12)
        r1 = size * rng.uniform(0.38, 0.44)
        pts = [(c + np.cos(ang) * r, c + np.sin(ang) * r) for r in np.linspace(2.0, r1, 20)]
        brush(a, pts, 6.4, rng, load0=rng.uniform(0.85, 1.0), dry=0.3, taper=(0.02, 0.05))
    yy, xx = np.mgrid[0:size, 0:size].astype(float)
    a = np.maximum(a, np.clip((8.0 - np.hypot(xx - c, yy - c)) / 1.6, 0, 1))
    # Bite the edges so they read as dry brush rather than a clean outline.
    bite = (rng.random((size, size)) < 0.22) & (a < 0.9) & (a > 0.05)
    a = np.where(bite, a * rng.uniform(0.0, 0.5, (size, size)), a)
    return grain(a, rng, loose=0.05)

write_png(OUT / "mark-star.png", mark_star_thick())

def icon_split(seed=503, size=96):
    """Split a sidebar into two columns: a pair of hanging scrolls side by
    side, each with a rod across the top and the bottom. Same brush and
    weight as the other sand icons."""
    rng = np.random.default_rng(seed)
    a = np.zeros((size, size))
    def line(p0, p1, n=28):
        return [(p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t) for t in np.linspace(0, 1, n)]
    for (x0, x1) in ((15, 39), (57, 81)):
        brush(a, line((x0 - 5, 17), (x1 + 5, 17)), 3.6, rng, load0=1.0, dry=0.2, taper=(0.06, 0.1))
        brush(a, line((x0 - 4, 80), (x1 + 4, 80)), 3.4, rng, load0=0.95, dry=0.25, taper=(0.06, 0.1))
        brush(a, line((x0, 19), (x0, 78)), 2.6, rng, load0=0.95, dry=0.25, taper=(0.04, 0.08))
        brush(a, line((x1, 19), (x1, 78)), 2.6, rng, load0=0.9, dry=0.25, taper=(0.04, 0.08))
        # The hanging cord, a short peak above the top rod.
        cx = (x0 + x1) / 2
        brush(a, line((cx - 7, 16), (cx, 7), 12) + line((cx, 7), (cx + 7, 16), 12), 1.8, rng, load0=0.8, dry=0.3, taper=(0.1, 0.1))
    return grain(a, rng, loose=0.006)

write_png(OUT / "si-split.png", icon_split())
