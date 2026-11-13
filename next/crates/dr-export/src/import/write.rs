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

/// Which level entry each imported file is created under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportTarget {
    pub level: String,
}

impl ImportTarget {
    pub fn new(level: impl Into<String>) -> Self {
        Self {
            level: level.into(),
        }
    }
}

impl From<&str> for ImportTarget {
    fn from(level: &str) -> Self {
        Self::new(level)
    }
}

impl From<String> for ImportTarget {
    fn from(level: String) -> Self {
        Self::new(level)
    }
}

/// What one file became.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedEntity {
    pub id: String,
    /// The final name.
    pub name: String,
    /// Its prose document (`body:<entry>/<module>`).
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
    let book_id = book
        .parse()
        .map_err(|e: dr_model::id::IdError| ExportError::Invalid(e.to_string()))?;
    let level_id: dr_model::id::EntryId = target
        .level
        .trim()
        .parse()
        .map_err(|e: dr_model::id::IdError| ExportError::Invalid(e.to_string()))?;
    // The copy below is read between two equal versions; the new entry is
    // then held to the level, its ancestor chain, its residence and the
    // template it was resolved from.
    let doc = format!("book:{book}");
    let before = ws.version(&doc)?;
    let copy = ws
        .library()
        .load_copy(&doc)
        .map_err(dr_workspace::WsError::from)?;
    if !dr_doc::v3::is_book_doc(&copy) {
        return Err(ExportError::Invalid("current book format required".into()));
    }
    let borrowed = dr_doc::v3::BorrowedBookV3::new(&copy, &book_id)
        .map_err(|e| ExportError::Invalid(e.to_string()))?;
    let view = borrowed.view();
    let entries = view.entries_map();
    let templates = view.templates_map();
    dr_model::v3::check_parent_is_level(Some(&level_id), &entries)
        .map_err(|e| ExportError::Invalid(e.to_string()))?;
    let settings = dr_model::v3::resolve_level_settings(Some(&level_id), &entries, &templates);
    let template_id = settings
        .default_template
        .ok_or_else(|| ExportError::Invalid("import level needs a default template".into()))?;
    dr_model::v3::check_entry_template(&templates, Some(&template_id))
        .map_err(|e| ExportError::Invalid(e.to_string()))?;
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
    let mut guard_keys = Vec::new();
    let mut seen_keys = std::collections::HashSet::new();
    let mut push_key = |key: dr_workspace::RecordKey| {
        if seen_keys.insert(key.clone()) {
            guard_keys.push(key);
        }
    };
    let mut push_chain = |start: &dr_model::id::EntryId| {
        let mut seen = std::collections::BTreeSet::new();
        let mut cur = Some(start);
        while let Some(id) = cur {
            if !seen.insert(id.clone()) {
                break;
            }
            push_key(dr_workspace::RecordKey::entry(id.as_str()));
            let Some(e) = entries.get(id) else {
                break;
            };
            if let Some(tpl) = &e.template {
                push_key(dr_workspace::RecordKey::template(tpl.as_str()));
            }
            cur = e.parent.as_ref();
        }
    };
    push_chain(&level_id);
    if let Some(home) =
        dr_model::v3::resolve_new_entry_residence(Some(&level_id), &entries, &templates)
        && home != level_id
    {
        push_chain(&home);
    }
    push_key(dr_workspace::RecordKey::template(template_id.as_str()));
    let resolved = ws.observe_records(&doc, &guard_keys)?;
    if ws.version(&doc)? != before {
        return Err(ExportError::Invalid(
            "import target changed; select it again".into(),
        ));
    }
    let parent = level_id.to_string();
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
