//! The paragraph boundary index: a SumTree with one item per paragraph,
//! summed in paragraphs, Unicode scalars, UTF-16 units and UTF-8 bytes.
//!
//! Each item measures its paragraph *and the `\n` after it* (the last,
//! hidden paragraph after the final `\n` counts one phantom character, so the
//! text length is the total minus one). Looking up the paragraph at an offset
//! or the offset of a paragraph is O(log n); changing one paragraph (typing)
//! updates one item instead of rebuilding a prefix array.
//!
//! Block ids are mapped to paragraph numbers by [`BidMap`], rebuilt only
//! when paragraphs are added, removed or their ids change (not when typing).

use std::{collections::HashMap, ops::Range};

use sum_tree::{Bias, ContextLessSummary, Dimension, Dimensions, Item, SumTree};

/// One paragraph's extent, its `\n` included.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ParagraphExtent {
    pub chars: usize,
    pub utf16: usize,
    pub bytes: usize,
}

impl ParagraphExtent {
    /// The extent of a paragraph whose text is `text` (the `\n` is added).
    pub fn of(text: &str) -> ParagraphExtent {
        ParagraphExtent {
            chars: text.chars().count() + 1,
            utf16: text.encode_utf16().count() + 1,
            bytes: text.len() + 1,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExtentSummary {
    pub paragraphs: usize,
    pub chars: usize,
    pub utf16: usize,
    pub bytes: usize,
}

impl ContextLessSummary for ExtentSummary {
    fn zero() -> Self {
        ExtentSummary::default()
    }

    fn add_summary(&mut self, other: &Self) {
        self.paragraphs += other.paragraphs;
        self.chars += other.chars;
        self.utf16 += other.utf16;
        self.bytes += other.bytes;
    }
}

impl Item for ParagraphExtent {
    type Summary = ExtentSummary;

    fn summary(&self, _: ()) -> ExtentSummary {
        ExtentSummary {
            paragraphs: 1,
            chars: self.chars,
            utf16: self.utf16,
            bytes: self.bytes,
        }
    }
}

macro_rules! dimension {
    ($name:ident, $field:ident) => {
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
        struct $name(usize);

        impl<'a> Dimension<'a, ExtentSummary> for $name {
            fn zero(_: ()) -> Self {
                $name(0)
            }

            fn add_summary(&mut self, summary: &'a ExtentSummary, _: ()) {
                self.0 += summary.$field;
            }
        }
    };
}

dimension!(Paragraphs, paragraphs);
dimension!(Chars, chars);
dimension!(Utf16, utf16);

/// Paragraph boundaries of one body text.
#[derive(Clone)]
pub struct ParagraphIndex {
    tree: SumTree<ParagraphExtent>,
}

impl ParagraphIndex {
    pub fn new(extents: impl IntoIterator<Item = ParagraphExtent>) -> ParagraphIndex {
        ParagraphIndex {
            tree: SumTree::from_iter(extents, ()),
        }
    }

    pub fn len(&self) -> usize {
        self.tree.summary().paragraphs
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Text length in scalars (without the phantom character).
    pub fn len_chars(&self) -> usize {
        self.tree.summary().chars.saturating_sub(1)
    }

    /// Text length in UTF-16 units.
    pub fn len_utf16(&self) -> usize {
        self.tree.summary().utf16.saturating_sub(1)
    }

    /// Replaces paragraphs `range` with `extents`.
    pub fn splice(
        &mut self,
        range: Range<usize>,
        extents: impl IntoIterator<Item = ParagraphExtent>,
    ) {
        let mut cursor = self.tree.cursor::<Paragraphs>(());
        let mut tree = cursor.slice(&Paragraphs(range.start), Bias::Right);
        tree.extend(extents, ());
        cursor.seek_forward(&Paragraphs(range.end), Bias::Right);
        tree.append(cursor.suffix(), ());
        drop(cursor);
        self.tree = tree;
    }

    /// Replaces one paragraph's extent.
    pub fn set(&mut self, ix: usize, extent: ParagraphExtent) {
        self.splice(ix..ix + 1, [extent]);
    }

    /// Scalar offset of the first character of paragraph `ix`.
    pub fn start(&self, ix: usize) -> usize {
        let mut cursor = self.tree.cursor::<Dimensions<Paragraphs, Chars>>(());
        cursor.seek(&Paragraphs(ix), Bias::Right);
        cursor.start().1.0
    }

    /// UTF-16 offset of the first unit of paragraph `ix`.
    pub fn start_utf16(&self, ix: usize) -> usize {
        let mut cursor = self.tree.cursor::<Dimensions<Paragraphs, Utf16>>(());
        cursor.seek(&Paragraphs(ix), Bias::Right);
        cursor.start().1.0
    }

    /// The paragraph holding scalar `offset` and the offset inside it. An
    /// offset on a `\n` belongs to the paragraph that `\n` ends; the text end
    /// belongs to the last paragraph.
    pub fn locate(&self, offset: usize) -> (usize, usize) {
        let offset = offset.min(self.len_chars());
        let mut cursor = self.tree.cursor::<Dimensions<Chars, Paragraphs>>(());
        cursor.seek(&Chars(offset), Bias::Right);
        if cursor.item().is_none() {
            let last = self.len().saturating_sub(1);
            return (last, offset - self.start(last));
        }
        let start = cursor.start();
        (start.1.0, offset - start.0.0)
    }

    /// The paragraph holding UTF-16 `offset` and the paragraph's UTF-16 start.
    pub fn locate_utf16(&self, offset: usize) -> (usize, usize) {
        let offset = offset.min(self.len_utf16());
        let mut cursor = self.tree.cursor::<Dimensions<Utf16, Paragraphs>>(());
        cursor.seek(&Utf16(offset), Bias::Right);
        if cursor.item().is_none() {
            let last = self.len().saturating_sub(1);
            return (last, self.start_utf16(last));
        }
        let start = cursor.start();
        (start.1.0, start.0.0)
    }
}

/// Block id → paragraph number, rebuilt when paragraphs move.
#[derive(Clone, Debug, Default)]
pub struct BidMap {
    map: HashMap<String, usize>,
    dirty: bool,
}

impl BidMap {
    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// Rebuilds from the paragraphs' ids (the first paragraph with an id wins,
    /// as the reading rules say).
    pub fn rebuild<'a>(&mut self, ids: impl IntoIterator<Item = Option<&'a str>>) {
        self.map.clear();
        for (ix, id) in ids.into_iter().enumerate() {
            if let Some(id) = id {
                self.map.entry(id.to_owned()).or_insert(ix);
            }
        }
        self.dirty = false;
    }

    pub fn get(&self, bid: &str) -> Option<usize> {
        self.map.get(bid).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(texts: &[&str]) -> ParagraphIndex {
        ParagraphIndex::new(texts.iter().map(|t| ParagraphExtent::of(t)))
    }

    #[test]
    fn locate_and_start() {
        // "a😀中\n文\n" + hidden "": paragraphs [a😀中][文][].
        let ix = index(&["a😀中", "文", ""]);
        assert_eq!(ix.len(), 3);
        assert_eq!(ix.len_chars(), 6);
        assert_eq!(ix.len_utf16(), 7);
        assert_eq!(ix.start(0), 0);
        assert_eq!(ix.start(1), 4);
        assert_eq!(ix.start(2), 6);
        assert_eq!(ix.locate(0), (0, 0));
        assert_eq!(ix.locate(3), (0, 3)); // on the newline
        assert_eq!(ix.locate(4), (1, 0));
        assert_eq!(ix.locate(6), (2, 0));
        assert_eq!(ix.start_utf16(1), 5);
        assert_eq!(ix.locate_utf16(5), (1, 5));
        assert_eq!(ix.locate_utf16(4), (0, 0));
    }

    #[test]
    fn splice_and_set() {
        let mut ix = index(&["一", "二", "三", ""]);
        ix.splice(
            1..2,
            [ParagraphExtent::of("二二"), ParagraphExtent::of("x")],
        );
        assert_eq!(ix.len(), 5);
        assert_eq!(ix.start(2), 2 + 3);
        assert_eq!(ix.start(3), 2 + 3 + 2);
        ix.set(0, ParagraphExtent::of("一一一"));
        assert_eq!(ix.start(1), 4);
        ix.splice(0..4, []);
        assert_eq!(ix.len(), 1);
        assert_eq!(ix.len_chars(), 0);
        ix.splice(0..0, [ParagraphExtent::of("新")]);
        assert_eq!(ix.locate(2), (1, 0));
    }

    #[test]
    fn first_bid_wins() {
        let mut map = BidMap::default();
        map.rebuild([Some("a"), None, Some("b"), Some("a")]);
        assert_eq!(map.get("a"), Some(0));
        assert_eq!(map.get("b"), Some(2));
        assert_eq!(map.get("c"), None);
    }
}
