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
        .add::<CreateWithReceipt>()
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
/// Exact frontiers committed by checkpoint creation, captured while all
/// affected holders remain reserved. Later observations may include other edits.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Created {
    pub point: Point,
    pub versions: BTreeMap<String, String>,
}
fn created(docs: &BTreeMap<String, LoroDoc>, point: Point) -> Created {
    for doc in docs.values() {
        doc.commit();
    }
    Created {
        point,
        versions: versions(docs),
    }
}

/// The format-1 manifest checksum, shared with identity-preserving archive
/// import. This computes integrity only; owner and history validation remain
/// the caller's responsibility. It does not mutate a library or a manifest.
pub fn checkpoint_manifest_checksum(point: &Point) -> Result<String> {
    checksum(point)
}

/// Fingerprint a checkpoint's historical book and body copies using the same
/// algorithm as capture/preview. Archive import calls this on the rewritten
/// documents at the rewritten frontiers, never on current live documents.
pub fn checkpoint_history_fingerprint(
    documents: &BTreeMap<String, LoroDoc>,
    target: &EntryIn,
) -> Result<String> {
    if !documents.contains_key(&book_doc(&target.book)) {
        return Err(WsError::not_found("checkpoint book", &target.book));
    }
    content_hash(documents, target)
}

/// Whether a checkpoint's historical book and body copies are the content
/// its manifest's `content_hash` was taken of. Preview, restore and archive
/// import all ask this before trusting a manifest.
///
/// Two fingerprints are recognised: the one checkpoints are saved with now
/// (`checkpoint_history_fingerprint`), and the one they were saved with
/// until 2026-11-12, which also covered the list of the entry's siblings.
/// Libraries hold checkpoints of both kinds, and a checkpoint is never
/// rewritten in place, so the old kind stays readable for good. A build
/// from before the change does not recognise the new kind: with two devices
/// on different builds, the older one cannot preview what the newer one
/// saved. That is accepted.
pub fn checkpoint_history_matches(
    documents: &BTreeMap<String, LoroDoc>,
    target: &EntryIn,
    content_hash: &str,
) -> Result<bool> {
    Ok(
        checkpoint_history_fingerprint(documents, target)? == content_hash
            || content_hash_with_siblings(documents, target)? == content_hash,
    )
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
    checked_point(&value, &input.target, &input.point)
}
/// The manifest stored under `id`, when it is a sound checkpoint of `target`.
fn checked_point(value: &str, target: &EntryIn, id: &str) -> Result<Point> {
    let p: Point = serde_json::from_str(value).map_err(|e| WsError::invalid(e.to_string()))?;
    if p.format != 1
        || p.book != target.book
        || p.entry != target.entry
        || p.id != id
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
/// Every sound checkpoint of `target`, each manifest read once.
fn points_of<'a>(v: &BookViewV3<'_>, target: &'a EntryIn) -> impl Iterator<Item = Point> + use<'a> {
    v.entry_checkpoints()
        .into_iter()
        .filter_map(move |(id, value)| checked_point(&value, target, &id).ok())
}
fn newer(a: &Point, b: &Point) -> std::cmp::Ordering {
    a.ts.cmp(&b.ts).then(a.id.cmp(&b.id))
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
    // The entry by itself: its title is all that is read here, and reading
    // every entry of the book for it was most of what a checkpoint cost.
    let e = b
        .view()
        .entry_raw(&pid("entry", &input.entry)?)
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
    let target = EntryIn {
        book: p.book.clone(),
        entry: p.entry.clone(),
    };
    let automatic: Vec<_> = points_of(&b.view(), &target)
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
    CreateWithReceipt="entry_snapshot.create_with_receipt",Write,Book,"Save a complete entry checkpoint and return its exact committed versions for a guarded host write. Never infer these versions from a later observation.",fn(cx,input:EntryIn)->Created {
        create_with_receipt(cx, input, None)
    }
}
op! {
    Capture="entry_snapshot.capture",Write,Book,"Capture changed v3 entry content periodically or on close using the existing history interval; unchanged content is skipped.",fn(cx,input:CaptureIn)->Point {
        create(cx, input.target, Some(input.reason))
    }
}
/// Whether an entry changed is decided by what it owns and nothing else:
/// its metadata and records, its parent and its own position among its
/// siblings (`BookViewV3::entry_change_state`), and the versions of its
/// bodies. Another entry created, deleted or moved beside it is not a change
/// of this one. Restoration does not read this: `restore_book` takes the
/// sibling order from the historical book itself.
fn content_hash(docs: &BTreeMap<String, LoroDoc>, input: &EntryIn) -> Result<String> {
    let book: BookId = pid("book", &input.book)?;
    let b = BorrowedBookV3::new(&docs[&book_doc(&input.book)], &book)?;
    let v = b.view();
    let id: EntryId = pid("entry", &input.entry)?;
    let state = v
        .entry_change_state(&id)
        .ok_or_else(|| WsError::not_found("entry", &input.entry))?;
    fingerprint(&state, &body_states(docs, &id))
}
/// The content hash of checkpoints saved until 2026-11-12, byte for byte:
/// the entry's owned raw state with the list of its siblings
/// (`BookViewV3::entry_owned_raw_state`) and the versions of its bodies.
/// Only `checkpoint_history_matches` reads it, to recognise those
/// checkpoints; nothing is saved or compared for a capture with it.
fn content_hash_with_siblings(docs: &BTreeMap<String, LoroDoc>, input: &EntryIn) -> Result<String> {
    let book: BookId = pid("book", &input.book)?;
    let b = BorrowedBookV3::new(&docs[&book_doc(&input.book)], &book)?;
    let v = b.view();
    let id: EntryId = pid("entry", &input.entry)?;
    let state = v
        .entry_owned_raw_state(&id)
        .ok_or_else(|| WsError::not_found("entry", &input.entry))?;
    fingerprint(&state, &body_states(docs, &id))
}
/// The version of each of the entry's bodies among `docs`.
fn body_states(docs: &BTreeMap<String, LoroDoc>, entry: &EntryId) -> BTreeMap<String, String> {
    docs.iter()
        .filter(|(doc, _)| matches!(DocId::parse(doc),Ok(DocId::Body(b)) if b.entry()==entry))
        .map(|(doc, state)| (doc.clone(), frontiers_hex(&state.state_frontiers())))
        .collect()
}
fn fingerprint(state: &Value, bodies: &BTreeMap<String, String>) -> Result<String> {
    let mut value = serde_json::json!({"state":state,"bodies":bodies});
    value.sort_all_objects();
    Ok(dr_store::digest::sha256_hex(
        &serde_json::to_vec(&value).map_err(|e| WsError::Internal(e.to_string()))?,
    ))
}
/// The prose modules an entry has by its template (a level: its own page).
/// A checkpoint creates the bodies of those that have none yet.
fn prose_modules(
    e: &m::Entry,
    templates: &BTreeMap<EntryTemplateId, m::EntryTemplate>,
) -> Vec<ModuleId> {
    if e.is_level(templates) {
        vec![m::level_about_module_id()]
    } else {
        e.effective_template(templates)
            .into_iter()
            .flat_map(|t| t.prose_modules().map(|m| m.id.clone()))
            .collect()
    }
}

/// The entries of `book` an automatic capture has something to do for, in
/// tree order: all of them but those `entry_snapshot.capture` with reason
/// `close` would only look at and leave. A sweep (the last one on quitting)
/// calls the command for these alone. Each call copies the whole book
/// document to work on, which a book of hundreds of entries cannot pay once
/// per entry every time the app quits.
///
/// An entry is left out only when the command would find nothing to write:
/// every registered body has content and no default body is missing (so it
/// would create no document), and the content hash it would compute equals
/// that of the entry's latest sound checkpoint. The book and the bodies are
/// read as the command reads them, from the open holders, so operations a
/// holder could not store yet still count as a change; while the book itself
/// holds such operations every entry is due, and the commands settle them or
/// fail as before. A book that is not a v3 book has no entry checkpoints.
pub fn entries_due_for_capture(ws: &crate::Workspace, book: &str) -> Result<Vec<String>> {
    struct Row {
        entry: String,
        /// With a sound checkpoint: the entry's state now, that checkpoint's
        /// content hash and the bodies its template gives it.
        latest: Option<(Value, String, Vec<String>)>,
    }
    let id: BookId = pid("book", book)?;
    let lib = ws.library();
    let slot = match ws.book_slot(&id) {
        Ok(slot) => slot,
        Err(e) => {
            return match lib.load_copy(&book_doc(book)) {
                Ok(d) if !dr_doc::v3::is_v3_doc(&d) => Ok(Vec::new()),
                _ => Err(e),
            };
        }
    };
    let (book_id, owner) = (id.clone(), book.to_owned());
    let (live, rows) = slot.handle.read(move |d| -> Result<_> {
        let b = BorrowedBookV3::new(d, &book_id)?;
        let v = b.view();
        let (entries, templates) = (v.entries_map(), v.templates_map());
        let mut latest: BTreeMap<String, Point> = BTreeMap::new();
        for (point, value) in v.entry_checkpoints() {
            // Sound for the entry it names, or not a checkpoint of any.
            let Ok(p) = serde_json::from_str::<Point>(&value) else {
                continue;
            };
            let target = EntryIn {
                book: owner.clone(),
                entry: p.entry,
            };
            let Ok(p) = checked_point(&value, &target, &point) else {
                continue;
            };
            if latest
                .get(&target.entry)
                .is_none_or(|old| newer(old, &p).is_lt())
            {
                latest.insert(target.entry, p);
            }
        }
        let rows: Vec<Row> = v
            .entry_change_states()
            .into_iter()
            .map(|(entry, state)| {
                let latest = latest.remove(entry.as_str()).and_then(|p| {
                    let defaults = prose_modules(entries.get(&entry)?, &templates)
                        .iter()
                        .map(|module| body_id(&entry, module).to_string())
                        .collect();
                    Some((state, p.content_hash, defaults))
                });
                Row {
                    entry: entry.to_string(),
                    latest,
                }
            })
            .collect();
        Ok((frontiers_hex(&d.oplog_frontiers()), rows))
    })??;
    if lib
        .head(&book_doc(book))?
        .is_none_or(|head| frontiers_hex(&head.frontiers) != live)
    {
        return Ok(rows.into_iter().map(|row| row.entry).collect());
    }
    // The raw document inventory, as `handles` reads it for one entry.
    let mut bodies: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for info in lib.docs(Some(book), None)? {
        if let Ok(DocId::Body(b)) = DocId::parse(&info.doc_id) {
            bodies
                .entry(b.entry().to_string())
                .or_default()
                .push(info.doc_id);
        }
    }
    let mut due = Vec::new();
    for row in rows {
        let unchanged = match &row.latest {
            None => false,
            Some((state, hash, defaults)) => {
                let registered = bodies.get(&row.entry).map_or(&[][..], Vec::as_slice);
                match body_versions(lib, registered) {
                    Some(versions) => {
                        defaults.iter().all(|doc| versions.contains_key(doc))
                            && fingerprint(state, &versions)? == *hash
                    }
                    None => false,
                }
            }
        };
        if !unchanged {
            due.push(row.entry);
        }
    }
    Ok(due)
}
/// The version of each of an entry's registered bodies, from its holder.
/// `None` when one has no content yet or cannot be opened: the capture
/// command initializes the first and reports the second.
fn body_versions(lib: &dr_store::Library, docs: &[String]) -> Option<BTreeMap<String, String>> {
    let mut versions = BTreeMap::new();
    for id in docs {
        let handle = lib.open_doc(id, dr_store::OpenDoc::Existing).ok()?;
        let version = handle.read(|d| frontiers_hex(&d.state_frontiers()));
        handle.close();
        versions.insert(id.clone(), version.ok()?);
    }
    Some(versions)
}
fn create(cx: &Cx<'_>, input: EntryIn, automatic: Option<CaptureReason>) -> Result<Point> {
    Ok(create_with_receipt(cx, input, automatic)?.point)
}
fn create_with_receipt(
    cx: &Cx<'_>,
    input: EntryIn,
    automatic: Option<CaptureReason>,
) -> Result<Created> {
    let s = cx.book_v3(&input.book)?;
    let (book, entry) = (s.book.clone(), pid("entry", &input.entry)?);
    let (version, e, templates) = s.handle.read(move |d| -> Result<_> {
        let b = BorrowedBookV3::new(d, &book)?;
        // The entry by itself (its template decides its bodies); the name
        // conflicts `entry` resolves over the whole book are not used.
        let e = b
            .view()
            .entry_raw(&entry)
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
    for mid in prose_modules(&e, &templates) {
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
        |docs| -> Result<Created> {
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
            let latest = points_of(&current.view(), &input).max_by(newer);
            if fresh.is_empty()
                && matches!(automatic, Some(CaptureReason::Periodic))
                && latest.as_ref().is_some_and(|p| {
                    !dr_store::history::periodic_due(Some(p.ts), dr_store::now_ms())
                })
            {
                return Ok(created(docs, latest.expect("checked")));
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
                return Ok(created(docs, latest.expect("checked")));
            }
            save(&docs[&book_doc(&input.book)], &s.book, &p)?;
            cx.faults().check("snapshot_create_after_manifest")?;
            Ok(created(docs, p))
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
    let target = EntryIn {
        book: p.book.clone(),
        entry: p.entry.clone(),
    };
    if !checkpoint_history_matches(&out, &target, &p.content_hash)? {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Workspace;
    use serde_json::json;

    /// A new novel book with chapters `a`, `b`, `c`, `d` in its manuscript.
    struct Shelf {
        _dir: tempfile::TempDir,
        ws: Workspace,
        book: String,
        manuscript: String,
        chapters: BTreeMap<&'static str, String>,
    }
    fn shelf() -> Shelf {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "test").unwrap();
        let out = |name: &str, input: Value| ws.call(&Actor::User, name, input).unwrap();
        let book = out("project.create", json!({"name":"Synthetic checkpoints"}))["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let manuscript = out("entry.list", json!({"book":book,"all":true}))["output"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["template"] == "tpl-manuscript")
            .expect("the manuscript")["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut s = Shelf {
            _dir: dir,
            ws,
            book,
            manuscript,
            chapters: BTreeMap::new(),
        };
        for name in ["a", "b", "c", "d"] {
            let id = s.chapter(name);
            s.chapters.insert(name, id);
        }
        s
    }
    impl Shelf {
        fn out(&self, name: &str, input: Value) -> Value {
            self.ws.call(&Actor::User, name, input).unwrap()["output"].clone()
        }
        fn id(&self, name: &str) -> &str {
            &self.chapters[name]
        }
        /// A chapter at the end of the manuscript.
        fn chapter(&self, title: &str) -> String {
            self.out(
                "entry.create",
                json!({"book":self.book,"title":title,"parent":self.manuscript,"template":"tpl-chapter"}),
            )["id"]
                .as_str()
                .unwrap()
                .to_owned()
        }
        fn move_to(&self, name: &str, parent: Option<&str>, index: usize) {
            self.out(
                "entry.move",
                json!({"book":self.book,"id":self.id(name),"parent":parent,"index":index}),
            );
        }
        /// The automatic checkpoint a quit saves or finds.
        fn close(&self, entry: &str) -> String {
            self.out(
                "entry_snapshot.capture",
                json!({"book":self.book,"entry":entry,"reason":"close"}),
            )["id"]
                .as_str()
                .unwrap()
                .to_owned()
        }
        fn points(&self, entry: &str) -> usize {
            self.out(
                "entry_snapshot.list",
                json!({"book":self.book,"entry":entry}),
            )
            .as_array()
            .unwrap()
            .len()
        }
        /// The titles under `parent`, in manuscript order.
        fn order(&self, parent: Option<&str>) -> String {
            self.out("entry.list", json!({"book":self.book,"all":true}))
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| e["parent"].as_str() == parent && e["template"] == "tpl-chapter")
                .map(|e| e["title"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
                .join(" ")
        }
        fn restore(&self, name: &str, point: &str) {
            let target = json!({"book":self.book,"entry":self.id(name),"point":point});
            let preview = self.out("entry_snapshot.preview", target.clone());
            let mut input = target;
            input["expected"] = preview["expected"].clone();
            self.out("entry_snapshot.restore", input);
        }
        fn point(&self, name: &str, point: &str) -> Value {
            json!({"book":self.book,"entry":self.id(name),"point":point})
        }
        /// A checkpoint of chapter `name` as it is stored.
        fn stored(&self, name: &str, point: &str) -> Point {
            let all: Vec<Point> = serde_json::from_value(self.out(
                "entry_snapshot.list",
                json!({"book":self.book,"entry":self.id(name)}),
            ))
            .unwrap();
            all.into_iter().find(|p| p.id == point).expect("the point")
        }
        /// Put `p` where the manifest of that id is stored, with the checksum
        /// its fields give. A raw write: no command rewrites a checkpoint.
        fn store(&self, mut p: Point) -> Point {
            p.checksum = checksum(&p).unwrap();
            let (id, manifest) = (p.id.clone(), serde_json::to_string(&p).unwrap());
            self.ws
                .library()
                .open_doc(&book_doc(&self.book), dr_store::OpenDoc::Existing)
                .unwrap()
                .write(dr_store::Origin::User, move |d| {
                    d.get_map("entry_checkpoints")
                        .insert(&id, manifest)
                        .unwrap();
                })
                .unwrap();
            p
        }
        /// The checkpoint as a build before 2026-11-12 saved it: the same
        /// manifest, its content hash the one that covered the siblings.
        fn save_with_old_fingerprint(&self, name: &str, point: &str) -> Point {
            let mut p = self.stored(name, point);
            let lib = self.ws.library();
            let docs: BTreeMap<String, LoroDoc> =
                std::iter::once((book_doc(&p.book), p.book_version.clone()))
                    .chain(p.bodies.clone())
                    .map(|(id, version)| {
                        let at = frontiers_from_hex(&version).unwrap();
                        let doc = lib.load_copy_at(&id, &at).unwrap();
                        (id, doc)
                    })
                    .collect();
            let target = EntryIn {
                book: p.book.clone(),
                entry: p.entry.clone(),
            };
            let current = std::mem::replace(
                &mut p.content_hash,
                content_hash_with_siblings(&docs, &target).unwrap(),
            );
            assert_eq!(content_hash(&docs, &target).unwrap(), current);
            assert_ne!(p.content_hash, current, "the two fingerprints differ");
            self.store(p)
        }
        /// What a restore of chapter `b` puts back: its place, title and text.
        fn b(&self) -> (String, Value, Value) {
            let entry = self.out("entry.get", json!({"book":self.book,"id":self.id("b")}));
            let text = self.out(
                "module.read_prose",
                json!({"book":self.book,"owner":self.id("b"),"module":"mod-prose"}),
            )["paragraphs"]
                .clone();
            (
                self.order(Some(&self.manuscript)),
                json!([entry["title"], entry["parent"]]),
                text,
            )
        }
        /// Chapter `b` renamed, rewritten and moved to the end.
        fn change_b(&self, text: &str) {
            self.out(
                "entry.update",
                json!({"book":self.book,"id":self.id("b"),"title":text}),
            );
            self.out(
                "module.set_prose",
                json!({"book":self.book,"owner":self.id("b"),"module":"mod-prose","paragraphs":[{"text":text}]}),
            );
            self.move_to("b", Some(&self.manuscript), 3);
        }
    }

    #[test]
    fn a_sibling_created_moved_trashed_or_removed_earns_an_entry_no_checkpoint() {
        let s = shelf();
        let first: BTreeMap<_, _> = ["a", "b", "c"]
            .into_iter()
            .map(|name| (name, s.close(s.id(name))))
            .collect();
        let unchanged = |step: &str, names: &[&str]| {
            for name in names {
                assert_eq!(s.close(s.id(name)), first[name], "{name} after {step}");
                assert_eq!(s.points(s.id(name)), 1, "{name} after {step}");
            }
        };
        let e = s.chapter("e");
        unchanged("a sibling was created", &["a", "b", "c"]);
        s.move_to("c", Some(&s.manuscript), 0);
        assert_eq!(s.order(Some(&s.manuscript)), "c a b d e");
        unchanged("a sibling moved in front", &["a", "b"]);
        assert_ne!(s.close(s.id("c")), first["c"], "the mover itself changed");
        s.out("entry.trash", json!({"book":s.book,"id":e}));
        unchanged("a sibling was trashed", &["a", "b"]);
        s.move_to("d", None, 0);
        unchanged("a sibling left for another parent", &["a", "b"]);
        // A creation undone, and a sibling's node deleted from the tree
        // outright (no command does that today; another device's purge
        // arriving by sync would).
        let f = s.chapter("f");
        unchanged("another sibling was created", &["a", "b"]);
        s.ws.undo(&Actor::User).unwrap().expect("the creation");
        let listed = |id: &str| {
            s.out(
                "entry.list",
                json!({"book":s.book,"all":true,"trashed":true}),
            )
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == id)
        };
        assert!(!s.order(Some(&s.manuscript)).contains('f'));
        unchanged("a sibling's creation was undone", &["a", "b"]);
        let (book, gone): (BookId, EntryId) =
            (pid("book", &s.book).unwrap(), pid("entry", &f).unwrap());
        s.ws.library()
            .open_doc(&book_doc(&s.book), dr_store::OpenDoc::Existing)
            .unwrap()
            .write(dr_store::Origin::User, move |d| {
                BorrowedBookV3::new(d, &book)
                    .unwrap()
                    .txn()
                    .entries()
                    .purge_subtree(&gone)
                    .unwrap();
            })
            .unwrap();
        assert!(listed(&e) && !listed(&f));
        unchanged("a sibling was deleted", &["a", "b"]);
        // An entry's own content still earns one.
        s.out(
            "entry.update",
            json!({"book":s.book,"id":s.id("a"),"title":"a2"}),
        );
        assert_ne!(s.close(s.id("a")), first["a"]);
        unchanged("another entry was renamed", &["b"]);
    }

    #[test]
    fn an_entry_moved_among_its_siblings_or_to_another_parent_earns_a_checkpoint() {
        let s = shelf();
        let (a, first) = (s.close(s.id("a")), s.close(s.id("b")));
        s.move_to("b", Some(&s.manuscript), 0);
        assert_eq!(s.order(Some(&s.manuscript)), "b a c d");
        let reordered = s.close(s.id("b"));
        assert_ne!(reordered, first);
        assert_eq!(s.close(s.id("b")), reordered, "and only one");
        s.move_to("b", None, 0);
        assert_eq!(s.order(Some(&s.manuscript)), "a c d");
        let rehomed = s.close(s.id("b"));
        assert_ne!(rehomed, reordered);
        assert_eq!(s.points(s.id("b")), 3);
        // The entry it passed and then left behind was never touched.
        assert_eq!(s.close(s.id("a")), a);
        assert_eq!(s.points(s.id("a")), 1);
    }

    #[test]
    fn restore_puts_an_entry_back_among_its_historical_neighbours() {
        let s = shelf();
        let point = s.out(
            "entry_snapshot.create",
            json!({"book":s.book,"entry":s.id("b")}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned();
        // The preview still lists the siblings of that time; the content
        // hash no longer covers them.
        let preview = s.out(
            "entry_snapshot.preview",
            json!({"book":s.book,"entry":s.id("b"),"point":point}),
        );
        assert_eq!(
            preview["raw_state"]["siblings"],
            json!([s.id("a"), s.id("b"), s.id("c"), s.id("d")])
        );

        // After its historical predecessor, whatever came since.
        s.move_to("b", Some(&s.manuscript), 3);
        s.chapter("e");
        assert_eq!(s.order(Some(&s.manuscript)), "a c d b e");
        s.restore("b", &point);
        assert_eq!(s.order(Some(&s.manuscript)), "a b c d e");

        // The predecessor has left: before its historical successor.
        s.move_to("b", Some(&s.manuscript), 4);
        s.move_to("a", None, 0);
        assert_eq!(s.order(Some(&s.manuscript)), "c d e b");
        s.restore("b", &point);
        assert_eq!(s.order(Some(&s.manuscript)), "b c d e");

        // From another parent: home again, in the same place.
        s.move_to("b", None, 0);
        assert_eq!(s.order(Some(&s.manuscript)), "c d e");
        s.restore("b", &point);
        assert_eq!(s.order(Some(&s.manuscript)), "b c d e");
        assert_eq!(s.order(None), "a");
    }

    #[test]
    fn a_checkpoint_saved_with_the_old_fingerprint_is_previewed_and_restored_like_any_other() {
        let s = shelf();
        s.out(
            "module.set_prose",
            json!({"book":s.book,"owner":s.id("b"),"module":"mod-prose","paragraphs":[{"text":"first text"}]}),
        );
        // Three checkpoints of the same content. One stays as it is saved
        // now; one is stored as a build before 2026-11-12 saved it; one
        // claims a content that is neither.
        let create = || {
            s.out(
                "entry_snapshot.create",
                json!({"book":s.book,"entry":s.id("b")}),
            )["id"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let (new, old, neither) = (create(), create(), create());
        let saved = s.save_with_old_fingerprint("b", &old);
        let mut wrong = s.stored("b", &neither);
        wrong.content_hash = dr_store::digest::sha256_hex(b"neither fingerprint");
        s.store(wrong);
        let before = s.b();
        assert_eq!(before.0, "a b c d");
        s.change_b("later");
        assert_ne!(s.b(), before);

        // The same preview, whichever fingerprint the manifest carries.
        let as_new = s.out("entry_snapshot.preview", s.point("b", &new));
        let as_old = s.out("entry_snapshot.preview", s.point("b", &old));
        assert_eq!(as_old["point"]["content_hash"], saved.content_hash);
        assert_ne!(
            as_old["point"]["content_hash"],
            as_new["point"]["content_hash"]
        );
        for part in [
            "metadata",
            "raw_state",
            "records",
            "template",
            "template_metadata",
            "bodies",
            "expected",
        ] {
            assert_eq!(as_old[part], as_new[part], "{part}");
        }
        assert_eq!(as_old["metadata"]["title"], "b");

        // And the same restore.
        s.restore("b", &old);
        assert_eq!(s.b(), before);
        s.change_b("later again");
        s.restore("b", &new);
        assert_eq!(s.b(), before);

        // A manifest whose content hash is neither fingerprint of its
        // history is still refused, before anything is written.
        s.change_b("kept");
        let kept = s.b();
        let mut restore = s.point("b", &neither);
        restore["expected"] = json!({});
        for (name, input) in [
            ("entry_snapshot.preview", s.point("b", &neither)),
            ("entry_snapshot.restore", restore),
        ] {
            let refused = s.ws.call(&Actor::User, name, input).unwrap_err();
            assert!(
                refused
                    .to_string()
                    .contains("checkpoint content does not match its manifest"),
                "{name}: {refused}"
            );
        }
        assert_eq!(s.b(), kept);
    }

    #[test]
    fn an_old_fingerprint_costs_an_entry_one_more_automatic_checkpoint_and_no_second() {
        let s = shelf();
        let due = || {
            entries_due_for_capture(&s.ws, &s.book)
                .unwrap()
                .iter()
                .any(|entry| entry == s.id("b"))
        };
        let first = s.close(s.id("b"));
        assert_eq!(s.close(s.id("b")), first);
        assert!(!due());
        // The library as an earlier build left it: the entry's latest
        // checkpoint carries the old fingerprint.
        s.save_with_old_fingerprint("b", &first);
        assert!(due(), "the old fingerprint is not compared when capturing");
        let second = s.close(s.id("b"));
        assert_ne!(
            second, first,
            "one more checkpoint, with the new fingerprint"
        );
        assert_eq!(s.points(s.id("b")), 2);
        assert!(!due());
        assert_eq!(s.close(s.id("b")), second, "and no second");
        assert_eq!(s.points(s.id("b")), 2);
        // The old one is still there, and readable.
        let old = s.out("entry_snapshot.preview", s.point("b", &first));
        assert_eq!(old["metadata"]["title"], "b");
    }
}
