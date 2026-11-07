//! Words and characters of plain text.
//!
//! Words follow the `prose-metrics` rule (CJK ideographs one by one, other
//! runs with an ASCII letter or digit by whitespace), applied to the real
//! text: unlike the 0.1 client, a Latin word split by bold or a link counts
//! once (`simplifications.md`, section one, item 20). Characters are Unicode
//! scalars of the plain text, whitespace included, paragraph breaks
//! excluded.
//!
//! Both are additive over paragraphs: a document's counts are the sums of
//! its paragraphs' counts.

use prose_metrics::count_words;

/// Words and characters of one piece of plain text.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TextMetrics {
    pub words: u64,
    pub chars: u64,
}

impl std::ops::AddAssign for TextMetrics {
    fn add_assign(&mut self, other: Self) {
        self.words += other.words;
        self.chars += other.chars;
    }
}

pub fn text_metrics(text: &str) -> TextMetrics {
    TextMetrics {
        words: count_words(text),
        chars: text.chars().count() as u64,
    }
}
