//! Markdown → manuscript blocks: the subset of CommonMark (with the GFM
//! pieces `marked` turned on in 0.1: strikethrough, tables, autolinked
//! addresses, task markers) whose result the editor can hold.
//!
//! 0.1 ran `marked` and then the editor's schema over the HTML, so what the
//! schema lacked degraded; the same happens here:
//!
//! - ATX (`#`) and setext (`===`, `---`) headings; levels 4–6 become H3
//!   (the editor has three heading levels);
//! - blockquotes (nested ones are one quote), thematic breaks as rules;
//! - list items become paragraphs (task markers `[ ]`, `[x]` dropped);
//! - fenced and indented code becomes a paragraph, one line per line;
//! - a table's cells become paragraphs, row by row;
//! - link reference definitions are used and leave the text;
//! - inline: `**`/`__` bold, `*`/`_` italic, `~~`/`~` strike (CommonMark's
//!   delimiter rules), `[text](url)`, `[text][ref]`, `<url>` and bare
//!   `http(s)://` / `www.` addresses as links (only web and mail links keep
//!   their address), code spans as plain text, backslash escapes, a few
//!   HTML entities, `<u>`, `<s>`/`<del>`, `<b>`/`<strong>`, `<i>`/`<em>` and
//!   `<br>` (what Drifting's own Markdown share writes); other HTML stays as
//!   text; images are dropped (and counted).
//! - A line break is two spaces or a backslash at the end of a line; any
//!   other line end joins the lines with a space, or with nothing between
//!   two CJK characters (0.1 put a space there too).

use std::collections::HashMap;

use super::ImportWarning;
use crate::manuscript::{Align, Block, Run};

/// A block before its inline content is read.
enum Raw {
    Heading(u8, String),
    Para(String),
    Quote(Vec<Raw>),
    Rule,
    Code(Vec<String>),
}

type Defs = HashMap<String, String>;

pub(super) fn parse(text: &str, warnings: &mut Vec<ImportWarning>) -> Vec<Block> {
    let lines: Vec<String> = text.split('\n').map(expand_tabs).collect();
    let mut defs = Defs::new();
    let raw = blocks(&lines, &mut defs);
    let mut images = 0;
    let mut out = Vec::new();
    convert(&raw, &defs, &mut images, &mut out);
    if images > 0 {
        warnings.push(ImportWarning::ImagesDropped(images));
    }
    out
}

/// Tabs before the first other character as spaces to the next stop of 4.
fn expand_tabs(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut leading = true;
    for c in line.chars() {
        if leading && c == '\t' {
            let n = 4 - out.chars().count() % 4;
            out.extend(std::iter::repeat_n(' ', n));
        } else {
            if c != ' ' {
                leading = false;
            }
            out.push(c);
        }
    }
    out
}

fn indent(line: &str) -> usize {
    line.chars().take_while(|c| *c == ' ').count()
}

fn is_blank(line: &str) -> bool {
    line.trim().is_empty()
}

/// `***`, `- - -`, `___`: three or more of one of them, spaces between.
fn is_rule(line: &str) -> bool {
    if indent(line) > 3 {
        return false;
    }
    let s = line.trim();
    let Some(c) = s.chars().next().filter(|c| matches!(c, '-' | '*' | '_')) else {
        return false;
    };
    s.chars().all(|x| x == c || x == ' ' || x == '\t') && s.chars().filter(|x| *x == c).count() >= 3
}

/// `# Title #` → (1, "Title").
fn atx(line: &str) -> Option<(u8, String)> {
    if indent(line) > 3 {
        return None;
    }
    let s = line.trim_start();
    let hashes = s.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &s[hashes..];
    if !(rest.is_empty() || rest.starts_with(' ') || rest.starts_with('\t')) {
        return None;
    }
    let mut text = rest.trim();
    // A closing run of `#` after a space goes.
    let without = text.trim_end_matches('#');
    if without.len() < text.len() && (without.is_empty() || without.ends_with(' ')) {
        text = without.trim_end();
    }
    Some((hashes as u8, text.to_owned()))
}

/// The opening of a fenced code block: its character and length.
fn fence(line: &str) -> Option<(char, usize)> {
    if indent(line) > 3 {
        return None;
    }
    let s = line.trim_start();
    let c = s.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let n = s.chars().take_while(|x| *x == c).count();
    if n < 3 || (c == '`' && s[n..].contains('`')) {
        return None;
    }
    Some((c, n))
}

/// A list item's marker: (content column, is it ordered and not 1).
fn list_item(line: &str) -> Option<(usize, bool)> {
    let ind = indent(line);
    if ind > 3 {
        return None;
    }
    let s = &line[ind..];
    let (marker_len, late) = if s.starts_with(['-', '+', '*']) {
        (1, false)
    } else {
        let digits = s.chars().take_while(|c| c.is_ascii_digit()).count();
        if !(1..=9).contains(&digits) || !s[digits..].starts_with(['.', ')']) {
            return None;
        }
        (digits + 1, s[..digits].parse::<u64>().ok() != Some(1))
    };
    let rest = &s[marker_len..];
    if rest.is_empty() {
        return Some((ind + marker_len + 1, late));
    }
    if !rest.starts_with(' ') {
        return None;
    }
    let spaces = rest.chars().take_while(|c| *c == ' ').count();
    let pad = if spaces > 4 || rest.trim().is_empty() {
        1
    } else {
        spaces
    };
    Some((ind + marker_len + pad, late))
}

