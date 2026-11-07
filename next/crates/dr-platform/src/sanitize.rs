//! Keeping manuscript text and personal paths out of crash reports, with the
//! 0.1 client's rules (`crash-sanitize.ts`): messages are cut to 300
//! characters; runs of 12 or more CJK characters, quoted spans over 40
//! characters and runs of 13 or more words become `[text]`; the home folder
//! becomes `~`.
//!
//! A Rust panic message can quote whole strings (slicing a `&str` off a char
//! boundary prints the string), so every panic message goes through this
//! before it is written or sent. It is defence in depth: code must still
//! never put prose or secrets in errors.

const MAX_MESSAGE_CHARS: usize = 300;
const CJK_RUN: usize = 12;
const QUOTED_SPAN: usize = 40;
const WORD_RUN: usize = 13;
const PLACEHOLDER: &str = "[text]";

fn is_cjk(character: char) -> bool {
    matches!(character as u32,
        0x3040..=0x30FF   // kana
        | 0x3400..=0x4DBF // CJK extension A
        | 0x4E00..=0x9FFF // CJK unified
        | 0xAC00..=0xD7AF // Hangul
        | 0xF900..=0xFAFF // compatibility ideographs
        | 0x20000..=0x2FA1F)
}

/// The home folder, as this process sees it.
fn home() -> Option<String> {
    dirs::home_dir()
        .map(|home| home.to_string_lossy().into_owned())
        .filter(|home| home.len() > 1)
}

/// The home folder replaced by `~`.
pub fn redact_home(text: &str) -> String {
    match home() {
        Some(home) => text.replace(&home, "~"),
        None => text.to_owned(),
    }
}

pub fn message(text: &str) -> String {
    let text = redact_home(text);
    let text = collapse_quoted(&text);
    let text = collapse_cjk(&text);
    let text = collapse_words(&text);
    truncate(&text, MAX_MESSAGE_CHARS)
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(limit.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

fn collapse_cjk(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = String::new();
    let mut run_chars = 0;
    let flush = |out: &mut String, run: &mut String, run_chars: &mut usize| {
        if *run_chars >= CJK_RUN {
            out.push_str(PLACEHOLDER);
        } else {
            out.push_str(run);
        }
        run.clear();
        *run_chars = 0;
    };
    for character in text.chars() {
        // CJK prose carries its own punctuation and spaces.
        let continues = is_cjk(character)
            || (run_chars > 0
                && (character.is_whitespace()
                    || "，。、；：？！…「」『』（）《》—·“”".contains(character)));
        if continues {
            run.push(character);
            if is_cjk(character) {
                run_chars += 1;
            }
        } else {
            flush(&mut out, &mut run, &mut run_chars);
            out.push(character);
        }
    }
    flush(&mut out, &mut run, &mut run_chars);
    out
}

fn collapse_quoted(text: &str) -> String {
    const PAIRS: [(char, char); 6] = [
        ('"', '"'),
        ('\'', '\''),
        ('`', '`'),
        ('“', '”'),
        ('「', '」'),
        ('『', '』'),
    ];
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < chars.len() {
        let character = chars[index];
        if let Some(&(_, close)) = PAIRS.iter().find(|(open, _)| *open == character)
            && let Some(length) = chars[index + 1..].iter().position(|c| *c == close)
            && length > QUOTED_SPAN
        {
            out.push(character);
            out.push_str(PLACEHOLDER);
            out.push(close);
            index += length + 2;
            continue;
        }
        out.push(character);
        index += 1;
    }
    out
}

fn collapse_words(text: &str) -> String {
    let is_word = |token: &str| {
        let core = token.trim_matches(|c: char| c.is_ascii_punctuation());
        !core.is_empty() && core.chars().all(char::is_alphabetic)
    };
    let tokens: Vec<&str> = text.split(' ').collect();
    let mut out: Vec<&str> = Vec::with_capacity(tokens.len());
    let mut start = 0;
    while start < tokens.len() {
        let mut end = start;
        while end < tokens.len() && is_word(tokens[end]) {
            end += 1;
        }
        if end - start >= WORD_RUN {
            out.push(PLACEHOLDER);
            start = end;
        } else if end > start {
            out.extend_from_slice(&tokens[start..end]);
            start = end;
        } else {
            out.push(tokens[start]);
            start += 1;
        }
    }
    out.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prose_in_a_slicing_panic_is_removed() {
        let prose = "他推开门，看见雨还在下，远处的灯一盏一盏地灭了。";
        let panic = format!(
            "byte index 5 is not a char boundary; it is inside '推' (bytes 3..6) of `{prose}`"
        );
        let cleaned = message(&panic);
        assert!(!cleaned.contains("远处的灯"));
        assert!(cleaned.starts_with("byte index 5 is not a char boundary"));
    }

    #[test]
    fn long_quotes_and_word_runs_become_placeholders() {
        let quoted = format!("failed on \"{}\"", "x".repeat(41));
        assert_eq!(message(&quoted), "failed on \"[text]\"");
        assert_eq!(message("short \"quote\" stays"), "short \"quote\" stays");
        let words = "the rain kept falling on the old roof while she read the letter again slowly";
        assert_eq!(
            message(&format!("panic at 3: {words}")),
            "panic at 3: [text]"
        );
        assert_eq!(
            message("called `Option::unwrap()` on a `None` value"),
            "called `Option::unwrap()` on a `None` value"
        );
    }

    #[test]
    fn short_cjk_and_identifiers_survive() {
        assert_eq!(message("章节「第一章」打不开"), "章节「第一章」打不开");
        assert_eq!(message(&"字".repeat(12)), "[text]");
    }

    #[test]
    fn messages_are_bounded_and_home_is_redacted() {
        assert!(message(&"a1 ".repeat(400)).chars().count() <= MAX_MESSAGE_CHARS);
        if let Some(home) = home() {
            assert_eq!(
                message(&format!("could not open {home}/Library/x.sqlite")),
                "could not open ~/Library/x.sqlite"
            );
        }
    }
}
