//! One import, start to finish (`m10-import.md` "流程"):
//!
//! 1. stage the 0.1 database (the original is only read) and bring it up to
//!    the last 0.1 schema;
//! 2. classify every body's freshness and decide the gate; stop unless it is
//!    clear or the author accepted;
//! 3. per book: plan every body, give projected TODOs their ids, write each
//!    prose document (snapshot history first, then the current body) in
//!    memory with dr-doc (deterministic import peers and the 0.1
//!    timestamps) and store it in dr-store (origin `import`); then the book
//!    document, stored step by step while the snapshot history's metadata is
//!    replayed, each history point labelled at its version and time; then
//!    the assets;
//! 4. write the receipt into the library and the archive beside it;
//! 5. build search, outlines and word counts (dr-index).
//!
//! [`import_with`] reports [`Progress`] all the way.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::time::Instant;

use dr_doc::Anchor;
use dr_doc::book::{BookDoc, BookReader};
use dr_doc::loro_types::{Frontiers, VersionVector};
use dr_doc::peer::import_peer;
use dr_doc::prose::ProseDoc;
use dr_model::id::{BlockId, BookId, CategoryId, CommentId, StorylineId, TemplateOwner};
use dr_model::kind::ProjectionKind;
use dr_model::{DocId, Origin, ProseProfile};
use dr_store::history::{LabelRetention, NewLabel};
use dr_store::{Device, DocHandle, Library, LibraryOptions, OpenDoc};
use serde::Serialize;
use serde_json::Value;

use crate::anchors::{self, Resolution};
use crate::book;
use crate::error::{ImportError, Result};
use crate::gate::{Accept, Gate};
use crate::handoff::BookSettings;
use crate::legacy::{BookRows, HistoryRow, Legacy, ProseKind, ProseOwner};
use crate::locate;
use crate::meta::{self, Fields, Meta, Owner};
use crate::progress::{Callback, Reporter, Step};
use crate::prose::{self, BlockSpan, Context, DocBlocks, Notes, Para, Plan, pm, read, write};
use crate::receipt::{self, AnchorRecord, BookRecord, DocRecord, Receipt};
use crate::staging::{self, Staged};
use crate::time::parse_iso_ms;

/// The importer's name in receipts.
pub const IMPORTER: &str = concat!("dr-import-v1 ", env!("CARGO_PKG_VERSION"));

/// How to import.
#[derive(Clone, Debug)]
pub struct Options {
    /// What the author accepted when the gate stopped ("仍然导入").
    pub accept: Accept,
    /// The 0.2 app version (dr-store's safety snapshots and library meta).
    pub app_version: String,
    /// The 0.1 library's data root: assets, installation identity. Without
    /// it no asset bytes are copied.
    pub old_root: Option<PathBuf>,
    /// This device's directory for dr-store's [`Device`]. When it has no
    /// installation identity yet, the 0.1 one is adopted
    /// ([`Device::adopt`]), so writing days continue under the same device
    /// key.
    pub device_dir: Option<PathBuf>,
    /// Keep the staging copy after a successful import.
    pub keep_staging: bool,
    /// Also check every history version by loading it at its frontiers:
    /// the body on its prose document, the metadata on the book document.
    pub verify_history: bool,
    /// Build search, outlines and word counts right after the import
    /// (dr-index). On by default; without it dr-store builds them the next
    /// time the library opens with a deriver.
    pub index: bool,
    /// Whether the history points brought from 0.1 (and the `import` point)
    /// are exempt from the 30-day retention. Kept by default: the author
    /// may import months after the last 0.1 edit, and thinning would drop
    /// them the moment they arrive.
    pub history_retention: LabelRetention,
    /// Stops the import ([`Cancel`]); clone it before starting and keep it.
    pub cancel: Cancel,
}

/// Stops an import that is running (`m10-import.md` 「取消」). Clones share
/// the request.
#[derive(Clone, Debug, Default)]
pub struct Cancel(Arc<AtomicU8>);

impl Cancel {
    const AFTER_BOOK: u8 = 1;
    const NOW: u8 = 2;

    /// Stop once the book being written is finished, so no book is left
    /// half-written: the books not started yet are left out ("cancelled" in
    /// the receipt) and the import finishes as usual (receipt, indexes).
    /// Before anything is written (copying, checking), nothing is.
    pub fn after_book(&self) {
        self.0.fetch_max(Self::AFTER_BOOK, Ordering::SeqCst);
    }

    /// Stop at the next body, step or asset (the app quitting): the book
    /// being written stays half-written, marked as still importing, and the
    /// next import of the same library carries it on. No indexes are built.
    pub fn now(&self) {
        self.0.fetch_max(Self::NOW, Ordering::SeqCst);
    }

    /// Whether a stop was asked for.
    pub fn requested(&self) -> bool {
        self.0.load(Ordering::SeqCst) >= Self::AFTER_BOOK
    }

    fn now_requested(&self) -> bool {
        self.0.load(Ordering::SeqCst) >= Self::NOW
    }
}

impl Options {
    pub fn new(app_version: impl Into<String>) -> Self {
        Self {
            accept: Accept::NOTHING,
            app_version: app_version.into(),
            old_root: None,
            device_dir: None,
            keep_staging: false,
            verify_history: false,
            index: true,
            history_retention: LabelRetention::Kept,
            cancel: Cancel::default(),
        }
    }
}

/// What an import (or an analysis) came to.
#[derive(Debug)]
pub enum Outcome {
    /// The gate stopped it; nothing was written to the new library.
    Blocked(Gate),
    /// Stopped ([`Cancel`]) before anything was written.
    Cancelled,
    /// Written, all of it or (stopped with [`Cancel`]) the books it got to:
    /// `Receipt::cancelled` says which.
    Imported(Box<Receipt>),
}

/// Timing of one import, for the measurements.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    /// Copying, recovering and migrating the 0.1 database, and the gate.
    pub stage_ms: f64,
    pub prose_ms: f64,
    pub book_ms: f64,
    pub store_ms: f64,
    /// Writing the history points (dr-store `label_many`).
    pub labels_ms: f64,
    pub assets_ms: f64,
    pub receipt_ms: f64,
    /// Building search, outlines and word counts.
    pub index_ms: f64,
    pub indexed_docs: usize,
    pub total_ms: f64,
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1e3
}

