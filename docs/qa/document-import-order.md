# Document import order

Native directory pickers can return files in filesystem enumeration order. The
import queue now sorts every incoming batch by relative path, or filename for
individual files, using numeric ordering. Thus chapter 2 precedes chapter 10;
numbered subfolders retain their order. Existing queued batches stay ahead of
later batches. Preview and commit use the same sequence.

Machine-checkable regression: `pnpm exec vitest run src/renderer/services/import/order.test.ts`.
Its synthetic fixtures cover scrambled enumeration, reversed enumeration, nested
folders, repeated chapter filenames, deterministic ties and unchanged input.
The fix does not infer chapter order from prose or change document content.

Mac verification on 2026-09-30 reproduced scrambled native directory enumeration
and confirmed that the rebuilt app previews the same batch in numeric filename
order. After moving the non-secret installation marker out of Keychain, all 20 chapters
and 7 reference documents were imported locally and restored in an independent
Hosted peer library. Both libraries passed source-text equality checks; chapter
order and paragraph counts matched. Source files were unchanged. Personal source
files, staging copies, backups and verification details remain outside this repo.

Author manuscripts, derived chapter files and import receipts remain outside the
repository and are never used as committed test fixtures.

## Titles

An imported file's title is not written twice. A level-1 heading that opens
the document (Markdown `# …`, Word's Title or Heading 1) becomes the title and
leaves the body. Without one, the title is the file name without its extension
or a short ordering number (`01 第一章 序.md` → 第一章 序; years such as
`2024-11-05` stay), and an opening line that only repeats it leaves the body.
Headings further down stay in the text as scene, beat and note headings; a
plain-text file's first sentence no longer becomes its title. The dialog still
shows each title for editing before anything is created.

Machine-checkable regression: `pnpm exec vitest run src/renderer/services/import/title.test.ts`,
and the document import scenario in the renderer performance harness
(`docxTitleAndUnicode`, `markdownHeadingAndBold`).
