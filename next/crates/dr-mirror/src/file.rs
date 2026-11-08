//! The authored file: a small frontmatter with the fields an author may
//! change, then the body (the 0.1 client's `markdown-mirror/authored-file.ts`).
//!
//! ```markdown
//! ---
//! drifting-id: <chapter or idea id>
//! 写作状态: 草稿
//! 摘要: "……"
//! aliases: ["雨夜"]
//! (other entries, kept as written)
//! ---
//!
//! # H1
//!
//! 正文……
//! ```
//!
//! The title is the file's name; `aliases` repeats it for Obsidian and is
//! ignored when read back. `写作状态` takes the label or the stored value;
//! an unknown value is ignored. Entries Drifting does not own (Obsidian's
//! `tags`…) are kept and written back verbatim.

/// The frontmatter key naming the chapter or idea.
pub const ID_KEY: &str = "drifting-id";
const STATUS_KEY: &str = "写作状态";
const SUMMARY_KEY: &str = "摘要";
const ALIASES_KEY: &str = "aliases";

/// Stored writing statuses and their labels (the 0.1 labels).
const STATUS_LABELS: [(&str, &str); 5] = [
    ("draft", "草稿"),
    ("finished", "已完成"),
    ("discarded", "已搁置"),
    ("drifting", "漂浮中"),
    ("resting", "休眠"),
];

/// The fields an author may change from the file.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Fields {
    /// The stored value (`draft`, `finished`, `discarded`, `drifting`,
    /// `resting`).
    pub status: String,
    pub summary: String,
    /// Frontmatter entries Drifting does not own, verbatim.
    #[serde(default)]
    pub extra: String,
}

/// What a file says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Parsed {
    /// `None` when the author removed it (or the frontmatter).
    pub id: Option<String>,
    pub status: Option<&'static str>,
    pub summary: Option<String>,
    pub extra: String,
    /// The text after the frontmatter (and the one blank line after it),
    /// line ends as `\n`.
    pub body: String,
}

/// The label a stored status is written with.
pub fn status_label(status: &str) -> &str {
    STATUS_LABELS
        .iter()
        .find(|(v, _)| *v == status)
        .map_or(status, |(_, l)| l)
}

/// The stored status for a frontmatter value: its label or its stored value.
pub fn parse_status(value: &str) -> Option<&'static str> {
    let v = value.trim();
    STATUS_LABELS
        .iter()
        .find(|(s, l)| *s == v || *l == v)
        .map(|(s, _)| *s)
}

/// The whole file.
pub fn render(id: &str, title: &str, fields: &Fields, body: &str) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("{ID_KEY}: {id}\n"));
    out.push_str(&format!("{STATUS_KEY}: {}\n", status_label(&fields.status)));
    out.push_str(&format!(
        "{SUMMARY_KEY}: {}\n",
        serde_json::to_string(&fields.summary).expect("a string serialises")
    ));
    out.push_str(&format!(
        "{ALIASES_KEY}: {}\n",
        serde_json::to_string(&[title]).expect("strings serialise")
    ));
    let extra = fields.extra.trim_end_matches('\n');
    if !extra.is_empty() {
        out.push_str(extra);
        out.push('\n');
    }
    out.push_str("---\n\n");
    out.push_str(body);
    if !body.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// The file read back; `None` when the frontmatter is broken (not closed,
