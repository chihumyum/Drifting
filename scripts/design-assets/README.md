# Design assets: sand and glass masks

The PNGs in `src/assets/design/` are procedurally generated alpha masks:
white with an alpha channel, tinted in CSS through `mask-image`. They carry no
colour of their own, so one mask serves every theme and accent (the two
tinted highlight swashes below are the one exception).

| Output | Script | Notes |
| --- | --- | --- |
| `glass-thick.png` | `glassgen.py` | Tileable thickness of uneven glass; masks the glass rim and flowing hairlines. |
| `sand/hl.png`, `sand/ul.png` | `gen.py` | Dry highlight swash and dry underline. |
| `sand/hl-mark.png`, `sand/hl-mark-dark.png` | `markgen.py` | The highlight swash tinted for highlighted text in notes (light and dark theme). The one exception to colourless masks: a highlight runs over several lines, and only a background image is drawn once per line fragment, so it cannot be a mask tinted in CSS. Run after `gen.py`; it reads the committed `hl.png`. |
| `sand/blob-0..5.png` | `protogen.py` | Round seals. The frame round a selected cell is not an asset: `src/renderer/lib/sand-frame.ts` draws it for each cell's size. |
| `sand/frame-box.png` | `glyphgen.py` `frame_box()` | Nine-sliced frame for element categories. |
| `sand/mark-*.png` | `glyphgen.py` | Kind marks: dash, square, corner, spiral, wave, slip, star. |
| `sand/*-hollow.png` | `hollowgen.py` | Hollow kind marks for preview tabs, derived from the solid marks above (run it after them). |
| `icons/split.png` | `glyphgen.py` `icon_split()` | Sidebar split button (a pair of hanging scrolls). |
| `icons/stones-triad.png` … `icons/gate-out.png`, `icons/close.png` … `icons/folder-plus.png` | `brushicons.py` | Chapter end (⁂ and its three actions), dock lock and new, user menu, and the small action glyphs (close, arrows, chevrons, check, minus, loader, trash, edit, search, copy, stop, folder) the object and state icons (file, comment-plus, status seals, cloud, checklist, image and the rest), and the icons that replaced characters standing in for icons (arrows turned down and askew, both-ways, swap, the bound booklet, the task boxes, the name seal, the inkstone, the grip, the hook) and the Agent composer's send and steer (`lift`, `lift-bent`, a weight heavier), which get finer grain. `thinking.png` is a strip of six frames side by side that CSS steps through. `comment-plus` is composited onto the committed `comment.png`, `new-category` pastes the committed `sand/mark-corner.png`, and `moon-left-hollow` / `moon-right-hollow` are cleared out of the committed solid moons. The docstring lists each icon; seeds are the ones the author picked. |
| `icons/*.png` (others) | drawn with the same brush in a design session | Committed as source; regenerate by hand if changed. |

Each script takes an output directory: `python3 glyphgen.py out/`. They need
NumPy and write every mask they define (`hollowgen.py` instead reads the sand
directory and writes beside it); copy the ones listed above into
`src/assets/design/`. Seeds are fixed, so a rerun reproduces the same pixels.
