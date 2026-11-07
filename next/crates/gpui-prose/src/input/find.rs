//! Find and replace: the matches of a query in a chapter (or every chapter
//! of the book), the current match, stepping through them, and replacing one
//! or all of them.
//!
//! - **Matches stay inside a paragraph.** A query with a line break finds
//!   nothing (as in the old editor's paper search).
//! - **Case** is ignored unless [`FindOptions::case_sensitive`]: both sides
//!   are lower-cased by Unicode's full mapping, and a match must start and
//!   end on whole characters of the paragraph.
//! - **Whole words** ([`FindOptions::whole_word`]) means both ends sit on a
//!   word boundary of the same segmentation the editor moves by (ICU, with
//!   its dictionary for Chinese: 「公园」 is found in 「去公园」, 「园」 is not).
//! - **The current match is the selection.** Stepping selects a match; a
//!   match is current exactly while the selection covers it. So edits,
//!   undo and other people's writes move it along with the selection, and
//!   typing elsewhere leaves no match current (the next step starts from the
//!   caret).
//! - **Matches follow edits.** They are computed lazily and cached by
//!   paragraph text: a paragraph whose text did not change is not searched
//!   (folded, segmented) again. The key is the text itself, not its address:
//!   GPUI's `SharedString` keeps short strings inline, so an address says
//!   nothing about the text.
//! - **Replace** writes as the author (`user` origin), one undo step;
//!   **replace all** writes every match of a chapter back to front as one
//!   commit ([`crate::text::ProseDoc::edit_batch`]): one undo step, one Loro
//!   undo item. The replacement takes the marks of the match's
//!   first character (a renamed, bold, entity-linked name stays so).
//! - Drawing the matches is F4d's: [`ProseEditor::find_matches`] and
//!   [`ProseEditor::find_current`] are what a highlight layer reads.
//!
//! Crossing documents the editor does not hold (Drifting opens one chapter
//! at a time) is the host's: with [`FindOptions::wrap`] off, stepping past
//! the last match reports [`FindOutcome::PassedEnd`] and emits
//! [`FindEvent::PassedEnd`], so the host can open the next chapter and call
//! [`ProseEditor::find_first`].

use std::{cell::RefCell, collections::HashMap, ops::Range, rc::Rc};

use gpui::{Context, EventEmitter, SharedString, Window};

use super::{Selection, actions::*};
use crate::{
    ProseEditor,
    text::{Edit, MarkOverride, ORIGIN_USER, ProseDoc, segment},
};

/// How a query matches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FindOptions {
    /// Match case exactly (off: Unicode lower-case on both sides).
    pub case_sensitive: bool,
    /// Both ends of a match on word boundaries (ICU words; Chinese by
    /// dictionary).
    pub whole_word: bool,
    /// The selection's chapter, or every chapter in the editor's book.
    pub scope: FindScope,
    /// Stepping past the last match goes round to the first (and back).
    pub wrap: bool,
}

impl Default for FindOptions {
    fn default() -> Self {
        FindOptions {
            case_sensitive: false,
            whole_word: false,
            scope: FindScope::Chapter,
            wrap: true,
        }
    }
}

/// Where find looks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FindScope {
    /// The chapter the selection is in.
    #[default]
    Chapter,
    /// Every chapter of the editor's book, in order.
    Book,
}

/// One match: scalar offsets in `chapter`'s text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FindHit {
    pub chapter: usize,
    pub range: Range<usize>,
}

/// What a step found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FindOutcome {
    /// The next match, now selected.
    Found(FindHit),
    /// The first (or last) match again, after going round the scope.
    Wrapped(FindHit),
    /// No match ahead and [`FindOptions::wrap`] is off: the selection did
    /// not move.
    PassedEnd,
    /// No query, or nothing matches it.
    NotFound,
}

impl FindOutcome {
    pub fn hit(&self) -> Option<&FindHit> {
        match self {
            FindOutcome::Found(hit) | FindOutcome::Wrapped(hit) => Some(hit),
            _ => None,
        }
    }
}

