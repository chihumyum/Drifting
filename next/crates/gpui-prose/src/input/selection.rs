//! The selection: an anchor and a head, each in a chapter. Both ends are in
//! one chapter unless the author selected across a chapter boundary in the
//! whole-book view ([`Selection::spans_chapters`]).

use std::ops::Range;

use gpui::Pixels;

use crate::layout::{Affinity, BookPos, BookRange};

/// The selection; offsets are scalars in their chapter's text. `chapter` is
/// the head's (the caret's) chapter, `anchor_chapter` the anchor's; they
/// differ only for a selection across chapters.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Selection {
    pub chapter: usize,
    pub anchor: usize,
    pub head: usize,
    pub anchor_chapter: usize,
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
            anchor_chapter: chapter,
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

    /// A selection from `anchor` to `head`, possibly across chapters.
    pub fn across(anchor: BookPos, head: BookPos) -> Selection {
        Selection {
            chapter: head.chapter,
            head: head.offset,
            ..Selection::caret(anchor.chapter, anchor.offset)
        }
    }

    /// The selected range in the caret's chapter. For a selection across
    /// chapters this is the bare caret (`head..head`): use
    /// [`Selection::book_range`] (and [`crate::Book::split_range`]) there.
    pub fn range(&self) -> Range<usize> {
        if self.spans_chapters() {
            return self.head..self.head;
        }
        self.anchor.min(self.head)..self.anchor.max(self.head)
    }

    pub fn is_empty(&self) -> bool {
        self.anchor == self.head && !self.spans_chapters()
    }

    /// Whether the anchor and the head are in different chapters.
    pub fn spans_chapters(&self) -> bool {
        self.anchor_chapter != self.chapter
    }

    pub fn anchor_pos(&self) -> BookPos {
        BookPos {
            chapter: self.anchor_chapter,
            offset: self.anchor,
        }
    }

    pub fn head_pos(&self) -> BookPos {
        BookPos {
            chapter: self.chapter,
            offset: self.head,
        }
    }

    /// The earlier end.
    pub fn start(&self) -> BookPos {
        self.anchor_pos().min(self.head_pos())
    }

    /// The later end.
    pub fn end(&self) -> BookPos {
        self.anchor_pos().max(self.head_pos())
    }

    /// Whether the head comes before the anchor.
    pub fn reversed(&self) -> bool {
        self.head_pos() < self.anchor_pos()
    }

    /// The selection as a book range (`start <= end`).
    pub fn book_range(&self) -> BookRange {
        BookRange {
            start: self.start(),
            end: self.end(),
        }
    }

    /// Drops the anchor: a caret at the head.
    pub(crate) fn collapse(&mut self) {
        self.anchor_chapter = self.chapter;
        self.anchor = self.head;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_selection_across_chapters_has_book_ends() {
        let pos = |chapter, offset| BookPos { chapter, offset };
        let s = Selection::across(pos(2, 3), pos(0, 5));
        assert!(s.spans_chapters() && !s.is_empty() && s.reversed());
        assert_eq!((s.start(), s.end()), (pos(0, 5), pos(2, 3)));
        assert_eq!(s.range(), 5..5, "the caret alone in its chapter");
        let one = Selection::across(pos(1, 4), pos(1, 2));
        assert!(!one.spans_chapters());
        assert_eq!(one, Selection::new(1, 4, 2));
        assert_eq!(one.range(), 2..4);
        assert_eq!(one.book_range(), BookRange::in_chapter(1, 2..4));
        let mut c = s;
        c.collapse();
        assert_eq!(c, Selection::caret(0, 5));
    }
}
