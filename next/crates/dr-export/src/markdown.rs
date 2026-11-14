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
use dr_model::kind::ListKind;
use dr_model::prose::{LINE_BREAK, OBJECT_CHAR};

use crate::files::readable_stem;

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
    let paragraphs: Vec<Paragraph> = view.paragraphs().collect();
    let mut blocks: Vec<String> = Vec::new();
    let mut i = 0;
    while i < paragraphs.len() {
        let p = &paragraphs[i];
        if p.attrs.quote && p.embed().is_none() {
            let mut q = Vec::new();
            while i < paragraphs.len()
                && paragraphs[i].attrs.quote
                && paragraphs[i].embed().is_none()
            {
                let inner = if paragraphs[i].attrs.rule {
                    String::new()
                } else {
                    inline(&paragraphs[i].runs)
                };
                q.push(inner);
                i += 1;
            }
            blocks.push(format!("> {}", q.join("<br><br>")));
            continue;
        }
        if let Some(kind) = p.attrs.callout.as_deref()
            && p.embed().is_none()
        {
            let mut c = Vec::new();
            while i < paragraphs.len()
                && paragraphs[i].attrs.callout.as_deref() == Some(kind)
                && !paragraphs[i].attrs.quote
                && paragraphs[i].embed().is_none()
            {
                let inner = if paragraphs[i].attrs.rule {
                    String::new()
                } else {
                    inline(&paragraphs[i].runs)
                };
                c.push(inner);
                i += 1;
            }
            blocks.push(format!("> {}", c.join("<br><br>")));
            continue;
        }
        if let Some(lang) = p.attrs.code_block.as_deref()
            && p.embed().is_none()
        {
            let mut lines = Vec::new();
            while i < paragraphs.len()
                && paragraphs[i].attrs.code_block.as_deref() == Some(lang)
                && !paragraphs[i].attrs.quote
                && paragraphs[i].attrs.callout.is_none()
                && paragraphs[i].embed().is_none()
            {
                let raw: String = paragraphs[i]
                    .runs
                    .iter()
                    .flat_map(|r| r.text.chars())
                    .filter(|&c| c != OBJECT_CHAR)
                    .map(|c| if c == LINE_BREAK { '\n' } else { c })
                    .collect();
                lines.push(raw);
                i += 1;
            }
            let body = lines.join("\n");
            let fence = code_fence(&body);
            let info = lang.trim();
            blocks.push(format!("{fence}{info}\n{body}\n{fence}"));
            continue;
        }
        if let Some(list_kind) = p.attrs.list.as_ref()
            && p.embed().is_none()
        {
            let mut items = Vec::new();
            let mut counters = [0usize; 9];
            while i < paragraphs.len()
                && paragraphs[i].attrs.list.as_ref() == Some(list_kind)
                && !paragraphs[i].attrs.quote
                && paragraphs[i].attrs.callout.is_none()
                && paragraphs[i].embed().is_none()
            {
                let item = &paragraphs[i];
                let lvl = (item.attrs.list_level as usize).min(8);
                for c in &mut counters[lvl + 1..] {
                    *c = 0;
                }
                let indent = "  ".repeat(lvl);
                let marker = match list_kind {
                    ListKind::Bullet | ListKind::Other(_) => "- ".to_string(),
                    ListKind::Ordered => {
                        counters[lvl] += 1;
                        format!("{}. ", counters[lvl])
                    }
                    ListKind::Task => {
                        if item.attrs.checked {
                            "- [x] ".to_string()
                        } else {
                            "- [ ] ".to_string()
                        }
                    }
                };
                items.push(format!("{indent}{marker}{}", inline(&item.runs)));
                i += 1;
            }
            blocks.push(items.join("\n"));
            continue;
        }
        block(view, p, offset, &mut blocks);
        i += 1;
    }
    blocks.join("\n\n")
}

fn code_fence(text: &str) -> String {
    let mut max_run = 0usize;
    let mut cur = 0usize;
    for c in text.chars() {
        if c == '`' {
            cur += 1;
            max_run = max_run.max(cur);
        } else {
            cur = 0;
        }
    }
    "`".repeat((max_run + 1).max(3))
}

fn code_span(text: &str) -> String {
    let clean = text.replace('\r', "").replace('\n', " ");
    let mut max_run = 0usize;
    let mut cur = 0usize;
    for c in clean.chars() {
        if c == '`' {
            cur += 1;
            max_run = max_run.max(cur);
        } else {
            cur = 0;
        }
    }
    let ticks = "`".repeat(max_run + 1);
    let pad = clean.starts_with('`')
        || clean.ends_with('`')
        || (clean.starts_with(' ') && clean.ends_with(' ') && clean.chars().any(|c| c != ' '));
    if pad {
        format!("{ticks} {clean} {ticks}")
    } else {
        format!("{ticks}{clean}{ticks}")
    }
}