/// Where the current match stands, for a "3 / 12" label.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FindStatus {
    /// Matches in the scope.
    pub total: usize,
    /// The current match's position among them (0-based), if the selection
    /// is on one.
    pub current: Option<usize>,
}

/// Events for a host's find bar.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FindEvent {
    /// A step went past the last (or first) match with wrapping off: a host
    /// searching across documents opens the next one and calls
    /// [`ProseEditor::find_first`].
    PassedEnd { forward: bool },
    /// The editor set the query itself (⌘E, "use selection for find"): the
    /// find bar shows it.
    QueryChanged(String),
}

impl EventEmitter<FindEvent> for ProseEditor {}

// ----- matching (pure) -----------------------------------------------------------------

/// A query prepared for matching paragraphs.
#[derive(Clone, Debug, PartialEq)]
pub struct Matcher {
    query: String,
    /// The query as compared (lower-cased unless case-sensitive).
    needle: String,
    options: FindOptions,
}

impl Matcher {
    /// `None` for a query that can match nothing (empty, or with a line
    /// break).
    pub fn new(query: &str, options: FindOptions) -> Option<Matcher> {
        if query.is_empty() || query.contains(['\n', '\r']) {
            return None;
        }
        let needle = if options.case_sensitive {
            query.to_owned()
        } else {
            fold(query).0
        };
        Some(Matcher {
            query: query.to_owned(),
            needle,
            options,
        })
    }

    pub fn query(&self) -> &str {
        &self.query
    }

    pub fn options(&self) -> &FindOptions {
        &self.options
    }

    /// The matches in one paragraph's text, in scalar offsets of it,
    /// non-overlapping, left to right.
    pub fn find_in(&self, text: &str) -> Vec<Range<usize>> {
        let bytes: Vec<Range<usize>> = if self.options.case_sensitive {
            text.match_indices(self.needle.as_str())
                .map(|(at, found)| at..at + found.len())
                .collect()
        } else {
            let (folded, map) = fold(text);
            folded
                .match_indices(self.needle.as_str())
                .filter_map(|(at, found)| map.original(at, at + found.len()))
                .collect()
        };
        if bytes.is_empty() {
            return Vec::new();
        }
        let bytes = if self.options.whole_word {
            let segments = segment::word_segments(text);
            let boundary = |b: usize| {
                b == text.len() || segments.binary_search_by(|s| s.range.start.cmp(&b)).is_ok()
            };
            bytes
                .into_iter()
                .filter(|r| boundary(r.start) && boundary(r.end))
                .collect()
        } else {
            bytes
        };
        to_chars(text, bytes)
    }
}

/// Lower-cased text and where each of its bytes came from.
struct FoldMap {
    /// For every original character: (byte in the folded text, byte in the
    /// original text). Strictly increasing in both.
    starts: Vec<(usize, usize)>,
    folded_len: usize,
    original_len: usize,
}

impl FoldMap {
    /// The original byte range of a folded range, if both ends fall on the
    /// fold of whole characters.
    fn original(&self, start: usize, end: usize) -> Option<Range<usize>> {
        let edge = |folded: usize| {
            if folded == self.folded_len {
                return Some(self.original_len);
            }
            self.starts
                .binary_search_by(|(f, _)| f.cmp(&folded))
                .ok()
                .map(|ix| self.starts[ix].1)
        };
        Some(edge(start)?..edge(end)?)
    }
}

/// Unicode full lower-casing, with the map back to the original. ASCII text
/// folds byte for byte.
fn fold(text: &str) -> (String, FoldMap) {
    if text.is_ascii() {
        let starts = (0..text.len()).map(|b| (b, b)).collect();
        return (
            text.to_ascii_lowercase(),
            FoldMap {
                starts,
                folded_len: text.len(),
                original_len: text.len(),
            },
        );
    }
    let mut folded = String::with_capacity(text.len());
    let mut starts = Vec::with_capacity(text.len());
    for (at, c) in text.char_indices() {
        starts.push((folded.len(), at));
        folded.extend(c.to_lowercase());
    }
    let folded_len = folded.len();
    (
        folded,
        FoldMap {
            starts,
            folded_len,
            original_len: text.len(),
        },
    )
}