/// Stage and analyse a 0.1 library without writing anything new.
pub fn analyse(
    source: &Path,
    staging_dir: &Path,
) -> Result<(Staged, Legacy, Vec<ProseOwner>, Gate)> {
    analyse_reporting(source, staging_dir, &mut Reporter::new(&mut |_| {}))
}

fn analyse_reporting(
    source: &Path,
    staging_dir: &Path,
    reporter: &mut Reporter<'_>,
) -> Result<(Staged, Legacy, Vec<ProseOwner>, Gate)> {
    let staged = staging::stage_with(source, staging_dir, "source", &mut |done, total| {
        reporter.copying(done, total)
    })?;
    reporter.checking();
    let legacy = Legacy::new(staged.open()?)?;
    let (owners, _) = legacy.prose_owners()?;
    let sync = legacy.sync_blockers()?;
    let mut gate = Gate::decide(
        legacy.stamp.is_some(),
        legacy.stamp.as_ref().and_then(|s| s.app_version.clone()),
        &owners,
        sync,
    );
    fill_titles(&legacy, &mut gate)?;
    Ok((staged, legacy, owners, gate))
}

fn fill_titles(legacy: &Legacy, gate: &mut Gate) -> Result<()> {
    for d in &mut gate.doubtful {
        d.book_name = legacy
            .conn
            .query_row("SELECT name FROM project WHERE id = ?1", [&d.book], |r| {
                r.get(0)
            })
            .ok();
        let Some((kind, id)) = ProseKind::from_doc_id(&d.doc) else {
            continue;
        };
        let sql = match kind {
            ProseKind::NodeContent => "SELECT title, kind FROM book_node WHERE id = ?1",
            ProseKind::Element => "SELECT name, NULL FROM element WHERE id = ?1",
            ProseKind::Storyline => "SELECT name, NULL FROM storylines WHERE id = ?1",
            ProseKind::Category => "SELECT name, NULL FROM element_category WHERE id = ?1",
            ProseKind::LibraryItem => "SELECT title, NULL FROM library_item WHERE id = ?1",
        };
        if let Ok((title, node_kind)) = legacy.conn.query_row(sql, [id], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, Option<String>>(1)?,
            ))
        }) {
            d.title = title;
            d.drift = node_kind.is_some_and(|k| {
                dr_model::kind::NodeKind::parse(&k) == dr_model::kind::NodeKind::Drift
            });
        }
    }
    Ok(())
}

fn secs(ms: i64) -> i64 {
    ms.div_euclid(1000)
}

/// Adopt the 0.1 installation identity into `device_dir` when it has none.
fn adopt_identity(old_root: Option<&Path>, device_dir: &Path) -> bool {
    let Some(id) = old_root.and_then(locate::installation_id) else {
        return false;
    };
    match Device::adopt(device_dir, &id) {
        Ok(adopted) => adopted,
        Err(e) => {
            log::warn!("not adopting the 0.1 installation identity: {e}");
            false
        }
    }
}

/// The device of an open library takes over the 0.1 installation id (it
/// has one already: the app made it, or found the 0.1 file).
fn take_over_identity(old_root: Option<&Path>, lib: &Library) -> bool {
    let Some(id) = old_root.and_then(locate::installation_id) else {
        return false;
    };
    match lib.adopt_installation_id(&id) {
        Ok(adopted) => adopted,
        Err(e) => {
            log::warn!("not taking over the 0.1 installation identity: {e}");
            false
        }
    }
}

struct Body<'a> {
    owner: &'a ProseOwner,
    doc_id: DocId,
    profile: ProseProfile,
    lines: pm::Prose,
    blocks: DocBlocks,
    history: Vec<&'a HistoryRow>,
}

/// One 0.1 history row, replayed: the prose version it became, and the
/// metadata to replay into the book document.
struct Point {
    doc_id: String,
    row_id: String,
    ts_ms: i64,
    frontiers: Frontiers,
    owner: Option<Owner>,
    meta: Option<Meta>,
}

fn old_doc_of_target(kind: &str, id: &str) -> Option<String> {
    let prefix = match kind {
        "node" => "node-content",
        "element" => "element",
        "storyline" => "storyline",
        "category" => "category",
        "library_item" | "material" => "library-item",
        _ => return None,
    };
    Some(format!("{prefix}:{id}"))
}

fn open_new(lib: &Library, doc_id: &DocId, book: &str, genesis: Vec<u8>) -> Result<DocHandle> {
    let g = genesis;
    Ok(lib.open_doc(
        &doc_id.to_string(),
        OpenDoc::CreateIfMissing {
            kind: doc_id.kind().prefix(),
            book_id: Some(book),
            genesis: &move |d: &loro::LoroDoc| {
                d.import(&g)
                    .expect("dr-doc's genesis imports into an empty document");
            },
        },
    )?)
}

fn import_into(h: &DocHandle, id: &str, bytes: Vec<u8>) -> Result<()> {
    let imported = h.import(bytes, dr_store::Origin::Import)?;
    if imported.status.pending.is_some() {
        return Err(ImportError::Invalid(format!(
            "{id}: imported updates wait for missing ones"
        )));
    }
    Ok(())
}

fn store_doc(
    lib: &Library,
    doc_id: &DocId,
    book: &str,
    genesis: Vec<u8>,
    bytes: Vec<u8>,
) -> Result<()> {
    let h = open_new(lib, doc_id, book, genesis)?;
    import_into(&h, &doc_id.to_string(), bytes)?;
    h.close();
    Ok(())
}

