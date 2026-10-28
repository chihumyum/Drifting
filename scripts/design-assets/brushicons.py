"""Sand-brush icons for the chapter end, the dock and the user menu (white on
alpha, 96×96, shown at 13–20px). Same brush as glyphgen.py, plus a few filled
shapes (pressed dots, cut paper, carved holes). Each icon has a fixed seed, so
a rerun reproduces the committed pixels.

stones-triad.png            the chapter end: 三尊石, a dry garden's triad of stones
brush-laid / brush-lifted   mark finished (搁笔) / back to draft (提笔)
sprout.png                  new next chapter: a sprout with two leaves
shikigami.png               Agent review: a paper doll with an eye for a head
lock-open / lock-shut       dock lock: pills fold to dots / stay spread
plus.png                    dock new: two strokes, level then standing
enso / ink-disc / taiji     theme light / dark / system
wen.png                     language: the character 文
jizo.png                    Copilot: a small roadside stone figure, staff at its side
dharma-wheel.png            settings: a wheel with eight handles
movable-type.png            keyboard shortcuts: rows of type blocks
case-dew.png                import: a 垂露 stroke let down into an open case
case-rise.png               save as a file: the same drop turned over, rising out of the case
books.png                   bookshelf: three volumes, the last one leaning
gate-in / gate-out          sign in / sign out: a stroke through a door frame

Small glyphs, 9–16px, drawn a little heavier and finished with fine grain
(solid ink, a light dither only at the edges, no loose grains):

close.png                   two even diagonal strokes
arrow-back / arrow-forward  a 「く」 head and a shaft; forward is its mirror
chevron-down/right/up/left  one even stroke down and up, turned four ways
check.png                   a short press, then a long flick drying out
minus.png                   one level stroke
loader.png                  an ensō a quarter short (spun in CSS)
trash.png                   a waste-paper basket (字纸篓) with a cross inside
edit.png                    a writing brush at a slant, a full head tapering to its tip
search.png                  an ensō and a short heavy handle
copy.png                    one sheet over another, a little offset
stop.png                    a square seal pressed solid
folder / folder-open / folder-plus   a cloth book case (书帙) shut, opened, and with a plus

Objects and states, also fine grain:

file-text.png               a sheet with its lower corner curling up
comment-plus.png            the comment icon, a plus at its corner
rotate.png                  a circle drawn backwards, arrowhead at its end
sort.png                    counting rods (算筹) laid long to short
status-done/-warning/-stopped  an inked round seal, a tick, 「！」 or a slash cut white
cloud.png                   祥云: a curl coiled at the left, two lobes, the tail run out beneath
checklist / checklist-plus  three rows, each after a small box; the first ticked
sticky-note.png             a slip tucked in at a slant, its top corner folded
mic.png                     a length of bamboo in a microphone holder
image / image-plus          a round moon window with hills in it
eraser.png                  a whisk (拂尘)
share.png                   a kite let out on the wind
layers.png                  three sheets laid one on another
branch.png                  a twig that forks, a bud on each end
view-grid / view-list       four square seals / three solid bars
open-book.png               two pages open, two lines on each
knots.png                   a cord with knots tied along it (结绳记事)

tea.png                     a cup just set down, still steaming (Project Home "recent")

moon-left-hollow / moon-right-hollow  the sidebar toggles' crescents with the
                            inside cleared, the rim as thin, light and sandy as
                            the moon's faint outer ring: shown while that
                            sidebar is closed
"""
import struct, sys, zlib
from pathlib import Path
import numpy as np

OUT = Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
S = 96

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

def grain(alpha, rng, loose=0.006):
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

def grain_fine(alpha, rng):
    """Finer sand for small glyphs: most of the stroke stays solid."""
    h, w = alpha.shape
    g = rng.random((h, w))
    dither = (g < alpha * 1.2).astype(float) * (0.75 + 0.25 * rng.random((h, w)))
    return np.clip(alpha * 0.7 + dither * 0.3, 0, 1)

def read_png_alpha(path):
    """The alpha of a committed mask (8-bit RGBA or grey+alpha, any filter)."""
    data = Path(path).read_bytes()
    pos, idat = 8, b""
    while pos < len(data):
        n, = struct.unpack(">I", data[pos:pos + 4]); kind = data[pos + 4:pos + 8]; body = data[pos + 8:pos + 8 + n]; pos += 12 + n
        if kind == b"IHDR": w, h, _, ct = struct.unpack(">IIBB", body[:10])
        elif kind == b"IDAT": idat += body
    ch = {6: 4, 4: 2}[ct]
    raw = zlib.decompress(idat); stride = w * ch
    out = np.zeros((h, stride), np.int32); prev = np.zeros(stride, np.int32); p = 0
    for y in range(h):
        f = raw[p]; cur = np.frombuffer(raw[p + 1:p + 1 + stride], np.uint8).astype(np.int32).copy(); p += 1 + stride
        if f == 2: cur = (cur + prev) & 255
        elif f in (1, 3, 4):
            for i in range(stride):
                a_ = cur[i - ch] if i >= ch else 0; b_ = prev[i]; c_ = prev[i - ch] if i >= ch else 0
                if f == 1: pr = a_
                elif f == 3: pr = (a_ + b_) // 2
                else:
                    pa, pb, pc = abs(b_ - c_), abs(a_ - c_), abs(a_ + b_ - 2 * c_)
                    pr = a_ if pa <= pb and pa <= pc else (b_ if pb <= pc else c_)
                cur[i] = (cur[i] + pr) & 255
        out[y] = cur; prev = cur
    return out.reshape(h, w, ch)[..., ch - 1] / 255.0

ICON_DIR = Path(__file__).resolve().parents[2] / "src/assets/design/icons"

# ── Paths ──

def line(p0, p1, n=28):
    return [(p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t) for t in np.linspace(0, 1, n)]

def arc(cx, cy, rx, ry, a0, a1, n=80):
    """Angles in degrees, 0 = right, 90 = down (screen space)."""
    t = np.deg2rad(np.linspace(a0, a1, n))
    return [(cx + rx * np.cos(u), cy + ry * np.sin(u)) for u in t]

def curve(points, per=24):
    return [tuple(p) for p in catmull(points, per)]