/// Byte ranges (sorted, on char boundaries) to scalar ranges, in one pass.
fn to_chars(text: &str, bytes: Vec<Range<usize>>) -> Vec<Range<usize>> {
    let mut out = Vec::with_capacity(bytes.len());
    let (mut byte, mut chars) = (0, 0);
    let mut advance = |to: usize| {
        chars += text[byte..to].chars().count();
        byte = to;
        chars
    };
    for range in bytes {
        let start = advance(range.start);
        let end = advance(range.end);
        out.push(start..end);
    }
    out
}

// ----- per-chapter cache ---------------------------------------------------------------

/// A chapter's matches and the per-paragraph cache they were built from.
#[derive(Default)]
struct ChapterMatches {
    lines: HashMap<SharedString, Rc<[Range<usize>]>>,
    all: Rc<[Range<usize>]>,
}

/// Find's state in the editor.
#[derive(Default)]
pub(crate) struct FindState {
    matcher: Option<Matcher>,
    chapters: RefCell<Vec<ChapterMatches>>,
}

impl FindState {
    fn chapter_matches(&self, chapter: usize, doc: &ProseDoc) -> Rc<[Range<usize>]> {
        let Some(matcher) = &self.matcher else {
            return Rc::from([]);
        };
        let mut chapters = self.chapters.borrow_mut();
        if chapters.len() <= chapter {
            chapters.resize_with(chapter + 1, ChapterMatches::default);
        }
        let cached = &mut chapters[chapter];
        let mut fresh: HashMap<SharedString, Rc<[Range<usize>]>> =
            HashMap::with_capacity(cached.lines.len());
        let mut all = Vec::new();
        let mut changed = false;
        let mut start = 0;
        for line in &doc.lines()[..doc.visible_lines()] {
            let ranges = if let Some(ranges) = fresh.get(&line.text) {
                ranges.clone()
            } else {
                let ranges = cached.lines.remove(&line.text).unwrap_or_else(|| {
                    changed = true;
                    matcher.find_in(&line.text).into()
                });
                fresh.insert(line.text.clone(), ranges.clone());
                ranges
            };
            all.extend(ranges.iter().map(|r| start + r.start..start + r.end));
            start += line.chars + 1;
        }
        changed |= !cached.lines.is_empty();
        cached.lines = fresh;
        if changed || *cached.all != *all {
            cached.all = all.into();
        }
        cached.all.clone()
    }
}

// ----- the editor ----------------------------------------------------------------------

