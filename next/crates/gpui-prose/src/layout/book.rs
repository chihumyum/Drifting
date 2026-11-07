//! Several body texts in one scroll: a single chapter, or the whole book.
//!
//! Each chapter is its own Loro document (one body text per document). The
//! scroll is a flat list of items: for every chapter a title item, then one
//! item per visible paragraph, then (when the host has chapter slots, see
//! [`crate::slots`]) an end item.

use std::ops::Range;

use gpui::SharedString;

use crate::text::ProseDoc;

pub struct Chapter {
    pub title: SharedString,
    pub doc: ProseDoc,
}

/// What a list item shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Item {
    /// The chapter's title row, or the host's head for it.
    Title(usize),
    Line(usize, usize),
    /// After the chapter's last paragraph: the host's end for it (only with
    /// chapter slots).
    End(usize),
}

pub struct Book {
    pub chapters: Vec<Chapter>,
    /// First item of each chapter (its title), plus the total at the end.
    starts: Vec<usize>,
    /// Paragraph items the list currently holds for each chapter.
    pub(crate) listed: Vec<usize>,
    /// The chapters that open an act, with the act's name (the whole-book
    /// view's title pages; drawn by the render layer).
    acts: Vec<(usize, SharedString)>,
    /// Whether each chapter has an end item ([`Item::End`]).
    ends: bool,
}

/// A position in the book: a chapter and a scalar offset in its text.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BookPos {
    pub chapter: usize,
    pub offset: usize,
}

/// A range of the book that may span chapters, `start <= end`. Today's
/// selection stays inside one chapter; a selection across chapters (F4b and
/// F4c) is a `BookRange`, and edits on it go chapter by chapter
/// ([`Book::split_range`]), each to that chapter's own document and undo.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct BookRange {
    pub start: BookPos,
    pub end: BookPos,
}

impl BookRange {
    /// A range inside one chapter.
    pub fn in_chapter(chapter: usize, range: Range<usize>) -> BookRange {
        BookRange {
            start: BookPos {
                chapter,
                offset: range.start,
            },
            end: BookPos {
                chapter,
                offset: range.end,
            },
        }
    }

    pub fn is_empty(&self) -> bool {
        self.start == self.end
    }

    /// The chapter, if the range does not cross a chapter boundary.
    pub fn chapter(&self) -> Option<usize> {
        (self.start.chapter == self.end.chapter).then_some(self.start.chapter)
    }
}

impl Book {
    pub fn new(chapters: Vec<Chapter>) -> Book {
        let listed = chapters.iter().map(|c| c.doc.visible_lines()).collect();
        let mut book = Book {
            chapters,
            starts: Vec::new(),
            listed,
            acts: Vec::new(),
            ends: false,
        };
        book.recompute_starts();
        book
    }

    pub(crate) fn recompute_starts(&mut self) {
        self.starts.clear();
        let mut at = 0;
        for listed in &self.listed {
            self.starts.push(at);
            at += 1 + listed + usize::from(self.ends);
        }
        self.starts.push(at);
    }

    pub fn item_count(&self) -> usize {
        *self.starts.last().unwrap_or(&0)
    }

    pub fn chapter_item(&self, chapter: usize) -> usize {
        self.starts[chapter]
    }

    pub fn line_item(&self, chapter: usize, line: usize) -> usize {
        self.starts[chapter] + 1 + line
    }

    pub fn item(&self, ix: usize) -> Item {
        let chapter = match self.starts.binary_search(&ix) {
            Ok(chapter) => chapter.min(self.chapters.len() - 1),
            Err(next) => next - 1,
        };
        let offset = ix - self.starts[chapter];
        if offset == 0 {
            Item::Title(chapter)
        } else if self.ends && offset == 1 + self.listed[chapter] {
            Item::End(chapter)
        } else {
            Item::Line(chapter, offset - 1)
        }
    }

    /// The end item of `chapter`, if chapters have ends.
    pub fn end_item(&self, chapter: usize) -> Option<usize> {
        self.ends
            .then(|| self.starts[chapter] + 1 + self.listed[chapter])
    }

    /// Whether each chapter has an end item.
    pub fn has_ends(&self) -> bool {
        self.ends
    }

    /// Gives every chapter an end item, or takes them away (the editor does
    /// this when the host sets chapter slots).
    pub(crate) fn set_ends(&mut self, ends: bool) {
        self.ends = ends;
        self.recompute_starts();
    }

    pub fn len_chars(&mut self) -> usize {
        self.chapters.iter_mut().map(|c| c.doc.len_chars()).sum()
    }

