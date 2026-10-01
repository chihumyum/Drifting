# Editor Markdown sharing

The editor's three-dot menu item **Share** directly opens a read-only floating
dialog containing the complete, unrendered Markdown, with **Copy all** and
**Save .md**. The text field supports normal selection and Cmd/Ctrl+A and C.
Closing the dialog leaves the manuscript unchanged; opening it again captures
fresh content. A failed read offers retry and never enables a partial export.
Markdown is the only sharing format; there is no format-selection submenu.

- Node (chapter or drift), element, category and storyline editors share the
  current document's title and full prose body.
- **Read whole book** has the same **Share** item,
  above its current-chapter menu section. It reads every non-trashed chapter
  in book order, including chapters that have never been mounted or loaded.
  Acts and chapters retain their hierarchy; prose headings are shifted below
  their containing chapter. Drift nodes and act-note bindings are excluded.
- Chapter summaries appear as Markdown blockquotes immediately below each
  chapter title, before its prose, in both single-chapter and whole-book shares.
  Empty summaries are omitted. Plain-text formatting characters are escaped and
  line breaks preserved. Other entity summaries, comments, KV facts, planning
  grids and related entities are not included. Entity links retain visible text
  without internal IDs or targets.
- Source rows and persisted Yjs snapshots/updates are captured in one SQLite
  transaction, with bounded Yjs batches. Live Yjs documents override persisted
  state, including an intentionally empty document. Only seed-only documents
  use contentJson. Hydration runs after the transaction, using the existing
  worker. This is a local read, not a cross-device publication snapshot.
- Copy and save use exactly the displayed string. Save uses a native Markdown
  document picker, writes UTF-8, handles cancellation separately from errors,
  and accepts at most 32 MiB. No database migration or online service is needed.

Machine-checkable acceptance uses synthetic documents:

```sh
pnpm exec vitest run src/renderer/services/export/markdown-share.acceptance.test.ts
cargo test --manifest-path src-tauri/Cargo.toml markdown_share::tests
```

These checks cover local data selection and conversion, live/persisted/seed
precedence, complete-book reads, chapter-summary placement and escaping,
corruption failure, cancellation and native
filename limits. They do not claim Hosted links or real-device mobile sharing.

Browser UI verification on 2026-10-02 used the production menu, dialog and
Markdown reader with 41 synthetic chapters and substituted database/save
adapters. The preview contained all 41 chapters; Cmd+A selected all 3,235
characters; typing did not change the read-only body; Copy all pasted all 41
chapters after replacing the old clipboard with a sentinel. The save adapter
received the preview's filename and complete text. Native compilation and the
Rust validation test passed, but the native save picker was not UI-verified:
the desktop automation tool could not attach to the isolated dev executable.