/// The book's 0.1 body templates (a category's `element_template`, a
/// storyline's `chapter_template`: editor JSON), each written into its
/// template document (dr-doc's `template:category:<id>` /
/// `template:storyline:<id>`) the way a body is: headings, marks, entity
/// links, tables. F3 copies a registered template document into new
/// elements and chapters; the field stays on the book document as it was,
/// read only. An empty field (`{}`, or nothing but empty paragraphs) is no
/// template. The import peer is deterministic, so a book carried on after
/// an interruption stores the same updates again without change. Returns
/// how many were written.
fn write_templates(
    lib: &Library,
    book: &str,
    rows: &BookRows,
    span: &dyn Fn(&str) -> Option<BlockSpan>,
    ts: i64,
    notes: &mut Notes,
) -> Result<usize> {
    let owners = rows
        .categories
        .iter()
        .filter_map(|c| {
            let id = CategoryId::parse(&c.id).ok()?;
            Some((TemplateOwner::Category(id), c.template_json.as_deref()?))
        })
        .chain(rows.storylines.iter().filter_map(|s| {
            let id = StorylineId::parse(&s.id).ok()?;
            Some((TemplateOwner::Storyline(id), s.template.as_str()))
        }));
    let mut written = 0;
    for (owner, json) in owners {
        let json = json.trim();
        if json.is_empty() || json == "{}" {
            continue;
        }
        let Ok(lines) = pm::parse(json) else {
            notes.add("template-unreadable");
            continue;
        };
        let blocks = prose::doc_blocks(&lines);
        let ctx = Context {
            profile: ProseProfile::Prose,
            span,
            todo: &|_| None,
        };
        let planned = prose::plan(&lines, &blocks, &ctx);
        if planned.paras.iter().all(Para::is_empty) {
            continue;
        }
        notes.merge(&planned.notes);
        let doc_id = owner.doc_id();
        let id_s = doc_id.to_string();
        let mut doc = ProseDoc::create(doc_id.clone(), import_peer(&id_s))?;
        let (r, _) = doc.edit_at(Origin::Import, Some(ts), |t| write::sync(t, &planned.paras));
        r?;
        let (r, _) = doc.edit_at(Origin::Repair, Some(ts), |t| t.repair_block_ids());
        r?;
        let bytes = doc.export_updates_since(&VersionVector::default())?;
        store_doc(lib, &doc_id, book, dr_doc::prose::genesis(&doc_id), bytes)?;
        written += 1;
    }
    Ok(written)
}

/// Bodies and assets of each book, for the overall estimate.
fn book_units(legacy: &Legacy, owners: &[ProseOwner]) -> HashMap<String, u64> {
    let mut units: HashMap<String, u64> = HashMap::new();
    for o in owners {
        *units.entry(o.project_id.clone()).or_default() += 1;
    }
    if let Ok(mut stmt) = legacy
        .conn
        .prepare("SELECT project_id, count(*) FROM project_asset GROUP BY project_id")
        && let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
    {
        for (p, n) in rows.flatten() {
            *units.entry(p).or_default() += n.max(0) as u64;
        }
    }
    units
}

/// Import the 0.1 library at `source` into the 0.2 library at `target`.
pub fn import(source: &Path, target: &Path, options: &Options) -> Result<(Outcome, Timing)> {
    import_with(source, target, options, &mut |_| {})
}

/// [`import`], reporting what it is doing to `progress`.
pub fn import_with(
    source: &Path,
    target: &Path,
    options: &Options,
    progress: Callback<'_>,
) -> Result<(Outcome, Timing)> {
    let mut reporter = Reporter::new(progress);
    let started = Instant::now();
    let mut timing = Timing::default();
    let analysed = match stage_and_gate(source, target, options, &mut reporter, &mut timing)? {
        Gated::Clear(a) => a,
        stopped => {
            if !options.keep_staging {
                // A library folder this import made, and nothing else.
                let _ = std::fs::remove_dir(target);
            }
            return Ok((stopped.outcome(), timing));
        }
    };
    let adopted = match &options.device_dir {
        Some(dir) => adopt_identity(options.old_root.as_deref(), dir),
        None => false,
    };
    let library_options = || -> Result<LibraryOptions> {
        let mut o = LibraryOptions::new(options.app_version.clone());
        o.configure_doc = Some(std::sync::Arc::new(dr_doc::schema::configure));
        if let Some(dir) = &options.device_dir {
            o.device = Some(Device::open(dir)?);
        }
        Ok(o)
    };
    let lib = Library::open(target, library_options()?)?;
    let written = write_library(&lib, analysed, options, adopted, &mut reporter, &mut timing)?;
    lib.close()?;
    let receipt = finish(target, written, options, &mut timing)?;
    if options.index && !options.cancel.now_requested() {
        let t9 = Instant::now();
        let mut o = library_options()?;
        dr_index::attach(&mut o);
        o.rebuild_indexes_on_open = false;
        let lib = reopen(target, o)?;
        timing.indexed_docs = build_indexes(&lib, &mut reporter)?;
        lib.close()?;
        timing.index_ms = ms(t9);
    }
    reporter.done();
    timing.total_ms = ms(started);
    Ok((Outcome::Imported(receipt), timing))
}

/// [`import_with`] into a library that is already open (the app's): the
/// same import, written through `lib`, which stays open. The receipt
/// archive and the staging copy go beside it as usual. Indexes are built
/// right away when `lib` has a deriver (the app's does: dr-index through
/// F3); without one dr-store builds them the next time the library opens
/// with a deriver. Once the gate lets it through, the device `lib` was
/// opened with takes over the 0.1 library's installation id
/// (`Library::adopt_installation_id`), so this device's writing days continue
/// under the 0.1 device key; `options.device_dir` is not used.
pub fn import_into_library(
    source: &Path,
    lib: &Library,
    options: &Options,
    progress: Callback<'_>,
) -> Result<(Outcome, Timing)> {
    let mut reporter = Reporter::new(progress);
    let started = Instant::now();
    let mut timing = Timing::default();
    let root = lib.paths().root.clone();
    let analysed = match stage_and_gate(source, &root, options, &mut reporter, &mut timing)? {
        Gated::Clear(a) => a,
        stopped => return Ok((stopped.outcome(), timing)),
    };
    let adopted = take_over_identity(options.old_root.as_deref(), lib);
    let written = write_library(lib, analysed, options, adopted, &mut reporter, &mut timing)?;
    let receipt = finish(&root, written, options, &mut timing)?;
    if options.index && lib.options().deriver.is_some() && !options.cancel.now_requested() {
        let t9 = Instant::now();
        timing.indexed_docs = build_indexes(lib, &mut reporter)?;
        timing.index_ms = ms(t9);
    }
    reporter.done();
    timing.total_ms = ms(started);
    Ok((Outcome::Imported(receipt), timing))
}

/// The staged and checked 0.1 library, ready to write.
struct Analysed {
    started_ms: i64,
    /// The 0.1 database imported (recorded in the receipt).
    source: PathBuf,
    staging_dir: PathBuf,
    staged: Staged,
    legacy: Legacy,
    owners: Vec<ProseOwner>,
    gate: Gate,
}

enum Gated {
    Clear(Box<Analysed>),
    Blocked(Gate),
    Cancelled,
}

