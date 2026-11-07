//! One line of text, its selection and its input-method composition: what
//! a single-line field (a title, a search box, a setting) needs. Ported from
//! dr-ui's `Composer` (F5) so the field and the editor follow one set of
//! rules; dr-ui switches to this crate in its next milestone.
//!
//! The platform speaks UTF-16 offsets (`NSTextInputClient`, IMM32); the text
//! is UTF-8. Every platform-facing call here takes and returns UTF-16 and
//! converts at the edge; everything else is in UTF-8 byte offsets.
//!
//! The rules (the same as the editor's [`crate::overlay`]):
//!
//! - While the input method composes, the marked text is shown but not
//!   committed: [`LineComposer::committed`] leaves it out and edits report
//!   [`Change::Composing`], so a field never tells its owner about half-typed
//!   pinyin.
//! - Composition replaces the selection it started on; committing it
//!   (`insertText`) or the input method's own `unmarkText` makes it real.
//! - **Losing focus discards the marked text** ([`LineComposer::blur`]), and
//!   the host tells the system input method to drop it too
//!   (`discardMarkedText`): nothing half-typed is left behind or committed.
//!   (Author's decision, 2026-11-07; dr-ui's first version committed it.)
//! - Keys that edit (backspace, arrows, submit) go to the input method first
//!   while it composes; [`LineComposer::is_composing`] lets the field ignore
//!   them.
//! - Grapheme boundaries come from the caller ([`Boundaries`]), so this crate
//!   needs no Unicode tables; [`Scalars`] steps by scalar value.

use std::ops::Range;

/// Where the cursor may stop: grapheme-cluster boundaries in the caller's
/// segmentation (ICU4X, `unicode-segmentation`, …).
pub trait Boundaries {
    /// The boundary before byte `offset` of `text` (0 at the start).
    fn prev(&self, text: &str, offset: usize) -> usize;
    /// The boundary after byte `offset` of `text` (`text.len()` at the end).
    fn next(&self, text: &str, offset: usize) -> usize;
}

/// Boundaries at every scalar value (no grapheme clustering).
#[derive(Clone, Copy, Debug, Default)]
pub struct Scalars;

impl Boundaries for Scalars {
    fn prev(&self, text: &str, offset: usize) -> usize {
        text[..offset.min(text.len())]
            .char_indices()
            .next_back()
            .map_or(0, |(i, _)| i)
    }

    fn next(&self, text: &str, offset: usize) -> usize {
        let offset = offset.min(text.len());
        text[offset..]
            .chars()
            .next()
            .map_or(text.len(), |c| offset + c.len_utf8())
    }
}

/// What an operation did to the text an owner can see.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    /// Nothing visible changed (or only the selection).
    None,
    /// Only the composition changed: the committed text is as it was.
    Composing,
    /// The committed text changed.
    Committed,
}

