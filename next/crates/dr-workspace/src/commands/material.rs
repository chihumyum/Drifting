//! Materials (素材) metadata, material folders (素材夹) and asset metadata.

use dr_doc::book::Collection;
use dr_model::DocId;
use dr_model::book::{Asset, EntityRef};
use dr_model::id::{AssetId, MaterialFolderId, MaterialId};
use dr_model::kind::{AssetKind, EntityKind, MaterialKind};
use dr_model::pos::PosKey;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::dto::{GroupInfo, MaterialInfo};
use crate::naming::{Place, pos_for};
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<MaterialList>()
        .add::<MaterialCreate>()
        .add::<MaterialUpdate>()
        .add::<MaterialMove>()
        .add::<MaterialDelete>()
        .add::<FolderList>()
        .add::<FolderCreate>()
        .add::<FolderUpdate>()
        .add::<FolderDelete>()
        .add::<AssetPut>()
        .add::<AssetGet>();
}

fn find(slot: &BookSlot, id: &str) -> Result<dr_model::book::Material> {
    materials(slot)
        .iter()
        .find(|m| m.id.as_str() == id)
        .cloned()
        .ok_or_else(|| WsError::not_found("material", id))
}

fn folder_exists(slot: &BookSlot, id: &str) -> Result<MaterialFolderId> {
    let f: MaterialFolderId = pid("material folder", id)?;
    if material_folders(slot).iter().any(|x| x.id == f) {
        Ok(f)
    } else {
        Err(WsError::not_found("material folder", id))
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct MaterialListIn {
    pub book: String,
    /// Only this folder's materials (`""`: at the top level).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

op! {
    MaterialList = "material.list", Read, Shared,
    "List materials in order, optionally of one folder.",
    fn(cx, input: MaterialListIn) -> Vec<MaterialInfo> {
        let slot = cx.book(&input.book)?;
        Ok(materials(&slot).iter().filter(|m| match input.folder.as_deref() {
            None => true,
            Some("") => m.folder.is_none(),
            Some(f) => m.folder.as_ref().map(|x| x.as_str()) == Some(f),
        }).map(MaterialInfo::from).collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MaterialCreateIn {
    pub book: String,
    /// `text`, `image` or `pdf`.
    pub kind: String,
    #[serde(default)]
    pub title: String,
    /// The asset of an image or PDF material (registered with `asset.put`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
    #[serde(default)]
    pub description: String,
    /// A text material's note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

op! {
    MaterialCreate = "material.create", Write, Book,
    "Add a material: a text note, or an image or PDF whose asset is registered.",
    fn(cx, input: MaterialCreateIn) -> Named {
        let slot = cx.book(&input.book)?;
        let kind = MaterialKind::parse(&input.kind);
        let asset: Option<Asset> = match &input.asset {
            Some(a) => {
                let id: AssetId = pid("asset", a)?;
                Some(assets(&slot).iter().find(|x| x.id == id).cloned().ok_or_else(|| WsError::not_found("asset", a))?)
            }
            None => None,
        };
        dr_model::check::material_payload(&kind, asset.as_ref())?;
        if input.text.is_some() && kind != MaterialKind::Text {
            return Err(WsError::invalid("only a text material has a note"));
        }
        let folder = input.folder.as_deref().map(|f| folder_exists(&slot, f)).transpose()?;
        let items: Vec<(String, Option<PosKey>)> = materials(&slot).iter().map(|m| (m.id.to_string(), m.pos.clone())).collect();
        let pos = pos_for(&items, input.place.as_ref().unwrap_or(&Place::Last))?;
        let id = MaterialId::new_v7();
        let title = match input.title.trim() { "" => "Untitled".to_string(), t => t.to_string() };
        if kind == MaterialKind::Text {
            super::chapter::seed_prose(cx, &slot.book, &DocId::Material(id.clone()), input.text.as_deref())?;
        }
        let (i2, t2, d2) = (id.clone(), title.clone(), input.description.clone());
        let asset_id = asset.map(|a| a.id);
        cx.write_book(&slot, move |txn| {
            let w = txn.material(&i2)?;
            w.title(&t2)?.kind(&kind)?.asset(asset_id.as_ref())?.folder(folder.as_ref())?.pos(&pos)?.task_todos(true)?;
            if !d2.is_empty() { w.description(&d2)?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "material", id.as_str(), Some(&title));
        cx.undo_with(Invocation::new("material.delete", EntityIn { book: input.book, id: id.to_string() }));
        Ok(Named { id: id.to_string(), name: title })
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct MaterialUpdateIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Whether a text material's checklist items project into TODOs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_todos: Option<bool>,
    /// Move to this folder (`null`: the top level).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub folder: Option<Option<String>>,
}

op! {
    MaterialUpdate = "material.update", Write, Book,
    "Change a material's title, description, folder or TODO projection.",
    fn(cx, input: MaterialUpdateIn) -> Named {
        let slot = cx.book(&input.book)?;
        let old = find(&slot, &input.id)?;
        if let Some(t) = &input.title { name_ok(t)?; }
        let folder: Option<Option<MaterialFolderId>> = match &input.folder {
            Some(Some(f)) => Some(Some(folder_exists(&slot, f)?)),
            Some(None) => Some(None),
            None => None,
        };
        let (id, i, f2) = (old.id.clone(), input.clone(), folder.clone());
        cx.write_book(&slot, move |txn| {
            let w = txn.material(&id)?;
            if let Some(t) = &i.title { w.title(t.trim())?; }
            if let Some(d) = &i.description { w.description(d)?; }
            if let Some(t) = i.task_todos { w.task_todos(t)?; }
            if let Some(f) = &f2 { w.folder(f.as_ref())?; }
            Ok(())
        })?;
        let name = input.title.as_ref().map(|t| t.trim().to_string()).unwrap_or_else(|| old.title.clone());
        cx.effect(EffectAction::Updated, "material", &input.id, Some(&name));
        cx.undo_with(Invocation::new("material.update", MaterialUpdateIn {
            book: input.book.clone(), id: input.id.clone(),
            title: input.title.as_ref().map(|_| old.title.clone()),
            description: input.description.as_ref().map(|_| old.description.clone()),
            task_todos: input.task_todos.map(|_| old.task_todos),
            folder: folder.as_ref().map(|_| old.folder.as_ref().map(|f| f.to_string())),
        }));
        Ok(Named { id: input.id, name })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MaterialMoveIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
    /// An exact position key (undo uses it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
}

op! {
    MaterialMove = "material.move", Write, Book,
    "Move a material in the list (only its own position changes).",
    fn(cx, input: MaterialMoveIn) -> Done {
        let slot = cx.book(&input.book)?;
        let old = find(&slot, &input.id)?;
        let pos = match (&input.pos, &input.place) {
            (Some(p), _) => PosKey::parse(p).map_err(|e| WsError::invalid(e.to_string()))?,
            (None, Some(place)) => {
                let items: Vec<(String, Option<PosKey>)> = materials(&slot).iter().filter(|m| m.id != old.id)
                    .map(|m| (m.id.to_string(), m.pos.clone())).collect();
                pos_for(&items, place)?
            }
            (None, None) => return Err(WsError::invalid("give place or pos")),
        };
        let id = old.id.clone();
        cx.write_book(&slot, move |txn| { txn.material(&id)?.pos(&pos)?; Ok(()) })?;
        cx.effect(EffectAction::Moved, "material", &input.id, Some(&old.title));
        match old.pos {
            Some(p) => cx.undo_with(Invocation::new("material.move", MaterialMoveIn { book: input.book.clone(), id: input.id.clone(), place: None, pos: Some(p.to_string()) })),
            None => cx.irreversible(),
        }
        Ok(Done { id: input.id })
    }
}

op! {
    MaterialDelete = "material.delete", Write, Book,
    "Delete a material: its relations go and comments on it become floating, in one commit (its note stays in history; undo restores it).",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book(&input.book)?;
        let old = find(&slot, &input.id)?;
        let target = EntityRef::new(EntityKind::Material, input.id.clone());
        let (rels, cmts) = purge_fallout(&slot, &target);
        let mut touched: Vec<(String, String)> = vec![("materials".into(), input.id.clone())];
        touched.extend(rels.iter().map(|r| ("relations".to_string(), r.to_string())));
        touched.extend(cmts.iter().map(|c| ("comments".to_string(), c.to_string())));
        let (id, r2, c2) = (old.id.clone(), rels.clone(), cmts.clone());
        let (_, before) = cx.write_book(&slot, move |txn| {
            apply_fallout(txn, &r2, &c2)?;
            txn.purge(Collection::Materials, id.as_str())?;
            Ok(())
        })?;
        report_fallout(cx, &rels, &cmts);
        cx.effect(EffectAction::Purged, "material", &input.id, Some(&old.title));
        cx.undo_with(super::history::restore_invocation(&input.book, &before, touched));
        Ok(Done { id: input.id })
    }
}

// ---- folders ----------------------------------------------------------------

op! {
    FolderList = "material_folder.list", Read, Shared,
    "List material folders (素材夹), parents before children.",
    fn(cx, input: BookIn) -> Vec<GroupInfo> {
        let slot = cx.book(&input.book)?;
        Ok(material_folders(&slot).iter().map(|f| GroupInfo {
            id: f.id.to_string(), name: f.name.clone(), color: None, parent: f.parent.as_ref().map(|p| p.to_string()),
        }).collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct FolderCreateIn {
    pub book: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}

op! {
    FolderCreate = "material_folder.create", Write, Book,
    "Create a material folder.",
    fn(cx, input: FolderCreateIn) -> Named {
        let slot = cx.book(&input.book)?;
        name_ok(&input.name)?;
        let parent = input.parent.as_deref().map(|p| folder_exists(&slot, p)).transpose()?;
        let id = MaterialFolderId::new_v7();
        let (i2, n2) = (id.clone(), input.name.trim().to_string());
        cx.write_book(&slot, move |txn| {
            txn.material_folders().create(i2.as_str(), parent.as_ref().map(|p| p.as_str()), &n2)?;
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "material_folder", id.as_str(), Some(input.name.trim()));
        cx.undo_with(Invocation::new("material_folder.delete", EntityIn { book: input.book, id: id.to_string() }));
        Ok(Named { id: id.to_string(), name: input.name.trim().to_string() })
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct FolderUpdateIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub parent: Option<Option<String>>,
}

op! {
    FolderUpdate = "material_folder.update", Write, Book,
    "Rename or move a material folder.",
    fn(cx, input: FolderUpdateIn) -> Named {
        let slot = cx.book(&input.book)?;
        let me = folder_exists(&slot, &input.id)?;
        let folders = material_folders(&slot);
        let old = folders.iter().find(|f| f.id == me).cloned().expect("exists");
        if let Some(n) = &input.name { name_ok(n)?; }
        let parent: Option<Option<MaterialFolderId>> = match &input.parent {
            Some(Some(p)) => {
                let p = folder_exists(&slot, p)?;
                // Loro refuses a cycle; say so plainly first.
                let mut cur = Some(p.clone());
                while let Some(c) = cur {
                    if c == me { return Err(WsError::invalid("a folder cannot move into itself")); }
                    cur = folders.iter().find(|f| f.id == c).and_then(|f| f.parent.clone());
                }
                Some(Some(p))
            }
            Some(None) => Some(None),
            None => None,
        };
        let (i2, n2, p2) = (me.clone(), input.name.clone(), parent.clone());
        cx.write_book(&slot, move |txn| {
            let t = txn.material_folders();
            if let Some(n) = &n2 { t.rename(i2.as_str(), n.trim())?; }
            if let Some(p) = &p2 { t.move_to(i2.as_str(), p.as_ref().map(|p| p.as_str()))?; }
            Ok(())
        })?;
        let name = input.name.as_ref().map(|n| n.trim().to_string()).unwrap_or_else(|| old.name.clone());
        cx.effect(if parent.is_some() { EffectAction::Moved } else { EffectAction::Updated }, "material_folder", &input.id, Some(&name));
        cx.undo_with(Invocation::new("material_folder.update", FolderUpdateIn {
            book: input.book.clone(), id: input.id.clone(),
            name: input.name.as_ref().map(|_| old.name.clone()),
            parent: parent.as_ref().map(|_| old.parent.as_ref().map(|p| p.to_string())),
        }));
        Ok(Named { id: input.id, name })
    }
}

op! {
    FolderDelete = "material_folder.delete", Write, Book,
    "Delete a material folder: its sub-folders and materials move up to its parent.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book(&input.book)?;
        let me = folder_exists(&slot, &input.id)?;
        let children: Vec<String> = material_folders(&slot).iter().filter(|f| f.parent.as_ref() == Some(&me)).map(|f| f.id.to_string()).collect();
        let members: Vec<String> = materials(&slot).iter().filter(|m| m.folder.as_ref() == Some(&me)).map(|m| m.id.to_string()).collect();
        let mut touched: Vec<(String, String)> = vec![("material_folders".into(), input.id.clone())];
        touched.extend(children.iter().map(|c| ("material_folders".to_string(), c.clone())));
        touched.extend(members.iter().map(|m| ("materials".to_string(), m.clone())));
        let i2 = me.clone();
        let (_, before) = cx.write_book(&slot, move |txn| { txn.delete_material_folder(&i2)?; Ok(()) })?;
        for c in &children { cx.effect(EffectAction::Moved, "material_folder", c.as_str(), None); }
        for m in &members { cx.effect(EffectAction::Moved, "material", m.as_str(), None); }
        cx.effect(EffectAction::Purged, "material_folder", &input.id, None);
        cx.undo_with(super::history::restore_invocation(&input.book, &before, touched));
        Ok(Done { id: input.id })
    }
}

// ---- assets -------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AssetPutIn {
    pub book: String,
    /// The asset id the store imported the bytes under.
    pub id: String,
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
}

op! {
    AssetPut = "asset.put", Write, Book,
    "Record an imported asset's metadata in the book (written once; the bytes are in storage).",
    fn(cx, input: AssetPutIn) -> Done {
        let slot = cx.book(&input.book)?;
        let a = Asset {
            id: pid("asset", &input.id)?, kind: AssetKind::parse(&input.kind), mime: input.mime.clone(),
            size: input.size, sha256: input.sha256.clone(), width: input.width, height: input.height,
        };
        dr_model::check::asset_shape(&a)?;
        if let Some(have) = assets(&slot).iter().find(|x| x.id == a.id) {
            if have == &a { cx.undo_nothing(); return Ok(Done { id: input.id }); }
            return Err(WsError::Locked(format!("asset {} is already recorded differently", input.id)));
        }
        let a2 = a.clone();
        cx.write_book(&slot, move |txn| { txn.put_asset(&a2)?; Ok(()) })?;
        cx.effect(EffectAction::Created, "asset", &input.id, None);
        cx.irreversible();
        Ok(Done { id: input.id })
    }
}

/// An asset's recorded metadata.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct AssetInfo {
    pub id: String,
    /// `image` or `pdf`.
    pub kind: String,
    pub mime: String,
    /// Bytes.
    pub size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

op! {
    AssetGet = "asset.get", Read, Shared,
    "Read an asset's recorded metadata: kind, media type, size and pixel dimensions (the Stats tab's file readings).",
    fn(cx, input: EntityIn) -> AssetInfo {
        let slot = cx.book(&input.book)?;
        let a = assets(&slot).iter().find(|a| a.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("asset", input.id.clone()))?;
        Ok(AssetInfo {
            id: a.id.to_string(), kind: a.kind.as_str().to_owned(), mime: a.mime,
            size: a.size, width: a.width, height: a.height,
        })
    }
}