fn block(view: &ProseView<'_>, p: &Paragraph, offset: usize, out: &mut Vec<String>) {
    if let Some(id) = p.embed() {
        match view.embed(id) {
            Some(EmbedView::Table {
                cols, rows, cells, ..
            }) if !rows.is_empty() && !cols.is_empty() => {
                let mut table_lines = Vec::with_capacity(rows.len() + 1);
                for (row_idx, row) in rows.iter().enumerate() {
                    let rendered: Vec<String> = cols
                        .iter()
                        .map(|col| {
                            if let Some(cell_runs) = view.table_cell(id, &row.id, &col.id) {
                                inline(&cell_runs)
                            } else if let Some(text) = cells.get(&(row.id.clone(), col.id.clone()))
                            {
                                text.split(['\n', LINE_BREAK])
                                    .map(escape)
                                    .collect::<Vec<_>>()
                                    .join("<br>")
                            } else {
                                String::new()
                            }
                        })
                        .collect();
                    table_lines.push(format!("| {} |", rendered.join(" | ")));
                    if row_idx == 0 {
                        let sep = vec!["---"; cols.len()].join(" | ");
                        table_lines.push(format!("| {sep} |"));
                    }
                }
                out.push(table_lines.join("\n"));
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
    code: bool,
    highlight: bool,
    link: Option<String>,
}

enum Piece {
    Text(String, Marks),
    /// A line break inside the paragraph: `<br>` between the marked pieces.
    Break,
}

/// Runs as inline Markdown: neighbours with the same marks merged, then
/// escaped and wrapped (code, highlight, bold, italic, strike, underline, link).
fn inline(runs: &[ProseRun]) -> String {
    let mut pieces: Vec<Piece> = Vec::new();
    for r in runs {
        let marks = Marks {
            bold: r.marks.bold,
            italic: r.marks.italic,
            strike: r.marks.strike,
            underline: r.marks.underline,
            code: r.marks.code,
            highlight: r.marks.highlight.is_some(),
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
        let mut value = if m.code {
            code_span(&text)
        } else {
            text.split('\n')
                .map(|l| escape(l.strip_suffix('\r').unwrap_or(l)))
                .collect::<Vec<_>>()
                .join("<br>")
        };
        if m.bold {
            value = format!("**{value}**");
        }
        if m.italic {
            value = format!("*{value}*");
        }
        if m.strike {
            value = format!("~~{value}~~");
        }
        if m.highlight {
            value = format!("=={value}==");
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

    #[test]
    fn unified_prose_formats_render_to_markdown_without_dropping_text() {
        use dr_doc::prose::{EmbedKind, ProseDoc};
        use dr_model::id::EmbedId;
        use dr_model::pos::PosKey;
        use dr_model::prose::{BlockAttrs, InlineStyle};
        use dr_model::{DocId, Origin};

        let mut doc = ProseDoc::create(
            DocId::parse("body:entry-1/mod-body").unwrap(),
            dr_doc::peer::random_device_peer(),
        )
        .unwrap();
        doc.edit(Origin::User, |txn| {
            txn.insert_paragraphs(
                0,
                "高亮与行内代码\n无序一\n有序一\n待办一\nfn demo() {}\n提示段\n",
            )?;
            txn.set_style(0..2, &InlineStyle::Highlight("yellow".into()))?;
            txn.set_style(3..7, &InlineStyle::Code)?;
            let starts: Vec<usize> = txn.view().paragraphs().map(|p| p.range.start).collect();
            txn.set_block_attrs(
                starts[1],
                &BlockAttrs {
                    list: Some(ListKind::Bullet),
                    ..BlockAttrs::default()
                },
            )?;
            txn.set_block_attrs(
                starts[2],
                &BlockAttrs {
                    list: Some(ListKind::Ordered),
                    ..BlockAttrs::default()
                },
            )?;
            txn.set_block_attrs(
                starts[3],
                &BlockAttrs {
                    list: Some(ListKind::Task),
                    checked: true,
                    ..BlockAttrs::default()
                },
            )?;
            txn.set_block_attrs(
                starts[4],
                &BlockAttrs {
                    code_block: Some("rust".into()),
                    ..BlockAttrs::default()
                },
            )?;
            txn.set_block_attrs(
                starts[5],
                &BlockAttrs {
                    callout: Some("info".into()),
                    ..BlockAttrs::default()
                },
            )?;
            let table_at = txn.view().paragraphs().last().unwrap().range.start;
            let tid = EmbedId::new_v7();
            let w = txn.insert_embed(table_at, &tid, &EmbedKind::Table)?;
            let (c1, c2) = (PosKey::first(), PosKey::first().after());
            w.add_col("c1", &c1)?;
            w.add_col("c2", &c2)?;
            w.add_row("r1", &c1)?;
            w.set_cell("r1", "c1", "表左")?;
            w.set_cell("r1", "c2", "表右")?;
            Ok(())
        })
        .0
        .unwrap();
        let md = prose(&doc.view(), 1);
        for expected in [
            "==高亮==",
            "`行内代码`",
            "- 无序一",
            "1. 有序一",
            "- [x] 待办一",
            "```rust\nfn demo() {}\n```",
            "> 提示段",
            "| 表左 | 表右 |",
        ] {
            assert!(md.contains(expected), "missing {expected:?} in:\n{md}");
        }
    }
}
