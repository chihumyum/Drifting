#!/usr/bin/env python3
"""Shrinks the gallery's screenshots for the docs: 256 colours, dithered.

The gallery's --capture writes full-colour PNGs (about 300 KB each); a UI of
flat colours and thin glass keeps its look at 256 colours, about a third of
the size. Needs Pillow.

    python3 crates/dr-ui/script/shrink-pngs.py ../docs/rust-rewrite/foundations/f5
"""

import pathlib
import sys

from PIL import Image

for path in sorted(pathlib.Path(sys.argv[1]).glob("*.png")):
    before = path.stat().st_size
    image = Image.open(path).convert("RGB")
    image = image.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    image.save(path, optimize=True)
    print(f"{path.name}: {before // 1024} KB -> {path.stat().st_size // 1024} KB")
