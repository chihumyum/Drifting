//! Conversions between the three position units in play: Unicode scalars
//! (Loro's native unit and the editor's), UTF-8 bytes (GPUI's text layout)
//! and UTF-16 code units (the input method).

/// Byte offset of the `n`-th scalar of `s` (clamped to the end).
pub fn byte_of_char(s: &str, n: usize) -> usize {
    if n == 0 {
        return 0;
    }
    s.char_indices().nth(n).map_or(s.len(), |(i, _)| i)
}

/// Scalar offset of byte offset `byte` (clamped; must be a char boundary).
pub fn char_of_byte(s: &str, byte: usize) -> usize {
    s[..byte.min(s.len())].chars().count()
}

/// Byte offset of UTF-16 offset `units` (clamped to the end).
pub fn byte_of_utf16(s: &str, units: usize) -> usize {
    let mut count = 0;
    for (byte, ch) in s.char_indices() {
        if count >= units {
            return byte;
        }
        count += ch.len_utf16();
    }
    s.len()
}

/// UTF-16 length of the first `byte` bytes of `s`.
pub fn utf16_of_byte(s: &str, byte: usize) -> usize {
    s[..byte.min(s.len())].encode_utf16().count()
}

/// The sub-slice of `s` between two UTF-16 offsets.
pub fn utf16_slice(s: &str, start: usize, end: usize) -> &str {
    &s[byte_of_utf16(s, start)..byte_of_utf16(s, end)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let s = "a😀中";
        assert_eq!(byte_of_char(s, 0), 0);
        assert_eq!(byte_of_char(s, 1), 1);
        assert_eq!(byte_of_char(s, 2), 5);
        assert_eq!(byte_of_char(s, 9), s.len());
        assert_eq!(char_of_byte(s, 5), 2);
        assert_eq!(byte_of_utf16(s, 3), 5);
        assert_eq!(utf16_of_byte(s, 5), 3);
        assert_eq!(utf16_slice(s, 1, 4), "😀中");
    }
}
