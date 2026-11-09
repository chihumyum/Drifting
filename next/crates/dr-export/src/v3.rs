//! V3 manuscript conversion. Only live leaves resident under manuscript
//! levels contribute, once each; prose modules follow their template order.

use std::collections::{BTreeMap, HashSet};
use std::time::SystemTime;

use dr_doc::{prose::BorrowedProse, v3::BorrowedBookV3};
use dr_model::{
    DocId,
    id::{BodyDocId, BookId},
    v3 as model,
};
use dr_store::OpenDoc;
use dr_workspace::Workspace;

use crate::{ExportError, Labels, Manuscript, Options, Result, Section};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub mark: Option<String>,
    /// Current prose modules only. Retained content remains in the book file.
    pub prose: Vec<DocId>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outline {
    pub book: String,
    pub title: String,
    pub entries: Vec<Entry>,
}

impl Outline {
    /// Share the existing picker layout without assigning acts to v3 levels.
    pub fn picker(&self) -> crate::Outline {
        crate::Outline {
            book: self.book.clone(),
            title: self.title.clone(),
            acts: Vec::new(),
            chapters: self
                .entries
                .iter()
                .map(|entry| crate::ChapterEntry {
                    id: entry.id.clone(),
                    title: entry.title.clone(),
                    status: String::new(),
                    act: None,
                })
                .collect(),
        }
    }
}

fn invalid(e: impl ToString) -> ExportError {
    ExportError::Invalid(e.to_string())
}

/// Version dispatch for hosts which also serve v2.2 books.
pub fn is_book(ws: &Workspace, book: &str) -> Result<bool> {
    ws.library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)
        .map_err(invalid)?
        .read(dr_doc::v3::is_v3_doc)
        .map_err(invalid)
}

pub fn outline(ws: &Workspace, book: &str) -> Result<Outline> {
    let id = BookId::parse(book).map_err(invalid)?;
    ws.library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)
        .map_err(invalid)?
        .read(move |doc| {
            if !dr_doc::v3::is_v3_doc(doc) {
                return Err(invalid("v3 manuscript requires a v3 book"));
            }
            let borrowed = BorrowedBookV3::new(doc, &id).map_err(invalid)?;
            let view = borrowed.view();
            let meta = view.meta();
            if meta.deleted_at.is_some() {
                return Err(ExportError::NotFound(format!("book {id}")));
            }
            let templates = view.templates_map();
            let entries = view.entries_raw();
            let map: BTreeMap<_, _> = entries.iter().map(|e| (e.id.clone(), e.clone())).collect();
            let levels = model::effective_manuscript_levels(&map, &templates);
            let entries = entries
                .iter()
                .filter(|entry| {
                    if entry.is_trashed() || !entry.is_leaf(&templates) {
                        return false;
                    }
                    let ancestors = model::effective_ancestors(&map, &templates, &entry.id);
                    ancestors.iter().any(|id| levels.contains(id))
                        && ancestors
                            .iter()
                            .all(|id| map.get(id).is_some_and(|e| !e.is_trashed()))
                })
                .map(|entry| Entry {
                    id: entry.id.to_string(),
                    title: entry.title.clone(),
                    mark: entry
                        .effective_template(&templates)
                        .and_then(|t| t.mark.clone()),
                    prose: entry
                        .effective_template(&templates)
                        .into_iter()
                        .flat_map(|t| t.prose_modules())
                        .map(|m| DocId::Body(BodyDocId::new(entry.id.clone(), m.id.clone())))
                        .collect(),
                })
                .collect();
            Ok(Outline {
                book: id.to_string(),
                title: meta.name,
                entries,
            })
        })
        .map_err(invalid)?
}

/// Uses the existing manuscript options and writers. `chapters` selects leaf
/// entry ids; `act_titles` has no v3 meaning and adds no invented hierarchy.
/// Module content is concatenated without inserting module headings or copy.
#[allow(clippy::too_many_arguments)]
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
    let entries: Vec<_> = outline
        .entries
        .iter()
        .filter(|e| {
            options
                .chapters
                .as_ref()
                .is_none_or(|ids| ids.contains(&e.id))
        })
        .collect();
    if entries.is_empty() {
        return Err(ExportError::NoChapters);
    }
    let stored: HashSet<_> = ws
        .library()
        .docs(Some(book), None)
        .map_err(invalid)?
        .into_iter()
        .map(|d| d.doc_id)
        .collect();
    let mut sections = Vec::new();
    for entry in entries {
        let mut blocks = Vec::new();
        for doc in &entry.prose {
            let id = doc.to_string();
            if !stored.contains(&id) {
                continue;
            }
            let doc = doc.clone();
            let part = ws
                .library()
                .open_doc(&id, OpenDoc::Existing)
                .map_err(invalid)?
                .read(move |loro| {
                    let prose = BorrowedProse::new(loro, &doc).map_err(invalid)?;
                    Ok::<_, ExportError>(crate::blocks(&prose.view()))
                })
                .map_err(invalid)??;
            blocks.extend(part);
        }
        let title = crate::convert::one_line(&entry.title);
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
    let title = options.title.trim();
    Ok(Manuscript {
        title: if title.is_empty() {
            outline.title.trim().to_owned()
        } else {
            title.to_owned()
        },
        author: options.author.trim().to_owned(),
        identifier: book.to_owned(),
        modified: crate::timestamp(now),
        locale: locale.to_owned(),
        preferred_font: preferred_font.filter(|f| !f.trim().is_empty()),
        cover: options.cover.clone(),
        sections,
    })
}
