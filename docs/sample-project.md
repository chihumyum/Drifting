# Built-in sample project

Status: **current behavior** of every build (desktop and Tauri iOS), from
migration `0015_library_state`; recipe `pride-and-prejudice-v1`.

A brand-new local library opens with one sample project, **Pride and Prejudice
(Sample)**, already on the Bookshelf. No seed command is needed: a fresh
install, a fresh `pnpm dev` / `pnpm dev:worktree` profile and a new
`--instance` all get it on first launch. It is an ordinary project — edit it,
rename it, move it to Recently Deleted or delete it permanently. A deleted
sample never comes back.

## Content

Jane Austen's novel, taken apart as an author would set it up in Drifting. The
text is the real book; everything around it was written for the sample in
English (whatever the interface language) and checked against the novel.

| Data | Built-in sample |
| --- | --- |
| Chapters | 61 (`Chapter I` … `Chapter LXI`), about 122,000 words, each with a one-line summary; Chapter I is marked finished |
| Acts | 3: Volume I (chapters 1–23), Volume II (24–42), Volume III (43–61) |
| Storylines | 4: Elizabeth & Darcy, Jane & Bingley, Lydia & Wickham, Charlotte & Collins; every chapter has a primary lane |
| Element categories / elements | 3 / 31: 18 characters, 9 places, 4 objects & lore, with aliases, facts and short bodies; Elizabeth and Darcy have portraits |
| Relation types / relations | 8 (Family, Courtship, Friendship, Rivalry, Patronage, Deception, Lives at, Key scene) / 37 |
| Narrative timeline | Chapters placed in reading order; 7 pins from "Sept 1811 · Netherfield is let" to "Autumn 1812 · Bingley returns" |
| Element patches | 4, each anchored to the passage that changes the element (Elizabeth, ch. XXXVI; Wickham, ch. XXXV; Darcy, ch. XLIII; Charlotte, ch. XXII) |
| Ideas (构想) | 5 loose notes (First Impressions, the letter as hinge, which year, …) |
| Comments / TODOs | 3 / 3; five anchored to passages, one on Wickham; one of each resolved |
| Materials | 2 notes (The entail, explained; Money and rank) and 5 Hugh Thomson illustrations in one folder |
| Plot grid | Chapter XVIII (the Netherfield ball): 4 rows × 4 columns |
| Project facts / memory | Author, publication, working title, point of view, setting, edition; one Project Memory note |

The text keeps the 1894 edition's paragraphs, italics, line breaks and letters
(set as block quotes). Quotations used by comments and patches are verbatim and
anchored to exact block offsets, as an editor selection records them. The
timeline assumes 1811–12 (Austen gives no year; her November weekdays fit 1811)
and uses months or seasons rather than days.

### Source and rights

