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

## Where they came from

Exported on 2026-11-07, field for field, from the 0.1 client's
`SLOW_CLOCK` and `SHELF_BOOKS` (`src/dev-cli/seeds/showcase/`). 《慢钟》 is
its `SampleBook` object as JSON, laid out like the samples
(`crates/dr-samples/books/README.md` has the format).

From now on these files are the showcase's source for `next/`: edit them
here. The 0.1 client keeps its own copies until it is removed.
