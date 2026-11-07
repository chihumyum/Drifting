//! Composition as an overlay on a document the input method does not own.
//!
//! The editor keeps marked text here, shows it spliced into its paragraph and
//! never writes it to the document: only the confirmed text is written, in
//! one commit, so one undo removes the whole word. The input method sees the
//! committed text in UTF-16 with the marked text spliced in at the anchor,
//! hiding any selection it is typing over ([`Marked16`]).
//!
//! Positions in [`Overlay`] are in the host's own unit (the editor uses
//! Unicode scalars); [`Marked16`] is the same overlay in UTF-16.

use std::ops::Range;

use crate::units::byte_of_utf16;

/// Marked text from the input method, shown but not yet written.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Overlay {
    /// Where the marked text sits in the committed text.
    pub at: usize,
    /// Committed characters after `at` that the marked text replaces once
    /// confirmed (a selection typed over). They stay in the document until
    /// then.
    pub replaced: usize,
    pub text: String,
    /// The input method's selection inside the marked text, in bytes.
    pub selected: Range<usize>,
}

/// What a `setMarkedText` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Marking {
    /// The overlay shows the new marked text.
    Composing,
    /// The marked text was deleted to nothing: the composition is over and
    /// the committed text is untouched.
    Cancelled,
}

impl Overlay {
    /// A composition starting over `range` of the committed text (the
    /// selection, or an empty range at the caret).
    pub fn begin(range: Range<usize>) -> Overlay {
        Overlay {
            at: range.start,
            replaced: range.len(),
            text: String::new(),
            selected: 0..0,
        }
    }

    /// `setMarkedText`: the new marked text and the input method's selection
    /// inside it (UTF-16, relative to the marked text; `None` puts the caret
    /// at its end).
    pub fn mark(&mut self, text: &str, selected16: Option<Range<usize>>) -> Marking {
        if text.is_empty() {
            return Marking::Cancelled;
        }
        self.text = text.to_owned();
        self.selected = match selected16 {
            Some(range) => byte_of_utf16(text, range.start)..byte_of_utf16(text, range.end),
            None => text.len()..text.len(),
        };
        Marking::Composing
    }

    /// The input method re-targets the marked range (rare): the overlay grows
    /// to cover `range` too.
    pub fn retarget(&mut self, range: Range<usize>) {
        let end = (self.at + self.replaced).max(range.end);
        self.at = self.at.min(range.start);
        self.replaced = end - self.at;
    }

    /// The committed range the confirmed text replaces.
    pub fn target(&self) -> Range<usize> {
        self.at..self.at + self.replaced
    }

    /// Moves the overlay over an edit someone else made (another device, the
    /// Agent): `map` takes a committed position before the edit to one after.
    pub fn follow(&mut self, map: impl Fn(usize) -> usize) {
        let end = map(self.at + self.replaced);
        self.at = map(self.at);
        self.replaced = end.saturating_sub(self.at);
    }

    /// The caret inside the shown text: bytes from the start of the marked
    /// text.
    pub fn caret(&self) -> usize {
        self.selected.end
    }

    /// The overlay in UTF-16, given where `at` and `at + replaced` fall in
    /// UTF-16 units of the committed text.
    pub fn in_utf16(&self, at16: usize, end16: usize) -> Marked16 {
        Marked16 {
            at: at16,
            len: self.text.encode_utf16().count(),
            replaced: end16 - at16,
        }
    }

    /// The input method's selection, in UTF-16 units of the virtual text.
    pub fn selected_utf16(&self, at16: usize) -> Range<usize> {
        let start = self.text[..self.selected.start].encode_utf16().count();
        let end = self.text[..self.selected.end].encode_utf16().count();
        at16 + start..at16 + end
    }
}

/// The marked text in UTF-16 units of the committed text: it sits at `at`,
/// is `len` units long, and hides the `replaced` committed units after `at`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Marked16 {
    pub at: usize,
    pub len: usize,
    pub replaced: usize,
}

/// A position in the input method's (virtual) text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Virtual16 {
    /// A position in the committed text, in UTF-16 units.
    Committed(usize),
    /// A position inside the marked text, in UTF-16 units from its start.
    Marked(usize),
}

impl Marked16 {
    /// Length of the virtual text, given the committed text's length.
    pub fn virtual_len(&self, committed_len: usize) -> usize {
        committed_len - self.replaced + self.len
    }

    /// Committed → virtual. Positions inside the replaced text map to the end
    /// of the marked text.
    pub fn to_virtual(&self, committed: usize) -> usize {
        if committed <= self.at {
            committed
        } else {
            committed.saturating_sub(self.replaced).max(self.at) + self.len
        }
    }

    /// Virtual → committed or marked.
    pub fn from_virtual(&self, v: usize) -> Virtual16 {
        if v <= self.at {
            Virtual16::Committed(v)
        } else if v < self.at + self.len {
            Virtual16::Marked(v - self.at)
        } else {
            Virtual16::Committed(v - self.len + self.replaced)
        }
    }

    /// A virtual range as a committed range; positions inside the marked text
    /// map to its edges (start → `at`, end → `at + replaced`).
    pub fn range_to_committed(&self, range: Range<usize>) -> Range<usize> {
        let start = match self.from_virtual(range.start) {
            Virtual16::Committed(c) => c,
            Virtual16::Marked(_) => self.at,
        };
        let end = match self.from_virtual(range.end) {
            Virtual16::Committed(c) => c,
            Virtual16::Marked(_) => self.at + self.replaced,
        };
        start.min(end)..start.max(end)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_mapping() {
        // Committed "abcdef", marked "XY" at 2 replacing "cd".
        let m = Marked16 {
            at: 2,
            len: 2,
            replaced: 2,
        };
        assert_eq!(m.virtual_len(6), 6);
        assert_eq!(m.to_virtual(1), 1);
        assert_eq!(m.to_virtual(3), 4);
        assert_eq!(m.to_virtual(5), 5);
        assert_eq!(m.from_virtual(2), Virtual16::Committed(2));
        assert_eq!(m.from_virtual(3), Virtual16::Marked(1));
        assert_eq!(m.from_virtual(4), Virtual16::Committed(4));
        assert_eq!(m.from_virtual(6), Virtual16::Committed(6));
        assert_eq!(m.range_to_committed(3..5), 2..5);
    }

    #[test]
    fn overlay_lifecycle() {
        let mut o = Overlay::begin(3..5);
        assert_eq!(o.mark("ni", None), Marking::Composing);
        assert_eq!(o.caret(), 2);
        assert_eq!(o.target(), 3..5);
        o.follow(|p| if p >= 1 { p + 4 } else { p });
        assert_eq!(o.target(), 7..9);
        assert_eq!(o.mark("", None), Marking::Cancelled);
        let mut o = Overlay::begin(2..2);
        o.mark("你好", Some(1..1));
        assert_eq!(o.selected, 3..3);
        assert_eq!(o.selected_utf16(10), 11..11);
        assert_eq!(o.in_utf16(10, 10).len, 2);
    }
}