The text and illustrations come from an EPUB transcription of the George Allen
edition of 1894, illustrated by Hugh Thomson. Austen (d. 1817), Thomson
(d. 1920) and the 1894 edition are in the public domain. Only the 61 chapters
and seven images are bundled; the digital edition's header, footer, license and
every mention of its name are removed, so its trademark license does not
apply. See [ASSET_PROVENANCE.md](../ASSET_PROVENANCE.md#built-in-sample-book)
and the [files' README](../src/renderer/services/built-in-sample/pride-and-prejudice/README.md).

Bundled size: `text.json` 698,454 bytes (lazy-loaded with the sample code, not
part of startup) and 683,638 bytes of greyscale JPEG (five plates at 760 px and
two portrait crops, each with a thumbnail; the source doubles as the display
variant). The synthetic seed assets the old sample used are no longer in the
renderer bundle.

## How it is written

`services/built-in-sample/`:

- `book.ts` reads the generated files in `pride-and-prejudice/` and turns each
  chapter into a ProseMirror document with a stable id on every block.
- `showcase.ts` holds the curated workspace.
- `write-sample.ts` writes it in a few authored transactions
  (`withAtomicSyncTransaction`, the app's own sync identity):
  1. project summary and facts, Project Memory, categories, elements (facts,
     aliases), relation types and element relations, storylines, acts,
     timeline pins and ideas;
  2. the chapters, in change-sets of at most 320 KiB of Yjs state (three for
     this book, the largest change-set about 350 KB), so a later Hosted upload
     never meets an oversized one; their storyline links are written as the
     Agent's membership write stores them, all rows then one projection per
     chapter;
  3. chapter relations, comments and TODOs, element patches, the finished
     status and the plot grid;
  4. the material folder, notes and illustrations, and the two portraits.
- `built-in-sample.ts` is the first-run workflow; `first-run.ts` is the small
  startup hook and the state the Bookshelf observes.

Each object goes through the same repositories and journal calls as the
author's own action or the General Agent's write tool for it (for example
`useBookNode.createNode`, `create_element`, `useComment` selection comments,
`createElementPatchWithSync`, `applyPlotGridMutationsInTransaction`); only the
batching differs. Chapter, idea, element, category and storyline prose becomes
live Yjs state through `createYjsProseSeedState` and
`appendAuthoredProseSeedInTransaction`, the seed path chapter creation and
import use; `contentJson` is only its cache. Material notes are stored as their
`bodyJson` seed, as the app creates notes. Illustrations are verified against
`manifest.json`, written to the native asset store with their prebuilt
variants and registered with a verified local blob receipt before they are
bound. The imports run alongside the first transactions. No Agent runtime rows
are written and no model is called.

The development seed (`pnpm dev:seed`, `pnpm dev:seed:lite`) is separate: it
stays the synthetic Chinese corpus in `services/sample-project/`, written
through the headless Agent tool path, and its evidence is unchanged.

## Once per library

`store/auth.ts` `checkSession()` opens the local library, emits `db:ready` and
starts the sample in the background. It never blocks startup; on desktop the
first-run welcome dialog usually covers the time it takes.

The device-local `library_state` table (never synced or journaled) holds the
`built-in-sample` marker:

| Status | Meaning | Next launch |
| --- | --- | --- |
| *(none)* | Never checked | Check the library |
| `skipped` | The library had a project (live or in the trash), a cloud account or a provider transition; or attempts ran out | Nothing |
| `creating` | Claimed together with the empty project row; not complete | Remove the partial project, then retry |
| `failed` | Rolled back after an error | Retry while fewer than 3 attempts |
| `created` | Published once (with `durationMs`) | Nothing, even after the sample is deleted |

The first check of any existing library records `skipped`, so a library that
was ever in use (including the author's own) is never given a sample later,
even if all its projects are deleted. The claim re-checks that no project
exists inside the transaction that creates the sample's project row.

While the sample is being written, the Bookshelf hides its unfinished project,
shows a placeholder card and holds **New book**. A failure in any transaction
or import removes the partial project (rows already committed included) and
its asset files, logs a warning and leaves the shelf as it was.

## Cost

Measured on 2026-10-31 on an Apple Silicon Mac with fresh isolated profiles
(`durationMs` and `steps` in the marker, from the claim to the last commit):

| Build | Time | Steps (ms) |
| --- | --- | --- |
| Node integration test (in-process SQLite) | 0.65 s, 4,180 SQL statements | outline about 1,800 statements (with the illustration receipts), chapters 1,889, review 313, materials 112 |
| Debug (`pnpm dev:worktree`, Vite dev server, debug Rust) | 6.4 s | claim 67, outline 2,171, chapters 3,346, review 436, materials 188 |
| `--release-perf` (release Rust, production bundle) | 4.0 s | claim 65, outline 1,001, chapters 2,301, review 365, materials 192 |

The window was in front and nothing else was running for the two app rows.
Each SQL statement is one call over the native gateway, so the time is almost
all statement count; most statements are the journal and Yjs bookkeeping each
new entity needs (about 15 per prose document, 104 documents). Preparing the 61
chapters' documents and Yjs seeds takes about 0.2 s and overlaps the outline
transaction; the illustration imports overlap it too. The previous sample (one
Agent tool call per object) took about 28 s with `--release-perf`.

## Hosted

The sample is created at local library initialization, before any Hosted
connect. `connectHostedFromProduct()` waits for an in-flight sample, so a
half-written sample is never published. A library that is connecting or
connected to an account, or has a provider account, does not get a sample.
Signing in afterwards uploads the finished sample like any local project; a
second fresh device that signs in to the same account brings its own sample,
so the account can hold two copies (an open question, see below).

## Acceptance

```bash
pnpm exec vitest run src/renderer/services/built-in-sample
SAMPLE_BOOK_EPUB=<pride-and-prejudice.epub> pnpm exec vitest run src/renderer/services/built-in-sample/pride-and-prejudice.test.ts
```

The integration test writes into real migrated SQLite libraries: an empty
library gets exactly one sample (61 chapters whose live Yjs prose equals the
bundled text paragraph by paragraph, three volumes, storylines, elements,
relations, pins, patches, comments, plot grid, materials, verified asset
receipts, bounded change-sets, no foreign-key violations and no Agent runtime
rows); comment and patch anchors match the live prose exactly; a second launch
and a deleted sample are left alone; libraries with projects (including only
trashed ones) or a cloud connection are untouched; a failed import and a failed
later transaction both roll back completely and are retried; an interrupted
attempt is cleaned up; repeated failures stop; and the startup hook never
rejects. The content test checks the 61 chapters, spot-checked passages, the
manifest hashes and size budget, that no bundled file mentions the digital
library, that every quotation anchors once, and that names and relations are
valid; with `SAMPLE_BOOK_EPUB` it rebuilds every file from the EPUB and
compares them byte for byte.

Desktop acceptance (2026-10-31, fresh `--instance` profiles with the frontend
debug bridge, no model keys): the Bookshelf shows the sample card; Project
Home counts 61 chapters, 4 storylines, 31 elements and the three volumes; the
chapter editor renders the text with italics and letters; Chapter I shows its
comment in Review and the finished state; Chapter XVIII's plot grid opens; the
Elizabeth element shows its portrait, facts, nine relations and its patch; the
narrative timeline places all 61 chapters and the seven pins; materials show
the illustrations (display variant) and the notes. The bridge has no
screenshots, so visual layout was not judged.

Open question: whether a Hosted sign-in on a fresh device should drop an
untouched sample instead of uploading it.
