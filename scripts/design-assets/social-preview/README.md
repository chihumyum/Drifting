# Social preview

The card shown when the repository is shared (GitHub's social preview; the
same image can serve as a site's `og:image`). The chosen variant is `dark.png`.

```sh
scripts/design-assets/social-preview/render.sh            # writes out/social-preview/
scripts/design-assets/social-preview/render.sh /tmp/card  # or another directory
```

It renders `dark`, `dark-frame`, `light` and `light-frame` at 2560×1280 (2:1,
about 0.6 MB each, under GitHub's 1 MB limit) with headless Chrome. It needs
`pnpm install` for the Newsreader files and Times New Roman from the system.
Upload by hand: repository Settings → General → Social preview → Edit.
Open `preview.html?theme=dark&frame=1` through any local server to look at
one variant in a browser.

What is on the card, and why:

- **The character sea** (`char-sea-frame.js`): one still frame of
  `src/renderer/lib/char-sea`, laid out as its fragment shader lays the cells.
  The cells are 1.9 times denser than the app's, so the word still reads when
  the card is shown at half size.
- **The word** rises the way the loading word does: an old serif (Times New
  Roman bold), in capitals, held up by each water cell's share of its ink. The
  cells it lifts surface, swell and take the accent; there is no drawn outline.
- **The rain** is one frame of the loading rain lighting the cells' own
  letters. A drop is two columns wide (one in four, three), so on the denser
  sea it is as wide as on the app's own columns. No rain falls on the tagline.
- **The tagline** (`sand-letters.js`) is written letter by letter: each glyph
  of Times New Roman is thinned to a skeleton, traced into strokes, and each
  stroke is laid with `brushicons.py`'s dry brush and grained the same way. Every
  letter has its own seed and a slight tilt. `letterMark` is exported: the
  site's wordmark (`landing/wordmark.sh`) is written with it. It names a kind of product, not a
  competitor.

Seeds are fixed, so a rerun reproduces the same pixels.
