//! GPUI Markdown renderer for Agent replies and Working Memory.
//!
//! Renders headings, paragraphs, bullet/ordered lists, fenced code blocks,
//! blockquotes (using soft wash rather than an inset-left vertical accent bar),
//! horizontal rules, GFM pipe tables, inline emphasis/code/strike, external
//! `http(s)://` links, and clickable `drifting:` deep links into the open book.
//!
//! Plain text blocks without links render via `StyledText` with zero focusable
//! child controls so disclosure Tab order in the transcript stays deterministic.

use std::{ops::Range, rc::Rc};

use dr_shell::nav::Target;
use dr_ui::{
    Theme,
    fonts::{Role, weight},
    style::DrStyled as _,
    tokens::radius,
};
use gpui::{
    AnyElement, App, ElementId, FontStyle, HighlightStyle, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, StrikethroughStyle,
    Styled as _, StyledText, UnderlineStyle, Window, div, prelude::FluentBuilder as _, px,
};

pub type OpenTargetFn = Rc<dyn Fn(Target, &mut Window, &mut App)>;

/// Parses a `drifting:` deep link into a workspace [`Target`].
///
/// Supported forms:
/// - `drifting:entry/<id>` or `drifting://entry/<id>`
/// - `drifting:entry/<id>/<module>`
/// - `drifting:material/<id>` or `drifting:asset/<id>`
/// - `drifting:template/<id>`
/// - `drifting:book-view/<id>` or `drifting:timeline/<id>`
pub fn parse_drifting_link(url: &str) -> Option<Target> {
    let rest = url
        .strip_prefix("drifting://")
        .or_else(|| url.strip_prefix("drifting:"))?;
    let rest = rest.trim_start_matches('/');
    let mut parts = rest.splitn(3, '/');
    let kind = parts.next()?;
    let id = parts.next()?.trim();
    if id.is_empty() {
        return None;
    }
    let extra = parts.next().map(str::trim).filter(|s| !s.is_empty());
    let key = match kind {
        "entry" | "chapter" | "element" => match extra {
            Some(module) => format!("entry:{id}/{module}"),
            None => format!("entry:{id}"),
        },
        "material" | "asset" => format!("material:{id}"),
        "template" => format!("template:{id}"),
        "book-view" | "timeline" | "timeline-view" => format!("book-view:{id}"),
        _ => return None,
    };
    Target::from_key(&key)
}

#[derive(Clone, Debug)]
enum Block {
    Heading {
        level: u8,
        text: String,
    },
    Paragraph(String),
    Code {
        lang: String,
        code: String,
    },
    Quote(Vec<String>),
    Rule,
    List {
        items: Vec<(String, String)>,
    },
    Table {
        headers: Vec<String>,
        rows: Vec<Vec<String>>,
    },
}

fn parse_blocks(input: &str) -> Vec<Block> {
    let lines: Vec<&str> = input.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let trimmed = lines[i].trim();
        if trimmed.is_empty() {
            i += 1;
            continue;
        }
        // Fenced code block
        if let Some(rest) = trimmed.strip_prefix("```") {
            let lang = rest.trim().to_owned();
            i += 1;
            let mut code = Vec::new();
            while i < lines.len() && !lines[i].trim_start().starts_with("```") {
                code.push(lines[i]);
                i += 1;
            }
            if i < lines.len() {
                i += 1;
            }
            out.push(Block::Code {
                lang,
                code: code.join("\n"),
            });
            continue;
        }
        // Horizontal rule
        if is_rule(trimmed) {
            out.push(Block::Rule);
            i += 1;
            continue;
        }
        // ATX Heading
        if let Some((level, text)) = parse_heading(trimmed) {
            out.push(Block::Heading {
                level,
                text: text.to_owned(),
            });
            i += 1;
            continue;
        }
        // GFM pipe table
        if trimmed.contains('|') && i + 1 < lines.len() && is_table_separator(lines[i + 1].trim()) {
            let headers = split_table_row(trimmed);
            i += 2;
            let mut rows = Vec::new();
            while i < lines.len() {
                let row = lines[i].trim();
                if row.is_empty() || !row.contains('|') {
                    break;
                }
                rows.push(split_table_row(row));
                i += 1;
            }
            out.push(Block::Table { headers, rows });
            continue;
        }
        // Blockquote
        if trimmed.starts_with('>') {
            let mut quote_lines = Vec::new();
            while i < lines.len() {
                let line = lines[i].trim();
                if let Some(stripped) = line.strip_prefix('>') {
                    quote_lines.push(stripped.trim_start().to_owned());
                    i += 1;
                } else {
                    break;
                }
            }
            out.push(Block::Quote(quote_lines));
            continue;
        }
        // Bullet or ordered list
        if let Some((ordered, marker, item)) = parse_list_item(lines[i]) {
            let mut items = vec![(marker, item)];
            i += 1;
            while i < lines.len() {
                if let Some((ord, m, it)) = parse_list_item(lines[i])
                    && ord == ordered
                {
                    items.push((m, it));
                    i += 1;
                } else {
                    break;
                }
            }
            out.push(Block::List { items });
            continue;
        }
        // Paragraph
        let mut para = vec![lines[i]];
        i += 1;
        while i < lines.len() {
            let next = lines[i].trim();
            if next.is_empty()
                || next.starts_with("```")
                || is_rule(next)
                || parse_heading(next).is_some()
                || next.starts_with('>')
                || parse_list_item(lines[i]).is_some()
                || (next.contains('|')
                    && i + 1 < lines.len()
                    && is_table_separator(lines[i + 1].trim()))
            {
                break;
            }
            para.push(lines[i]);
            i += 1;
        }
        out.push(Block::Paragraph(para.join("\n")));
    }
    out
}

