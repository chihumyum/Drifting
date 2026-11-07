//! A text's shape for the Stats tab (M20): paragraphs, sentences and the
//! share of dialogue, by the 0.1 client's rules (`lib/prose-stats.ts`).
//!
//! - A paragraph is one that is not blank once JavaScript's whitespace is
//!   trimmed off.
//! - A sentence ends at a run of 。！？… or at a run of `.!?` followed by
//!   whitespace or the paragraph's end (so `3.14` does not split); a
//!   paragraph with words but no ending is still one sentence.
//! - Dialogue is what stands inside 「」, 『』, “”, ‘’ or `""` (straight single
//!   quotes are apostrophes), as a share of all the characters that are not
//!   whitespace. Each pair is read on its own over the whole text, so a
//!   quote nested in another counts twice; the share stops at 1.
//!
//! Characters are counted in UTF-16 units, as JavaScript's `length` counts
//! them, so a text reads the same share in both clients.

use prose_metrics::is_js_whitespace;

/// See the module docs.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ProseShape {
    pub paragraphs: u64,
    pub sentences: u64,
    /// 0–1.
    pub dialogue: f32,
}

/// The quote pairs read as dialogue.
const QUOTES: [(char, char); 5] = [
    ('「', '」'),
    ('『', '』'),
    ('\u{201C}', '\u{201D}'),
    ('\u{2018}', '\u{2019}'),
    ('"', '"'),
];

fn is_cjk_end(c: char) -> bool {
    matches!(c, '。' | '！' | '？' | '…')
}

fn is_latin_end(c: char) -> bool {
    matches!(c, '.' | '!' | '?')
}

/// Sentence endings in one (trimmed, non-blank) paragraph.
fn endings(text: &str) -> u64 {
    let chars: Vec<char> = text.chars().collect();
    let (mut i, mut n) = (0, 0);
    while i < chars.len() {
        let c = chars[i];
        if is_cjk_end(c) {
            while i < chars.len() && is_cjk_end(chars[i]) {
                i += 1;
            }
            n += 1;
        } else if is_latin_end(c) {
            while i < chars.len() && is_latin_end(chars[i]) {
                i += 1;
            }
            if chars.get(i).is_none_or(|c| is_js_whitespace(*c)) {
                n += 1;
            }
        } else {
            i += 1;
        }
    }
    n
}

/// UTF-16 units of `text` that are not whitespace.
fn solid_units(text: &str) -> u64 {
    text.chars()
        .filter(|c| !is_js_whitespace(*c))
        .map(|c| c.len_utf16() as u64)
        .sum()
}

/// What stands inside one quote pair, over the whole text.
fn quoted_units(text: &str, open: char, close: char) -> u64 {
    let mut total = 0;
    let mut rest = text;
    while let Some(at) = rest.find(open) {
        let after = &rest[at + open.len_utf8()..];
        let Some(end) = after.find(close) else {
            break;
        };
        total += solid_units(&after[..end]);
        rest = &after[end + close.len_utf8()..];
    }
    total
}

/// The shape of a text given paragraph by paragraph.
pub fn prose_shape<'a>(paragraphs: impl IntoIterator<Item = &'a str>) -> ProseShape {
    let blocks: Vec<&str> = paragraphs
        .into_iter()
        .map(|p| p.trim_matches(is_js_whitespace))
        .filter(|p| !p.is_empty())
        .collect();
    if blocks.is_empty() {
        return ProseShape::default();
    }
    let sentences = blocks.iter().map(|b| endings(b).max(1)).sum();
    let full = blocks.join("\n");
    let quoted: u64 = QUOTES
        .iter()
        .map(|(open, close)| quoted_units(&full, *open, *close))
        .sum();
    let total = solid_units(&full);
    ProseShape {
        paragraphs: blocks.len() as u64,
        sentences,
        dialogue: if total > 0 {
            (quoted as f64 / total as f64).min(1.0) as f32
        } else {
            0.0
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_text_has_no_shape() {
        assert_eq!(prose_shape(["", "  \u{3000}"]), ProseShape::default());
    }

    #[test]
    fn sentences_end_at_runs_and_not_inside_numbers() {
        let s = prose_shape([
            "他走了。她没回头！！",
            "Pi is 3.14. Really?! Yes",
            "没有句号",
        ]);
        assert_eq!(s.paragraphs, 3);
        // 2 + 2 ("3.14" does not end one; "Yes" has no ending) + 1.
        assert_eq!(s.sentences, 5);
        assert_eq!(endings("Wait…!"), 2);
        assert_eq!(endings("a!。"), 1);
    }

    #[test]
    fn dialogue_is_the_quoted_share() {
        // 2 quoted of 7 solid characters.
        let s = prose_shape(["她说：「走吧」"]);
        assert!((s.dialogue - 2.0 / 7.0).abs() < 1e-6);
        let s = prose_shape(["\u{201C}ab cd\u{201D}", "ef"]);
        assert!((s.dialogue - 4.0 / 8.0).abs() < 1e-6);
        // An unclosed quote reads as none; apostrophes are not quotes.
        assert_eq!(prose_shape(["「没有收尾", "it's"]).dialogue, 0.0);
        // A quote may run across paragraphs.
        assert_eq!(prose_shape(["「一", "二」"]).dialogue, 2.0 / 4.0);
    }
}
