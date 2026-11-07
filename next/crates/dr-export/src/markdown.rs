//! Markdown share: the whole book, or one document's body, as one Markdown
//! text to copy or save. A port of the 0.1 client's
//! `services/export/markdown-share.ts` and its service (the hosted share
//! link is not part of it).
//!
//! - Whole book: the book's name as H1; without acts every live chapter
//!   (discarded ones too, as 0.1) as H2; with acts the chapters before the
//!   first act as H3, then each act as H2 with its chapters as H3. Under a
//!   chapter title its summary as a quote, then its prose with the prose's
//!   own H1/H2/H3 moved down below the chapter title (at most `######`).
//! - One document (`node:` chapter or idea, `element:`, `storyline:`,
//!   `category:`): its name as H1, a chapter's summary, the prose with its
//!   headings one level down. Material notes are not shared (0.1 had no
//!   share on them, and their lists and tasks have no form here).
//! - Prose is the Agent's Markdown view of 0.1 (`renderAgentProseMarkdownBlock`):
//!   `**bold**`, `*italic*`, `~~strike~~`, `<u>underline</u>`, links to
//!   http(s), mailto, tel or relative addresses, `<br>` for a line break,
//!   `---` for a rule, `> ` for a quote (its paragraphs joined by
//!   `<br><br>`), Markdown punctuation escaped and block prefixes protected.
//!   Entity links keep only their words. Blocks are joined by a blank line;
//!   empty paragraphs stay as empty blocks, as in 0.1. Embeds: a table's
//!   non-empty cell lines become paragraphs, a material leaves an empty block.

use dr_doc::prose::{EmbedView, Paragraph, ProseView, Run as ProseRun};
use dr_model::prose::{LINE_BREAK, OBJECT_CHAR};
use dr_workspace::commands::book::BookGet;
use dr_workspace::commands::chapter::{ActList, ChapterList};
use dr_workspace::commands::element::{CategoryList, ElementList, ElementListIn};
use dr_workspace::commands::idea::{IdeaList, IdeaListIn};
use dr_workspace::commands::storyline::StorylineList;
use dr_workspace::commands::{BookIn, ListIn};
use dr_workspace::{Actor, Workspace};

use crate::files::readable_stem;
use crate::{ExportError, Result};

/// What to share.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MarkdownTarget {
    /// Every live chapter, under its act.
    Book,
    /// One prose document: `node:<id>` (a chapter or an idea),
    /// `element:<id>`, `storyline:<id>` or `category:<id>`.
    Doc(String),
}

/// The Markdown text and what the dialog says about it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarkdownDoc {
    pub title: String,
    /// `<title>.md`, safe as one file name.
    pub filename: String,
    pub markdown: String,
    /// How many prose documents it holds.
    pub documents: usize,
}

struct Part {
    title: String,
    level: usize,
    summary: String,
    doc: Option<String>,
}

