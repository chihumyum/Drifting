//! Complete entry checkpoints. Manifests live in the book document; all
//! versions refer to durable history, including every retained body document.
//! Restore is an opt-in atomic holder operation, never successive prose writes.
use super::*;
use crate::Actor;
use dr_doc::{prose::ProseReader, v3::BorrowedBookV3};
use dr_store::{AtomicNewDocument, AtomicScope, DocHandle, Origin};
use loro::LoroDoc;
use serde_json::Value;

pub(crate) fn register(r: &mut Registry) {
    r.add::<Create>()
        .add::<List>()
        .add::<Preview>()
        .add::<Restore>()
        .add::<Capture>();
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
    /// Detect a damaged/incomplete manifest before planning any restoration.
    pub checksum: String,
    pub content_hash: String,
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct BodyPreview {
    pub doc: String,
    pub text: String,
    /// Complete historical roots and attributes, including retained future data.
    pub raw_state: Value,
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct PreviewOut {
    pub point: Point,
    /// Complete raw metadata and records, including keys unknown to this build.
    pub metadata: BTreeMap<String, Value>,
    /// The complete typed raw state, including unknown container kinds and
    /// rich-text attributes that deep JSON cannot express.
    pub raw_state: Value,
    pub records: BTreeMap<String, BTreeMap<String, BTreeMap<String, Value>>>,
    /// The historical template, not the entry's current template definition.
    pub template: Option<types::EntryTemplate>,
    /// Complete historical shared definition, for preview only.
    pub template_metadata: Option<BTreeMap<String, Value>>,
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
        || p.checksum != checksum(&p)?
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
fn checksum(p: &Point) -> Result<String> {
    let mut payload = p.clone();
    payload.checksum.clear();
    Ok(dr_store::digest::sha256_hex(
        &serde_json::to_vec(&payload).map_err(|e| WsError::Internal(e.to_string()))?,
    ))
}
fn handles(
    cx: &Cx<'_>,
    s: &BookSlot,
    entry: &str,
) -> Result<(Vec<DocHandle>, Vec<AtomicNewDocument>)> {
    let mut out = vec![s.handle.clone()];
    let mut unwritten = Vec::new();
    // Raw document inventory, not the current template's visible modules.
    for info in cx.workspace().library().docs(Some(s.book.as_str()), None)? {
        if let Ok(doc @ DocId::Body(_)) = DocId::parse(&info.doc_id)
            && matches!(&doc, DocId::Body(b) if b.entry().as_str() == entry)
        {
            // Existing-only access must never initialize or repair a live
            // prose session before this command validates its complete guards.
            match cx
                .workspace()
                .library()
                .open_doc(&info.doc_id, dr_store::OpenDoc::Existing)
            {
                Ok(h) => out.push(h),
                Err(dr_store::StoreError::NotFound(_)) => unwritten.push(AtomicNewDocument {
                    id: info.doc_id,
                    kind: info.kind,
                    genesis: dr_doc::prose::genesis(&doc),
                    pre_registered: true,
                }),
                Err(e) => return Err(e.into()),
            }
        }
    }
    Ok((out, unwritten))
}
fn initialized_handles(cx: &Cx<'_>, s: &BookSlot, entry: &str) -> Result<Vec<DocHandle>> {
    let (handles, unwritten) = handles(cx, s, entry)?;
    if !unwritten.is_empty() {
        return Err(WsError::Conflict("entry has uninitialized body documents; create a current checkpoint before previewing restoration".into()));
    }
    Ok(handles)
}
fn versions(docs: &BTreeMap<String, LoroDoc>) -> BTreeMap<String, String> {
    docs.iter()
        .map(|(id, d)| (id.clone(), frontiers_hex(&d.oplog_frontiers())))
        .collect()
}
fn scope<'a>(book: &'a str, prefix: &'a str) -> AtomicScope<'a> {
    AtomicScope {
        book_id: book,
        prefix,
    }
}
fn inventory_error(e: WsError) -> WsError {
    match e {
        WsError::Store(dr_store::StoreError::Invalid {
            what: "atomic inventory",
            value,
        }) => WsError::Conflict(value),
        other => other,
    }
}
fn make_point(docs: &BTreeMap<String, LoroDoc>, input: &EntryIn, reason: String) -> Result<Point> {
    for (id, d) in docs {
        if let Ok(doc @ DocId::Body(_)) = DocId::parse(id) {
            ProseReader::from_loro(doc, d)?;
        }
    }
    let book: BookId = pid("book", &input.book)?;
    let b = BorrowedBookV3::new(&docs[&book_doc(&input.book)], &book)?;
    let e = b
        .view()
        .entry(&pid("entry", &input.entry)?)
        .ok_or_else(|| WsError::not_found("entry", &input.entry))?;
    let mut versions = versions(docs);
    versions.retain(|id, _| {
        id == &book_doc(&input.book)
            || matches!(DocId::parse(id), Ok(DocId::Body(b)) if b.entry().as_str() == input.entry)
    });
    let book_version = versions
        .remove(&book_doc(&input.book))
        .expect("book is reserved");
    let mut p = Point {
        id: EntryId::new_v7().to_string(),
        format: 1,
        book: input.book.clone(),
        entry: input.entry.clone(),
        ts: dr_store::now_ms(),
        title: e.title,
        reason,
        book_version,
        bodies: versions,
        checksum: String::new(),
        content_hash: content_hash(docs, input)?,
    };
    p.checksum = checksum(&p)?;
    Ok(p)
}
fn save(doc: &LoroDoc, book: &BookId, p: &Point) -> Result<()> {
    let b = BorrowedBookV3::new(doc, book)?;
    b.txn().put_entry_checkpoint(
        &p.id,
        &serde_json::to_string(p).map_err(|e| WsError::Internal(e.to_string()))?,
    )?;
    // Apply F2's cadence/retention to automatic points only. Explicit author,
    // Agent-before-write and pre-restore recovery points are never thinned.
    let automatic: Vec<_> = b
        .view()
        .entry_checkpoints()
        .into_iter()
        .filter_map(|(id, _)| {
            point(
                &b.view(),
                &PointIn {
                    target: EntryIn {
                        book: p.book.clone(),
                        entry: p.entry.clone(),
                    },
                    point: id,
                },
            )
            .ok()
        })
        .filter(|p| matches!(p.reason.as_str(), "periodic" | "close"))
        .collect();
    let rows: Vec<_> = automatic
        .iter()
        .enumerate()
        .map(|(i, p)| (i as i64, p.ts))
        .collect();
    for index in dr_store::history::thinning_plan(&rows, p.ts) {
        let old = &automatic[index as usize];
        if old.id != p.id {
            b.txn().remove_entry_checkpoint(&old.id)?;
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CaptureReason {
    Periodic,
    Close,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CaptureIn {
    #[serde(flatten)]
    pub target: EntryIn,
    pub reason: CaptureReason,
}
op! {
    Create="entry_snapshot.create",Write,Book,"Save a complete v3 entry checkpoint, including retained modules and all body versions. Call before an Agent writes the entry.",fn(cx,input:EntryIn)->Point {
        create(cx, input, None)
    }
}
op! {
    Capture="entry_snapshot.capture",Write,Book,"Capture changed v3 entry content periodically or on close using the existing history interval; unchanged content is skipped.",fn(cx,input:CaptureIn)->Point {
        create(cx, input.target, Some(input.reason))
    }
}
fn content_hash(docs: &BTreeMap<String, LoroDoc>, input: &EntryIn) -> Result<String> {
    let book: BookId = pid("book", &input.book)?;
    let b = BorrowedBookV3::new(&docs[&book_doc(&input.book)], &book)?;
    let v = b.view();
    let id: EntryId = pid("entry", &input.entry)?;
    let state = v
        .entry_owned_raw_state(&id)
        .ok_or_else(|| WsError::not_found("entry", &input.entry))?;
    let versions: BTreeMap<_, _> = docs
        .iter()
        .filter(|(doc, _)| matches!(DocId::parse(doc),Ok(DocId::Body(b)) if b.entry()==&id))
        .map(|(doc, state)| (doc.clone(), frontiers_hex(&state.state_frontiers())))
        .collect();
    let mut value = serde_json::json!({"state":state,"bodies":versions});
    value.sort_all_objects();
    Ok(dr_store::digest::sha256_hex(
        &serde_json::to_vec(&value).map_err(|e| WsError::Internal(e.to_string()))?,
    ))
}
fn create(cx: &Cx<'_>, input: EntryIn, automatic: Option<CaptureReason>) -> Result<Point> {
    let s = cx.book_v3(&input.book)?;
    let (book, entry) = (s.book.clone(), pid("entry", &input.entry)?);
    let (version, e, templates) = s.handle.read(move |d| -> Result<_> {
        let b = BorrowedBookV3::new(d, &book)?;
        let e = b
            .view()
            .entry(&entry)
            .ok_or_else(|| WsError::not_found("entry", entry.to_string()))?;
        Ok((
            frontiers_hex(&d.oplog_frontiers()),
            e,
            b.view().templates_map(),
        ))
    })??;
    let (mut hs, mut fresh) = handles(cx, &s, &input.entry)?;
    let existing: BTreeSet<_> = hs.iter().map(|h| h.doc_id().to_owned()).collect();
    let mut defaults = Vec::new();
    let template = e.effective_template(&templates);
    let mids = if e.is_level(&templates) {
        vec![m::level_about_module_id()]
    } else {
        template
            .into_iter()
            .flat_map(|t| t.prose_modules().map(|m| m.id.clone()))
            .collect()
    };
    for mid in mids {
        let doc = body_id(&e.id, &mid);
        if existing.contains(&doc.to_string()) || fresh.iter().any(|n| n.id == doc.to_string()) {
            continue;
        }
        let source = template
            .filter(|t| t.is_leaf())
            .map(|t| template_doc(&s.book, &t.id, &mid))
            .transpose()?;
        let source = match source {
            Some(d) if cx.workspace().library().doc_info(&d.to_string())?.is_some() => {
                owns(cx, &s, &d)?;
                match cx
                    .workspace()
                    .library()
                    .open_doc(&d.to_string(), dr_store::OpenDoc::Existing)
                {
                    Ok(h) => {
                        hs.push(h);
                        Some(d)
                    }
                    Err(dr_store::StoreError::NotFound(_)) => None,
                    Err(e) => return Err(e.into()),
                }
            }
            _ => None,
        };
        defaults.push((doc.clone(), source));
        fresh.push(AtomicNewDocument {
            id: doc.to_string(),
            kind: doc.kind().prefix().into(),
            genesis: dr_doc::prose::genesis(&doc),
            pre_registered: false,
        });
    }
    let prefix = format!("body:{}/", input.entry);
    let p = DocHandle::atomic_scoped(
        &hs,
        Origin::Command,
        scope(&input.book, &prefix),
        &fresh,
        |docs| -> Result<Point> {
            let observed = docs
                .iter()
                .filter(|(id, _)| existing.contains(*id))
                .map(|(id, d)| (id.clone(), d.clone()))
                .collect();
            cx.check_atomic_guards(&observed)?;
            for (id, doc) in docs {
                if matches!(DocId::parse(id), Ok(DocId::Template(_))) {
                    cx.check_atomic_read_guard(id, doc)?;
                }
            }
            if frontiers_hex(&docs[&book_doc(&input.book)].oplog_frontiers()) != version {
                return Err(WsError::Conflict(
                    "entry changed while preparing checkpoint".into(),
                ));
            }
            let current = BorrowedBookV3::new(&docs[&book_doc(&input.book)], &s.book)?;
            let latest = current
                .view()
                .entry_checkpoints()
                .into_iter()
                .filter_map(|(id, _)| {
                    point(
                        &current.view(),
                        &PointIn {
                            target: input.clone(),
                            point: id,
                        },
                    )
                    .ok()
                })
                .max_by(|a, b| a.ts.cmp(&b.ts).then(a.id.cmp(&b.id)));
            if fresh.is_empty()
                && matches!(automatic, Some(CaptureReason::Periodic))
                && latest.as_ref().is_some_and(|p| {
                    !dr_store::history::periodic_due(Some(p.ts), dr_store::now_ms())
                })
            {
                return Ok(latest.expect("checked"));
            }
            for (doc, source) in &defaults {
                if let Some(source) = source {
                    let source =
                        ProseReader::from_loro(source.clone(), &docs[&source.to_string()])?;
                    dr_doc::prose::BorrowedProse::new(&docs[&doc.to_string()], doc)?
                        .txn()
                        .insert_copy(0, &source.view())?;
                }
                docs[&doc.to_string()].commit();
                cx.faults().check("snapshot_create_after_body")?;
            }
            let reason = match automatic {
                Some(CaptureReason::Periodic) => "periodic".into(),
                Some(CaptureReason::Close) => "close".into(),
                None => cx.actor().store_origin().to_string(),
            };
            let p = make_point(docs, &input, reason)?;
            if automatic.is_some()
                && latest
                    .as_ref()
                    .is_some_and(|old| old.content_hash == p.content_hash)
            {
                return Ok(latest.expect("checked"));
            }
            save(&docs[&book_doc(&input.book)], &s.book, &p)?;
            Ok(p)
        },
    )
    .map_err(inventory_error)?;
    cx.undo_nothing();
    cx.follows_prose();
    Ok(p)
}
op! {
    List="entry_snapshot.list",Read,Shared,"List complete checkpoints of one v3 entry, newest first.",fn(cx,input:EntryIn)->Vec<Point> {
        let s = cx.book_v3(&input.book)?;
        let mut out = Vec::new();
        for (id, value) in s.reader_v3.view().entry_checkpoints() {
            let owner:Value=serde_json::from_str(&value).map_err(|e|WsError::invalid(format!("damaged checkpoint {id}: {e}")))?;
            let entry=owner.get("entry").and_then(Value::as_str).ok_or_else(||WsError::invalid(format!("checkpoint {id} has no owner")))?;
            if entry==input.entry {out.push(point(&s.reader_v3.view(), &PointIn { target: input.clone(), point: id })?);}
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
    if content_hash(
        &out,
        &EntryIn {
            book: p.book.clone(),
            entry: p.entry.clone(),
        },
    )? != p.content_hash
    {
        return Err(WsError::invalid(
            "checkpoint content does not match its manifest",
        ));
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
            let text=dr_text::plain_text(&ProseReader::from_loro(doc, &old[id])?.view());
            bodies.push(BodyPreview { doc: id.clone(), text, raw_state: dr_doc::v3::raw_document_state(&old[id])? });
        }
        let hs = initialized_handles(cx, &s, &p.entry)?;
        let prefix = format!("body:{}/", p.entry);
        let expected = DocHandle::atomic_scoped(&hs, Origin::Command, scope(&p.book, &prefix), &[], |docs| -> Result<_> { Ok(versions(docs)) }).map_err(inventory_error)?;
        let template_metadata=e.template.as_ref().and_then(|id|view.map_snapshot(CollectionV3::Templates,id.as_str())).map(|s|fields(&s)).transpose()?;
        let template = e.effective_template(&view.templates_map()).cloned().map(convert).transpose()?;
        let raw_state=view.entry_owned_raw_state(&id).expect("entry exists");
        Ok(PreviewOut { point: p, metadata, raw_state, records, template, template_metadata, bodies, expected })
    }
}

op! {
    Restore="entry_snapshot.restore",Write,Book,"Atomically restore all owned content of one entry with required version guards, preserving a complete pre-restore checkpoint.",fn(cx,input:RestoreIn)->Restored {
        if *cx.actor() != Actor::User { return Err(WsError::invalid("entry snapshot restoration is an author operation")); }
        let s = cx.book_v3(&input.point.target.book)?;
        let p = point(&s.reader_v3.view(), &input.point)?;
        let old = load_point(cx, &p)?; // Validate every historical frontier before any write.
        let hs = initialized_handles(cx, &s, &p.entry)?;
        let faults = cx.faults();
        let prefix = format!("body:{}/", p.entry);
        let result = DocHandle::atomic_scoped(&hs, Origin::Command, scope(&p.book, &prefix), &[], |docs| -> Result<Restored> {
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
                    let doc = DocId::parse(id).map_err(|e| WsError::invalid(e.to_string()))?;
                    // Both readers materialize the same known empty `embeds`
                    // root without an operation. Unknown roots stay exact.
                    ProseReader::from_loro(doc.clone(), &old[id])?;
                    ProseReader::from_loro(doc, d)?;
                    d.revert_to(&frontiers_from_hex(at)?)?;
                    if dr_doc::v3::raw_document_state(d)? != dr_doc::v3::raw_document_state(&old[id])? {
                        return Err(WsError::invalid("body history cannot be restored without changing retained container identities"));
                    }
                } else {
                    // Body added since this checkpoint: clear it while keeping
                    // its identity/history and the pre-restore content above.
                    let doc = DocId::parse(id).map_err(|e| WsError::invalid(e.to_string()))?;
                    let genesis = LoroDoc::new();
                    genesis.import(&dr_doc::prose::genesis(&doc))?;
                    ProseReader::from_loro(doc, &genesis)?;
                    d.revert_to(&genesis.oplog_frontiers())?;
                    if dr_doc::v3::raw_document_state(d)? != dr_doc::v3::raw_document_state(&genesis)? {
                        return Err(WsError::invalid("later body cannot be cleared without changing retained data"));
                    }
                }
                faults.check("snapshot_after_body")?;
            }
            save(&docs[&book_doc(&p.book)], &s.book, &before)?;
            for d in docs.values() { d.commit(); }
            Ok(Restored { before: before.id, versions: versions(docs) })
        }).map_err(inventory_error)?;
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
    txn.restore_entry_owned_at(&id, &ov)?;
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
    let view = txn.view();
    graph_ok(&view.entries_map(), &templates, &view.memberships_raw())?;
    let mut want = ov.entry_owned_raw_state(&id).expect("historical entry");
    let mut got = view.entry_owned_raw_state(&id).expect("restored entry");
    // Other entries keep their current positions. Their ids in the sibling
    // inventory are not part of this entry's owned metadata or records.
    want.as_object_mut().expect("raw object").remove("siblings");
    got.as_object_mut().expect("raw object").remove("siblings");
    if want != got {
        return Err(WsError::invalid(
            "entry history cannot be restored without changing retained container identities",
        ));
    }
    Ok(())
}
