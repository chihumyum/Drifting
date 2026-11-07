//! Books, project facts (项目设定) and Project Memory.

use dr_model::book::KvEntry;
use dr_model::id::{BlockId, BookId, KvEntryId, MemoryId};
use dr_model::kind::{MemoryKind, MemorySource, MemoryStatus};
use dr_model::pos::PosKey;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::dto::{BookInfo, FieldInfo, MemoryInfo, Target};
use crate::naming::{Place, pos_for};
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<BookCreate>()
        .add::<BookList>()
        .add::<BookGet>()
        .add::<BookUpdate>()
        .add::<BookTrash>()
        .add::<BookRestore>()
        .add::<BookShelf>()
        .add::<BookPurge>()
        .add::<BookPurgeExpired>()
        .add::<FactList>()
        .add::<FactPut>()
        .add::<FactRemove>()
        .add::<MemoryList>()
        .add::<MemoryAdd>()
        .add::<MemoryUpdate>()
        .add::<MemoryRemove>()
        .add::<MemoryRestore>();
}

// ---- books ----------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct BookCreateIn {
    pub name: String,
    #[serde(default)]
    pub summary: String,
}

op! {
    BookCreate = "book.create", Write, Library,
    "Create a book (its book document from the shared genesis) and return its id.",
    fn(cx, input: BookCreateIn) -> Named {
        name_ok(&input.name)?;
        let id = BookId::new_v7();
        let slot = cx.workspace().book_slot_or_create(&id)?;
        let name = input.name.trim().to_string();
        cx.summarize(format!("「{name}」"));
        let (n, s) = (name.clone(), input.summary.clone());
        cx.write_book(&slot, move |txn| {
            txn.meta().name(&n)?.summary(&s)?.created_at(Some(now()))?;
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "book", id.as_str(), Some(&name));
        cx.undo_with(Invocation::new("book.trash", BookIn { book: id.to_string() }));
        Ok(Named { id: id.to_string(), name })
    }
}

op! {
    BookList = "book.list", Read, Shared,
    "List the library's books (trashed ones when asked).",
    fn(cx, input: ListBooksIn) -> Vec<BookInfo> {
        let mut out = Vec::new();
        for d in cx.workspace().library().docs(None, Some("book"))? {
            let Some(id) = d.doc_id.strip_prefix("book:") else { continue };
            let slot = cx.workspace().book_slot(&super::pid("book", id)?)?;
            let m = meta(&slot);
            if m.deleted_at.is_none() || input.trashed {
                out.push(BookInfo::from(&*m));
            }
        }
        Ok(out)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ListBooksIn {
    #[serde(default)]
    pub trashed: bool,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct BookDetail {
    #[serde(flatten)]
    pub info: BookInfo,
    pub chapters: u32,
    pub ideas: u32,
    pub elements: u32,
    /// Words in the book's prose documents, from the derived index.
    pub words: u64,
}

op! {
    BookGet = "book.get", Read, Shared,
    "Read a book's name, summary, word targets and counts.",
    fn(cx, input: BookIn) -> BookDetail {
        let slot = cx.book(&input.book)?;
        let m = meta(&slot);
        let n = nodes(&slot);
        let stats = cx.workspace().library().book_stats(&input.book)?;
        Ok(BookDetail {
            info: BookInfo::from(&*m),
            chapters: n.values().filter(|n| n.is_chapter() && !n.is_trashed()).count() as u32,
            ideas: n.values().filter(|n| n.is_drift() && !n.is_trashed()).count() as u32,
            elements: elements(&slot).iter().filter(|e| e.deleted_at.is_none()).count() as u32,
            words: stats.words,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct BookUpdateIn {
    pub book: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// The book's word target; 0 turns it off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub word_target: Option<i64>,
    /// Words per day; 0 turns it off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_word_target: Option<i64>,
}

op! {
    BookUpdate = "book.update", Write, Book,
    "Change a book's name, summary or word targets.",
    fn(cx, input: BookUpdateIn) -> Done {
        let slot = cx.book(&input.book)?;
        if let Some(n) = &input.name { name_ok(n)?; }
        for t in [input.word_target, input.daily_word_target].into_iter().flatten() {
            if t < 0 { return Err(WsError::invalid("a word target cannot be negative")); }
        }
        let m = meta(&slot);
        let old = BookUpdateIn {
            book: input.book.clone(),
            name: input.name.as_ref().map(|_| m.name.clone()),
            summary: input.summary.as_ref().map(|_| m.summary.clone()),
            word_target: input.word_target.map(|_| m.word_target_set.unwrap_or(dr_model::book::DEFAULT_WORD_TARGET)),
            daily_word_target: input.daily_word_target.map(|_| m.daily_word_target_set.unwrap_or(dr_model::book::DEFAULT_DAILY_WORD_TARGET)),
        };
        let i = input.clone();
        cx.write_book(&slot, move |txn| {
            let w = txn.meta();
            if let Some(n) = &i.name { w.name(n.trim())?; }
            if let Some(s) = &i.summary { w.summary(s)?; }
            if let Some(t) = i.word_target { w.word_target(Some(t))?; }
            if let Some(t) = i.daily_word_target { w.daily_word_target(Some(t))?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Updated, "book", &input.book, input.name.as_deref());
        cx.undo_with(Invocation::new("book.update", old));
        Ok(Done { id: input.book })
    }
}

op! {
    BookTrash = "book.trash", Write, Book,
    "Move a book to the trash (restorable; storage deletes it for good later).",
    fn(cx, input: BookIn) -> Done {
        let slot = cx.book(&input.book)?;
        cx.write_book(&slot, |txn| { txn.meta().deleted_at(Some(now()))?; Ok(()) })?;
        cx.effect(EffectAction::Trashed, "book", &input.book, Some(&meta(&slot).name));
        cx.undo_with(Invocation::new("book.restore", &input));
        Ok(Done { id: input.book })
    }
}

op! {
    BookRestore = "book.restore", Write, Book,
    "Bring a book back from the trash.",
    fn(cx, input: BookIn) -> Done {
        let slot = cx.book(&input.book)?;
        cx.write_book(&slot, |txn| { txn.meta().deleted_at(None)?; Ok(()) })?;
        cx.effect(EffectAction::Restored, "book", &input.book, Some(&meta(&slot).name));
        cx.undo_with(Invocation::new("book.trash", &input));
        Ok(Done { id: input.book })
    }
}

// ---- the shelf and the trash ---------------------------------------------------

/// Days a book stays in Recently Deleted before it goes for good (the 0.1
/// shelf's rule).
pub const BOOK_TRASH_DAYS: i64 = 30;

const DAY_SECS: i64 = 86_400;

/// One book as the bookshelf shows it.
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct ShelfBook {
    #[serde(flatten)]
    pub info: BookInfo,
    /// The 「副标题」 project fact, trimmed, when it has a value.
    pub subtitle: Option<String>,
    /// Live chapters, storylines and elements.
    pub chapters: u32,
    pub storylines: u32,
    pub elements: u32,
    /// Words in the live chapters only (not ideas, elements or notes), as
    /// the derived index counts them.
    pub words: u64,
    /// The newest stored change of any of its documents (Unix seconds).
    pub updated_at: Option<i64>,
    /// In Recently Deleted since (Unix seconds).
    pub deleted_at: Option<i64>,
    /// In Recently Deleted: when it goes for good (Unix seconds) …
    pub purge_at: Option<i64>,
    /// … and the whole days left until then, rounded up (0: due now).
    pub days_left: Option<i64>,
}

/// When a book trashed at `deleted_at` goes for good, and the days left at
/// `now` (all Unix seconds).
pub fn purge_due(deleted_at: i64, now: i64) -> (i64, i64) {
    let at = deleted_at + BOOK_TRASH_DAYS * DAY_SECS;
    let left = (at - now).max(0);
    (at, (left + DAY_SECS - 1) / DAY_SECS)
}

fn shelf_book(cx: &Cx<'_>, id: &BookId, now: i64) -> Result<ShelfBook> {
    let slot = cx.workspace().book_slot(id)?;
    let m = meta(&slot);
    let lib = cx.workspace().library();
    let chapters = chapters(&slot);
    let words = chapters
        .iter()
        .map(|c| prose_facts(lib, &dr_model::DocId::Node(c.id.clone()).to_string()).words)
        .sum();
    let mut docs: Vec<String> = lib
        .docs(Some(id.as_str()), None)?
        .into_iter()
        .map(|d| d.doc_id)
        .collect();
    docs.push(dr_model::DocId::Book(id.clone()).to_string());
    let updated_at = docs
        .iter()
        .filter_map(|d| prose_facts(lib, d).edited_at)
        .max();
    let deleted_at = m.deleted_at.map(|t| t.0);
    let due = deleted_at.map(|d| purge_due(d, now));
    Ok(ShelfBook {
        info: BookInfo::from(&*m),
        subtitle: facts(&slot)
            .iter()
            .find(|f| f.key.trim() == "副标题")
            .map(|f| f.value.trim().to_string())
            .filter(|v| !v.is_empty()),
        chapters: chapters.len() as u32,
        storylines: storylines(&slot)
            .iter()
            .filter(|l| l.deleted_at.is_none())
            .count() as u32,
        elements: elements(&slot)
            .iter()
            .filter(|e| e.deleted_at.is_none())
            .count() as u32,
        words,
        updated_at,
        deleted_at,
        purge_at: due.map(|d| d.0),
        days_left: due.map(|d| d.1),
    })
}

op! {
    BookShelf = "book.shelf", Read, Shared,
    "Everything the bookshelf shows, in one read: every book with its counts, chapter words, creation, last change, and (in Recently Deleted) when it goes for good. Live books first, most recently changed first; then the trashed ones, most recently deleted first.",
    fn(cx, input: ListBooksIn) -> Vec<ShelfBook> {
        let now = now().0;
        let mut live = Vec::new();
        let mut trashed = Vec::new();
        for d in cx.workspace().library().docs(None, Some("book"))? {
            let Some(id) = d.doc_id.strip_prefix("book:") else { continue };
            let id: BookId = super::pid("book", id)?;
            match shelf_book(cx, &id, now) {
                Ok(b) if b.info.trashed => { if input.trashed { trashed.push(b) } }
                Ok(b) => live.push(b),
                // One unreadable book leaves the rest of the shelf.
                Err(e) => log::warn!("book {id} not on the shelf: {e}"),
            }
        }
        live.sort_by(|a, b| b.updated_at.cmp(&a.updated_at)
            .then_with(|| a.info.name.cmp(&b.info.name))
            .then_with(|| a.info.id.cmp(&b.info.id)));
        trashed.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at).then_with(|| a.info.id.cmp(&b.info.id)));
        live.extend(trashed);
        Ok(live)
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct BookPurged {
    pub id: String,
    /// Stored documents deleted (the book's and its prose).
    pub docs: usize,
    /// Asset files deleted.
    pub assets: usize,
}

op! {
    BookPurge = "book.purge", Write, Library,
    "Delete a book in Recently Deleted for good, now: its documents, history and assets on this device. Refused for a book not in the trash or still open in an editor. Cannot be undone.",
    fn(cx, input: BookIn) -> BookPurged {
        let id: BookId = super::pid("book", &input.book)?;
        let ws = cx.workspace();
        // No command may write the book meanwhile.
        let gate = ws.book_gate(&id);
        let _lease = gate.enter();
        let (name, trashed) = {
            let slot = ws.book_slot(&id)?;
            let m = meta(&slot);
            (m.name.clone(), m.deleted_at.is_some())
        };
        if !trashed {
            return Err(WsError::Conflict(format!("book {id} is not in Recently Deleted")));
        }
        let out = ws.purge_book(&id)?;
        cx.effect(EffectAction::Purged, "book", id.as_str(), Some(&name));
        cx.irreversible();
        Ok(BookPurged { id: input.book, docs: out.0, assets: out.1 })
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct ExpiredPurged {
    /// The books deleted for good.
    pub purged: Vec<String>,
    /// Books that were due but are in use; the next run tries again.
    pub waiting: Vec<String>,
}

op! {
    BookPurgeExpired = "book.purge_expired", Write, Library,
    "Delete for good every book whose 30 days in Recently Deleted are over (the shelf runs it a while after it opens, so a restore made on another device can arrive first). Cannot be undone.",
    fn(cx, input: NoInput) -> ExpiredPurged {
        let ws = cx.workspace();
        let now = now().0;
        let mut out = ExpiredPurged { purged: Vec::new(), waiting: Vec::new() };
        for d in ws.library().docs(None, Some("book"))? {
            let Some(id) = d.doc_id.strip_prefix("book:") else { continue };
            let id: BookId = super::pid("book", id)?;
            let gate = ws.book_gate(&id);
            let _lease = gate.enter();
            let (name, due) = {
                let slot = ws.book_slot(&id)?;
                let m = meta(&slot);
                (m.name.clone(), m.deleted_at.map(|t| purge_due(t.0, now).0))
            };
            if !due.is_some_and(|at| at <= now) { continue; }
            match ws.purge_book(&id) {
                Ok(_) => {
                    cx.effect(EffectAction::Purged, "book", id.as_str(), Some(&name));
                    out.purged.push(id.to_string());
                }
                Err(WsError::Conflict(_)) => out.waiting.push(id.to_string()),
                Err(e) => return Err(e),
            }
        }
        if !out.purged.is_empty() { cx.irreversible(); } else { cx.undo_nothing(); }
        Ok(out)
    }
}

// ---- project facts ----------------------------------------------------------

op! {
    FactList = "fact.list", Read, Shared,
    "List the book's project facts (项目设定), in order.",
    fn(cx, input: BookIn) -> Vec<FieldInfo> {
        let slot = cx.book(&input.book)?;
        Ok(facts(&slot).iter().map(FieldInfo::from).collect())
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
        let slot = cx.book(&input.book)?;
        name_ok(&input.key)?;
        let list = facts(&slot);
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
        cx.write_book(&slot, move |txn| { txn.put_fact(&e2)?; Ok(()) })?;
        match existing {
            Some(old) => {
                cx.effect(EffectAction::Updated, "fact", id.as_str(), Some(&entry.key));
                cx.undo_with(Invocation::new("fact.put", FactPutIn {
                    book: input.book.clone(), id: Some(id.to_string()), key: old.key, value: old.value,
                    place: None, pos: old.pos.map(|p| p.to_string()),
                }));
            }
            None => {
                cx.effect(EffectAction::Created, "fact", id.as_str(), Some(&entry.key));
                cx.undo_with(Invocation::new("fact.remove", EntityIn { book: input.book.clone(), id: id.to_string() }));
            }
        }
        Ok(Named { id: id.to_string(), name: entry.key })
    }
}

op! {
    FactRemove = "fact.remove", Write, Book,
    "Remove a project fact.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book(&input.book)?;
        let old = facts(&slot).iter().find(|f| f.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("fact", &input.id))?;
        let id = old.id.clone();
        cx.write_book(&slot, move |txn| { txn.remove_fact(&id)?; Ok(()) })?;
        cx.effect(EffectAction::Purged, "fact", &input.id, Some(&old.key));
        cx.undo_with(Invocation::new("fact.put", FactPutIn {
            book: input.book.clone(), id: None, key: old.key, value: old.value, place: None,
            pos: old.pos.map(|p| p.to_string()),
        }));
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
        let slot = cx.book(&input.book)?;
        Ok(memory(&slot).iter().filter(|m| input.removed || m.deleted_at.is_none())
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
        let slot = cx.book(&input.book)?;
        name_ok(&input.body)?;
        let kind = memory_kind(input.kind.as_deref())?;
        let target = input.target.as_ref().map(|t| t.to_ref());
        if let Some(t) = &target { require_live(&slot, t.kind.clone(), &t.id)?; }
        let block = input.target_block.as_deref().map(|b| pid::<BlockId>("block", b)).transpose()?;
        let id = MemoryId::new_v7();
        let source = if matches!(cx.actor(), crate::Actor::Agent { .. }) { MemorySource::Agent } else { MemorySource::Author };
        let (i2, body) = (id.clone(), input.body.clone());
        cx.write_book(&slot, move |txn| {
            txn.memory(&i2)?.kind(&kind)?.body(&body)?.target(target.as_ref())?
                .target_block(block.as_ref())?.source(&source)?.status(&MemoryStatus::Active)?;
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "memory", id.as_str(), None);
        cx.undo_with(Invocation::new("memory.remove", EntityIn { book: input.book, id: id.to_string() }));
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
        let slot = cx.book(&input.book)?;
        let old = memory(&slot).iter().find(|m| m.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("memory", &input.id))?;
        if let Some(b) = &input.body { name_ok(b)?; }
        let kind = input.kind.as_deref().map(|k| memory_kind(Some(k))).transpose()?;
        let status = input.status.as_deref().map(MemoryStatus::parse);
        if let Some(s) = &status && !s.is_known() {
            return Err(WsError::invalid(format!("unknown memory status {:?}", s.as_str())));
        }
        let (id, body) = (old.id.clone(), input.body.clone());
        cx.write_book(&slot, move |txn| {
            let w = txn.memory(&id)?;
            if let Some(b) = &body { w.body(b)?; }
            if let Some(k) = &kind { w.kind(k)?; }
            if let Some(s) = &status { w.status(s)?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Updated, "memory", &input.id, None);
        cx.undo_with(Invocation::new("memory.update", MemoryUpdateIn {
            book: input.book.clone(), id: input.id.clone(),
            body: input.body.as_ref().map(|_| old.body.clone()),
            kind: input.kind.as_ref().map(|_| old.kind.as_str().to_string()),
            status: input.status.as_ref().map(|_| old.status.as_str().to_string()),
        }));
        Ok(Done { id: input.id })
    }
}

fn memory_removed(cx: &Cx<'_>, input: &EntityIn, removed: bool) -> Result<Done> {
    let slot = cx.book(&input.book)?;
    let id: MemoryId = memory(&slot)
        .iter()
        .find(|m| m.id.as_str() == input.id)
        .map(|m| m.id.clone())
        .ok_or_else(|| WsError::not_found("memory", &input.id))?;
    let at = removed.then(now);
    cx.write_book(&slot, move |txn| {
        txn.memory(&id)?.deleted_at(at)?;
        Ok(())
    })?;
    if removed {
        cx.effect(EffectAction::Trashed, "memory", &input.id, None);
        cx.undo_with(Invocation::new("memory.restore", input));
    } else {
        cx.effect(EffectAction::Restored, "memory", &input.id, None);
        cx.undo_with(Invocation::new("memory.remove", input));
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