impl ProseEditor {
    /// Sets the query (the find bar's text) and selects the first match at
    /// or after the selection's start, as the find bar types. An empty query
    /// clears find.
    pub fn set_find(
        &mut self,
        query: &str,
        options: FindOptions,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> FindOutcome {
        let matcher = Matcher::new(query, options);
        if matcher != self.input.find.matcher {
            self.input.find.matcher = matcher;
            self.input.find.chapters.borrow_mut().clear();
        }
        cx.notify();
        if self.input.find.matcher.is_none() || self.composition.is_some() {
            return FindOutcome::NotFound;
        }
        let from = (self.selection.chapter, self.selection.range().start);
        let outcome = self.step(from, true);
        self.select_outcome(&outcome, cx)
    }

    /// Drops the query; no matches remain.
    pub fn clear_find(&mut self, cx: &mut Context<Self>) {
        self.input.find = FindState::default();
        cx.notify();
    }

    /// The query and its options, if find is on.
    pub fn find_query(&self) -> Option<(&str, &FindOptions)> {
        self.input
            .find
            .matcher
            .as_ref()
            .map(|m| (m.query(), m.options()))
    }

    /// Every match in `chapter`, sorted, in scalar offsets of its text (for a
    /// highlight layer). Empty without a query.
    pub fn find_matches(&self, chapter: usize) -> Rc<[Range<usize>]> {
        match self.book.chapters.get(chapter) {
            Some(c) => self.input.find.chapter_matches(chapter, &c.doc),
            None => Rc::from([]),
        }
    }

    /// The match the selection covers exactly, if any.
    pub fn find_current(&self) -> Option<FindHit> {
        let sel = self.selection;
        if sel.is_empty() {
            return None;
        }
        let range = sel.range();
        let matches = self.find_matches(sel.chapter);
        matches
            .binary_search_by(|m| m.start.cmp(&range.start))
            .ok()
            .filter(|&ix| matches[ix] == range)
            .map(|_| FindHit {
                chapter: sel.chapter,
                range,
            })
    }

    /// How many matches the scope has and which one is current.
    pub fn find_status(&self) -> FindStatus {
        let current = self.find_current();
        let mut status = FindStatus::default();
        for chapter in self.scope_chapters() {
            let matches = self.find_matches(chapter);
            if let Some(hit) = current.as_ref().filter(|hit| hit.chapter == chapter) {
                let ix = matches.partition_point(|m| m.start < hit.range.start);
                status.current = Some(status.total + ix);
            }
            status.total += matches.len();
        }
        status
    }

    /// Selects the next match after the selection (⌘G).
    pub fn find_next(&mut self, window: &mut Window, cx: &mut Context<Self>) -> FindOutcome {
        self.find_step(true, window, cx)
    }

    /// Selects the match before the selection (⇧⌘G).
    pub fn find_previous(&mut self, window: &mut Window, cx: &mut Context<Self>) -> FindOutcome {
        self.find_step(false, window, cx)
    }

    /// Selects the first match of the scope (`forward`), or the last: where
    /// a host continues after opening the next or previous document.
    pub fn find_first(
        &mut self,
        forward: bool,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> FindOutcome {
        if self.composition.is_some() {
            return FindOutcome::NotFound;
        }
        let from = if forward {
            (self.scope_chapters().start, 0)
        } else {
            let last = self.scope_chapters().end - 1;
            (last, self.book.chapters[last].doc.max_cursor() + 1)
        };
        let outcome = match self.step(from, forward) {
            FindOutcome::Wrapped(hit) => FindOutcome::Found(hit),
            other => other,
        };
        self.select_outcome(&outcome, cx)
    }

    fn find_step(
        &mut self,
        forward: bool,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> FindOutcome {
        if self.composition.is_some() || self.input.find.matcher.is_none() {
            return FindOutcome::NotFound;
        }
        // From the selection's far end (it may span chapters).
        let at = if forward {
            self.selection.end()
        } else {
            self.selection.start()
        };
        let from = (at.chapter, at.offset);
        let outcome = self.step(from, forward);
        if outcome == FindOutcome::PassedEnd {
            cx.emit(FindEvent::PassedEnd { forward });
        }
        self.select_outcome(&outcome, cx)
    }

    /// Replaces the current match with `replacement` and selects the next
    /// one; with no current match, only selects the next (the first press
    /// shows what will be replaced). One undo step. Returns whether text was
    /// replaced.
    pub fn replace_current(
        &mut self,
        replacement: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.composition.is_some() {
            return false;
        }
        let Some(hit) = self.find_current() else {
            self.find_next(window, cx);
            return false;
        };
        self.edit(window, cx, |doc, sel| {
            doc.checkpoint();
            let overrides = overrides_for(doc, hit.range.clone());
            let inserted =
                doc.replace_styled(hit.range.clone(), replacement, &overrides, ORIGIN_USER);
            *sel = Selection::caret(sel.chapter, inserted.end);
            doc.checkpoint();
        });
        // The next match after the replacement, never the replacement itself
        // (a replacement that contains the query is not found again).
        let from = (self.selection.chapter, self.selection.head);
        let outcome = self.step(from, true);
        self.select_outcome(&outcome, cx);
        true
    }

    /// Replaces every match in the scope with `replacement`: one undo step
    /// per chapter, back to front so earlier matches keep their offsets.
    /// Returns how many were replaced.
    pub fn replace_all(
        &mut self,
        replacement: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> usize {
        if self.composition.is_some() {
            return 0;
        }
        let home = self.selection.chapter;
        let mut keep = self.selection;
        let mut replaced = 0;
        for chapter in self.scope_chapters() {
            let matches = self.find_matches(chapter);
            if matches.is_empty() {
                continue;
            }
            replaced += matches.len();
            self.selection = Selection::caret(chapter, matches[0].start);
            let steps_before = self.book.chapters[chapter].doc.undo_count();
            self.edit(window, cx, |doc, sel| {
                doc.checkpoint();
                // One commit, one undo item (undoing N separate commits is
                // quadratic in Loro).
                let overrides: Vec<Vec<MarkOverride>> = matches
                    .iter()
                    .rev()
                    .map(|range| overrides_for(doc, range.clone()))
                    .collect();
                let edits: Vec<Edit> = matches
                    .iter()
                    .rev()
                    .zip(&overrides)
                    .map(|(range, overrides)| Edit::Replace {
                        range: range.clone(),
                        text: replacement,
                        overrides,
                    })
                    .collect();
                doc.edit_batch(&edits, ORIGIN_USER);
                *sel =
                    Selection::caret(sel.chapter, matches[0].start + replacement.chars().count());
                doc.checkpoint();
            });
            // One commit is one step; a source without batches commits each
            // edit, and a slow run of them may span several steps: each needs
            // its own entry so undo reaches them all.
            let steps = self.book.chapters[chapter].doc.undo_count() - steps_before;
            for _ in 1..steps {
                self.undo_chapters.push(chapter);
            }
            if chapter == home {
                keep = self.selection;
            } else {
                self.selection = keep;
            }
        }
        if replaced > 0 {
            self.reveal_cursor();
        }
        cx.notify();
        replaced
    }

    /// Uses the selection as the query (⌘E) and tells the find bar.
    pub fn use_selection_for_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let sel = self.selection;
        if sel.is_empty() {
            return;
        }
        let text = self.selected_text();
        if text.contains('\n') {
            return;
        }
        let options = self
            .input
            .find
            .matcher
            .as_ref()
            .map(|m| m.options().clone())
            .unwrap_or_default();
        self.set_find(&text, options, window, cx);
        cx.emit(FindEvent::QueryChanged(text));
    }

    // ----- stepping -----------------------------------------------------------------------

    fn scope_chapters(&self) -> Range<usize> {
        let scope = self
            .input
            .find
            .matcher
            .as_ref()
            .map_or(FindScope::Chapter, |m| m.options().scope);
        match scope {
            FindScope::Chapter => self.selection.chapter..self.selection.chapter + 1,
            FindScope::Book => 0..self.book.chapters.len(),
        }
    }

    /// The first match at or after `from` going forward (a match starting
    /// there counts), or the last one ending at or before it going back, in
    /// scope order; then round from the other end of the scope.
    fn step(&self, from: (usize, usize), forward: bool) -> FindOutcome {
        let Some(matcher) = &self.input.find.matcher else {
            return FindOutcome::NotFound;
        };
        let wrap = matcher.options().wrap;
        let scope = self.scope_chapters();
        let (chapter, offset) = from;
        let pick = |matches: &[Range<usize>], bounded: bool| -> Option<Range<usize>> {
            if forward {
                let ix = if bounded {
                    matches.partition_point(|m| m.start < offset)
                } else {
                    0
                };
                matches.get(ix).cloned()
            } else {
                let ix = if bounded {
                    matches.partition_point(|m| m.end <= offset)
                } else {
                    matches.len()
                };
                ix.checked_sub(1).map(|ix| matches[ix].clone())
            }
        };
        // Ahead: the rest of this chapter, then the chapters after it.
        let ahead: Vec<usize> = if forward {
            (chapter..scope.end).collect()
        } else {
            (scope.start..=chapter).rev().collect()
        };
        for &c in &ahead {
            if let Some(range) = pick(&self.find_matches(c), c == chapter) {
                return FindOutcome::Found(FindHit { chapter: c, range });
            }
        }
        // Round: from the other end of the scope back to this chapter.
        let round: Vec<usize> = if forward {
            (scope.start..=chapter).collect()
        } else {
            (chapter..scope.end).rev().collect()
        };
        for &c in &round {
            if let Some(range) = pick(&self.find_matches(c), false) {
                return if wrap {
                    FindOutcome::Wrapped(FindHit { chapter: c, range })
                } else {
                    FindOutcome::PassedEnd
                };
            }
        }
        FindOutcome::NotFound
    }

    fn select_outcome(&mut self, outcome: &FindOutcome, cx: &mut Context<Self>) -> FindOutcome {
        if let Some(hit) = outcome.hit() {
            self.cancel_composition();
            self.set_selection(
                Selection::new(hit.chapter, hit.range.start, hit.range.end),
                cx,
            );
        }
        outcome.clone()
    }

    // ----- action handlers ----------------------------------------------------------------

    pub(crate) fn on_find_next(
        &mut self,
        _: &FindNext,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.find_next(window, cx);
    }

    pub(crate) fn on_find_previous(
        &mut self,
        _: &FindPrevious,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.find_previous(window, cx);
    }

    pub(crate) fn on_use_selection_for_find(
        &mut self,
        _: &UseSelectionForFind,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.use_selection_for_find(window, cx);
    }
}

/// Marks that make `replacement` look like the match's first character:
/// its inline marks set, and any expanding mark of the character before the
/// match that the match does not have cleared.
fn overrides_for(doc: &ProseDoc, range: Range<usize>) -> Vec<MarkOverride> {
    let first = doc.marks_before(range.start + 1);
    let before = doc.marks_before(range.start);
    let mut overrides: Vec<MarkOverride> = first
        .iter()
        .map(|(key, value)| (key.to_owned(), Some(value.clone())))
        .collect();
    for (key, _) in before.iter() {
        if first.get(key).is_none() {
            overrides.push((key.to_owned(), None));
        }
    }
    overrides
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find(query: &str, options: FindOptions, text: &str) -> Vec<Range<usize>> {
        Matcher::new(query, options).unwrap().find_in(text)
    }

    fn only(range: Range<usize>) -> Vec<Range<usize>> {
        std::iter::once(range).collect()
    }

    #[test]
    fn case_is_ignored_unless_asked() {
        let text = "Anna 和 anna，ANNA";
        assert_eq!(
            find("anna", FindOptions::default(), text),
            [0..4, 7..11, 12..16]
        );
        let exact = FindOptions {
            case_sensitive: true,
            ..FindOptions::default()
        };
        assert_eq!(find("anna", exact, text), only(7..11));
    }

    #[test]
    fn folding_keeps_offsets_on_whole_characters() {
        // İ lower-cases to two characters; offsets stay on the original's.
        let text = "İstanbul，istanbul";
        assert_eq!(find("istanbul", FindOptions::default(), text), only(9..17));
        assert_eq!(find("i̇stanbul", FindOptions::default(), text), only(0..8));
        // Full-width letters fold too (Ａ → ａ).
        assert_eq!(find("ａｂ", FindOptions::default(), "ＡＢ与ab"), only(0..2));
    }

    #[test]
    fn matches_do_not_overlap() {
        assert_eq!(
            find("哈哈", FindOptions::default(), "哈哈哈哈哈"),
            [0..2, 2..4]
        );
    }

    #[cfg(feature = "icu")]
    #[test]
    fn whole_words_follow_the_dictionary() {
        let whole = FindOptions {
            whole_word: true,
            ..FindOptions::default()
        };
        let text = "我们今天去公园。公园很大";
        assert_eq!(find("公园", whole.clone(), text), [5..7, 8..10]);
        assert!(find("园", whole.clone(), text).is_empty());
        assert_eq!(find("园", FindOptions::default(), text), [6..7, 9..10]);
        let latin = "cat concatenate cat.";
        assert_eq!(find("cat", whole, latin), [0..3, 16..19]);
    }

    #[test]
    fn a_line_break_or_nothing_finds_nothing() {
        assert!(Matcher::new("", FindOptions::default()).is_none());
        assert!(Matcher::new("甲\n乙", FindOptions::default()).is_none());
    }
}
