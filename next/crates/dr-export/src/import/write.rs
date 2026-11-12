use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};

use dr_model::prose::{
    Align as ProseAlign, BlockAttrs, Heading, InlineStyle, LINE_BREAK, MAX_INDENT, OBJECT_CHAR,
};
use dr_workspace::commands::BookIn;
use dr_workspace::commands::book::BookGet;
use dr_workspace::{Actor, Workspace};

use super::{ParsedDoc, title_from_filename};
use crate::manuscript::{Align, Block, Run};
use crate::{ExportError, Result};

/// The longest name a file gives what it becomes (the 0.1 dialog's 200).
pub const MAX_NAME: usize = 200;

/// What each file becomes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportTarget {
    /// A chapter after the last one, on `storyline` when given.
    Chapter { storyline: Option<String> },
    /// An idea (构想).
    Idea,
    /// An element in `category` when given.
    Element { category: Option<String> },
}

/// What one file became.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedEntity {
    pub id: String,
    /// The final name (a taken chapter or idea title gets a suffix).
    pub name: String,
    /// Its prose document (`node:<id>`, `element:<id>`).
    pub doc: String,
}

/// One file's outcome, in the order given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedItem {
    /// The name asked for.
    pub title: String,
    /// What it became, or why it did not (the command's message).
    pub result: std::result::Result<ImportedEntity, String>,
}

/// One paragraph to write: its text (line breaks as U+2028), attributes
/// and inline styles (character ranges within the paragraph).
struct Line {
    text: String,
    attrs: BlockAttrs,
    styles: Vec<(Range<usize>, InlineStyle)>,
}

fn prose_align(a: Align) -> ProseAlign {
    match a {
        Align::Center => ProseAlign::Center,
        Align::Right => ProseAlign::Right,
        Align::Justify | Align::Left => ProseAlign::Left,
    }
}

fn line(runs: &[Run], attrs: BlockAttrs) -> Line {
    let mut text = String::new();
    let mut styles = Vec::new();
    let mut at = 0;
    for r in runs {
        let piece: String = r
            .text
            .chars()
            .filter(|c| *c != OBJECT_CHAR && *c != '\r')
            .map(|c| if c == '\n' { LINE_BREAK } else { c })
            .collect();
        let n = piece.chars().count();
        if n == 0 {
            continue;
        }
        let range = at..at + n;
        let mut push = |on: bool, s: InlineStyle| {
            if on {
                styles.push((range.clone(), s));
            }
        };
        push(r.bold, InlineStyle::Bold);
        push(r.italic, InlineStyle::Italic);
        push(r.underline, InlineStyle::Underline);
        push(r.strike, InlineStyle::Strike);
        if let Some(h) = r
            .href
            .as_deref()
            .map(str::trim)
            .filter(|h| crate::manuscript::exported_link(h))
        {
            styles.push((range.clone(), InlineStyle::Link(h.to_owned())));
        }
        text.push_str(&piece);
        at += n;
    }
    Line {
        text,
        attrs,
        styles,
    }
}

fn lines(blocks: &[Block], quote: bool, out: &mut Vec<Line>) {
    for b in blocks {
        match b {
            Block::Heading { level, runs, align } => {
                let heading = match level {
                    1 => Heading::H1,
                    2 => Heading::H2,
                    _ => Heading::H3,
                };
                out.push(line(
                    runs,
                    BlockAttrs {
                        heading: Some(heading),
                        quote,
                        align: prose_align(*align),
                        ..BlockAttrs::default()
                    },
                ));
            }
            Block::Paragraph {
                runs,
                align,
                indent,
            } => out.push(line(
                runs,
                BlockAttrs {
                    quote,
                    align: prose_align(*align),
                    indent: (*indent).min(MAX_INDENT),
                    ..BlockAttrs::default()
                },
            )),
            Block::Quote { blocks } => lines(blocks, true, out),
            Block::Break => out.push(Line {
                text: String::new(),
                attrs: BlockAttrs {
                    rule: true,
                    quote,
                    ..BlockAttrs::default()
                },
                styles: Vec::new(),
            }),
        }
    }
}

/// The name a file's entity is asked for: the dialog's, else the parsed
/// title, else the file's name; at most [`MAX_NAME`] characters.
fn name_for(asked: &str, parsed: &ParsedDoc) -> String {
    let name = [asked.trim(), parsed.title.trim()]
        .into_iter()
        .find(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| title_from_filename(&parsed.filename));
    name.chars().take(MAX_NAME).collect()
}

/// Create one entity per `(name, file)` in `book`, in order, as `actor`.
/// `cancel` stops before the next file. Fails only when the book is gone;
/// each file's own failure is in its [`ImportedItem`].
pub fn import_docs(
    ws: &Workspace,
    actor: &Actor,
    book: &str,
    target: &ImportTarget,
    docs: &[(String, ParsedDoc)],
    cancel: Option<&AtomicBool>,
) -> Result<Vec<ImportedItem>> {
    let detail = ws
        .run::<BookGet>(
            actor,
            BookIn {
                book: book.to_owned(),
            },
        )?
        .output;
    if detail.trashed {
        return Err(ExportError::NotFound(format!("book {book}")));
    }
    let mut out = Vec::new();
    for (asked, parsed) in docs {
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            break;
        }
        let title = name_for(asked, parsed);
        let result = import_one(ws, actor, book, target, &title, parsed).map_err(|e| e.to_string());
        out.push(ImportedItem { title, result });
    }
    Ok(out)
}