impl Change {
    fn or(self, other: Change) -> Change {
        match (self, other) {
            (Change::Committed, _) | (_, Change::Committed) => Change::Committed,
            (Change::Composing, _) | (_, Change::Composing) => Change::Composing,
            _ => Change::None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LineComposer {
    text: String,
    /// UTF-8 byte offsets.
    selection: Range<usize>,
    reversed: bool,
    marked: Option<Range<usize>>,
}

impl LineComposer {
    pub fn new(text: impl Into<String>) -> LineComposer {
        let text = text.into();
        let end = text.len();
        LineComposer {
            text,
            selection: end..end,
            reversed: false,
            marked: None,
        }
    }

    /// Everything shown, the composition included.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// What the owner sees: the text without the composition.
    pub fn committed(&self) -> String {
        match &self.marked {
            Some(m) => format!("{}{}", &self.text[..m.start], &self.text[m.end..]),
            None => self.text.clone(),
        }
    }

    pub fn is_composing(&self) -> bool {
        self.marked.is_some()
    }

    pub fn marked(&self) -> Option<Range<usize>> {
        self.marked.clone()
    }

    pub fn selection(&self) -> Range<usize> {
        self.selection.clone()
    }

    pub fn reversed(&self) -> bool {
        self.reversed
    }

    pub fn cursor(&self) -> usize {
        if self.reversed {
            self.selection.start
        } else {
            self.selection.end
        }
    }

    /// Replaces everything (an owner setting the value). Drops composition.
    pub fn set_text(&mut self, text: impl Into<String>) {
        *self = LineComposer::new(text);
    }

    // ── UTF-16 at the platform edge ─────────────────────────────────────

    pub fn utf16_len(&self) -> usize {
        self.text.encode_utf16().count()
    }

    pub fn to_utf16(&self, offset: usize) -> usize {
        self.text[..offset.min(self.text.len())]
            .chars()
            .map(char::len_utf16)
            .sum()
    }

    /// The UTF-8 offset of a UTF-16 offset, snapped to a char boundary.
    pub fn from_utf16(&self, offset16: usize) -> usize {
        let mut utf16 = 0;
        for (i, ch) in self.text.char_indices() {
            if utf16 >= offset16 {
                return i;
            }
            utf16 += ch.len_utf16();
        }
        self.text.len()
    }

    pub fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.to_utf16(range.start)..self.to_utf16(range.end)
    }

    pub fn range_from_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.from_utf16(range.start)..self.from_utf16(range.end)
    }

    pub fn text_for_utf16(&self, range16: Range<usize>) -> (String, Range<usize>) {
        let range = self.range_from_utf16(&range16);
        let actual = self.range_to_utf16(&range);
        (self.text[range].to_string(), actual)
    }

    pub fn selected_utf16(&self) -> Range<usize> {
        self.range_to_utf16(&self.selection)
    }

    pub fn marked_utf16(&self) -> Option<Range<usize>> {
        self.marked.as_ref().map(|m| self.range_to_utf16(m))
    }

    pub fn set_selected_utf16(&mut self, range16: Range<usize>) {
        self.selection = self.range_from_utf16(&range16);
        self.reversed = false;
    }

    /// The range an input-method call means: the one it named, else the
    /// composition, else the selection.
    fn target(&self, range16: Option<Range<usize>>) -> Range<usize> {
        range16
            .map(|r| self.range_from_utf16(&r))
            .or(self.marked.clone())
            .unwrap_or(self.selection.clone())
    }

    fn splice(&mut self, range: Range<usize>, new: &str) {
        self.text.replace_range(range, new);
    }

    /// `insertText`: commits `new` over the target range.
    pub fn replace(&mut self, range16: Option<Range<usize>>, new: &str) -> Change {
        let range = self.target(range16);
        let before = self.committed();
        self.splice(range.clone(), new);
        let end = range.start + new.len();
        self.selection = end..end;
        self.reversed = false;
        self.marked = None;
        if self.committed() == before {
            Change::Composing
        } else {
            Change::Committed
        }
    }

    /// `setMarkedText`: shows `new` as the composition over the target
    /// range, with the input method's own selection inside it.
    pub fn replace_and_mark(
        &mut self,
        range16: Option<Range<usize>>,
        new: &str,
        selected16: Option<Range<usize>>,
    ) -> Change {
        let range = self.target(range16);
        // The text the composition replaced leaves the committed text now.
        let replaced_committed = self.marked.as_ref() != Some(&range) && !range.is_empty();
        self.splice(range.clone(), new);
        self.marked = (!new.is_empty()).then(|| range.start..range.start + new.len());
        let start16 = self.to_utf16(range.start);
        let len16 = new.encode_utf16().count();
        self.selection = match selected16 {
            Some(sel) => self
                .range_from_utf16(&(start16 + sel.start.min(len16)..start16 + sel.end.min(len16))),
            None => {
                let end = range.start + new.len();
                end..end
            }
        };
        self.reversed = false;
        if replaced_committed {
            Change::Committed
        } else {
            Change::Composing
        }
    }

    /// `unmarkText`: the composition becomes ordinary text.
    pub fn unmark(&mut self) -> Change {
        if self.marked.take().is_some() {
            Change::Committed
        } else {
            Change::None
        }
    }

    /// Drops the composition (the input method cancelled it).
    pub fn discard(&mut self) -> Change {
        let Some(m) = self.marked.take() else {
            return Change::None;
        };
        let start = m.start;
        self.splice(m, "");
        self.selection = start..start;
        Change::Composing
    }

    /// Focus left: drop what was marked so nothing stays half-composed (the
    /// host also calls the system's `discardMarkedText`).
    pub fn blur(&mut self) -> Change {
        self.discard()
    }

    // ── Editing keys ────────────────────────────────────────────────────

    pub fn previous_boundary(&self, offset: usize, b: &impl Boundaries) -> usize {
        b.prev(&self.text, offset)
    }

    pub fn next_boundary(&self, offset: usize, b: &impl Boundaries) -> usize {
        b.next(&self.text, offset)
    }

    pub fn move_to(&mut self, offset: usize) {
        let offset = offset.min(self.text.len());
        self.selection = offset..offset;
        self.reversed = false;
    }

    pub fn select_to(&mut self, offset: usize) {
        let offset = offset.min(self.text.len());
        if self.reversed {
            self.selection.start = offset;
        } else {
            self.selection.end = offset;
        }
        if self.selection.end < self.selection.start {
            self.reversed = !self.reversed;
            self.selection = self.selection.end..self.selection.start;
        }
    }

    pub fn left(&mut self, b: &impl Boundaries) {
        if self.selection.is_empty() {
            self.move_to(self.previous_boundary(self.cursor(), b));
        } else {
            self.move_to(self.selection.start);
        }
    }

    pub fn right(&mut self, b: &impl Boundaries) {
        if self.selection.is_empty() {
            self.move_to(self.next_boundary(self.selection.end, b));
        } else {
            self.move_to(self.selection.end);
        }
    }

    pub fn select_left(&mut self, b: &impl Boundaries) {
        self.select_to(self.previous_boundary(self.cursor(), b));
    }

    pub fn select_right(&mut self, b: &impl Boundaries) {
        self.select_to(self.next_boundary(self.cursor(), b));
    }

    pub fn select_all(&mut self) {
        self.selection = 0..self.text.len();
        self.reversed = false;
    }

    pub fn home(&mut self) {
        self.move_to(0);
    }

    pub fn end(&mut self) {
        self.move_to(self.text.len());
    }

    pub fn backspace(&mut self, b: &impl Boundaries) -> Change {
        if self.selection.is_empty() {
            let prev = self.previous_boundary(self.cursor(), b);
            if prev == self.cursor() {
                return Change::None;
            }
            self.select_to(prev);
        }
        self.replace(None, "")
    }

    pub fn delete(&mut self, b: &impl Boundaries) -> Change {
        if self.selection.is_empty() {
            let next = self.next_boundary(self.cursor(), b);
            if next == self.cursor() {
                return Change::None;
            }
            self.select_to(next);
        }
        self.replace(None, "")
    }

    /// Typed or pasted text (newlines become spaces: one line).
    pub fn insert(&mut self, text: &str) -> Change {
        let line = text.replace(['\r', '\n'], " ");
        self.replace(None, &line).or(Change::None)
    }

    pub fn selected_text(&self) -> &str {
        &self.text[self.selection.clone()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A test segmentation: combining marks join the character before.
    struct Clusters;
    impl Boundaries for Clusters {
        fn prev(&self, text: &str, offset: usize) -> usize {
            let mut at = Scalars.prev(text, offset);
            while at > 0 && text[at..].starts_with('\u{301}') {
                at = Scalars.prev(text, at);
            }
            at
        }
        fn next(&self, text: &str, offset: usize) -> usize {
            let mut at = Scalars.next(text, offset);
            while text[at..].starts_with('\u{301}') {
                at = Scalars.next(text, at);
            }
            at
        }
    }

    #[test]
    fn pinyin_is_shown_but_not_committed_until_chosen() {
        let mut c = LineComposer::new("林");
        assert_eq!(c.replace_and_mark(None, "l", Some(1..1)), Change::Composing);
        assert_eq!(
            c.replace_and_mark(None, "lan", Some(3..3)),
            Change::Composing
        );
        assert_eq!(c.text(), "林lan");
        assert_eq!(c.committed(), "林");
        assert!(c.is_composing());
        assert_eq!(c.marked_utf16(), Some(1..4));
        assert_eq!(c.replace(None, "岚"), Change::Committed);
        assert_eq!(c.committed(), "林岚");
        assert!(!c.is_composing());
        assert_eq!(c.selected_utf16(), 2..2);
    }

    #[test]
    fn composing_over_a_selection_replaces_it() {
        let mut c = LineComposer::new("旧港雾");
        c.set_selected_utf16(1..2);
        assert_eq!(c.replace_and_mark(None, "w", Some(1..1)), Change::Committed);
        assert_eq!(c.committed(), "旧雾");
        assert_eq!(c.replace(None, "望"), Change::Committed);
        assert_eq!(c.text(), "旧望雾");
    }

    /// The unified rule: blur discards the marked text, it is not committed.
    #[test]
    fn blur_discards_the_composition() {
        let mut c = LineComposer::new("灯");
        c.replace_and_mark(None, "wu gang", Some(7..7));
        assert_eq!(c.blur(), Change::Composing);
        assert!(!c.is_composing());
        assert_eq!(c.committed(), "灯");
        assert_eq!(c.text(), "灯");
        assert_eq!(c.blur(), Change::None);
    }

    #[test]
    fn a_cancelled_composition_leaves_the_text_as_it_was() {
        let mut c = LineComposer::new("灯");
        c.replace_and_mark(None, "ta", None);
        assert_eq!(c.discard(), Change::Composing);
        assert_eq!(c.text(), "灯");
        assert_eq!(c.cursor(), "灯".len());
    }

    #[test]
    fn utf16_offsets_cross_astral_characters() {
        let c = LineComposer::new("a𠀀中");
        assert_eq!(c.utf16_len(), 4);
        assert_eq!(c.from_utf16(1), 1);
        assert_eq!(c.from_utf16(3), 5);
        assert_eq!(c.to_utf16(5), 3);
        // Inside a surrogate pair snaps to the next char boundary.
        assert_eq!(c.from_utf16(2), 5);
    }

    #[test]
    fn backspace_takes_a_whole_grapheme() {
        let mut c = LineComposer::new("e\u{301}x");
        c.left(&Clusters);
        assert_eq!(c.backspace(&Clusters), Change::Committed);
        assert_eq!(c.text(), "x");
        let mut c = LineComposer::new("e\u{301}x");
        c.left(&Scalars);
        c.backspace(&Scalars);
        assert_eq!(c.text(), "ex");
    }

    #[test]
    fn a_line_stays_one_line() {
        let mut c = LineComposer::new("");
        c.insert("第一行\n第二行");
        assert_eq!(c.text(), "第一行 第二行");
    }
}
