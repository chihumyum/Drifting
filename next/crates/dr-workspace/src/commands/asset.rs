//! Asset metadata (`assets` in the book document; bytes live in storage).

use dr_model::id::AssetId;
use dr_model::kind::AssetKind;
use dr_model::shared::Asset;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::EffectAction;
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<AssetPut>().add::<AssetGet>().add::<AssetList>();
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
}

op! {
    AssetPut = "asset.put", Write, Book,
    "Record an imported asset's metadata in the book (written once; the bytes are in storage).",
    fn(cx, input: AssetPutIn) -> Done {
        let slot = cx.book(&input.book)?;
        let a = Asset {
            id: pid::<AssetId>("asset", &input.id)?,
            name: input.name.trim().to_owned(),
            kind: AssetKind::parse(&input.kind),
            mime: input.mime.clone(),
            size: input.size,
            sha256: input.sha256.clone(),
            width: input.width,
            height: input.height,
        };
        dr_model::check::asset_shape(&a)?;
        if slot.is_v3()
            && let Some(stored) = cx.workspace().library().asset(a.id.as_str(), dr_store::asset::Variant::Source)?
            && (stored.book_id != slot.book.as_str() || stored.sha256 != a.sha256 || stored.size != a.size as u64)
        {
            return Err(WsError::invalid("asset bytes do not match this book's metadata"));
        }
        if let Some(have) = assets(&slot).iter().find(|x| x.id == a.id) {
            if !have.same_file(&a) {
                return Err(WsError::Locked(format!("asset {} is already recorded differently", input.id)));
            }
            if !have.name.is_empty() || a.name.is_empty() {
                cx.undo_nothing();
                return Ok(Done { id: input.id });
            }
            let a2 = a.clone();
            cx.write_book_v3(&slot, Replaces::nothing(), move |txn| {
                txn.put_asset(&a2)?;
                Ok(())
            })?;
            cx.effect(EffectAction::Updated, "asset", &input.id, None);
            cx.irreversible();
            return Ok(Done { id: input.id });
        }
        let a2 = a.clone();
        // Written once, under the id of its bytes.
        cx.write_book_v3(&slot, Replaces::nothing(), move |txn| {
            txn.put_asset(&a2)?;
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "asset", &input.id, None);
        cx.irreversible();
        Ok(Done { id: input.id })
    }
}

/// An asset's recorded metadata.
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
}

impl From<&Asset> for AssetInfo {
    fn from(a: &Asset) -> Self {
        Self {
            id: a.id.to_string(),
            name: a.name.clone(),
            kind: a.kind.as_str().to_owned(),
            mime: a.mime.clone(),
            size: a.size,
            sha256: a.sha256.clone(),
            width: a.width,
            height: a.height,
        }
    }
}

op! {
    AssetGet = "asset.get", Read, Shared,
    "Read an asset's recorded metadata: name, kind, media type, size, sha256 and pixel dimensions.",
    fn(cx, input: EntityIn) -> AssetInfo {
        let slot = cx.book(&input.book)?;
        let a = assets(&slot)
            .iter()
            .find(|a| a.id.as_str() == input.id)
            .cloned()
            .ok_or_else(|| WsError::not_found("asset", input.id.clone()))?;
        Ok(AssetInfo::from(&a))
    }
}

op! {
    AssetList = "asset.list", Read, Shared,
    "List every asset recorded in the book, sorted by asset id.",
    fn(cx, input: BookIn) -> Vec<AssetInfo> {
        let slot = cx.book(&input.book)?;
        Ok(assets(&slot).iter().map(AssetInfo::from).collect())
    }
}