def poly(*corners, n=20):
    out = []
    for i in range(len(corners) - 1):
        out += line(corners[i], corners[i + 1], n)[:-1]
    out.append(corners[-1])
    return out

# ── Fills ──

YY, XX = np.mgrid[0:S, 0:S].astype(float) + 0.5

def new(): return np.zeros((S, S))

def disc(a, cx, cy, r, rng, wob=0.08, squash=1.0, load=1.0):
    """A pressed ink dot: round, edges a little uneven."""
    ang = np.arctan2(YY - cy, XX - cx)
    w = 1 + wob * np.sin(3 * ang + rng.uniform(0, 6)) + wob * 0.5 * np.sin(5 * ang + rng.uniform(0, 6))
    d = np.hypot(XX - cx, (YY - cy) / squash) / (r * w)
    body = np.clip((1 - d) * r / 1.3, 0, 1) * load * (0.9 + 0.1 * rng.random((S, S)))
    np.maximum(a, body, out=a)

def fill_poly(a, pts, rng, load=1.0, soft=1.1, rough=0.6):
    """Fill a closed polygon with ink; the edge is a little ragged."""
    pts = np.asarray(pts, float)
    x0, y0 = pts[:, 0], pts[:, 1]
    x1, y1 = np.roll(x0, -1), np.roll(y0, -1)
    inside = np.zeros((S, S), bool)
    dmin = np.full((S, S), 1e9)
    for i in range(len(pts)):
        ax, ay, bx, by = x0[i], y0[i], x1[i], y1[i]
        cond = ((ay > YY) != (by > YY))
        xint = ax + (YY - ay) * (bx - ax) / np.where(by - ay == 0, 1e-9, by - ay)
        inside ^= cond & (XX < xint)
        vx, vy = bx - ax, by - ay
        L = max(1e-9, vx * vx + vy * vy)
        t = np.clip(((XX - ax) * vx + (YY - ay) * vy) / L, 0, 1)
        dmin = np.minimum(dmin, np.hypot(XX - (ax + t * vx), YY - (ay + t * vy)))
    jitter = (rng.random((S, S)) - 0.5) * rough * 2
    sd = np.where(inside, dmin, -dmin) + jitter
    body = np.clip(sd / soft + 0.5, 0, 1) * load * (0.9 + 0.1 * rng.random((S, S)))
    np.maximum(a, body, out=a)

def erase(a, mask_alpha):
    """Carve (阴刻) a shape out of an inked area."""
    a *= (1 - np.clip(mask_alpha, 0, 1))

def block(a, rng, x0, y0, x1, y1, tilt=0.0):
    """A filled block turned a little off true."""
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    c, s = np.cos(tilt), np.sin(tilt)
    R = lambda x, y: (cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c)
    fill_poly(a, [R(x0, y0), R(x1, y0), R(x1, y1), R(x0, y1)], rng, rough=0.8)

def dot_stroke(a, cx, cy, rng, s=1.0):
    """A calligraphic 点: lands thin, presses down into a round belly."""
    brush(a, line((cx - 7 * s, cy - 9 * s), (cx + 1 * s, cy + 1 * s), 16), 6.2 * s, rng, load0=1.0, dry=0.0, taper=(0.85, 0.0))
    disc(a, cx + 1.5 * s, cy + 2.5 * s, 7.2 * s, rng, wob=0.06)

# ── Chapter end ──

def stones_triad(rng):
    """三尊石: one big stone at the back, two smaller in front."""
    a = new()
    disc(a, 48, 32, 15.5, rng, wob=0.1, squash=0.88)
    disc(a, 24, 66, 12, rng, wob=0.1, squash=0.85)
    disc(a, 72, 67, 10, rng, wob=0.1, squash=0.85)
    return a

def brush_rest(a, rng):
    brush(a, poly((26, 82), (36, 70), (44, 76), (52, 64), (60, 76), (68, 70), (78, 82), n=12) + line((78, 82), (26, 82), 20), 2.8, rng, load0=1.0, dry=0.15, taper=(0.04, 0.06))

def brush_laid(rng):
    """搁笔: the brush laid across its rest — writing done."""
    a = new()
    brush_rest(a, rng)
    brush(a, line((26, 54), (90, 52)), 3.1, rng, load0=1.0, dry=0.25, taper=(0.02, 0.06))
    brush(a, line((28, 55), (6, 59), 20), 6.4, rng, load0=1.0, dry=0.1, taper=(0.0, 0.9))
    return a

def brush_lifted(rng):
    """提笔: the brush lifted off its rest again."""
    a = new()
    brush_rest(a, rng)
    brush(a, line((44, 40), (84, 8)), 3.1, rng, load0=1.0, dry=0.25, taper=(0.02, 0.06))
    brush(a, line((45, 39), (30, 56), 20), 6.4, rng, load0=1.0, dry=0.1, taper=(0.0, 0.9))
    return a

def sprout(rng):
    """新芽: a sprout with two leaves out of a line of soil."""
    a = new()
    brush(a, line((16, 82), (80, 81)), 3.0, rng, load0=0.9, dry=0.3, taper=(0.06, 0.12))
    brush(a, curve([(48, 81), (47, 62), (49, 44)]), 3.0, rng, load0=1.0, dry=0.2, taper=(0.0, 0.1))
    brush(a, curve([(46, 46), (34, 30), (14, 28)]), 7.2, rng, load0=1.0, dry=0.1, taper=(0.45, 0.45))
    brush(a, curve([(50, 42), (64, 22), (84, 16)]), 7.6, rng, load0=1.0, dry=0.1, taper=(0.45, 0.45))
    return a

def shikigami(rng):
    """式神: a paper doll cut flat, an eye where its head would be — the eye
    inked solid, its pupil left white."""
    a = new()
    pts = [(36, 35), (12, 37), (12, 48), (36, 47), (38, 65), (31, 90), (44, 90), (48, 73),
           (52, 90), (65, 90), (58, 65), (60, 47), (84, 48), (84, 37), (60, 35)]
    fill_poly(a, pts, rng, rough=0.9)
    upper = curve([(20, 18), (32, 5), (64, 4), (76, 17)], 12)
    lower = curve([(76, 17), (62, 30), (34, 30), (20, 18)], 12)
    fill_poly(a, upper + lower, rng, rough=0.7)
    pupil = new()
    disc(pupil, 48, 17, 6.6, np.random.default_rng(17), wob=0.05)
    erase(a, np.clip(pupil * 1.3, 0, 1))
    return a

