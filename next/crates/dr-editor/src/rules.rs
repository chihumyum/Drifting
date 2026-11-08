//! Markdown input rules: what typed Markdown turns into.
//!
//! The rules of the 0.1 client (Tiptap's StarterKit plus Drifting's
//! `inline-markdown-rules.ts`), kept:
//!
//! - `**bold**` / `__bold__`, `*italic*` / `_italic_`, `~~strike~~` become
//!   the mark when the closing marker is typed; the markers go away and
//!   typing continues without the mark.
//! - The marked text may not start or end with a space, and does not contain
//!   the marker's character.
//! - **Chinese and Japanese prose has no spaces**, so a marker may follow any
//!   character: `他把**吸铁石**拍在桌上` and `“**吸铁石。**”` work. A single
//!   `*` or `_` (and `__`) still needs a non-word character (not an ASCII
//!   letter, digit or `_`) or a space before it, so `snake_case`, `a*b*c`
//!   and English words stay literal; `**` and `~~` may follow anything but
//!   their own character.
//! - `# `, `## `, `### ` at the start of a paragraph make it H1, H2, H3;
//!   `> ` makes it a quote.
//!
//! gpui-prose applies the result as its own undo step, so Undo right after
//! brings the literal Markdown back.

use gpui_prose::schema::{block, inline};
use gpui_prose::{InputRule, Typed};
use loro::LoroValue;

/// Inline markers, longest first so `**` is tried before `*`.
const INLINE: &[(&str, &str)] = &[
    ("**", inline::BOLD),
    ("__", inline::BOLD),
    ("~~", inline::STRIKE),
    ("*", inline::ITALIC),
    ("_", inline::ITALIC),
];

/// What `typed` turns into, if anything.
pub fn markdown_rule(typed: &Typed<'_>) -> Option<InputRule> {
    block_rule(typed).or_else(|| inline_rule(typed))
}

fn block_rule(typed: &Typed<'_>) -> Option<InputRule> {
    if !typed.typed.ends_with(' ') {
        return None;
    }
    let (key, value, level) = match typed.before {
        "# " => (block::HEADING, LoroValue::I64(1), Some(1)),
        "## " => (block::HEADING, LoroValue::I64(2), Some(2)),
        "### " => (block::HEADING, LoroValue::I64(3), Some(3)),
        "> " => (block::QUOTE, LoroValue::Bool(true), None),
        _ => return None,
    };
    if level.is_some() && typed.kind.level() == level {
        return None;
    }
    let len = typed.before.chars().count();
    Some(InputRule::Block {
        prefix: 0..len,
        key,
        value,
    })
}

