//! Shared project facts and Project Memory on the canonical v3 catalog.
use super::*;
use crate::dto::{FieldInfo, MemoryInfo, Target};
use crate::naming::{Place, pos_for};
use dr_model::kind::{MemoryKind, MemorySource, MemoryStatus};
use dr_model::pos::PosKey;
use dr_model::shared::KvEntry;
pub(crate) fn register(r: &mut Registry) {
    r.add::<FactList>()
        .add::<FactPut>()
        .add::<FactRemove>()
        .add::<MemoryList>()
        .add::<MemoryAdd>()
        .add::<MemoryUpdate>()
        .add::<MemoryRemove>()
        .add::<MemoryRestore>();
}
// ---- project facts ----------------------------------------------------------

op! {
    FactList = "fact.list", Read, Shared,
    "List the book's project facts (项目设定), in order.",
    fn(cx, input: BookIn) -> Vec<FieldInfo> {
        let slot = cx.book_v3(&input.book)?;
        Ok(slot.reader_v3.view().facts().iter().map(FieldInfo::from).collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct FactPutIn {
    pub book: String,
    /// The fact to change; omitted: a new fact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub key: String,
    pub value: String,
    /// Where it goes (a new fact goes last by default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
    /// An exact position key (undo uses it); wins over `place`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
}

op! {
    FactPut = "fact.put", Write, Book,
    "Add a project fact or change one (key, value, position).",
    fn(cx, input: FactPutIn) -> Named {
        let slot = cx.book_v3(&input.book)?;
        name_ok(&input.key)?;
        let list = slot.reader_v3.view().facts();
        let existing = match &input.id {
            Some(id) => Some(list.iter().find(|f| f.id.as_str() == id)
                .cloned().ok_or_else(|| WsError::not_found("fact", id))?),
            None => None,
        };
        let id: KvEntryId = match &existing { Some(f) => f.id.clone(), None => KvEntryId::new_v7() };
        let others: Vec<(String, Option<PosKey>)> = list.iter()
            .filter(|f| f.id != id).map(|f| (f.id.to_string(), f.pos.clone())).collect();
        let pos = match (&input.pos, &input.place, &existing) {
            (Some(p), _, _) => Some(PosKey::parse(p).map_err(|e| WsError::invalid(e.to_string()))?),
            (None, Some(place), _) => Some(pos_for(&others, place)?),
            (None, None, Some(f)) => f.pos.clone(),
            (None, None, None) => Some(pos_for(&others, &Place::Last)?),
        };
        let entry = KvEntry { id: id.clone(), key: input.key.trim().to_string(), value: input.value.clone(), pos };
        let e2 = entry.clone();
        let (_,at)=cx.write_book_v3(&slot, move |txn| { txn.put_fact(&e2)?; Ok(()) })?;
        undo(cx,&slot,&at,vec![key("facts",&id)]);
        match existing {
            Some(_) => {
                cx.effect(EffectAction::Updated, "fact", id.as_str(), Some(&entry.key));

            }
            None => {
                cx.effect(EffectAction::Created, "fact", id.as_str(), Some(&entry.key));

            }
        }
        Ok(Named { id: id.to_string(), name: entry.key })
    }
}

op! {
    FactRemove = "fact.remove", Write, Book,
    "Remove a project fact.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let old = slot.reader_v3.view().facts().iter().find(|f| f.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("fact", &input.id))?;
        let id = old.id.clone();
        let (_,at)=cx.write_book_v3(&slot, move |txn| { txn.remove_fact(&id)?; Ok(()) })?;
        undo(cx,&slot,&at,vec![key("facts",&input.id)]);
        cx.effect(EffectAction::Purged, "fact", &input.id, Some(&old.key));

        Ok(Done { id: input.id })
    }
}

// ---- Project Memory -----------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct MemoryListIn {
    pub book: String,
    /// Include removed entries.
    #[serde(default)]
    pub removed: bool,
}

op! {
    MemoryList = "memory.list", Read, Shared,
    "List the book's Project Memory entries.",
    fn(cx, input: MemoryListIn) -> Vec<MemoryInfo> {
        let slot = cx.book_v3(&input.book)?;
        Ok(slot.reader_v3.view().memory().iter().filter(|m| input.removed || m.deleted_at.is_none())
            .map(MemoryInfo::from).collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MemoryAddIn {
    pub book: String,
    pub body: String,
    /// `preference`, `veto` or `directive` (default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_block: Option<String>,
}

fn memory_kind(k: Option<&str>) -> Result<MemoryKind> {
    let k = MemoryKind::parse(k.unwrap_or("directive"));
    if k.is_known() {
        Ok(k)
    } else {
        Err(WsError::invalid(format!(
            "unknown memory kind {:?}",
            k.as_str()
        )))
    }
}

op! {
    MemoryAdd = "memory.add", Write, Book,
    "Add a Project Memory entry (plain text; takes effect at once).",
    fn(cx, input: MemoryAddIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        name_ok(&input.body)?;
        let kind = memory_kind(input.kind.as_deref())?;
        let target = input.target.as_ref().map(|t| t.to_ref());
        if let Some(t) = &target && !slot.reader_v3.view().entity_exists(t) {return Err(WsError::not_found("memory target",&t.id));};
        let block = input.target_block.as_deref().map(|b| pid::<BlockId>("block", b)).transpose()?;
        let id = MemoryId::new_v7();
        let source = if matches!(cx.actor(), crate::Actor::Agent { .. }) { MemorySource::Agent } else { MemorySource::Author };
        let (i2, body) = (id.clone(), input.body.clone());
        let (_,at)=cx.write_book_v3(&slot, move |txn| {
            txn.memory(&i2)?.kind(&kind)?.body(&body)?.target(target.as_ref())?
                .target_block(block.as_ref())?.source(&source)?.status(&MemoryStatus::Active)?;
            Ok(())
        })?;
        undo(cx,&slot,&at,vec![key("memory",&id)]);
        cx.effect(EffectAction::Created, "memory", id.as_str(), None);

        Ok(Done { id: id.to_string() })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MemoryUpdateIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// `active` or `dismissed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

op! {
    MemoryUpdate = "memory.update", Write, Book,
    "Change a Project Memory entry's text, kind or status.",
    fn(cx, input: MemoryUpdateIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let old = slot.reader_v3.view().memory().iter().find(|m| m.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("memory", &input.id))?;
        if let Some(b) = &input.body { name_ok(b)?; }
        let kind = input.kind.as_deref().map(|k| memory_kind(Some(k))).transpose()?;
        let status = input.status.as_deref().map(MemoryStatus::parse);
        if let Some(s) = &status && !s.is_known() {
            return Err(WsError::invalid(format!("unknown memory status {:?}", s.as_str())));
        }
        let (id, body) = (old.id.clone(), input.body.clone());
        let (_,at)=cx.write_book_v3(&slot, move |txn| {
            let w = txn.memory(&id)?;
            if let Some(b) = &body { w.body(b)?; }
            if let Some(k) = &kind { w.kind(k)?; }
            if let Some(s) = &status { w.status(s)?; }
            Ok(())
        })?;
        undo(cx,&slot,&at,vec![key("memory",&input.id)]);
        cx.effect(EffectAction::Updated, "memory", &input.id, None);

        Ok(Done { id: input.id })
    }
}

fn memory_removed(cx: &Cx<'_>, input: &EntityIn, removed: bool) -> Result<Done> {
    let slot = cx.book_v3(&input.book)?;
    let id: MemoryId = slot
        .reader_v3
        .view()
        .memory()
        .iter()
        .find(|m| m.id.as_str() == input.id)
        .map(|m| m.id.clone())
        .ok_or_else(|| WsError::not_found("memory", &input.id))?;
    let at = removed.then(now);
    let (_, at) = cx.write_book_v3(&slot, move |txn| {
        txn.memory(&id)?.deleted_at(at)?;
        Ok(())
    })?;
    undo(cx, &slot, &at, vec![key("memory", &input.id)]);
    if removed {
        cx.effect(EffectAction::Trashed, "memory", &input.id, None);
    } else {
        cx.effect(EffectAction::Restored, "memory", &input.id, None);
    }
    Ok(Done {
        id: input.id.clone(),
    })
}

op! {
    MemoryRemove = "memory.remove", Write, Book,
    "Remove a Project Memory entry (kept as removed; restorable).",
    fn(cx, input: EntityIn) -> Done { memory_removed(cx, &input, true) }
}

op! {
    MemoryRestore = "memory.restore", Write, Book,
    "Bring back a removed Project Memory entry.",
    fn(cx, input: EntityIn) -> Done { memory_removed(cx, &input, false) }
}