# ── Dock ──

def lock_body(a, rng):
    fill_poly(a, curve([(20, 44), (76, 44), (80, 64), (76, 86), (20, 86), (16, 64), (20, 44)], 6), rng, rough=0.7)
    hole = new()
    disc(hole, 48, 60, 5.2, np.random.default_rng(3), wob=0.02)
    fill_poly(hole, [(45, 62), (51, 62), (52.5, 76), (43.5, 76)], np.random.default_rng(4), rough=0.0)
    erase(a, hole)

def lock_open(rng):
    """The shackle swung up off one leg: the pills fold back to dots."""
    a = new()
    lock_body(a, rng)
    brush(a, curve([(66, 46), (66, 24), (77, 11), (89, 17), (91, 30)]), 4.0, rng, load0=1.0, dry=0.2, taper=(0.02, 0.04))
    return a

def lock_shut(rng):
    """The shackle home: the pills stay spread."""
    a = new()
    lock_body(a, rng)
    brush(a, curve([(30, 46), (30, 26), (48, 12), (66, 26), (66, 46)]), 4.0, rng, load0=1.0, dry=0.2, taper=(0.02, 0.04))
    return a

def plus(rng):
    """A level stroke, then a standing one."""
    a = new()
    brush(a, line((14, 49), (82, 47)), 4.0, rng, load0=1.0, dry=0.3, taper=(0.08, 0.15))
    brush(a, line((48, 14), (49, 83)), 3.8, rng, load0=1.0, dry=0.3, taper=(0.08, 0.15))
    return a

# ── User menu ──

def jizo(rng):
    """地藏: a small roadside stone figure, a bib carved on its chest, a staff
    at its side."""
    a = new()
    disc(a, 40, 22, 12.5, rng, wob=0.05)
    body = curve([(30, 37), (24, 52), (18, 72), (16, 84), (64, 84), (62, 72), (56, 52), (50, 37), (30, 37)], 8)
    fill_poly(a, body, rng, rough=0.8)
    bib = new()
    brush(bib, line((26, 45), (40, 56), 12) + line((40, 56), (54, 45), 12), 2.4, np.random.default_rng(5), dry=0.0, taper=(0, 0))
    erase(a, bib)
    fill_poly(a, [(10, 86), (70, 86), (70, 92), (10, 92)], rng, rough=0.6)
    brush(a, line((80, 18), (80, 92)), 2.6, rng, load0=1.0, dry=0.25, taper=(0.02, 0.05))
    brush(a, arc(80, 13, 6, 7, 0, 360, 40), 2.2, rng, load0=0.95, dry=0.2, taper=(0.05, 0.05))
    return a

def enso(rng):
    """Light theme: an empty circle."""
    a = new(); brush(a, arc(48, 48, 30, 30, -110, 270, 150), 3.6, rng, load0=1.0, dry=0.3, taper=(0.04, 0.12)); return a

def ink_disc(rng):
    """Dark theme: the circle inked solid."""
    a = new(); disc(a, 48, 48, 32, rng, wob=0.04); return a

def taiji(rng):
    """Follow the system: the circle half dark, an S through the centre."""
    a = new()
    brush(a, arc(48, 48, 30, 30, -110, 270, 150), 3.6, rng, load0=1.0, dry=0.3, taper=(0.04, 0.12))
    s = arc(48, 33, 15, 15, -90, 90, 30) + arc(48, 63, 15, 15, -90, -270, 30)
    rim = arc(48, 48, 30, 30, 90, 270, 50)
    fill_poly(a, s + rim, rng, rough=0.5)
    disc(a, 48, 63, 4.5, rng)
    erase(a, np.clip((5 - np.hypot(XX - 48, YY - 33)) / 1.2, 0, 1))
    return a

def wen(rng):
    """文: 点, 横, 撇, 捺 — the character for writing and language."""
    a = new()
    dot_stroke(a, 46, 14, rng, s=0.75)
    brush(a, line((14, 32), (82, 30)), 3.6, rng, load0=1.0, dry=0.2, taper=(0.08, 0.06))
    brush(a, curve([(66, 36), (54, 60), (34, 78), (12, 88)]), 4.0, rng, load0=1.0, dry=0.3, taper=(0.04, 0.6))
    brush(a, curve([(30, 40), (44, 60), (64, 78), (86, 86)]), 4.2, rng, load0=0.95, dry=0.0, taper=(0.4, 0.04))
    return a

def dharma_wheel(rng):
    """法轮: a wheel with eight handles round its rim."""
    a = new()
    brush(a, arc(48, 48, 22, 22, -100, 270, 120), 3.6, rng, load0=1.0, dry=0.25, taper=(0.03, 0.08))
    for k in range(8):
        ang = np.deg2rad(k * 45 + 22.5)
        brush(a, [(48 + np.cos(ang) * r, 48 + np.sin(ang) * r) for r in np.linspace(25, 39, 10)], 3.8, rng,
              load0=1.0, dry=0.1, taper=(0.0, 0.2))
    disc(a, 48, 48, 7, rng)
    return a

def movable_type(rng):
    """活字: type blocks set in two rows, a long one beneath."""
    a = new()
    for y in (20, 42):
        for x in (12, 38, 64):
            j = rng.uniform(-1.5, 1.5)
            block(a, rng, x + j, y, x + 20 + j, y + 16, tilt=rng.uniform(-0.06, 0.06))
    block(a, rng, 22, 66, 74, 80, tilt=rng.uniform(-0.03, 0.03))
    return a

def case_dew(rng):
    """垂露: a stroke let down into an open case, a hair at the top, landing heavy."""
    a = new()
    brush(a, poly((18, 44), (18, 84), (78, 84), (78, 44), n=24), 3.4, rng, load0=1.0, dry=0.25, taper=(0.04, 0.06))
    side_l = curve([(48, 4), (45.5, 22), (41.5, 42), (38.5, 56)], 10)
    side_r = curve([(57.5, 56), (54.5, 42), (50.5, 22), (48, 4)], 10)
    fill_poly(a, side_l + arc(48, 57, 9.5, 9, 190, -10, 24) + side_r, rng, rough=0.6)
    return a

