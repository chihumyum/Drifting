//! V3 counts: the manuscript sequence, one entry/module, or one material.
//! The legacy NavTarget::Book sentinel cannot select a v3 entry.

use std::collections::{BTreeMap, BTreeSet};

use dr_doc::v3::BorrowedBookV3;
use dr_model::{Day, DocId, id::BookId, v3 as m};
use dr_store::OpenDoc;
use dr_text::{ProseShape, TextMetrics};
use dr_workspace::commands::stats::{WritingDays, WritingDaysIn, WritingDaysOut};
use dr_workspace::{Actor, Result, Workspace, WsError};

use crate::model::Live;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    Book,
    Entry { id: String, module: Option<String> },
    Material(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Document {
    pub id: String,
    pub entry: Option<String>,
    pub entry_title: Option<String>,
    pub module: Option<String>,
    pub name: String,
    pub retained: bool,
    /// None while the index is pending; an uncreated empty body is zero.
    pub metrics: Option<TextMetrics>,
}

#[derive(Clone, Debug)]
pub struct Loaded {
    pub scope: Scope,
    pub title: String,
    pub summary: String,
    pub documents: Vec<Document>,
    pub manuscript: Vec<Document>,
    /// Entries the manuscript sequence numbers (those with book prose).
    pub entries: usize,
    pub word_target: Option<i64>,
    pub daily_word_target: Option<i64>,
    /// Read from the selected prose, independent of index lag.
    pub shape: Option<ProseShape>,
    pub days: WritingDaysOut,
}

impl Loaded {
    pub fn words(&self, live: &Live) -> Option<TextMetrics> {
        total(&self.documents, live)
    }
    pub fn book_words(&self, live: &Live) -> Option<TextMetrics> {
        total(&self.manuscript, live)
    }
}

/// Each live editor replaces exactly its own document's indexed count.
/// One ready document must not turn another pending document into zero.
pub fn total(docs: &[Document], live: &Live) -> Option<TextMetrics> {
    let mut sum = TextMetrics::default();
    for doc in docs {
        sum += live.docs.get(&doc.id).copied().or(doc.metrics)?;
    }
    Some(sum)
}

fn invalid(e: impl ToString) -> WsError {
    WsError::Invalid(e.to_string())
}

/// Background read. All manuscript membership is derived from the tree and
/// effective settings; a membership/timeline lane does not add words twice.
pub fn load(ws: &Workspace, book: &str, scope: Scope) -> Result<Loaded> {
    load_at(ws, book, scope, &crate::clock::today())
}

/// The same read with an explicit local day, for Home and deterministic checks.
pub fn load_at(ws: &Workspace, book: &str, scope: Scope, today: &Day) -> Result<Loaded> {
    let id = BookId::parse(book).map_err(invalid)?;
    let handle = ws
        .library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)?;
    let (meta, entries, templates, materials, sequence) = handle.read(move |doc| {
        if !dr_doc::v3::is_book_doc(doc) {
            return Err(invalid("statistics require a book of the current format"));
        }
        let b = BorrowedBookV3::new(doc, &id)?;
        let v = b.view();
        if v.meta().deleted_at.is_some() {
            return Err(invalid("book is in the trash"));
        }
        // The manuscript sequence: each entry's own book prose, in order.
        let structure = v.structure_snapshot();
        let sequence: Vec<(m::EntryId, Vec<(String, String)>)> = structure
            .manuscript()
            .into_iter()
            .flat_map(|p| p.entries)
            .filter(|e| !e.prose.is_empty())
            .map(|e| {
                let prose = e
                    .prose
                    .iter()
                    .map(|p| (p.module.to_string(), p.name.clone()))
                    .collect();
                (e.entry.id.clone(), prose)
            })
            .collect();
        Ok((
            v.meta(),
            v.entries(),
            v.templates_map(),
            v.materials(),
            sequence,
        ))
    })??;
    let map: BTreeMap<_, _> = entries.iter().map(|e| (e.id.clone(), e.clone())).collect();
    let live = |e: &m::Entry| {
        !e.is_trashed()
            && m::effective_ancestors(&map, &e.id)
                .iter()
                .all(|a| map.get(a).is_some_and(|e| !e.is_trashed()))
    };
    let stored: BTreeSet<_> = ws
        .library()
        .docs(Some(book), None)?
        .into_iter()
        .map(|d| d.doc_id)
        .collect();
    let document =
        |entry: &m::Entry, module: &str, name: &str, retained: bool| -> Result<Document> {
            let id = format!("body:{}/{module}", entry.id);
            let metrics = if stored.contains(&id) {
                ws.library().doc_stats(&id)?.map(|s| TextMetrics {
                    words: s.words,
                    chars: s.chars,
                })
            } else {
                Some(TextMetrics::default())
            };
            Ok(Document {
                id,
                entry: Some(entry.id.to_string()),
                entry_title: Some(entry.title.clone()),
                module: Some(module.into()),
                name: name.into(),
                retained,
                metrics,
            })
        };
    let docs_for = |entry: &m::Entry, retained: bool| -> Result<Vec<Document>> {
        let mut docs = Vec::new();
        if let Some(template) = entry.effective_template(&templates) {
            for module in template.prose_modules() {
                docs.push(document(entry, module.id.as_str(), &module.name, false)?);
            }
        }
        if retained {
            for id in &stored {
                if let Ok(DocId::Body(body)) = DocId::parse(id)
                    && body.entry() == &entry.id
                    && !docs.iter().any(|d| &d.id == id)
                {
                    docs.push(document(
                        entry,
                        body.module().as_str(),
                        body.module().as_str(),
                        true,
                    )?);
                }
            }
        }
        Ok(docs)
    };
    let mut manuscript = Vec::new();
    for (id, prose) in &sequence {
        let entry = &map[id];
        for (module, name) in prose {
            manuscript.push(document(entry, module, name, false)?);
        }
    }
    let (title, documents) = match &scope {
        Scope::Book => (meta.name.clone(), manuscript.clone()),
        Scope::Entry { id, module } => {
            let entry = entries
                .iter()
                .find(|e| e.id.as_str() == id && live(e))
                .ok_or_else(|| WsError::NotFound {
                    what: "entry",
                    id: id.clone(),
                })?;
            let mut docs = docs_for(entry, true)?;
            if let Some(module) = module {
                docs.retain(|d| d.module.as_ref() == Some(module));
                // A non-prose module has no words; it never falls back to book.
            }
            (entry.title.clone(), docs)
        }
        Scope::Material(id) => {
            let mat = materials
                .iter()
                .find(|m| m.id.as_str() == id)
                .ok_or_else(|| WsError::NotFound {
                    what: "material",
                    id: id.clone(),
                })?;
            let id = format!("material:{id}");
            let docs = if mat.kind == dr_model::kind::MaterialKind::Text {
                vec![Document {
                    metrics: if stored.contains(&id) {
                        ws.library().doc_stats(&id)?.map(|s| TextMetrics {
                            words: s.words,
                            chars: s.chars,
                        })
                    } else {
                        Some(TextMetrics::default())
                    },
                    id,
                    entry: None,
                    entry_title: None,
                    module: None,
                    name: mat.title.clone(),
                    retained: false,
                }]
            } else {
                Vec::new()
            };
            (mat.title.clone(), docs)
        }
    };
    let shape = if documents.len() == 1
        && !matches!(scope, Scope::Book)
        && stored.contains(&documents[0].id)
    {
        let session = ws.prose_session(&documents[0].id)?;
        let reader = session.reader();
        let view = reader.view();
        let text: Vec<_> = view
            .paragraphs()
            .map(|p| dr_text::block_text(&view, &p))
            .collect();
        Some(dr_text::prose_shape(text.iter().map(String::as_str)))
    } else {
        None
    };
    Ok(Loaded {
        scope,
        title,
        summary: meta.summary.clone(),
        documents,
        manuscript,
        entries: sequence.len(),
        word_target: meta.word_target(),
        daily_word_target: meta.daily_word_target(),
        shape,
        days: ws
            .run::<WritingDays>(
                &Actor::User,
                WritingDaysIn {
                    book: book.into(),
                    today: today.to_string(),
                    days: Some(7),
                    device: ws.writing_device(),
                },
            )?
            .output,
    })
}