    /// Sets which chapters open an act, and the act names (sorted by
    /// chapter; chapters out of range are dropped).
    pub fn set_acts(&mut self, acts: impl IntoIterator<Item = (usize, SharedString)>) {
        let n = self.chapters.len();
        self.acts = acts.into_iter().filter(|(c, _)| *c < n).collect();
        self.acts.sort_by_key(|(c, _)| *c);
        self.acts.dedup_by_key(|(c, _)| *c);
    }

    /// The name of the act `chapter` opens, if it opens one.
    pub fn act_opening(&self, chapter: usize) -> Option<&SharedString> {
        self.acts
            .binary_search_by_key(&chapter, |(c, _)| *c)
            .ok()
            .map(|i| &self.acts[i].1)
    }

    /// Every act, as `(first chapter, name)`.
    pub fn acts(&self) -> &[(usize, SharedString)] {
        &self.acts
    }

    /// `range` cut into one range per chapter it touches, in order (offsets
    /// clamped to each chapter's text, its final newline excluded; a chapter
    /// crossed whole is `0..max_cursor`).
    pub fn split_range(&self, range: BookRange) -> Vec<(usize, Range<usize>)> {
        let (start, end) = if range.start <= range.end {
            (range.start, range.end)
        } else {
            (range.end, range.start)
        };
        let last = self.chapters.len().saturating_sub(1);
        let (first, final_chapter) = (start.chapter.min(last), end.chapter.min(last));
        (first..=final_chapter)
            .filter(|_| !self.chapters.is_empty())
            .map(|c| {
                let len = self.chapters[c].doc.max_cursor();
                let from = if c == start.chapter {
                    start.offset.min(len)
                } else {
                    0
                };
                let to = if c == end.chapter {
                    end.offset.min(len)
                } else {
                    len
                };
                (c, from..to.max(from))
            })
            .collect()
    }

    /// The text of `range`, chapters joined by a newline.
    pub fn text_in(&self, range: BookRange) -> String {
        self.split_range(range)
            .into_iter()
            .map(|(c, r)| self.chapters[c].doc.slice(r))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::{BlockKind, ProseDoc};

    fn book(texts: &[&str]) -> Book {
        Book::new(
            texts
                .iter()
                .map(|t| Chapter {
                    title: "章".into(),
                    doc: ProseDoc::from_paragraphs([(BlockKind::Body, *t)]),
                })
                .collect(),
        )
    }

    #[test]
    fn ranges_split_per_chapter() {
        let b = book(&["一二三", "四五", "六七八九"]);
        let r = BookRange {
            start: BookPos {
                chapter: 0,
                offset: 1,
            },
            end: BookPos {
                chapter: 2,
                offset: 2,
            },
        };
        assert_eq!(b.split_range(r), vec![(0, 1..3), (1, 0..2), (2, 0..2)]);
        assert_eq!(b.text_in(r), "二三\n四五\n六七");
        let within = BookRange::in_chapter(1, 0..1);
        assert_eq!(within.chapter(), Some(1));
        assert_eq!(b.split_range(within), vec![(1, 0..1)]);
        assert_eq!(r.chapter(), None);
    }

    #[test]
    fn end_items_follow_each_chapter() {
        let mut b = Book::new(vec![
            Chapter {
                title: "一".into(),
                doc: ProseDoc::from_paragraphs([(BlockKind::Body, "甲"), (BlockKind::Body, "乙")]),
            },
            Chapter {
                title: "二".into(),
                doc: ProseDoc::from_paragraphs([(BlockKind::Body, "丙")]),
            },
        ]);
        assert_eq!(b.item_count(), 5);
        assert_eq!(b.end_item(0), None);
        b.set_ends(true);
        let items: Vec<Item> = (0..b.item_count()).map(|ix| b.item(ix)).collect();
        assert_eq!(
            items,
            [
                Item::Title(0),
                Item::Line(0, 0),
                Item::Line(0, 1),
                Item::End(0),
                Item::Title(1),
                Item::Line(1, 0),
                Item::End(1),
            ]
        );
        assert_eq!((b.end_item(0), b.end_item(1)), (Some(3), Some(6)));
        assert_eq!((b.chapter_item(1), b.line_item(1, 0)), (4, 5));
        b.set_ends(false);
        assert_eq!(b.item_count(), 5);
    }

    #[test]
    fn acts_open_chapters() {
        let mut b = book(&["一", "二", "三"]);
        b.set_acts([(2, "第二幕".into()), (0, "第一幕".into()), (9, "x".into())]);
        assert_eq!(b.act_opening(0).map(|s| s.as_ref()), Some("第一幕"));
        assert_eq!(b.act_opening(1), None);
        assert_eq!(b.act_opening(2).map(|s| s.as_ref()), Some("第二幕"));
        assert_eq!(b.acts().len(), 2);
    }
}