/// A material note's `==text==`: the highlight (the 0.1 note's input rule,
/// here with the same CJK freedom as `**`: the marker may follow any
/// character but `=`).
pub fn highlight_rule(typed: &Typed<'_>) -> Option<InputRule> {
    if !typed.typed.ends_with('=') {
        return None;
    }
    let chars: Vec<char> = typed.before.chars().collect();
    if !chars.ends_with(&['=', '=']) {
        return None;
    }
    let close = chars.len() - 2..chars.len();
    let k = chars[..close.start].iter().rposition(|&x| x == '=')?;
    if k == 0 || chars[k - 1] != '=' {
        return None;
    }
    let (open, inner) = (k - 1..k + 1, k + 1..close.start);
    if inner.is_empty() {
        return None;
    }
    let (first, last) = (chars[inner.start], chars[inner.end - 1]);
    if first.is_whitespace() || last.is_whitespace() {
        return None;
    }
    if open.start > 0 && chars[open.start - 1] == '=' {
        return None;
    }
    Some(InputRule::Mark {
        open,
        inner,
        close,
        key: inline::HIGHLIGHT.to_owned(),
        value: crate::highlight::value(),
    })
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn inline_rule(typed: &Typed<'_>) -> Option<InputRule> {
    let chars: Vec<char> = typed.before.chars().collect();
    let last_typed = typed.typed.chars().last()?;
    for (marker, key) in INLINE {
        let m: Vec<char> = marker.chars().collect();
        let c = m[0];
        if last_typed != c || !chars.ends_with(&m) {
            continue;
        }
        let close = chars.len() - m.len()..chars.len();
        // The nearest marker character before the closing marker ends the
        // opening one (the marked text has none of it).
        let Some(k) = chars[..close.start].iter().rposition(|&x| x == c) else {
            continue;
        };
        let inner = k + 1..close.start;
        if inner.is_empty() || k + 1 < m.len() {
            continue;
        }
        let open = k + 1 - m.len()..k + 1;
        if chars[open.clone()] != m[..] {
            continue;
        }
        let (first, last) = (chars[inner.start], chars[inner.end - 1]);
        if first.is_whitespace() || last.is_whitespace() {
            continue;
        }
        if let Some(&prev) = open.start.checked_sub(1).map(|i| &chars[i]) {
            let ok = prev.is_whitespace()
                || (prev != c && (m.len() == 2 && *marker != "__" || !is_word(prev)));
            if !ok {
                continue;
            }
        }
        return Some(InputRule::Mark {
            open,
            inner,
            close,
            key: (*key).to_owned(),
            value: LoroValue::Bool(true),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_prose::text::BlockKind;

    #[test]
    fn double_equals_highlight_in_a_note() {
        let rule = |before: &str| {
            highlight_rule(&Typed {
                before,
                typed: "=",
                kind: BlockKind::Body,
            })
        };
        match rule("他==吸铁石==") {
            Some(InputRule::Mark {
                open, inner, close, ..
            }) => assert_eq!((open, inner, close), (1..3, 3..6, 6..8)),
            other => panic!("{other:?}"),
        }
        assert_eq!(rule("==  =="), None, "spaces inside");
        assert_eq!(rule("===="), None, "nothing inside");
        assert_eq!(rule("a == b"), None);
    }

    fn rule(before: &str) -> Option<InputRule> {
        let typed = &before[before.char_indices().last().map_or(0, |(i, _)| i)..];
        markdown_rule(&Typed {
            before,
            typed,
            kind: BlockKind::Body,
        })
    }

    /// The text after the rule: markers gone, the marked part in brackets.
    fn applied(before: &str) -> Option<(String, String)> {
        match rule(before)? {
            InputRule::Mark {
                open,
                inner,
                close,
                key,
                ..
            } => {
                let chars: Vec<char> = before.chars().collect();
                let s = |r: std::ops::Range<usize>| chars[r].iter().collect::<String>();
                Some((
                    format!(
                        "{}[{}]{}",
                        s(0..open.start),
                        s(inner),
                        s(close.end..chars.len())
                    ),
                    key,
                ))
            }
            InputRule::Block { .. } => None,
        }
    }

    #[test]
    fn bold_after_a_chinese_character() {
        assert_eq!(
            applied("他把**吸铁石**"),
            Some(("他把[吸铁石]".into(), "bold".into()))
        );
        assert_eq!(
            applied("“**吸铁石。**"),
            Some(("“[吸铁石。]".into(), "bold".into()))
        );
        assert_eq!(applied("**开头**"), Some(("[开头]".into(), "bold".into())));
        assert_eq!(applied("a **b**"), Some(("a [b]".into(), "bold".into())));
        assert_eq!(applied("x**y**"), Some(("x[y]".into(), "bold".into())));
    }

    #[test]
    fn italic_and_strike() {
        assert_eq!(
            applied("他*轻声*"),
            Some(("他[轻声]".into(), "italic".into()))
        );
        assert_eq!(
            applied("说~~错了~~"),
            Some(("说[错了]".into(), "strike".into()))
        );
        assert_eq!(applied("_斜_"), Some(("[斜]".into(), "italic".into())));
        assert_eq!(applied("中__粗__"), Some(("中[粗]".into(), "bold".into())));
    }

    #[test]
    fn english_words_and_spaces_stay_literal() {
        assert_eq!(applied("snake_case_"), None);
        assert_eq!(applied("a*b*"), None);
        assert_eq!(applied("a__b__"), None);
        assert_eq!(applied("** 空格**"), None);
        assert_eq!(applied("**空格 **"), None);
        assert_eq!(applied("****"), None);
        assert_eq!(applied("***"), None);
        // A single star closing a double one is not italic.
        assert_eq!(applied("**粗*"), None);
    }

    #[test]
    fn headings_and_quotes_at_the_paragraph_start() {
        for (before, key, value) in [
            ("# ", "heading", LoroValue::I64(1)),
            ("## ", "heading", LoroValue::I64(2)),
            ("### ", "heading", LoroValue::I64(3)),
            ("> ", "quote", LoroValue::Bool(true)),
        ] {
            assert_eq!(
                rule(before),
                Some(InputRule::Block {
                    prefix: 0..before.chars().count(),
                    key,
                    value
                }),
                "{before:?}"
            );
        }
        assert_eq!(rule("#### "), None);
        assert_eq!(rule("正文 # "), None);
        let same = markdown_rule(&Typed {
            before: "# ",
            typed: " ",
            kind: BlockKind::H1,
        });
        assert_eq!(same, None, "already an H1");
    }
}