def case_rise(rng):
    """The import's drop turned over: full at the top, a hair where it leaves the case."""
    a = new()
    brush(a, poly((18, 44), (18, 84), (78, 84), (78, 44), n=24), 3.4, rng, load0=1.0, dry=0.25, taper=(0.04, 0.06))
    flip = lambda pts: [(x, 70 - y) for x, y in pts]
    side_l = curve([(48, 4), (45.5, 22), (41.5, 42), (38.5, 56)], 10)
    side_r = curve([(57.5, 56), (54.5, 42), (50.5, 22), (48, 4)], 10)
    fill_poly(a, flip(side_l + arc(48, 57, 9.5, 9, 190, -10, 24) + side_r), rng, rough=0.6)
    return a

def books(rng):
    """Three volumes standing on a shelf, the last one leaning."""
    a = new()
    brush(a, line((6, 86), (90, 86)), 2.8, rng, load0=0.95, dry=0.25, taper=(0.03, 0.05))
    block(a, rng, 14, 28, 25, 82)
    block(a, rng, 32, 16, 43, 82)
    fill_poly(a, [(52, 82), (63, 82), (82, 32), (72, 28)], rng, rough=0.7)
    return a

def door_frame(a, rng, x0, x1):
    """Left post, lintel and right post in one stroke."""
    brush(a, poly((x0, 90), (x0, 12), (x1, 12), (x1, 90), n=36), 3.6, rng, load0=1.0, dry=0.3, taper=(0.04, 0.08))

def arrow(a, rng, x0, x1, y=56):
    brush(a, line((x0, y), (x1, y)), 3.6, rng, load0=1.0, dry=0.1, taper=(0.1, 0.0))
    brush(a, line((x1, y), (x1 - 14, y - 12), 10), 3.2, rng, load0=1.0, dry=0.2, taper=(0.0, 0.3))
    brush(a, line((x1, y), (x1 - 14, y + 12), 10), 3.2, rng, load0=1.0, dry=0.2, taper=(0.0, 0.3))

def gate_in(rng):
    """Sign in: a stroke led in through the door frame."""
    a = new(); door_frame(a, rng, 36, 86); arrow(a, rng, 4, 64); return a

def gate_out(rng):
    """Sign out: the stroke led back out."""
    a = new(); door_frame(a, rng, 10, 60); arrow(a, rng, 32, 92); return a

# ── Small glyphs ──

G = 4.0   # glyph stroke radius

def close(rng):
    a = new()
    brush(a, line((20, 20), (76, 76)), G, rng, load0=1.0, dry=0.25, taper=(0.08, 0.12))
    brush(a, line((76, 20), (20, 76)), G, rng, load0=1.0, dry=0.25, taper=(0.08, 0.12))
    return a

def arrow_back(rng):
    a = new()
    brush(a, poly((44, 22), (16, 48), (44, 74), n=24), G, rng, load0=1.0, dry=0.25, taper=(0.1, 0.1))
    brush(a, line((18, 48), (84, 48)), G, rng, load0=1.0, dry=0.35, taper=(0.04, 0.15))
    return a

def chevron_down(rng):
    a = new()
    brush(a, poly((20, 34), (48, 64), (76, 34), n=24), G * 1.1, rng, load0=1.0, dry=0.2, taper=(0.08, 0.08))
    return a

def check(rng):
    a = new()
    brush(a, line((16, 50), (38, 74), 16), G * 1.1, rng, load0=1.0, dry=0.0, taper=(0.3, 0.0))
    brush(a, curve([(38, 74), (58, 48), (84, 18)]), G * 1.15, rng, load0=1.0, dry=0.4, taper=(0.0, 0.6))
    return a

def minus(rng):
    a = new(); brush(a, line((18, 49), (78, 47)), G * 1.05, rng, load0=1.0, dry=0.3, taper=(0.08, 0.15)); return a

def loader(rng):
    a = new(); brush(a, arc(48, 48, 30, 30, -90, 190, 120), G * 1.05, rng, load0=1.0, dry=0.6, taper=(0.04, 0.35)); return a

def trash(rng):
    a = new()
    brush(a, poly((14, 34), (24, 86), (72, 86), (82, 34), n=24), G * 0.9, rng, load0=1.0, dry=0.2, taper=(0.03, 0.05))
    brush(a, line((10, 34), (86, 34)), G, rng, load0=1.0, dry=0.15, taper=(0.04, 0.05))
    brush(a, line((34, 46), (62, 76), 20), G * 0.7, rng, load0=1.0, dry=0.2, taper=(0.08, 0.12))
    brush(a, line((62, 46), (34, 76), 20), G * 0.7, rng, load0=1.0, dry=0.2, taper=(0.08, 0.12))
    return a

def edit(rng):
    a = new()
    brush(a, line((40, 58), (86, 12)), G * 0.75, rng, load0=1.0, dry=0.2, taper=(0.02, 0.05))
    head = curve([(44, 50), (36, 54), (24, 68), (10, 88), (28, 74), (42, 64), (48, 56), (44, 50)], 8)
    fill_poly(a, head, rng, rough=0.6)
    return a

def search(rng):
    a = new()
    brush(a, arc(40, 40, 24, 24, -120, 250, 120), G, rng, load0=1.0, dry=0.3, taper=(0.04, 0.12))
    brush(a, line((58, 58), (84, 84)), G * 1.45, rng, load0=1.0, dry=0.15, taper=(0.05, 0.15))
    return a

def copy(rng):
    a = new()
    brush(a, poly((14, 64), (14, 12), (62, 12), n=22), G * 0.8, rng, load0=0.9, dry=0.2, taper=(0.03, 0.08))
    brush(a, poly((32, 30), (82, 30), (82, 84), (32, 84), (32, 30), n=22), G * 0.8, rng, load0=1.0, dry=0.15, taper=(0.02, 0.02))
    return a

