//! Built-in asset library (`assets` in the book document; bytes live in storage).
//!
//! Per `kernel-v5.md` §6 ("素材库"), `assets` is the project's built-in file
//! manifest (images and PDFs). Files stay in the library even when unreferenced;
//! trashing an asset moves it to Recently Deleted (`deleted_at`) so places that
//! reference it read as placeholders while disk bytes remain; purging a trashed
//! asset deletes the record, dangling relations, and disk bytes.

use std::collections::{BTreeMap, BTreeSet};

use dr_doc::v3::CollectionV3;
use dr_model::id::AssetId;
use dr_model::kind::{AssetKind, EntityKind};
use dr_model::shared::{Asset, EntityRef};
use dr_model::v3::ModuleKind;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::EffectAction;
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<AssetPut>()
        .add::<AssetRename>()
        .add::<AssetTrash>()
        .add::<AssetRestore>()
        .add::<AssetPurge>()
        .add::<AssetGet>()
        .add::<AssetList>();
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AssetPutIn {
    pub book: String,
    /// The asset id the store imported the bytes under.
    pub id: String,
    /// Display filename (`assets.<id>.name`); optional for idempotent callers.
    #[serde(default)]
    pub name: String,
    /// `image` or `pdf`.
    pub kind: String,
    pub mime: String,
    pub size: i64,
    /// Lowercase hex SHA-256 of the bytes.
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    /// Original 0.1 material folder path when imported (optional).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

op! {
    AssetPut = "asset.put", Write, Book,
    "Record an imported asset in the project's built-in asset library (bytes live in storage).",
    fn(cx, input: AssetPutIn) -> Done {
        let slot = cx.book(&input.book)?;
        let folder = input
            .folder
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let a = Asset {
            id: pid::<AssetId>("asset", &input.id)?,
            name: input.name.trim().to_owned(),
            kind: AssetKind::parse(&input.kind),
            mime: input.mime.clone(),
            size: input.size,
            sha256: input.sha256.clone(),
            width: input.width,
            height: input.height,
            created_at: Some(now()),
            folder,
            deleted_at: None,
        };
        dr_model::check::asset_shape(&a)?;
        if slot.is_v3()
            && let Some(stored) = cx.workspace().library().asset(a.id.as_str(), dr_store::asset::Variant::Source)?
            && (stored.book_id != slot.book.as_str() || stored.sha256 != a.sha256 || stored.size != a.size as u64)
        {
            return Err(WsError::invalid("asset bytes do not match this book's metadata"));
        }
        if let Some(have) = slot.reader_v3.view().asset_raw(&a.id) {
            if !have.same_file(&a) {
                return Err(WsError::Locked(format!("asset {} is already recorded differently", input.id)));
            }
            let need_name = have.name.is_empty() && !a.name.is_empty();
            let need_folder = have.folder.is_none() && a.folder.is_some();
            let need_restore = have.is_trashed();
            if !need_name && !need_folder && !need_restore {
                cx.undo_nothing();
                return Ok(Done { id: input.id });
            }
            let a2 = a.clone();
            let (_, at) = cx.write_book_v3(&slot, Replaces::nothing(), move |txn| {
                txn.put_asset(&a2)?;
                Ok(())
            })?;
            if need_restore {
                v3::undo(cx, &slot, &at, vec![v3::key("assets", &a.id)]);
                cx.effect(
                    EffectAction::Restored,
                    "asset",
                    &input.id,
                    (!a.name.is_empty()).then_some(a.name.as_str()),
                );
            } else {
                cx.effect(
                    EffectAction::Updated,
                    "asset",
                    &input.id,
                    (!a.name.is_empty()).then_some(a.name.as_str()),
                );
                cx.irreversible();
            }
            return Ok(Done { id: input.id });
        }
        let a2 = a.clone();
        // Written once, under the id of its bytes.
        cx.write_book_v3(&slot, Replaces::nothing(), move |txn| {
            txn.put_asset(&a2)?;
            Ok(())
        })?;
        cx.effect(
            EffectAction::Created,
            "asset",
            &input.id,
            (!a.name.is_empty()).then_some(a.name.as_str()),
        );
        cx.irreversible();
        Ok(Done { id: input.id })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AssetRenameIn {
    pub book: String,
    pub id: String,
    pub name: String,
}

op! {
    AssetRename = "asset.rename", Write, Book,
    "Rename a live asset in the built-in asset library.",
    fn(cx, input: AssetRenameIn) -> Named {
        let slot = cx.book_v3(&input.book)?;
        name_ok(&input.name)?;
        let id: AssetId = pid("asset", &input.id)?;
        let trimmed = input.name.trim().to_owned();
        let have = slot
            .reader_v3
            .view()
            .asset(&id)
            .ok_or_else(|| WsError::not_found("asset", &input.id))?;
        if have.name == trimmed {
            cx.undo_nothing();
            return Ok(Named {
                id: input.id,
                name: trimmed,
            });
        }
        let id2 = id.clone();
        let name2 = trimmed.clone();
        let replaced = rec(CollectionV3::Assets, &id).at(["name"]);
        let (_, at) = cx.write_book_v3(&slot, Replaces::records([replaced]), move |txn| {
            txn.asset(&id2)?.name(&name2)?;
            Ok(())
        })?;
        v3::undo(cx, &slot, &at, vec![v3::key("assets", &id)]);
        cx.effect(EffectAction::Updated, "asset", &input.id, Some(&trimmed));
        Ok(Named {
            id: input.id,
            name: trimmed,
        })
    }
}

fn set_asset_trashed(cx: &Cx<'_>, input: EntityIn, trashed: bool) -> Result<Done> {
    let slot = cx.book_v3(&input.book)?;
    let id: AssetId = pid("asset", &input.id)?;
    let have = slot
        .reader_v3
        .view()
        .asset_raw(&id)
        .ok_or_else(|| WsError::not_found("asset", &input.id))?;
    if have.is_trashed() == trashed {
        cx.undo_nothing();
        return Ok(Done { id: input.id });
    }
    let stamp = trashed.then(now);
    let id2 = id.clone();
    let replaced = rec(CollectionV3::Assets, &id).at(["deleted_at"]);
    let (_, at) = cx.write_book_v3(&slot, Replaces::records([replaced]), move |txn| {
        txn.asset(&id2)?.deleted_at(stamp)?;
        Ok(())
    })?;
    v3::undo(cx, &slot, &at, vec![v3::key("assets", &id)]);
    cx.effect(
        if trashed {
            EffectAction::Trashed
        } else {
            EffectAction::Restored
        },
        "asset",
        &input.id,
        (!have.name.is_empty()).then_some(have.name.as_str()),
    );
    Ok(Done { id: input.id })
}

op! {
    AssetTrash = "asset.trash", Write, Book,
    "Move an asset in the built-in asset library to Recently Deleted; places referencing it read as placeholders while its bytes remain.",
    fn(cx, input: EntityIn) -> Done {
        set_asset_trashed(cx, input, true)
    }
}

op! {
    AssetRestore = "asset.restore", Write, Book,
    "Restore a trashed asset from Recently Deleted back into the asset library.",
    fn(cx, input: EntityIn) -> Done {
        set_asset_trashed(cx, input, false)
    }
}

op! {
    AssetPurge = "asset.purge", Write, Book,
    "Permanently purge a trashed asset from the book manifest and delete its stored bytes.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let id: AssetId = pid("asset", &input.id)?;
        let have = slot
            .reader_v3
            .view()
            .asset_raw(&id)
            .ok_or_else(|| WsError::not_found("asset", &input.id))?;
        if !have.is_trashed() {
            return Err(WsError::invalid("asset must be trashed before purge"));
        }
        let target = EntityRef::new(EntityKind::Asset, input.id.clone());
        let (rels, _) = purge_fallout(&slot, &target);
        let id2 = id.clone();
        let rels2 = rels.clone();
        cx.write_book_v3(&slot, Replaces::record(CollectionV3::Assets, &id), move |txn| {
            for r in &rels2 {
                txn.purge(CollectionV3::Relations, r.as_str())?;
            }
            txn.purge(CollectionV3::Assets, id2.as_str())?;
            Ok(())
        })?;
        cx.workspace().library().remove_asset(id.as_str())?;
        for r in &rels {
            cx.effect(EffectAction::Purged, "relation", r.as_str(), None);
        }
        cx.effect(
            EffectAction::Purged,
            "asset",
            &input.id,
            (!have.name.is_empty()).then_some(have.name.as_str()),
        );
        cx.irreversible();
        Ok(Done { id: input.id })
    }
}

/// One live place in the book where an asset is used (`kernel-v5.md` §6).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AssetUsage {
    /// An item in a live entry's active `media` module.
    Media {
        entry: String,
        module: String,
        item: String,
    },
    /// A file embed block inside a live entry's active `prose` module.
    Embed {
        entry: String,
        module: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block: Option<String>,
    },
    /// A relation where one end is this asset and the other end is live.
    Relation {
        relation: String,
        other: v3::content::Ref,
    },
}

/// An asset's recorded metadata and live usages in the book.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct AssetInfo {
    pub id: String,
    pub name: String,
    /// `image` or `pdf`.
    pub kind: String,
    pub mime: String,
    /// Bytes.
    pub size: i64,
    pub sha256: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub created_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
    pub usages: Vec<AssetUsage>,
}