fn is_rule(trimmed: &str) -> bool {
    if trimmed.len() < 3 {
        return false;
    }
    let bytes: Vec<char> = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    bytes.len() >= 3 && matches!(bytes[0], '-' | '*' | '_') && bytes.iter().all(|&c| c == bytes[0])
}

fn parse_heading(trimmed: &str) -> Option<(u8, &str)> {
    let hashes = trimmed.bytes().take_while(|&b| b == b'#').count();
    if (1..=4).contains(&hashes) {
        let rest = &trimmed[hashes..];
        if let Some(text) = rest.strip_prefix(' ') {
            return Some((hashes as u8, text.trim_end_matches('#').trim()));
        }
    }
    None
}

fn is_table_separator(trimmed: &str) -> bool {
    if !trimmed.contains('-') || !trimmed.contains('|') {
        return false;
    }
    let cells = split_table_row(trimmed);
    !cells.is_empty()
        && cells.iter().all(|cell| {
            let c = cell.trim();
            !c.is_empty() && c.chars().all(|ch| matches!(ch, '-' | ':')) && c.contains('-')
        })
}

fn split_table_row(line: &str) -> Vec<String> {
    let s = line.trim().trim_start_matches('|').trim_end_matches('|');
    s.split('|').map(|c| c.trim().to_owned()).collect()
}

fn parse_list_item(line: &str) -> Option<(bool, String, String)> {
    let trimmed = line.trim_start();
    for prefix in ["- ", "* ", "+ "] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return Some((false, "•".to_owned(), rest.to_owned()));
        }
    }
    let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 && digits <= 4 {
        let after = &trimmed[digits..];
        if let Some(rest) = after.strip_prefix(". ") {
            return Some((true, format!("{}.", &trimmed[..digits]), rest.to_owned()));
        }
    }
    None
}

#[derive(Clone, Debug)]
enum InlineSegment {
    Styled {
        text: String,
        highlights: Vec<(Range<usize>, InlineKind)>,
    },
    Link {
        label: String,
        url: String,
    },
}

#[derive(Clone, Copy, Debug)]
enum InlineKind {
    Bold,
    Italic,
    Code,
    Strike,
}