def stop(rng):
    a = new()
    c, s = np.cos(0.05), np.sin(0.05)
    R = lambda x, y: (48 + (x - 48) * c - (y - 48) * s, 48 + (x - 48) * s + (y - 48) * c)
    fill_poly(a, [R(22, 22), R(74, 22), R(74, 74), R(22, 74)], rng, rough=0.9)
    return a

def folder(rng):
    """书帙: the case closed round its sheets, a bone clasp holding it."""
    a = new()
    brush(a, poly((12, 30), (84, 30), (84, 82), (12, 82), (12, 30), n=26), G * 0.85, rng, load0=1.0, dry=0.2, taper=(0.02, 0.02))
    brush(a, line((12, 44), (84, 44), 24), G * 0.55, rng, load0=0.85, dry=0.2, taper=(0.03, 0.03))
    brush(a, line((76, 56), (94, 56), 10), G * 0.8, rng, load0=1.0, dry=0.1, taper=(0.02, 0.02))
    disc(a, 92, 56, 3.8, rng)
    return a

def folder_open(rng):
    """The case's flap folded back, the sheets showing."""
    a = new()
    brush(a, poly((12, 44), (12, 82), (84, 82), (84, 44), n=24), G * 0.85, rng, load0=1.0, dry=0.2, taper=(0.02, 0.02))
    brush(a, poly((12, 44), (26, 14), (94, 14), (84, 44), n=22), G * 0.75, rng, load0=0.95, dry=0.25, taper=(0.03, 0.05))
    for y in (56, 68):
        brush(a, line((24, y), (70, y), 16), G * 0.5, rng, load0=0.85, dry=0.3, taper=(0.05, 0.1))
    return a

def folder_plus(rng):
    """The closed case, a plus at its lower right."""
    a = new()
    brush(a, poly((12, 30), (66, 30), n=24), G * 0.85, rng, load0=1.0, dry=0.2, taper=(0.02, 0.02))
    brush(a, poly((84, 46), (84, 30), (66, 30), n=12), G * 0.85, rng, load0=1.0, dry=0.2, taper=(0.02, 0.02))
    brush(a, poly((12, 30), (12, 82), (56, 82), n=24), G * 0.85, rng, load0=1.0, dry=0.2, taper=(0.02, 0.02))
    brush(a, line((12, 44), (60, 44), 18), G * 0.55, rng, load0=0.85, dry=0.2, taper=(0.03, 0.03))
    brush(a, line((62, 64), (88, 64), 14), G * 0.85, rng, load0=1.0, dry=0.1, taper=(0.05, 0.05))
    brush(a, line((75, 51), (75, 77), 14), G * 0.85, rng, load0=1.0, dry=0.1, taper=(0.05, 0.05))
    return a

# ── Objects and states ──

T = G

def plus_at(a, rng, cx, cy, r=12, th=None):
    th = th or T * 0.85
    brush(a, line((cx - r, cy), (cx + r, cy), 14), th, rng, load0=1.0, dry=0.1, taper=(0.05, 0.05))
    brush(a, line((cx, cy - r), (cx, cy + r), 14), th, rng, load0=1.0, dry=0.1, taper=(0.05, 0.05))

def clear_disc(a, cx, cy, r):
    erase(a, np.clip((r - np.hypot(XX - cx, YY - cy)) / 1.5, 0, 1))

def arrowhead(a, rng, tip, direction, length=15, spread=38, th=None):
    th = th or T
    dx, dy = direction
    n = np.hypot(dx, dy); dx, dy = dx / n, dy / n
    for sgn in (1, -1):
        ang = np.deg2rad(180 + sgn * spread)
        bx = dx * np.cos(ang) - dy * np.sin(ang); by = dx * np.sin(ang) + dy * np.cos(ang)
        brush(a, line(tip, (tip[0] + bx * length, tip[1] + by * length), 10), th, rng, load0=1.0, dry=0.2, taper=(0.0, 0.3))

def _comment(scale=1.0, dx=0, dy=0):
    m = read_png_alpha(ICON_DIR / 'comment.png')
    if scale == 1.0 and dx == 0 and dy == 0: return m.copy()
    out = np.zeros_like(m)
    ys, xs = np.mgrid[0:S, 0:S].astype(float)
    sx = ((xs - dx) - 48) / scale + 48; sy = ((ys - dy) - 48) / scale + 48
    ok = (sx >= 0) & (sx < S - 1) & (sy >= 0) & (sy < S - 1)
    x0 = np.clip(sx.astype(int), 0, S - 2); y0 = np.clip(sy.astype(int), 0, S - 2)
    fx = sx - x0; fy = sy - y0
    v = (m[y0, x0] * (1 - fx) * (1 - fy) + m[y0, x0 + 1] * fx * (1 - fy) + m[y0 + 1, x0] * (1 - fx) * fy + m[y0 + 1, x0 + 1] * fx * fy)
    out[ok] = v[ok]
    return out

def _arc_dir(a0, a1):
    t = np.deg2rad(a1); s = 1 if a1 > a0 else -1
    return (-np.sin(t) * s, np.cos(t) * s)

def _seal(a, rng):
    disc(a, 48, 48, 37, rng, wob=0.04)

def _carve(a, fn, th):
    k = new(); fn(k, np.random.default_rng(21), th); erase(a, np.clip(k * 1.3, 0, 1))

def _tick(a, rng, th, k=1.0):
    brush(a, line((32, 50), (44, 62), 12), th, rng, load0=1.0, dry=0.0, taper=(0.3, 0.0))
    brush(a, curve([(44, 62), (54, 48), (66, 32)], 12), th, rng, load0=1.0, dry=0.3, taper=(0.0, 0.5))

def _bang(a, rng, th):
    brush(a, line((48, 24), (48, 56), 14), th * 1.1, rng, load0=1.0, dry=0.2, taper=(0.05, 0.4))
    disc(a, 48, 68, th * 1.2, rng)

def _slash(a, rng, th):
    brush(a, line((26, 26), (70, 70)), th, rng, load0=1.0, dry=0.25, taper=(0.06, 0.12))