impl AssetInfo {
    fn from_asset(a: &Asset, usages: Vec<AssetUsage>) -> Self {
        Self {
            id: a.id.to_string(),
            name: a.name.clone(),
            kind: a.kind.as_str().to_owned(),
            mime: a.mime.clone(),
            size: a.size,
            sha256: a.sha256.clone(),
            width: a.width,
            height: a.height,
            created_at: a.created_at.map(|t| t.0),
            folder: a.folder.clone(),
            deleted_at: a.deleted_at.map(|t| t.0),
            usages,
        }
    }
}

fn compute_usages(cx: &Cx<'_>, slot: &BookSlot) -> Result<BTreeMap<AssetId, Vec<AssetUsage>>> {
    let mut by_asset: BTreeMap<AssetId, Vec<AssetUsage>> = BTreeMap::new();
    let view = slot.reader_v3.view();
    let templates = view.templates_map();
    let live_entries = view.entries();

    let mut untemplated_live: BTreeSet<String> = BTreeSet::new();
    let mut active_prose: BTreeSet<(String, String)> = BTreeSet::new();

    for e in &live_entries {
        for (mod_id, items) in e.visible_media(&templates) {
            for item in items {
                by_asset
                    .entry(item.asset.clone())
                    .or_default()
                    .push(AssetUsage::Media {
                        entry: e.id.to_string(),
                        module: mod_id.to_string(),
                        item: item.id.to_string(),
                    });
            }
        }
        if let Some(tpl) = e.effective_template(&templates) {
            for spec in &tpl.modules {
                if spec.kind == ModuleKind::Prose {
                    active_prose.insert((e.id.to_string(), spec.id.to_string()));
                }
            }
        } else {
            untemplated_live.insert(e.id.to_string());
        }
    }

    cx.workspace().flush_book_prose_indices(&slot.book)?;
    let rows = cx
        .workspace()
        .library()
        .entry_module_references_in_book(slot.book.as_str())?;
    for r in &rows {
        if r.kind != dr_store::index::RefKind::Embed || r.target_kind != "asset" || r.count == 0 {
            continue;
        }
        let is_active = untemplated_live.contains(&r.source_entry)
            || active_prose.contains(&(r.source_entry.clone(), r.source_module.clone()));
        if !is_active {
            continue;
        }
        let Ok(aid) = AssetId::parse(&r.target_id) else {
            continue;
        };
        let block = r.source_block.clone().filter(|b| !b.is_empty());
        let list = by_asset.entry(aid).or_default();
        for _ in 0..r.count {
            list.push(AssetUsage::Embed {
                entry: r.source_entry.clone(),
                module: r.source_module.clone(),
                block: block.clone(),
            });
        }
    }

    for r in view.relations_raw() {
        if r.from.kind == EntityKind::Asset
            && view.entity_exists(&r.to)
            && let Ok(aid) = AssetId::parse(r.from.id.as_str())
        {
            by_asset.entry(aid).or_default().push(AssetUsage::Relation {
                relation: r.id.to_string(),
                other: v3::content::Ref {
                    kind: r.to.kind.as_str().to_owned(),
                    id: r.to.id.clone(),
                },
            });
        }
        if r.to.kind == EntityKind::Asset
            && view.entity_exists(&r.from)
            && let Ok(aid) = AssetId::parse(r.to.id.as_str())
        {
            by_asset.entry(aid).or_default().push(AssetUsage::Relation {
                relation: r.id.to_string(),
                other: v3::content::Ref {
                    kind: r.from.kind.as_str().to_owned(),
                    id: r.from.id.clone(),
                },
            });
        }
    }

    Ok(by_asset)
}

