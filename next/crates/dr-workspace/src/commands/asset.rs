//! Built-in asset library (`assets` in the book document; bytes live in storage).
//!
//! Per `kernel-v5.md` §6 ("素材库"), `assets` is the project's built-in file
//! manifest (images and PDFs). Files stay in the library even when unreferenced;
//! trashing an asset moves it to Recently Deleted (`deleted_at`) so places that
//! reference it read as placeholders while disk bytes remain; purging a trashed
//! asset deletes the record, dangling relations, and disk bytes.

use std::collections::{BTreeMap, BTreeSet};

use dr_doc::v3::CollectionV3;
use dr_model::id::{AssetFolderId, AssetId};
use dr_model::kind::{AssetKind, EntityKind};
use dr_model::pos::PosKey;
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
        .add::<AssetMove>()
        .add::<AssetGet>()
        .add::<AssetList>()
        .add::<AssetFolderCreate>()
        .add::<AssetFolderRename>()
        .add::<AssetFolderMove>()
        .add::<AssetFolderTrash>()
        .add::<AssetFolderRestore>()
        .add::<AssetFolderPurge>()
        .add::<AssetFolderList>();
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
    /// The asset-library folder to put a new file in (a live folder id);
    /// omitted: the top of the library. It goes last in that folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

/// A live folder of `slot`'s asset library named by `id`, if any.
fn live_folder(slot: &BookSlot, id: Option<&str>) -> Result<Option<AssetFolderId>> {
    let Some(id) = id.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let fid: AssetFolderId = pid("asset folder", id)?;
    if !slot
        .reader_v3
        .view()
        .asset_folders()
        .iter()
        .any(|f| f.id == fid)
    {
        return Err(WsError::not_found("asset folder", id));
    }
    Ok(Some(fid))
}

/// The position after the last live file of `folder` (`without` aside).
fn end_of_folder(
    slot: &BookSlot,
    folder: Option<&AssetFolderId>,
    without: Option<&AssetId>,
) -> PosKey {
    slot.reader_v3
        .view()
        .assets()
        .into_iter()
        .filter(|a| a.folder.as_ref() == folder && Some(&a.id) != without)
        .filter_map(|a| a.pos)
        .max()
        .map_or_else(PosKey::first, |p| p.after())
}

