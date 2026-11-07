//! Spike P0-B: the editor core that seeds `gpui-prose`.
//!
//! - [`doc`]: one body text as a Loro document (flat `LoroText`, newline marks).
//! - [`book`]: several body texts in one scroll (a chapter, or the whole book).
//! - [`editor`]: the GPUI view — selection, IME composition, undo, actions.
//! - [`element`]: the paragraph element that shapes, wraps and paints one line.
//! - [`heights`]: estimated and measured paragraph heights for the scrollbar.
//!
//! Depends on `gpui` and `loro` only.

pub mod book;
pub mod doc;
pub mod editor;
pub mod element;
pub mod heights;
