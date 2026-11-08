//! A chapter's or idea's prose as the body of its file, and back.
//!
//! One paragraph is one line; a blank line separates two paragraphs, and
//! each empty paragraph between them is one more blank line. Empty
//! paragraphs at the very start or end are not written (and an author's
//! blank lines there mean nothing). When the file is read back, every line
//! is a paragraph of its own, as authors type in plain editors (a fenced
//! code block is one unit, whose lines become paragraphs).
//!
//! - `#`, `##`, `###` are H1, H2, H3; `>` a quote; `---` a rule.
//! - Bold, italic, strike, underline and web links are written with `**`,
//!   `*`, `~~`, `<u>` and `[…](…)`; where Markdown's delimiter rules would
//!   not read a `*` or `~~` back (next to punctuation, around spaces), the
//!   HTML tags `<b>`, `<i>`, `<s>` stand in. A line break in a paragraph is
//!   `<br>`.
//! - Entity links are plain words: read back, names are linked again.
//! - A table or material is one line `<!-- drifting:embed <id> -->`: it
//!   cannot be edited in the file; deleting the line deletes it.
//! - Text is escaped so that reading what was written gives exactly the
//!   paragraphs it came from: Markdown punctuation, `&`, and the `:` / `.`
//!   that would make a bare `http://` or `www.` address a link.
//!
//! Reading uses dr-export's Markdown reader (the import's), so what an
//! author writes by hand — lists, code, tables, headings below H3 —
//! degrades as an imported file does.

use dr_doc::prose::Paragraph;
use dr_export::{Block, Run};
use dr_model::prose::{LINE_BREAK, OBJECT_CHAR};

/// The inline marks a file can carry.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Marks {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub link: Option<String>,
}

/// What a paragraph is, as far as a file can say.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    Text {
        heading: Option<u8>,
        quote: bool,
    },
    Rule {
        quote: bool,
    },
    /// A table or material embed, by embed id.
    Embed(String),
}

/// One paragraph: its kind, its characters (a line break is
/// [`LINE_BREAK`]) and each character's marks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Para {
    pub kind: Kind,
    pub chars: Vec<char>,
    pub marks: Vec<Marks>,
}

impl Para {
    pub fn empty() -> Para {
        Para {
            kind: Kind::Text {
                heading: None,
                quote: false,
            },
            chars: Vec::new(),
            marks: Vec::new(),
        }
    }

    /// A plain paragraph with no text.
    pub fn is_empty(&self) -> bool {
        self.chars.is_empty()
            && self.kind
                == Kind::Text {
                    heading: None,
                    quote: false,
                }
    }

    /// A paragraph of a prose document.
    pub fn of(p: &Paragraph) -> Para {
        if let Some(id) = p.embed() {
            return Para {
                kind: Kind::Embed(id.to_string()),
                chars: Vec::new(),
                marks: Vec::new(),
            };
        }
        let kind = if p.attrs.rule {
            Kind::Rule {
                quote: p.attrs.quote,
            }
        } else {
            Kind::Text {
                heading: p.attrs.heading.map(|h| h.level() as u8),
                quote: p.attrs.quote,
            }
        };
        let mut chars = Vec::new();
        let mut marks = Vec::new();
        for r in &p.runs {
            let m = Marks {
                bold: r.marks.bold,
                italic: r.marks.italic,
                underline: r.marks.underline,
                strike: r.marks.strike,
                link: r.marks.link.clone(),
            };
            for c in r.text.chars().filter(|&c| c != OBJECT_CHAR) {
                chars.push(c);
                // A line break shows no marks in a file.
                marks.push(if c == LINE_BREAK {
                    Marks::default()
                } else {
                    m.clone()
                });
            }
        }
        Para { kind, chars, marks }
    }

    pub fn text(&self) -> String {
        self.chars.iter().collect()
    }
}

/// The marker line of an embed.
pub fn embed_line(id: &str) -> String {
    format!("<!-- drifting:embed {id} -->")
}

fn embed_of(line: &str) -> Option<String> {
    let id = line
        .trim()
        .strip_prefix("<!-- drifting:embed ")?
        .strip_suffix(" -->")?
        .trim();
    (!id.is_empty() && !id.contains(char::is_whitespace)).then(|| id.to_owned())
}

