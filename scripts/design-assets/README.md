# Design assets: sand and glass masks

The PNGs in `src/assets/design/` are procedurally generated alpha masks:
white with an alpha channel, tinted in CSS through `mask-image`. They carry no
colour of their own, so one mask serves every theme and accent.

| Output | Script | Notes |
| --- | --- | --- |
| `glass-thick.png` | `glassgen.py` | Tileable thickness of uneven glass; masks the glass rim and flowing hairlines. |
| `sand/hl.png`, `sand/ul.png` | `gen.py` | Dry highlight swash and dry underline. |
| `sand/blob-0..5.png`, `sand/frame.png` | `protogen.py` | Round seals and the cell frame (loaded where it starts, drier as it goes round). |
| `sand/frame-tile.png` | `protogen.py` `frame(w=180, h=60, inset=4, thick=2.7, seed=11)` | Frame for compact-index tiles. |
| `sand/frame-box.png` | `glyphgen.py` `frame_box()` | Nine-sliced frame for element categories. |
| `sand/mark-*.png` | `glyphgen.py` | Kind marks: dash, square, corner, spiral, wave, slip, star. |
| `sand/*-hollow.png` | `hollowgen.py` | Hollow kind marks for preview tabs, derived from the solid marks above (run it after them). |
| `icons/split.png` | `glyphgen.py` `icon_split()` | Sidebar split button (a pair of hanging scrolls). |
| `icons/stones-triad.png` … `icons/gate-out.png`, `icons/close.png` … `icons/folder-plus.png` | `brushicons.py` | Chapter end (⁂ and its three actions), dock lock and new, user menu, and the small action glyphs (close, arrows, chevrons, check, minus, loader, trash, edit, search, copy, stop, folder) and the object and state icons (file, comment-plus, status seals, cloud, checklist, image and the rest), which get finer grain. `comment-plus` is composited onto the committed `comment.png`. The docstring lists each icon; seeds are the ones the author picked. |
| `icons/*.png` (others) | drawn with the same brush in a design session | Committed as source; regenerate by hand if changed. |

Each script takes an output directory: `python3 glyphgen.py out/`. They need
NumPy and write every mask they define (`hollowgen.py` instead reads the sand
directory and writes beside it); copy the ones listed above into
`src/assets/design/`. Seeds are fixed, so a rerun reproduces the same pixels.
