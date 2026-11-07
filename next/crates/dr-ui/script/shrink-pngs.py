#!/usr/bin/env python3
"""Shrinks the gallery's screenshots for the docs: 256 colours.

The gallery's --capture writes full-colour PNGs (about 300 KB each); a UI of
flat colours and thin glass keeps its look at 256 colours, about a fifth of
the size. Needs Pillow.

The palette comes from an octree, not median cut: median cut spends nearly
every entry on the greys of the desk and the paper and folds the storyline
colours (a purple, a green, a yellow mark a few pixels wide) into one blue.
Dithering is left off; it triples the size and the octree palette shows no
banding on these pictures.

    python3 crates/dr-ui/script/shrink-pngs.py ../docs/rust-rewrite/foundations/f5
"""

import pathlib
import sys

from PIL import Image

for path in sorted(pathlib.Path(sys.argv[1]).glob("*.png")):
    before = path.stat().st_size
    image = Image.open(path).convert("RGB")
    image = image.quantize(colors=256, method=Image.Quantize.FASTOCTREE)
    image.save(path, optimize=True)
    print(f"{path.name}: {before // 1024} KB -> {path.stat().st_size // 1024} KB")
