//! One position type for three units.
//!
//! - Loro's Rust API and its native events count **Unicode scalars**: this is
//!   the unit of every `usize` position in this crate's API.
//! - GPUI lays text out and hit-tests in **UTF-8 bytes**.
//! - Input methods (`EntityInputHandler`, macOS `NSTextInputClient`, Windows
//!   IMM32) speak **UTF-16 code units**.
//!
//! A [`TextPos`] carries all three at once, so a position converted once can be
//! handed to any of the three without converting again, and a mix-up of units
//! is a type error instead of an off-by-some bug on the first emoji or CJK
//! extension character. Build one with [`TextPos::in_str`] (paragraph-local,
//! linear) or `ProseView::pos` (document-wide, logarithmic through Loro).

use std::fmt;

/// A unit of text position.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Unit {
    /// Unicode scalar values (`char`s): Loro's unit.
    Char,
    /// UTF-8 bytes: GPUI's unit.
    Utf8,
    /// UTF-16 code units: the input method's unit.
    Utf16,
}

/// A position in all three units. Ordering compares `chars` (the three always
/// agree on order).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct TextPos {
    pub chars: usize,
    pub utf8: usize,
    pub utf16: usize,
}

impl PartialOrd for TextPos {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for TextPos {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.chars.cmp(&other.chars)
    }
}

/// Why a position could not be built.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PosError {
    /// Past the end of the text (`len` in the same unit).
    OutOfRange {
        unit: Unit,
        value: usize,
        len: usize,
    },
    /// Inside a character: a UTF-8 offset in the middle of a multi-byte
    /// sequence, or a UTF-16 offset between the two halves of a surrogate
    /// pair.
    NotABoundary { unit: Unit, value: usize },
}

impl fmt::Display for PosError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PosError::OutOfRange { unit, value, len } => {
                write!(f, "{unit:?} position {value} is past the end ({len})")
            }
            PosError::NotABoundary { unit, value } => {
                write!(f, "{unit:?} position {value} is inside a character")
            }
        }
    }
}

impl std::error::Error for PosError {}

impl TextPos {
    pub const ZERO: TextPos = TextPos {
        chars: 0,
        utf8: 0,
        utf16: 0,
    };

    pub fn get(self, unit: Unit) -> usize {
        match unit {
            Unit::Char => self.chars,
            Unit::Utf8 => self.utf8,
            Unit::Utf16 => self.utf16,
        }
    }

    /// The end of `s`.
    pub fn end_of(s: &str) -> TextPos {
        TextPos::ZERO.advance(s)
    }

    /// This position moved past `s`.
    pub fn advance(self, s: &str) -> TextPos {
        TextPos {
            chars: self.chars + s.chars().count(),
            utf8: self.utf8 + s.len(),
            utf16: self.utf16 + s.encode_utf16().count(),
        }
    }

    /// This position moved past one `c`.
    pub fn advance_char(self, c: char) -> TextPos {
        TextPos {
            chars: self.chars + 1,
            utf8: self.utf8 + c.len_utf8(),
            utf16: self.utf16 + c.len_utf16(),
        }
    }

    /// The position `value` (in `unit`) of `s`, measured from the start of
    /// `s`. Linear in the offset: meant for one paragraph or one line.
    pub fn in_str(s: &str, unit: Unit, value: usize) -> Result<TextPos, PosError> {
        let mut at = TextPos::ZERO;
        if value == 0 {
            return Ok(at);
        }
        for c in s.chars() {
            let next = at.advance_char(c);
            let n = next.get(unit);
            if n == value {
                return Ok(next);
            }
            if n > value {
                return Err(PosError::NotABoundary { unit, value });
            }
            at = next;
        }
        Err(PosError::OutOfRange {
            unit,
            value,
            len: at.get(unit),
        })
    }

    /// The offset of this position relative to `base` (both in one text).
    pub fn since(self, base: TextPos) -> TextPos {
        TextPos {
            chars: self.chars - base.chars,
            utf8: self.utf8 - base.utf8,
            utf16: self.utf16 - base.utf16,
        }
    }
}

/// Convert `value` from one unit to another within `s`.
pub fn convert_in_str(s: &str, from: Unit, value: usize, to: Unit) -> Result<usize, PosError> {
    TextPos::in_str(s, from, value).map(|p| p.get(to))
}

#[cfg(test)]
mod tests {
    use super::*;

    // "a" (1/1/1) "中" (1/3/1) "😀" (1/4/2) "\u{20000}" CJK Extension B (1/4/2) "é" (1/2/1)
    const S: &str = "a中😀\u{20000}é";

    #[test]
    fn units_agree() {
        let end = TextPos::end_of(S);
        assert_eq!(
            end,
            TextPos {
                chars: 5,
                utf8: 14,
                utf16: 7
            }
        );
        let cases = [
            (0, 0, 0),
            (1, 1, 1),
            (2, 4, 2),
            (3, 8, 4),
            (4, 12, 6),
            (5, 14, 7),
        ];
        for (c, b, u) in cases {
            let want = TextPos {
                chars: c,
                utf8: b,
                utf16: u,
            };
            assert_eq!(TextPos::in_str(S, Unit::Char, c), Ok(want));
            assert_eq!(TextPos::in_str(S, Unit::Utf8, b), Ok(want));
            assert_eq!(TextPos::in_str(S, Unit::Utf16, u), Ok(want));
        }
    }

    #[test]
    fn inside_a_character_is_an_error() {
        assert_eq!(
            TextPos::in_str(S, Unit::Utf8, 2),
            Err(PosError::NotABoundary {
                unit: Unit::Utf8,
                value: 2
            })
        );
        // Between the halves of 😀's surrogate pair.
        assert_eq!(
            TextPos::in_str(S, Unit::Utf16, 3),
            Err(PosError::NotABoundary {
                unit: Unit::Utf16,
                value: 3
            })
        );
        assert_eq!(
            TextPos::in_str(S, Unit::Char, 6),
            Err(PosError::OutOfRange {
                unit: Unit::Char,
                value: 6,
                len: 5
            })
        );
        assert_eq!(convert_in_str(S, Unit::Utf16, 4, Unit::Utf8), Ok(8));
    }

    #[test]
    fn advance_and_since() {
        let p = TextPos::ZERO.advance("中😀");
        let q = p.advance("é");
        assert_eq!(q.since(p), TextPos::end_of("é"));
        assert!(p < q);
    }
}
