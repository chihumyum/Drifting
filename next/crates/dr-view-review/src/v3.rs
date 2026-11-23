//! Read-only review of format-5 books. Grouping is by entry (or standalone
//! asset); neither grouping nor navigation passes through the legacy NavTarget.

use std::collections::{HashMap, HashSet};

use dr_doc::prose::{BorrowedProse, EmbedView};
use dr_doc::v3::BorrowedBookV3;
use dr_editor::decor::Original;
use dr_model::{
    DocId,
    id::{BodyDocId, BookId, CommentId},
    kind::EntityKind,
    v3::{self as m, CommentV3, FieldType, FieldValue},
};
use dr_store::OpenDoc;
use dr_workspace::{Result, Workspace, WsError};

use crate::{Filter, OriginFilter};

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

/// Sub-target descriptor formatted with the panel's active [`dr_i18n::I18n`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum PartWhere {
    #[default]
    Floating,
    /// Whole entry (`module: None`, `part: None`): no `where` label, no quote.
    WholeEntry,
    /// Whole module (`module: Some`, `part: None`, unanchored): `module_name` only.
    WholeModule,
    /// Prose selection or `TODO:` marker: `module_name`.
    Prose,
    /// Structured sub-part (`field`, `kv_row`, `plot_cell`, `patch`): `"{module_name} · {part}"`.
    NamedPart(String),
    /// Media-module item or prose file embed: `module_name`, optional asset name, optional region.
    EntryAsset {
        asset_title: Option<String>,
        region: Option<Option<u32>>,
    },
    /// Standalone asset in the asset library: whole file (`None`) or region (`Some(page)`).
    StandaloneAsset { region: Option<Option<u32>> },
}

#[derive(Clone, Debug)]
pub struct Item {
    pub comment: CommentV3,
    /// Navigation target for the `→` jump button (`Entry` fallback when `target_missing`).
    pub target: Option<Target>,
    /// Exact scope targets matched when `当前` (`current_only`) is active.
    pub scope_targets: Vec<Target>,
    pub title: String,
    pub module_name: Option<String>,
    /// The module is no longer declared on the entry's template, but stored prose remains.
    pub retained: bool,
    /// The sub-part, embed or unretained module on a live entry is gone (`找不到原处`).
    pub target_missing: bool,
    pub part_where: PartWhere,
    pub part_quote: Option<String>,
    pub place: Place,
}

impl Item {
    /// Shared visual card data; source identity remains in `target`/`place`.
    pub fn card(&self) -> dr_workspace::dto::CommentInfo {
        let c = &self.comment;
        let quote = if c.origin == dr_model::kind::CommentOrigin::Marker {
            None
        } else {
            self.part_quote.clone().or_else(|| c.quote.clone())
        };
        dr_workspace::dto::CommentInfo {
            id: c.id.to_string(),
            target: c.target.as_ref().map(dr_workspace::dto::Target::from),
            module: c.target_module.as_ref().map(ToString::to_string),
            part: c.part.as_ref().map(dr_workspace::dto::CommentPartDto::from),
            unlocated: self.place == Place::Gone || self.target_missing,
            target_block: c.target_block.as_ref().map(ToString::to_string),
            anchored: c.anchor.is_some(),
            quote,
            body: c.body.clone(),
            status: c.status.as_str().into(),
            origin: c.origin.as_str().into(),
            author_kind: c.author_kind.as_str().into(),
            author_name: c.author_name.clone(),
            source: c.source.as_str().into(),
            agent_conversation: c.agent_conversation.clone(),
            projection: c.projection.as_ref().map(|p| p.kind.as_str().into()),
            created_at: c.created_at.map(|t| t.0),
            updated_at: c.updated_at.map(|t| t.0),
        }
    }