def _box_row(a, rng, y, ticked=False, x1=86):
    brush(a, poly((10, y - 8), (26, y - 8), (26, y + 8), (10, y + 8), (10, y - 8), n=8), T * 0.6, rng, load0=1.0, dry=0.1, taper=(0.02, 0.02))
    if ticked:
        brush(a, line((12, y - 1), (18, y + 6), 8), T * 0.6, rng, load0=1.0, dry=0.0, taper=(0.2, 0))
        brush(a, line((18, y + 6), (30, y - 12), 10), T * 0.6, rng, load0=1.0, dry=0.3, taper=(0, 0.4))
    brush(a, line((38, y), (x1, y)), T * 0.85, rng, load0=1.0, dry=0.3, taper=(0.05, 0.15))

def _rot(pts, deg, c=(48, 48)):
    t = np.deg2rad(deg); cs, sn = np.cos(t), np.sin(t)
    return [(c[0] + (x - c[0]) * cs - (y - c[1]) * sn, c[1] + (x - c[0]) * sn + (y - c[1]) * cs) for x, y in pts]

def file_text(rng):
    """A sheet with its lower corner curling up, three lines written on it."""
    a = new()
    brush(a, poly((60, 86), (22, 86), (22, 10), (74, 10), (74, 66), n=20), T * 0.85, rng, load0=1.0, dry=0.15, taper=(0.02, 0.02))
    brush(a, curve([(74, 66), (70, 78), (60, 86)], 10), T * 0.8, rng, load0=1.0, dry=0.2, taper=(0.02, 0.05))
    brush(a, curve([(74, 66), (64, 70), (60, 86)], 10), T * 0.6, rng, load0=0.9, dry=0.2, taper=(0.05, 0.05))
    for y, x1 in ((30, 62), (44, 62), (58, 52)):
        brush(a, line((32, y), (x1, y), 16), T * 0.65, rng, load0=1.0, dry=0.35, taper=(0.06, 0.2))
    return a

def comment_plus(rng):
    a = _comment(0.82, -7, -7)
    clear_disc(a, 76, 76, 17)
    p = new(); plus_at(p, rng, 76, 76, 12)
    return a, p

def rotate(rng):
    """一笔回旋: a circle drawn backwards, its head at the end."""
    a = new()
    a0, a1 = 70, -200
    brush(a, arc(48, 50, 29, 29, a0, a1, 140), T, rng, load0=1.0, dry=0.3, taper=(0.04, 0.0))
    tip = (48 + 29 * np.cos(np.deg2rad(a1)), 50 + 29 * np.sin(np.deg2rad(a1)))
    arrowhead(a, rng, tip, _arc_dir(a0, a1), length=19, spread=42, th=T * 0.8)
    return a

def sort_rods(rng):
    """算筹: counting rods laid long to short."""
    a = new()
    for y, x1 in ((24, 84), (48, 64), (72, 42)):
        brush(a, line((12, y), (x1, y)), T * 1.05, rng, load0=1.0, dry=0.3, taper=(0.06, 0.12))
    return a

def status_done(rng): a = new(); _seal(a, rng); _carve(a, _tick, T * 0.95); return a

def status_warning(rng): a = new(); _seal(a, rng); _carve(a, _bang, T * 0.95); return a

def status_stopped(rng): a = new(); _seal(a, rng); _carve(a, _slash, T * 0.95); return a

def cloud(rng):
    """祥云: one stroke coils out from the curl's eye, runs round under it and
    trails off to the right as the tail; a second rises from the curl over
    two lobes. Neither crosses the other."""
    a = new()
    cx, cy = 30, 50
    th = np.deg2rad(np.linspace(630, 90, 140))          # inner eye → outer ring, ending at the bottom
    r = 4 + (16 - 4) * (630 - np.rad2deg(th)) / 540
    coil = [(cx + rr * np.cos(t), cy + rr * np.sin(t)) for rr, t in zip(r, th)]
    tail = curve([(cx, cy + 16), (48, 68), (66, 64), (80, 68), (92, 66)], 14)
    brush(a, coil + tail[1:], T * 0.95, rng, load0=1.0, dry=0.5, taper=(0.05, 0.4))
    lobes = [(cx + 2, cy - 12)] + arc(52, 40, 15, 15, 205, 335, 30) + arc(74, 54, 11, 11, 255, 395, 26)
    brush(a, lobes, T * 0.95, rng, load0=1.0, dry=0.3, taper=(0.15, 0.2))
    return a

def checklist(rng):
    a = new()
    _box_row(a, rng, 22, True); _box_row(a, rng, 48); _box_row(a, rng, 74, x1=70)
    return a

def checklist_plus(rng):
    a = new()
    _box_row(a, rng, 22, True); _box_row(a, rng, 48)
    brush(a, line((38, 74), (58, 74), 12), T * 0.85, rng, load0=1.0, dry=0.3, taper=(0.05, 0.15))
    plus_at(a, rng, 78, 74, 12)
    return a

def sticky_note(rng):
    """浮签: a slip tucked in at a slant, its top corner folded down."""
    a = new()
    brush(a, _rot(poly((50, 10), (32, 10), (32, 88), (64, 88), (64, 24), (50, 10), n=20), 14), T * 0.85, rng, load0=1.0, dry=0.15, taper=(0.02, 0.02))
    brush(a, _rot(poly((50, 11), (50, 24), (63, 24), n=10), 14), T * 0.6, rng, load0=0.9, dry=0.2, taper=(0.05, 0.05))
    brush(a, _rot(line((40, 40), (56, 40), 10), 14), T * 0.6, rng, load0=0.9, dry=0.3, taper=(0.05, 0.2))
    return a

def mic(rng):
    """竹筒: a length of bamboo, two nodes across it, in its holder."""
    a = new()
    brush(a, poly((36, 50), (36, 10), (60, 10), (60, 50), n=18) + arc(48, 50, 12, 12, 0, 180, 20)[::-1], T * 0.85, rng, load0=1.0, dry=0.15, taper=(0.02, 0.02))
    for y in (24, 38):
        brush(a, line((34, y), (62, y), 10), T * 0.6, rng, load0=0.9, dry=0.1, taper=(0.05, 0.05))
    brush(a, arc(48, 48, 22, 22, 0, 180, 40), T * 0.8, rng, load0=1.0, dry=0.25, taper=(0.04, 0.04))
    brush(a, line((48, 70), (48, 84), 8), T * 0.8, rng, load0=1.0, dry=0.1, taper=(0, 0))
    brush(a, line((34, 86), (62, 86), 12), T * 0.85, rng, load0=1.0, dry=0.2, taper=(0.05, 0.08))
    return a

