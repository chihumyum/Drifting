//! Manuscript conversion: the manuscript sequence
//! (`BookStructureV3::manuscript`), each entry with book prose once, its own
//! book prose in template order before what lives under it.

use std::collections::HashSet;
use std::time::SystemTime;

use dr_doc::{prose::BorrowedProse, v3::BorrowedBookV3};
use dr_model::{DocId, id::BookId};
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

/// One outermost manuscript level (`ManuscriptPart`) and the entries with book
/// prose inside it, in manuscript order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Part {
    pub id: String,
    pub title: String,
    /// Ancestor titles from the top of the tree down to this manuscript root.
    pub path: Vec<String>,
    pub mark: Option<String>,
    pub color: Option<String>,
    pub entries: Vec<Entry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outline {
    pub book: String,
    pub title: String,
    pub parts: Vec<Part>,
    pub entries: Vec<Entry>,
}

impl Outline {
    /// Share the existing picker layout without assigning acts to v3 levels.
    pub fn picker(&self) -> crate::Outline {
        self.picker_for(None)
    }

    /// Picker layout scoped to `manuscript` (`Part::id`), or across every
    /// manuscript part when `None`.
    pub fn picker_for(&self, manuscript: Option<&str>) -> crate::Outline {
        let entries: &[Entry] = match manuscript {
            Some(id) => self
                .parts
                .iter()
                .find(|p| p.id == id)
                .map_or(&[], |p| p.entries.as_slice()),
            None => &self.entries,
        };
        crate::Outline {
            book: self.book.clone(),
            title: self.title.clone(),
            acts: Vec::new(),
            chapters: entries
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

fn path_of(structure: &dr_doc::v3::BookStructureV3, id: &dr_model::id::EntryId) -> Vec<String> {
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut cur = Some(id);
    while let Some(entry_id) = cur {
        if !seen.insert(entry_id.clone()) {
            break;
        }
        let Some(entry) = structure.entry(entry_id) else {
            break;
        };
        chain.push(entry.title.clone());
        cur = structure.effective_parent(entry_id);
    }
    chain.reverse();
    chain
}

fn color_of(
    entry: &dr_model::v3::Entry,
    template: Option<&dr_model::v3::EntryTemplate>,
) -> Option<String> {
    let template = template?;
    template
        .modules
        .iter()
        .find_map(|m| {
            let field = m.config.color_field.as_ref()?;
            match entry.fields.get(&m.id)?.get(field)? {
                dr_model::v3::FieldValue::Text(s) if !s.is_empty() => Some(s.clone()),
                _ => None,
            }
        })
        .or_else(|| template.color.clone())
}

fn invalid(e: impl ToString) -> ExportError {
    ExportError::Invalid(e.to_string())
}

/// Version dispatch for hosts which also serve v2.2 books.
pub fn is_book(ws: &Workspace, book: &str) -> Result<bool> {
    ws.library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)
        .map_err(invalid)?
        .read(dr_doc::v3::is_book_doc)
        .map_err(invalid)
}

pub fn outline(ws: &Workspace, book: &str) -> Result<Outline> {
    let id = BookId::parse(book).map_err(invalid)?;
    ws.library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)
        .map_err(invalid)?
        .read(move |doc| {
            if !dr_doc::v3::is_book_doc(doc) {
                return Err(invalid(
                    "the manuscript requires a book of the current format",
                ));
            }
            let borrowed = BorrowedBookV3::new(doc, &id).map_err(invalid)?;
            let view = borrowed.view();
            let meta = view.meta();
            if meta.deleted_at.is_some() {
                return Err(ExportError::NotFound(format!("book {id}")));
            }
            // The manuscript sequence: every entry with book prose, its own
            // prose before what lives under it; entries without book prose
            // (an organizing level, say) do not appear.
            let structure = view.structure_snapshot();
            let templates = structure.templates_map();
            let parts: Vec<Part> = structure
                .manuscript()
                .into_iter()
                .map(|p| {
                    let root_tpl = p.root.effective_template(templates);
                    let entries = p
                        .entries
                        .into_iter()
                        .filter(|e| !e.prose.is_empty())
                        .map(|e| Entry {
                            id: e.entry.id.to_string(),
                            title: e.entry.title.clone(),
                            mark: e
                                .entry
                                .effective_template(templates)
                                .and_then(|t| t.mark.clone()),
                            prose: e.prose.iter().map(|p| p.doc.clone()).collect(),
                        })
                        .collect();
                    Part {
                        id: p.root.id.to_string(),
                        title: p.root.title.clone(),
                        path: path_of(&structure, &p.root.id),
                        mark: root_tpl.and_then(|t| t.mark.clone()),
                        color: color_of(p.root, root_tpl),
                        entries,
                    }
                })
                .collect();
            let entries = parts.iter().flat_map(|p| p.entries.clone()).collect();
            Ok(Outline {
                book: id.to_string(),
                title: meta.name,
                parts,
                entries,
            })
        })
        .map_err(invalid)?
}

/// Uses the existing manuscript options and writers. `manuscript` selects one
/// outermost manuscript part when a book has multiple; `chapters` selects
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
    let source_entries: &[Entry] = match options.manuscript.as_deref() {
        Some(part_id) => {
            let part = outline
                .parts
                .iter()
                .find(|p| p.id == part_id)
                .ok_or_else(|| ExportError::NotFound(format!("manuscript {part_id}")))?;
            &part.entries
        }
        None => &outline.entries,
    };
    let entries: Vec<_> = source_entries
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
