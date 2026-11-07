//! gpui-prose: a Chinese-first long-form rich-text editor for GPUI, with its
//! text stored in Loro.
//!
//! - One body text is one flat `LoroText`; paragraphs end with `\n` and carry
//!   their attributes (block id, heading …) on it ([`schema`]).
//! - The editor lays out from a paragraph mirror fed only by Loro events, so
//!   local typing, undo, other devices and Agent writes take one path.
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
//! Depends on `gpui` and `loro` only, plus ICU4X segmentation behind the
//! default `icu` feature.

pub mod editor;
pub mod extension;
pub mod input;
pub mod layout;
pub mod platform;
pub mod render;
pub mod schema;
pub mod style;
pub mod text;

pub use editor::{EditorEvent, ProseEditor};
pub use extension::ProseExtension;
pub use input::{Composition, Selection, bind_keys};
pub use layout::{Book, Chapter};
pub use platform::PlatformHooks;
pub use style::{EditorOptions, ProseStyle};
pub use text::{Anchor, AnchorChange, BlockKind, Line, Marks, ProseDoc, UndoConfig};
