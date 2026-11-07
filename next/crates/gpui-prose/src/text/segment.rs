//! Grapheme clusters and words, in byte offsets of one paragraph's text.
//!
//! With the default `icu` feature both come from ICU4X: grapheme clusters by
//! UAX #29, words by UAX #29 plus ICU's dictionary for Chinese and Japanese
//! (「我们今天去公园」 → 我们 / 今天 / 去 / 公园). Without it a small built-in
//! approximation is used: clusters extend over combining marks, variation
//! selectors, ZWJ sequences, skin-tone modifiers, keycaps and flag pairs;
//! words are runs of one character class, a run of CJK being one word.
//!
//! The cursor moves by grapheme cluster, so 👨‍👩‍👧 or 🇨🇳 is one step and one
//! Backspace. Most prose is CJK or ASCII, where every character is its own
//! cluster; that case is answered without running a segmenter.

use std::ops::Range;

/// Byte offset of the grapheme boundary after `byte` (`text.len()` at the end).
pub fn next_grapheme(text: &str, byte: usize) -> usize {
    if byte >= text.len() {
        return text.len();
    }
    let mut chars = text[byte..].chars();
    let first = chars.next().unwrap_or(' ');
    let after = byte + first.len_utf8();
    match chars.next() {
        None => return after,
        Some(next) if simple(first) && simple(next) => return after,
        _ => {}
    }
    grapheme_boundaries(text)
        .into_iter()
        .find(|&b| b > byte)
        .unwrap_or(text.len())
}

/// Byte offset of the grapheme boundary before `byte` (0 at the start).
pub fn prev_grapheme(text: &str, byte: usize) -> usize {
    let byte = byte.min(text.len());
    if byte == 0 {
        return 0;
    }
    let mut chars = text[..byte].chars().rev();
    let last = chars.next().unwrap_or(' ');
    let before = byte - last.len_utf8();
    match chars.next() {
        None => return before,
        Some(prev) if simple(last) && simple(prev) => return before,
        _ => {}
    }
    grapheme_boundaries(text)
        .into_iter()
        .rev()
        .find(|&b| b < byte)
        .unwrap_or(0)
}

/// Snaps `byte` to the grapheme boundary at or before it.
pub fn snap_grapheme(text: &str, byte: usize) -> usize {
    let byte = byte.min(text.len());
    if byte == 0 || byte == text.len() || !text.is_char_boundary(byte) {
        let mut b = byte;
        while b > 0 && !text.is_char_boundary(b) {
            b -= 1;
        }
        if b == 0 || b == text.len() {
            return b;
        }
        return snap_grapheme(text, b);
    }
    let prev = text[..byte].chars().next_back().unwrap_or(' ');
    let next = text[byte..].chars().next().unwrap_or(' ');
    if simple(prev) && simple(next) {
        return byte;
    }
    grapheme_boundaries(text)
        .into_iter()
        .rev()
        .find(|&b| b <= byte)
        .unwrap_or(0)
}

/// A character that is always a cluster of its own next to another such
/// character: printable ASCII and the common CJK blocks. (Not a regional
/// indicator, not an extender, not a Hangul jamo, not a prepend mark.)
fn simple(c: char) -> bool {
    let u = c as u32;
    (0x20..0x7F).contains(&u)
        || matches!(u, 0x3000..=0x303F | 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
            | 0xFF01..=0xFF60 | 0x2010..=0x2027 | 0x2030..=0x205E)
}

/// The word (or space, or punctuation run) around `byte`: what a double click
/// selects. At the end of the text, the segment before it.
pub fn word_range(text: &str, byte: usize) -> Range<usize> {
    if text.is_empty() {
        return 0..0;
    }
    let segments = word_segments(text);
    let byte = byte.min(text.len());
    segments
        .iter()
        .find(|s| s.range.start <= byte && byte < s.range.end)
        .or_else(|| segments.last())
        .map_or(byte..byte, |s| s.range.clone())
}

/// Where ⌥→ goes from `byte`: the end of the next word (skipping spaces and
/// punctuation), or `None` if no word follows in this text.
pub fn next_word_end(text: &str, byte: usize) -> Option<usize> {
    word_segments(text)
        .into_iter()
        .find(|s| s.word && s.range.end > byte)
        .map(|s| s.range.end)
}

/// Where ⌥← goes from `byte`: the start of the word before (or around) it,
/// or `None` if no word precedes it in this text.
pub fn prev_word_start(text: &str, byte: usize) -> Option<usize> {
    word_segments(text)
        .into_iter()
        .rev()
        .find(|s| s.word && s.range.start < byte)
        .map(|s| s.range.start)
}

/// A segment between two word boundaries; `word` if it holds letters,
/// ideographs or digits (not spaces or punctuation).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WordSegment {
    pub range: Range<usize>,
    pub word: bool,
}

#[cfg(feature = "icu")]
mod imp {
    use super::WordSegment;
    use icu_segmenter::{
        GraphemeClusterSegmenter, WordSegmenter, WordSegmenterBorrowed,
        options::WordBreakInvariantOptions,
    };
    use std::sync::OnceLock;

    fn words() -> &'static WordSegmenterBorrowed<'static> {
        static SEGMENTER: OnceLock<WordSegmenterBorrowed<'static>> = OnceLock::new();
        SEGMENTER
            .get_or_init(|| WordSegmenter::new_dictionary(WordBreakInvariantOptions::default()))
    }