    pub fn matches_scope(&self, scope: &Target) -> bool {
        self.scope_targets.iter().any(|t| scope.contains(t))
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
    pub book_name: String,
    pub items: Vec<Item>,
    by_id: HashMap<String, usize>,
    by_place: HashMap<Target, usize>,
}

fn invalid(e: impl ToString) -> WsError {
    WsError::Invalid(e.to_string())
}

fn format_field_value(
    val: &FieldValue,
    field_type: Option<FieldType>,
    entries: &std::collections::BTreeMap<m::EntryId, m::Entry>,
) -> Option<String> {
    match val {
        FieldValue::Null => None,
        FieldValue::Bool(b) => Some(if *b { "true".into() } else { "false".into() }),
        FieldValue::Number(n) => {
            if n.fract() == 0.0 && n.is_finite() {
                Some(format!("{}", *n as i64))
            } else {
                Some(n.to_string())
            }
        }
        FieldValue::Text(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return None;
            }
            if field_type == Some(FieldType::EntityRef)
                && let Ok(eid) = m::EntryId::parse(trimmed)
                && let Some(e) = entries.get(&eid)
                && !e.title.trim().is_empty()
            {
                return Some(e.title.clone());
            }
            Some(trimmed.to_owned())
        }
        FieldValue::List(items) => {
            let parts: Vec<&str> = items
                .iter()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();
            (!parts.is_empty()).then(|| parts.join("、"))
        }
    }
}

