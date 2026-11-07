//! Input-method composition in the editor: `gpui-ime`'s [`Overlay`] (the
//! rules shared with dr-ui's single-line fields) plus the chapter it is in.
//!
//! The marked text never reaches the document: the editor keeps it here and
//! shows it spliced into the paragraph; only the confirmed text is written,
//! in one commit, so one undo removes the whole word. Losing focus discards
//! it here and in the system input method ([`gpui_ime::BLUR_RULE`]).

use std::ops::{Deref, DerefMut};

pub use gpui_ime::{Marked16, Marking, Overlay, Virtual16};

/// Marked text in one chapter of the editor.
#[derive(Clone, Debug, PartialEq)]
pub struct Composition {
    pub chapter: usize,
    pub overlay: Overlay,
}

impl Composition {
    pub fn begin(chapter: usize, range: std::ops::Range<usize>) -> Composition {
        Composition {
            chapter,
            overlay: Overlay::begin(range),
        }
    }
}

impl Deref for Composition {
    type Target = Overlay;

    fn deref(&self) -> &Overlay {
        &self.overlay
    }
}

impl DerefMut for Composition {
    fn deref_mut(&mut self) -> &mut Overlay {
        &mut self.overlay
    }
}