op! {
    AssetGet = "asset.get", Read, Shared,
    "Read an asset's metadata and live usages in the book.",
    fn(cx, input: EntityIn) -> AssetInfo {
        let slot = cx.book(&input.book)?;
        let id: AssetId = pid("asset", &input.id)?;
        let a = slot
            .reader_v3
            .view()
            .asset_raw(&id)
            .ok_or_else(|| WsError::not_found("asset", input.id.clone()))?;
        let mut usages = compute_usages(cx, &slot)?;
        Ok(AssetInfo::from_asset(&a, usages.remove(&a.id).unwrap_or_default()))
    }
}

op! {
    AssetList = "asset.list", Read, Shared,
    "List assets in the project's built-in asset library (sorted by asset id), each with its live usages (media modules, prose embeds, relations). Set `trashed: true` to include Recently Deleted.",
    fn(cx, input: ListIn) -> Vec<AssetInfo> {
        let slot = cx.book(&input.book)?;
        let list = if input.trashed {
            slot.reader_v3.view().assets_raw()
        } else {
            slot.reader_v3.view().assets()
        };
        let mut usages = compute_usages(cx, &slot)?;
        Ok(list
            .iter()
            .map(|a| AssetInfo::from_asset(a, usages.remove(&a.id).unwrap_or_default()))
            .collect())
    }
}