fn parse_inline(text: &str) -> Vec<InlineSegment> {
    let mut segments: Vec<InlineSegment> = Vec::new();
    let mut plain = String::new();
    let mut highlights: Vec<(Range<usize>, InlineKind)> = Vec::new();
    let flush_styled = |segments: &mut Vec<InlineSegment>,
                        plain: &mut String,
                        highlights: &mut Vec<(Range<usize>, InlineKind)>| {
        if !plain.is_empty() {
            segments.push(InlineSegment::Styled {
                text: std::mem::take(plain),
                highlights: std::mem::take(highlights),
            });
        }
    };

    let mut rest = text;
    while !rest.is_empty() {
        // Inline code: `...`
        if let Some(after) = rest.strip_prefix('`')
            && let Some(end) = after.find('`')
            && end > 0
        {
            let start = plain.len();
            plain.push_str(&after[..end]);
            highlights.push((start..plain.len(), InlineKind::Code));
            rest = &after[end + 1..];
            continue;
        }
        // Bold: **...**
        if let Some(after) = rest.strip_prefix("**")
            && let Some(end) = after.find("**")
            && end > 0
        {
            let start = plain.len();
            plain.push_str(&after[..end]);
            highlights.push((start..plain.len(), InlineKind::Bold));
            rest = &after[end + 2..];
            continue;
        }
        // Strike: ~~...~~
        if let Some(after) = rest.strip_prefix("~~")
            && let Some(end) = after.find("~~")
            && end > 0
        {
            let start = plain.len();
            plain.push_str(&after[..end]);
            highlights.push((start..plain.len(), InlineKind::Strike));
            rest = &after[end + 2..];
            continue;
        }
        // Link: [label](url)
        if let Some(after) = rest.strip_prefix('[')
            && let Some(close_bracket) = after.find("](")
        {
            let label = &after[..close_bracket];
            let url_part = &after[close_bracket + 2..];
            if !label.is_empty()
                && let Some(close_paren) = url_part.find(')')
            {
                let url = url_part[..close_paren].trim();
                let valid =
                    parse_drifting_link(url).is_some() || crate::data::web_url(url).is_some();
                if valid {
                    flush_styled(&mut segments, &mut plain, &mut highlights);
                    segments.push(InlineSegment::Link {
                        label: label.to_owned(),
                        url: url.to_owned(),
                    });
                    rest = &url_part[close_paren + 1..];
                    continue;
                }
            }
        }
        // Italic: *...* (single asterisk, not followed by space)
        if let Some(after) = rest.strip_prefix('*')
            && !after.starts_with('*')
            && !after.starts_with(' ')
            && let Some(end) = after.find('*')
            && end > 0
        {
            let start = plain.len();
            plain.push_str(&after[..end]);
            highlights.push((start..plain.len(), InlineKind::Italic));
            rest = &after[end + 1..];
            continue;
        }
        // Consume one character
        let mut chars = rest.chars();
        if let Some(ch) = chars.next() {
            plain.push(ch);
            rest = chars.as_str();
        }
    }
    flush_styled(&mut segments, &mut plain, &mut highlights);
    segments
}

fn highlight_style(kind: InlineKind, window: &Window, cx: &App) -> HighlightStyle {
    let p = Theme::of(window, cx).palette;
    match kind {
        InlineKind::Bold => HighlightStyle {
            font_weight: Some(weight::SEMIBOLD),
            ..Default::default()
        },
        InlineKind::Italic => HighlightStyle {
            font_style: Some(FontStyle::Italic),
            ..Default::default()
        },
        InlineKind::Code => HighlightStyle {
            background_color: Some(p.ink(1).alpha(0.06)),
            color: Some(p.ink(1).solid()),
            ..Default::default()
        },
        InlineKind::Strike => HighlightStyle {
            strikethrough: Some(StrikethroughStyle {
                thickness: px(1.0),
                color: Some(p.ink(3).solid()),
            }),
            color: Some(p.ink(3).solid()),
            ..Default::default()
        },
    }
}

