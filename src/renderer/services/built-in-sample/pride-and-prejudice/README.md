# Pride and Prejudice: bundled text and illustrations

The [built-in sample project](../../../../../docs/sample-project.md) takes
apart Jane Austen's *Pride and Prejudice* (first published 1813). These files
are generated from an EPUB transcription of the George Allen edition of 1894,
illustrated by Hugh Thomson, by `scripts/build-sample-book.py`. Do not edit
them by hand.

- `text.json`: the 61 chapters in the edition's continuous numbering
  (Volume I is chapters 1–23, Volume II 24–42, Volume III 43–61). Paragraphs,
  italics, line breaks and the letters set off as block quotes are kept as
  printed. Each chapter's drop cap and capitalised first word are returned to
  normal case ("IT is a truth" becomes "It is a truth"). Page numbers,
  illustrations, chapter heading art, the preface, front matter and the
  printer's imprint are not included, and neither is anything added by the
  digital edition (its header, footer, license or name).
- `*.jpg`: five of Thomson's plates as image materials and two crops used as
  element portraits (Elizabeth from "She is tolerable", Darcy from "Hearing
  herself called"). Two plates are cropped above the publisher's 1894
  copyright line. Each file is greyscale JPEG with embedded metadata removed;
  the source bytes double as the display variant, and `*.thumbnail.jpg` is the
  thumbnail variant.
- `manifest.json`: SHA-256, size and dimensions of every file. The app checks
  each illustration against it before importing it.

Austen died in 1817, Thomson in 1920 and the 1894 edition was published more
than a century ago, so the text and the illustrations are in the public domain.
Sources and the public-domain basis are recorded in
[ASSET_PROVENANCE.md](../../../../../ASSET_PROVENANCE.md).

To rebuild, with the EPUB at hand (macOS; uses `sips`):

```bash
python3 -I scripts/build-sample-book.py <pride-and-prejudice.epub>
SAMPLE_BOOK_EPUB=<pride-and-prejudice.epub> pnpm exec vitest run src/renderer/services/built-in-sample/pride-and-prejudice.test.ts
```

The second command rebuilds into a temporary directory and checks that every
file here is byte-identical.
