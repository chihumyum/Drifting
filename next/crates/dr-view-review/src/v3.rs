//! Read-only review of v3 books. A source is an entry AND its prose module;
//! neither grouping nor navigation passes through the legacy NavTarget.

use std::collections::{HashMap, HashSet};

use dr_doc::v3::BorrowedBookV3;
use dr_editor::decor::Original;
use dr_model::{
    DocId,
    id::{BodyDocId, BookId, CommentId},
    kind::EntityKind,
    shared::Relation,
    v3::{self as m, CommentV3},
};
use dr_store::OpenDoc;
use dr_workspace::{Result, Workspace, WsError};

use crate::Filter;

/// The host maps this directly to the shell's versioned Target.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    Entry { id: String, module: Option<String> },
    Material(String),
}

impl Target {
    /// An entry without a module means all of that entry's comments.
    fn contains(&self, other: &Self) -> bool {
        match (self, other) {
            (
                Self::Entry { id, module },
                Self::Entry {
                    id: other,
                    module: other_module,
                },
            ) => id == other && (module.is_none() || module == other_module),
            _ => self == other,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Place {
    On(Target),
    Gone,
    Floating,
}

#[derive(Clone, Debug)]
pub struct Item {
    pub comment: CommentV3,
    /// Preserved even when the source is gone; never guessed from the template.
    pub target: Option<Target>,
    pub title: String,
    pub module_name: Option<String>,
    /// The module is no longer declared but its stored prose is retained.
    pub retained: bool,
    pub place: Place,
}

impl Item {
    /// Shared visual card data; source identity remains in `target`/`place`.
    pub fn card(&self) -> dr_workspace::dto::CommentInfo {
        let c = &self.comment;
        dr_workspace::dto::CommentInfo {
            id: c.id.to_string(),
            kind: c.kind.as_str().into(),
            target: c.target.as_ref().map(dr_workspace::dto::Target::from),
            unlocated: self.place == Place::Gone,
            target_block: c.target_block.as_ref().map(ToString::to_string),
            anchored: c.anchor.is_some(),
            quote: c.quote.clone(),
            body: c.body.clone(),
            status: c.status.as_str().into(),
            priority: c.priority.as_ref().map(|p| p.as_str().into()),
            author_kind: c.author_kind.as_str().into(),
            author_name: c.author_name.clone(),
            source: c.source.as_str().into(),
            agent_conversation: c.agent_conversation.clone(),
            projection: c.projection.as_ref().map(|p| p.kind.as_str().into()),
            region: c.region.as_ref().map(dr_workspace::dto::Region::from),
            created_at: c.created_at.map(|t| t.0),
            updated_at: c.updated_at.map(|t| t.0),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Group {
    pub place: Place,
    pub items: Vec<Item>,
}

#[derive(Clone, Debug, Default)]
pub struct Listing {
    pub open: Vec<Group>,
    pub resolved: Vec<Group>,
    pub resolved_count: usize,
}

#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub items: Vec<Item>,
    /// Read projections are never offered back as a replacement write.
    associations: Vec<Relation>,
    by_id: HashMap<String, usize>,
    by_target: HashMap<Target, usize>,
}

fn invalid(e: impl ToString) -> WsError {
    WsError::Invalid(e.to_string())
}

fn target(comment: &CommentV3) -> Option<Target> {
    let target = comment.target.as_ref()?;
    match target.kind {
        EntityKind::Entry => Some(Target::Entry {
            id: target.id.clone(),
            module: comment.target_module.as_ref().map(ToString::to_string),
        }),
        EntityKind::Material => Some(Target::Material(target.id.clone())),
        _ => None,
    }
}

/// Read comments and source names in one book snapshot, without opening or
/// creating any prose document. Ancestor trash hides navigation, not comments.
pub fn load(ws: &Workspace, book: &str) -> Result<Snapshot> {
    let id = BookId::parse(book).map_err(invalid)?;
    let (mut items, associations, pending_retained) = ws
        .library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)?
        .read(move |doc| {
            if !dr_doc::v3::is_v3_doc(doc) {
                return Err(invalid("v3 review requires a v3 book"));
            }
            let b = BorrowedBookV3::new(doc, &id).map_err(invalid)?;
            let v = b.view();
            if v.meta().deleted_at.is_some() {
                return Err(invalid("book is in the trash"));
            }
            let entries = v.entry_headers();
            let mut node_live = HashSet::with_capacity(entries.len());
            let mut node_all = HashSet::with_capacity(entries.len());
            for (eid, e) in &entries {
                node_all.insert(eid.to_string());
                if !e.is_trashed() {
                    node_live.insert(eid.to_string());
                }
            }
            let entry_sets = (node_live, node_all);
            let comments = v.comments_with_entries(&entry_sets);
            let generic = dr_doc::catalog::generic_relation_type_id(&id);
            if comments.is_empty() {
                let associations = v.relations_matching_with_entries(&entry_sets, |r| {
                    r.relation_type == generic
                        && r.from.kind == EntityKind::Comment
                        && r.to.kind == EntityKind::Entry
                });
                return Ok((Vec::new(), associations, Vec::new()));
            }
            let templates = v.templates_map();
            let live_ids: HashSet<String> = entries
                .values()
                .filter(|e| {
                    !e.is_trashed()
                        && m::effective_ancestors(&entries, &templates, &e.id)
                            .iter()
                            .all(|a| entries.get(a).is_some_and(|a| !a.is_trashed()))
                })
                .map(|e| e.id.to_string())
                .collect();
            let material_titles = v.material_titles();
            let mut pending_retained: Vec<(usize, String)> = Vec::new();
            let items: Vec<Item> = comments
                .into_iter()
                .enumerate()
                .map(|(idx, comment)| {
                    let target = target(&comment);
                    let mut title = String::new();
                    let mut module_name = None;
                    let found = match &target {
                        Some(Target::Entry { id, module }) => {
                            if live_ids.contains(id.as_str())
                                && let Some(entry) = entries.get(id.as_str())
                            {
                                title = entry.title.clone();
                                match module {
                                    None => true,
                                    Some(module) => {
                                        let definition =
                                            entry.effective_template(&templates).and_then(|t| {
                                                t.modules.iter().find(|m| m.id.as_str() == module)
                                            });
                                        module_name = definition.map(|m| m.name.clone());
                                        let prose = definition
                                            .is_some_and(|m| m.kind == m::ModuleKind::Prose)
                                            || (module == "about" && entry.is_level(&templates));
                                        if prose {
                                            true
                                        } else {
                                            pending_retained
                                                .push((idx, format!("body:{id}/{module}")));
                                            false
                                        }
                                    }
                                }
                            } else {
                                false
                            }
                        }
                        Some(Target::Material(id)) => {
                            if let Some(mat_title) = material_titles.get(id.as_str()) {
                                title = mat_title.clone();
                                true
                            } else {
                                false
                            }
                        }
                        None => false,
                    };
                    let place = match &target {
                        Some(target) if found => Place::On(target.clone()),
                        _ if comment.target.is_some() => Place::Gone,
                        _ => Place::Floating,
                    };
                    Item {
                        comment,
                        target,
                        title,
                        module_name,
                        retained: false,
                        place,
                    }
                })
                .collect();
            let associations = v
                .relations_matching_with_entries(&entry_sets, |r| {
                    r.relation_type == generic
                        && r.from.kind == EntityKind::Comment
                        && r.to.kind == EntityKind::Entry
                })
                .into_iter()
                .filter(|r| live_ids.contains(&r.to.id))
                .collect();
            Ok((items, associations, pending_retained))
        })??;
    if !pending_retained.is_empty() {
        let stored: HashSet<String> = ws
            .library()
            .docs(Some(book), None)?
            .into_iter()
            .map(|d| d.doc_id)
            .collect();
        for (idx, doc_id) in pending_retained {
            if stored.contains(&doc_id)
                && let Some(item) = items.get_mut(idx)
                && let Some(target) = item.target.clone()
            {
                item.retained = true;
                item.place = Place::On(target);
            }
        }
    }
    let mut by_id = HashMap::with_capacity(items.len());
    let mut by_target = HashMap::with_capacity(items.len());
    for (idx, item) in items.iter().enumerate() {
        by_id.entry(item.comment.id.to_string()).or_insert(idx);
        if let Some(target) = &item.target {
            by_target.entry(target.clone()).or_insert(idx);
        }
    }
    Ok(Snapshot {
        items,
        associations,
        by_id,
        by_target,
    })
}

impl Snapshot {
    /// Built-in generic `comment -> entry` associations on live entries.
    pub fn associations(&self) -> &[Relation] {
        &self.associations
    }

    pub(crate) fn item(&self, id: &str) -> Option<&Item> {
        self.by_id.get(id).and_then(|&idx| self.items.get(idx))
    }

    pub(crate) fn item_for_target(&self, target: &Target) -> Option<&Item> {
        self.by_target
            .get(target)
            .and_then(|&idx| self.items.get(idx))
    }

    pub(crate) fn cards(&self, filter: Filter, scope: Option<&Target>) -> crate::Listing {
        let listing = self.listing(filter, scope);
        let groups = |groups: Vec<Group>| {
            groups
                .into_iter()
                .map(|g| crate::Group {
                    place: match g.place {
                        Place::On(target) => crate::Place::V3(target),
                        Place::Gone => crate::Place::Gone,
                        Place::Floating => crate::Place::Floating,
                    },
                    items: g.items.iter().map(Item::card).collect(),
                })
                .collect()
        };
        crate::Listing {
            open: groups(listing.open),
            resolved: groups(listing.resolved),
            resolved_count: listing.resolved_count,
        }
    }

    /// Current includes direct module matches and generic entry associations;
    /// an association affects inclusion only, never the card's actual source.
    pub fn listing(&self, filter: Filter, scope: Option<&Target>) -> Listing {
        let related: HashSet<&str> = match scope {
            Some(Target::Entry { id, .. }) => self
                .associations
                .iter()
                .filter(|r| r.to.id == *id)
                .map(|r| r.from.id.as_str())
                .collect(),
            _ => HashSet::new(),
        };
        let mut chosen: Vec<_> = self
            .items
            .iter()
            .filter(|item| {
                let matches_kind = match filter {
                    Filter::All => true,
                    Filter::Comments => !item.comment.is_todo(),
                    Filter::Todos => item.comment.is_todo(),
                };
                matches_kind
                    && scope.is_none_or(|scope| {
                        item.target
                            .as_ref()
                            .is_some_and(|target| scope.contains(target))
                            || related.contains(item.comment.id.as_str())
                    })
            })
            .cloned()
            .collect();
        chosen.sort_by(|a, b| {
            b.comment
                .created_at
                .cmp(&a.comment.created_at)
                .then(b.comment.id.cmp(&a.comment.id))
        });
        let group = |done| {
            let mut groups: Vec<Group> = Vec::new();
            for item in chosen.iter().filter(|i| i.comment.is_done() == done) {
                if let Some(group) = groups.iter_mut().find(|g| g.place == item.place) {
                    group.items.push(item.clone());
                } else {
                    groups.push(Group {
                        place: item.place.clone(),
                        items: vec![item.clone()],
                    });
                }
            }
            groups.sort_by_key(|g| match g.place {
                Place::On(_) => 0,
                Place::Gone => 1,
                Place::Floating => 2,
            });
            groups
        };
        let resolved: Vec<Group> = group(true);
        Listing {
            open: group(false),
            resolved_count: resolved.iter().map(|g| g.items.len()).sum(),
            resolved,
        }
    }
}

/// The precise body a comment anchors. No default module is substituted.
pub fn prose_doc(comment: &CommentV3) -> Option<DocId> {
    let target = comment.target.as_ref()?;
    match target.kind {
        EntityKind::Entry => Some(DocId::Body(BodyDocId::new(
            target.id.parse().ok()?,
            comment.target_module.clone()?,
        ))),
        EntityKind::Material => Some(DocId::Material(target.id.parse().ok()?)),
        _ => None,
    }
}

/// A source card's original passage, resolved against exactly its module.
/// Missing prose is reported as changed without creating an empty document.
pub fn original(ws: &Workspace, book: &str, comment: &str) -> Result<Option<Original>> {
    let id = CommentId::parse(comment).map_err(invalid)?;
    let book_id = BookId::parse(book).map_err(invalid)?;
    let found = ws
        .library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)?
        .read(move |doc| {
            if !dr_doc::v3::is_v3_doc(doc) {
                return Err(invalid("v3 review requires a v3 book"));
            }
            let b = BorrowedBookV3::new(doc, &book_id).map_err(invalid)?;
            if b.view().meta().deleted_at.is_some() {
                return Err(invalid("book is in the trash"));
            }
            Ok(b.view().comment(&id))
        })??;
    let Some(c) = found else {
        return Ok(None);
    };
    let quote = c.quote.as_deref().map(str::trim).filter(|q| !q.is_empty());
    let text = quote.map(str::to_owned).unwrap_or_else(|| {
        c.snapshots
            .iter()
            .map(|s| s.text.trim())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    });
    if text.is_empty() {
        return Ok(None);
    }
    let changed = match (quote, c.anchor.clone(), prose_doc(&c)) {
        (Some(quote), Some(anchor), Some(doc)) => {
            let id = doc.to_string();
            if !ws
                .library()
                .docs(Some(book), None)?
                .iter()
                .any(|d| d.doc_id == id)
            {
                Some(true)
            } else {
                let quote = quote.to_owned();
                Some(
                    ws.library()
                        .open_doc(&id, OpenDoc::Existing)?
                        .read(move |doc| {
                            let now = dr_editor::anchors::decode(&anchor)
                                .and_then(|a| a.resolve(doc))
                                .filter(|r| !r.collapsed)
                                .and_then(|r| {
                                    doc.get_text(dr_doc::schema::prose::BODY)
                                        .slice(r.range.start, r.range.end)
                                        .ok()
                                });
                            now.is_none_or(|now| now.trim() != quote)
                        })?,
                )
            }
        }
        _ => None,
    };
    Ok(Some(Original { text, changed }))
}