/// The file body of `paras`.
pub fn render(paras: &[Para]) -> String {
    let first = paras.iter().position(|p| !p.is_empty());
    let last = paras.iter().rposition(|p| !p.is_empty());
    let (Some(first), Some(last)) = (first, last) else {
        return String::new();
    };
    let mut lines: Vec<String> = Vec::new();
    for p in &paras[first..=last] {
        if p.is_empty() {
            lines.push(String::new());
        } else {
            if !lines.is_empty() {
                lines.push(String::new());
            }
            lines.push(line(p));
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// One paragraph as its line.
pub fn line(p: &Para) -> String {
    match &p.kind {
        Kind::Embed(id) => embed_line(id),
        Kind::Rule { quote } => {
            if *quote {
                "> ---".into()
            } else {
                "---".into()
            }
        }
        Kind::Text { heading, quote } => {
            let mut text = inline(&p.chars, &p.marks);
            // A heading's trailing `#`s would be its closing sequence.
            if heading.is_some() && text.ends_with('#') && !text.ends_with("\\#") {
                text.insert(text.len() - 1, '\\');
            }
            let body = match heading {
                Some(h) if text.is_empty() => "#".repeat(*h as usize),
                Some(h) => format!("{} {text}", "#".repeat(*h as usize)),
                None => protect_block_prefix(&text),
            };
            if *quote { format!("> {body}") } else { body }
        }
    }
}

/// A paragraph read from a file, with the text it is compared by: the line
/// itself when the line is this one paragraph, else the paragraph written
/// out again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FilePara {
    pub key: String,
    pub para: Para,
}

/// The paragraphs of a file's body.
pub fn parse(body: &str) -> Vec<FilePara> {
    let mut lines: Vec<&str> = body.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let mut out: Vec<FilePara> = Vec::new();
    let mut blank = 0usize;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].strip_suffix('\r').unwrap_or(lines[i]);
        if line.trim().is_empty() {
            blank += 1;
            i += 1;
            continue;
        }
        // A fence keeps its lines together.
        let unit = if let Some(fence) = fence_of(line) {
            let mut end = i + 1;
            while end < lines.len() {
                let l = lines[end];
                end += 1;
                if fence_of(l).is_some_and(|f| f.0 == fence.0 && f.1 >= fence.1) {
                    break;
                }
            }
            let unit = lines[i..end].join("\n");
            i = end;
            unit
        } else {
            i += 1;
            line.to_owned()
        };
        if !out.is_empty() {
            for _ in 1..blank {
                out.push(FilePara {
                    key: String::new(),
                    para: Para::empty(),
                });
            }
        }
        blank = 0;
        if let Some(id) = embed_of(&unit) {
            out.push(FilePara {
                key: embed_line(&id),
                para: Para {
                    kind: Kind::Embed(id),
                    chars: Vec::new(),
                    marks: Vec::new(),
                },
            });
            continue;
        }
        let paras = paras_of(&dr_export::import::markdown_blocks(&unit));
        let single = paras.len() == 1;
        for para in paras {
            let key = if single {
                unit.clone()
            } else {
                self::line(&para)
            };
            out.push(FilePara { key, para });
        }
    }
    // Empty paragraphs at the end mean nothing.
    while out.last().is_some_and(|p| p.para.is_empty()) {
        out.pop();
    }
    out
}

/// A fence opener: its character and length.
fn fence_of(line: &str) -> Option<(char, usize)> {
    let lead = line.len() - line.trim_start_matches(' ').len();
    if lead > 3 {
        return None;
    }
    let rest = &line[lead..];
    let c = rest.chars().next()?;
    if c != '`' && c != '~' {
        return None;
    }
    let n = rest.chars().take_while(|&x| x == c).count();
    (n >= 3).then_some((c, n))
}

fn paras_of(blocks: &[Block]) -> Vec<Para> {
    let mut out = Vec::new();
    flatten(blocks, false, &mut out);
    out
}

fn flatten(blocks: &[Block], quote: bool, out: &mut Vec<Para>) {
    for b in blocks {
        match b {
            Block::Heading { level, runs, .. } => out.push(text_para(
                runs,
                Kind::Text {
                    heading: Some((*level).clamp(1, 3)),
                    quote,
                },
            )),
            Block::Paragraph { runs, .. } => out.push(text_para(
                runs,
                Kind::Text {
                    heading: None,
                    quote,
                },
            )),
            Block::Quote { blocks } => flatten(blocks, true, out),
            Block::Break => out.push(Para {
                kind: Kind::Rule { quote },
                chars: Vec::new(),
                marks: Vec::new(),
            }),
        }
    }
}

fn text_para(runs: &[Run], kind: Kind) -> Para {
    let mut chars = Vec::new();
    let mut marks = Vec::new();
    for r in runs {
        let m = Marks {
            bold: r.bold,
            italic: r.italic,
            underline: r.underline,
            strike: r.strike,
            link: r.href.clone(),
        };
        for c in r.text.chars() {
            let c = match c {
                '\n' => LINE_BREAK,
                OBJECT_CHAR | '\r' => continue,
                c => c,
            };
            chars.push(c);
            marks.push(if c == LINE_BREAK {
                Marks::default()
            } else {
                m.clone()
            });
        }
    }
    Para { kind, chars, marks }
}

