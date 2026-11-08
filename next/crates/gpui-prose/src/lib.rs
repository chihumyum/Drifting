//! gpui-prose: a Chinese-first long-form rich-text editor for GPUI, with its
//! text stored in Loro.
//!
//! - One body text is one flat `LoroText`; paragraphs end with `\n` and carry
//!   their attributes (block id, heading …) on it ([`schema`]).
//! - The editor does not own the document: it reads, writes and undoes
//!   through a [`ProseSource`] (gpui-prose ships [`LoroSource`]; a host can
//!   bring its own, checked with the `conformance` suite).
//! - It lays out from a paragraph mirror and SumTree index fed only by the
//!   source's events, so local typing, undo, other devices and Agent writes
//!   take one path.
//! - It breaks lines itself with Chinese rules (no 「，」 at a row start,
//!   hanging punctuation) and virtualizes whole books of 1.5 million
//!   characters with GPUI's `list()` and its own height index.
//! - Input-method marked text never reaches Loro; one undo removes one word.
//!
//! Layers, each its own module so they can be worked on separately:
//!
//! | module | sub-line | what |
//! | --- | --- | --- |
//! | [`text`] | F4a | Loro document, mirror, block ids, marks, undo, anchors, segmentation |
//! | [`layout`] | F4b | line breaking, paragraph geometry, heights, the book |
//! | [`input`] | F4c | actions, selection, IME, movement, editing, mouse |
//! | [`render`] | F4d | runs, paragraph element, paint, caret layer |
//!
//! [`ProseEditor`] (in `editor.rs`) holds the state and the frame and ties
//! the layers together.
//!
//! Depends on `gpui` (and its `sum_tree`), `loro`, and two small crates of
//! its own: `gpui-ime` (composition rules, shared with dr-ui) and
//! `prose-linebreak` (Chinese line breaking, shared with the exports), plus
//! ICU4X segmentation behind the default `icu` feature.

pub mod editor;
pub mod embeds;
pub mod extension;
pub mod input;
pub mod layout;
pub mod platform;
pub mod render;
pub mod schema;
pub mod slots;
pub mod style;
pub mod text;

pub use editor::{AuthorTyped, EditorEvent, HostStep, ProseEditor};
pub use embeds::EmbedViews;
pub use extension::{InputRule, ProseExtension, Typed};
pub use input::{Composition, Selection, bind_keys};
pub use layout::{Book, Chapter};
pub use platform::PlatformHooks;
pub use slots::ChapterSlots;
pub use style::{EditorOptions, ProseStyle};
pub use text::{
    Anchor, AnchorChange, BlockKind, Edit, EditResult, Line, LoroSource, Marks, ProseDoc,
    ProseSource, SourceChange, SourceEvent, SourceParagraph, UndoConfig,
};
