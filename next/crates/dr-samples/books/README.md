# dr-samples books

The two built-in sample books a new library receives (`src/layout.rs` lays
them out, `src/built_in.rs` writes them once). Text only: the illustrations
are listed by name in `pride-and-prejudice.json` but their image files stay
in the 0.1 client until stage 7 moves them.

| File | What | Rights |
| --- | --- | --- |
| `pride-and-prejudice.json` | Jane Austen, *Pride and Prejudice* (1813), 61 chapters; and the 0.1 built-in sample's notes around it | Text public domain; notes written for Drifting, AGPL-3.0-or-later |
| `a-q.json` | 鲁迅《阿Q正传》 (1921–22), chapters one to six; three planned chapters; the sample's notes | Text public domain; notes written for Drifting, AGPL-3.0-or-later |

Editions, sources and what was taken are recorded in the repository's
`ASSET_PROVENANCE.md` ("Built-in sample book").

## Where they came from

Exported on 2026-11-07, field for field, from the 0.1 client's sample
definitions `PRIDE_AND_PREJUDICE` and `A_Q_ZHENGZHUAN`
(`src/renderer/services/built-in-sample/`). Each book is its `SampleBook`
object as JSON, with `chapterTitle(n)` evaluated into `chapterTitles`,
chapters reduced to their blocks (a string is a paragraph, an array of
strings a letter set off as a block quote; `*…*` marks italics) and
illustrations reduced to their metadata.

From now on these files are the samples' source for `next/`: edit them here.
They moved here from `dr-testkit/fixtures/` so the product can write them;
dr-testkit lays them out through this crate. The 0.1 client keeps its own
copies until it is removed.