/// a field Drifting owns is not a plain value). A file without frontmatter
/// is all body.
pub fn parse(raw: &str) -> Option<Parsed> {
    let text = raw
        .strip_prefix('\u{FEFF}')
        .unwrap_or(raw)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    if !text.starts_with("---\n") {
        return Some(Parsed {
            id: None,
            status: None,
            summary: None,
            extra: String::new(),
            body: text,
        });
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let close = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, l)| **l == "---" || **l == "...")
        .map(|(i, _)| i)?;
    let entries = entries(&lines[1..close])?;
    let mut parsed = Parsed {
        id: None,
        status: None,
        summary: None,
        extra: String::new(),
        body: String::new(),
    };
    let mut extra: Vec<String> = Vec::new();
    for e in entries {
        match e.key.as_str() {
            ID_KEY => {
                let v = scalar(&e)?;
                let v = v.trim();
                parsed.id = (!v.is_empty()).then(|| v.to_owned());
            }
            STATUS_KEY => parsed.status = parse_status(&scalar(&e)?),
            SUMMARY_KEY => parsed.summary = Some(scalar(&e)?),
            // Derived from the title, for Obsidian's link resolution.
            ALIASES_KEY => {}
            _ => extra.push(e.raw),
        }
    }
    parsed.extra = extra.join("\n");
    let mut start = close + 1;
    if lines.get(start) == Some(&"") {
        start += 1;
    }
    parsed.body = lines.get(start..).map(|l| l.join("\n")).unwrap_or_default();
    Some(parsed)
}

struct Entry {
    key: String,
    /// Text after `key:` on the first line.
    inline: String,
    /// Continuation lines (indented or list items).
    block: Vec<String>,
    raw: String,
}

fn entries(lines: &[&str]) -> Option<Vec<Entry>> {
    let mut out: Vec<Entry> = Vec::new();
    for line in lines {
        let blank_or_comment = line.trim().is_empty() || line.trim_start().starts_with('#');
        if blank_or_comment && out.is_empty() {
            continue;
        }
        if let Some((key, inline)) = top_level(line) {
            out.push(Entry {
                key,
                inline,
                block: Vec::new(),
                raw: (*line).to_owned(),
            });
            continue;
        }
        let last = out.last_mut()?;
        last.block.push((*line).to_owned());
        last.raw.push('\n');
        last.raw.push_str(line);
    }
    Some(out)
}

/// `key: value` at the start of a line (the 0.1 pattern
/// `^([^\s#:'"][^:]*?|"[^"]*"|'[^']*'):(?:\s(.*))?$`, not indented, not a
/// list item).
fn top_level(line: &str) -> Option<(String, String)> {
    if line.starts_with(char::is_whitespace) || line.starts_with("- ") {
        return None;
    }
    let first = line.chars().next()?;
    let (key, rest) = if first == '"' || first == '\'' {
        let end = line[1..].find(first)? + 1;
        let rest = &line[end + 1..];
        (line[1..end].to_owned(), rest)
    } else {
        if first.is_whitespace() || matches!(first, '#' | ':' | '\'' | '"') {
            return None;
        }
        let colon = line.find(':')?;
        (line[..colon].trim().to_owned(), &line[colon..])
    };
    let rest = rest.strip_prefix(':')?;
    if rest.is_empty() {
        return Some((key, String::new()));
    }
    let value = rest.strip_prefix(char::is_whitespace)?;
    Some((key, value.trim().to_owned()))
}

/// A YAML scalar value, or `None` when it is not one.
fn scalar(e: &Entry) -> Option<String> {
    let block: Vec<&str> = {
        let n = e.block.len();
        e.block
            .iter()
            .enumerate()
            .filter(|(i, l)| !l.trim().is_empty() || *i + 1 < n)
            .map(|(_, l)| l.as_str())
            .collect()
    };
    let inline = e.inline.as_str();
    let is_block_scalar = {
        let mut c = inline.chars();
        matches!(c.next(), Some('|' | '>'))
            && c.as_str()
                .trim_start_matches(['+', '-'])
                .chars()
                .all(|c| c.is_ascii_digit())
            && c.as_str()
                .chars()
                .filter(|c| matches!(c, '+' | '-'))
                .count()
                <= 1
    };
    if is_block_scalar {
        let indent = block
            .iter()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.len() - l.trim_start().len())
            .min()
            .unwrap_or(0);
        let content: Vec<&str> = block
            .iter()
            .map(|l| {
                if l.len() >= indent {
                    &l[indent..]
                } else {
                    l.trim_start()
                }
            })
            .collect();
        let joined = content.join("\n");
        let folded = if inline.starts_with('>') {
            fold(&joined)
        } else {
            joined
        };
        let keep = inline.contains('+');
        let strip = inline.contains('-');
        let trimmed = folded.trim_end_matches('\n').to_owned();
        return Some(if strip {
            trimmed
        } else if keep {
            format!("{folded}\n")
        } else if trimmed.is_empty() {
            String::new()
        } else {
            format!("{trimmed}\n")
        });
    }
    if block.iter().any(|l| l.trim_start().starts_with("- ")) {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    if !inline.is_empty() {
        parts.push(inline);
    }
    parts.extend(block.iter().map(|l| l.trim()).filter(|l| !l.is_empty()));
    let text = parts.join(" ");
    if text.starts_with('"') {
        return serde_json::from_str::<String>(&text).ok();
    }
    if let Some(inner) = text.strip_prefix('\'') {
        let inner = inner.strip_suffix('\'')?;
        // `''` is a quote; a lone `'` inside is not a scalar.
        let mut out = String::new();
        let mut chars = inner.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\'' {
                if chars.peek() == Some(&'\'') {
                    chars.next();
                    out.push('\'');
                } else {
                    return None;
                }
            } else {
                out.push(c);
            }
        }
        return Some(out);
    }
    if text.starts_with('[') || text.starts_with('{') {
        return None;
    }
    // A trailing ` # comment` goes.
    let value = match text.find(" #").or_else(|| text.find("\t#")) {
        Some(i) => &text[..i],
        None => text.as_str(),
    };
    Some(value.trim().to_owned())
}