impl Gated {
    fn outcome(self) -> Outcome {
        match self {
            Gated::Blocked(gate) => Outcome::Blocked(gate),
            Gated::Cancelled | Gated::Clear(_) => Outcome::Cancelled,
        }
    }
}

/// Steps 1 and 2: stage a copy beside the library at `root` and decide the
/// gate. Blocked: nothing is left behind (the staging folder goes, and the
/// receipt folder when it is empty) and the progress is done.
fn stage_and_gate(
    source: &Path,
    root: &Path,
    options: &Options,
    reporter: &mut Reporter<'_>,
    timing: &mut Timing,
) -> Result<Gated> {
    let started = Instant::now();
    let started_ms = dr_store::now_ms();
    let staging_dir = receipt::directory(root).join("staging");
    let (staged, legacy, owners, gate) = analyse_reporting(source, &staging_dir, reporter)?;
    timing.stage_ms = ms(started);
    let cancelled = options.cancel.requested();
    if cancelled || !gate.allows(options.accept) {
        drop(legacy);
        if !options.keep_staging {
            let _ = std::fs::remove_dir_all(&staging_dir);
            let _ = std::fs::remove_dir(receipt::directory(root));
        }
        reporter.done();
        return Ok(if cancelled {
            Gated::Cancelled
        } else {
            Gated::Blocked(gate)
        });
    }
    Ok(Gated::Clear(Box::new(Analysed {
        started_ms,
        source: source.to_path_buf(),
        staging_dir,
        staged,
        legacy,
        owners,
        gate,
    })))
}

/// What [`write_library`] leaves for [`finish`].
struct Written {
    receipt: Box<Receipt>,
    staged: Staged,
    staging_dir: PathBuf,
    settings: BTreeMap<String, String>,
}

