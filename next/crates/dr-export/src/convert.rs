//! The book, read from Loro through F3, reduced to a [`Manuscript`].
//!
//! The 0.1 client's rules (`services/export/manuscript-export.ts` and its
//! service), on Loro prose instead of ProseMirror JSON:
//!
//! - Reading order: the chapters before the first act, then each act's
//!   chapters. A whole-book export takes every chapter that is not
//!   discarded; a chosen set keeps book order whatever order it was chosen
//!   in. Ideas, elements, comments, TODOs, summaries never enter.
//! - Prose: H1, H2 and H3 always travel as heading levels 1–3 (there is no
//!   switch); a heading with no visible text is left out. Paragraphs keep a
//!   centre or right alignment (left is the manuscript's justified body) and
//!   their indent (0–8). Consecutive quoted paragraphs make one quote;
//!   callouts, code blocks and lists travel as structured blocks; a horizontal
//!   rule is a separator. Runs keep bold, italic, underline, strike, inline
//!   code and highlight; a link keeps its address only when it is http(s) or
//!   mailto (anything else would make the writers refuse the whole book, so
//!   its words stay as plain text); entity links and comments keep their words
//!   only; a line break inside a paragraph stays a line break. Blank
//!   paragraphs at a chapter's (and a quote's or callout's) start and end go.
//! - Embeds: a table travels as a rectangular grid of styled cell runs in row
//!   then column order; a material or an unknown embed has no words of its own
//!   and is left out.

use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use dr_doc::prose::{EmbedView, FileEmbedLook, Paragraph, ProseView, Run as ProseRun};
use dr_model::id::{AssetId, CommentId};
use dr_model::kind::ListKind as ProseListKind;
use dr_model::prose::{Align as ProseAlign, LINE_BREAK, OBJECT_CHAR};
use dr_workspace::Workspace;

use crate::Result;
use crate::manuscript::{Align, Block, Cover, ListItem, ListKind, Manuscript, Run};

pub(crate) type AssetResolver<'a> = dyn Fn(&AssetId, &FileEmbedLook) -> Option<Block> + 'a;

/// An act as the chapter picker lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActEntry {
    pub id: String,
    pub name: String,
}

/// A chapter as the picker lists it, in book order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChapterEntry {
    pub id: String,
    /// As stored (may be empty: show the untitled label).
    pub title: String,
    /// `draft`, `finished` or `discarded`.
    pub status: String,
    pub act: Option<String>,
}

impl ChapterEntry {
    /// A discarded chapter stays out of a whole-book export.
    pub fn discarded(&self) -> bool {
        self.status == "discarded"
    }
}

/// The book's acts and chapters in book order, for the export dialog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outline {
    pub book: String,
    /// The book's name: the default manuscript title.
    pub title: String,
    /// Whether the project has manuscript assembly (`成书`) enabled.
    pub has_book: bool,
    pub acts: Vec<ActEntry>,
    pub chapters: Vec<ChapterEntry>,
}

impl Outline {
    pub fn has_acts(&self) -> bool {
        !self.acts.is_empty()
    }

    /// The act's name, untitled acts included as stored.
    pub fn act_name(&self, id: &str) -> Option<&str> {
        self.acts
            .iter()
            .find(|a| a.id == id)
            .map(|a| a.name.as_str())
    }
}

/// The chapters a whole-book export includes: all but the discarded ones.
pub fn default_chapters(outline: &Outline) -> Vec<String> {
    outline
        .chapters
        .iter()
        .filter(|c| !c.discarded())
        .map(|c| c.id.clone())
        .collect()
}

/// What the author chose in the dialog.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Options {
    /// `None` exports the whole book ([`default_chapters`]).
    pub chapters: Option<Vec<String>>,
    /// Act titles get pages (sections) of their own. Without acts this has
    /// no effect.
    pub act_titles: bool,
    /// Chapter titles are shown (they stay in the navigation either way).
    pub chapter_titles: bool,
    /// Empty: the book's name.
    pub title: String,
    pub author: String,
    pub cover: Option<Cover>,
}

/// Names for what has none, in the interface language.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Labels {
    pub untitled_chapter: String,
    pub untitled_act: String,
}

/// Reads the book's acts and live chapters in book order.
pub fn outline(ws: &Workspace, book: &str) -> Result<Outline> {
    Ok(crate::v3::outline(ws, book)?.picker())
}

/// One line of a title: line breaks and tabs become one space (ideographic
/// spaces stay), ends trimmed.
pub(crate) fn one_line(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut gap = false;
    for c in title.chars() {
        if matches!(c, '\r' | '\n' | '\t') {
            gap = true;
            continue;
        }
        if gap {
            out.push(' ');
            gap = false;
        }
        out.push(c);
    }
    if gap {
        out.push(' ');
    }
    out.trim().to_owned()
}

