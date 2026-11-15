//! Manuscript conversion: the single book sequence
//! (`BookStructureV3::book_sequence`), each entry with book prose once, its own
//! book prose in template order before what lives under it.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use dr_doc::{
    prose::{BorrowedProse, FileEmbedLook},
    v3::BorrowedBookV3,
};
use dr_model::{
    DocId,
    id::{AssetId, BookId, CommentId},
    kind::AssetKind,
    shared::Asset,
};
use dr_store::{OpenDoc, asset::Variant};
use dr_workspace::Workspace;

use crate::manuscript::{Align, Block, Cover, Run};
use crate::{ExportError, Labels, Manuscript, Options, Result, Section};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub mark: Option<String>,
    /// Current book-prose modules only (`in_book = true`). Retained content stays in the book file.
    pub prose: Vec<DocId>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outline {
    pub book: String,
    pub title: String,
    pub has_book: bool,
    pub entries: Vec<Entry>,
}

impl Outline {
    /// Share the picker layout without assigning built-in acts to v3 levels.
    pub fn picker(&self) -> crate::Outline {
        crate::Outline {
            book: self.book.clone(),
            title: self.title.clone(),
            has_book: self.has_book,
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

/// Version dispatch for hosts which also check book format.
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
            // The book sequence (`BookStructureV3::book_sequence`): every entry
            // with book prose in sequence order; entries without book prose do
            // not appear, and when `project.book` is disabled the sequence is empty.
            let structure = view.structure_snapshot();
            let has_book = structure.project().book.is_some();
            let templates = structure.templates_map();
            let entries: Vec<Entry> = structure
                .book_sequence()
                .into_iter()
                .filter(|e| !e.prose.is_empty())
                .map(|e| Entry {
                    id: e.entry.id.to_string(),
                    title: e.entry.title.clone(),
                    mark: e.entry.mark.clone().or_else(|| {
                        e.entry
                            .effective_template(templates)
                            .and_then(|t| t.mark.clone())
                    }),
                    prose: e.prose.iter().map(|p| p.doc.clone()).collect(),
                })
                .collect();
            Ok(Outline {
                book: id.to_string(),
                title: meta.name,
                has_book,
                entries,
            })
        })
        .map_err(invalid)?
}

/// Reads the manuscript from `BookStructureV3::book_sequence()`. `chapters`
/// selects entry ids; `act_titles` has no v3 meaning and adds no invented
/// hierarchy. Module content is concatenated without inserting module headings
/// or copy. Live image embeds export image + caption (without app-side size or
/// alignment), live PDF embeds export a single filename line, and trashed
/// assets stay out.
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
    if !outline.has_book {
        return Err(ExportError::NoChapters);
    }
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
    let book_id = BookId::parse(book).map_err(invalid)?;
    let (done_todos, live_assets): (Arc<HashSet<CommentId>>, Arc<HashMap<AssetId, Asset>>) = ws
        .library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)
        .map_err(invalid)?
        .read(move |doc| {
            let borrowed = BorrowedBookV3::new(doc, &book_id).map_err(invalid)?;
            let view = borrowed.view();
            let done = view
                .comments()
                .into_iter()
                .filter(|c| c.is_done())
                .map(|c| c.id)
                .collect();
            let assets = view
                .assets()
                .into_iter()
                .map(|a| (a.id.clone(), a))
                .collect();
            Ok::<_, ExportError>((Arc::new(done), Arc::new(assets)))
        })
        .map_err(invalid)??;

    let image_cache: Arc<Mutex<HashMap<AssetId, Option<Cover>>>> =
        Arc::new(Mutex::new(HashMap::new()));
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
            let done_todos = Arc::clone(&done_todos);
            let live_assets = Arc::clone(&live_assets);
            let image_cache = Arc::clone(&image_cache);
            let lib = ws.library().clone();
            let book_key = book.to_owned();
            let part = ws
                .library()
                .open_doc(&id, OpenDoc::Existing)
                .map_err(invalid)?
                .read(move |loro| {
                    let prose = BorrowedProse::new(loro, &doc).map_err(invalid)?;
                    let resolve_asset = |asset_id: &AssetId,
                                         look: &FileEmbedLook|
                     -> Option<Block> {
                        let asset = live_assets.get(asset_id)?;
                        match asset.kind {
                            AssetKind::Pdf => {
                                let name = crate::convert::one_line(&asset.name);
                                let line = if name.is_empty() {
                                    asset_id.to_string()
                                } else {
                                    name
                                };
                                Some(Block::Paragraph {
                                    runs: vec![Run {
                                        text: line,
                                        ..Run::default()
                                    }],
                                    align: Align::Left,
                                    indent: 0,
                                })
                            }
                            AssetKind::Image => {
                                let cached = image_cache
                                    .lock()
                                    .ok()
                                    .and_then(|guard| guard.get(asset_id).cloned());
                                let cover = match cached {
                                    Some(found) => found,
                                    None => {
                                        let loaded = lib
                                            .asset(asset_id.as_str(), Variant::Source)
                                            .ok()
                                            .flatten()
                                            .filter(|rec| rec.book_id == book_key)
                                            .and_then(|rec| {
                                                crate::cover::inline_image_from_path(&rec.path).ok()
                                            });
                                        if let Ok(mut guard) = image_cache.lock() {
                                            guard.insert(asset_id.clone(), loaded.clone());
                                        }
                                        loaded
                                    }
                                }?;
                                Some(Block::Image {
                                    media_type: cover.media_type,
                                    data: cover.data,
                                    width: cover.width,
                                    height: cover.height,
                                    caption: crate::convert::one_line(&look.caption),
                                })
                            }
                            _ => None,
                        }
                    };
                    Ok::<_, ExportError>(crate::convert::blocks_with_context(
                        &prose.view(),
                        Some(&done_todos),
                        Some(&resolve_asset),
                    ))
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
