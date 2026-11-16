//! A format 5 prose document as Markdown. Ordinary line breaks are paragraph
//! breaks. Lists, fences, callouts, tables, and standalone assets have their
//! Markdown structure. The import's Markdown reader supplies the inline
//! grammar.

mod links;

pub use links::FileLinks;

use dr_doc::prose::{EmbedView, Paragraph, ProseView};
use dr_export::import::{
    markdown_blocks, markdown_callout_kind, markdown_image_line, markdown_runs,
};
use dr_export::{Block, Run};
use dr_model::id::AssetId;
use dr_model::kind::{AssetKind, EntityKind, ListKind};
use dr_model::prose::{LINE_BREAK, OBJECT_CHAR};

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Marks {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub code: bool,
    pub highlight: bool,
    pub link: Option<String>,
    pub file: Option<AssetId>,
}

/// The attributes represented by the file. Alignment, non-list indent,
/// highlight colour, and links to entries live in the Loro document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    Text {
        heading: Option<u8>,
        quote: bool,
    },
    Rule {
        quote: bool,
    },
    List {
        kind: ListKind,
        level: u32,
        checked: bool,
    },
    Code(String),
    Callout(String),
    Table(Vec<Vec<Para>>),
    BrokenTable(String),
    Asset {
        asset: AssetId,
        caption: String,
    },
    /// A retained embed whose data or asset path is unavailable.
    Embed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Para {
    pub kind: Kind,
    pub chars: Vec<char>,
    pub marks: Vec<Marks>,
}

const TEXT: Kind = Kind::Text {
    heading: None,
    quote: false,
};

impl Para {
    fn new(kind: Kind) -> Self {
        Self {
            kind,
            chars: Vec::new(),
            marks: Vec::new(),
        }
    }

    pub fn empty() -> Self {
        Self::new(TEXT)
    }

