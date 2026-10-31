# Manuscript export (EPUB, PDF, Word)

Status: **current desktop feature** (2026-10-31). The book, or chosen chapters,
leaves Drifting as a finished manuscript a reader, an editor or a printer can
open. It is not a backup ([`.drifting` library backup](library-backup.md)) and
not the readable project archive ([relational Markdown](local-data-export.md)).

## Where it opens

- **Read whole book** → three-dot menu → **Export manuscript** (导出成稿): the
  whole book is preselected.
- A chapter's three-dot menu → **Export manuscript**: "Selected chapters" starts
  with that chapter.

The dialog uses the shared dialog shell: a mono label over each section, no
frames. Its sections are

| Section | Controls |
| --- | --- |
| Format | EPUB / PDF / Word (`GlassSlider`) |
| Scope | Whole book / Selected chapters; the chapter list (whole-row toggles grouped under their acts, select all/none) folds open under the slider |
| Contents | Act titles (only when the book has acts), chapter titles, beat and note headings (`Switch`) |
| Book details | Title (defaults to the project name), author, optional cover image |

The author name is remembered on this device for every book; format, the three
switches and an edited title are remembered per project (browser storage,
never synced, never required). Export first asks where to save, then lays the
file out natively and writes it; cancelling the save dialog is a no-op. The
dialog stays open with **Exported** or the failure so another format can follow.

## What enters the manuscript

The five-level outline decides: acts and chapters are structure, scenes (`h1`)
are manuscript headings, beats (`h2`) and notes (`h3`) are outline markers.

- **Whole book** is every chapter in book order except chapters marked
  *discarded* (折笔). In *Selected chapters* the author ticks any chapter,
  discarded ones included; the export still follows book order.
- Chapters before the first act stay outside acts. With act titles on, each
  act with at least one exported chapter opens with its title (EPUB part page,
  Word Heading 1, PDF part page). Acts without exported chapters drop out.
- Chapter titles off keeps chapters as page/file boundaries and in navigation
  (EPUB nav and NCX, PDF bookmarks); the printed contents page is omitted.
- Beat and note headings are left out by default; only the heading line goes,
  the prose under it stays. The switch brings them back.
- Never exported: drifts, elements, storylines, categories, materials,
  comments, TODOs, chapter summaries, plot grids, Agent state.
- Inline marks kept: bold, italic, underline, strike. Hard line breaks,
  blockquotes, horizontal rules (scene breaks), centre/right alignment and
  Tab indent levels are kept. `http(s):` and `mailto:` links stay links;
  entity links and any other link keep only their text. Leading and trailing
  empty paragraphs of a chapter are trimmed; empty lines inside stay.

Live Yjs is the prose truth. `readManuscript`
(`src/renderer/services/export/manuscript-export.service.ts`) captures the
chapter rows, acts and persisted Yjs snapshots/updates in one SQLite read
transaction (bounded batches), takes every mounted live `Y.Doc` synchronously
before yielding (an empty live document is authoritative), hydrates persisted
state through the existing worker, and uses `contentJson` only for a chapter
that has never had Yjs state. A corrupt body or cancellation fails the whole
export. No flush, authored write or network call happens.

The renderer sends one JSON manuscript (`Manuscript` in
`manuscript-export.ts`) to `manuscript_export_save`; native code never reads
the database. The payload limit is 96 MiB and the output limit 512 MiB.

## Language

`src-tauri/src/manuscript_export/text.rs` detects the book's language from its
own characters: Han text becomes `zh-CN` (or `zh-TW` when traditional-only
characters outnumber simplified-only ones), kana `ja`, hangul `ko`; otherwise
the interface locale names a Latin-script book (`en` by default). The language
sets EPUB/Word/PDF metadata, the contents heading (目录 / 目錄 / 目次 / 목차 /
Contents), paragraph indent conventions and the PDF font chain.

## Formats

### EPUB 3

`epub.rs` writes an OCF container: an uncompressed `mimetype` first,
`META-INF/container.xml`, and `OEBPS/` with `content.opf` (EPUB 3.0 package,
`urn:uuid` identifier derived from the project ID so re-exports update the same
book in a reader library, title, creator, language, `dcterms:modified`, cover
metadata), `nav.xhtml` (table of contents with acts nesting their chapters,
plus landmarks), `toc.ncx` for EPUB 2 readers, `styles/book.css` and one XHTML
document per act and chapter. The spine reads cover, title page, contents,
then the body. CJK books get a 2em first-line indent, `line-break: strict` and
1.8 line height; Latin books a 1.5em indent (none after headings and breaks)
and `hyphens: auto`. Fonts are left to the reader.