/// The punctuation of dr-export's reader (Markdown's delimiter rules use
/// it): ASCII punctuation and the common CJK and Latin-1 marks.
fn is_punct(c: char) -> bool {
    c.is_ascii_punctuation()
        || matches!(c,
            '\u{2010}'..='\u{2027}'
            | '\u{2030}'..='\u{205E}'
            | '\u{3001}'..='\u{3003}'
            | '\u{3008}'..='\u{3011}'
            | '\u{3014}'..='\u{301F}'
            | '\u{FF01}'..='\u{FF0F}'
            | '\u{FF1A}'..='\u{FF20}'
            | '\u{FF3B}'..='\u{FF40}'
            | '\u{FF5B}'..='\u{FF65}'
            | '\u{00A1}' | '\u{00A7}' | '\u{00AB}' | '\u{00B6}' | '\u{00B7}' | '\u{00BB}' | '\u{00BF}')
}

/// Escaped text of one run of characters: Markdown punctuation, `&`, and
/// what would start a bare link.
fn escape(chars: &[char]) -> String {
    let mut out = String::with_capacity(chars.len());
    for (i, &c) in chars.iter().enumerate() {
        let lower = |k: usize| chars.get(k).map(|c| c.to_ascii_lowercase());
        let after = |word: &str, at: usize| {
            at >= word.len()
                && word
                    .chars()
                    .enumerate()
                    .all(|(k, w)| lower(at - word.len() + k) == Some(w))
        };
        let link_colon = c == ':'
            && chars.get(i + 1) == Some(&'/')
            && chars.get(i + 2) == Some(&'/')
            && (after("http", i) || after("https", i));
        let www_dot = c == '.' && after("www", i);
        // `]:` reads as a link definition to dr-export's reader.
        let label_colon = c == ':' && i > 0 && chars[i - 1] == ']';
        if matches!(
            c,
            '\\' | '`' | '*' | '_' | '[' | ']' | '~' | '<' | '|' | '&'
        ) || link_colon
            || www_dot
            || label_colon
        {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn escape_destination(href: &str) -> String {
    let mut out = String::with_capacity(href.len());
    for c in href.chars() {
        match c {
            '\\' => out.push_str("%5C"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            c if c.is_whitespace() => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).bytes() {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
            c => out.push(c),
        }
    }
    out
}

/// Whether `*`/`**`/`~~` around `inner` would be read back as delimiters,
/// with `prev` / `next` the characters just outside.
fn delimiters_hold(inner: &str, prev: Option<char>, next: Option<char>) -> bool {
    let (Some(first), Some(last)) = (inner.chars().next(), inner.chars().last()) else {
        return false;
    };
    let outside = |c: Option<char>| c.is_none_or(|c| c.is_whitespace() || is_punct(c));
    let opens = !first.is_whitespace() && (!is_punct(first) || outside(prev));
    let closes = !last.is_whitespace() && (!is_punct(last) || outside(next));
    opens && closes
}

struct Piece {
    text: Vec<char>,
    marks: Marks,
}

/// Inline Markdown of a paragraph's characters.
fn inline(chars: &[char], marks: &[Marks]) -> String {
    // Runs of equal marks; a line break is a piece of its own.
    let mut pieces: Vec<Option<Piece>> = Vec::new();
    for (c, m) in chars.iter().zip(marks) {
        if *c == LINE_BREAK {
            pieces.push(None);
            continue;
        }
        match pieces.last_mut() {
            Some(Some(p)) if p.marks == *m => p.text.push(*c),
            _ => pieces.push(Some(Piece {
                text: vec![*c],
                marks: m.clone(),
            })),
        }
    }
    let styled = |m: &Marks| m.bold || m.italic || m.strike || m.underline || m.link.is_some();
    // The character just outside each piece: a styled piece and a line
    // break begin and end with punctuation whatever their form.
    let edge = |p: &Option<Piece>, first: bool| -> char {
        match p {
            None => '<',
            Some(p) if styled(&p.marks) => '*',
            Some(p) => {
                let e = escape(&p.text);
                if first {
                    e.chars().next().unwrap_or(' ')
                } else {
                    e.chars().last().unwrap_or(' ')
                }
            }
        }
    };
    let mut out = String::new();
    for (k, piece) in pieces.iter().enumerate() {
        let Some(p) = piece else {
            out.push_str("<br>");
            continue;
        };
        let mut value = escape(&p.text);
        let m = &p.marks;
        // Inside a link or underline the delimiters touch `[`/`>`; else
        // the neighbours.
        let wrapped = m.underline || m.link.is_some();
        let prev = if wrapped {
            Some('>')
        } else {
            k.checked_sub(1).map(|j| edge(&pieces[j], false))
        };
        let next = if wrapped {
            Some('<')
        } else {
            pieces.get(k + 1).map(|q| edge(q, true))
        };
        let delims: Vec<(&str, &str)> = [
            (m.bold, "**", "b"),
            (m.italic, "*", "i"),
            (m.strike, "~~", "s"),
        ]
        .into_iter()
        .filter(|(on, _, _)| *on)
        .map(|(_, d, t)| (d, t))
        .collect();
        // `***x***` and the like are left to tags: one delimiter kind at a
        // time.
        // Nor next to a delimiter of the same character (`**a***b*` is
        // one run).
        let markdown = delims.len() <= 1
            && delims.first().is_none_or(|(d, _)| {
                delimiters_hold(&value, prev, next)
                    && (wrapped || !d.chars().next().is_some_and(|c| out.ends_with(c)))
            });
        for (d, t) in delims {
            value = if markdown {
                format!("{d}{value}{d}")
            } else {
                format!("<{t}>{value}</{t}>")
            };
        }
        if m.underline {
            value = format!("<u>{value}</u>");
        }
        if let Some(href) = &m.link {
            value = format!("[{value}]({})", escape_destination(href));
            // `!` right before it would make it an image.
            if out.ends_with('!') && !out.ends_with("\\!") {
                out.pop();
                out.push_str("\\!");
            }
        }
        out.push_str(&value);
    }
    out
}

/// Up to three leading spaces, as Markdown's block prefixes allow.
fn indent_of(value: &str) -> usize {
    value.chars().take(3).take_while(|c| *c == ' ').count()
}

/// A paragraph that would read as another block (heading, quote, list,
/// fence, rule) gets its marker escaped (dr-export's share rule).
fn protect_block_prefix(value: &str) -> String {
    let lead = indent_of(value);
    let rest = &value[lead..];
    let ws_or_end = |s: &str| s.chars().next().is_none_or(char::is_whitespace);
    let hashes = rest.chars().take_while(|&c| c == '#').count();
    if (1..=6).contains(&hashes) && ws_or_end(&rest[hashes..]) {
        return format!("{}\\{}", &value[..lead], rest);
    }
    if rest.starts_with('>') {
        return format!("{}\\{}", &value[..lead], rest);
    }
    if let Some(c) = rest.chars().next()
        && matches!(c, '-' | '+' | '*' | '=')
        && ws_or_end(&rest[1..])
    {
        return format!("{}\\{}", &value[..lead], rest);
    }
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 {
        let after = &rest[digits..];
        if let Some(d) = after.chars().next()
            && matches!(d, '.' | ')')
            && ws_or_end(&after[1..])
        {
            return format!("{}{}\\{}", &value[..lead], &rest[..digits], after);
        }
    }
    let fence = |m: char| rest.chars().take_while(|&c| c == m).count() >= 3;
    if fence('`') || fence('~') {
        return format!("\\{value}");
    }
    let trimmed = rest.trim_end();
    for m in ['-', '*', '_', '=', '+'] {
        if trimmed.chars().count() >= 3
            && trimmed.chars().all(|c| c == m || c == ' ')
            && trimmed.starts_with(m)
        {
            return format!("{}\\{}", &value[..lead], rest);
        }
    }
    value.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn text(s: &str) -> Para {
        Para {
            kind: Kind::Text {
                heading: None,
                quote: false,
            },
            chars: s.chars().collect(),
            marks: vec![Marks::default(); s.chars().count()],
        }
    }

    fn styled(parts: &[(&str, Marks)], kind: Kind) -> Para {
        let mut p = Para {
            kind,
            chars: Vec::new(),
            marks: Vec::new(),
        };
        for (s, m) in parts {
            for c in s.chars() {
                p.chars.push(c);
                p.marks.push(m.clone());
            }
        }
        p
    }

    fn back(p: &Para) -> Para {
        let got = parse(&format!("{}\n", line(p)));
        assert_eq!(got.len(), 1, "{:?} → {:?}", line(p), got);
        got.into_iter().next().unwrap().para
    }

    #[test]
    fn lines_read_back_as_written() {
        let bold = Marks {
            bold: true,
            ..Marks::default()
        };
        let italic = Marks {
            italic: true,
            ..Marks::default()
        };
        let link = Marks {
            link: Some("https://example.com/a".into()),
            underline: true,
            ..Marks::default()
        };
        let cases = [
            text("# 不是标题 1. 也不是 - 列表 * [x] <b> &amp; a_b http://x.org www.y.cn"),
            styled(
                &[
                    ("他说", Marks::default()),
                    ("「走」", bold.clone()),
                    ("。", Marks::default()),
                ],
                Kind::Text {
                    heading: Some(2),
                    quote: true,
                },
            ),
            styled(
                &[
                    ("a ", italic.clone()),
                    ("b", bold),
                    ("\u{2028}c", Marks::default()),
                    ("链接", link),
                ],
                Kind::Text {
                    heading: None,
                    quote: false,
                },
            ),
            text("---"),
            text("1) 2"),
            Para {
                kind: Kind::Rule { quote: true },
                chars: Vec::new(),
                marks: Vec::new(),
            },
        ];
        for p in cases {
            assert_eq!(back(&p), p, "{}", line(&p));
        }
    }

    #[test]
    fn blank_lines_are_separators_and_empty_paragraphs() {
        let paras = vec![
            Para::empty(),
            text("一"),
            Para::empty(),
            text("二"),
            text("三"),
            Para::empty(),
        ];
        let body = render(&paras);
        assert_eq!(body, "一\n\n\n二\n\n三\n");
        let read: Vec<Para> = parse(&body).into_iter().map(|f| f.para).collect();
        assert_eq!(read, paras[1..5].to_vec());
        // Authors' single line ends are paragraphs too; a fence is one unit.
        let read: Vec<String> = parse("甲\n乙\n\n```\nx\ny\n```\n丙")
            .into_iter()
            .map(|f| f.para.text())
            .collect();
        assert_eq!(read, ["甲", "乙", "x\u{2028}y", "丙"]);
        let embed = parse("<!-- drifting:embed t1 -->\n");
        assert_eq!(embed[0].para.kind, Kind::Embed("t1".into()));
    }

    fn marks() -> impl Strategy<Value = Marks> {
        (
            any::<bool>(),
            any::<bool>(),
            any::<bool>(),
            any::<bool>(),
            prop::option::weighted(0.1, Just("https://example.com/x".to_owned())),
        )
            .prop_map(|(bold, italic, underline, strike, link)| Marks {
                bold,
                italic,
                underline,
                strike,
                link,
            })
    }

    fn para() -> impl Strategy<Value = Para> {
        let chars = prop::sample::select(vec![
            'a', 'b', ' ', '钟', '楼', '，', '。', '「', '」', '*', '_', '~', '[', ']', '<', '>',
            '&', '#', '\\', '`', '|', '!', ':', '/', '.', '-', '(', ')', '1', LINE_BREAK,
        ]);
        let run = (prop::collection::vec(chars, 1..6), marks());
        (
            prop::collection::vec(run, 1..6),
            prop::option::of(1u8..=3),
            any::<bool>(),
        )
            .prop_map(|(runs, heading, quote)| {
                let mut p = Para {
                    kind: Kind::Text { heading, quote },
                    chars: Vec::new(),
                    marks: Vec::new(),
                };
                for (cs, m) in runs {
                    for c in cs {
                        p.chars.push(c);
                        p.marks.push(m.clone());
                    }
                }
                p
            })
    }

    /// What a paragraph can mean in Markdown: no space at either end or
    /// around a line break (Markdown trims them), no marks on spaces at a
    /// mark's edge, a line break carries no marks.
    fn normal(mut p: Para) -> Option<Para> {
        for (c, m) in p.chars.iter().zip(p.marks.iter_mut()) {
            if *c == LINE_BREAK {
                *m = Marks::default();
            }
        }
        let bad = |i: usize| p.chars.get(i).is_some_and(|c| c.is_whitespace());
        if bad(0) || bad(p.chars.len().wrapping_sub(1)) {
            return None;
        }
        for i in 0..p.chars.len() {
            if p.chars[i] == LINE_BREAK && (bad(i + 1) || (i > 0 && bad(i - 1))) {
                return None;
            }
            if p.chars[i].is_whitespace() {
                let differs = |j: usize| p.marks.get(j).is_some_and(|m| *m != p.marks[i]);
                if (i > 0 && differs(i - 1)) || differs(i + 1) {
                    return None;
                }
            }
        }
        Some(p)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]
        #[test]
        fn what_is_written_reads_back(p in para()) {
            if let Some(p) = normal(p) {
                let got = back(&p);
                prop_assert_eq!(&got, &p, "line {:?}", line(&p));
            }
        }
    }
}
