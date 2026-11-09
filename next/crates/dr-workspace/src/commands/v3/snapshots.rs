//! Complete entry checkpoints. Manifests live in the book document; all
//! versions refer to durable history, including every retained body document.
//! Restore is an opt-in atomic holder operation, never successive prose writes.
use super::*;
use crate::Actor;
use dr_doc::{prose::ProseReader, v3::BorrowedBookV3};
use dr_store::{DocHandle, Origin};
use loro::LoroDoc;
use serde_json::Value;

pub(crate) fn register(r: &mut Registry) {
    r.add::<Create>()
        .add::<List>()
        .add::<Preview>()
        .add::<Restore>();
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct EntryIn {
    pub book: String,
    pub entry: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PointIn {
    #[serde(flatten)]
    pub target: EntryIn,
    pub point: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RestoreIn {
    #[serde(flatten)]
    pub point: PointIn,
    /// Exact versions returned by preview. All current entry bodies and the
    /// book must match; a new/removed body or any intervening edit rejects all.
    pub expected: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Point {
    pub id: String,
    pub format: u32,
    pub book: String,
    pub entry: String,
    pub ts: i64,
    pub title: String,
    pub reason: String,
    pub book_version: String,
    pub bodies: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct BodyPreview {
    pub doc: String,
    pub text: String,
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct PreviewOut {
    pub point: Point,
    /// Complete raw metadata and records, including keys unknown to this build.
    pub metadata: BTreeMap<String, Value>,
    pub records: BTreeMap<String, BTreeMap<String, BTreeMap<String, Value>>>,
    /// The historical template, not the entry's current template definition.
    pub template: Option<types::EntryTemplate>,
    pub bodies: Vec<BodyPreview>,
    pub expected: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct Restored {
    pub before: String,
    pub versions: BTreeMap<String, String>,
}

fn book_doc(book: &str) -> String {
    format!("book:{book}")
}
fn point(v: &BookViewV3<'_>, input: &PointIn) -> Result<Point> {
    let value = v
        .entry_checkpoints()
        .into_iter()
        .find(|(id, _)| *id == input.point)
        .ok_or_else(|| WsError::not_found("entry checkpoint", &input.point))?
        .1;
    let p: Point = serde_json::from_str(&value).map_err(|e| WsError::invalid(e.to_string()))?;
    if p.format != 1
        || p.book != input.target.book
        || p.entry != input.target.entry
        || p.id != input.point
    {
        return Err(WsError::invalid("checkpoint format or owner mismatch"));
    }
    for id in p.bodies.keys() {
        if !matches!(DocId::parse(id), Ok(DocId::Body(b)) if b.entry().as_str() == p.entry) {
            return Err(WsError::invalid("checkpoint contains a foreign body"));
        }
    }
    Ok(p)
}
fn handles(cx: &Cx<'_>, s: &BookSlot, entry: &str) -> Result<Vec<DocHandle>> {
    let mut out = vec![s.handle.clone()];
    // Raw document inventory, not the current template's visible modules.
    for info in cx.workspace().library().docs(Some(s.book.as_str()), None)? {
        if let Ok(doc @ DocId::Body(_)) = DocId::parse(&info.doc_id)
            && matches!(&doc, DocId::Body(b) if b.entry().as_str() == entry)
        {
            out.push(cx.prose(&doc)?.handle.clone());
        }
    }
    Ok(out)
}
fn versions(docs: &BTreeMap<String, LoroDoc>) -> BTreeMap<String, String> {
    docs.iter()
        .map(|(id, d)| (id.clone(), frontiers_hex(&d.oplog_frontiers())))
        .collect()
}
fn make_point(docs: &BTreeMap<String, LoroDoc>, input: &EntryIn, reason: String) -> Result<Point> {
    let book: BookId = pid("book", &input.book)?;
    let b = BorrowedBookV3::new(&docs[&book_doc(&input.book)], &book)?;
    let e = b
        .view()
        .entry(&pid("entry", &input.entry)?)
        .ok_or_else(|| WsError::not_found("entry", &input.entry))?;
    let mut versions = versions(docs);
    let book_version = versions
        .remove(&book_doc(&input.book))
        .expect("book is reserved");
    Ok(Point {
        id: EntryId::new_v7().to_string(),
        format: 1,
        book: input.book.clone(),
        entry: input.entry.clone(),
        ts: now().0,
        title: e.title,
        reason,
        book_version,
        bodies: versions,
    })
}
fn save(doc: &LoroDoc, book: &BookId, p: &Point) -> Result<()> {
    BorrowedBookV3::new(doc, book)?.txn().put_entry_checkpoint(
        &p.id,
        &serde_json::to_string(p).map_err(|e| WsError::Internal(e.to_string()))?,
    )?;
    Ok(())
}

op! {
    Create="entry_snapshot.create",Write,Book,"Save a complete v3 entry checkpoint, including retained modules and all body versions. Call before an Agent writes the entry.",fn(cx,input:EntryIn)->Point {
        let s = cx.book_v3(&input.book)?;
        let e = s.reader_v3.view().entry(&pid("entry", &input.entry)?).ok_or_else(|| WsError::not_found("entry", &input.entry))?;
        // Materialize only missing default bodies, as opening the editor does.
        module::initialize(cx, &s, &e, &s.reader_v3.view().templates_map(), &BTreeMap::new())?;
        let hs = handles(cx, &s, &input.entry)?;
        let p = DocHandle::atomic(&hs, Origin::Command, |docs| -> Result<Point> {
            cx.check_atomic_guards(docs)?;
            let p = make_point(docs, &input, cx.actor().store_origin().to_string())?;
            save(&docs[&book_doc(&input.book)], &s.book, &p)?;
            Ok(p)
        })?;
        cx.undo_nothing();
        cx.follows_prose();
        Ok(p)
    }
}
op! {
    List="entry_snapshot.list",Read,Shared,"List complete checkpoints of one v3 entry, newest first.",fn(cx,input:EntryIn)->Vec<Point> {
        let s = cx.book_v3(&input.book)?;
        let mut out = Vec::new();
        for (id, _) in s.reader_v3.view().entry_checkpoints() {
            if let Ok(p) = point(&s.reader_v3.view(), &PointIn { target: input.clone(), point: id }) { out.push(p); }
        }
        out.sort_by(|a, b| b.ts.cmp(&a.ts).then(b.id.cmp(&a.id)));
        Ok(out)
    }
}
fn fields(s: &dr_doc::v3::EntrySnapshotV3) -> Result<BTreeMap<String, Value>> {
    s.keys()
        .into_iter()
        .map(|k| {
            let v =
                serde_json::to_value(s.field(&k)).map_err(|e| WsError::Internal(e.to_string()))?;
            Ok((k, v))
        })
        .collect()
}
fn load_point(cx: &Cx<'_>, p: &Point) -> Result<BTreeMap<String, LoroDoc>> {
    let lib = cx.workspace().library();
    let mut out = BTreeMap::new();
    for (id, version) in
        std::iter::once((book_doc(&p.book), p.book_version.clone())).chain(p.bodies.clone())
    {
        let info = lib
            .doc_info(&id)?
            .ok_or_else(|| WsError::not_found("checkpoint document", &id))?;
        if info.book_id.as_deref() != Some(&p.book) {
            return Err(WsError::invalid(
                "checkpoint document belongs to another book",
            ));
        }
        out.insert(
            id.clone(),
            lib.load_copy_at(&id, &frontiers_from_hex(&version)?)?,
        );
    }
    Ok(out)
}
op! {
    Preview="entry_snapshot.preview",Read,Shared,"Read all historical entry content and current version guards for an atomic restore.",fn(cx,input:PointIn)->PreviewOut {
        let s = cx.book_v3(&input.target.book)?;
        let p = point(&s.reader_v3.view(), &input)?;
        let old = load_point(cx, &p)?;
        let b = BorrowedBookV3::new(&old[&book_doc(&p.book)], &s.book)?;
        let view = b.view();
        let id: EntryId = pid("entry", &p.entry)?;
        let e = view.entry(&id).ok_or_else(|| WsError::not_found("checkpoint entry", &p.entry))?;
        let metadata = fields(&view.entry_snapshot(&id).expect("entry exists"))?;
        let mut records = BTreeMap::new();
        for (c, rows) in view.entry_owned_records(&id) {
            records.insert(c.root().to_string(), rows.into_iter().map(|(id, s)| Ok((id, fields(&s)?))).collect::<Result<_>>()?);
        }
        let mut bodies = Vec::new();
        for id in p.bodies.keys() {
            let doc = DocId::parse(id).map_err(|e| WsError::invalid(e.to_string()))?;
            bodies.push(BodyPreview { doc: id.clone(), text: dr_text::plain_text(&ProseReader::from_loro(doc, &old[id])?.view()) });
        }
        let hs = handles(cx, &s, &p.entry)?;
        let expected = DocHandle::atomic(&hs, Origin::Command, |docs| -> Result<_> { Ok(versions(docs)) })?;
        let template = e.effective_template(&view.templates_map()).cloned().map(convert).transpose()?;
        Ok(PreviewOut { point: p, metadata, records, template, bodies, expected })
    }
}

op! {
    Restore="entry_snapshot.restore",Write,Book,"Atomically restore all owned content of one entry with required version guards, preserving a complete pre-restore checkpoint.",fn(cx,input:RestoreIn)->Restored {
        if *cx.actor() != Actor::User { return Err(WsError::invalid("entry snapshot restoration is an author operation")); }
        let s = cx.book_v3(&input.point.target.book)?;
        let p = point(&s.reader_v3.view(), &input.point)?;
        let old = load_point(cx, &p)?; // Validate every historical frontier before any write.
        let hs = handles(cx, &s, &p.entry)?;
        let faults = cx.faults();
        let result = DocHandle::atomic(&hs, Origin::Command, |docs| -> Result<Restored> {
            cx.check_atomic_guards(docs)?;
            if versions(docs) != input.expected { return Err(WsError::Conflict("entry changed since preview; read a new preview".into())); }
            // Every historic body must still be present; a purged document is
            // not silently recreated with another identity/history.
            if p.bodies.keys().any(|id| !docs.contains_key(id)) { return Err(WsError::invalid("checkpoint body is missing")); }
            let before = make_point(docs, &input.point.target, "restore".into())?;
            restore_book(&docs[&book_doc(&p.book)], &old[&book_doc(&p.book)], &s.book, &p.entry)?;
            faults.check("snapshot_after_book")?;
            for (id, d) in docs.iter().filter(|(id, _)| *id != &book_doc(&p.book)) {
                if let Some(at) = p.bodies.get(id) {
                    d.revert_to(&frontiers_from_hex(at)?)?;
                } else {
                    // Body added since this checkpoint: clear it while keeping
                    // its identity/history and the pre-restore content above.
                    let doc = DocId::parse(id).map_err(|e| WsError::invalid(e.to_string()))?;
                    let b = dr_doc::prose::BorrowedProse::new(d, &doc)?;
                    super::super::template::replace_paragraphs(&mut b.txn(), &[])?;
                }
                faults.check("snapshot_after_body")?;
            }
            save(&docs[&book_doc(&p.book)], &s.book, &before)?;
            for d in docs.values() { d.commit(); }
            Ok(Restored { before: before.id, versions: versions(docs) })
        })?;
        cx.effect(EffectAction::Restored, "entry", &p.entry, None);
        cx.undo_with(Invocation::new("entry_snapshot.restore", RestoreIn { point: PointIn { target: input.point.target, point: result.before.clone() }, expected: result.versions.clone() }));
        Ok(result)
    }
}

fn restore_book(now: &LoroDoc, old: &LoroDoc, book: &BookId, entry: &str) -> Result<()> {
    let old = BorrowedBookV3::new(old, book)?;
    let ov = old.view();
    let id: EntryId = pid("entry", entry)?;
    let e = ov
        .entry(&id)
        .ok_or_else(|| WsError::not_found("checkpoint entry", entry))?;
    let b = BorrowedBookV3::new(now, book)?;
    let current = b.view();
    // Never resurrect a purged entry through history.
    if current.entry(&id).is_none() {
        return Err(WsError::not_found("entry", entry));
    }
    let mut entries = current.entries_map();
    let templates = current.templates_map();
    m::check_entry_move(&entries, &id, e.parent.as_ref())?;
    m::check_parent_is_level(e.parent.as_ref(), &entries, &templates)?;
    if let Some(t) = &e.template {
        m::check_entry_template(&templates, Some(t))?;
    }
    entries.insert(id.clone(), e.clone());
    if e.is_leaf(&templates) && entries.values().any(|c| c.parent.as_ref() == Some(&id)) {
        return Err(WsError::invalid("restoration would give a leaf children"));
    }
    let want = ov.entry_owned_records(&id);
    let have = current.entry_owned_records(&id);
    for (c, rows) in &want {
        for key in rows.keys() {
            if !have[c].contains_key(key) && current.map_snapshot(*c, key).is_some() {
                return Err(WsError::Conflict(format!(
                    "record now belongs to another entry: {key}"
                )));
            }
        }
    }
    let mut txn = b.txn();
    txn.restore_entry_with_parent(
        &id,
        e.parent.as_ref(),
        &ov.entry_snapshot(&id).expect("entry"),
    )?;
    txn.restore_entry_complete(&id, &ov.entry_snapshot(&id).expect("entry"))?;
    // Restore sibling order relative to surviving historical neighbours.
    let siblings: Vec<_> = current
        .entries_raw()
        .into_iter()
        .filter(|x| x.parent == e.parent && x.id != id)
        .map(|x| x.id)
        .collect();
    let historical: Vec<_> = ov
        .entries_raw()
        .into_iter()
        .filter(|x| x.parent == e.parent)
        .map(|x| x.id)
        .collect();
    let pos = historical.iter().position(|x| x == &id).unwrap_or(0);
    let index = historical[..pos]
        .iter()
        .rev()
        .find_map(|x| siblings.iter().position(|s| s == x).map(|i| i + 1))
        .or_else(|| {
            historical[pos + 1..]
                .iter()
                .find_map(|x| siblings.iter().position(|s| s == x))
        })
        .unwrap_or(pos.min(siblings.len()));
    txn.entries().move_to_at(&id, e.parent.as_ref(), index)?;
    for (c, rows) in &want {
        let ids: BTreeSet<_> = rows.keys().chain(have[c].keys()).collect();
        for id in ids {
            txn.restore_map_snapshot(*c, id, rows.get(id))?;
        }
    }
    let view = txn.view();
    graph_ok(&view.entries_map(), &templates, &view.memberships_raw())?;
    Ok(())
}