/// Reads the target's prose and lays it out as Markdown.
pub fn markdown(ws: &Workspace, book: &str, target: &MarkdownTarget) -> Result<MarkdownDoc> {
    let actor = Actor::User;
    let book_in = || BookIn {
        book: book.to_owned(),
    };
    let list_in = || ListIn {
        book: book.to_owned(),
        trashed: false,
    };
    let detail = ws.run::<BookGet>(&actor, book_in())?.output;
    if detail.info.trashed {
        return Err(ExportError::NotFound(format!("book {book}")));
    }
    let gone = |doc: &str| ExportError::NotFound(format!("document {doc}"));
    let mut title = detail.info.name.clone();
    let mut parts: Vec<Part> = Vec::new();
    match target {
        MarkdownTarget::Book => {
            let acts = ws.run::<ActList>(&actor, book_in())?.output;
            let chapters: Vec<_> = ws
                .run::<ChapterList>(&actor, list_in())?
                .output
                .into_iter()
                .filter(|c| !c.trashed)
                .collect();
            let level = if acts.is_empty() { 2 } else { 3 };
            let chapter = |c: &dr_workspace::dto::ChapterInfo| Part {
                title: c.title.clone(),
                level,
                summary: c.summary.clone(),
                doc: Some(format!("node:{}", c.id)),
            };
            parts.push(Part {
                title: title.clone(),
                level: 1,
                summary: String::new(),
                doc: None,
            });
            let in_act = |c: &dr_workspace::dto::ChapterInfo| {
                c.act
                    .as_ref()
                    .is_some_and(|a| acts.iter().any(|x| &x.id == a))
            };
            parts.extend(chapters.iter().filter(|c| !in_act(c)).map(chapter));
            for act in &acts {
                parts.push(Part {
                    title: act.name.clone(),
                    level: 2,
                    summary: String::new(),
                    doc: None,
                });
                parts.extend(
                    chapters
                        .iter()
                        .filter(|c| c.act.as_deref() == Some(act.id.as_str()))
                        .map(chapter),
                );
            }
        }
        MarkdownTarget::Doc(doc) => {
            let (kind, id) = doc
                .split_once(':')
                .ok_or_else(|| ExportError::Invalid(format!("{doc:?} is not a document")))?;
            let (name, summary) = match kind {
                "node" => {
                    let chapters = ws.run::<ChapterList>(&actor, list_in())?.output;
                    if let Some(c) = chapters.iter().find(|c| c.id == id && !c.trashed) {
                        (c.title.clone(), c.summary.clone())
                    } else {
                        let ideas = ws
                            .run::<IdeaList>(
                                &actor,
                                IdeaListIn {
                                    book: book.to_owned(),
                                    group: None,
                                    trashed: false,
                                },
                            )?
                            .output;
                        let idea = ideas.iter().find(|i| i.id == id).ok_or_else(|| gone(doc))?;
                        (idea.title.clone(), String::new())
                    }
                }
                "element" => {
                    let elements = ws
                        .run::<ElementList>(
                            &actor,
                            ElementListIn {
                                book: book.to_owned(),
                                category: None,
                                trashed: false,
                            },
                        )?
                        .output;
                    let e = elements
                        .iter()
                        .find(|e| e.id == id)
                        .ok_or_else(|| gone(doc))?;
                    (e.name.clone(), String::new())
                }
                "storyline" => {
                    let lines = ws.run::<StorylineList>(&actor, list_in())?.output;
                    let s = lines
                        .iter()
                        .find(|s| s.id == id && !s.trashed)
                        .ok_or_else(|| gone(doc))?;
                    (s.name.clone(), String::new())
                }
                "category" => {
                    let cats = ws.run::<CategoryList>(&actor, list_in())?.output;
                    let c = cats
                        .iter()
                        .find(|c| c.id == id && !c.trashed)
                        .ok_or_else(|| gone(doc))?;
                    (c.name.clone(), String::new())
                }
                _ => {
                    return Err(ExportError::Invalid(format!(
                        "{doc:?} is not a document Markdown can share"
                    )));
                }
            };
            title = name;
            parts.push(Part {
                title: title.clone(),
                level: 1,
                summary,
                doc: Some(doc.clone()),
            });
        }
    }
    let mut out: Vec<String> = Vec::new();
    let mut documents = 0;
    for part in &parts {
        out.push(heading(&part.title, part.level));
        let summary = summary(&part.summary);
        if !summary.is_empty() {
            out.push(summary);
        }
        let Some(doc) = &part.doc else {
            continue;
        };
        documents += 1;
        let session = ws.prose_session(doc)?;
        let reader = session.reader();
        let body = prose(&reader.view(), part.level);
        if !body.is_empty() {
            out.push(body);
        }
    }
    Ok(MarkdownDoc {
        filename: markdown_filename(&title),
        title,
        markdown: format!("{}\n", out.join("\n\n")),
        documents,
    })
}

/// `<title>.md`, at most 35 characters before the extension.
pub fn markdown_filename(title: &str) -> String {
    format!("{}.md", readable_stem(title))
}

/// A title as one Markdown heading line (`Untitled` when it has no words).
pub fn heading(title: &str, level: usize) -> String {
    let mut line = String::new();
    let mut gap = false;
    for c in title.chars() {
        if matches!(c, '\r' | '\n') {
            gap = true;
            continue;
        }
        if gap {
            line.push(' ');
            gap = false;
        }
        line.push(c);
    }
    let line = line.trim();
    let text = if line.is_empty() { "Untitled" } else { line };
    let inline = protect_block_prefix(&escape(text));
    format!("{} {inline}", "#".repeat(level.clamp(1, 6)))
}

/// A plain-text summary as a quote (empty when it has no words).
pub fn summary(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let text = text.trim();
    if text.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = text.split('\n').map(escape).collect();
    format!("> {}", lines.join("<br>"))
}

