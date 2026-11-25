//! V3 counts: the manuscript sequence, one entry/module, or one material.
//! The legacy NavTarget::Book sentinel cannot select a v3 entry.

use std::collections::{BTreeMap, BTreeSet};

use dr_doc::v3::BorrowedBookV3;
use dr_model::{Day, DocId, id::BookId, kind::EntityKind, v3 as m};
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

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CompletionStats {
    pub finished: usize,
    pub draft: usize,
    pub discarded: usize,
    pub other: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChapterBar {
    pub entry_id: String,
    pub title: String,
    pub words: u64,
    pub status: Option<String>,
    pub group_id: Option<String>,
    pub group_title: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupRhythm {
    pub id: String,
    pub title: String,
    pub count: usize,
    pub words: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefEntry {
    pub entry_id: String,
    pub title: String,
    pub count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryCoords {
    pub template_name: Option<String>,
    pub parent_title: Option<String>,
    pub status: Option<String>,
    pub book_position: Option<usize>,
    pub updated_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubtreeStats {
    pub child_count: usize,
    pub total_words: u64,
    pub appeared_count: usize,
    pub unappeared: Vec<(String, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MaterialStats {
    pub kind: String,
    pub mime: String,
    pub size_bytes: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub created_at: Option<i64>,
    pub open_comments: usize,
    pub usages: Vec<(String, String)>,
}

#[derive(Clone, Debug)]
pub struct Loaded {
    pub scope: Scope,
    pub has_book: bool,
    pub title: String,
    pub summary: String,
    pub documents: Vec<Document>,
    pub manuscript: Vec<Document>,
    /// Entries the manuscript sequence numbers (those with book prose).
    pub entries: usize,
    /// Total live entries in the project (populated even when `has_book == false`).
    pub total_entries: usize,
    /// Total live templates in the project.
    pub template_count: usize,
    pub word_target: Option<i64>,
    pub daily_word_target: Option<i64>,
    /// Read from the selected prose, independent of index lag.
    pub shape: Option<ProseShape>,
    pub days: WritingDaysOut,
    pub completion: CompletionStats,
    pub chapters: Vec<ChapterBar>,
    pub group_rhythm: Vec<GroupRhythm>,
    pub outbound_links: Vec<RefEntry>,
    pub inbound_links: Vec<RefEntry>,
    pub coordinates: Option<EntryCoords>,
    pub subtree: Option<SubtreeStats>,
    pub material: Option<MaterialStats>,
    /// Primary prose document id and title for the bottom `历史快照…` button.
    pub history_doc: Option<(String, String)>,
}

impl Loaded {
    pub fn words(&self, live: &Live) -> Option<TextMetrics> {
        if !self.has_book {
            return None;
        }
        total(&self.documents, live)
    }
    pub fn book_words(&self, live: &Live) -> Option<TextMetrics> {
        if !self.has_book {
            return None;
        }
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

fn entry_status(
    entry: &m::Entry,
    templates: &BTreeMap<m::EntryTemplateId, m::EntryTemplate>,
) -> Option<String> {
    let tpl = entry.effective_template(templates)?;
    for module in &tpl.modules {
        if module.kind == m::ModuleKind::Fields
            && let Some(field_id) = module.config.status_field.as_deref()
            && let Some(m::FieldValue::Text(s)) =
                entry.fields.get(&module.id).and_then(|f| f.get(field_id))
            && !s.trim().is_empty()
        {
            return Some(s.trim().to_owned());
        }
    }
    None
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
    let (meta, project, entries, assets, templates, comments, memberships, sequence) = handle
        .read(move |doc| {
            if !dr_doc::v3::is_book_doc(doc) {
                return Err(invalid("statistics require a book of the current format"));
            }
            let b = BorrowedBookV3::new(doc, &id)?;
            let v = b.view();
            if v.meta().deleted_at.is_some() {
                return Err(invalid("book is in the trash"));
            }
            // The book sequence (`project.book`): each entry's book prose, in order.
            let structure = v.structure_snapshot();
            let sequence: Vec<(m::EntryId, Vec<(String, String)>)> = structure
                .book_sequence()
                .into_iter()
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
                v.project(),
                v.entries(),
                v.assets(),
                v.templates_map(),
                v.comments(),
                v.memberships(),
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
    let live_entries: BTreeMap<String, &m::Entry> = entries
        .iter()
        .filter(|e| live(e))
        .map(|e| (e.id.to_string(), e))
        .collect();
    let total_entries = live_entries.len();
    let template_count = templates
        .values()
        .filter(|t| t.deleted_at.is_none())
        .count();
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
    let mut completion = CompletionStats::default();
    let mut chapters = Vec::new();
    let mut group_order: Vec<String> = Vec::new();
    let mut group_acc: BTreeMap<String, (String, usize, u64)> = BTreeMap::new();
    let mut book_pos: BTreeMap<String, usize> = BTreeMap::new();
    for (idx, (id, prose)) in sequence.iter().enumerate() {
        let entry = &map[id];
        book_pos.insert(id.to_string(), idx + 1);
        let mut entry_words = 0u64;
        for (module, name) in prose {
            let doc = document(entry, module, name, false)?;
            entry_words += doc.metrics.map_or(0, |m| m.words);
            manuscript.push(doc);
        }
        let status = entry_status(entry, &templates);
        match status.as_deref() {
            Some("finished") => completion.finished += 1,
            Some("draft") => completion.draft += 1,
            Some("discarded") => completion.discarded += 1,
            _ => completion.other += 1,
        }
        let (group_id, group_title) = entry
            .parent
            .as_ref()
            .and_then(|pid| map.get(pid))
            .map(|p| (Some(p.id.to_string()), Some(p.title.clone())))
            .unwrap_or((None, None));
        if let (Some(gid), Some(gtitle)) = (&group_id, &group_title) {
            if !group_acc.contains_key(gid) {
                group_order.push(gid.clone());
            }
            let slot = group_acc
                .entry(gid.clone())
                .or_insert_with(|| (gtitle.clone(), 0, 0));
            slot.1 += 1;
            slot.2 += entry_words;
        }
        chapters.push(ChapterBar {
            entry_id: id.to_string(),
            title: entry.title.clone(),
            words: entry_words,
            status,
            group_id,
            group_title,
        });
    }
    let group_rhythm: Vec<GroupRhythm> = if group_order.len() > 1 {
        group_order
            .into_iter()
            .filter_map(|gid| {
                let (title, count, words) = group_acc.remove(&gid)?;
                Some(GroupRhythm {
                    id: gid,
                    title,
                    count,
                    words,
                })
            })
            .collect()
    } else {
        Vec::new()
    };

    // Query link/reference index across the book (respecting auto-links setting).
    let link_states = m::LinkEntries::of(entries.iter());
    let auto_links = ws.auto_links();
    let ref_rows = ws
        .library()
        .entry_module_references_in_book(book)
        .unwrap_or_default();
    let mut outbound_map: BTreeMap<String, BTreeMap<String, u32>> = BTreeMap::new();
    let mut inbound_map: BTreeMap<String, BTreeMap<String, u32>> = BTreeMap::new();
    let mut total_mentions: BTreeMap<String, u32> = BTreeMap::new();
    for r in &ref_rows {
        if r.count == 0 || r.target_kind != "entry" || r.source_entry == r.target_id {
            continue;
        }
        if !dr_workspace::autolink::reference_counts(
            r.kind,
            link_states.get(&r.target_id),
            auto_links,
        ) {
            continue;
        }
        if !live_entries.contains_key(&r.source_entry) || !live_entries.contains_key(&r.target_id) {
            continue;
        }
        *outbound_map
            .entry(r.source_entry.clone())
            .or_default()
            .entry(r.target_id.clone())
            .or_insert(0) += r.count;
        *inbound_map
            .entry(r.target_id.clone())
            .or_default()
            .entry(r.source_entry.clone())
            .or_insert(0) += r.count;
        *total_mentions.entry(r.target_id.clone()).or_insert(0) += r.count;
    }
    let to_ref_list = |counts: &BTreeMap<String, u32>| -> Vec<RefEntry> {
        let mut list: Vec<RefEntry> = counts
            .iter()
            .filter_map(|(eid, &count)| {
                let e = live_entries.get(eid)?;
                Some(RefEntry {
                    entry_id: eid.clone(),
                    title: e.title.clone(),
                    count,
                })
            })
            .collect();
        list.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.title.cmp(&b.title)));
        list
    };

    let mut coordinates = None;
    let mut subtree = None;
    let mut material_stats = None;
    let mut outbound_links = Vec::new();
    let mut inbound_links = Vec::new();
    let mut history_doc = None;

    let (title, documents) = match &scope {
        Scope::Book => {
            inbound_links = to_ref_list(&total_mentions).into_iter().take(12).collect();
            (meta.name.clone(), manuscript.clone())
        }
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
            history_doc = docs
                .iter()
                .find(|d| stored.contains(&d.id))
                .or_else(|| docs.first())
                .map(|d| (d.id.clone(), entry.title.clone()));
            coordinates = Some(EntryCoords {
                template_name: entry.effective_template(&templates).map(|t| t.name.clone()),
                parent_title: entry
                    .parent
                    .as_ref()
                    .and_then(|p| map.get(p))
                    .map(|p| p.title.clone()),
                status: entry_status(entry, &templates),
                book_position: book_pos.get(id).copied(),
                updated_at: entry.updated_at.or(entry.created_at).map(|t| t.0),
            });
            if let Some(out) = outbound_map.get(id) {
                outbound_links = to_ref_list(out);
            }
            if let Some(inc) = inbound_map.get(id) {
                inbound_links = to_ref_list(inc);
            }
            // Container / level aggregate over direct children and attached members.
            let mut related_ids: Vec<m::EntryId> = entries
                .iter()
                .filter(|e| live(e) && e.parent.as_ref() == Some(&entry.id))
                .map(|e| e.id.clone())
                .collect();
            for mem in &memberships {
                if mem.host == entry.id
                    && let Some(e) = map.get(&mem.member)
                    && live(e)
                    && !related_ids.contains(&e.id)
                {
                    related_ids.push(e.id.clone());
                }
            }
            if !related_ids.is_empty() {
                let mut total_words = 0u64;
                let mut appeared_count = 0usize;
                let mut unappeared = Vec::new();
                for cid in &related_ids {
                    let Some(child) = map.get(cid) else { continue };
                    for doc in docs_for(child, false)? {
                        total_words += doc.metrics.map_or(0, |m| m.words);
                    }
                    let mentions = total_mentions.get(cid.as_str()).copied().unwrap_or(0);
                    if mentions > 0 {
                        appeared_count += 1;
                    } else {
                        unappeared.push((cid.to_string(), child.title.clone()));
                    }
                }
                subtree = Some(SubtreeStats {
                    child_count: related_ids.len(),
                    total_words,
                    appeared_count,
                    unappeared,
                });
            }
            (entry.title.clone(), docs)
        }
        Scope::Material(id) => {
            let asset = assets.iter().find(|a| a.id.as_str() == id).or_else(|| {
                entries.iter().filter(|e| live(e)).find_map(|e| {
                    e.media
                        .values()
                        .flatten()
                        .find(|m| m.id.as_str() == id)
                        .and_then(|mi| assets.iter().find(|a| a.id == mi.asset))
                })
            });
            let Some(asset) = asset else {
                return Err(WsError::NotFound {
                    what: "material",
                    id: id.clone(),
                });
            };
            let asset_id_str = asset.id.to_string();
            let open_comments = comments
                .iter()
                .filter(|c| {
                    !c.is_done()
                        && c.target.as_ref().is_some_and(|t| {
                            matches!(t.kind, EntityKind::Asset | EntityKind::Material)
                                && (t.id == asset_id_str || t.id == *id)
                        })
                })
                .count();
            let mut usages: Vec<(String, String)> = Vec::new();
            let mut seen_entries = BTreeSet::new();
            for e in entries.iter().filter(|e| live(e)) {
                let in_media = e
                    .media
                    .values()
                    .flatten()
                    .any(|mi| mi.asset == asset.id || mi.id.as_str() == id);
                let in_fields = e.fields.values().any(|vals| {
                    vals.values()
                        .any(|fv| matches!(fv, m::FieldValue::Text(s) if s.trim() == asset_id_str))
                });
                if (in_media || in_fields) && seen_entries.insert(e.id.to_string()) {
                    usages.push((e.id.to_string(), e.title.clone()));
                }
            }
            // Also check prose asset embeds from reference index rows.
            for r in &ref_rows {
                if (r.target_kind == "asset" || r.target_kind == "material")
                    && (r.target_id == asset_id_str || r.target_id == *id)
                    && let Some(e) = live_entries.get(&r.source_entry)
                    && seen_entries.insert(r.source_entry.clone())
                {
                    usages.push((r.source_entry.clone(), e.title.clone()));
                }
            }
            material_stats = Some(MaterialStats {
                kind: asset.kind.as_str().to_owned(),
                mime: asset.mime.clone(),
                size_bytes: asset.size,
                width: asset.width,
                height: asset.height,
                created_at: asset.created_at.map(|t| t.0),
                open_comments,
                usages,
            });
            (asset.name.clone(), Vec::new())
        }
    };
    let has_book = project.book.is_some();
    // Aggregate prose shape across ALL stored prose documents of the entry (supports multi-prose).
    let shape = if has_book && !matches!(scope, Scope::Book) {
        let mut all_paragraphs = Vec::new();
        let mut read_any = false;
        for doc in &documents {
            if !stored.contains(&doc.id) {
                continue;
            }
            let session = ws.prose_session(&doc.id)?;
            let reader = session.reader();
            let view = reader.view();
            for p in view.paragraphs() {
                all_paragraphs.push(dr_text::block_text(&view, &p));
            }
            read_any = true;
        }
        read_any.then(|| dr_text::prose_shape(all_paragraphs.iter().map(String::as_str)))
    } else {
        None
    };
    let days = if has_book {
        ws.run::<WritingDays>(
            &Actor::User,
            WritingDaysIn {
                book: book.into(),
                today: today.to_string(),
                days: Some(7),
                device: ws.writing_device(),
            },
        )?
        .output
    } else {
        WritingDaysOut {
            days: Vec::new(),
            today: 0,
            mine_today: 0,
            week: 0,
            active_days: 0,
            streak: 0,
            streak_before: 0,
            daily_word_target: None,
        }
    };
    Ok(Loaded {
        scope,
        has_book,
        title,
        summary: meta.summary.clone(),
        documents,
        manuscript,
        entries: sequence.len(),
        total_entries,
        template_count,
        word_target: has_book.then(|| project.word_target()).flatten(),
        daily_word_target: has_book.then(|| project.daily_word_target()).flatten(),
        shape,
        days,
        completion,
        chapters,
        group_rhythm,
        outbound_links,
        inbound_links,
        coordinates,
        subtree,
        material: material_stats,
        history_doc,
    })
}
