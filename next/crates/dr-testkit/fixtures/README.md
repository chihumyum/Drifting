# dr-testkit fixtures

The showcase's books the seed lays out (`src/samples.rs`). The two built-in
samples, *Pride and Prejudice* and 《阿Q正传》, live in
`crates/dr-samples/books/` (with their rights) since the product writes
them; `dr_testkit::samples` lays them out through dr-samples.

| File | What | Rights |
| --- | --- | --- |
| `slow-clock.json` | 《慢钟》, an original novel in progress written for the release screenshots | Written for Drifting, AGPL-3.0-or-later |
| `shelf.json` | The screenshot shelf: titles, genres, summaries, storylines, people and places of the other books (their text is generated) | Written for Drifting, AGPL-3.0-or-later |

Editions, sources and what was taken are recorded in the repository's
`ASSET_PROVENANCE.md` ("README screenshots").

## media/

Two synthetic pictures for HEIC and AVIF materials (`src/media.rs`,
`media::HEIC` and `media::AVIF`). Writing these formats needs a system
encoder, so unlike the rest of `media` they are not made by code at test
time. Both are the pixels of `media::quadrants(600, 400)` (four solid
quadrants, nothing else), saved as an 8-bit RGB PNG and encoded on
2026-11-21 on macOS 27.0.1:

| File | Command | Rights |
| --- | --- | --- |
| `media/quadrants.heic` (726 bytes) | `sips -s format heic quadrants.png --out quadrants.heic` | Made for Drifting, AGPL-3.0-or-later |
| `media/quadrants.avif` (631 bytes) | `sips -s format avif quadrants.png --out quadrants.avif` | Made for Drifting, AGPL-3.0-or-later |

dr-platform's `tests/image_codec.rs` reads them by path.

## Where they came from

Exported on 2026-11-07, field for field, from the 0.1 client's
`SLOW_CLOCK` and `SHELF_BOOKS` (`src/dev-cli/seeds/showcase/`). 《慢钟》 is
its `SampleBook` object as JSON, laid out like the samples
(`crates/dr-samples/books/README.md` has the format).

From now on these files are the showcase's source for `next/`: edit them
here. The 0.1 client keeps its own copies until it is removed.
