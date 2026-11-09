//! V3 device-local navigation, preserving the entry's selected module.
use super::*;
use crate::commands::recent::RECENT_KEEP;
pub use crate::commands::recent::RecentListIn;
use crate::registry::Op;
use dr_store::{LocalChange, LocalChangeKind, StoreError};

// One book-owned row per book. The store purges it atomically with the book;
// the legacy ws/recent value is never parsed or rewritten here.
pub const SCOPE: &str = "ws-recent-v3";
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "RecentTargetV3")]
pub struct Target {
    /// entry or material.
    pub kind: String,
    pub id: String,
    /// The selected entry module; omit for the whole entry or a material.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "RecentEntryV3")]
pub struct RecentEntry {
    pub book: String,
    pub target: Target,
    pub used_ms: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "RecentTouchInV3")]
pub struct RecentTouchIn {
    pub book: String,
    pub target: Target,
}
fn decode(raw: Option<String>, book: &str) -> dr_store::Result<Vec<RecentEntry>> {
    let invalid = || StoreError::Invalid {
        what: "v3 recent pages",
        value: "unreadable state; left unchanged".into(),
    };
    let entries: Vec<RecentEntry> = raw
        .map(|r| serde_json::from_str(&r).map_err(|_| invalid()))
        .transpose()?
        .unwrap_or_default();
    if entries.iter().any(|e| e.book != book) {
        return Err(invalid());
    }
    Ok(entries)
}
fn live(cx: &Cx<'_>, slot: &BookSlot, target: &Target) -> Result<bool> {
    match target.kind.as_str() {
        "entry" => {
            let Ok(id) = EntryId::parse(&target.id) else {
                return Ok(false);
            };
            if slot
                .reader_v3
                .view()
                .entry(&id)
                .is_none_or(|e| e.is_trashed())
            {
                return Ok(false);
            }
            match &target.module {
                None => Ok(true),
                Some(module) => Ok(super::module::ModuleList::run(
                    cx,
                    EntityIn {
                        book: slot.book.to_string(),
                        id: target.id.clone(),
                    },
                )?
                .iter()
                .any(|m| &m.id == module)),
            }
        }
        "material" => Ok(target.module.is_none()
            && slot
                .reader_v3
                .view()
                .materials()
                .iter()
                .any(|m| m.id.as_str() == target.id)),
        _ => Ok(false),
    }
}
op! {
    RecentTouch = "recent.touch", Write, Book,
    "Record a v3 entry and optional module, or a material, on this device without an undo step.",
    fn(cx, input: RecentTouchIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        if let Some(module) = &input.target.module { let _: ModuleId = pid("module", module)?; }
        if !live(cx, &slot, &input.target)? {
            return Err(WsError::invalid("recent target is not a live v3 page or retained module"));
        }
        let used_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64).unwrap_or(0);
        let entry = RecentEntry {
            book: input.book.clone(), target: input.target.clone(), used_ms,
        };
        cx.workspace().library().local_write(|tx| {
            let mut all = decode(tx.get_state(SCOPE, &input.book)?, &input.book)?;
            all.retain(|e| e.target != entry.target);
            all.insert(0, entry);
            all.truncate(RECENT_KEEP);
            let value = serde_json::to_string(&all).expect("strings and integers serialize");
            tx.set_state(SCOPE, &input.book, &value, Some(&input.book))?;
            tx.changed(LocalChange::new("recent", &input.book, LocalChangeKind::Update));
            Ok(())
        })?;
        cx.undo_nothing();
        Ok(Done { id: input.target.id })
    }
}
op! {
    RecentList = "recent.list", Read, Shared,
    "List this device's live v3 pages, retaining each entry's selected module.",
    fn(cx, input: RecentListIn) -> Vec<RecentEntry> {
        let slot = cx.book_v3(&input.book)?;
        let all = decode(cx.workspace().library().local_get(SCOPE, &input.book)?, &input.book)?;
        let limit = input.limit.unwrap_or(RECENT_KEEP).clamp(1, RECENT_KEEP);
        let mut out = Vec::new();
        for e in all {
            if live(cx, &slot, &e.target)? { out.push(e); }
            if out.len() == limit { break; }
        }
        Ok(out)
    }
}
