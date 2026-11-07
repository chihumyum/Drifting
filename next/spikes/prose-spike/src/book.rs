//! Several body texts in one scroll: a single chapter, or the whole book.
//!
//! Each chapter is its own Loro document (one body text per document). The
//! scroll is a flat list of items: for every chapter a title item, then one
//! item per visible paragraph.

use gpui::SharedString;

use crate::doc::ProseDoc;

pub struct Chapter {
    pub title: SharedString,
    pub doc: ProseDoc,
}

/// What a list item shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Item {
    Title(usize),
    Line(usize, usize),
}

pub struct Book {
    pub chapters: Vec<Chapter>,
    /// First item of each chapter (its title), plus the total at the end.
    starts: Vec<usize>,
    /// Paragraph items the list currently holds for each chapter.
    pub(crate) listed: Vec<usize>,
}

impl Book {
    pub fn new(chapters: Vec<Chapter>) -> Book {
        let listed = chapters.iter().map(|c| c.doc.visible_lines()).collect();
        let mut book = Book {
            chapters,
            starts: Vec::new(),
            listed,
        };
        book.recompute_starts();
        book
    }

    pub(crate) fn recompute_starts(&mut self) {
        self.starts.clear();
        let mut at = 0;
        for listed in &self.listed {
            self.starts.push(at);
            at += 1 + listed;
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
        } else {
            Item::Line(chapter, offset - 1)
        }
    }

    pub fn len_chars(&mut self) -> usize {
        self.chapters.iter_mut().map(|c| c.doc.len_chars()).sum()
    }
}