/// `2026-10-31T08:09:10Z`, the timestamp form the writers accept.
pub fn timestamp(now: SystemTime) -> String {
    let secs = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (H. Hinnant).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// Reads the chosen chapters' prose (the live documents) and builds the
/// manuscript. `locale` is the interface language (it names a Latin-script
/// book's language); `preferred_font` is the editor font the author chose,
/// which the PDF tries first; `now` stamps the files.
pub fn read_manuscript(
    ws: &Workspace,
    book: &str,
    options: &Options,
    labels: &Labels,
    locale: &str,
    preferred_font: Option<String>,
    now: SystemTime,
) -> Result<Manuscript> {
    crate::v3::read_manuscript(ws, book, options, labels, locale, preferred_font, now)
}

/// A chapter's prose as manuscript blocks.
pub fn blocks(view: &ProseView<'_>) -> Vec<Block> {
    blocks_with_context(view, None, None)
}

pub(crate) fn blocks_with_context(
    view: &ProseView<'_>,
    done_todos: Option<&HashSet<CommentId>>,
    assets: Option<&AssetResolver<'_>>,
) -> Vec<Block> {
    let paragraphs: Vec<Paragraph> = view.paragraphs().collect();
    trim_blank(convert_slice(
        view,
        &paragraphs,
        done_todos,
        assets,
        false,
        false,
    ))
}

fn export_list_kind(kind: &ProseListKind) -> ListKind {
    match kind {
        ProseListKind::Bullet | ProseListKind::Other(_) => ListKind::Bullet,
        ProseListKind::Ordered => ListKind::Ordered,
        ProseListKind::Task => ListKind::Task,
    }
}

fn convert_slice(
    view: &ProseView<'_>,
    paragraphs: &[Paragraph],
    done_todos: Option<&HashSet<CommentId>>,
    assets: Option<&AssetResolver<'_>>,
    ignore_quote: bool,
    ignore_callout: bool,
) -> Vec<Block> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < paragraphs.len() {
        let p = &paragraphs[i];
        if !ignore_quote && p.attrs.quote && p.embed().is_none() {
            let start = i;
            i += 1;
            while i < paragraphs.len()
                && paragraphs[i].attrs.quote
                && paragraphs[i].embed().is_none()
            {
                i += 1;
            }
            let inner = trim_blank(convert_slice(
                view,
                &paragraphs[start..i],
                done_todos,
                assets,
                true,
                ignore_callout,
            ));
            if !inner.is_empty() {
                out.push(Block::Quote { blocks: inner });
            }
            continue;
        }
        if !ignore_callout
            && let Some(kind) = p.attrs.callout.as_deref()
            && p.embed().is_none()
        {
            let start = i;
            i += 1;
            while i < paragraphs.len()
                && paragraphs[i].attrs.callout.as_deref() == Some(kind)
                && paragraphs[i].embed().is_none()
                && (ignore_quote || !paragraphs[i].attrs.quote)
            {
                i += 1;
            }
            let inner = trim_blank(convert_slice(
                view,
                &paragraphs[start..i],
                done_todos,
                assets,
                ignore_quote,
                true,
            ));
            if !inner.is_empty() {
                out.push(Block::Callout {
                    kind: kind.to_owned(),
                    blocks: inner,
                });
            }
            continue;
        }
        if let Some(lang) = p.attrs.code_block.as_deref()
            && p.embed().is_none()
        {
            let mut lines = Vec::new();
            while i < paragraphs.len()
                && paragraphs[i].attrs.code_block.as_deref() == Some(lang)
                && paragraphs[i].embed().is_none()
                && (ignore_quote || !paragraphs[i].attrs.quote)
                && (ignore_callout || paragraphs[i].attrs.callout.is_none())
            {
                lines.push(plain_code_text(&paragraphs[i]));
                i += 1;
            }
            out.push(Block::CodeBlock {
                language: lang.to_owned(),
                text: lines.join("\n"),
            });
            continue;
        }
        if let Some(list_kind) = p.attrs.list.as_ref()
            && p.embed().is_none()
        {
            let mut items = Vec::new();
            while i < paragraphs.len()
                && paragraphs[i].attrs.list.as_ref() == Some(list_kind)
                && paragraphs[i].embed().is_none()
                && (ignore_quote || !paragraphs[i].attrs.quote)
                && (ignore_callout || paragraphs[i].attrs.callout.is_none())
            {
                let item = &paragraphs[i];
                let checked = if *list_kind == ProseListKind::Task {
                    match &item.attrs.todo {
                        Some(todo_id) => done_todos.is_some_and(|set| set.contains(todo_id)),
                        None => item.attrs.checked,
                    }
                } else {
                    false
                };
                items.push(ListItem {
                    runs: runs_from_prose(&item.runs),
                    level: item.attrs.list_level.min(8) as u8,
                    checked,
                });
                i += 1;
            }
            out.push(Block::List {
                kind: export_list_kind(list_kind),
                items,
            });
            continue;
        }
        paragraph_blocks(view, p, assets, &mut out);
        i += 1;
    }
    out
}