fn import_one(
    ws: &Workspace,
    actor: &Actor,
    book: &str,
    target: &ImportTarget,
    title: &str,
    parsed: &ParsedDoc,
) -> Result<ImportedEntity> {
    let mut ls = Vec::new();
    lines(&parsed.blocks, false, &mut ls);
    let text = ls
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let text = (!text.is_empty()).then_some(text);
    // These are the existing novel import destinations. Their actual dynamic
    // roots, level defaults, home and membership are resolved by the v3 kernel.
    use dr_doc::v3::novel;
    let book_id = book
        .parse()
        .map_err(|e: dr_model::id::IdError| ExportError::Invalid(e.to_string()))?;
    // The copy below is read between two equal versions; the new entry is
    // then held to the level and the template it was resolved from.
    let doc = format!("book:{book}");
    let before = ws.version(&doc)?;
    let copy = ws
        .library()
        .load_copy(&format!("book:{book}"))
        .map_err(dr_workspace::WsError::from)?;
    if !dr_doc::v3::is_v3_doc(&copy) {
        return Err(ExportError::Invalid("canonical v3 book required".into()));
    }
    let borrowed = dr_doc::v3::BorrowedBookV3::new(&copy, &book_id)
        .map_err(|e| ExportError::Invalid(e.to_string()))?;
    let view = borrowed.view();
    let entries = view.entries_map();
    let templates = view.templates_map();
    let root = |template: &str| -> Result<String> {
        let rows: Vec<_> = entries
            .values()
            .filter(|e| {
                !e.is_trashed() && e.template.as_ref().is_some_and(|t| t.as_str() == template)
            })
            .collect();
        match rows.as_slice() {
            [e] => Ok(e.id.to_string()),
            _ => Err(ExportError::Invalid(
                "choose an unambiguous v3 import level".into(),
            )),
        }
    };
    let parent = match target {
        ImportTarget::Chapter {
            storyline: Some(id),
        } => id.clone(),
        ImportTarget::Chapter { storyline: None } => root(novel::TPL_MANUSCRIPT)?,
        ImportTarget::Idea => root(novel::TPL_IDEAS)?,
        ImportTarget::Element { category: Some(id) } => id.clone(),
        ImportTarget::Element { category: None } => root(novel::TPL_ELEMENTS)?,
    };
    let level_id = parent
        .parse()
        .map_err(|e: dr_model::id::IdError| ExportError::Invalid(e.to_string()))?;
    let settings = dr_model::v3::resolve_level_settings(Some(&level_id), &entries, &templates);
    let template_id = settings.default_template.ok_or_else(|| {
        ExportError::Invalid("import level needs an explicit default template".into())
    })?;
    let template = templates
        .get(&template_id)
        .ok_or_else(|| ExportError::Invalid("import template missing".into()))?;
    let modules: Vec<_> = template.prose_modules().collect();
    let [module] = modules.as_slice() else {
        return Err(ExportError::Invalid(
            "import template must identify exactly one prose module".into(),
        ));
    };
    let module = module.id.to_string();
    let resolved = ws.observe_records(
        &doc,
        &[
            dr_workspace::RecordKey::entry(&parent),
            dr_workspace::RecordKey::template(template_id.as_str()),
        ],
    )?;
    if ws.version(&doc)? != before {
        return Err(ExportError::Invalid(
            "import target changed; select it again".into(),
        ));
    }
    let created = ws.call_guarded(
        actor,
        "entry.create",
        serde_json::json!({
            "book": book, "parent": parent, "template": template_id,
            "title": title, "bodies": {module.clone(): text.unwrap_or_default()}
        }),
        dr_workspace::WritePreconditions {
            require_all: false,
            ..dr_workspace::WritePreconditions::from_records(resolved)
        },
    )?;
    let entity = &created["output"];
    let id = entity["id"]
        .as_str()
        .ok_or_else(|| ExportError::Invalid("entry.create returned no id".into()))?
        .to_owned();
    let created = ImportedEntity {
        doc: format!("body:{id}/{module}"),
        name: entity["title"].as_str().unwrap_or(title).into(),
        id,
    };
    let plain = ls.iter().all(|l| l.attrs.is_plain() && l.styles.is_empty());
    if !plain {
        format(ws, &created.doc, ls)?;
    }
    Ok(created)
}

/// Headings, quotes, rules, alignment and inline styles, in one commit.
fn format(ws: &Workspace, doc: &str, ls: Vec<Line>) -> Result<()> {
    let session = ws.prose_session(doc)?;
    session.edit(move |txn| {
        let paragraphs: Vec<Range<usize>> = txn.view().paragraphs().map(|p| p.range).collect();
        for (l, range) in ls.iter().zip(&paragraphs) {
            if !l.attrs.is_plain() {
                txn.set_block_attrs(range.start, &l.attrs)?;
            }
            for (r, style) in &l.styles {
                let at = range.start + r.start..range.start + r.end;
                if at.end <= range.end {
                    txn.set_style(at, style)?;
                }
            }
        }
        Ok(())
    })?;
    Ok(())
}