/// One document's prose, its H1/H2/H3 moved `offset` levels down.
pub fn prose(view: &ProseView<'_>, offset: usize) -> String {
    let mut blocks: Vec<String> = Vec::new();
    let mut quote: Option<Vec<String>> = None;
    for p in view.paragraphs() {
        if p.attrs.quote && p.embed().is_none() {
            // A quote's paragraphs are one block; headings and rules inside
            // it keep only their words (0.1's flattening).
            let inner = if p.attrs.rule {
                String::new()
            } else {
                inline(&p.runs)
            };
            quote.get_or_insert_with(Vec::new).push(inner);
            continue;
        }
        if let Some(q) = quote.take() {
            blocks.push(format!("> {}", q.join("<br><br>")));
        }
        block(view, &p, offset, &mut blocks);
    }
    if let Some(q) = quote.take() {
        blocks.push(format!("> {}", q.join("<br><br>")));
    }
    blocks.join("\n\n")
}

fn block(view: &ProseView<'_>, p: &Paragraph, offset: usize, out: &mut Vec<String>) {
    if let Some(id) = p.embed() {
        match view.embed(id) {
            Some(EmbedView::Table {
                cols, rows, cells, ..
            }) => {
                for row in &rows {
                    for col in &cols {
                        let Some(text) = cells.get(&(row.id.clone(), col.id.clone())) else {
                            continue;
                        };
                        for line in text.split(['\n', LINE_BREAK]) {
                            if !line.trim().is_empty() {
                                out.push(protect_block_prefix(&escape(line)));
                            }
                        }
                    }
                }
            }
            _ => out.push(String::new()),
        }
        return;
    }
    if p.attrs.rule {
        out.push("---".into());
        return;
    }
    let text = inline(&p.runs);
    match p.attrs.heading {
        Some(h) => {
            let level = (h.level() as usize + offset).min(6);
            out.push(format!("{} {text}", "#".repeat(level)));
        }
        None => out.push(protect_block_prefix(&text)),
    }
}

#[derive(Clone, PartialEq, Eq)]
struct Marks {
    bold: bool,
    italic: bool,
    strike: bool,
    underline: bool,
    link: Option<String>,
}

enum Piece {
    Text(String, Marks),
    /// A line break inside the paragraph: `<br>` between the marked pieces.
    Break,
}

/// Runs as inline Markdown: neighbours with the same marks merged, then
/// escaped and wrapped (bold, italic, strike, underline, link).
fn inline(runs: &[ProseRun]) -> String {
    let mut pieces: Vec<Piece> = Vec::new();
    for r in runs {
        let marks = Marks {
            bold: r.marks.bold,
            italic: r.marks.italic,
            strike: r.marks.strike,
            underline: r.marks.underline,
            link: r.marks.link.as_deref().and_then(markdown_link),
        };
        for (i, segment) in r.text.split(LINE_BREAK).enumerate() {
            if i > 0 {
                pieces.push(Piece::Break);
            }
            let text: String = segment.chars().filter(|&c| c != OBJECT_CHAR).collect();
            if text.is_empty() {
                continue;
            }
            match pieces.last_mut() {
                Some(Piece::Text(t, m)) if *m == marks => t.push_str(&text),
                _ => pieces.push(Piece::Text(text, marks.clone())),
            }
        }
    }
    let mut out = String::new();
    for piece in pieces {
        let (text, m) = match piece {
            Piece::Break => {
                out.push_str("<br>");
                continue;
            }
            Piece::Text(text, m) => (text, m),
        };
        let mut value = text
            .split('\n')
            .map(|l| escape(l.strip_suffix('\r').unwrap_or(l)))
            .collect::<Vec<_>>()
            .join("<br>");
        if m.bold {
            value = format!("**{value}**");
        }
        if m.italic {
            value = format!("*{value}*");
        }
        if m.strike {
            value = format!("~~{value}~~");
        }
        if m.underline {
            value = format!("<u>{value}</u>");
        }
        if let Some(href) = m.link {
            value = format!("[{value}]({})", escape_destination(&href));
        }
        out.push_str(&value);
    }
    out
}