### Word (.docx)

`docx.rs` writes WordprocessingML by hand (no new dependency). Headings use
Word's built-in styles so the navigation pane and a Word table of contents
follow the outline:

| Drifting | With acts | Without acts |
| --- | --- | --- |
| Act | Heading 1 | — |
| Chapter | Heading 2 | Heading 1 |
| Scene (`h1`) | Heading 3 | Heading 2 |
| Beat (`h2`) | Heading 4 | Heading 3 |
| Note (`h3`) | Heading 5 | Heading 4 |

Body text is Normal (12 pt, justified, 1.5 lines, two-character first-line
indent in CJK books), quotes use Quote, scene breaks a centred Scene Break
paragraph (`*  *  *`). Acts and chapters start on a new page. A4 pages; East
Asian text is set in SimSun / PMingLiU / Yu Mincho / Batang by script with
Times New Roman for Latin, and `compressPunctuation` is on. The cover and
title page are their own section; the body section restarts page numbers at 1
in a centred footer. Core properties carry title, author and language.

### PDF

`pdf/` typesets the book in Rust and writes it with
[krilla](https://github.com/LaurenzV/krilla) (Typst's PDF library): A5 pages,
10.5 pt CJK body on a 30-character measure (11 pt Latin), cover page, title
page, a contents page with dot leaders, page numbers and links, act part pages,
chapters on new pages, centred footer page numbers from the first body page
(front matter is labelled in roman numerals), bookmarks for acts and
chapters, and title/author/language metadata.

- **Fonts.** Faces come from the computer's installed fonts (scanned once per
  run with `fontdb`). Each script has a serif chain: Simplified Chinese starts
  with Songti SC / STSong / Source Han Serif SC / Noto Serif CJK SC / SimSun;
  Traditional with Songti TC / PMingLiU; Japanese with Hiragino Mincho / Yu
  Mincho; Korean with AppleMyungjo / Batang; Latin with Times New Roman /
  Georgia / Charter. A custom system font chosen in the editor's font
  preference is tried first. In CJK books Latin letters and digits use the
  Latin serif while CJK punctuation stays in the CJK face; anything still
  missing falls through the other chains. Faces whose OS/2 `fsType` forbids
  embedding or subsetting are skipped. Fonts are embedded as subsets with
  ToUnicode maps, so text copies and searches. Bold and italic use the
  family's real faces and are synthesised (stroke, 12° slant) only when the
  family has none.
- **Text.** Runs are shaped with rustybuzz (kerning and ligatures for Latin).
  Lines break at UAX #14 opportunities (`unicode-linebreak`), which keeps
  closing marks off line starts and opening marks off line ends. Simplified
  Chinese and Japanese punctuation is spaced: a full-width closing mark before
  another mark, or an opening mark after an opening mark, loses its blank half;
  a closing mark at a line end may lose it when the line needs the room.
  Body lines are justified: CJK lines distribute space between characters
  (never after an opening or before a closing mark), Latin lines at spaces;
  last lines stay flush left. Paragraphs avoid single first or last lines at
  page breaks and headings keep with the following lines.

## Images

Chapter prose uses the `prose` editor profile, which has **no image node**:
images and PDFs exist only as material embeds inside material notes, which are
not manuscript. The image a manuscript carries is therefore its **cover**,
picked in the dialog from any PNG, JPEG, GIF, WebP, BMP or TIFF file. Native
code orients it, bounds the long edge to 2560 px, re-encodes it as JPEG
(`image_pipeline::create_variant`) and embeds it in all three formats: EPUB
`cover-image` with a cover page, a Word inline picture on the first page, a PDF
full-page image. HEIC and AVIF covers are refused (no portable decoder). If
chapter prose gains an image node, extend the manuscript block types and the
three writers together.

## Library choice

| Option | Verdict |
| --- | --- |
| krilla 0.8 + rustybuzz + unicode-linebreak (chosen for PDF) | Correct CID font subsetting, ToUnicode, images, outlines, metadata; adds about 3.5 MB to a release binary in an isolated probe (4.1 MB vs 0.55 MB for a fontdb-only binary). `ttf-parser` 0.25 is shared with the existing `fontdb`. |
| Typst as a library | Best typography, but a whole compiler and its font/package machinery for one feature; several times larger. |
| WebView print-to-PDF | Free CJK layout, but three platform-specific print paths (WKWebView, WebView2, WebKitGTK), no page control, and nothing testable in `cargo test`. |
| `docx-rs`, `epub-builder` | Unnecessary: both formats are XML in a ZIP, written directly with the locked `zip` 4.6.1 and checked by tests. |