def image(rng, plus=False):
    """月洞窗: a round moon window with hills in it."""
    a = new()
    cx, cy, r = (42, 42, 32) if plus else (48, 48, 36)
    brush(a, arc(cx, cy, r, r, -100, 265, 150), T * 0.9, rng, load0=1.0, dry=0.25, taper=(0.04, 0.1))
    clip = np.clip((r - 3 - np.hypot(XX - cx, YY - cy)) / 1.2, 0, 1)
    m = new()
    fill_poly(m, [(cx - r, cy + r), (cx - r, cy + 22), (cx - 12, cy + 8), (cx + 2, cy + 18), (cx + 14, cy + 2), (cx + r, cy + 24), (cx + r, cy + r)], rng, rough=0.7)
    np.maximum(a, m * clip, out=a)
    if plus:
        clear_disc(a, 78, 78, 18); plus_at(a, rng, 78, 78, 12)
    return a

def image_plus(rng): return image(rng, plus=True)

def eraser(rng):
    """拂尘: a whisk to sweep the grid clean — a short handle and long hair."""
    a = new()
    brush(a, line((84, 12), (58, 40)), T * 1.05, rng, load0=1.0, dry=0.1, taper=(0.03, 0.03))
    disc(a, 57, 41, 5, rng)
    for k, (ex, ey) in enumerate(((10, 70), (16, 84), (28, 90), (40, 92), (22, 60))):
        brush(a, curve([(56, 43), ((56 + ex) / 2 + 6, (43 + ey) / 2 - 4), (ex, ey)], 12), T * 0.72, rng,
              load0=0.95, dry=0.5, taper=(0.0, 0.6))
    return a

def share(rng):
    """风筝: a kite let out on the wind, its tail streaming behind."""
    a = new()
    pts = [(58, 6), (86, 32), (58, 62), (30, 32)]
    brush(a, pts + [pts[0]], T * 0.85, rng, load0=1.0, dry=0.15, taper=(0.02, 0.02))
    brush(a, line((58, 8), (58, 60), 16), T * 0.55, rng, load0=0.9, dry=0.2, taper=(0.03, 0.03))
    brush(a, line((32, 32), (84, 32), 16), T * 0.55, rng, load0=0.9, dry=0.2, taper=(0.03, 0.03))
    brush(a, curve([(58, 62), (48, 70), (40, 66), (30, 76), (20, 74), (10, 88)], 12), T * 0.7, rng, load0=1.0, dry=0.5, taper=(0.02, 0.5))
    return a

def layers(rng):
    """叠纸: three sheets laid one on another, seen at a slant."""
    a = new()
    for k, y in enumerate((22, 42, 62)):
        pts = [(48, y - 14), (86, y), (48, y + 14), (10, y)]
        if k == 0:
            brush(a, pts + [pts[0]], T * 0.8, rng, load0=1.0, dry=0.15, taper=(0.02, 0.02))
        else:
            brush(a, [(10, y - 2), (48, y + 14), (86, y - 2)], T * 0.8, rng, load0=1.0, dry=0.2, taper=(0.04, 0.04))
    return a

def branch(rng):
    """枝: a twig that forks, a bud on each end."""
    a = new()
    brush(a, curve([(28, 90), (32, 62), (30, 36), (26, 14)]), T, rng, load0=1.0, dry=0.3, taper=(0.04, 0.2))
    brush(a, curve([(31, 62), (48, 48), (64, 36), (72, 20)]), T * 0.9, rng, load0=1.0, dry=0.35, taper=(0.0, 0.25))
    disc(a, 26, 12, 6.5, rng); disc(a, 74, 17, 6.5, rng)
    return a

def view_grid(rng):
    """四印: four small square seals pressed in a grid."""
    a = new()
    for x in (14, 52):
        for y in (14, 52):
            fill_poly(a, _rot([(x, y), (x + 30, y), (x + 30, y + 30), (x, y + 30)], rng.uniform(-4, 4), (x + 15, y + 15)), rng, rough=0.7)
    return a

def view_list(rng):
    """三条: three solid bars."""
    a = new()
    for y in (16, 40, 64):
        fill_poly(a, _rot([(12, y), (84, y), (84, y + 16), (12, y + 16)], rng.uniform(-1.5, 1.5), (48, y + 8)), rng, rough=0.7)
    return a

def open_book(rng):
    """摊开的书: two pages open, a line on each."""
    a = new()
    brush(a, curve([(48, 26), (30, 18), (10, 22)], 14) + [(10, 76)] + curve([(10, 76), (30, 72), (48, 80)], 14), T * 0.85, rng, load0=1.0, dry=0.15, taper=(0.02, 0.02))
    brush(a, curve([(48, 26), (66, 18), (86, 22)], 14) + [(86, 76)] + curve([(86, 76), (66, 72), (48, 80)], 14), T * 0.85, rng, load0=1.0, dry=0.15, taper=(0.02, 0.02))
    brush(a, line((48, 27), (48, 79)), T * 0.6, rng, load0=0.9, dry=0.2, taper=(0.05, 0.05))
    for x0 in (20, 58):
        brush(a, line((x0, 42), (x0 + 18, 41), 10), T * 0.55, rng, load0=0.9, dry=0.3, taper=(0.05, 0.2))
        brush(a, line((x0, 56), (x0 + 14, 55), 10), T * 0.55, rng, load0=0.9, dry=0.3, taper=(0.05, 0.2))
    return a

def knots(rng):
    """结绳: a cord with knots tied along it — the oldest way to remember."""
    a = new()
    brush(a, curve([(48, 6), (52, 30), (46, 56), (50, 82)], 20), T * 0.75, rng, load0=1.0, dry=0.2, taper=(0.04, 0.05))
    for y, r in ((22, 7.5), (44, 8.5), (66, 7.0)):
        disc(a, 49 + (2 if y == 22 else -2 if y == 44 else 1), y, r, rng, wob=0.12)
    for dx in (-7, 0, 7):
        brush(a, line((50, 82), (50 + dx, 94), 6), T * 0.5, rng, load0=0.9, dry=0.5, taper=(0, 0.5))
    return a