/// A link Markdown keeps: no control characters, and a scheme (if any) of
/// http, https, mailto or tel.
fn markdown_link(href: &str) -> Option<String> {
    let href = href.trim();
    if href.is_empty() || href.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f) {
        return None;
    }
    let mut chars = href.char_indices();
    let scheme_end = match chars.next() {
        Some((_, c)) if c.is_ascii_alphabetic() => chars
            .find(|&(_, c)| !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')))
            .filter(|&(_, c)| c == ':')
            .map(|(i, _)| i),
        _ => None,
    };
    if let Some(end) = scheme_end {
        let scheme = href[..end].to_ascii_lowercase();
        if !matches!(scheme.as_str(), "http" | "https" | "mailto" | "tel") {
            return None;
        }
    }
    Some(href.to_owned())
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '`' | '*' | '_' | '[' | ']' | '~' | '<' | '|') {
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

/// Up to three leading spaces, as Markdown's block prefixes allow.
fn indent_of(value: &str) -> usize {
    value
        .chars()
        .take(3)
        .take_while(|c| c.is_whitespace())
        .map(char::len_utf8)
        .sum()
}

/// A paragraph that would read as another block (heading, quote, list,
/// fence, rule) gets its marker escaped.
fn protect_block_prefix(value: &str) -> String {
    let lead = indent_of(value);
    let rest = &value[lead..];
    let ws_or_end = |s: &str| s.chars().next().is_none_or(char::is_whitespace);
    // # … ###### then a space or the end.
    let hashes = rest.chars().take_while(|&c| c == '#').count();
    if (1..=6).contains(&hashes) && ws_or_end(&rest[hashes..]) {
        return format!("{}\\{}", &value[..lead], rest);
    }
    if rest.starts_with('>') {
        return format!("{}\\{}", &value[..lead], rest);
    }
    if let Some(c) = rest.chars().next()
        && matches!(c, '-' | '+' | '*')
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
    for m in ['-', '*', '_'] {
        if trimmed.chars().count() >= 3 && trimmed.chars().all(|c| c == m) {
            return format!("{}\\{}", &value[..lead], rest);
        }
    }
    value.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_are_one_escaped_line() {
        assert_eq!(heading("第一章\n来信", 2), "## 第一章 来信");
        assert_eq!(heading("  ", 1), "# Untitled");
        assert_eq!(heading("a*b_c", 3), "### a\\*b\\_c");
        assert_eq!(heading("# 不是标题", 1), "# \\# 不是标题");
    }

    #[test]
    fn summaries_are_quotes() {
        assert_eq!(summary(""), "");
        assert_eq!(summary(" 一行\r\n两行 "), "> 一行<br>两行");
    }

    #[test]
    fn block_prefixes_are_protected() {
        assert_eq!(protect_block_prefix("# x"), "\\# x");
        assert_eq!(protect_block_prefix("#tag"), "#tag");
        assert_eq!(protect_block_prefix("> x"), "\\> x");
        assert_eq!(protect_block_prefix("- x"), "\\- x");
        assert_eq!(protect_block_prefix("-x"), "-x");
        assert_eq!(protect_block_prefix("12. x"), "12\\. x");
        assert_eq!(protect_block_prefix("1.5 x"), "1.5 x");
        assert_eq!(protect_block_prefix("---"), "\\---");
        assert_eq!(protect_block_prefix("  ---  "), "  \\---  ");
        assert_eq!(protect_block_prefix("普通段落"), "普通段落");
    }

    #[test]
    fn links_keep_safe_schemes_only() {
        assert_eq!(
            markdown_link(" https://example.com/a ").as_deref(),
            Some("https://example.com/a")
        );
        assert_eq!(
            markdown_link("mailto:a@example.com").as_deref(),
            Some("mailto:a@example.com")
        );
        assert_eq!(markdown_link("notes/a.md").as_deref(), Some("notes/a.md"));
        assert_eq!(markdown_link("javascript:alert(1)"), None);
        assert_eq!(markdown_link("drifting://x"), None);
        assert_eq!(
            escape_destination("https://x.y/a b(c)"),
            "https://x.y/a%20b%28c%29"
        );
    }

    #[test]
    fn filenames_are_readable_and_bounded() {
        assert_eq!(markdown_filename("雾港/来信?"), "雾港-来信-.md");
        assert_eq!(markdown_filename("  ..  "), "Drifting.md");
        assert_eq!(
            markdown_filename(&"长".repeat(50)),
            format!("{}.md", "长".repeat(35))
        );
    }
}
