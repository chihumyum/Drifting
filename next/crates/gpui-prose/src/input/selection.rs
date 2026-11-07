//! The selection: an anchor and a head in one chapter.

use std::ops::Range;

use gpui::Pixels;

use crate::layout::Affinity;

/// The selection; offsets are scalars in `chapter`'s text. Selections do not
/// cross chapters yet (F4c, later milestone).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Selection {
    pub chapter: usize,
    pub anchor: usize,
    pub head: usize,
    pub affinity: Affinity,
    /// Where vertical movement aims, kept across consecutive ↑/↓.
    pub(crate) goal_x: Option<Pixels>,
}

impl Selection {
    pub fn caret(chapter: usize, offset: usize) -> Selection {
        Selection {
            chapter,
            anchor: offset,
            head: offset,
            affinity: Affinity::Downstream,
            goal_x: None,
        }
    }

    pub fn new(chapter: usize, anchor: usize, head: usize) -> Selection {
        Selection {
            head,
            ..Selection::caret(chapter, anchor)
        }
    }

    pub fn range(&self) -> Range<usize> {
        self.anchor.min(self.head)..self.anchor.max(self.head)
    }

    pub fn is_empty(&self) -> bool {
        self.anchor == self.head
    }
}