    pub fn plain(text: &str) -> Self {
        let chars: Vec<_> = text.chars().collect();
        let marks = vec![Marks::default(); chars.len()];
        Self {
            kind: TEXT,
            chars,
            marks,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.chars.is_empty() && self.kind == TEXT
    }

    /// Simple paragraph capture, without looking up embeds.
    pub fn of(p: &Paragraph) -> Self {
        if let Some(id) = p.embed() {
            return Self::new(Kind::Embed(id.to_string()));
        }
        let a = &p.attrs;
        let kind = if a.rule {
            Kind::Rule { quote: a.quote }
        } else if a.quote || a.heading.is_some() {
            Kind::Text {
                heading: a.heading.map(|h| h.level() as u8),
                quote: a.quote,
            }
        } else if let Some(callout) = &a.callout {
            Kind::Callout(callout.clone())
        } else if let Some(language) = &a.code_block {
            Kind::Code(language.clone())
        } else if let Some(list) = &a.list {
            let kind = match list {
                ListKind::Other(_) => ListKind::Bullet,
                known => known.clone(),
            };
            Kind::List {
                kind,
                level: a.list_level.min(8),
                checked: *list == ListKind::Task && a.checked,
            }
        } else {
            TEXT
        };
        if matches!(kind, Kind::Code(_)) {
            return Self {
                kind,
                ..Self::plain(&p.text())
            };
        }
        Self::from_prose_runs(&p.runs, kind)
    }

    /// Capture the embeds as seen by the Markdown folder. Missing or damaged
    /// embed records remain identifiable without projecting new content.
    pub fn project(view: &ProseView<'_>, p: &Paragraph, links: &FileLinks<'_>) -> Self {
        if let Some(id) = p.embed() {
            match view.embed(id) {
                Some(EmbedView::Table { cols, rows, .. })
                    if !rows.is_empty() && !cols.is_empty() =>
                {
                    let cells = rows
                        .iter()
                        .map(|row| {
                            cols.iter()
                                .map(|col| {
                                    view.table_cell(id, &row.id, &col.id)
                                        .map_or_else(Para::empty, |runs| {
                                            Self::from_prose_runs(&runs, TEXT)
                                        })
                                })
                                .collect()
                        })
                        .collect();
                    return Self::new(Kind::Table(cells));
                }
                Some(EmbedView::Asset {
                    asset: Some(asset),
                    look,
                    ..
                }) => {
                    if let Some(file) = links.asset(&asset) {
                        let caption = if file.kind == AssetKind::Pdf {
                            String::new()
                        } else {
                            look.caption
                        };
                        return Self::new(Kind::Asset { asset, caption });
                    }
                }
                _ => {}
            }
        }
        Self::of(p)
    }

    pub(crate) fn from_prose_runs(runs: &[dr_doc::prose::Run], kind: Kind) -> Self {
        let mut p = Self::new(kind);
        for run in runs {
            let m = &run.marks;
            let file = m
                .entities
                .iter()
                .find(|e| e.kind == EntityKind::Asset)
                .and_then(|e| AssetId::parse(&e.target).ok());
            p.push(
                &run.text,
                &Marks {
                    bold: m.bold,
                    italic: m.italic,
                    underline: m.underline,
                    strike: m.strike,
                    code: m.code,
                    highlight: m.highlight.is_some(),
                    link: m.link.clone(),
                    file,
                },
            );
        }
        p
    }

    fn push(&mut self, text: &str, marks: &Marks) {
        for c in text.chars() {
            let c = match c {
                '\n' => LINE_BREAK,
                OBJECT_CHAR | '\r' => continue,
                c => c,
            };
            self.chars.push(c);
            self.marks.push(if c == LINE_BREAK {
                Marks::default()
            } else {
                marks.clone()
            });
        }
    }

    pub fn text(&self) -> String {
        self.chars.iter().collect()
    }
}

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

pub fn render(paras: &[Para]) -> String {
    render_with(paras, &FileLinks::default())
}

pub fn render_with(paras: &[Para], links: &FileLinks<'_>) -> String {
    let (Some(first), Some(last)) = (
        paras.iter().position(|p| !p.is_empty()),
        paras.iter().rposition(|p| !p.is_empty()),
    ) else {
        return String::new();
    };
    let mut lines = Vec::new();
    let mut i = first;
    while i <= last {
        let p = &paras[i];
        if p.is_empty() {
            lines.push(String::new());
            i += 1;
            continue;
        }
        if i > first {
            lines.push(String::new());
        }
        let group = &paras[i..=last];
        let (used, text) = match &p.kind {
            Kind::Code(language) => {
                let lines: Vec<_> = group
                    .iter()
                    .take_while(|p| p.kind == group[0].kind)
                    .map(Para::text)
                    .collect();
                (lines.len(), fenced(language, &lines.join("\n")))
            }
            Kind::Callout(kind) => {
                let mut lines = vec![format!("> [!{kind}]")];
                for q in group.iter().take_while(|p| p.kind == group[0].kind) {
                    lines.push(format!("> {}", inline(&q.chars, &q.marks, links, false)));
                }
                (lines.len() - 1, lines.join("\n"))
            }
            Kind::List { .. } => {
                let lines: Vec<_> = group
                    .iter()
                    .take_while(|p| matches!(p.kind, Kind::List { .. }))
                    .map(|p| line_with(p, links))
                    .collect();
                (lines.len(), lines.join("\n"))
            }
            _ => (1, line_with(p, links)),
        };
        lines.push(text);
        i += used;
    }
    format!("{}\n", lines.join("\n"))
}

pub fn line(p: &Para) -> String {
    line_with(p, &FileLinks::default())
}

pub fn line_with(p: &Para, links: &FileLinks<'_>) -> String {
    match &p.kind {
        Kind::Embed(id) => embed_line(id),
        Kind::Asset { asset, caption } => {
            let name = links
                .asset(asset)
                .filter(|file| file.kind == AssetKind::Pdf)
                .map_or(caption.as_str(), |file| file.name.as_str());
            let target = links.destination(asset).unwrap_or_default();
            let alt =
                escape(&name.chars().collect::<Vec<_>>(), true, true).replace(LINE_BREAK, "<br>");
            format!("![{alt}]({target})")
        }
        Kind::Table(rows) => render_table(rows, links),
        Kind::BrokenTable(raw) => raw.clone(),
        Kind::Code(lang) => fenced(lang, &p.text()),
        Kind::Callout(kind) => format!(
            "> [!{kind}]\n> {}",
            inline(&p.chars, &p.marks, links, false)
        ),
        Kind::List {
            kind,
            level,
            checked,
        } => {
            let indent = "  ".repeat((*level).min(8) as usize);
            let marker = match kind {
                ListKind::Ordered => "1. ",
                ListKind::Task if *checked => "- [x] ",
                ListKind::Task => "- [ ] ",
                _ => "- ",
            };
            format!(
                "{indent}{marker}{}",
                inline(&p.chars, &p.marks, links, false)
            )
        }
        Kind::Rule { quote } => if *quote { "> ---" } else { "---" }.into(),
        Kind::Text { heading, quote } => {
            let mut text = inline(&p.chars, &p.marks, links, false);
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

fn render_table(rows: &[Vec<Para>], links: &FileLinks<'_>) -> String {
    let mut lines = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let cells: Vec<_> = row
            .iter()
            .map(|cell| inline(&cell.chars, &cell.marks, links, true))
            .collect();
        lines.push(format!("| {} |", cells.join(" | ")));
        if i == 0 {
            lines.push(format!("|{}", " --- |".repeat(row.len())));
        }
    }
    lines.join("\n")
}

fn fenced(language: &str, text: &str) -> String {
    let language = language.lines().next().unwrap_or("").trim();
    let marker = if language.contains('`') { '~' } else { '`' };
    let fence = marker.to_string().repeat(fence_len(text, marker).max(3));
    let pad = if language.starts_with(marker) {
        " "
    } else {
        ""
    };
    format!("{fence}{pad}{language}\n{text}\n{fence}")
}

fn fence_len(text: &str, marker: char) -> usize {
    let mut max = 0;
    let mut run = 0;
    for c in text.chars() {
        run = if c == marker { run + 1 } else { 0 };
        max = max.max(run);
    }
    max + 1
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FilePara {
    /// Canonical comparison key. The text may have been spelled differently
    /// in Markdown (e.g. heading closing hashes or upper case task checks).
    pub key: String,
    pub para: Para,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum BodyIssue {
    MalformedTable,
    UnknownImage,
}

#[derive(Default)]
pub struct ReadBody {
    pub paragraphs: Vec<FilePara>,
    pub issues: std::collections::BTreeSet<BodyIssue>,
}

pub fn parse(body: &str) -> Vec<FilePara> {
    parse_with(body, &FileLinks::default()).paragraphs
}

pub fn parse_with(body: &str, links: &FileLinks<'_>) -> ReadBody {
    let lines: Vec<_> = body
        .split_terminator('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    let mut out = ReadBody::default();
    let mut i = 0;
    let mut blank: usize = 0;
    let push = |out: &mut ReadBody, para: Para| {
        let key = if para.is_empty() {
            String::new()
        } else {
            line_with(&para, links)
        };
        out.paragraphs.push(FilePara { key, para });
    };

    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            blank += 1;
            i += 1;
            continue;
        }
        if !out.paragraphs.is_empty() {
            for _ in 1..blank {
                push(&mut out, Para::empty());
            }
        }
        blank = 0;
        i += 1;

        if let Some((marker, length, pad, language)) = fence_of(line) {
            let mut found_line = false;
            while let Some(content) = lines.get(i) {
                i += 1;
                if fence_of(content)
                    .is_some_and(|(c, n, _, rest)| c == marker && n >= length && rest.is_empty())
                {
                    break;
                }
                let strip = indent_of(content).min(pad);
                let para = Para {
                    kind: Kind::Code(language.to_owned()),
                    ..Para::plain(&content[strip..])
                };
                push(&mut out, para);
                found_line = true;
            }
            if !found_line {
                push(&mut out, Para::new(Kind::Code(language.to_owned())));
            }
            continue;
        }
        if let Some(callout) = quote_content(line).and_then(markdown_callout_kind) {
            let start = i;
            while let Some(inside) = lines.get(i).and_then(|line| quote_content(line)) {
                push(
                    &mut out,
                    text_para(
                        &markdown_runs(inside),
                        Kind::Callout(callout.to_owned()),
                        links,
                    ),
                );
                i += 1;
            }
            if i == start {
                push(&mut out, Para::new(Kind::Callout(callout.to_owned())));
            }
            continue;
        }
        if let Some((kind, text)) = list_kind(line) {
            push(&mut out, text_para(&markdown_runs(text), kind, links));
            continue;
        }
        if table_start(line, lines.get(i).copied()) {
            let start = i - 1;
            while lines.get(i).is_some_and(|line| table_like(line)) {
                i += 1;
            }
            let text = lines[start..i].join("\n");
            let parsed = markdown_blocks(&text);
            let para = if let [Block::Table { rows }] = parsed.as_slice()
                && !rows.is_empty()
                && !rows[0].is_empty()
                && rows.iter().all(|row| row.len() == rows[0].len())
            {
                let rows = rows
                    .iter()
                    .map(|row| {
                        row.iter()
                            .map(|cell| text_para(cell, TEXT, links))
                            .collect()
                    })
                    .collect();
                Para::new(Kind::Table(rows))
            } else {
                out.issues.insert(BodyIssue::MalformedTable);
                Para::new(Kind::BrokenTable(text))
            };
            push(&mut out, para);
            continue;
        }
        if let Some(id) = embed_of(line) {
            push(&mut out, Para::new(Kind::Embed(id)));
            continue;
        }
        if let Some((caption, target, wiki)) = image_target(line) {
            let para = if let Some(asset) = links.resolve(&target, wiki) {
                let caption = if asset.kind == AssetKind::Pdf {
                    String::new()
                } else {
                    text_para(&markdown_runs(&caption), TEXT, links).text()
                };
                Para::new(Kind::Asset {
                    asset: asset.id.clone(),
                    caption,
                })
            } else {
                out.issues.insert(BodyIssue::UnknownImage);
                Para::plain(line)
            };
            push(&mut out, para);
            continue;
        }
        if quote_content(line).is_some_and(str::is_empty) {
            push(
                &mut out,
                Para::new(Kind::Text {
                    heading: None,
                    quote: true,
                }),
            );
            continue;
        }
        let parsed = markdown_blocks(line);
        if parsed.is_empty() {
            push(&mut out, Para::plain(line));
        }
        for block in parsed {
            block_para(&block, false, links, &mut |p| push(&mut out, p));
        }
    }
    while out.paragraphs.last().is_some_and(|p| p.para.is_empty()) {
        out.paragraphs.pop();
    }
    out
}

fn fence_of(line: &str) -> Option<(char, usize, usize, &str)> {
    let pad = line.len() - line.trim_start_matches(' ').len();
    if pad > 3 {
        return None;
    }
    let rest = &line[pad..];
    let marker = rest.chars().next().filter(|&c| matches!(c, '`' | '~'))?;
    let length = rest.chars().take_while(|&c| c == marker).count();
    let tail = rest[length..].trim();
    (length >= 3 && (marker != '`' || !tail.contains('`'))).then_some((marker, length, pad, tail))
}

fn quote_content(line: &str) -> Option<&str> {
    let inner = line.trim_start().strip_prefix('>')?;
    Some(inner.strip_prefix(' ').unwrap_or(inner))
}

fn list_kind(line: &str) -> Option<(Kind, &str)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    let line = &line[indent..];
    let bullet = line.starts_with(['-', '+', '*']);
    let (kind, rest) = if bullet {
        (ListKind::Bullet, &line[1..])
    } else {
        let digits = line.bytes().take_while(u8::is_ascii_digit).count();
        if !(1..=9).contains(&digits) || !line[digits..].starts_with(['.', ')']) {
            return None;
        }
        (ListKind::Ordered, &line[digits + 1..])
    };
    let text = rest.strip_prefix(' ')?;
    let (kind, checked, text) = if bullet {
        ["[ ]", "[x]", "[X]"]
            .iter()
            .enumerate()
            .find_map(|(i, mark)| {
                let tail = text.strip_prefix(mark)?;
                let content = if tail.is_empty() {
                    tail
                } else {
                    tail.strip_prefix(' ')?
                };
                Some((ListKind::Task, i != 0, content))
            })
            .unwrap_or((kind, false, text))
    } else {
        (kind, false, text)
    };
    Some((
        Kind::List {
            kind,
            level: ((indent / 2) as u32).min(8),
            checked,
        },
        text,
    ))
}

fn table_like(line: &str) -> bool {
    let mut escaped = false;
    for c in line.chars() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '|' {
            return true;
        }
    }
    false
}

fn table_start(line: &str, next: Option<&str>) -> bool {
    let trimmed = line.trim();
    (trimmed.starts_with('|') && trimmed.ends_with('|') && trimmed.len() > 1)
        || (table_like(line) && next.is_some_and(|next| table_like(next) && next.contains('-')))
}

fn image_target(line: &str) -> Option<(String, String, bool)> {
    if let Some(inner) = line
        .trim()
        .strip_prefix("![[")
        .and_then(|s| s.strip_suffix("]]"))
    {
        let (target, caption) = inner.split_once('|').unwrap_or((inner, ""));
        return Some((caption.to_owned(), target.to_owned(), true));
    }
    markdown_image_line(line).map(|(caption, target)| (caption, target, false))
}

fn block_para(block: &Block, quote: bool, links: &FileLinks<'_>, push: &mut impl FnMut(Para)) {
    match block {
        Block::Heading { level, runs, .. } => push(text_para(
            runs,
            Kind::Text {
                heading: Some(*level),
                quote,
            },
            links,
        )),
        Block::Paragraph { runs, .. } => push(text_para(
            runs,
            Kind::Text {
                heading: None,
                quote,
            },
            links,
        )),
        Block::Quote { blocks } => {
            for block in blocks {
                block_para(block, true, links, push);
            }
        }
        Block::Break => push(Para::new(Kind::Rule { quote })),
        _ => {}
    }
}

fn text_para(runs: &[Run], kind: Kind, links: &FileLinks<'_>) -> Para {
    let mut p = Para::new(kind);
    for r in runs {
        let href = r.href.as_deref();
        let file = href
            .and_then(|href| links.resolve(href, false))
            .map(|asset| asset.id.clone());
        let link = href
            .filter(|v| {
                let lower = v.to_ascii_lowercase();
                lower.starts_with("http://")
                    || lower.starts_with("https://")
                    || lower.starts_with("mailto:")
            })
            .map(str::to_owned);
        p.push(
            &r.text,
            &Marks {
                bold: r.bold,
                italic: r.italic,
                underline: r.underline,
                strike: r.strike,
                code: r.code,
                highlight: r.highlight,
                link,
                file,
            },
        );
    }
    p
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
fn escape(chars: &[char], preserve_start: bool, preserve_end: bool) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(chars.len());
    for (i, &c) in chars.iter().enumerate() {
        if c.is_whitespace()
            && (c != ' ' || (preserve_start && i == 0) || (preserve_end && i + 1 == chars.len()))
        {
            write!(out, "&#{};", c as u32).unwrap();
            continue;
        }
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
            '\\' | '`' | '*' | '_' | '[' | ']' | '~' | '<' | '|' | '&' | '='
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
fn inline(chars: &[char], marks: &[Marks], links: &FileLinks<'_>, table: bool) -> String {
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
    let styled = |m: &Marks| {
        m.bold
            || m.italic
            || m.strike
            || m.underline
            || m.highlight
            || m.code
            || m.link.is_some()
            || m.file.is_some()
    };
    // The character just outside each piece: a styled piece and a line
    // break begin and end with punctuation whatever their form.
    let edge = |p: &Option<Piece>, first: bool| -> char {
        match p {
            None => '<',
            Some(p) if styled(&p.marks) => '*',
            Some(p) => {
                let e = escape(&p.text, false, false);
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
        let m = &p.marks;
        let mut value = if m.code {
            let code: String = p.text.iter().collect();
            if (table && code.contains(['|', '\\'])) || out.ends_with('`') {
                format!("<code>{}</code>", escape(&p.text, true, true))
            } else {
                code_span(&code)
            }
        } else {
            escape(
                &p.text,
                styled(m) || k == 0,
                styled(m) || k + 1 == pieces.len(),
            )
        };
        let destination = m
            .file
            .as_ref()
            .and_then(|id| links.destination(id))
            .or_else(|| m.link.as_ref().map(|href| escape_destination(href)));

        // Inside a link or underline the delimiters touch `[`/`>`; else
        // the neighbours.
        let wrapped = m.underline || destination.is_some();
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
            (m.highlight, "==", "mark"),
        ]
        .into_iter()
        .filter(|(on, _, _)| *on)
        .map(|(_, d, t)| (d, t))
        .collect();
        // `***x***` and the like are left to tags: one delimiter kind at a
        // time.
        // Nor next to a delimiter of the same character (`**a***b*` is
        // one run).
        let markdown = !m.code
            && delims.len() <= 1
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
        if let Some(href) = destination {
            value = format!("[{value}]({href})");
            // `!` right before it would make it an image.
            if out.ends_with('!') {
                out.pop();
                out.push_str("\\!");
            }
        }
        out.push_str(&value);
    }
    out
}

fn code_span(text: &str) -> String {
    let ticks = "`".repeat(fence_len(text, '`'));
    let pad = text.starts_with('`')
        || text.ends_with('`')
        || (text.starts_with(' ') && text.ends_with(' ') && !text.trim().is_empty());
    if pad {
        format!("{ticks} {text} {ticks}")
    } else {
        format!("{ticks}{text}{ticks}")
    }
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
        assert_eq!(read, ["甲", "乙", "x", "y", "丙"]);
        let embed = parse("<!-- drifting:embed t1 -->\n");
        assert_eq!(embed[0].para.kind, Kind::Embed("t1".into()));
    }

    fn marks() -> impl Strategy<Value = Marks> {
        (
            any::<bool>(),
            any::<bool>(),
            any::<bool>(),
            any::<bool>(),
            prop::bool::weighted(0.25),
            prop::bool::weighted(0.25),
            prop::option::weighted(0.1, Just("https://example.com/x".to_owned())),
        )
            .prop_map(
                |(bold, italic, underline, strike, highlight, code, link)| Marks {
                    bold,
                    italic,
                    underline,
                    strike,
                    highlight,
                    code,
                    link,
                    ..Marks::default()
                },
            )
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
        #![proptest_config({
            let mut config = ProptestConfig::default();
            config.cases = config.cases.max(512);
            config
        })]
        #[test]
        fn what_is_written_reads_back(p in para()) {
            if let Some(p) = normal(p) {
                let got = back(&p);
                prop_assert_eq!(&got, &p, "line {:?}", line(&p));
            }
        }
    }
}