fn render_inline(
    id_prefix: &str,
    text: &str,
    on_open: &Option<OpenTargetFn>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let segments = parse_inline(text);
    if segments.is_empty() {
        return div().into_any_element();
    }
    let p = Theme::of(window, cx).palette;
    let has_links = segments
        .iter()
        .any(|s| matches!(s, InlineSegment::Link { .. }));
    if !has_links && let [InlineSegment::Styled { text, highlights }] = segments.as_slice() {
        if highlights.is_empty() {
            return dr_ui::text::wrapped(text.clone()).into_any_element();
        }
        let styled = StyledText::new(SharedString::from(text.clone())).with_highlights(
            highlights
                .iter()
                .map(|(range, kind)| (range.clone(), highlight_style(*kind, window, cx))),
        );
        return div().min_w_0().child(styled).into_any_element();
    }
    let mut row = div()
        .flex()
        .flex_wrap()
        .items_baseline()
        .gap_x(px(2.0))
        .min_w_0();
    for (idx, seg) in segments.into_iter().enumerate() {
        match seg {
            InlineSegment::Styled { text, highlights } => {
                let styled = StyledText::new(SharedString::from(text)).with_highlights(
                    highlights
                        .into_iter()
                        .map(|(range, kind)| (range, highlight_style(kind, window, cx))),
                );
                row = row.child(div().min_w_0().child(styled));
            }
            InlineSegment::Link { label, url } => {
                let link_id = ElementId::Name(format!("{id_prefix}:link:{idx}").into());
                let target = parse_drifting_link(&url);
                let web = crate::data::web_url(&url);
                let opener = on_open.clone();
                let accent = p.accent.solid();
                let display = if target.is_some() {
                    format!("↗ {label}")
                } else {
                    label
                };
                let len = display.len();
                let styled_link = StyledText::new(SharedString::from(display)).with_highlights([(
                    0..len,
                    HighlightStyle {
                        underline: Some(UnderlineStyle {
                            thickness: px(1.0),
                            color: Some(accent),
                            wavy: false,
                        }),
                        ..Default::default()
                    },
                )]);
                let mut el = div()
                    .id(link_id)
                    .cursor_pointer()
                    .text_color(accent)
                    .px(px(2.0))
                    .rounded(px(3.0))
                    .hover(move |st| st.bg(p.accent.alpha(0.08)))
                    .child(styled_link);
                if let Some(target) = target {
                    if let Some(open) = opener {
                        el = el.on_click(move |_, window, cx| open(target.clone(), window, cx));
                    }
                } else if let Some(web) = web {
                    el = el.on_click(move |_, _, cx| cx.open_url(&web));
                }
                row = row.child(el);
            }
        }
    }
    row.into_any_element()
}

