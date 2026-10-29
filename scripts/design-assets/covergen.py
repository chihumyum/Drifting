"""Covers for sand drawn under text in the prose editor.

An inline span (an entity link, an Agent insertion or deletion) can only be
drawn once per line fragment through its background, and a background image
cannot be tinted by CSS. So the colour comes from a plain CSS band and these
covers lie over it: opaque everywhere except where the grains are, white for
the light theme and black for the dark. The span blends with the page
(`darken` in light, `lighten` in dark), so the cover itself vanishes and only
the band showing through the grains is left, in any colour CSS gives it.

Reads the committed `sand/ul.png` and `sand/hl.png` and writes, beside the
output directory given:

- `ul-cover.png`, `ul-cover-dark.png`: the dry underline (a link, a strike);
- `ul-loose-cover.png`, `ul-loose-cover-dark.png`: only scattered grains of
  the underline (the dotted link band), five strokes wide and tiling sideways;
- `hl-loose-cover.png`, `hl-loose-cover-dark.png`: only scattered grains of
  the highlight swash (sand not yet pressed down: an Agent change waiting for
  the author), three strokes wide and tiling sideways.

    python3 covergen.py out/
"""
import struct
import sys
import zlib
from pathlib import Path

import numpy as np

SAND = Path(__file__).resolve().parents[2] / "src/assets/design/sand"
OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)


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


def loose(alpha, css_height, seed, periods, pitch=3.4, keep=0.58, radius=(0.5, 0.55)):
    """Scattered grains under the stroke's vertical profile, periodic sideways.

    The strip is `periods` times the stroke's width, so one line of prose rarely
    needs a second tile. `pitch` and `radius` are CSS px at the stroke's natural
    height (it is drawn at that height and tiled, never stretched), so every
    grain stays round."""
    h, w = alpha.shape
    w *= periods
    scale = h / css_height
    middle = alpha[:, alpha.shape[1] // 6: alpha.shape[1] - alpha.shape[1] // 6]
    profile = middle.mean(axis=1)
    profile = np.clip(profile / profile.max(), 0, 1) * 0.92
    rng = np.random.default_rng(seed)
    step = pitch * scale
    cols = max(1, round(w / step))
    step_x = w / cols
    # One column of padding each side so grains crossing the seam wrap round.
    pad = int(np.ceil(step_x + (radius[0] + radius[1]) * scale + 2))
    grains = np.zeros((h, w + 2 * pad))
    y = step / 2
    while y < h:
        for i in range(cols):
            if rng.random() >= keep:
                continue
            cx = (i + 0.5) * step_x + (rng.random() - 0.5) * step_x * 0.8 + pad
            cy = y + (rng.random() - 0.5) * step * 0.8
            r = (radius[0] + rng.random() * radius[1]) * scale
            x0, x1 = int(cx - r - 2), int(cx + r + 3)
            y0, y1 = max(0, int(cy - r - 2)), min(h, int(cy + r + 3))
            ys, xs = np.mgrid[y0:y1, x0:x1]
            d = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
            grains[y0:y1, x0:x1] = np.maximum(grains[y0:y1, x0:x1], np.clip(r + 0.5 - d, 0, 1))
        y += step
    strip = grains[:, pad:pad + w].copy()
    strip[:, :pad] = np.maximum(strip[:, :pad], grains[:, pad + w:])
    strip[:, w - pad:] = np.maximum(strip[:, w - pad:], grains[:, :pad])
    return strip * profile[:, None]


def cover(alpha, rgb):
    rgba = np.zeros(alpha.shape + (4,), dtype=np.uint8)
    rgba[..., :3] = rgb
    rgba[..., 3] = np.clip((1 - alpha) * 255, 0, 255).astype(np.uint8)
    return rgba


underline = read_alpha(SAND / "ul.png")
swash = read_alpha(SAND / "hl.png")
shapes = {
    "ul": underline,
    "ul-loose": loose(underline, 7, 4021, 5, pitch=2.6, keep=0.55, radius=(0.5, 0.5)),
    "hl-loose": loose(swash, 26, 1187, 3),
}
for name, alpha in shapes.items():
    write_png(OUT / f"{name}-cover.png", cover(alpha, (255, 255, 255)))
    write_png(OUT / f"{name}-cover-dark.png", cover(alpha, (0, 0, 0)))