fn plain_code_text(p: &Paragraph) -> String {
    let mut text = String::new();
    for r in &p.runs {
        for c in r.text.chars() {
            if c == OBJECT_CHAR {
                continue;
            }
            text.push(if c == LINE_BREAK { '\n' } else { c });
        }
    }
    text
}

fn paragraph_blocks(
    view: &ProseView<'_>,
    p: &Paragraph,
    assets: Option<&AssetResolver<'_>>,
    out: &mut Vec<Block>,
) {
    if let Some(id) = p.embed() {
        match view.embed(id) {
            Some(EmbedView::Table {
                cols, rows, cells, ..
            }) if !rows.is_empty() && !cols.is_empty() => {
                let grid = rows
                    .iter()
                    .map(|row| {
                        cols.iter()
                            .map(|col| {
                                if let Some(cell_runs) = view.table_cell(id, &row.id, &col.id) {
                                    runs_from_prose(&cell_runs)
                                } else if let Some(text) =
                                    cells.get(&(row.id.clone(), col.id.clone()))
                                {
                                    let clean: String = text
                                        .chars()
                                        .filter(|&c| c != OBJECT_CHAR)
                                        .map(|c| if c == LINE_BREAK { '\n' } else { c })
                                        .collect();
                                    if clean.is_empty() {
                                        Vec::new()
                                    } else {
                                        vec![Run {
                                            text: clean,
                                            ..Run::default()
                                        }]
                                    }
                                } else {
                                    Vec::new()
                                }
                            })
                            .collect()
                    })
                    .collect();
                out.push(Block::Table { rows: grid });
            }
            Some(EmbedView::Asset {
                asset: Some(asset_id),
                look,
                ..
            }) => {
                if let Some(resolve) = assets
                    && let Some(block) = resolve(&asset_id, &look)
                {
                    out.push(block);
                }
            }
            _ => {}
        }
        return;
    }
    if p.attrs.rule {
        out.push(Block::Break);
        return;
    }
    let runs = runs_from_prose(&p.runs);
    let align = match p.attrs.align {
        ProseAlign::Center => Align::Center,
        ProseAlign::Right => Align::Right,
        ProseAlign::Left => Align::Justify,
    };
    if let Some(h) = p.attrs.heading {
        if runs.iter().any(|r| !r.text.trim().is_empty()) {
            out.push(Block::Heading {
                level: h.level() as u8,
                runs,
                align,
            });
        }
        return;
    }
    out.push(Block::Paragraph {
        runs,
        align,
        indent: p.attrs.indent.min(8),
    });
}

fn same_marks(a: &Run, b: &Run) -> bool {
    a.bold == b.bold
        && a.italic == b.italic
        && a.underline == b.underline
        && a.strike == b.strike
        && a.code == b.code
        && a.highlight == b.highlight
        && a.href == b.href
}

/// Runs from Loro prose: inline styles (including code and highlight) and web
/// or mail links kept, line breaks as `\n`, object placeholders dropped, equal
/// neighbours merged.
fn runs_from_prose(runs: &[ProseRun]) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::new();
    for r in runs {
        let text: String = r
            .text
            .chars()
            .filter(|&c| c != OBJECT_CHAR)
            .map(|c| if c == LINE_BREAK { '\n' } else { c })
            .collect();
        if text.is_empty() {
            continue;
        }
        let href = r
            .marks
            .link
            .as_deref()
            .map(str::trim)
            .filter(|h| crate::manuscript::exported_link(h))
            .map(str::to_owned);
        let run = Run {
            text,
            bold: r.marks.bold,
            italic: r.marks.italic,
            underline: r.marks.underline,
            strike: r.marks.strike,
            code: r.marks.code,
            highlight: r.marks.highlight.is_some(),
            href,
        };
        match out.last_mut() {
            Some(last) if same_marks(last, &run) => last.text.push_str(&run.text),
            _ => out.push(run),
        }
    }
    out
}

fn is_blank(b: &Block) -> bool {
    matches!(b, Block::Paragraph { runs, .. } if runs.iter().all(|r| r.text.trim().is_empty()))
}

fn trim_blank(mut blocks: Vec<Block>) -> Vec<Block> {
    while blocks.last().is_some_and(is_blank) {
        blocks.pop();
    }
    let start = blocks.iter().take_while(|b| is_blank(b)).count();
    blocks.drain(..start);
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_become_one_line() {
        assert_eq!(one_line(" 第一章\n\t来信 "), "第一章 来信");
        assert_eq!(one_line("序章　灯下"), "序章　灯下");
        assert_eq!(one_line("\n"), "");
    }

    #[test]
    fn timestamps_are_utc_seconds() {
        let t = UNIX_EPOCH + std::time::Duration::from_secs(1_793_434_150);
        assert_eq!(timestamp(t), "2026-10-31T08:09:10Z");
        assert_eq!(timestamp(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(
            timestamp(UNIX_EPOCH + std::time::Duration::from_secs(951_782_400)),
            "2000-02-29T00:00:00Z"
        );
    }
}