/// Renders `markdown` into a clean GPUI element column.
pub fn render_markdown(
    id_prefix: &str,
    markdown: &str,
    on_open: Option<OpenTargetFn>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let (p, s) = (theme.palette, theme.scale);
    let blocks = parse_blocks(markdown);
    if blocks.is_empty() {
        return dr_ui::text::wrapped(markdown.to_owned()).into_any_element();
    }
    let mut col = div().flex().flex_col().gap(px(8.0)).min_w_0();
    for (idx, block) in blocks.into_iter().enumerate() {
        let block_id = format!("{id_prefix}:b{idx}");
        match block {
            Block::Heading { level, text } => {
                let (size, line) = match level {
                    1 => (s.body + 4.0, s.line_body + 5.0),
                    2 => (s.body + 2.0, s.line_body + 3.0),
                    _ => (s.body + 0.5, s.line_body + 1.0),
                };
                col = col.child(
                    div()
                        .min_w_0()
                        .pt(px(if idx == 0 { 0.0 } else { 4.0 }))
                        .font_role(Role::Structure)
                        .type_px(size, line)
                        .weight(weight::SEMIBOLD)
                        .text_color(p.ink(1).solid())
                        .child(render_inline(&block_id, &text, &on_open, window, cx)),
                );
            }
            Block::Paragraph(text) => {
                col = col.child(render_inline(&block_id, &text, &on_open, window, cx));
            }
            Block::Code { lang, code } => {
                col = col.child(
                    div()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .p(px(10.0))
                        .rounded(px(radius::SM))
                        .bg(p.paper.solid())
                        .border(px(0.5))
                        .border_color(p.hairline())
                        .when(!lang.is_empty(), |el| {
                            el.child(
                                div()
                                    .font_role(Role::Index)
                                    .type_px(s.caption, s.line_caption)
                                    .text_color(p.ink(4).solid())
                                    .child(lang),
                            )
                        })
                        .child(
                            div()
                                .min_w_0()
                                .font_role(Role::Index)
                                .type_px((s.body - 1.5).max(11.5), (s.line_body - 2.0).max(16.0))
                                .text_color(p.ink(1).solid())
                                .child(dr_ui::text::wrapped(code)),
                        ),
                );
            }
            Block::Quote(lines) => {
                // Uses subtle wash + padding (never an inset-left vertical accent bar).
                col = col.child(
                    div()
                        .min_w_0()
                        .px(px(10.0))
                        .py(px(7.0))
                        .rounded(px(radius::SM))
                        .bg(p.ink(1).alpha(0.035))
                        .text_color(p.ink(2).solid())
                        .child(render_inline(
                            &block_id,
                            &lines.join("\n"),
                            &on_open,
                            window,
                            cx,
                        )),
                );
            }
            Block::Rule => {
                col = col.child(div().w_full().h(px(0.5)).my(px(4.0)).bg(p.hairline()));
            }
            Block::List { items } => {
                let mut list = div().flex().flex_col().gap(px(4.0)).min_w_0();
                for (item_idx, (marker, text)) in items.into_iter().enumerate() {
                    let item_id = format!("{block_id}:i{item_idx}");
                    list = list.child(
                        div()
                            .flex()
                            .flex_row()
                            .items_start()
                            .gap(px(6.0))
                            .min_w_0()
                            .child(
                                div()
                                    .flex_none()
                                    .font_role(Role::Index)
                                    .text_color(p.ink(3).solid())
                                    .child(marker),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .child(render_inline(&item_id, &text, &on_open, window, cx)),
                            ),
                    );
                }
                col = col.child(list);
            }
            Block::Table { headers, rows } => {
                let mut table = div()
                    .w_full()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .rounded(px(radius::SM))
                    .border(px(0.5))
                    .border_color(p.hairline())
                    .overflow_hidden();
                let mut head = div()
                    .flex()
                    .flex_row()
                    .bg(p.paper.solid())
                    .border_b(px(0.5))
                    .border_color(p.hairline());
                for (c_idx, h) in headers.iter().enumerate() {
                    let cell_id = format!("{block_id}:th{c_idx}");
                    head = head.child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .px(px(8.0))
                            .py(px(5.0))
                            .weight(weight::MEDIUM)
                            .type_px(s.caption, s.line_caption)
                            .child(render_inline(&cell_id, h, &on_open, window, cx)),
                    );
                }
                table = table.child(head);
                for (r_idx, row) in rows.iter().enumerate() {
                    let mut tr = div().flex().flex_row().when(r_idx + 1 < rows.len(), |el| {
                        el.border_b(px(0.5)).border_color(p.hairline())
                    });
                    for (c_idx, cell) in row.iter().enumerate() {
                        let cell_id = format!("{block_id}:r{r_idx}c{c_idx}");
                        tr = tr.child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .px(px(8.0))
                                .py(px(5.0))
                                .type_px(s.caption, s.line_caption)
                                .child(render_inline(&cell_id, cell, &on_open, window, cx)),
                        );
                    }
                    table = table.child(tr);
                }
                col = col.child(table);
            }
        }
    }
    col.into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_drifting_deep_links() {
        assert_eq!(
            parse_drifting_link("drifting:entry/abc").unwrap().key(),
            "entry:abc"
        );
        assert_eq!(
            parse_drifting_link("drifting://entry/abc/mod-prose")
                .unwrap()
                .key(),
            "entry:abc/mod-prose"
        );
        assert_eq!(
            parse_drifting_link("drifting:material/m1").unwrap().key(),
            "material:m1"
        );
        assert_eq!(
            parse_drifting_link("drifting:template/tpl-chapter")
                .unwrap()
                .key(),
            "template:tpl-chapter"
        );
        assert_eq!(
            parse_drifting_link("drifting:book-view/tv-1")
                .unwrap()
                .key(),
            "book-view:tv-1"
        );
        assert!(parse_drifting_link("https://example.com").is_none());
        assert!(parse_drifting_link("drifting:unknown/x").is_none());
    }

    #[test]
    fn parses_markdown_blocks_and_inline_spans() {
        let md = "# Title\n\nSome **bold** and `code` with [Chapter](drifting:entry/ch1).\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n";
        let blocks = parse_blocks(md);
        assert!(matches!(blocks[0], Block::Heading { level: 1, .. }));
        assert!(matches!(blocks[1], Block::Paragraph(_)));
        assert!(matches!(blocks[2], Block::List { .. }));
        assert!(matches!(blocks[3], Block::Table { .. }));
        let segs = parse_inline("See [Chapter](drifting:entry/ch1) and **bold**");
        assert!(segs.iter().any(|s| matches!(s, InlineSegment::Link { .. })));
    }
}