/// Read comments and source names in one book snapshot, without opening or
/// creating unreferenced prose documents. Ancestor trash hides navigation, not comments.
pub fn load(ws: &Workspace, book: &str) -> Result<Snapshot> {
    let id = BookId::parse(book).map_err(invalid)?;
    let embedded: Vec<(m::EntryId, m::ModuleId)> = ws.read_book_v3(book, {
        let id = id.clone();
        move |doc, _| {
            let b = BorrowedBookV3::new(doc, &id).map_err(invalid)?;
            Ok(b.view()
                .comments()
                .into_iter()
                .filter_map(|c| match (&c.target, &c.target_module, &c.part) {
                    (Some(t), Some(module), Some(m::CommentPart::Embed { .. }))
                        if t.kind == EntityKind::Entry =>
                    {
                        Some((m::EntryId::parse(&t.id).ok()?, module.clone()))
                    }
                    _ => None,
                })
                .collect::<HashSet<_>>()
                .into_iter()
                .collect())
        }
    })?;
    let mut embeds: HashMap<(m::EntryId, m::ModuleId), Option<HashSet<m::EmbedId>>> =
        HashMap::with_capacity(embedded.len());
    let mut embed_assets: HashMap<(m::EntryId, m::ModuleId, m::EmbedId), m::AssetId> =
        HashMap::new();
    for (e, module) in embedded {
        let set = ws.prose_file_embeds(&e, &module);
        if let Some(ids) = set.clone() {
            let doc_id = DocId::Body(BodyDocId::new(e.clone(), module.clone()));
            if let Ok(handle) = ws
                .library()
                .open_doc(&doc_id.to_string(), OpenDoc::Existing)
                && let Ok(pairs) = handle.read(move |doc| {
                    let mut out = Vec::new();
                    if let Ok(prose) = BorrowedProse::new(doc, &doc_id) {
                        let pv = prose.view();
                        for eid in ids {
                            if let Some(EmbedView::Asset {
                                asset: Some(asset), ..
                            }) = pv.embed(&eid)
                            {
                                out.push((eid, asset));
                            }
                        }
                    }
                    out
                })
            {
                for (eid, asset) in pairs {
                    embed_assets.insert((e.clone(), module.clone(), eid), asset);
                }
            }
        }
        embeds.insert((e, module), set);
    }

    let (book_name, mut items, pending_retained) = ws
        .library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)?
        .read(move |doc| {
            if !dr_doc::v3::is_book_doc(doc) {
                return Err(invalid("v3 review requires a v3 book"));
            }
            let b = BorrowedBookV3::new(doc, &id).map_err(invalid)?;
            let v = b.view();
            let meta = v.meta();
            if meta.deleted_at.is_some() {
                return Err(invalid("book is in the trash"));
            }
            let book_name = meta.name.clone();
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
            let comments = v.comments_with_embeds(Some(&entry_sets), &mut |e, module| {
                embeds.get(&(e.clone(), module.clone())).cloned().flatten()
            });
            if comments.is_empty() {
                return Ok((book_name, Vec::new(), Vec::new()));
            }
            let templates = v.templates_map();
            let live_ids: HashSet<String> = entries
                .values()
                .filter(|e| {
                    !e.is_trashed()
                        && m::effective_ancestors(&entries, &e.id)
                            .iter()
                            .all(|a| entries.get(a).is_some_and(|a| !a.is_trashed()))
                })
                .map(|e| e.id.to_string())
                .collect();

            let mut full_entries: HashMap<m::EntryId, Option<m::Entry>> = HashMap::new();
            let mut patches_cache: HashMap<(m::EntryId, m::ModuleId), Vec<m::PatchV3>> =
                HashMap::new();
            let mut grids_cache: HashMap<(m::EntryId, m::ModuleId), Option<m::PlotGridV3>> =
                HashMap::new();
            let mut assets_cache: HashMap<m::AssetId, Option<dr_model::shared::Asset>> =
                HashMap::new();
            let mut pending_retained: Vec<(usize, String, String, String)> = Vec::new();

            let items: Vec<Item> = comments
                .into_iter()
                .enumerate()
                .map(|(idx, comment)| {
                    let Some(target_ref) = &comment.target else {
                        return Item {
                            comment,
                            target: None,
                            scope_targets: Vec::new(),
                            title: String::new(),
                            module_name: None,
                            retained: false,
                            target_missing: false,
                            part_where: PartWhere::Floating,
                            part_quote: None,
                            place: Place::Floating,
                        };
                    };

                    match target_ref.kind {
                        EntityKind::Asset => {
                            let Ok(aid) = m::AssetId::parse(&target_ref.id) else {
                                return gone_item(comment);
                            };
                            let asset = assets_cache
                                .entry(aid.clone())
                                .or_insert_with(|| v.asset(&aid))
                                .clone();
                            let Some(asset) = asset else {
                                return gone_item(comment);
                            };
                            let title = if asset.name.trim().is_empty() {
                                aid.to_string()
                            } else {
                                asset.name.clone()
                            };
                            let region = match &comment.part {
                                Some(m::CommentPart::Region { region }) => Some(region.page),
                                _ => None,
                            };
                            let mat_target = Target::Material(aid.to_string());
                            Item {
                                comment,
                                target: Some(mat_target.clone()),
                                scope_targets: vec![mat_target.clone()],
                                title,
                                module_name: None,
                                retained: false,
                                target_missing: false,
                                part_where: PartWhere::StandaloneAsset { region },
                                part_quote: None,
                                place: Place::On(mat_target),
                            }
                        }
                        EntityKind::Entry => {
                            let Ok(eid) = m::EntryId::parse(&target_ref.id) else {
                                return gone_item(comment);
                            };
                            if !live_ids.contains(eid.as_str()) {
                                return gone_item(comment);
                            }
                            let Some(header) = entries.get(&eid) else {
                                return gone_item(comment);
                            };
                            let title = header.title.clone();
                            let entry_only = Target::Entry {
                                id: eid.to_string(),
                                module: None,
                            };
                            let place = Place::On(entry_only.clone());

                            let Some(mod_id) = comment.target_module.clone() else {
                                return Item {
                                    comment,
                                    target: Some(entry_only.clone()),
                                    scope_targets: vec![entry_only],
                                    title,
                                    module_name: None,
                                    retained: false,
                                    target_missing: false,
                                    part_where: PartWhere::WholeEntry,
                                    part_quote: None,
                                    place,
                                };
                            };

                            let mod_str = mod_id.to_string();
                            let definition = header
                                .effective_template(&templates)
                                .and_then(|t| t.modules.iter().find(|m| m.id == mod_id));
                            let module_name = definition
                                .map(|m| m.name.clone())
                                .or_else(|| Some(mod_str.clone()));
                            let entry_mod = Target::Entry {
                                id: eid.to_string(),
                                module: Some(mod_str.clone()),
                            };

                            if comment.part.is_none() {
                                let is_whole_module = comment.anchor.is_none()
                                    && comment.target_block.is_none()
                                    && comment.quote.as_deref().is_none_or(|q| q.trim().is_empty())
                                    && comment.origin != dr_model::kind::CommentOrigin::Marker
                                    && comment.origin != dr_model::kind::CommentOrigin::Task;
                                let part_where = if is_whole_module {
                                    PartWhere::WholeModule
                                } else {
                                    PartWhere::Prose
                                };
                                if definition.is_some() {
                                    let missing = comment.target_missing;
                                    return Item {
                                        comment,
                                        target: Some(if missing {
                                            entry_only
                                        } else {
                                            entry_mod.clone()
                                        }),
                                        scope_targets: vec![entry_mod],
                                        title,
                                        module_name: definition.map(|m| m.name.clone()),
                                        retained: false,
                                        target_missing: missing,
                                        part_where,
                                        part_quote: None,
                                        place,
                                    };
                                }
                                pending_retained.push((
                                    idx,
                                    format!("body:{eid}/{mod_str}"),
                                    eid.to_string(),
                                    mod_str,
                                ));
                                return Item {
                                    comment,
                                    target: Some(entry_only),
                                    scope_targets: vec![entry_mod],
                                    title,
                                    module_name: Some(mod_id.to_string()),
                                    retained: false,
                                    target_missing: true,
                                    part_where,
                                    part_quote: None,
                                    place,
                                };
                            }

                            let full = full_entries
                                .entry(eid.clone())
                                .or_insert_with(|| v.entry(&eid))
                                .clone();
                            let missing = comment.target_missing || definition.is_none();

                            match comment.part.as_ref().expect("checked part.is_some()") {
                                m::CommentPart::Field { field } => {
                                    let def = definition.and_then(|m| {
                                        m.config.defs.iter().find(|d| d.id == field.as_str())
                                    });
                                    let label = def
                                        .map(|d| d.name.clone())
                                        .unwrap_or_else(|| field.to_string());
                                    let val = full
                                        .as_ref()
                                        .and_then(|e| e.fields.get(&mod_id))
                                        .and_then(|f| f.get(field.as_str()))
                                        .and_then(|fv| {
                                            format_field_value(
                                                fv,
                                                def.map(|d| d.field_type.clone()),
                                                &entries,
                                            )
                                        });
                                    Item {
                                        comment,
                                        target: Some(if missing {
                                            entry_only
                                        } else {
                                            entry_mod.clone()
                                        }),
                                        scope_targets: vec![entry_mod],
                                        title,
                                        module_name,
                                        retained: false,
                                        target_missing: missing,
                                        part_where: PartWhere::NamedPart(label),
                                        part_quote: val,
                                        place,
                                    }
                                }
                                m::CommentPart::KvRow { row } => {
                                    let kv_row = full
                                        .as_ref()
                                        .and_then(|e| e.kv.get(&mod_id))
                                        .and_then(|rows| rows.iter().find(|r| &r.id == row));
                                    let label =
                                        kv_row.map(|r| r.key.trim().to_owned()).unwrap_or_default();
                                    let val = kv_row
                                        .map(|r| r.value.trim().to_owned())
                                        .filter(|s| !s.is_empty());
                                    Item {
                                        comment,
                                        target: Some(if missing {
                                            entry_only
                                        } else {
                                            entry_mod.clone()
                                        }),
                                        scope_targets: vec![entry_mod],
                                        title,
                                        module_name,
                                        retained: false,
                                        target_missing: missing,
                                        part_where: PartWhere::NamedPart(label),
                                        part_quote: val,
                                        place,
                                    }
                                }
                                m::CommentPart::PlotCell { row, col } => {
                                    let grid = grids_cache
                                        .entry((eid.clone(), mod_id.clone()))
                                        .or_insert_with(|| v.plot_grid(&eid, &mod_id))
                                        .as_ref();
                                    let row_label = grid
                                        .and_then(|g| g.rows.iter().find(|r| &r.id == row))
                                        .map(|r| r.label.trim())
                                        .filter(|s| !s.is_empty())
                                        .unwrap_or(row.as_str());
                                    let col_label = grid
                                        .and_then(|g| g.cols.iter().find(|c| &c.id == col))
                                        .map(|c| c.label.trim())
                                        .filter(|s| !s.is_empty())
                                        .unwrap_or(col.as_str());
                                    let label = format!("{row_label} × {col_label}");
                                    let val = grid
                                        .and_then(|g| g.cells.get(&(row.clone(), col.clone())))
                                        .map(|s| s.trim().to_owned())
                                        .filter(|s| !s.is_empty());
                                    Item {
                                        comment,
                                        target: Some(if missing {
                                            entry_only
                                        } else {
                                            entry_mod.clone()
                                        }),
                                        scope_targets: vec![entry_mod],
                                        title,
                                        module_name,
                                        retained: false,
                                        target_missing: missing,
                                        part_where: PartWhere::NamedPart(label),
                                        part_quote: val,
                                        place,
                                    }
                                }
                                m::CommentPart::Patch { patch } => {
                                    let pa = patches_cache
                                        .entry((eid.clone(), mod_id.clone()))
                                        .or_insert_with(|| v.patches_of(&eid, &mod_id))
                                        .iter()
                                        .find(|p| &p.id == patch)
                                        .cloned();
                                    let label = pa
                                        .as_ref()
                                        .and_then(|p| p.title.as_deref())
                                        .map(str::trim)
                                        .filter(|s| !s.is_empty())
                                        .map(str::to_owned)
                                        .unwrap_or_default();
                                    let val = pa
                                        .as_ref()
                                        .map(|p| p.body.trim().to_owned())
                                        .filter(|s| !s.is_empty());
                                    Item {
                                        comment,
                                        target: Some(if missing {
                                            entry_only
                                        } else {
                                            entry_mod.clone()
                                        }),
                                        scope_targets: vec![entry_mod],
                                        title,
                                        module_name,
                                        retained: false,
                                        target_missing: missing,
                                        part_where: PartWhere::NamedPart(label),
                                        part_quote: val,
                                        place,
                                    }
                                }
                                m::CommentPart::Media { asset, region } => {
                                    let region_page = region.as_ref().map(|r| r.page);
                                    let media_item = full
                                        .as_ref()
                                        .and_then(|e| e.media.get(&mod_id))
                                        .and_then(|items| items.iter().find(|i| &i.asset == asset))
                                        .map(|i| i.id.to_string());
                                    let asset_rec = assets_cache
                                        .entry(asset.clone())
                                        .or_insert_with(|| v.asset(asset))
                                        .clone();
                                    let asset_title = asset_rec
                                        .as_ref()
                                        .map(|a| a.name.trim().to_owned())
                                        .filter(|s| !s.is_empty());
                                    let mat_scope = Target::Material(
                                        media_item.clone().unwrap_or_else(|| asset.to_string()),
                                    );
                                    let jump = if missing {
                                        entry_only
                                    } else {
                                        mat_scope.clone()
                                    };
                                    Item {
                                        comment,
                                        target: Some(jump),
                                        scope_targets: vec![entry_mod, mat_scope],
                                        title,
                                        module_name,
                                        retained: false,
                                        target_missing: missing,
                                        part_where: PartWhere::EntryAsset {
                                            asset_title,
                                            region: region_page,
                                        },
                                        part_quote: None,
                                        place,
                                    }
                                }
                                m::CommentPart::Embed { embed, region } => {
                                    let region_page = region.as_ref().map(|r| r.page);
                                    let asset_title = embed_assets
                                        .get(&(eid.clone(), mod_id.clone(), embed.clone()))
                                        .and_then(|aid| {
                                            assets_cache
                                                .entry(aid.clone())
                                                .or_insert_with(|| v.asset(aid))
                                                .as_ref()
                                                .map(|a| a.name.trim().to_owned())
                                                .filter(|s| !s.is_empty())
                                        });
                                    Item {
                                        comment,
                                        target: Some(if missing {
                                            entry_only
                                        } else {
                                            entry_mod.clone()
                                        }),
                                        scope_targets: vec![entry_mod],
                                        title,
                                        module_name,
                                        retained: false,
                                        target_missing: missing,
                                        part_where: PartWhere::EntryAsset {
                                            asset_title,
                                            region: region_page,
                                        },
                                        part_quote: None,
                                        place,
                                    }
                                }
                                m::CommentPart::Region { region } => {
                                    let region_page = region.page;
                                    Item {
                                        comment,
                                        target: Some(entry_only),
                                        scope_targets: vec![entry_mod],
                                        title,
                                        module_name,
                                        retained: false,
                                        target_missing: true,
                                        part_where: PartWhere::StandaloneAsset {
                                            region: Some(region_page),
                                        },
                                        part_quote: None,
                                        place,
                                    }
                                }
                            }
                        }
                        EntityKind::Material => {
                            let mat = Target::Material(target_ref.id.clone());
                            if let Ok(aid) = m::AssetId::parse(&target_ref.id)
                                && let Some(asset) = assets_cache
                                    .entry(aid.clone())
                                    .or_insert_with(|| v.asset(&aid))
                                    .clone()
                            {
                                let title = if asset.name.trim().is_empty() {
                                    aid.to_string()
                                } else {
                                    asset.name
                                };
                                Item {
                                    comment,
                                    target: Some(mat.clone()),
                                    scope_targets: vec![mat.clone()],
                                    title,
                                    module_name: None,
                                    retained: false,
                                    target_missing: false,
                                    part_where: PartWhere::StandaloneAsset { region: None },
                                    part_quote: None,
                                    place: Place::On(mat),
                                }
                            } else {
                                gone_item(comment)
                            }
                        }
                        _ => gone_item(comment),
                    }
                })
                .collect();
            Ok((book_name, items, pending_retained))
        })??;

    if !pending_retained.is_empty() {
        let stored: HashSet<String> = ws
            .library()
            .docs(Some(book), None)?
            .into_iter()
            .map(|d| d.doc_id)
            .collect();
        for (idx, doc_id, eid, mod_str) in pending_retained {
            if stored.contains(&doc_id)
                && let Some(item) = items.get_mut(idx)
            {
                item.retained = true;
                item.target_missing = false;
                item.module_name = None;
                item.target = Some(Target::Entry {
                    id: eid,
                    module: Some(mod_str),
                });
            }
        }
    }

    // While the author's setting is off, an automatic link reads as text
    // and only those picked with @ stay links (`kernel-v5.md` §16); the
    // book gave the rest under their entries' own switches.
    if !ws.auto_links() {
        for item in &mut items {
            item.comment.body.links.retain(|l| l.manual);
        }
    }
    let mut by_id = HashMap::with_capacity(items.len());
    let mut by_place = HashMap::with_capacity(items.len());
    for (idx, item) in items.iter().enumerate() {
        by_id.entry(item.comment.id.to_string()).or_insert(idx);
        if let Place::On(place_target) = &item.place {
            by_place.entry(place_target.clone()).or_insert(idx);
        }
        if let Some(target) = &item.target {
            by_place.entry(target.clone()).or_insert(idx);
        }
    }
    Ok(Snapshot {
        book_name,
        items,
        by_id,
        by_place,
    })
}

