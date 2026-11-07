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
//!   their indent (0–8). Consecutive quoted paragraphs make one quote; a
//!   horizontal rule is a separator. Runs keep bold, italic, underline and
//!   strike; a link keeps its address only when it is http(s) or mailto
//!   (anything else would make the writers refuse the whole book, so its
//!   words stay as plain text); entity links, comments and highlights keep
//!   their words only; a line break inside a paragraph stays a line break.
//!   Blank paragraphs at a chapter's (and a quote's) start and end go.
//! - Embeds (decided here, 0.1 had them in ProseMirror nodes): a table keeps
//!   its words, one paragraph per non-empty cell line in row then column
//!   order (0.1 kept the words of nodes outside the prose profile); a
//!   material or an unknown embed has no words of its own and is left out.

use std::time::{SystemTime, UNIX_EPOCH};

use dr_doc::prose::{EmbedView, Paragraph, ProseView};
use dr_model::prose::{Align as ProseAlign, LINE_BREAK, OBJECT_CHAR};
use dr_workspace::commands::book::BookGet;
use dr_workspace::commands::chapter::{ActList, ChapterList};
use dr_workspace::commands::{BookIn, ListIn};
use dr_workspace::{Actor, Workspace};

use crate::manuscript::{Align, Block, Cover, Manuscript, Run, Section};
use crate::{ExportError, Result};

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
    let actor = Actor::User;
    let detail = ws
        .run::<BookGet>(
            &actor,
            BookIn {
                book: book.to_owned(),
            },
        )?
        .output;
    if detail.info.trashed {
        return Err(ExportError::NotFound(format!("book {book}")));
    }
    let acts = ws
        .run::<ActList>(
            &actor,
            BookIn {
                book: book.to_owned(),
            },
        )?
        .output;
    let listed = ws
        .run::<ChapterList>(
            &actor,
            ListIn {
                book: book.to_owned(),
                trashed: false,
            },
        )?
        .output;
    let entry = |c: &dr_workspace::dto::ChapterInfo| ChapterEntry {
        id: c.id.clone(),
        title: c.title.clone(),
        status: c.status.clone(),
        act: c.act.clone(),
    };
    let live: Vec<_> = listed.iter().filter(|c| !c.trashed).collect();
    // Book order: the chapters before the first act, then each act's.
    let mut chapters: Vec<ChapterEntry> = live
        .iter()
        .filter(|c| {
            c.act
                .as_ref()
                .is_none_or(|a| !acts.iter().any(|x| &x.id == a))
        })
        .map(|c| entry(c))
        .collect();
    for act in &acts {
        chapters.extend(
            live.iter()
                .filter(|c| c.act.as_deref() == Some(act.id.as_str()))
                .map(|c| entry(c)),
        );
    }
    Ok(Outline {
        book: book.to_owned(),
        title: detail.info.name,
        acts: acts
            .into_iter()
            .map(|a| ActEntry {
                id: a.id,
                name: a.name,
            })
            .collect(),
        chapters,
    })
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
    let outline = outline(ws, book)?;
    let chosen: Vec<&ChapterEntry> = match &options.chapters {
        None => outline.chapters.iter().filter(|c| !c.discarded()).collect(),
        Some(ids) => outline
            .chapters
            .iter()
            .filter(|c| ids.iter().any(|id| id == &c.id))
            .collect(),
    };
    if chosen.is_empty() {
        return Err(ExportError::NoChapters);
    }
    let act_titles = options.act_titles && outline.has_acts();
    let mut sections = Vec::new();
    let mut current_act: Option<&str> = None;
    for chapter in chosen {
        if act_titles
            && let Some(act) = chapter.act.as_deref()
            && current_act != Some(act)
        {
            let name = one_line(outline.act_name(act).unwrap_or(""));
            sections.push(Section::Act {
                title: if name.is_empty() {
                    labels.untitled_act.clone()
                } else {
                    name
                },
            });
        }
        current_act = chapter.act.as_deref();
        let session = ws.prose_session(&format!("node:{}", chapter.id))?;
        let reader = session.reader();
        let blocks = blocks(&reader.view());
        let title = one_line(&chapter.title);
        sections.push(Section::Chapter {
            title: if title.is_empty() {
                labels.untitled_chapter.clone()
            } else {
                title
            },
            show_title: options.chapter_titles,
            blocks,
        });
    }
    // An empty title is the book's name (and an empty name fails at render,
    // as in 0.1: the dialog keeps export off without a title).
    let title = options.title.trim();
    Ok(Manuscript {
        title: if title.is_empty() {
            outline.title.trim().to_owned()
        } else {
            title.to_owned()
        },
        author: options.author.trim().to_owned(),
        identifier: book.to_owned(),
        modified: timestamp(now),
        locale: locale.to_owned(),
        preferred_font: preferred_font.filter(|f| !f.trim().is_empty()),
        cover: options.cover.clone(),
        sections,
    })
}

/// A chapter's prose as manuscript blocks.
pub fn blocks(view: &ProseView<'_>) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::new();
    let mut quote: Option<Vec<Block>> = None;
    for p in view.paragraphs() {
        let mut converted = Vec::new();
        paragraph_blocks(view, &p, &mut converted);
        if p.attrs.quote {
            quote.get_or_insert_with(Vec::new).extend(converted);
        } else {
            close_quote(&mut quote, &mut out);
            out.extend(converted);
        }
    }
    close_quote(&mut quote, &mut out);
    trim_blank(out)
}

fn close_quote(quote: &mut Option<Vec<Block>>, out: &mut Vec<Block>) {
    if let Some(inner) = quote.take() {
        let inner = trim_blank(inner);
        if !inner.is_empty() {
            out.push(Block::Quote { blocks: inner });
        }
    }
}

fn paragraph_blocks(view: &ProseView<'_>, p: &Paragraph, out: &mut Vec<Block>) {
    if let Some(id) = p.embed() {
        if let Some(EmbedView::Table {
            cols, rows, cells, ..
        }) = view.embed(id)
        {
            for row in &rows {
                for col in &cols {
                    let Some(text) = cells.get(&(row.id.clone(), col.id.clone())) else {
                        continue;
                    };
                    for line in text.split(['\n', LINE_BREAK]) {
                        if !line.trim().is_empty() {
                            out.push(Block::Paragraph {
                                runs: vec![Run {
                                    text: line.to_owned(),
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
        return;
    }
    if p.attrs.rule {
        out.push(Block::Break);
        return;
    }
    let runs = runs(p);
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
        && a.href == b.href
}

/// A paragraph's runs: inline styles and web or mail links kept, line
/// breaks as `\n`, object placeholders dropped, equal neighbours merged.
fn runs(p: &Paragraph) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::new();
    for r in &p.runs {
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
