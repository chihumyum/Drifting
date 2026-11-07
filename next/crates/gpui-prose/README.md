# gpui-prose

A Chinese-first long-form rich-text editor for [GPUI](https://www.gpui.rs),
with its text stored in [Loro](https://loro.dev). Built for
[Drifting](https://drifting.cc), a novel-writing app; usable on its own.

一个基于 GPUI 和 Loro 的中文长文富文本编辑器。

- **Loro is the truth.** One body text is one flat `LoroText`. Paragraphs end
  with `\n` and carry their attributes (block id, heading level …) on it; inline
  marks (bold, italic, underline, strike, links, `entity:<id>` links) sit on the
  other characters. The editor lays out from a paragraph mirror fed only by Loro
  events, so typing, undo, remote changes and programmatic writes take one path.
- **Chinese line breaking.** Rows never start with 「，」「。」 or a closing
  quote, never end with an opening one; 「——」「……」 stay whole; punctuation
  hangs past the edge.
- **Input methods.** Marked (pinyin) text never reaches Loro; confirming writes
  the word in one commit, and one undo removes it. Losing focus mid-composition
  discards the marked text.
- **Whole books.** Many documents in one virtualized scroll (tested with 100
  chapters, 1.5 million characters), with height estimates for paragraphs never
  laid out.
- **Words and clusters.** ⌥←/⌥→ and double click use ICU4X word segmentation
  (Chinese words from its dictionary); arrows and Backspace step over whole
  grapheme clusters (👨‍👩‍👧, 🇨🇳).
- **Undo that respects collaboration.** Loro's merge interval stays 0; the editor
  groups bursts of typing itself, skips other writers (`agent:` origins), and
  re-anchors comments whose text an undo brings back.

```bash
cargo run -p gpui-prose --example editor
```

Status: early. The API is described, with what is stable and what may change,
in the Drifting repository at `docs/rust-rewrite/foundations/f4-editor.md`.
GPUI is a git dependency (Zed `v1.27.0`), so the crate is not on crates.io yet.

## Features

- `icu` (default): ICU4X word and grapheme segmentation. Without it a small
  built-in approximation is used, and the crate depends on `gpui` and `loro`
  only.

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or
[MIT license](LICENSE-MIT) at your option. The rest of the Drifting repository
is AGPL-3.0-or-later; this crate does not depend on it.