/// YAML folding: a single line break between two non-empty lines is a space.
fn fold(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, &c) in chars.iter().enumerate() {
        if c == '\n'
            && i > 0
            && chars[i - 1] != '\n'
            && chars.get(i + 1).is_some_and(|&n| n != '\n')
        {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(status: &str, summary: &str, extra: &str) -> Fields {
        Fields {
            status: status.into(),
            summary: summary.into(),
            extra: extra.into(),
        }
    }

    #[test]
    fn a_file_round_trips() {
        let f = fields("finished", "钟停在\n四点\"十七\"", "tags: [钟]");
        let text = render("n1", "雨夜", &f, "# 一\n\n正文。");
        assert!(text.starts_with("---\ndrifting-id: n1\n写作状态: 已完成\n"));
        assert!(text.contains("aliases: [\"雨夜\"]\ntags: [钟]\n---\n\n# 一"));
        let p = parse(&text).unwrap();
        assert_eq!(p.id.as_deref(), Some("n1"));
        assert_eq!(p.status, Some("finished"));
        assert_eq!(p.summary.as_deref(), Some("钟停在\n四点\"十七\""));
        assert_eq!(p.extra, "tags: [钟]");
        assert_eq!(p.body, "# 一\n\n正文。\n");
    }

    #[test]
    fn other_editors_frontmatter_is_read() {
        let text = "\u{FEFF}---\r\ndrifting-id: 'n1'\r\n写作状态: draft\r\n摘要: >\r\n  一行\r\n  两行\r\ntags:\r\n  - a\r\n  - b\r\n---\r\n正文\r\n";
        let p = parse(text).unwrap();
        assert_eq!(p.id.as_deref(), Some("n1"));
        assert_eq!(p.status, Some("draft"));
        assert_eq!(p.summary.as_deref(), Some("一行 两行\n"));
        assert_eq!(p.extra, "tags:\n  - a\n  - b");
        assert_eq!(p.body, "正文\n");
        // Plain scalars lose a trailing comment; an unknown status is none.
        let p = parse("---\n摘要: 钟 # note\n写作状态: 不知道\n---\n").unwrap();
        assert_eq!(p.summary.as_deref(), Some("钟"));
        assert_eq!(p.status, None);
    }

    #[test]
    fn broken_frontmatter_is_refused() {
        assert!(
            parse("---\ndrifting-id: n1\n正文").is_none(),
            "never closed"
        );
        assert!(parse("---\n摘要: [a, b]\n---\n").is_none(), "not a scalar");
        assert!(parse("---\n  stray\n---\n").is_none(), "no key");
        let none = parse("正文\n").unwrap();
        assert_eq!((none.id, none.body.as_str()), (None, "正文\n"));
    }
}