Licenses are listed in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Platform boundary

The dialog is desktop-only and opens from desktop editor menus. EPUB and Word
writers compile everywhere; PDF typesetting and `fontdb` compile only for
macOS, Windows and Linux, and other targets answer that PDF export is a
desktop feature.

## Machine-checkable acceptance

```bash
pnpm exec vitest run src/renderer/services/export/manuscript-export.acceptance.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --lib manuscript_export
node scripts/run-manuscript-export-acceptance.mjs          # regenerate evidence
node scripts/run-manuscript-export-acceptance.mjs --check  # verify freshness
```

- The vitest suite builds a synthetic book in a file-backed SQLite database
  (pre-act chapter, two acts, a discarded chapter, a drift, a trashed chapter,
  scene/beat/note headings, marks, links, quote, scene break, hard break,
  alignment, indent) and proves book order, exclusions, option handling,
  live/persisted/seed precedence and all-or-nothing failure. It also keeps
  `src-tauri/src/manuscript_export/fixtures/sample-manuscript.json` equal to
  the converter's own output (`DRIFTING_UPDATE_MANUSCRIPT_FIXTURE=1` rewrites
  it).
- The Rust tests render that fixture with a generated cover in all three
  formats. EPUB: OCF layout, unique identifier, metadata, manifest/spine/nav
  integrity, every file declared, XHTML well-formedness, resolvable references,
  NCX order. Word: every part parses and has a content type, relationships
  resolve, Heading 1–5 definitions and outline levels, heading order, marks,
  the external link, the embedded cover, page breaks and sections. PDF:
  embedded subset fonts with Unicode maps, cover image, bookmarks, page count.
  Unit tests cover punctuation compression, line-end trimming, justification
  slots, language detection, XML escaping, timestamps, links and filenames.
- [`acceptance/manuscript-export.json`](acceptance/manuscript-export.json)
  records independent readers on the sample: poppler (`pdfinfo`, `pdffonts`,
  `pdftotext`, `pdfimages`) for metadata, A5 size, embedded subsets, text order,
  verbatim CJK punctuation, line-start/line-end punctuation and footer numbers;
  macOS `textutil` for the Word package; the EPUB container for navigation,
  spine order and metadata. Set `EPUBCHECK_JAR` to a local W3C epubcheck jar to
  add its verdict; without it the report says epubcheck was not run.

Not claimed by these checks: Microsoft Word, Apple Books or other readers
driven interactively; the native save dialog; fonts on other machines (the
report names the faces chosen on the machine that ran it).

## Recorded desktop run

On 2026-10-31 the dialog was driven through the desktop debug bridge
(`pnpm drifting frontend serve --platform desktop`, then
`pnpm dev:seed:lite --no-watch --frontend-debug`) on the lite sample project
(20 chapters, no acts):

- **Read whole book** → three-dot menu listed *Share*, then *Export manuscript*.
  The 520 px dialog showed Format, Scope, Contents and Book details; the act
  switch was absent (no acts), the title defaulted to the project name and all
  20 chapters were preselected. Selected chapters folded open into a 240 px
  scrolling list (card 720 px high in a 900 px window, no horizontal overflow);
  Select none disabled Export; ticking two chapters and choosing PDF relabelled
  the button *Export PDF*.
- With `platform.sharing.saveManuscript` replaced by a recorder, Export sent the
  two chapters in book order with the typed author, `zh-CN`, a canonical UTC
  timestamp and the filename `潮汐灯塔（轻量功能样本）.pdf`, showed *Exported*
  and remembered the author, format and switches. The unreplaced native
  command, called with `../bad.pdf`, answered `invalid export filename`, so the
  command is registered and validates before any dialog.
- The whole-book payload (200,550 bytes) rendered natively through
  `DRIFTING_MANUSCRIPT_PAYLOAD` to a 243-page PDF (Songti SC and Times New
  Roman subsets, debug build 2.6 s), an EPUB and a Word file that `textutil`
  reads in book order.
- A chapter's own menu opened the dialog on *Selected chapters* with only that
  chapter ticked and the remembered format.

The test window sat behind other windows (`visibilityState: hidden`), so the
fold-open transition was measured with transitions disabled; the native save
and cover pickers were not clicked.