/// `[label]: destination "title"`.
fn definition(line: &str) -> Option<(String, String)> {
    if indent(line) > 3 {
        return None;
    }
    let s = line.trim();
    let rest = s.strip_prefix('[')?;
    let close = rest.find("]:")?;
    let label = normalize_label(&rest[..close]);
    if label.is_empty() {
        return None;
    }
    let after = rest[close + 2..].trim_start();
    let (dest, tail) = match after.strip_prefix('<') {
        Some(inner) => {
            let end = inner.find('>')?;
            (&inner[..end], &inner[end + 1..])
        }
        None => {
            let end = after.find(char::is_whitespace).unwrap_or(after.len());
            (&after[..end], &after[end..])
        }
    };
    if dest.is_empty() {
        return None;
    }
    let tail = tail.trim();
    let titled = tail.is_empty()
        || (tail.len() >= 2
            && ((tail.starts_with('"') && tail.ends_with('"'))
                || (tail.starts_with('\'') && tail.ends_with('\''))
                || (tail.starts_with('(') && tail.ends_with(')'))));
    titled.then(|| (label, dest.to_owned()))
}

fn normalize_label(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// `| a | b |` → ["a", "b"].
fn cells(line: &str) -> Vec<String> {
    let s = line.trim();
    let s = s.strip_prefix('|').unwrap_or(s);
    let s = s.strip_suffix('|').unwrap_or(s);
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut escaped = false;
    for c in s.chars() {
        if escaped {
            if c != '|' {
                cur.push('\\');
            }
            cur.push(c);
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '|' {
            out.push(cur.trim().to_owned());
            cur.clear();
        } else {
            cur.push(c);
        }
    }
    if escaped {
        cur.push('\\');
    }
    out.push(cur.trim().to_owned());
    out
}

/// A table's delimiter row: `|---|:--:|`.
fn is_delimiter_row(line: &str) -> bool {
    line.contains('-')
        && cells(line).iter().all(|c| {
            let c = c.trim();
            let inner = c.trim_start_matches(':').trim_end_matches(':');
            !inner.is_empty() && inner.chars().all(|x| x == '-')
        })
}

/// Lines into blocks; definitions collected into `defs`.
fn blocks(lines: &[String], defs: &mut Defs) -> Vec<Raw> {
    let mut out = Vec::new();
    let mut para: Vec<String> = Vec::new();
    // Inside a list item: its content column (deeper lines are its content).
    let mut item_col: Option<usize> = None;
    let close = |para: &mut Vec<String>, out: &mut Vec<Raw>| {
        if !para.is_empty() {
            out.push(Raw::Para(para.join("\n")));
            para.clear();
        }
    };
    let mut i = 0;
    while i < lines.len() {
        let mut line: &str = &lines[i];
        if is_blank(line) {
            close(&mut para, &mut out);
            i += 1;
            continue;
        }
        // A list item's continuation: drop its indentation.
        if let Some(col) = item_col {
            if indent(line) >= col {
                line = &line[col..];
            } else if list_item(line).is_none() && para.is_empty() {
                item_col = None;
            }
        }
        // Setext underline.
        if !para.is_empty() && indent(line) <= 3 {
            let t = line.trim();
            if !t.is_empty() && (t.chars().all(|c| c == '=') || t.chars().all(|c| c == '-')) {
                let level = if t.starts_with('=') { 1 } else { 2 };
                out.push(Raw::Heading(level, para.join("\n")));
                para.clear();
                i += 1;
                continue;
            }
        }
        if para.is_empty() && indent(line) >= 4 {
            let mut code = Vec::new();
            while i < lines.len() {
                let l: &str = &lines[i];
                let l = match item_col {
                    Some(col) if indent(l) >= col => &l[col..],
                    _ => l,
                };
                if is_blank(l) {
                    code.push(String::new());
                } else if indent(l) >= 4 {
                    code.push(l[4..].to_owned());
                } else {
                    break;
                }
                i += 1;
            }
            while code.last().is_some_and(String::is_empty) {
                code.pop();
            }
            out.push(Raw::Code(code));
            continue;
        }
        if let Some((c, n)) = fence(line) {
            close(&mut para, &mut out);
            let pad = indent(line);
            let mut code = Vec::new();
            i += 1;
            while i < lines.len() {
                let l: &str = &lines[i];
                let t = l.trim();
                if indent(l) <= 3
                    && t.chars().take_while(|x| *x == c).count() >= n
                    && t.chars().all(|x| x == c)
                {
                    i += 1;
                    break;
                }
                let strip = indent(l).min(pad);
                code.push(l[strip..].to_owned());
                i += 1;
            }
            out.push(Raw::Code(code));
            continue;
        }
        if let Some((level, text)) = atx(line) {
            close(&mut para, &mut out);
            out.push(Raw::Heading(level, text));
            i += 1;
            continue;
        }
        if is_rule(line) {
            close(&mut para, &mut out);
            out.push(Raw::Rule);
            i += 1;
            continue;
        }
        if indent(line) <= 3 && line.trim_start().starts_with('>') {
            close(&mut para, &mut out);
            let mut inner: Vec<String> = Vec::new();
            while i < lines.len() {
                let l: &str = &lines[i];
                let t = l.trim_start();
                if indent(l) <= 3 && t.starts_with('>') {
                    let rest = &t[1..];
                    inner.push(rest.strip_prefix(' ').unwrap_or(rest).to_owned());
                } else if !is_blank(l)
                    && inner.last().is_some_and(|x| !is_blank(x))
                    && fence(l).is_none()
                    && atx(l).is_none()
                    && !is_rule(l)
                    && list_item(l).is_none()
                {
                    // A lazy continuation of the quoted paragraph.
                    inner.push(l.trim_start().to_owned());
                } else {
                    break;
                }
                i += 1;
            }
            out.push(Raw::Quote(blocks(&inner, defs)));
            continue;
        }
        if let Some((col, late)) = list_item(line)
            && !(late && !para.is_empty())
        {
            close(&mut para, &mut out);
            let content = line.get(col.min(line.len())..).unwrap_or("");
            let content = content.trim_start();
            let content = ["[ ] ", "[x] ", "[X] "]
                .iter()
                .find_map(|m| content.strip_prefix(m))
                .unwrap_or(content);
            // Columns stripped off this line already (a nested item).
            let stripped = lines[i].len() - line.len();
            item_col = Some(stripped + col);
            if !content.trim().is_empty() {
                para.push(content.to_owned());
            }
            i += 1;
            continue;
        }
        if para.is_empty() {
            if let Some((label, dest)) = definition(line) {
                defs.entry(label).or_insert(dest);
                i += 1;
                continue;
            }
            // A table: a row, then its delimiter row with as many cells.
            if line.contains('|')
                && i + 1 < lines.len()
                && is_delimiter_row(&lines[i + 1])
                && cells(&lines[i + 1]).len() == cells(line).len()
            {
                let mut rows = vec![cells(line)];
                i += 2;
                while i < lines.len() && !is_blank(&lines[i]) && lines[i].contains('|') {
                    rows.push(cells(&lines[i]));
                    i += 1;
                }
                for cell in rows.into_iter().flatten() {
                    if !cell.is_empty() {
                        out.push(Raw::Para(cell));
                    }
                }
                continue;
            }
        }
        para.push(line.trim_start().to_owned());
        i += 1;
    }
    close(&mut para, &mut out);
    out
}

fn convert(raw: &[Raw], defs: &Defs, images: &mut usize, out: &mut Vec<Block>) {
    for r in raw {
        match r {
            Raw::Heading(level, text) => {
                let runs = inline(text, defs, images);
                if runs.iter().any(|r| !r.text.trim().is_empty()) {
                    out.push(Block::Heading {
                        level: (*level).min(3),
                        runs,
                        align: Align::Justify,
                    });
                }
            }
            Raw::Para(text) => {
                let runs = inline(text, defs, images);
                if runs.iter().any(|r| !r.text.trim().is_empty()) {
                    out.push(Block::Paragraph {
                        runs,
                        align: Align::Justify,
                        indent: 0,
                    });
                }
            }
            Raw::Quote(inner) => {
                let mut blocks = Vec::new();
                convert(inner, defs, images, &mut blocks);
                // The editor's quote is a paragraph flag: nested quotes are
                // one quote.
                let flat: Vec<Block> = blocks
                    .into_iter()
                    .flat_map(|b| match b {
                        Block::Quote { blocks } => blocks,
                        other => vec![other],
                    })
                    .collect();
                if !flat.is_empty() {
                    out.push(Block::Quote { blocks: flat });
                }
            }
            Raw::Rule => out.push(Block::Break),
            Raw::Code(lines) => {
                let text = lines.join("\n");
                if !text.trim().is_empty() {
                    out.push(Block::Paragraph {
                        runs: vec![Run {
                            text,
                            ..Run::default()
                        }],
                        align: Align::Justify,
                        indent: 0,
                    });
                }
            }
        }
    }
}

// ---- inline -------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Marks {
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    href: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tag {
    Bold,
    Italic,
    Underline,
    Strike,
}

#[derive(Clone, Debug)]
enum Node {
    Text(String, Marks),
    Delim {
        ch: char,
        len: usize,
        orig: usize,
        open: bool,
        close: bool,
        marks: Marks,
    },
    /// An HTML tag the editor understands; `literal` if it stays unmatched.
    Html {
        tag: Tag,
        opening: bool,
        literal: String,
        matched: bool,
        marks: Marks,
    },
    Break,
}

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

/// Wide (CJK) characters: a line end between two of them joins without a
/// space.
fn is_wide(c: char) -> bool {
    matches!(c,
        '\u{1100}'..='\u{11FF}'
        | '\u{2E80}'..='\u{9FFF}'
        | '\u{AC00}'..='\u{D7AF}'
        | '\u{F900}'..='\u{FAFF}'
        | '\u{FE30}'..='\u{FE4F}'
        | '\u{FF00}'..='\u{FFEF}'
        | '\u{20000}'..='\u{3FFFF}')
}

fn entity(name: &str) -> Option<char> {
    if let Some(num) = name.strip_prefix('#') {
        let code = match num.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, 16).ok()?,
            None => num.parse().ok()?,
        };
        return char::from_u32(code).filter(|c| *c != '\0');
    }
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => '\u{A0}',
        "copy" => '©',
        "reg" => '®',
        "mdash" => '—',
        "ndash" => '–',
        "hellip" => '…',
        "ldquo" => '“',
        "rdquo" => '”',
        "lsquo" => '‘',
        "rsquo" => '’',
        "middot" => '·',
        _ => return None,
    })
}