op! {
    AssetPut = "asset.put", Write, Book,
    "Record an imported file in the project's built-in asset library (bytes live in storage). The same bytes are one file: when the library has them already, that file's id is given back (restored from Recently Deleted if it was there).",
    fn(cx, input: AssetPutIn) -> Done {
        let slot = cx.book(&input.book)?;
        let folder = live_folder(&slot, input.folder.as_deref())?;
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
            pos: Some(end_of_folder(&slot, folder.as_ref(), None)),
            folder,
            deleted_at: None,
            trashed_with: None,
        };
        dr_model::check::asset_shape(&a)?;
        if let Some(stored) = cx.workspace().library().asset(a.id.as_str(), dr_store::asset::Variant::Source)?
            && (stored.book_id != slot.book.as_str() || stored.sha256 != a.sha256 || stored.size != a.size as u64)
        {
            return Err(WsError::invalid("asset bytes do not match this book's metadata"));
        }
        let view = slot.reader_v3.view();
        if let Some(have) = view.asset_raw(&a.id) {
            if !have.same_file(&a) {
                return Err(WsError::Locked(format!("asset {} is already recorded differently", input.id)));
            }
            return restore_or_fill(cx, &slot, have, Some(&a));
        }
        // The same bytes are already a file of the library
        // (`ASSET-BYTES-UNIQUE`): that one, not a second.
        let library = cx.workspace().library();
        let held = |id: &AssetId| -> Result<bool> {
            Ok(library
                .asset(id.as_str(), dr_store::asset::Variant::Source)?
                .is_some_and(|r| r.book_id == slot.book.as_str()))
        };
        let same: Vec<Asset> = view
            .assets_raw()
            .into_iter()
            .filter(|x| x.sha256 == a.sha256 && x.size == a.size && x.kind == a.kind)
            .collect();
        let mut have = None;
        for x in &same {
            if held(&x.id)? {
                have = Some(x.clone());
                break;
            }
        }
        let callers_copy = held(&a.id)?;
        // A file recorded here whose bytes have not reached this device (its
        // record synced first) is not what the caller's bytes are folded
        // into: that would delete the only copy this device holds. They stay
        // a file of their own until the author removes one of the two.
        if have.is_none() && !callers_copy {
            have = same.into_iter().next();
        }
        if let Some(have) = have {
            if callers_copy {
                // The copy the caller stored for bytes the library has.
                library.remove_book_asset(slot.book.as_str(), a.id.as_str())?;
            }
            return restore_or_fill(cx, &slot, have, None);
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

/// `have` given back for a put: restored from Recently Deleted when it is
/// there (to the top of the library when its folder is), and its name or
/// folder filled in from `wanted` where it has none.
fn restore_or_fill(
    cx: &Cx<'_>,
    slot: &BookSlot,
    have: Asset,
    wanted: Option<&Asset>,
) -> Result<Done> {
    let view = slot.reader_v3.view();
    let live = view.asset(&have.id).is_some();
    // Its folder is in Recently Deleted (it went there with it, or a merge
    // put it into one): the folder cannot hold it, so it comes back to the
    // folder the caller names, else to the top of the library.
    let in_trashed_folder = have
        .folder
        .as_ref()
        .is_some_and(|f| !view.asset_folders().iter().any(|x| &x.id == f));
    let name = wanted
        .filter(|w| have.name.is_empty() && !w.name.is_empty())
        .map(|w| w.name.clone());
    let folder = wanted
        .and_then(|w| w.folder.clone())
        .filter(|_| have.folder.is_none() || in_trashed_folder);
    if live && name.is_none() && folder.is_none() {
        cx.undo_nothing();
        return Ok(Done {
            id: have.id.to_string(),
        });
    }
    let id = have.id.clone();
    let id2 = id.clone();
    let (name2, folder2) = (name.clone(), folder.clone());
    let move_it = in_trashed_folder || folder.is_some();
    let end = move_it.then(|| end_of_folder(slot, folder.as_ref(), Some(&id)));
    let replaced = rec(CollectionV3::Assets, &id);
    let (_, at) = cx.write_book_v3(slot, Replaces::records([replaced]), move |txn| {
        let w = txn.asset(&id2)?;
        w.deleted_at(None)?.trashed_with(None)?;
        if let Some(n) = &name2 {
            w.name(n)?;
        }
        if move_it {
            w.folder(folder2.as_ref())?.pos(end.as_ref())?;
        }
        Ok(())
    })?;
    v3::undo(cx, slot, &at, vec![v3::key("assets", &id)]);
    cx.effect(
        if live {
            EffectAction::Updated
        } else {
            EffectAction::Restored
        },
        "asset",
        id.as_str(),
        (!have.name.is_empty()).then_some(have.name.as_str()),
    );
    Ok(Done { id: id.to_string() })
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
    let view = slot.reader_v3.view();
    let have = view
        .asset_raw(&id)
        .ok_or_else(|| WsError::not_found("asset", &input.id))?;
    let folder_live = have
        .folder
        .as_ref()
        .is_none_or(|f| view.asset_folders().iter().any(|x| &x.id == f));
    // Restoring a file whose folder is in Recently Deleted brings it back
    // to the top of the library (its folder cannot hold it now).
    let to_top = !trashed && !folder_live;
    if have.is_trashed() == trashed && !to_top {
        cx.undo_nothing();
        return Ok(Done { id: input.id });
    }
    let stamp = trashed.then(now);
    let end = to_top.then(|| end_of_folder(&slot, None, Some(&id)));
    let id2 = id.clone();
    let replaced = rec(CollectionV3::Assets, &id);
    let (_, at) = cx.write_book_v3(&slot, Replaces::records([replaced]), move |txn| {
        let w = txn.asset(&id2)?;
        // Trashed or restored on its own: no folder's restore takes it.
        w.deleted_at(stamp)?.trashed_with(None)?;
        if to_top {
            w.folder(None)?.pos(end.as_ref())?;
        }
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
    "Restore a trashed asset from Recently Deleted back into the asset library (to the top when its folder is in Recently Deleted).",
    fn(cx, input: EntityIn) -> Done {
        set_asset_trashed(cx, input, false)
    }
}

/// Purge `files` (records, the relations to them, the image fields holding
/// them, this book's bytes) and the folders `folders`, in one commit.
fn purge_files(
    cx: &Cx<'_>,
    slot: &BookSlot,
    files: &[Asset],
    folders: &[AssetFolderId],
) -> Result<()> {
    let mut rels = Vec::new();
    let mut fields = Vec::new();
    let mut replaced = Vec::new();
    for a in files {
        let target = EntityRef::new(EntityKind::Asset, a.id.to_string());
        rels.extend(purge_fallout(slot, &target).0);
        // Image fields holding the file are cleared: no value is left
        // pointing at bytes that are gone.
        fields.extend(image_field_values(slot, &a.id));
        replaced.push(rec(CollectionV3::Assets, &a.id));
    }
    rels.sort();
    rels.dedup();
    replaced.extend(fields.iter().map(|(entry, module, field)| {
        rec(CollectionV3::Entries, entry).at(["fields", module.as_str(), field.as_str()])
    }));
    replaced.extend(folders.iter().map(|f| rec(CollectionV3::AssetFolders, f)));
    let ids: Vec<AssetId> = files.iter().map(|a| a.id.clone()).collect();
    let (rels2, fields2, folders2) = (rels.clone(), fields.clone(), folders.to_vec());
    cx.write_book_v3(slot, Replaces::records(replaced), move |txn| {
        for r in &rels2 {
            txn.purge(CollectionV3::Relations, r.as_str())?;
        }
        for (entry, module, field) in &fields2 {
            txn.entries().entry(entry)?.set_field(module, field, None)?;
        }
        for id in &ids {
            txn.purge(CollectionV3::Assets, id.as_str())?;
        }
        for f in &folders2 {
            txn.purge(CollectionV3::AssetFolders, f.as_str())?;
        }
        Ok(())
    })?;
    let library = cx.workspace().library();
    for a in files {
        // Only this book's bytes: a record that arrived from elsewhere under
        // another book's id never deletes that book's file.
        library.remove_book_asset(slot.book.as_str(), a.id.as_str())?;
        // Steps whose undo would bring the record back now have nothing to
        // bring back: Undo passes over them.
        cx.workspace()
            .inner
            .journal
            .forget_record(slot.book.as_str(), "assets", a.id.as_str())?;
    }
    for f in folders {
        cx.workspace().inner.journal.forget_record(
            slot.book.as_str(),
            "asset_folders",
            f.as_str(),
        )?;
    }
    for (entry, _, _) in &fields {
        cx.effect(EffectAction::Updated, "entry", entry.as_str(), None);
    }
    for r in &rels {
        cx.effect(EffectAction::Purged, "relation", r.as_str(), None);
    }
    for a in files {
        cx.effect(
            EffectAction::Purged,
            "asset",
            a.id.as_str(),
            (!a.name.is_empty()).then_some(a.name.as_str()),
        );
    }
    for f in folders {
        cx.effect(EffectAction::Purged, "asset_folder", f.as_str(), None);
    }
    cx.irreversible();
    Ok(())
}

op! {
    AssetPurge = "asset.purge", Write, Book,
    "Permanently purge a trashed asset from the book manifest and delete its stored bytes.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let id: AssetId = pid("asset", &input.id)?;
        let view = slot.reader_v3.view();
        let have = view
            .asset_raw(&id)
            .ok_or_else(|| WsError::not_found("asset", &input.id))?;
        if view.asset(&id).is_some() {
            return Err(WsError::invalid("asset must be trashed before purge"));
        }
        purge_files(cx, &slot, &[have], &[])?;
        Ok(Done { id: input.id })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AssetMoveIn {
    pub book: String,
    pub id: String,
    /// The folder to put the file in (a live folder id); `null`: the top of
    /// the library.
    #[serde(default)]
    pub folder: Option<String>,
    /// Its place among that folder's files (0 first); omitted: last.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<usize>,
}

/// The position for something put at `index` among `siblings` (sorted, the
/// moved one left out); `None` index: after the last.
fn pos_at(siblings: &[Option<PosKey>], index: Option<usize>) -> PosKey {
    let i = index.unwrap_or(siblings.len()).min(siblings.len());
    let before = i.checked_sub(1).and_then(|j| siblings[j].clone());
    let after = siblings.get(i).cloned().flatten();
    PosKey::between(before.as_ref(), after.as_ref())
        .or_else(|_| PosKey::between(before.as_ref(), None))
        .unwrap_or_else(|_| PosKey::first())
}

op! {
    AssetMove = "asset.move", Write, Book,
    "Put a file of the asset library into another folder (or the top) and/or at another place among that folder's files (manual order).",
    fn(cx, input: AssetMoveIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let id: AssetId = pid("asset", &input.id)?;
        let view = slot.reader_v3.view();
        let have = view.asset(&id).ok_or_else(|| WsError::not_found("asset", &input.id))?;
        let folder = live_folder(&slot, input.folder.as_deref())?;
        let mut siblings: Vec<Asset> = view
            .assets()
            .into_iter()
            .filter(|a| a.folder == folder && a.id != id)
            .collect();
        siblings.sort_by(|a, b| {
            dr_model::pos::cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id))
        });
        let pos = pos_at(&siblings.iter().map(|a| a.pos.clone()).collect::<Vec<_>>(), input.index);
        if have.folder == folder && have.pos.as_ref() == Some(&pos) {
            cx.undo_nothing();
            return Ok(Done { id: input.id });
        }
        let id2 = id.clone();
        let replaced = rec(CollectionV3::Assets, &id);
        let (_, at) = cx.write_book_v3(&slot, Replaces::records([replaced]), move |txn| {
            txn.asset(&id2)?.folder(folder.as_ref())?.pos(Some(&pos))?;
            Ok(())
        })?;
        v3::undo(cx, &slot, &at, vec![v3::key("assets", &id)]);
        cx.effect(EffectAction::Updated, "asset", &input.id, None);
        Ok(Done { id: input.id })
    }
}

/// One folder of the asset library.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct AssetFolderInfo {
    pub id: String,
    pub name: String,
    pub parent: Option<String>,
    pub pos: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AssetFolderCreateIn {
    pub book: String,
    pub name: String,
    /// The folder it goes in (a live folder id); omitted: the top.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}

/// The live sub-folders of `parent`, in manual order (`without` aside).
fn sibling_folders(
    slot: &BookSlot,
    parent: Option<&AssetFolderId>,
    without: Option<&AssetFolderId>,
) -> Vec<dr_model::shared::AssetFolder> {
    slot.reader_v3
        .view()
        .asset_folders()
        .into_iter()
        .filter(|f| f.parent.as_ref() == parent && Some(&f.id) != without)
        .collect()
}

op! {
    AssetFolderCreate = "asset_folder.create", Write, Book,
    "Make a folder (素材夹) in the asset library, last among the folders of its parent (or the top).",
    fn(cx, input: AssetFolderCreateIn) -> Named {
        let slot = cx.book_v3(&input.book)?;
        name_ok(&input.name)?;
        let name = input.name.trim().to_owned();
        let parent = live_folder(&slot, input.parent.as_deref())?;
        let siblings = sibling_folders(&slot, parent.as_ref(), None);
        let pos = pos_at(&siblings.iter().map(|f| f.pos.clone()).collect::<Vec<_>>(), None);
        let id = AssetFolderId::parse(&dr_model::id::new_uuid_v7()).expect("uuid");
        let (id2, name2) = (id.clone(), name.clone());
        let (_, at) = cx.write_book_v3(&slot, Replaces::nothing(), move |txn| {
            txn.asset_folder(&id2)?
                .name(&name2)?
                .parent(parent.as_ref())?
                .pos(Some(&pos))?;
            Ok(())
        })?;
        v3::undo(cx, &slot, &at, vec![v3::key("asset_folders", &id)]);
        cx.effect(EffectAction::Created, "asset_folder", id.as_str(), Some(&name));
        Ok(Named { id: id.to_string(), name })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AssetFolderRenameIn {
    pub book: String,
    pub id: String,
    pub name: String,
}

op! {
    AssetFolderRename = "asset_folder.rename", Write, Book,
    "Rename a folder of the asset library.",
    fn(cx, input: AssetFolderRenameIn) -> Named {
        let slot = cx.book_v3(&input.book)?;
        name_ok(&input.name)?;
        let id: AssetFolderId = pid("asset folder", &input.id)?;
        let have = slot
            .reader_v3
            .view()
            .asset_folder_raw(&id)
            .filter(|f| !f.is_trashed())
            .ok_or_else(|| WsError::not_found("asset folder", &input.id))?;
        let name = input.name.trim().to_owned();
        if have.name == name {
            cx.undo_nothing();
            return Ok(Named { id: input.id, name });
        }
        let (id2, name2) = (id.clone(), name.clone());
        let replaced = rec(CollectionV3::AssetFolders, &id).at(["name"]);
        let (_, at) = cx.write_book_v3(&slot, Replaces::records([replaced]), move |txn| {
            txn.asset_folder(&id2)?.name(&name2)?;
            Ok(())
        })?;
        v3::undo(cx, &slot, &at, vec![v3::key("asset_folders", &id)]);
        cx.effect(EffectAction::Updated, "asset_folder", &input.id, Some(&name));
        Ok(Named { id: input.id, name })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AssetFolderMoveIn {
    pub book: String,
    pub id: String,
    /// The folder it goes in (a live folder id); `null`: the top.
    #[serde(default)]
    pub parent: Option<String>,
    /// Its place among that folder's folders (0 first); omitted: last.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<usize>,
}

op! {
    AssetFolderMove = "asset_folder.move", Write, Book,
    "Put a folder of the asset library into another folder (or the top) and/or at another place among its siblings; a folder never goes into itself or below itself.",
    fn(cx, input: AssetFolderMoveIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let id: AssetFolderId = pid("asset folder", &input.id)?;
        let view = slot.reader_v3.view();
        let have = view
            .asset_folders()
            .into_iter()
            .find(|f| f.id == id)
            .ok_or_else(|| WsError::not_found("asset folder", &input.id))?;
        let parent = live_folder(&slot, input.parent.as_deref())?;
        let parents: BTreeMap<AssetFolderId, Option<AssetFolderId>> = view
            .asset_folders_raw()
            .into_iter()
            .map(|f| (f.id, f.parent))
            .collect();
        dr_model::v3::check_asset_folder_parent(&parents, &id, parent.as_ref())?;
        let siblings = sibling_folders(&slot, parent.as_ref(), Some(&id));
        let pos = pos_at(&siblings.iter().map(|f| f.pos.clone()).collect::<Vec<_>>(), input.index);
        if have.parent == parent && have.pos.as_ref() == Some(&pos) {
            cx.undo_nothing();
            return Ok(Done { id: input.id });
        }
        let id2 = id.clone();
        let replaced = rec(CollectionV3::AssetFolders, &id);
        let (_, at) = cx.write_book_v3(&slot, Replaces::records([replaced]), move |txn| {
            txn.asset_folder(&id2)?.parent(parent.as_ref())?.pos(Some(&pos))?;
            Ok(())
        })?;
        v3::undo(cx, &slot, &at, vec![v3::key("asset_folders", &id)]);
        cx.effect(EffectAction::Updated, "asset_folder", &input.id, None);
        Ok(Done { id: input.id })
    }
}

/// `root` and every folder under it, and the files in any of them.
fn folder_contents(
    slot: &BookSlot,
    root: &AssetFolderId,
) -> (Vec<dr_model::shared::AssetFolder>, Vec<Asset>) {
    let view = slot.reader_v3.view();
    let all = view.asset_folders_raw();
    let mut inside: BTreeSet<AssetFolderId> = BTreeSet::from([root.clone()]);
    loop {
        let before = inside.len();
        for f in &all {
            if f.parent.as_ref().is_some_and(|p| inside.contains(p)) {
                inside.insert(f.id.clone());
            }
        }
        if inside.len() == before {
            break;
        }
    }
    let folders = all.into_iter().filter(|f| inside.contains(&f.id)).collect();
    let files = view
        .assets_raw()
        .into_iter()
        .filter(|a| a.folder.as_ref().is_some_and(|f| inside.contains(f)))
        .collect();
    (folders, files)
}

fn history_keys(
    folders: &[dr_model::shared::AssetFolder],
    files: &[Asset],
) -> Vec<v3::history::Key> {
    folders
        .iter()
        .map(|f| v3::key("asset_folders", &f.id))
        .chain(files.iter().map(|a| v3::key("assets", &a.id)))
        .collect()
}

op! {
    AssetFolderTrash = "asset_folder.trash", Write, Book,
    "Move a folder of the asset library to Recently Deleted with everything in it (its files and folders), in one step: places using those files read as placeholders.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let id: AssetFolderId = pid("asset folder", &input.id)?;
        let have = slot
            .reader_v3
            .view()
            .asset_folder_raw(&id)
            .ok_or_else(|| WsError::not_found("asset folder", &input.id))?;
        if have.is_trashed() {
            cx.undo_nothing();
            return Ok(Done { id: input.id });
        }
        let (folders, files) = folder_contents(&slot, &id);
        // What is already in Recently Deleted stays as it is; the rest goes
        // with the folder, marked so (`trashed_with`), which is how
        // restoring the folder knows it.
        let folders: Vec<_> = folders.into_iter().filter(|f| !f.is_trashed()).collect();
        let files: Vec<_> = files.into_iter().filter(|a| !a.is_trashed()).collect();
        let stamp = now();
        let root = id.clone();
        let replaced: Vec<_> = folders
            .iter()
            .map(|f| rec(CollectionV3::AssetFolders, &f.id))
            .chain(files.iter().map(|a| rec(CollectionV3::Assets, &a.id)))
            .collect();
        let (f2, a2) = (folders.clone(), files.clone());
        let (_, at) = cx.write_book_v3(&slot, Replaces::records(replaced), move |txn| {
            for f in &f2 {
                let with = (f.id != root).then_some(&root);
                txn.asset_folder(&f.id)?
                    .deleted_at(Some(stamp))?
                    .trashed_with(with)?;
            }
            for a in &a2 {
                txn.asset(&a.id)?.deleted_at(Some(stamp))?.trashed_with(Some(&root))?;
            }
            Ok(())
        })?;
        v3::undo(cx, &slot, &at, history_keys(&folders, &files));
        cx.effect(EffectAction::Trashed, "asset_folder", &input.id, Some(&have.name));
        Ok(Done { id: input.id })
    }
}

op! {
    AssetFolderRestore = "asset_folder.restore", Write, Book,
    "Bring a folder of the asset library back from Recently Deleted with what went there with it (to the top when its parent is still in Recently Deleted).",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let id: AssetFolderId = pid("asset folder", &input.id)?;
        let view = slot.reader_v3.view();
        let have = view
            .asset_folder_raw(&id)
            .ok_or_else(|| WsError::not_found("asset folder", &input.id))?;
        if !have.is_trashed() {
            cx.undo_nothing();
            return Ok(Done { id: input.id });
        }
        // What went to Recently Deleted with it: the folders and files under
        // it marked with the folder whose trashing took them (this one, or
        // the folder above that took this one too). What was trashed on its
        // own stays there.
        let group = have.trashed_with.clone().unwrap_or_else(|| id.clone());
        let (folders, files) = folder_contents(&slot, &id);
        let folders: Vec<_> = folders
            .into_iter()
            .filter(|f| f.id == id || f.trashed_with.as_ref() == Some(&group))
            .collect();
        let files: Vec<_> = files
            .into_iter()
            .filter(|a| a.is_trashed() && a.trashed_with.as_ref() == Some(&group))
            .collect();
        // Its parent cannot hold it while that is in Recently Deleted.
        let parent_gone = have.parent.as_ref().is_some_and(|p| {
            !view.asset_folders().iter().any(|f| &f.id == p)
        });
        let top_pos = parent_gone.then(|| {
            let siblings = sibling_folders(&slot, None, Some(&id));
            pos_at(&siblings.iter().map(|f| f.pos.clone()).collect::<Vec<_>>(), None)
        });
        let replaced: Vec<_> = folders
            .iter()
            .map(|f| rec(CollectionV3::AssetFolders, &f.id))
            .chain(files.iter().map(|a| rec(CollectionV3::Assets, &a.id)))
            .collect();
        let (f2, a2, id2) = (folders.clone(), files.clone(), id.clone());
        let (_, at) = cx.write_book_v3(&slot, Replaces::records(replaced), move |txn| {
            for f in &f2 {
                txn.asset_folder(&f.id)?.deleted_at(None)?.trashed_with(None)?;
            }
            for a in &a2 {
                txn.asset(&a.id)?.deleted_at(None)?.trashed_with(None)?;
            }
            if let Some(pos) = &top_pos {
                txn.asset_folder(&id2)?.parent(None)?.pos(Some(pos))?;
            }
            Ok(())
        })?;
        v3::undo(cx, &slot, &at, history_keys(&folders, &files));
        cx.effect(EffectAction::Restored, "asset_folder", &input.id, Some(&have.name));
        Ok(Done { id: input.id })
    }
}

op! {
    AssetFolderPurge = "asset_folder.purge", Write, Book,
    "Permanently purge a folder of the asset library that is in Recently Deleted, with every folder and file in it (their bytes are deleted).",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let id: AssetFolderId = pid("asset folder", &input.id)?;
        let view = slot.reader_v3.view();
        view.asset_folder_raw(&id)
            .ok_or_else(|| WsError::not_found("asset folder", &input.id))?;
        if view.asset_folders().iter().any(|f| f.id == id) {
            return Err(WsError::invalid("asset folder must be trashed before purge"));
        }
        let (folders, files) = folder_contents(&slot, &id);
        let folder_ids: Vec<AssetFolderId> = folders.into_iter().map(|f| f.id).collect();
        purge_files(cx, &slot, &files, &folder_ids)?;
        Ok(Done { id: input.id })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AssetFolderListIn {
    pub book: String,
    /// Include the folders in Recently Deleted.
    #[serde(default)]
    pub trashed: bool,
}

op! {
    AssetFolderList = "asset_folder.list", Read, Shared,
    "List the folders of the asset library, in manual order within each parent (with `trashed: true`, those in Recently Deleted too).",
    fn(cx, input: AssetFolderListIn) -> Vec<AssetFolderInfo> {
        let slot = cx.book_v3(&input.book)?;
        let view = slot.reader_v3.view();
        let list = if input.trashed { view.asset_folders_raw() } else { view.asset_folders() };
        Ok(list
            .into_iter()
            .map(|f| AssetFolderInfo {
                id: f.id.to_string(),
                name: f.name,
                parent: f.parent.map(|p| p.to_string()),
                pos: f.pos.map(|p| p.as_str().to_owned()),
                deleted_at: f.deleted_at.map(|t| t.0),
            })
            .collect())
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
    /// A link in a live entry's active `prose` module pointing at this file.
    Link {
        entry: String,
        module: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block: Option<String>,
    },
    /// An image field of a live entry's active `fields` module holding this file.
    Field {
        entry: String,
        module: String,
        field: String,
    },
    /// A relation where one end is this asset and the other end is live.
    Relation {
        relation: String,
        other: v3::content::Ref,
    },
}

/// `(module, field)` of every image field any template declares, by template.
pub(crate) fn image_fields(
    templates: &BTreeMap<dr_model::id::EntryTemplateId, dr_model::v3::EntryTemplate>,
) -> BTreeMap<String, BTreeSet<(String, String)>> {
    let mut out: BTreeMap<String, BTreeSet<(String, String)>> = BTreeMap::new();
    for t in templates.values() {
        for m in t.modules.iter().filter(|m| m.kind == ModuleKind::Fields) {
            for d in &m.config.defs {
                if d.field_type == dr_model::v3::FieldType::Image {
                    out.entry(t.id.to_string())
                        .or_default()
                        .insert((m.id.to_string(), d.id.clone()));
                }
            }
        }
    }
    out
}

/// Every stored image field value (trashed entries and retained modules
/// included) that holds `asset`: `(entry, module, field)`.
fn image_field_values(
    slot: &BookSlot,
    asset: &AssetId,
) -> Vec<(dr_model::id::EntryId, dr_model::id::ModuleId, String)> {
    let view = slot.reader_v3.view();
    let templates = view.templates_map();
    let any_image: BTreeSet<(String, String)> =
        image_fields(&templates).into_values().flatten().collect();
    let mut out = Vec::new();
    for e in view.entries_raw() {
        for (module, values) in &e.fields {
            for (field, value) in values {
                if value.as_str() == Some(asset.as_str())
                    && any_image.contains(&(module.to_string(), field.clone()))
                {
                    out.push((e.id.clone(), module.clone(), field.clone()));
                }
            }
        }
    }
    out
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
    /// The asset-library folder it is in (absent: the top).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Its place among the files of its folder (manual order).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
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
            folder: a.folder.as_ref().map(ToString::to_string),
            pos: a.pos.as_ref().map(|p| p.as_str().to_owned()),
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
                if spec.kind == ModuleKind::Fields
                    && let Some(values) = e.fields.get(&spec.id)
                {
                    for def in &spec.config.defs {
                        if def.field_type == dr_model::v3::FieldType::Image
                            && let Some(Ok(aid)) = values
                                .get(&def.id)
                                .and_then(|v| v.as_str())
                                .map(AssetId::parse)
                        {
                            by_asset.entry(aid).or_default().push(AssetUsage::Field {
                                entry: e.id.to_string(),
                                module: spec.id.to_string(),
                                field: def.id.clone(),
                            });
                        }
                    }
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
        let link = r.kind == dr_store::index::RefKind::Link;
        if !(r.kind == dr_store::index::RefKind::Embed || link)
            || r.target_kind != "asset"
            || r.count == 0
        {
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
            let (entry, module, block) = (
                r.source_entry.clone(),
                r.source_module.clone(),
                block.clone(),
            );
            list.push(if link {
                AssetUsage::Link {
                    entry,
                    module,
                    block,
                }
            } else {
                AssetUsage::Embed {
                    entry,
                    module,
                    block,
                }
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

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AssetGetIn {
    pub book: String,
    pub id: String,
    /// List where the file is used (the default). `false` reads only the
    /// record: a caller showing one embedded file does not pay for scanning
    /// every entry and prose index of the book, and `usages` comes back empty.
    #[serde(default = "yes")]
    pub usages: bool,
}

op! {
    AssetGet = "asset.get", Read, Shared,
    "Read an asset's metadata and live usages in the book (`usages: false` reads the record alone).",
    fn(cx, input: AssetGetIn) -> AssetInfo {
        let slot = cx.book(&input.book)?;
        let id: AssetId = pid("asset", &input.id)?;
        let a = slot
            .reader_v3
            .view()
            .asset_raw(&id)
            .ok_or_else(|| WsError::not_found("asset", input.id.clone()))?;
        if !input.usages {
            return Ok(AssetInfo::from_asset(&a, Vec::new()));
        }
        let mut usages = compute_usages(cx, &slot)?;
        Ok(AssetInfo::from_asset(&a, usages.remove(&a.id).unwrap_or_default()))
    }
}

op! {
    AssetList = "asset.list", Read, Shared,
    "List assets in the project's built-in asset library (sorted by asset id), each with its folder, its place in it and its live usages (media modules, prose embeds and links, image fields, relations). Set `trashed: true` to include Recently Deleted.",
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