/// Steps 3 and 4: every book into `lib`, then the receipt into it.
fn write_library(
    lib: &Library,
    analysed: Box<Analysed>,
    options: &Options,
    adopted: bool,
    reporter: &mut Reporter<'_>,
    timing: &mut Timing,
) -> Result<Written> {
    let Analysed {
        started_ms,
        source,
        staging_dir,
        staged,
        legacy,
        owners,
        gate,
    } = *analysed;
    let run_id = lib.local_transaction(|tx| {
        Ok(receipt::begin_run(
            tx,
            &receipt::RunStart {
                started_ms,
                source_database: &source,
                source_root: options.old_root.as_deref(),
                source_sha256: &staged.source.sha256,
                source_bytes: staged.source.database_bytes + staged.source.wal_bytes,
                schema_level_before: staged.level_before.applied,
                gate: &gate,
                accepted: options.accept,
            },
        )?)
    })?;

    let (_, orphans) = legacy.prose_owners()?;
    let history = legacy.history()?;
    let stamp = legacy.stamp.clone();
    let projects = legacy.projects()?;
    let units = book_units(&legacy, &owners);
    reporter.plan_books(
        projects.len(),
        projects
            .iter()
            .map(|p| units.get(&p.id).copied().unwrap_or(0) + 1)
            .sum(),
    );
    let retention = options.history_retention;
    let mut books = Vec::new();
    let mut docs = Vec::new();
    let mut anchors_out = Vec::new();
    let mut originals = Vec::new();

    for (book_no, project) in projects.iter().enumerate() {
        let book_no = book_no + 1;
        let here = (book_no, project.name.as_str());
        let book_units = units.get(&project.id).copied().unwrap_or(0) + 1;
        let mut rec = BookRecord {
            book_id: project.id.clone(),
            name: project.name.clone(),
            trashed: project.deleted_at.is_some(),
            ..BookRecord::default()
        };
        if options.cancel.requested() {
            rec.status = "cancelled".into();
            books.push(rec);
            reporter.book_done(book_units);
            continue;
        }
        let Ok(book_id) = BookId::parse(&project.id) else {
            rec.status = "invalid-book-id".into();
            books.push(rec);
            reporter.book_done(book_units);
            continue;
        };
        let book_doc_id = DocId::Book(book_id.clone());
        let book_doc_s = book_doc_id.to_string();
        // Imported once on this device: never again (the import peers are
        // deterministic, see m10-import.md 待协调 8). Interrupted on this
        // device: carry on; the documents stored so far take the same
        // updates again without change, and history points are not doubled.
        // In the library without a receipt (synced from another device, or
        // made here): leave it alone.
        let (finished, interrupted) =
            lib.local_read(|c| Ok(receipt::book_state(c, &project.id)?))?;
        let exists = lib.doc_info(&book_doc_s)?.is_some();
        let status = if finished {
            Some("already-imported")
        } else if exists && !interrupted {
            Some("already-in-library")
        } else {
            None
        };
        if let Some(status) = status {
            rec.status = status.into();
            books.push(rec);
            reporter.book_done(book_units);
            continue;
        }
        let resuming = exists || interrupted;
        lib.local_transaction(|tx| {
            Ok(receipt::begin_book(tx, run_id, &project.id, &project.name)?)
        })?;
        let rows = legacy.book(&project.id)?;
        let mut notes = Notes::default();
        // Stopped now (the app quitting): this book stays "importing", and
        // the next import carries it on.
        macro_rules! stop_in_book {
            () => {{
                notes.add("stopped-before-finishing");
                rec.notes = notes;
                rec.status = "importing".into();
                books.push(rec);
                reporter.book_done(book_units);
                continue;
            }};
        }
        if resuming {
            notes.add("resumed-after-interruption");
        }
        // Whether a history point is already there (an interrupted import
        // wrote it): the same label on the same version (and, for the 0.1
        // points, at the same time).
        let has_label = |doc: &str, label: &str, at: &Frontiers, ts: Option<i64>| -> Result<bool> {
            Ok(resuming
                && lib.history(doc)?.iter().any(|l| {
                    l.label == label && l.frontiers == *at && ts.is_none_or(|t| l.ts == t)
                }))
        };
        let empty = BookSettings::default();
        let settings = stamp
            .as_ref()
            .and_then(|s| s.books.get(&project.id))
            .unwrap_or(&empty);

        // Pass 1: every body's lines and block ids.
        let mut bodies: Vec<Body<'_>> = Vec::new();
        for o in owners.iter().filter(|o| o.project_id == project.id) {
            let Ok(doc_id) = DocId::parse(&o.new_doc_id()) else {
                notes.add("invalid-id");
                continue;
            };
            let profile = doc_id.profile().unwrap_or(ProseProfile::Prose);
            let lines = match pm::parse(o.cache.as_deref().unwrap_or("")) {
                Ok(l) => l,
                Err(_) => {
                    notes.add("cache-unreadable");
                    pm::Prose::default()
                }
            };
            let blocks = prose::doc_blocks(&lines);
            let old = o.old_doc_id();
            let mut hist: Vec<&HistoryRow> =
                history.iter().filter(|h| h.old_doc_id() == old).collect();
            hist.sort_by(|a, b| {
                (parse_iso_ms(&a.created_at), &a.id).cmp(&(parse_iso_ms(&b.created_at), &b.id))
            });
            bodies.push(Body {
                owner: o,
                doc_id,
                profile,
                lines,
                blocks,
                history: hist,
            });
        }
        let mut spans: HashMap<String, BlockSpan> = HashMap::new();
        for b in &bodies {
            for id in b.blocks.ranges.keys() {
                if let Some(s) = b.blocks.span(id) {
                    spans.entry(id.clone()).or_insert(s);
                }
            }
        }
        let span = |old: &str| spans.get(old).cloned();

        // Projected TODOs get deterministic ids.
        let mut projected: HashMap<String, (CommentId, ProjectionKind, DocId, BlockId)> =
            HashMap::new();
        for c in &rows.comments {
            let meta: Value = c
                .metadata_json
                .as_deref()
                .and_then(|m| serde_json::from_str(m).ok())
                .unwrap_or(Value::Null);
            let kind = match meta.get("kind").and_then(Value::as_str) {
                Some("todo-autoparse") => ProjectionKind::Marker,
                Some("note-task") => ProjectionKind::NoteTask,
                _ => continue,
            };
            let (Some(tk), Some(tid)) = (c.target_kind.as_deref(), c.target_id.as_deref()) else {
                notes.add("projected-todo-without-target");
                continue;
            };
            let Some(doc) = old_doc_of_target(tk, tid)
                .and_then(|o| {
                    ProseKind::from_doc_id(&o).map(|(k, id)| format!("{}:{id}", k.new_prefix()))
                })
                .and_then(|d| DocId::parse(&d).ok())
            else {
                notes.add("projected-todo-without-target");
                continue;
            };
            let old_block = meta
                .get("blockId")
                .and_then(Value::as_str)
                .or(c.target_block_id.as_deref());
            let Some(block) = old_block.and_then(|b| {
                span(b)
                    .and_then(|s| s.first)
                    .or_else(|| BlockId::parse(b).ok())
            }) else {
                notes.add("projected-todo-without-block");
                continue;
            };
            let new = CommentId::for_projection(&kind, &doc, &block);
            projected.insert(c.id.clone(), (new, kind, doc, block));
        }
        rec.projected_todos = projected.len();
        let todo = |old: &str| projected.get(old).map(|p| p.0.clone());

        // Pass 2: plan, write, check and store every body, history first.
        let mut anchors_made: HashMap<String, Anchor> = HashMap::new();
        let mut points: Vec<Point> = Vec::new();
        let mut import_points: Vec<(String, Frontiers)> = Vec::new();
        let n_bodies = bodies.len() as u64;
        let mut stopped = false;
        for (body_no, b) in bodies.iter().enumerate() {
            if options.cancel.now_requested() {
                stopped = true;
                break;
            }
            let t0 = Instant::now();
            let ctx = Context {
                profile: b.profile,
                span: &span,
                todo: &todo,
            };
            let current = prose::plan(&b.lines, &b.blocks, &ctx);
            let mut versions: Vec<(Plan, &HistoryRow, i64)> = Vec::new();
            for h in &b.history {
                let Some(preview) = h.preview.as_deref() else {
                    notes.add("history-row-without-preview");
                    continue;
                };
                let Ok(lines) = pm::parse(preview) else {
                    notes.add("history-preview-unreadable");
                    continue;
                };
                let blocks = prose::doc_blocks(&lines);
                let ts = parse_iso_ms(&h.created_at).unwrap_or(0);
                versions.push((prose::plan(&lines, &blocks, &ctx), h, ts));
            }
            let final_ms = parse_iso_ms(&b.owner.updated_at)
                .unwrap_or(0)
                .max(versions.last().map_or(0, |v| v.2));
            let id_s = b.doc_id.to_string();
            let owner = Owner::of(b.owner.kind, &b.owner.id);
            let mut doc = ProseDoc::create(b.doc_id.clone(), import_peer(&id_s))?;
            let first_point = points.len();
            for (p, h, ts) in &versions {
                let (r, _) = doc.edit_at(Origin::Import, Some(secs(*ts)), |t| {
                    write::sync(t, &p.paras)
                });
                r?;
                let parsed = h.meta.as_deref().and_then(meta::parse);
                if h.meta.is_some() && parsed.is_none() {
                    notes.add("history-meta-unreadable");
                }
                points.push(Point {
                    doc_id: id_s.clone(),
                    row_id: h.id.clone(),
                    ts_ms: *ts,
                    frontiers: doc.frontiers(),
                    owner: owner.clone(),
                    meta: parsed,
                });
            }
            let (r, _) = doc.edit_at(Origin::Import, Some(secs(final_ms)), |t| {
                write::sync(t, &current.paras)
            });
            r?;
            let back: Vec<Para> = read::read_paras(&doc.view());
            let stored_exactly = back == current.paras;
            let round_trips = prose::round_trips(&back, b.profile);
            if options.verify_history && !versions.is_empty() {
                // Every version checks out on a detached copy.
                let bytes = vec![doc.export_snapshot()?];
                for (n, (p, _, _)) in versions.iter().enumerate() {
                    let at = &points[first_point + n].frontiers;
                    let copy = dr_doc::prose::ProseReader::load_at(b.doc_id.clone(), &bytes, at)?;
                    if read::read_paras(&copy.view()) != p.paras {
                        notes.add("history-version-differs");
                    }
                }
            }
            // Anchors on this body (comments and patches), on the current version.
            let old = b.owner.old_doc_id();
            {
                let starts = current.starts();
                let view = doc.view();
                let mut make =
                    |entity: &'static str,
                     id: &str,
                     resolved: (Resolution, Option<anchors::BodyRange>)| {
                        let (resolution, range) = resolved;
                        let range = range.filter(|r| !r.is_empty());
                        let resolution = if range.is_none() && resolved_some(resolution) {
                            Resolution::Empty
                        } else {
                            resolution
                        };
                        let made = range.as_ref().and_then(|r| {
                            let a = view.anchor(r.clone())?;
                            let back = view.resolve(&a)?;
                            (back.range == *r).then_some(a)
                        });
                        let cursor = made.is_some();
                        if let Some(a) = made {
                            anchors_made.insert(id.to_string(), a);
                        }
                        anchors_out.push(AnchorRecord {
                            entity,
                            id: id.to_string(),
                            doc_id: id_s.clone(),
                            resolution,
                            cursor,
                        });
                        cursor
                    };
                for c in &rows.comments {
                    if c.target_kind
                        .as_deref()
                        .zip(c.target_id.as_deref())
                        .and_then(|(k, i)| old_doc_of_target(k, i))
                        .as_deref()
                        != Some(old.as_str())
                    {
                        continue;
                    }
                    if projected.contains_key(&c.id) {
                        // A projected TODO's position is its block.
                        continue;
                    }
                    let a = anchors::parse_anchor(&c.anchor_json);
                    let ids: Vec<String> =
                        serde_json::from_str::<Vec<String>>(&c.target_block_ids_json)
                            .ok()
                            .filter(|v| !v.is_empty())
                            .or_else(|| c.target_block_id.clone().map(|b| vec![b]))
                            .unwrap_or_default();
                    let resolved = match &a.text {
                        Some(t) => anchors::resolve_text(&b.lines, &current, &starts, t),
                        None if !ids.is_empty() => {
                            anchors::resolve_blocks(&b.lines, &current, &starts, &ids)
                        }
                        None => continue,
                    };
                    if make("comment", &c.id, resolved) {
                        rec.anchors_with_cursors += 1;
                    } else {
                        rec.anchors_without_cursors += 1;
                    }
                }
                if b.owner.kind == ProseKind::NodeContent {
                    for p in rows
                        .patches
                        .iter()
                        .filter(|p| p.source_node.as_deref() == Some(b.owner.id.as_str()))
                    {
                        let resolved = match p
                            .text_anchor_json
                            .as_deref()
                            .and_then(|j| serde_json::from_str::<Value>(j).ok())
                            .and_then(|v| anchors::parse_text_anchor(&v))
                        {
                            Some(t) => anchors::resolve_text(&b.lines, &current, &starts, &t),
                            None => match &p.source_block {
                                Some(sb) => anchors::resolve_blocks(
                                    &b.lines,
                                    &current,
                                    &starts,
                                    std::slice::from_ref(sb),
                                ),
                                None => continue,
                            },
                        };
                        if make("patch", &p.id, resolved) {
                            rec.anchors_with_cursors += 1;
                        } else {
                            rec.anchors_without_cursors += 1;
                        }
                    }
                }
            }
            // Duplicate block ids from the 0.1 data, fixed the dr-doc way.
            let (repaired, _) = doc.edit_at(Origin::Repair, Some(secs(final_ms)), |t| {
                t.repair_block_ids()
            });
            let repaired = repaired?;
            import_points.push((id_s.clone(), doc.frontiers()));
            let bytes = doc.export_updates_since(&VersionVector::default())?;
            timing.prose_ms += ms(t0);
            let t1 = Instant::now();
            store_doc(
                lib,
                &b.doc_id,
                &project.id,
                dr_doc::prose::genesis(&b.doc_id),
                bytes,
            )?;
            timing.store_ms += ms(t1);
            let mut doc_notes = current.notes.clone();
            notes.merge(&doc_notes);
            if repaired > 0 {
                doc_notes.add("block-id-assigned");
            }
            rec.history_points += versions.len();
            docs.push(DocRecord {
                doc_id: id_s,
                old_doc_id: old,
                book_id: project.id.clone(),
                kind: b.owner.kind,
                freshness: b.owner.freshness,
                revision: b.owner.revision,
                cache_sha256: b.owner.cache_sha256(),
                history_versions: versions.len(),
                paragraphs: back.len(),
                chars: back.iter().map(Para::len).sum(),
                stored_exactly,
                round_trips,
                repaired_block_ids: repaired,
                notes: doc_notes,
                dropped_inline: current.dropped_inline.clone(),
            });
            let done = body_no as u64 + 1;
            reporter.book_step(Step::Bodies, here, done, n_bodies, done);
        }
        rec.bodies = bodies.len();
        if stopped || options.cancel.now_requested() {
            stop_in_book!();
        }
        // Body templates, written when the book was last changed (0.1 kept
        // no time for them).
        let t0 = Instant::now();
        let changed = secs(parse_iso_ms(&project.updated_at).unwrap_or(0));
        rec.templates = write_templates(lib, &project.id, &rows, &span, changed, &mut notes)?;
        timing.prose_ms += ms(t0);

        // The book document, with the snapshot history's metadata replayed:
        // stored after each history row, so every point is labelled while
        // its version is the stored head (`meta.rs`).
        points.sort_by(|a, b| (a.ts_ms, &a.row_id).cmp(&(b.ts_ms, &b.row_id)));
        let mut currents: BTreeMap<Owner, Fields> = BTreeMap::new();
        let mut steps: Vec<Option<(Owner, Fields)>> = Vec::with_capacity(points.len());
        for p in &points {
            let (Some(o), Some(m)) = (&p.owner, &p.meta) else {
                steps.push(None);
                continue;
            };
            if !currents.contains_key(o) {
                match meta::current(o, &rows) {
                    Some(f) => {
                        currents.insert(o.clone(), f);
                    }
                    None => {
                        notes.add("history-meta-entity-missing");
                        steps.push(None);
                        continue;
                    }
                }
            }
            steps.push(Some((o.clone(), meta::historical(o, m, &currents[o]))));
        }
        let book_ts = secs(parse_iso_ms(&project.updated_at).unwrap_or(0));
        let first_ts = points
            .iter()
            .zip(&steps)
            .find(|(_, s)| s.is_some())
            .map(|(p, _)| secs(p.ts_ms));
        let base_ts = first_ts.map_or(book_ts, |t| t.min(book_ts));
        let final_ts = points
            .last()
            .map_or(book_ts, |p| secs(p.ts_ms).max(book_ts));

        let t2 = Instant::now();
        let mut bdoc = BookDoc::create(book_id.clone(), import_peer(&book_doc_s))?;
        let inputs = book::Inputs {
            book: &book_id,
            project,
            rows: &rows,
            settings: Some(settings),
            projected: &projected,
            anchors: &anchors_made,
            span: &span,
        };
        // Each entity with history starts as its earliest row has it.
        let mut state: BTreeMap<Owner, Fields> = BTreeMap::new();
        for (o, step) in steps.iter().flatten() {
            if !state.contains_key(o) {
                state.insert(o.clone(), currents[o].then(step));
            }
        }
        let (r, _) = bdoc.edit_at(Origin::Import, Some(base_ts), |t| {
            let originals = book::write(t, &inputs, &mut notes)?;
            for (o, earliest) in &state {
                meta::apply(t, o, earliest, &currents[o])?;
            }
            Ok(originals)
        });
        for (c, id, f, json) in r? {
            originals.push((c.to_string(), id, f.to_string(), json));
        }
        timing.book_ms += ms(t2);

        let t3 = Instant::now();
        let bh = open_new(
            lib,
            &book_doc_id,
            &project.id,
            dr_doc::book::genesis(&book_id),
        )?;
        let mut stored = VersionVector::default();
        let push = |bdoc: &BookDoc, stored: &mut VersionVector| -> Result<()> {
            let now = bdoc.version();
            if now != *stored {
                import_into(&bh, &book_doc_s, bdoc.export_updates_since(stored)?)?;
                *stored = now;
            }
            Ok(())
        };
        push(&bdoc, &mut stored)?;
        timing.store_ms += ms(t3);
        let mut expected: Vec<(Frontiers, Owner, Fields)> = Vec::new();
        let n_points = points.len() as u64;
        reporter.book_step(Step::Book, here, 0, n_points, n_bodies);
        for (i, (p, step)) in points.iter().zip(&steps).enumerate() {
            if let Some((o, f)) = step {
                let t = Instant::now();
                let before = state[o].clone();
                let (r, _) = bdoc.edit_at(Origin::Import, Some(secs(p.ts_ms)), |t| {
                    meta::apply(t, o, f, &before)
                });
                r?;
                let after = before.then(f);
                state.insert(o.clone(), after.clone());
                timing.book_ms += ms(t);
                let t = Instant::now();
                push(&bdoc, &mut stored)?;
                timing.store_ms += ms(t);
                rec.history_meta_replayed += 1;
                expected.push((bdoc.frontiers(), o.clone(), after));
            }
            let t = Instant::now();
            let periodic = dr_store::history::labels::PERIODIC;
            if !has_label(&p.doc_id, periodic, &p.frontiers, Some(p.ts_ms))? {
                lib.label_at(&p.doc_id, &p.frontiers, periodic, p.ts_ms, retention)?;
            }
            timing.labels_ms += ms(t);
            reporter.book_step(Step::Book, here, i as u64 + 1, n_points, n_bodies);
        }
        // The current fields back, then the book's own repairs.
        let t4 = Instant::now();
        let (r, _) = bdoc.edit_at(Origin::Import, Some(final_ts), |t| {
            for (o, was) in &state {
                meta::apply(t, o, &currents[o], was)?;
            }
            Ok(())
        });
        r?;
        let (r, _) = bdoc.edit_at(Origin::Repair, Some(final_ts), |t| {
            let plan = t.view().repair_plan();
            t.apply_repair(&plan)
        });
        r?;
        timing.book_ms += ms(t4);
        let t5 = Instant::now();
        push(&bdoc, &mut stored)?;
        bh.close();
        timing.store_ms += ms(t5);
        if options.verify_history && !expected.is_empty() {
            let snapshot = vec![bdoc.export_snapshot()?];
            for (at, o, want) in &expected {
                let reader = BookReader::load_at(book_id.clone(), &snapshot, at)?;
                if meta::holds(&reader.view(), o, want) {
                    rec.history_meta_checked += 1;
                } else {
                    notes.add("history-meta-differs");
                }
            }
        }
        // The version as imported, on every body.
        let t6 = Instant::now();
        let mut labels: Vec<NewLabel<'_>> = Vec::with_capacity(import_points.len());
        for (doc_id, frontiers) in &import_points {
            if !has_label(doc_id, IMPORT_LABEL, frontiers, None)? {
                labels.push(NewLabel {
                    doc_id,
                    frontiers,
                    label: IMPORT_LABEL,
                    ts_ms: started_ms,
                    retention,
                });
            }
        }
        lib.label_many(&labels)?;
        timing.labels_ms += ms(t6);

        // Asset bytes.
        let t7 = Instant::now();
        let copied_all = copy_assets(
            lib,
            options.old_root.as_deref(),
            &project.id,
            &rows.assets,
            &mut rec,
            &mut notes,
            &mut |done, total| {
                reporter.book_step(Step::Assets, here, done, total, n_bodies + done);
                !options.cancel.now_requested()
            },
        )?;
        timing.assets_ms += ms(t7);
        if !copied_all {
            stop_in_book!();
        }

        rec.rows = [
            ("book_node", rows.nodes.len()),
            ("book_act", rows.acts.len()),
            ("storylines", rows.storylines.len()),
            ("element", rows.elements.len()),
            ("element_category", rows.categories.len()),
            ("entity_kv_entry", rows.kv.len()),
            ("entity_relation_type", rows.relation_types.len()),
            ("entity_relation", rows.relations.len()),
            ("timeline_marker", rows.time_pins.len()),
            ("plot_grid_document", rows.plot_docs.len()),
            ("comment", rows.comments.len()),
            ("comment_action", rows.comment_actions.len()),
            ("element_patch", rows.patches.len()),
            ("library_item", rows.materials.len()),
            ("material_folder", rows.folders.len()),
            ("drift_group", rows.groups.len()),
            ("agent_memory", rows.memory.len()),
            ("writing_day", rows.writing_days.len()),
            ("project_asset", rows.assets.len()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        rec.notes = notes;
        rec.status = "imported".into();
        books.push(rec);
        reporter.book_done(book_units);
    }

    reporter.finishing();
    let t8 = Instant::now();
    let counts = legacy.table_counts()?;
    let pick = |tables: &[&str]| -> BTreeMap<String, i64> {
        tables
            .iter()
            .map(|t| (t.to_string(), counts.get(*t).copied().unwrap_or(0)))
            .collect()
    };
    let receipt = Receipt {
        importer: IMPORTER,
        started_ms,
        finished_ms: dr_store::now_ms(),
        source_sha256: staged.source.sha256.clone(),
        source_bytes: staged.source.database_bytes + staged.source.wal_bytes,
        schema_level_before: staged.level_before.applied,
        gate,
        accepted: options.accept,
        books,
        docs,
        anchors: anchors_out,
        originals,
        orphan_yjs_docs: orphans.owner_missing + orphans.unknown_prefix,
        archived_rows: pick(receipt::AGENT_ARCHIVE),
        local_rows: pick(receipt::LOCAL),
        installation_id_adopted: adopted,
        history_retention: match retention {
            LabelRetention::Kept => "kept",
            LabelRetention::Thinned => "thinned",
        },
        cancelled: options.cancel.requested(),
    };
    lib.local_transaction(|tx| Ok(receipt::write_records(tx, run_id, &receipt)?))?;
    let settings = stamp.map(|s| s.settings).unwrap_or_default();
    drop(legacy);
    timing.receipt_ms = ms(t8);
    Ok(Written {
        receipt: Box::new(receipt),
        staged,
        staging_dir,
        settings,
    })
}

/// Step 5's rest: the archive and the summary beside the library at
/// `root`; the staging copy goes.
fn finish(
    root: &Path,
    written: Written,
    options: &Options,
    timing: &mut Timing,
) -> Result<Box<Receipt>> {
    let t = Instant::now();
    receipt::write_archive(
        root,
        &written.staged.path,
        &written.receipt,
        &written.settings,
    )?;
    timing.receipt_ms += ms(t);
    if !options.keep_staging {
        let _ = std::fs::remove_dir_all(&written.staging_dir);
    }
    Ok(written.receipt)
}

/// Open the library this import has just closed. dr-store sometimes still
/// holds its lock for a moment after `Library::close` returns when other
/// threads are busy (`m10-import.md` 待协调 12), so an "already open" is
/// retried for up to two seconds.
fn reopen(target: &Path, options: LibraryOptions) -> Result<Library> {
    let started = Instant::now();
    loop {
        match Library::open(target, options.clone()) {
            Err(e)
                if e.to_string().contains("already open")
                    && started.elapsed() < std::time::Duration::from_secs(2) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            r => return Ok(r?),
        }
    }
}

/// Derive every document's index that is missing or behind, on a few
/// threads (deriving is independent per document; dr-store serialises the
/// reads and writes). Returns how many were written.
fn build_indexes(lib: &Library, reporter: &mut Reporter<'_>) -> Result<usize> {
    let stale = lib.stale_index_docs()?;
    let total = stale.len() as u64;
    reporter.indexing(0, total);
    if stale.is_empty() {
        return Ok(0);
    }
    let threads = std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .clamp(1, 8)
        .min(stale.len());
    let next = AtomicUsize::new(0);
    let (tx, rx) = std::sync::mpsc::channel::<dr_store::Result<bool>>();
    let mut written = 0;
    let mut failed: Option<dr_store::StoreError> = None;
    std::thread::scope(|s| {
        for _ in 0..threads {
            let tx = tx.clone();
            let lib = lib.clone();
            let (next, stale) = (&next, &stale);
            s.spawn(move || {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(doc) = stale.get(i) else {
                        break;
                    };
                    if tx.send(lib.reindex_doc(doc)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);
        for (n, r) in rx.iter().enumerate() {
            match r {
                Ok(true) => written += 1,
                Ok(false) => {}
                Err(e) => {
                    failed.get_or_insert(e);
                }
            }
            reporter.indexing(n as u64 + 1, total);
        }
    });
    match failed {
        Some(e) => Err(e.into()),
        None => Ok(written),
    }
}

/// The history label on the version as imported.
pub const IMPORT_LABEL: &str = "import";

fn resolved_some(r: Resolution) -> bool {
    matches!(
        r,
        Resolution::Exact
            | Resolution::Relocated
            | Resolution::TextChanged
            | Resolution::WholeBlock
            | Resolution::SomeBlocksMissing
    )
}

fn copy_assets(
    lib: &Library,
    old_root: Option<&Path>,
    book: &str,
    assets: &[crate::legacy::AssetRow],
    rec: &mut BookRecord,
    notes: &mut Notes,
    // Reports `(done, total)` before each file; `false`: stop now.
    progress: &mut dyn FnMut(u64, u64) -> bool,
) -> Result<bool> {
    use sha2::{Digest, Sha256};
    let Some(root) = old_root else {
        if !assets.is_empty() {
            notes.add("asset-bytes-not-copied");
        }
        return Ok(true);
    };
    let total = assets.len() as u64;
    for (n, a) in assets.iter().enumerate() {
        if !progress(n as u64, total) {
            return Ok(false);
        }
        let dir = root
            .join("assets")
            .join(dr_store::asset::sanitized_segment(book)?)
            .join(dr_store::asset::sanitized_segment(&a.id)?);
        let source = std::fs::read_dir(&dir).ok().and_then(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .find(|p| p.file_stem().is_some_and(|s| s == "source") && p.is_file())
        });
        let Some(source) = source else {
            rec.assets_missing += 1;
            continue;
        };
        if lib
            .asset(&a.id, dr_store::asset::Variant::Source)?
            .is_some_and(|r| r.sha256 == a.sha256)
        {
            // Already copied (an interrupted import carrying on).
            rec.assets_copied += 1;
            continue;
        }
        let bytes = std::fs::read(&source)?;
        let sha: String = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if sha != a.sha256 || bytes.len() as i64 != a.size {
            rec.assets_mismatched += 1;
            continue;
        }
        let ext = source
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_ascii_lowercase();
        let dims = match (a.width, a.height) {
            (Some(w), Some(h)) if w > 0 && h > 0 => Some((w as u32, h as u32)),
            _ => None,
        };
        lib.import_asset(&dr_store::asset::SourceImport {
            book_id: book,
            asset_id: &a.id,
            source: &source,
            mime: &a.mime,
            ext: &ext,
            dimensions: dims,
            limit: 512 * 1024 * 1024,
        })?;
        rec.assets_copied += 1;
    }
    if total > 0 {
        progress(total, total);
    }
    Ok(true)
}