fn html_tag(s: &str) -> Option<(Option<(Tag, bool)>, usize)> {
    // Returns the tag (None for <br>) and the length consumed.
    let end = s.find('>')?;
    let inner = s[1..end].trim();
    let (closing, name) = match inner.strip_prefix('/') {
        Some(n) => (true, n.trim()),
        None => (false, inner.trim_end_matches('/').trim()),
    };
    let lower = name.to_ascii_lowercase();
    let tag = match lower.as_str() {
        "br" if !closing => return Some((None, end + 1)),
        "b" | "strong" => Tag::Bold,
        "i" | "em" => Tag::Italic,
        "u" | "ins" => Tag::Underline,
        "s" | "del" | "strike" => Tag::Strike,
        _ => return None,
    };
    Some((Some((tag, !closing)), end + 1))
}

/// Where the `]` closing the bracket opened at `open` is (escapes and code
/// spans skipped, nested brackets balanced).
fn closing_bracket(c: &[char], open: usize) -> Option<usize> {
    let mut depth = 0;
    let mut i = open;
    while i < c.len() {
        match c[i] {
            '\\' => i += 1,
            '`' => {
                let n = c[i..].iter().take_while(|x| **x == '`').count();
                if let Some(end) = code_span_end(c, i, n) {
                    i = end - 1;
                } else {
                    i += n - 1;
                }
            }
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The index after a code span opened by `n` backticks at `at`.
fn code_span_end(c: &[char], at: usize, n: usize) -> Option<usize> {
    let mut i = at + n;
    while i < c.len() {
        if c[i] == '`' {
            let m = c[i..].iter().take_while(|x| **x == '`').count();
            if m == n {
                return Some(i + m);
            }
            i += m;
        } else {
            i += 1;
        }
    }
    None
}

/// `(destination "title")` after a link's text: (href, index after `)`).
fn inline_destination(c: &[char], at: usize) -> Option<(String, usize)> {
    if c.get(at) != Some(&'(') {
        return None;
    }
    let mut i = at + 1;
    while i < c.len() && c[i].is_whitespace() {
        i += 1;
    }
    let mut dest = String::new();
    if c.get(i) == Some(&'<') {
        i += 1;
        while i < c.len() && c[i] != '>' {
            if c[i] == '\n' {
                return None;
            }
            dest.push(c[i]);
            i += 1;
        }
        i += 1;
    } else {
        let mut depth = 0;
        while i < c.len() && !c[i].is_whitespace() {
            match c[i] {
                '\\' if i + 1 < c.len() && c[i + 1].is_ascii_punctuation() => {
                    dest.push(c[i + 1]);
                    i += 2;
                    continue;
                }
                '(' => depth += 1,
                ')' if depth == 0 => break,
                ')' => depth -= 1,
                _ => {}
            }
            dest.push(c[i]);
            i += 1;
        }
    }
    while i < c.len() && c[i].is_whitespace() {
        i += 1;
    }
    // An optional title.
    if let Some(&q) = c.get(i).filter(|q| matches!(q, '"' | '\'' | '(')) {
        let end = if q == '(' { ')' } else { q };
        i += 1;
        while i < c.len() && c[i] != end {
            if c[i] == '\\' {
                i += 1;
            }
            i += 1;
        }
        i += 1;
        while i < c.len() && c[i].is_whitespace() {
            i += 1;
        }
    }
    (c.get(i) == Some(&')')).then_some((dest, i + 1))
}

/// A bare `http://`, `https://` or `www.` address starting at `at`.
fn bare_link(c: &[char], at: usize) -> Option<(String, String, usize)> {
    let starts = |p: &str| {
        p.chars()
            .enumerate()
            .all(|(k, x)| c.get(at + k).is_some_and(|y| y.eq_ignore_ascii_case(&x)))
    };
    let www = starts("www.");
    if !(starts("http://") || starts("https://") || www) {
        return None;
    }
    if at > 0 && (c[at - 1].is_alphanumeric() || matches!(c[at - 1], '/' | ':' | '@')) {
        return None;
    }
    let mut end = at;
    while end < c.len() && !c[end].is_whitespace() && c[end] != '<' && !is_wide(c[end]) {
        end += 1;
    }
    // Trailing punctuation is not part of it; nor an unbalanced `)`.
    while let Some(&last) = c[at..end].last() {
        let opens = c[at..end].iter().filter(|x| **x == '(').count();
        let closes = c[at..end].iter().filter(|x| **x == ')').count();
        if matches!(
            last,
            '?' | '!' | '.' | ',' | ':' | '*' | '_' | '~' | '\'' | '"' | ';'
        ) || (last == ')' && closes > opens)
        {
            end -= 1;
        } else {
            break;
        }
    }
    let text: String = c[at..end].iter().collect();
    let min = if www { 5 } else { 9 };
    if text.chars().count() < min {
        return None;
    }
    let href = if www {
        format!("http://{text}")
    } else {
        text.clone()
    };
    Some((text, href, end))
}

fn keep_href(href: &str) -> Option<String> {
    let h = href.trim();
    crate::manuscript::exported_link(h).then(|| h.to_owned())
}

/// One paragraph's (or heading's) text as runs; `\n` in the source is a
/// line end, `\n` in a run a line break.
fn inline(src: &str, defs: &Defs, images: &mut usize) -> Vec<Run> {
    let nodes = nodes(src, defs, images, &Marks::default());
    flatten(nodes)
}

fn nodes(src: &str, defs: &Defs, images: &mut usize, base: &Marks) -> Vec<Node> {
    let c: Vec<char> = src.chars().collect();
    let mut out: Vec<Node> = Vec::new();
    let mut text = String::new();
    let flush = |text: &mut String, out: &mut Vec<Node>| {
        if !text.is_empty() {
            out.push(Node::Text(std::mem::take(text), base.clone()));
        }
    };
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        match ch {
            '\\' => {
                match c.get(i + 1) {
                    Some('\n') => {
                        flush(&mut text, &mut out);
                        out.push(Node::Break);
                        i += 2;
                        while i < c.len() && c[i] == ' ' {
                            i += 1;
                        }
                        continue;
                    }
                    Some(&n) if n.is_ascii_punctuation() => {
                        text.push(n);
                        i += 2;
                        continue;
                    }
                    _ => text.push('\\'),
                }
                i += 1;
            }
            '`' => {
                let n = c[i..].iter().take_while(|x| **x == '`').count();
                match code_span_end(&c, i, n) {
                    Some(end) => {
                        let inner: String = c[i + n..end - n]
                            .iter()
                            .map(|x| if *x == '\n' { ' ' } else { *x })
                            .collect();
                        let inner = if inner.len() >= 2
                            && inner.starts_with(' ')
                            && inner.ends_with(' ')
                            && !inner.trim().is_empty()
                        {
                            inner[1..inner.len() - 1].to_owned()
                        } else {
                            inner
                        };
                        text.push_str(&inner);
                        i = end;
                    }
                    None => {
                        text.extend(std::iter::repeat_n('`', n));
                        i += n;
                    }
                }
            }
            '\n' => {
                // A line end: two spaces before it make a line break.
                let spaces = text.chars().rev().take_while(|x| *x == ' ').count();
                let trimmed_len = text.trim_end_matches(' ').len();
                text.truncate(trimmed_len);
                let prev = text.chars().last().or_else(|| last_char(&out));
                i += 1;
                while i < c.len() && c[i] == ' ' {
                    i += 1;
                }
                if spaces >= 2 {
                    flush(&mut text, &mut out);
                    out.push(Node::Break);
                } else {
                    let next = c.get(i).copied();
                    let join =
                        matches!((prev, next), (Some(p), Some(n)) if is_wide(p) && is_wide(n));
                    if !join {
                        text.push(' ');
                    }
                }
            }
            '<' => {
                let rest: String = c[i..].iter().take(512).collect();
                // An autolink.
                if let Some(end) = rest.find('>') {
                    let inner = &rest[1..end];
                    let scheme = inner.split_once(':').is_some_and(|(s, _)| {
                        s.len() >= 2
                            && s.chars().next().is_some_and(|x| x.is_ascii_alphabetic())
                            && s.chars()
                                .all(|x| x.is_ascii_alphanumeric() || matches!(x, '+' | '.' | '-'))
                    });
                    let email = !scheme
                        && inner.contains('@')
                        && !inner.contains(char::is_whitespace)
                        && inner
                            .split_once('@')
                            .is_some_and(|(a, b)| !a.is_empty() && b.contains('.'));
                    if (scheme || email)
                        && !inner.contains(char::is_whitespace)
                        && !inner.contains('<')
                    {
                        flush(&mut text, &mut out);
                        let href = if email {
                            format!("mailto:{inner}")
                        } else {
                            inner.to_owned()
                        };
                        let mut m = base.clone();
                        if m.href.is_none() {
                            m.href = keep_href(&href);
                        }
                        out.push(Node::Text(inner.to_owned(), m));
                        i += inner.chars().count() + 2;
                        continue;
                    }
                }
                if let Some((tag, len)) = html_tag(&rest) {
                    flush(&mut text, &mut out);
                    let literal: String = rest.chars().take(len).collect();
                    match tag {
                        None => out.push(Node::Break),
                        Some((tag, opening)) => out.push(Node::Html {
                            tag,
                            opening,
                            literal: literal.clone(),
                            matched: false,
                            marks: base.clone(),
                        }),
                    }
                    i += literal.chars().count();
                    continue;
                }
                text.push('<');
                i += 1;
            }
            '!' if c.get(i + 1) == Some(&'[') => {
                if let Some(close) = closing_bracket(&c, i + 1) {
                    let dest = inline_destination(&c, close + 1)
                        .map(|(_, e)| e)
                        .or_else(|| {
                            let label: String = c[i + 2..close].iter().collect();
                            reference(&c, close, &label, defs).map(|(_, e)| e)
                        });
                    if let Some(end) = dest {
                        *images += 1;
                        i = end;
                        continue;
                    }
                }
                text.push('!');
                i += 1;
            }
            '[' => {
                if let Some(close) = closing_bracket(&c, i) {
                    let label: String = c[i + 1..close].iter().collect();
                    let target = inline_destination(&c, close + 1)
                        .or_else(|| reference(&c, close, &label, defs));
                    if let Some((href, end)) = target {
                        flush(&mut text, &mut out);
                        let mut m = base.clone();
                        if m.href.is_none() {
                            m.href = keep_href(&href);
                        }
                        // Delimiters inside a link's text match only there.
                        let inner = nodes(&label, defs, images, &m);
                        out.extend(literal(inner));
                        i = end;
                        continue;
                    }
                }
                text.push('[');
                i += 1;
            }
            '*' | '_' | '~' => {
                flush(&mut text, &mut out);
                let n = c[i..].iter().take_while(|x| **x == ch).count();
                let prev = if i == 0 { None } else { Some(c[i - 1]) };
                let next = c.get(i + n).copied();
                let white = |x: Option<char>| x.is_none_or(char::is_whitespace);
                let punct = |x: Option<char>| x.is_some_and(is_punct);
                let left = !white(next) && (!punct(next) || white(prev) || punct(prev));
                let right = !white(prev) && (!punct(prev) || white(next) || punct(next));
                let (open, close) = match ch {
                    '_' => (
                        left && (!right || punct(prev)),
                        right && (!left || punct(next)),
                    ),
                    _ => (left, right),
                };
                // Strike is one or two tildes only.
                let usable = ch != '~' || n <= 2;
                out.push(Node::Delim {
                    ch,
                    len: n,
                    orig: n,
                    open: open && usable,
                    close: close && usable,
                    marks: base.clone(),
                });
                i += n;
            }
            '&' => {
                let rest: String = c[i + 1..].iter().take(12).collect();
                if let Some(semi) = rest.find(';')
                    && let Some(decoded) = entity(&rest[..semi])
                {
                    text.push(decoded);
                    i += rest[..semi].chars().count() + 2;
                    continue;
                }
                text.push('&');
                i += 1;
            }
            _ => {
                if base.href.is_none()
                    && let Some((shown, href, end)) = bare_link(&c, i)
                {
                    flush(&mut text, &mut out);
                    let mut m = base.clone();
                    m.href = keep_href(&href);
                    out.push(Node::Text(shown, m));
                    i = end;
                    continue;
                }
                text.push(ch);
                i += 1;
            }
        }
    }
    flush(&mut text, &mut out);
    resolve(out)
}

/// A reference link after `]` at `close`: `[text][ref]`, `[text][]` or
/// `[text]`.
fn reference(c: &[char], close: usize, label: &str, defs: &Defs) -> Option<(String, usize)> {
    if c.get(close + 1) == Some(&'[')
        && let Some(end) = c[close + 2..].iter().position(|x| *x == ']')
    {
        let r: String = c[close + 2..close + 2 + end].iter().collect();
        let key = if r.trim().is_empty() {
            normalize_label(label)
        } else {
            normalize_label(&r)
        };
        return defs.get(&key).map(|h| (h.clone(), close + 3 + end));
    }
    defs.get(&normalize_label(label))
        .map(|h| (h.clone(), close + 1))
}

fn last_char(nodes: &[Node]) -> Option<char> {
    nodes.iter().rev().find_map(|n| match n {
        Node::Text(t, _) => t.chars().last(),
        Node::Delim { ch, .. } => Some(*ch),
        _ => None,
    })
}

fn add(m: &mut Marks, tag: Tag) {
    match tag {
        Tag::Bold => m.bold = true,
        Tag::Italic => m.italic = true,
        Tag::Underline => m.underline = true,
        Tag::Strike => m.strike = true,
    }
}

fn marks_of(n: &mut Node) -> Option<&mut Marks> {
    match n {
        Node::Text(_, m) | Node::Delim { marks: m, .. } | Node::Html { marks: m, .. } => Some(m),
        Node::Break => None,
    }
}

/// CommonMark's emphasis processing, then the HTML tags; what stays
/// unmatched is literal text.
fn resolve(mut nodes: Vec<Node>) -> Vec<Node> {
    let mut ci = 0;
    while ci < nodes.len() {
        let (ch, can_close, clen, corig, copen) = match &nodes[ci] {
            Node::Delim {
                ch,
                len,
                orig,
                open,
                close,
                ..
            } if *close && *len > 0 => (*ch, *close, *len, *orig, *open),
            _ => {
                ci += 1;
                continue;
            }
        };
        debug_assert!(can_close);
        let opener = (0..ci).rev().find(|&oi| match &nodes[oi] {
            Node::Delim {
                ch: c2,
                len,
                orig,
                open,
                close,
                ..
            } if *c2 == ch && *open && *len > 0 => {
                if ch == '~' {
                    return *len == clen;
                }
                let both = *close || copen;
                !(both && (orig + corig) % 3 == 0 && !(orig % 3 == 0 && corig % 3 == 0))
            }
            _ => false,
        });
        let Some(oi) = opener else {
            ci += 1;
            continue;
        };
        let olen = match &nodes[oi] {
            Node::Delim { len, .. } => *len,
            _ => unreachable!("an opener is a delimiter"),
        };
        let used = if ch == '~' {
            clen
        } else if olen >= 2 && clen >= 2 {
            2
        } else {
            1
        };
        let tag = match (ch, used) {
            ('~', _) => Tag::Strike,
            (_, 2) => Tag::Bold,
            _ => Tag::Italic,
        };
        for n in &mut nodes[oi + 1..ci] {
            if let Node::Delim { open, close, .. } = n {
                // Delimiters inside a match can no longer match outside it.
                *open = false;
                *close = false;
            }
            if let Some(m) = marks_of(n) {
                add(m, tag);
            }
        }
        if let Node::Delim { len, .. } = &mut nodes[oi] {
            *len -= used;
        }
        if let Node::Delim { len, .. } = &mut nodes[ci] {
            *len -= used;
        }
        // The closer may close again (`***`).
    }
    // HTML tags: the nearest unmatched opening tag of the same kind.
    for ci in 0..nodes.len() {
        let Node::Html {
            tag,
            opening: false,
            matched: false,
            ..
        } = nodes[ci]
        else {
            continue;
        };
        let found = (0..ci).rev().find(|&oi| {
            matches!(nodes[oi], Node::Html { tag: t, opening: true, matched: false, .. } if t == tag)
        });
        if let Some(oi) = found {
            for n in &mut nodes[oi + 1..ci] {
                if let Some(m) = marks_of(n) {
                    add(m, tag);
                }
            }
            for k in [oi, ci] {
                if let Node::Html { matched, .. } = &mut nodes[k] {
                    *matched = true;
                }
            }
        }
    }
    nodes
}

/// Resolved nodes with what stayed unmatched turned into plain text.
fn literal(nodes: Vec<Node>) -> Vec<Node> {
    nodes
        .into_iter()
        .filter_map(|n| match n {
            Node::Delim { ch, len, marks, .. } => {
                (len > 0).then(|| Node::Text(std::iter::repeat_n(ch, len).collect(), marks))
            }
            Node::Html {
                literal,
                matched,
                marks,
                ..
            } => (!matched).then_some(Node::Text(literal, marks)),
            other => Some(other),
        })
        .collect()
}

fn flatten(nodes: Vec<Node>) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    let push = |text: String, m: &Marks, runs: &mut Vec<Run>| {
        if text.is_empty() {
            return;
        }
        let run = Run {
            text,
            bold: m.bold,
            italic: m.italic,
            underline: m.underline,
            strike: m.strike,
            href: m.href.clone(),
        };
        match runs.last_mut() {
            Some(last)
                if last.bold == run.bold
                    && last.italic == run.italic
                    && last.underline == run.underline
                    && last.strike == run.strike
                    && last.href == run.href =>
            {
                last.text.push_str(&run.text)
            }
            _ => runs.push(run),
        }
    };
    for n in nodes {
        match n {
            Node::Text(t, m) => push(t, &m, &mut runs),
            Node::Delim { ch, len, marks, .. } => {
                push(std::iter::repeat_n(ch, len).collect(), &marks, &mut runs)
            }
            Node::Html {
                literal,
                matched,
                marks,
                ..
            } => {
                if !matched {
                    push(literal, &marks, &mut runs);
                }
            }
            Node::Break => match runs.last_mut() {
                Some(last) => last.text.push('\n'),
                None => runs.push(Run {
                    text: "\n".into(),
                    ..Run::default()
                }),
            },
        }
    }
    // No spaces or line breaks at the paragraph's ends.
    while let Some(first) = runs.first_mut() {
        let t = first.text.trim_start_matches([' ', '\n']).to_owned();
        if t.is_empty() {
            runs.remove(0);
        } else {
            first.text = t;
            break;
        }
    }
    while let Some(last) = runs.last_mut() {
        let t = last.text.trim_end_matches([' ', '\n']).to_owned();
        if t.is_empty() {
            runs.pop();
        } else {
            last.text = t;
            break;
        }
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn md(s: &str) -> Vec<Block> {
        parse(s, &mut Vec::new())
    }

    fn run(text: &str) -> Run {
        Run {
            text: text.into(),
            ..Run::default()
        }
    }

    fn para(runs: Vec<Run>) -> Block {
        Block::Paragraph {
            runs,
            align: Align::Justify,
            indent: 0,
        }
    }

    fn heading(level: u8, text: &str) -> Block {
        Block::Heading {
            level,
            runs: vec![run(text)],
            align: Align::Justify,
        }
    }

    fn runs_of(b: &Block) -> &[Run] {
        match b {
            Block::Paragraph { runs, .. } | Block::Heading { runs, .. } => runs,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn headings_rules_and_paragraphs() {
        let got = md(
            "# 第一章 #\n\n正文第一行\n第二行\nsecond line\n\nTitle\n===\n\nSub\n---\n\n#### Deep\n\n***\n\n#nohash",
        );
        assert_eq!(
            got,
            vec![
                heading(1, "第一章"),
                para(vec![run("正文第一行第二行 second line")]),
                heading(1, "Title"),
                heading(2, "Sub"),
                heading(3, "Deep"),
                Block::Break,
                para(vec![run("#nohash")]),
            ]
        );
    }

    #[test]
    fn line_breaks_and_escapes() {
        let got = md("一行  \n二行\\\n三行 \\*不是斜体\\* &amp; &#x4E2D;");
        assert_eq!(
            got,
            vec![para(vec![run("一行\n二行\n三行 *不是斜体* & 中")])]
        );
    }

    #[test]
    fn emphasis_follows_the_delimiter_rules() {
        let got = md("**粗**和*斜*，__bold__ _it_ ~~删~~ ***both*** snake_case_name 2*3*4");
        let runs = runs_of(&got[0]);
        let styled: Vec<(&str, bool, bool, bool)> = runs
            .iter()
            .map(|r| (r.text.as_str(), r.bold, r.italic, r.strike))
            .collect();
        assert_eq!(
            styled,
            vec![
                ("粗", true, false, false),
                ("和", false, false, false),
                ("斜", false, true, false),
                ("，", false, false, false),
                ("bold", true, false, false),
                (" ", false, false, false),
                ("it", false, true, false),
                (" ", false, false, false),
                ("删", false, false, true),
                (" ", false, false, false),
                ("both", true, true, false),
                (" snake_case_name 2", false, false, false),
                ("3", false, true, false),
                ("4", false, false, false),
            ]
        );
        // Unmatched delimiters stay as text.
        assert_eq!(runs_of(&md("a ** b")[0]), [run("a ** b")]);
        assert_eq!(runs_of(&md("**未闭合")[0]), [run("**未闭合")]);
    }

    #[test]
    fn links_keep_web_and_mail_addresses_only() {
        let got = md(
            "[站点](https://example.com \"t\") [信](mailto:a@b.cn) [本地](./x.md) <https://a.org/x> see www.example.org. [ref]\n\n[ref]: https://ref.example",
        );
        let runs = runs_of(&got[0]);
        let linked: Vec<(&str, Option<&str>)> = runs
            .iter()
            .map(|r| (r.text.as_str(), r.href.as_deref()))
            .collect();
        assert_eq!(
            linked,
            vec![
                ("站点", Some("https://example.com")),
                (" ", None),
                ("信", Some("mailto:a@b.cn")),
                (" 本地 ", None),
                ("https://a.org/x", Some("https://a.org/x")),
                (" see ", None),
                ("www.example.org", Some("http://www.example.org")),
                (". ", None),
                ("ref", Some("https://ref.example")),
            ]
        );
        assert_eq!(got.len(), 1, "the definition leaves the text");
        let mut warnings = Vec::new();
        parse("![a](b.png)\n\n![c](d.jpg)", &mut warnings);
        assert_eq!(warnings, vec![ImportWarning::ImagesDropped(2)]);
    }

    #[test]
    fn quotes_lists_code_and_tables_degrade_to_what_the_editor_holds() {
        let got = md(
            "> 引文第一段\n继续\n>\n> > 第二段\n\n- 甲\n- [x] 乙\n  续行\n1. 一\n\n```rust\nfn x() {}\n\nlet y;\n```\n\n    indented\n\n| 名 | 值 |\n|---|:-:|\n| a | **b** |",
        );
        assert_eq!(
            got[0],
            Block::Quote {
                blocks: vec![para(vec![run("引文第一段继续")]), para(vec![run("第二段")])]
            }
        );
        assert_eq!(got[1], para(vec![run("甲")]));
        // A line end between two CJK characters joins them.
        assert_eq!(got[2], para(vec![run("乙续行")]));
        assert_eq!(got[3], para(vec![run("一")]));
        assert_eq!(got[4], para(vec![run("fn x() {}\n\nlet y;")]));
        assert_eq!(got[5], para(vec![run("indented")]));
        assert_eq!(got[6], para(vec![run("名")]));
        assert_eq!(got[7], para(vec![run("值")]));
        assert_eq!(got[8], para(vec![run("a")]));
        assert!(runs_of(&got[9])[0].bold);
        assert_eq!(got.len(), 10);
    }

    #[test]
    fn html_the_share_writes_comes_back() {
        // Drifting's own Markdown share writes underline and line breaks as HTML.
        let got = md("<u>下划线</u>一<br>二 <b>粗</b> <span>留着</span> code `**x**`");
        let runs = runs_of(&got[0]);
        assert!(runs[0].underline && runs[0].text == "下划线");
        assert_eq!(runs[1].text, "一\n二 ");
        assert!(runs[2].bold);
        assert_eq!(runs[3].text, " <span>留着</span> code **x**");
    }
}
