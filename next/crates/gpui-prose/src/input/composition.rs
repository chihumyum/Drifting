//! Input-method composition (marked text) and the input method's view of
//! the text.
//!
//! The marked text never reaches Loro: the editor keeps it here and shows it
//! spliced into the paragraph; only the confirmed text is written, in one
//! commit, so one undo removes the whole word. The input method sees the
//! focused chapter's committed text in UTF-16 with the marked text spliced in
//! at the anchor, hiding any selection it is typing over.
//!
//! [`Marked16`] is the coordinate mapping on its own, free of GPUI and Loro,
//! so a single-line input (dr-ui) can share it.

use std::ops::Range;

/// Marked text from the input method, shown but not yet written.
#[derive(Clone, Debug, PartialEq)]
pub struct Composition {
    pub chapter: usize,
    /// Where the marked text sits (scalar offset in the committed text).
    pub at: usize,
    /// Committed scalars after `at` that the marked text replaces once
    /// confirmed (a selection typed over). They stay in Loro until then.
    pub replaced: usize,
    pub text: String,
    /// The input method's selection inside the marked text, in bytes.
    pub selected: Range<usize>,
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
}