    pub fn grapheme_boundaries(text: &str) -> Vec<usize> {
        GraphemeClusterSegmenter::new().segment_str(text).collect()
    }

    pub fn word_segments(text: &str) -> Vec<WordSegment> {
        let mut out = Vec::new();
        let mut start = 0;
        for (end, kind) in words().segment_str(text).iter_with_word_type() {
            if end > start {
                out.push(WordSegment {
                    range: start..end,
                    word: kind.is_word_like(),
                });
            }
            start = end;
        }
        out
    }
}

#[cfg(not(feature = "icu"))]
mod imp {
    use super::WordSegment;

    fn extends(c: char) -> bool {
        let u = c as u32;
        matches!(u, 0x0300..=0x036F | 0x0483..=0x0489 | 0x0591..=0x05BD | 0x0610..=0x061A
            | 0x064B..=0x065F | 0x0E31 | 0x0E34..=0x0E3A | 0x0E47..=0x0E4E | 0x1AB0..=0x1AFF
            | 0x1DC0..=0x1DFF | 0x200C | 0x20D0..=0x20FF | 0x3099 | 0x309A | 0xFE00..=0xFE0F
            | 0xFE20..=0xFE2F | 0x1F3FB..=0x1F3FF | 0xE0020..=0xE007F | 0xE0100..=0xE01EF)
    }

    fn regional(c: char) -> bool {
        matches!(c as u32, 0x1F1E6..=0x1F1FF)
    }

    pub fn grapheme_boundaries(text: &str) -> Vec<usize> {
        let mut out = vec![0];
        let chars: Vec<(usize, char)> = text.char_indices().collect();
        let mut regional_run = 0;
        for (ix, &(byte, c)) in chars.iter().enumerate().skip(1) {
            let prev = chars[ix - 1].1;
            regional_run = if regional(prev) { regional_run + 1 } else { 0 };
            let join = extends(c)
                || c == '\u{200D}'
                || prev == '\u{200D}'
                || (regional(c) && regional(prev) && regional_run % 2 == 1);
            if !join {
                out.push(byte);
            }
        }
        if !text.is_empty() {
            out.push(text.len());
        }
        out
    }

    fn class(c: char) -> u8 {
        if c.is_whitespace() {
            0
        } else if crate::layout::linebreak::advance_em(c) >= 1.0 && c.is_alphanumeric() {
            1
        } else if c.is_alphanumeric() || c == '_' || c == '\'' {
            2
        } else {
            3
        }
    }

    pub fn word_segments(text: &str) -> Vec<WordSegment> {
        let mut out: Vec<WordSegment> = Vec::new();
        let mut current: Option<(usize, u8)> = None;
        for (byte, c) in text.char_indices() {
            let k = class(c);
            match current {
                Some((_, prev)) if prev == k && k != 3 => {}
                Some((start, prev)) => {
                    out.push(WordSegment {
                        range: start..byte,
                        word: prev == 1 || prev == 2,
                    });
                    current = Some((byte, k));
                }
                None => current = Some((byte, k)),
            }
        }
        if let Some((start, k)) = current {
            out.push(WordSegment {
                range: start..text.len(),
                word: k == 1 || k == 2,
            });
        }
        out
    }
}

pub use imp::{grapheme_boundaries, word_segments};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emoji_sequences_are_one_cluster() {
        let family = "a👨\u{200D}👩\u{200D}👧b";
        let after_a = 1;
        let end_family = family.len() - 1;
        assert_eq!(next_grapheme(family, after_a), end_family);
        assert_eq!(prev_grapheme(family, end_family), after_a);
        let flags = "🇨🇳🇯🇵";
        assert_eq!(next_grapheme(flags, 0), 8);
        assert_eq!(prev_grapheme(flags, flags.len()), 8);
        let accent = "e\u{0301}x";
        assert_eq!(next_grapheme(accent, 0), 3);
        let skin = "👍🏽!";
        assert_eq!(next_grapheme(skin, 0), 8);
        assert_eq!(snap_grapheme(skin, 4), 0);
    }

    #[test]
    fn cjk_and_ascii_take_the_fast_path() {
        assert_eq!(next_grapheme("天色将晚", 0), 3);
        assert_eq!(prev_grapheme("天色将晚", 6), 3);
        assert_eq!(next_grapheme("ab", 0), 1);
    }

    #[cfg(feature = "icu")]
    #[test]
    fn chinese_words_come_from_the_dictionary() {
        let text = "我们今天去公园。";
        let words: Vec<&str> = word_segments(text)
            .into_iter()
            .filter(|s| s.word)
            .map(|s| &text[s.range])
            .collect();
        assert_eq!(words, ["我们", "今天", "去", "公园"]);
        // Double click in 今天 selects 今天; ⌥→ from the start ends after 我们.
        assert_eq!(&text[word_range(text, 7)], "今天");
        assert_eq!(next_word_end(text, 0), Some(6));
        assert_eq!(prev_word_start(text, 12), Some(6));
        assert_eq!(next_word_end(text, 21), None);
    }

    #[test]
    fn latin_words_and_punctuation() {
        let text = "Hello, world";
        assert_eq!(&text[word_range(text, 1)], "Hello");
        assert_eq!(next_word_end(text, 5), Some(12));
        assert_eq!(prev_word_start(text, 7), Some(0));
    }
}
