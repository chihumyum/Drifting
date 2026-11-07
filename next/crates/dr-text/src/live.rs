//! Live word counts for the document an editor has open (M07).
//!
//! The derived index catches up when the document's holder is idle, 750 ms
//! after the last write, so while the author types it lags behind. The
//! readings that follow the editor (the chapter or idea, the selection) count
//! the editor's own paragraphs instead, by the same rule: [`LiveCount`]
//! keeps one count per paragraph and re-counts only the paragraphs an edit
//! touched. Totals over many documents (a storyline, the book) still come
//! from the index, with the open document's indexed count swapped for its
//! live one ([`with_live`]).
//!
//! The counts are the index's: a paragraph's words and characters by
//! [`crate::text_metrics`] over its plain text, embed placeholders (U+FFFC)
//! left out. For a table paragraph pass the table's text
//! ([`crate::table_text`]): the index counts the cells' words.
//!
//! With gpui-prose's mirror: for each `LineSplice` of a change set, in order,
//! call [`LiveCount::splice`]; then [`LiveCount::recount`] with the mirror's
//! lines.

use dr_doc::prose::ProseView;
use dr_model::prose::OBJECT_CHAR;
use prose_metrics::count_words;

use crate::metrics::TextMetrics;
use crate::plain::block_text;

/// Words and characters of one paragraph's text as an editor holds it.
pub fn paragraph_metrics(text: &str) -> TextMetrics {
    TextMetrics {
        // The rule skips U+FFFC on its own (it neither counts nor ends a word).
        words: count_words(text),
        chars: text.chars().filter(|c| *c != OBJECT_CHAR).count() as u64,
    }
}

/// One count per paragraph of an open document.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LiveCount {
    /// `None`: changed, to be counted by the next [`Self::recount`].
    paragraphs: Vec<Option<TextMetrics>>,
    counted: TextMetrics,
    pending: bool,
}

impl LiveCount {
    /// Count every paragraph.
    pub fn new<S: AsRef<str>>(paragraphs: impl IntoIterator<Item = S>) -> Self {
        let paragraphs: Vec<Option<TextMetrics>> = paragraphs
            .into_iter()
            .map(|t| Some(paragraph_metrics(t.as_ref())))
            .collect();
        let mut counted = TextMetrics::default();
        for m in paragraphs.iter().flatten() {
            counted += *m;
        }
        Self {
            paragraphs,
            counted,
            pending: false,
        }
    }

    /// Count every paragraph of a dr-doc document, tables by their cells:
    /// exactly what the index stores for it.
    pub fn from_view(view: &ProseView<'_>) -> Self {
        Self::new(view.paragraphs().map(|p| block_text(view, &p)))
    }

    /// Paragraphs `start..start + removed` became `inserted` paragraphs,
    /// counted at the next [`Self::recount`]. Positions are those after the
    /// splices before this one; a range past the end is cut to it.
    pub fn splice(&mut self, start: usize, removed: usize, inserted: usize) {
        let start = start.min(self.paragraphs.len());
        let end = start.saturating_add(removed).min(self.paragraphs.len());
        let gone = self
            .paragraphs
            .splice(start..end, std::iter::repeat_n(None, inserted));
        for m in gone.flatten() {
            self.counted.words -= m.words;
            self.counted.chars -= m.chars;
        }
        self.pending |= inserted > 0;
    }

    /// Count the paragraphs [`Self::splice`] left uncounted; `text(i)` is
    /// paragraph `i`'s text now. Only those paragraphs are asked for.
    pub fn recount<S: AsRef<str>>(&mut self, mut text: impl FnMut(usize) -> S) {
        if !self.pending {
            return;
        }
        for (i, slot) in self.paragraphs.iter_mut().enumerate() {
            if slot.is_none() {
                let m = paragraph_metrics(text(i).as_ref());
                self.counted += m;
                *slot = Some(m);
            }
        }
        self.pending = false;
    }

    /// The document's words and characters. Up to date once
    /// [`Self::recount`] has run after the last splice.
    pub fn total(&self) -> TextMetrics {
        self.counted
    }

    /// Whether every paragraph is counted.
    pub fn is_current(&self) -> bool {
        !self.pending
    }

    /// Number of paragraphs.
    pub fn len(&self) -> usize {
        self.paragraphs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.paragraphs.is_empty()
    }

    /// One paragraph's count (`None` until it is recounted).
    pub fn paragraph(&self, i: usize) -> Option<TextMetrics> {
        self.paragraphs.get(i).copied().flatten()
    }
}

/// A total read from the index over documents that include the open one
/// (its book, its storyline), with that document's indexed counts replaced
/// by its live ones. `indexed_doc` is the open document's row in the index
/// (zero when it has none yet).
pub fn with_live(
    indexed_total: TextMetrics,
    indexed_doc: TextMetrics,
    live: TextMetrics,
) -> TextMetrics {
    TextMetrics {
        words: indexed_total.words.saturating_sub(indexed_doc.words) + live.words,
        chars: indexed_total.chars.saturating_sub(indexed_doc.chars) + live.chars,
    }
}
