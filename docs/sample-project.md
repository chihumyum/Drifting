# Built-in sample project

Status: **current behavior** of every build (desktop and Tauri iOS), from
migration `0015_library_state`; recipe `pride-and-prejudice-v1+a-q-zhengzhuan-v1`
(libraries that received `pride-and-prejudice-v1` keep their one sample).

A brand-new local library opens with two sample projects already on the
Bookshelf: **Pride and Prejudice (Sample)** and **阿Q正传（示例）**, the second
left half written so there is something to go on writing. No seed command is
needed: a fresh install, a fresh `pnpm dev` / `pnpm dev:worktree` profile and a
new `--instance` all get them on first launch. Each is an ordinary project —
edit it, rename it, move it to Recently Deleted or delete it permanently. A
deleted sample never comes back.

## 阿Q正传

Lu Xun's novella (1921–22), in nine chapters, as a book in progress: the first
six chapters carry the text, the last three (革命, 不准革命, 大团圆) are planned
chapters with a summary and no prose. Everything around the text was written
for the sample in Chinese and checked against the novel.

| Data | 阿Q正传（示例） |
| --- | --- |
| Chapters | 9 (`第一章 序` … `第九章 大团圆`): 1–6 with the 1948 text, about 13,500 characters; 7–9 planned; 1–4 marked finished |
| Acts | 2: 上 未庄 (1–6), 下 革命 (7–9) |
| Storylines | 4: 优胜记, 未庄的眼睛, 恋爱与生计, 革命 |
| Element categories / elements | 3 / 29: 15 people, 7 places, 7 objects and sayings (精神胜利法, 癞疮疤, 五条件 …) |
| Relation types / relations | 9 (本家, 冤家, 欺辱, 求爱, 雇佣, 买卖, 住在, 持有, 关键章节) / 32 |
| Narrative timeline | 4 pins, from 有一年的春天 to 宣统三年九月十四日 |
| Element patches | 4 (阿Q in chapters 3, 5 and 6; 小D in chapter 5) |
| Ideas (构想) | 3 |
| Comments / TODOs | 4 / 3; six anchored to passages, one on 假洋鬼子; one note resolved |
| Materials | 2 notes (the novella's publication, how 未庄 addresses people); no images |
| Plot grid | Chapter 4: 4 rows × 4 columns |
| Project facts / memory | Author, first publication, collection, form, narration, setting, state; one Project Memory note |

Names link in the chapters as for the other books, by form and without word
boundaries: 秀才 is 赵太爷's son except where it is a rank (变秀才, 不要秀才 …),
and 秀才娘子 and the title 阿Q正传 stay plain. 辫子 is an element no form links.

### Source and rights

`a-q/text.json` is built by `scripts/build-a-q-sample.py` from Wikisource's
transcription of the 1948 Complete Works (魯迅全集, volume one), rendered in
simplified characters by Wikisource. Only the chapter text is kept; quotation
marks become “” and ‘’, the variant 偸 becomes 偷, and seven transcription slips
are corrected (listed in the script). Lu Xun died in 1936; the text is in the
public domain in China and wherever the term is the author's life plus 70 years
or less, and, first published in 1921–22, in the United States. See
[ASSET_PROVENANCE.md](../ASSET_PROVENANCE.md#built-in-sample-book) and the
[file's README](../src/renderer/services/built-in-sample/a-q/README.md).

## Pride and Prejudice

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
  chapter into a ProseMirror document with a stable id on every block. Names
  are linked to their elements as an author would have linked them: every
  whole-word, case-sensitive occurrence of a form in `LINK_FORMS`, the longest
  form winning, so "Miss Darcy" is Georgiana, "Mrs. Bingley" is Jane and "the
  late Mr. Darcy", "Lady Anne Darcy", "Mary King" and the ambiguous "Miss
  Bennet" stay plain. Element ids are assigned before the chapters are built.
  The reference index projects the links on the first open (about 2,900
  mentions across the 61 chapters), which feeds backlinks and the Element
  overview.
- `showcase.ts` holds the curated workspace and `LINK_FORMS`; `a-q.ts` holds
  阿Q正传 whole (its text in `a-q/text.json`) as a `SampleBook`.
- `write-sample.ts` writes it in a few authored transactions
  (`withAtomicSyncTransaction`, the app's own sync identity):
  1. project summary and facts, Project Memory, categories, elements (facts,
     aliases), relation types and element relations, storylines, acts,
     timeline pins and ideas;
  2. the chapters, in change-sets of at most 320 KiB of Yjs state (five for
     this book with its links, about 1.5 MB in all), so a later Hosted upload
     never meets an oversized one; their storyline links are written as the
     Agent's membership write stores them, all rows then one projection per
     chapter;
  3. chapter relations, comments and TODOs, element patches, the finished
     status and the plot grid;
  4. the material folder, notes and illustrations, and the two portraits.
- `built-in-sample.ts` is the first-run workflow: it writes `BUILT_IN_SAMPLES`
  in order, Pride and Prejudice then 阿Q正传, each into its own project;
  `first-run.ts` is the small startup hook and the state the Bookshelf observes.

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

`write-sample.ts` takes the book as a `SampleBook` (`sample-book.ts`):
Pride and Prejudice unless another is given. 阿Q正传 and the
[release screenshot library](release-screenshots.md)'s other books are written
with it; `createEntityLinker` links Han names without word boundaries for them.
A planned chapter is one empty paragraph, as a new chapter opens.

The development seed (`pnpm dev:seed`, `pnpm dev:seed:lite`) is separate: it
stays the synthetic Chinese corpus in `services/sample-project/`, written
through the headless Agent tool path, and its evidence is unchanged.

## Once per library

`store/auth.ts` `checkSession()` opens the local library, emits `db:ready` and
starts the sample in the background. It never blocks startup; on desktop the
first-run welcome card usually covers the time it takes.

The device-local `library_state` table (never synced or journaled) holds the
`built-in-sample` marker:

| Status | Meaning | Next launch |
| --- | --- | --- |
| *(none)* | Never checked | Check the library |
| `skipped` | The library had a project (live or in the trash), a cloud account or a provider transition; or attempts ran out | Nothing |
| `creating` | Claimed together with each project row as it is created (`projectIds` lists them); not complete | Remove the partial projects, then retry |
| `failed` | Rolled back after an error | Retry while fewer than 3 attempts |
| `created` | Published once (with `projectIds` and `durationMs`) | Nothing, even after the samples are deleted |

The first check of any existing library records `skipped`, so a library that
was ever in use (including the author's own) is never given a sample later,
even if all its projects are deleted. A library that received Pride and
Prejudice alone (`pride-and-prejudice-v1`) is `created` and so does not get
阿Q正传 either. The first claim re-checks that no project exists inside the
transaction that creates Pride and Prejudice's project row; 阿Q正传's row and
the updated claim commit together after Pride and Prejudice is written.

While the samples are being written, the Bookshelf hides both unfinished
projects, shows a placeholder card and holds **New book**. Both land or neither
does: a failure in any transaction or import of either book removes every
partial project (rows already committed included, Pride and Prejudice when
阿Q正传 fails) and its asset files, logs a warning and leaves the shelf as it
was. On the first-run shelf both cards land and wait until one of them is
opened.

## Cost

Measured on 2026-10-31 on an Apple Silicon Mac with fresh isolated profiles
(`durationMs` and `steps` in the marker, from the claim to the last commit):

| Build | Time | Steps (ms) |
| --- | --- | --- |
| Node integration test (in-process SQLite) | 0.65 s, 4,180 SQL statements | outline about 1,800 statements (with the illustration receipts), chapters 1,889, review 313, materials 112 |
| Debug (`pnpm dev:worktree`, Vite dev server, debug Rust) | 6.4 s | claim 67, outline 2,171, chapters 3,346, review 436, materials 188 |
| `--release-perf` (release Rust, production bundle) | 4.0 s | claim 65, outline 1,001, chapters 2,301, review 365, materials 192 |
| Debug, with the chapter links (window behind others, page hidden) | 7.1 s | claim 76, outline 2,507, chapters 3,855, review 401, materials 197 |

The window was in front and nothing else was running for the first two app
rows, measured before the chapters carried links; the links add about 0.65 MB
of Yjs state and two chapter change-sets. The last row was measured in the
background, so it overstates the cost of the links.
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
A_Q_WIKISOURCE_JSON=<a-q.json> pnpm exec vitest run src/renderer/services/built-in-sample/a-q.test.ts
```

By default a new library gets both samples: 阿Q正传's nine chapters (six whose
live prose equals the bundled text, three empty and planned, the first four
finished), two acts, its storylines, elements, relations, pins, ideas,
comments and patches anchored to the live prose, material notes and no assets,
with names linked in the chapters; the marker lists both projects. If 阿Q正传
fails after Pride and Prejudice is written, both are removed and a later launch
writes both; an interrupted two-book attempt leaves nothing behind. 阿Q正传's
content test checks the chapters, spot-checked paragraphs and the corrected
readings, that every quotation anchors once in a written chapter, that names,
relations and link forms are valid, and how 秀才 links; with
`A_Q_WIKISOURCE_JSON` it rebuilds `text.json` from the source and compares it
byte for byte. The other cases below run with Pride and Prejudice alone.

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
