//! Drifting's word count, the rule of `@drifting/prose-metrics`
//! (`packages/prose-metrics/src/index.ts`, `countWords`) carried over
//! unchanged:
//!
//! - every CJK ideograph (U+3400–U+4DBF, U+4E00–U+9FFF) is one word;
//! - CJK ideographs, CJK symbols and punctuation (U+3000–U+303F) and
//!   halfwidth and fullwidth forms (U+FF00–U+FFEF) separate words, like
//!   whitespace;
//! - every other run between separators is one word if it holds an ASCII
//!   letter or digit, and nothing otherwise.
//!
//! Whitespace is JavaScript's `\s` (what `String.prototype.split(/\s+/)` and
//! `trim` use), not Rust's `char::is_whitespace`: U+FEFF counts, U+0085 does
//! not.
//!
//! What the rule does not count, as before: kana, hangul, Cyrillic, Greek and
//! other scripts without an ASCII letter or digit in the same run; CJK
//! ideographs outside the two blocks (extension B and later, compatibility
//! ideographs). Changing that is a product decision, not a port.
//!
//! Counts are additive over text separated by whitespace: the count of
//! paragraphs joined by `\n` is the sum of their counts.

/// A CJK ideograph that counts as one word.
pub fn is_counted_ideograph(c: char) -> bool {
    matches!(c, '\u{3400}'..='\u{4DBF}' | '\u{4E00}'..='\u{9FFF}')
}

/// A character that separates words without being one: a counted ideograph,
/// CJK symbols and punctuation, or a halfwidth / fullwidth form.
fn is_cjk_separator(c: char) -> bool {
    is_counted_ideograph(c) || matches!(c, '\u{3000}'..='\u{303F}' | '\u{FF00}'..='\u{FFEF}')
}

/// JavaScript's `\s`: WhiteSpace and LineTerminator of ECMA-262.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// The number of words in `text` (see the crate documentation).
pub fn count_words(text: &str) -> u64 {
    let mut words = 0u64;
    // Whether the current run between separators holds an ASCII letter or
    // digit.
    let mut counts = false;
    for c in text.chars() {
        if is_counted_ideograph(c) {
            words += 1 + u64::from(counts);
            counts = false;
        } else if is_cjk_separator(c) || is_js_whitespace(c) {
            words += u64::from(counts);
            counts = false;
        } else if c.is_ascii_alphanumeric() {
            counts = true;
        }
    }
    words + u64::from(counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_the_documented_cases() {
        assert_eq!(count_words(""), 0);
        assert_eq!(count_words("   \n\t"), 0);
        assert_eq!(count_words("她叫安娜。"), 4);
        assert_eq!(count_words("Hello, world"), 2);
        assert_eq!(count_words("Anna说：hello"), 3);
        assert_eq!(count_words("don't stop-me 2026"), 3);
        // A run without an ASCII letter or digit is not a word.
        assert_eq!(count_words("— … !!"), 0);
        assert_eq!(count_words("こんにちは 안녕 привет"), 0);
        assert_eq!(count_words("café naïve"), 2);
        // Fullwidth forms separate and are not words.
        assert_eq!(count_words("ＡＢＣ１２３"), 0);
        assert_eq!(count_words("a，b"), 2);
        // JavaScript whitespace, not Rust's.
        assert_eq!(count_words("a\u{FEFF}b"), 2);
        assert_eq!(count_words("a\u{0085}b"), 1);
        assert_eq!(count_words("a\u{2028}b"), 2);
    }

    #[test]
    fn counts_add_up_over_paragraphs() {
        let paragraphs = ["第一段 one", "two三", "", "end."];
        let joined = paragraphs.join("\n");
        let sum: u64 = paragraphs.iter().map(|p| count_words(p)).sum();
        assert_eq!(count_words(&joined), sum);
    }
}