fn gone_item(comment: CommentV3) -> Item {
    let scope_targets = match &comment.target {
        Some(t) if t.kind == EntityKind::Entry => vec![Target::Entry {
            id: t.id.clone(),
            module: comment.target_module.as_ref().map(ToString::to_string),
        }],
        Some(t) if matches!(t.kind, EntityKind::Asset | EntityKind::Material) => {
            vec![Target::Material(t.id.clone())]
        }
        _ => Vec::new(),
    };
    Item {
        comment,
        target: None,
        scope_targets,
        title: String::new(),
        module_name: None,
        retained: false,
        target_missing: true,
        part_where: PartWhere::Floating,
        part_quote: None,
        place: Place::Gone,
    }
}

impl Snapshot {
    pub(crate) fn item(&self, id: &str) -> Option<&Item> {
        self.by_id.get(id).and_then(|&idx| self.items.get(idx))
    }

    pub(crate) fn item_for_target(&self, target: &Target) -> Option<&Item> {
        self.by_place
            .get(target)
            .and_then(|&idx| self.items.get(idx))
    }

    pub(crate) fn cards(&self, filter: Filter, scope: Option<&Target>) -> crate::Listing {
        self.cards_filtered(OriginFilter::All, filter, scope)
    }

    pub(crate) fn cards_filtered(
        &self,
        origin_filter: OriginFilter,
        legacy_filter: Filter,
        scope: Option<&Target>,
    ) -> crate::Listing {
        let listing = self.listing_filtered(origin_filter, legacy_filter, scope);
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

    /// Filter comments by their direct target and module.
    pub fn listing(&self, filter: Filter, scope: Option<&Target>) -> Listing {
        self.listing_filtered(OriginFilter::All, filter, scope)
    }

    pub fn listing_filtered(
        &self,
        origin_filter: OriginFilter,
        legacy_filter: Filter,
        scope: Option<&Target>,
    ) -> Listing {
        let mut chosen: Vec<_> = self
            .items
            .iter()
            .filter(|item| {
                let is_projected = matches!(
                    item.comment.origin,
                    dr_model::kind::CommentOrigin::Marker | dr_model::kind::CommentOrigin::Task
                );
                let matches_legacy = match legacy_filter {
                    Filter::All => true,
                    Filter::Comments => !is_projected,
                    Filter::Todos => is_projected,
                };
                let matches_origin = origin_filter.matches(item.comment.origin.as_str());
                matches_legacy
                    && matches_origin
                    && scope.is_none_or(|scope| item.matches_scope(scope))
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
            if !dr_doc::v3::is_book_doc(doc) {
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