def tea(rng):
    """茶尚温: a cup just set down, still steaming."""
    a = new()
    fill_poly(a, curve([(20, 52), (24, 76), (36, 86), (60, 86), (72, 76), (76, 52), (20, 52)], 10), rng, rough=0.7)
    brush(a, line((30, 90), (66, 90), 12), T * 0.7, rng, load0=1.0, dry=0.2, taper=(0.05, 0.05))
    for x0 in (38, 56):
        brush(a, curve([(x0, 44), (x0 - 5, 34), (x0 + 3, 24), (x0 - 2, 10)], 12), T * 0.6, rng, load0=0.85, dry=0.6, taper=(0.1, 0.6))
    return a

# name → (draw, seed). The seeds are the ones the author picked from.
ICONS = {
    "stones-triad": (stones_triad, 602), "brush-laid": (brush_laid, 606), "brush-lifted": (brush_lifted, 607),
    "sprout": (sprout, 610), "shikigami": (shikigami, 901),
    "lock-open": (lock_open, 616), "lock-shut": (lock_shut, 617), "plus": (plus, 622),
    "jizo": (jizo, 906), "enso": (enso, 628), "ink-disc": (ink_disc, 629), "taiji": (taiji, 630), "wen": (wen, 634),
    "dharma-wheel": (dharma_wheel, 639), "movable-type": (movable_type, 640), "case-dew": (case_dew, 902), "case-rise": (case_rise, 910),
    "books": (books, 646), "gate-in": (gate_in, 904), "gate-out": (gate_out, 905),
}
GLYPHS = {
    "close": (close, 1002), "arrow-back": (arrow_back, 1004), "chevron-down": (chevron_down, 1010),
    "check": (check, 1016), "minus": (minus, 1019), "loader": (loader, 1021), "trash": (trash, 1099), "edit": (edit, 1201),
    "search": (search, 1032), "copy": (copy, 1033), "stop": (stop, 1036),
    "folder": (folder, 1038), "folder-open": (folder_open, 1039), "folder-plus": (folder_plus, 1040),
}
OBJECTS = {
    "file-text": (file_text, 2003), "comment-plus": (comment_plus, 2004), "rotate": (rotate, 2006), "sort": (sort_rods, 2009),
    "status-done": (status_done, 2013), "status-warning": (status_warning, 2014), "status-stopped": (status_stopped, 2015),
    "cloud": (cloud, 2016), "checklist": (checklist, 2018), "checklist-plus": (checklist_plus, 2019),
    "sticky-note": (sticky_note, 2022), "mic": (mic, 2025), "image": (image, 2027), "image-plus": (image_plus, 2028),
    "eraser": (eraser, 2033), "share": (share, 2035), "layers": (layers, 2039), "branch": (branch, 2041),
    "view-grid": (view_grid, 2045), "view-list": (view_list, 2046), "open-book": (open_book, 2049), "knots": (knots, 2050), "tea": (tea, 2104),
}
masks = {}
for name, (draw, seed) in ICONS.items():
    rng = np.random.default_rng(seed)
    masks[name] = grain(draw(rng), rng)
for name, (draw, seed) in GLYPHS.items():
    rng = np.random.default_rng(seed)
    masks[name] = grain_fine(draw(rng), rng)
for name, (draw, seed) in OBJECTS.items():
    rng = np.random.default_rng(seed)
    out = draw(rng)
    if isinstance(out, tuple):          # a committed icon plus fresh strokes
        base, extra = out
        masks[name] = np.maximum(base, grain_fine(extra, rng))
    else:
        masks[name] = grain_fine(out, rng)
# A closed sidebar's crescent: the committed solid moon, its inside cleared.
def _blur(a, r):
    pad = np.pad(a, r, mode="edge"); h, w = a.shape; out = np.zeros_like(a)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out += pad[r + dy:r + dy + h, r + dx:r + dx + w]
    return out / (2 * r + 1) ** 2

def _erode(a, r):
    h, w = a.shape; pad = np.pad(a, r); out = a.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy <= r * r: out = np.minimum(out, pad[r + dy:r + dy + h, r + dx:r + dx + w])
    return out

def _dilate(a, r):
    h, w = a.shape; pad = np.pad(a, r); out = a.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy <= r * r: out = np.maximum(out, pad[r + dy:r + dy + h, r + dx:r + dx + w])
    return out

for seed, side in ((31, "left"), (32, "right")):
    solid = read_png_alpha(ICON_DIR / f"moon-{side}.png")
    # Keep a rim as thin and as light as the faint ring already drawn round
    # the moon's dark side: about 3px wide, at half the crescent's ink.
    inside = _blur(_erode((_blur(solid, 2) > 0.3).astype(float), 3), 1)
    rim = solid * (1 - inside)
    crescent = _blur(_dilate((_blur(solid, 2) > 0.55).astype(float), 1), 1)
    rim = np.where(crescent > 0.5, rim * 0.5, rim)
    # Then sand it the way that faint ring is sanded: loose grains of varied
    # weight on a light trace, not a smooth half-tone line.
    rng = np.random.default_rng(seed)
    body = solid > 0.55
    band = np.clip(rim / 0.45, 0, 1) * body
    grains = (rng.random(band.shape) < band * 0.42) * (0.55 + 0.4 * rng.random(band.shape))
    trace = band * (0.08 + 0.12 * rng.random(band.shape))
    masks[f"moon-{side}-hollow"] = np.where(body, np.maximum(grains, trace), rim)
# One stroke turned or mirrored, so every direction carries the same grain.
masks["arrow-forward"] = masks["arrow-back"][:, ::-1]
for k, name in ((1, "chevron-right"), (2, "chevron-up"), (3, "chevron-left")):
    masks[name] = np.rot90(masks["chevron-down"], k)
for name, a in masks.items():
    write_png(OUT / f"{name}.png", np.ascontiguousarray(a))
print(sorted(masks))
