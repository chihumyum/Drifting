//! The aging suites: what a long history costs.
//!
//! - `chapter-aging`: the seed's longest chapter as it is, then aged
//!   ([`crate::aging::chapter`]) to histories of growing size. Each tier is
//!   measured twice: through dr-doc alone (load, read, one keystroke, the
//!   author's undo and redo: [`dr_doc::undo::ProseUndo`]), and through the
//!   real storage and workspace (a library holding the book document and the
//!   chapter; `Library::load_copy`, a holder opened and closed, a
//!   `Workspace::prose_session` opened, its edits, undo and redo, a
//!   compaction).
//! - `book-aging`: the seed's book document as it is, then used for one and
//!   for three years ([`crate::aging::book`]): its snapshot, load, the
//!   structure snapshot, `Workspace::observe`, a writing-day write, and what
//!   a sync would upload per day.
//!
//! Quick mode runs small tiers on the tiny seed and pins their shapes; full
//! mode is the heavy seed (a 20 000-character chapter, a 680-document book).
//! Heap numbers are recorded only when the program installed a heap probe
//! ([`set_heap_probe`]: `examples/aging-bench.rs` does).
//!
//! See `docs/rust-rewrite/spikes/history-aging.md`.

use std::sync::OnceLock;

use super::*;
use crate::aging::book::{self, BookAging, Kind};
use crate::aging::chapter::{self, ChapterAging, Mix};
use crate::aging::{self, HistoryShape};
use crate::rng::Rng;
use crate::seed::{self, DEFAULT_SEED};
use dr_doc::prose::ProseDoc;
use dr_doc::v3::novel::TPL_CHAPTER;
use dr_doc::v3::{BookDocV3, genesis_v3};
use dr_model::{DocId, Origin};
use dr_workspace::{Actor, ProseSession, Workspace};

/// Reads the program's heap: live bytes now, and the peak since the last
/// reset. A counting global allocator provides it.
#[derive(Clone, Copy)]
pub struct HeapProbe {
    pub live: fn() -> usize,
    pub reset_peak: fn(),
    pub peak: fn() -> usize,
}

static HEAP: OnceLock<HeapProbe> = OnceLock::new();

/// Install the heap probe (once, before running a suite).
pub fn set_heap_probe(probe: HeapProbe) {
    let _ = HEAP.set(probe);
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

const APP: &str = "0.2.0-bench";

/// A library that never compacts by itself: the suites compact when they
/// mean to, and a measured write is never also a snapshot.
pub fn open_workspace(dir: &Path) -> Result<Workspace, String> {
    let mut options = dr_workspace::library_options(APP);
    options.compaction.max_updates = usize::MAX;
    options.compaction.max_bytes = usize::MAX;
    options.compaction.on_close_min_updates = usize::MAX;
    // Nothing here searches; a background index rebuild would only add noise.
    options.rebuild_indexes_on_open = false;
    let lib = dr_store::Library::open(dir, options).map_err(err)?;
    Workspace::open(lib, dr_workspace::WorkspaceOptions::default()).map_err(err)
}

pub mod chapter_suite {
    use super::*;

    pub fn suite() -> Suite {
        Suite {
            name: "chapter-aging",
            about: "a chapter with a long history: load, read, keystroke, the author's undo and redo, through dr-doc and through storage and a workspace session",
            inputs: &[
                "crates/dr-doc",
                "crates/dr-store",
                "crates/dr-workspace",
                "crates/dr-testkit/src/aging.rs",
                "crates/dr-testkit/src/aging",
                "crates/dr-testkit/src/bench/aging.rs",
            ],
            run,
            expect_quick,
        }
    }

    fn expect_quick() -> Value {
        json!({"devices12k": {"burst": 20, "changes": 9, "chars": 1318, "commits": 1977, "concurrentSessions": 0, "days": 11, "devices": 3, "keystrokes": 20, "opRuns": 882, "ops": 12044, "peers": 5, "sessions": 3, "undoBursts": 2, "undoItems": 5}, "fresh": {"burst": 20, "changes": 3, "chars": 1318, "keystrokes": 20, "opRuns": 71, "ops": 1380, "peers": 2, "undoBursts": 2, "undoItems": 5}, "ops4k": {"burst": 20, "changes": 5, "chars": 1318, "commits": 645, "concurrentSessions": 0, "days": 5, "devices": 1, "keystrokes": 20, "opRuns": 302, "ops": 4798, "peers": 3, "sessions": 2, "undoBursts": 2, "undoItems": 5}})
    }

    /// The tiers: a name and how to age (`None`: the seed as it is).
    fn tiers(mode: Mode) -> Vec<(&'static str, Option<ChapterAging>)> {
        match mode {
            Mode::Quick => vec![
                ("fresh", None),
                ("ops4k", Some(ChapterAging::revision(4_000))),
                ("devices12k", Some(ChapterAging::devices(12_000))),
            ],
            Mode::Full => vec![
                ("fresh", None),
                ("ops50k", Some(ChapterAging::revision(50_000))),
                ("ops150k", Some(ChapterAging::revision(150_000))),
                ("ops375k", Some(ChapterAging::revision(375_000))),
                ("devices150k", Some(ChapterAging::devices(150_000))),
                (
                    "scattered150k",
                    Some(ChapterAging {
                        mix: Mix::SCATTERED,
                        ..ChapterAging::revision(150_000)
                    }),
                ),
            ],
        }
    }

    /// Items in one burst of typing undone together.
    const BURST: usize = 20;

    pub fn run(mode: Mode) -> Result<Bench, String> {
        let mut bench = Bench::new("chapter-aging", mode);
        let seeded = seed::generate_v3(mode.preset(), DEFAULT_SEED).map_err(err)?;
        let shape = seeded.shape();
        bench.corpus = json!({
            "preset": format!("v3-{}", shape.preset),
            "seed": shape.seed,
            "corpusFingerprint": shape.corpus_fingerprint,
            "machineAtStart": crate::evidence::machine(),
        });
        let book = &seeded.books[0];
        let base = longest_chapter(book)?;
        let scratch = Scratch::new("chapter-aging").map_err(err)?;
        for (name, plan) in tiers(mode) {
            let aged;
            let doc = match &plan {
                Some(plan) => {
                    let t = Instant::now();
                    aged = chapter::age(base, plan).map_err(err)?;
                    eprintln!(
                        "chapter-aging: {name} aged in {:.1} s",
                        t.elapsed().as_secs_f64()
                    );
                    let s = aged.stats;
                    bench
                        .case(name, "")
                        .set("devices", plan.devices)
                        .set("sessions", s.sessions)
                        .set("days", s.days)
                        .set("commits", s.commits)
                        .set("concurrentSessions", s.concurrent_sessions);
                    &aged.doc
                }
                None => base,
            };
            let case = bench.case(
                name,
                "one chapter: its history, then load, read, keystroke, undo and redo through dr-doc (doc*) and through a library and a workspace session (store*, session*)",
            );
            through_doc(case, mode, doc)?;
            through_store(case, mode, &scratch.path().join(name), &book.book, doc)?;
        }
        Ok(bench)
    }

    /// The seed's longest chapter: the document every tier starts from.
    pub fn longest_chapter(book: &seed::SeededBookV3) -> Result<&ProseDoc, String> {
        let chapters: std::collections::BTreeSet<String> = book
            .book
            .view()
            .entries()
            .into_iter()
            .filter(|e| {
                e.template
                    .as_ref()
                    .is_some_and(|t| t.as_str() == TPL_CHAPTER)
            })
            .map(|e| e.id.to_string())
            .collect();
        book.prose
            .iter()
            .filter(|p| match p.doc_id() {
                DocId::Body(b) => chapters.contains(b.entry().as_str()),
                _ => false,
            })
            .max_by_key(|p| p.view().len())
            .ok_or_else(|| "the seed has no chapters".into())
    }

    /// Write every tier's chapter as a Loro snapshot, `<dir>/<tier>.loro`:
    /// the same documents [`run`] measures, for programs that take Loro
    /// bytes (`next/spikes/loro-undo-lab`). Returns how many were written.
    pub fn dump(mode: Mode, dir: &Path) -> Result<usize, String> {
        std::fs::create_dir_all(dir).map_err(err)?;
        let seeded = seed::generate_v3(mode.preset(), DEFAULT_SEED).map_err(err)?;
        let base = longest_chapter(&seeded.books[0])?;
        let tiers = tiers(mode);
        for (name, plan) in &tiers {
            let snapshot = match plan {
                Some(plan) => chapter::age(base, plan).map_err(err)?.doc.export_snapshot(),
                None => base.export_snapshot(),
            }
            .map_err(err)?;
            std::fs::write(dir.join(format!("{name}.loro")), snapshot).map_err(err)?;
        }
        Ok(tiers.len())
    }

    /// dr-doc alone: no storage, no threads.
    fn through_doc(case: &mut Case, mode: Mode, doc: &ProseDoc) -> Result<(), String> {
        let id = doc.doc_id().clone();
        let snapshot = doc.export_snapshot().map_err(err)?;
        let history = HistoryShape::of(&snapshot)?;
        case.set("chars", doc.view().len())
            .set("ops", history.ops)
            .set("changes", history.changes)
            .set("peers", history.peers)
            .set("opRuns", history.op_runs);
        if mode == Mode::Full {
            case.set("snapshotBytes", snapshot.len())
                .set("stateOnlyBytes", history.state_bytes);
        }
        let peer = dr_doc::peer::random_device_peer();
        let load = || ProseDoc::load(id.clone(), peer, std::slice::from_ref(&snapshot));

        for _ in 0..mode.reps(3, 20) {
            let d = case.time("docLoad", load).map_err(err)?;
            case.time("docReadAllFirst", || d.view().paragraphs().count());
        }

        // Heap: the loaded and read document, then what the first undo
        // leaves behind (Loro keeps what it built to replay the history).
        if let (Mode::Full, Some(heap)) = (mode, HEAP.get()) {
            let before = (heap.live)();
            let mut d = load().map_err(err)?;
            d.view().paragraphs().count();
            case.set("heapLoadedBytes", (heap.live)().saturating_sub(before));
            let mut undo = d.undo_manager();
            type_at(&mut d, 0)?;
            (heap.reset_peak)();
            let at_rest = (heap.live)();
            undo.undo(&mut d).map_err(err)?;
            case.set("heapUndoPeakBytes", (heap.peak)().saturating_sub(at_rest))
                .set("heapAfterUndoBytes", (heap.live)().saturating_sub(before));
        }

        // The first undo after a load pays for whatever Loro builds once.
        for _ in 0..mode.reps(2, 5) {
            let mut d = load().map_err(err)?;
            let mut undo = d.undo_manager();
            let middle = d.view().len() / 2;
            type_at(&mut d, middle)?;
            let done = case
                .time("docUndoFirst", || undo.undo(&mut d))
                .map_err(err)?;
            done.ok_or("the first undo undid nothing")?;
        }

        // Undo first, on the history as it was aged: the keystrokes measured
        // further down land all over the chapter and would add to it.
        let mut d = load().map_err(err)?;
        let mut rng = Rng::new(21);
        let mut undo = d.undo_manager();
        let items = mode.reps(5, 30);
        for _ in 0..items {
            let at = rng.range(0, d.view().len() - 2);
            type_at(&mut d, at)?;
            let done = case
                .time("docUndoItem", || undo.undo(&mut d))
                .map_err(err)?;
            done.ok_or("undo undid nothing")?;
            let done = case
                .time("docRedoItem", || undo.redo(&mut d))
                .map_err(err)?;
            done.ok_or("redo redid nothing")?;
        }
        case.set("undoItems", items);

        let bursts = mode.reps(2, 10);
        for _ in 0..bursts {
            let at = rng.range(0, d.view().len() - 2);
            for k in 0..BURST {
                type_at(&mut d, at + k)?;
            }
            let t = Instant::now();
            for _ in 0..BURST {
                undo.undo(&mut d)
                    .map_err(err)?
                    .ok_or("undo undid nothing")?;
            }
            case.sample("docUndoBurst", t.elapsed().as_secs_f64() * 1e3);
            let t = Instant::now();
            for _ in 0..BURST {
                undo.redo(&mut d)
                    .map_err(err)?
                    .ok_or("redo redid nothing")?;
            }
            case.sample("docRedoBurst", t.elapsed().as_secs_f64() * 1e3);
        }
        case.set("undoBursts", bursts).set("burst", BURST);

        // A paragraph selected and deleted, brought back by one undo.
        for _ in 0..mode.reps(2, 10) {
            let at = rng.range(0, d.view().len() - 2);
            let range = d.view().paragraph_at(at).map_err(err)?.range;
            if range.is_empty() {
                continue;
            }
            let (r, _) = d.edit(Origin::User, |t| t.delete(range));
            r.map_err(err)?;
            let done = case.time("docUndoCut", || undo.undo(&mut d)).map_err(err)?;
            done.ok_or("undo undid nothing")?;
        }
        drop(undo);

        let keystrokes = mode.reps(20, 2_000);
        for _ in 0..keystrokes {
            let at = rng.range(0, d.view().len() - 2);
            let (r, c) = case.time("docKeystroke", || {
                d.edit(Origin::User, |t| t.insert_text(at, "字"))
            });
            r.map_err(err)?;
            c.ok_or("a keystroke committed nothing")?;
        }
        case.set("keystrokes", keystrokes);
        Ok(())
    }

    fn type_at(d: &mut ProseDoc, at: usize) -> Result<(), String> {
        let (r, c) = d.edit(Origin::User, |t| t.insert_text(at, "字"));
        r.map_err(err)?;
        c.map(|_| ())
            .ok_or_else(|| "typing committed nothing".into())
    }

    /// The real path: a library with the book document and this chapter,
    /// and a workspace over it.
    fn through_store(
        case: &mut Case,
        mode: Mode,
        dir: &Path,
        book: &BookDocV3,
        doc: &ProseDoc,
    ) -> Result<(), String> {
        let all = Default::default();
        let id = doc.doc_id().to_string();
        let ws = open_workspace(dir)?;
        aging::store(
            ws.library(),
            book.book_id(),
            doc.doc_id(),
            dr_doc::prose::genesis(doc.doc_id()),
            doc.export_updates_since(&all).map_err(err)?,
        )
        .map_err(err)?;
        aging::store(
            ws.library(),
            book.book_id(),
            book.doc_id(),
            genesis_v3(book.book_id()),
            book.export_updates_since(&all).map_err(err)?,
        )
        .map_err(err)?;
        if mode == Mode::Full {
            let (_, bytes) = ws
                .library()
                .snapshot_info(&id)
                .map_err(err)?
                .ok_or("the stored chapter has no snapshot")?;
            case.set("storedSnapshotBytes", bytes);
        }
        ws.shutdown().map_err(err)?;

        // Cold: the workspace reopened, the chapter read from SQLite.
        for _ in 0..mode.reps(2, 5) {
            let ws = open_workspace(dir)?;
            let session = case
                .time("sessionOpen", || ws.prose_session(&id))
                .map_err(err)?;
            drop(session);
            ws.shutdown().map_err(err)?;
        }

        let ws = open_workspace(dir)?;
        let lib = ws.library();
        for _ in 0..mode.reps(3, 20) {
            case.time("storeLoadCopy", || lib.load_copy(&id))
                .map_err(err)?;
        }
        for _ in 0..mode.reps(2, 10) {
            let h = case
                .time("storeOpenHolder", || {
                    lib.open_doc(&id, dr_store::OpenDoc::Existing)
                })
                .map_err(err)?;
            case.time("storeCloseHolder", || h.close());
        }

        let session = ws.prose_session(&id).map_err(err)?;
        let len = || session.reader().view().len();
        let mut rng = Rng::new(23);
        for _ in 0..mode.reps(5, 30) {
            let at = rng.range(0, len() - 2);
            type_in(&session, at)?;
            let done = case
                .time("sessionUndoItem", || session.undo())
                .map_err(err)?;
            if !done {
                return Err("the session's undo undid nothing".into());
            }
            let done = case
                .time("sessionRedoItem", || session.redo())
                .map_err(err)?;
            if !done {
                return Err("the session's redo redid nothing".into());
            }
        }
        for _ in 0..mode.reps(2, 10) {
            let at = rng.range(0, len() - 2);
            for k in 0..BURST {
                type_in(&session, at + k)?;
            }
            let t = Instant::now();
            for _ in 0..BURST {
                session.undo().map_err(err)?;
            }
            case.sample("sessionUndoBurst", t.elapsed().as_secs_f64() * 1e3);
            let t = Instant::now();
            for _ in 0..BURST {
                session.redo().map_err(err)?;
            }
            case.sample("sessionRedoBurst", t.elapsed().as_secs_f64() * 1e3);
        }
        for _ in 0..mode.reps(20, 1_000) {
            let at = rng.range(0, len() - 2);
            case.time("sessionKeystroke", || type_in(&session, at))?;
        }
        let h = lib
            .open_doc(&id, dr_store::OpenDoc::Existing)
            .map_err(err)?;
        // Another device typing in this chapter, arriving by sync while it
        // is open here: one character per update.
        let mut remote = ProseDoc::load(
            doc.doc_id().clone(),
            dr_doc::peer::random_device_peer(),
            &[doc.export_snapshot().map_err(err)?],
        )
        .map_err(err)?;
        for _ in 0..mode.reps(3, 20) {
            let at = rng.range(0, remote.view().len() - 2);
            let (r, c) = remote.edit(Origin::User, |t| t.insert_text(at, "字"));
            r.map_err(err)?;
            let update = c.ok_or("the remote keystroke committed nothing")?.update;
            case.time("storeImportRemote", || {
                h.import(update, dr_store::Origin::Sync)
            })
            .map_err(err)?;
        }
        // What an idle holder does after 200 updates: a full snapshot.
        for _ in 0..mode.reps(2, 5) {
            for _ in 0..50 {
                let at = rng.range(0, len() - 2);
                type_in(&session, at)?;
            }
            case.time("storeCompact", || h.compact_now())
                .map_err(err)?
                .ok_or("nothing to compact")?;
        }
        h.close();
        drop(session);
        ws.shutdown().map_err(err)
    }

    fn type_in(session: &ProseSession, at: usize) -> Result<(), String> {
        session.edit(move |t| t.insert_text(at, "字")).map_err(err)
    }
}

pub mod book_suite {
    use super::*;

    pub fn suite() -> Suite {
        Suite {
            name: "book-aging",
            about: "a book document used for one and three years on two devices: snapshot, load, structure snapshot, Workspace::observe, a writing-day write, uploads per day",
            inputs: &[
                "crates/dr-doc",
                "crates/dr-store",
                "crates/dr-workspace",
                "crates/dr-testkit/src/aging.rs",
                "crates/dr-testkit/src/aging",
                "crates/dr-testkit/src/bench/aging.rs",
            ],
            run,
            expect_quick,
        }
    }

    fn expect_quick() -> Value {
        json!({"days30": {"byKind": {"checkpoint": {"commits": 328}, "comment": {"commits": 59}, "field": {"commits": 61}, "layout": {"commits": 184}, "structure": {"commits": 22}, "timeline": {"commits": 75}, "writingDay": {"commits": 1213}}, "changes": 125, "checkpointsForSiblings": 93, "checkpointsKept": 3, "checkpointsLive": 149, "checkpointsSaved": 328, "checkpointsThinned": 179, "comments": 38, "commentsLive": 44, "commits": 1942, "concurrentSessions": 0, "days": 30, "entries": 33, "entriesCreated": 9, "fieldEdits": 63, "layoutMoves": 213, "opRuns": 4193, "ops": 5999, "peers": 4, "planningSessions": 3, "sessions": 21, "timelineMoves": 75, "uploads": [{"batches": 1942, "cadenceS": 0, "writingDayOnly": 1213}, {"batches": 1614, "cadenceS": 8, "writingDayOnly": 1095}, {"batches": 1529, "cadenceS": 30, "writingDayOnly": 1039}, {"batches": 391, "cadenceS": 300, "writingDayOnly": 161}], "workingDays": 18, "writingDayKeys": 23, "writingDayWrites": 1213}, "fresh": {"changes": 3, "checkpointsLive": 0, "commentsLive": 6, "entries": 24, "opRuns": 1195, "ops": 1519, "peers": 2, "writingDayKeys": 5}})
    }

    fn tiers(mode: Mode) -> Vec<(&'static str, Option<BookAging>)> {
        match mode {
            Mode::Quick => vec![("fresh", None), ("days30", Some(BookAging::days(30)))],
            Mode::Full => vec![
                ("fresh", None),
                ("year1", Some(BookAging::days(365))),
                ("year3", Some(BookAging::days(3 * 365))),
                // The same three years with one kind of write left out: what
                // that kind alone adds to the document.
                (
                    "year3NoWritingDays",
                    Some(BookAging {
                        without_writing_days: true,
                        ..BookAging::days(3 * 365)
                    }),
                ),
                (
                    "year3NoCheckpoints",
                    Some(BookAging {
                        without_checkpoints: true,
                        ..BookAging::days(3 * 365)
                    }),
                ),
                (
                    "year3Neither",
                    Some(BookAging {
                        without_writing_days: true,
                        without_checkpoints: true,
                        ..BookAging::days(3 * 365)
                    }),
                ),
            ],
        }
    }

    /// Sync cadences judged: every commit by itself; every 8 seconds
    /// (dr-sync's `max_debounce_wait`: while the author types, a cycle goes
    /// out that often, and the book rides along when it has changed); every
    /// 30 seconds (its `periodic_interval`); every five minutes.
    const CADENCES_S: [i64; 4] = [0, 8, 30, 300];

    pub fn run(mode: Mode) -> Result<Bench, String> {
        let mut bench = Bench::new("book-aging", mode);
        let seeded = seed::generate_v3(mode.preset(), DEFAULT_SEED).map_err(err)?;
        let shape = seeded.shape();
        bench.corpus = json!({
            "preset": format!("v3-{}", shape.preset),
            "seed": shape.seed,
            "corpusFingerprint": shape.corpus_fingerprint,
            "machineAtStart": crate::evidence::machine(),
        });
        let base = &seeded.books[0].book;
        let scratch = Scratch::new("book-aging").map_err(err)?;
        for (name, plan) in tiers(mode) {
            let aged;
            let doc = match &plan {
                Some(plan) => {
                    let t = Instant::now();
                    aged = book::age(base, plan).map_err(err)?;
                    eprintln!(
                        "book-aging: {name} aged in {:.1} s",
                        t.elapsed().as_secs_f64()
                    );
                    let case = bench.case(name, "");
                    usage(case, mode, &aged);
                    &aged.doc
                }
                None => base,
            };
            let case = bench.case(
                name,
                "one book document: its history and what a sync uploads, then load and the structure snapshot through dr-doc (doc*), and load_copy, Workspace::observe, entry.list and a writing-day write through a library (store*, ws*)",
            );
            through_doc(case, mode, doc)?;
            through_store(case, mode, &scratch.path().join(name), doc)?;
        }
        Ok(bench)
    }

    /// What the aging did, and what a sync would upload (update bytes and
    /// per-day rates in full mode only).
    fn usage(case: &mut Case, mode: Mode, aged: &book::AgedBook) {
        let s = aged.stats;
        case.set("days", s.days)
            .set("workingDays", s.working_days)
            .set("sessions", s.sessions)
            .set("planningSessions", s.planning_sessions)
            .set("concurrentSessions", s.concurrent_sessions)
            .set("commits", s.commits)
            .set("writingDayWrites", s.writing_day_writes)
            .set("checkpointsSaved", s.checkpoints_saved)
            .set("checkpointsThinned", s.checkpoints_thinned)
            .set("checkpointsKept", s.checkpoints_kept)
            .set("checkpointsForSiblings", s.checkpoints_for_siblings)
            .set("fieldEdits", s.field_edits)
            .set("layoutMoves", s.layout_moves)
            .set("timelineMoves", s.timeline_moves)
            .set("comments", s.comments)
            .set("entriesCreated", s.entries_created);
        let mut by_kind = serde_json::Map::new();
        for kind in Kind::ALL {
            let of: Vec<_> = aged.commits.iter().filter(|c| c.kind == kind).collect();
            let mut row = json!({ "commits": of.len() });
            if mode == Mode::Full {
                row["updateBytes"] = json!(of.iter().map(|c| c.bytes as u64).sum::<u64>());
            }
            by_kind.insert(kind.name().into(), row);
        }
        case.set("byKind", Value::Object(by_kind));
        let uploads: Vec<Value> = CADENCES_S
            .iter()
            .map(|&cadence| {
                let u = book::uploads(&aged.commits, cadence);
                let mut row = json!({
                    "cadenceS": u.cadence_s,
                    "batches": u.batches,
                    "writingDayOnly": u.writing_day_only,
                });
                if mode == Mode::Full {
                    row["perWorkingDay"] = json!((u.per_working_day * 10.0).round() / 10.0);
                    row["writingDayOnlyPerWorkingDay"] =
                        json!((u.writing_day_only_per_working_day * 10.0).round() / 10.0);
                }
                row
            })
            .collect();
        case.set("uploads", uploads);
    }

    fn through_doc(case: &mut Case, mode: Mode, doc: &BookDocV3) -> Result<(), String> {
        let book = doc.book_id().clone();
        let snapshot = doc.export_snapshot().map_err(err)?;
        let history = HistoryShape::of(&snapshot)?;
        let view = doc.view();
        case.set("ops", history.ops)
            .set("changes", history.changes)
            .set("peers", history.peers)
            .set("opRuns", history.op_runs)
            .set("entries", view.entries_raw().len())
            .set("writingDayKeys", view.writing_days().len())
            .set("checkpointsLive", view.entry_checkpoints().len())
            .set("commentsLive", view.comments().len());
        if mode == Mode::Full {
            case.set("snapshotBytes", snapshot.len())
                .set("stateOnlyBytes", history.state_bytes);
        }
        let peer = dr_doc::peer::random_device_peer();
        let load = || BookDocV3::load(book.clone(), peer, std::slice::from_ref(&snapshot));
        if let (Mode::Full, Some(heap)) = (mode, HEAP.get()) {
            let before = (heap.live)();
            let d = load().map_err(err)?;
            d.view().structure_snapshot();
            case.set("heapLoadedBytes", (heap.live)().saturating_sub(before));
        }
        for _ in 0..mode.reps(3, 10) {
            let d = case.time("docLoad", load).map_err(err)?;
            let v = d.view();
            case.time("docStructureSnapshotFirst", || v.structure_snapshot());
            case.time("docStructureSnapshot", || v.structure_snapshot());
            case.time("docWritingDays", || v.writing_days().len());
            case.time("docEntryCheckpoints", || v.entry_checkpoints().len());
        }
        // What dr-view-history's automatic checkpoints compute after every
        // book change that touches entries: each entry's owned content,
        // hashed, to find the ones that changed. One sample: on the heavy
        // seed it takes seconds.
        let d = load().map_err(err)?;
        let v = d.view();
        {
            case.time("docEntryOwnersAll", || {
                v.entries_raw()
                    .iter()
                    .filter_map(|e| v.entry_owned_raw_state(&e.id))
                    .map(|state| dr_store::digest::sha256_hex(state.to_string().as_bytes()).len())
                    .sum::<usize>()
            });
        }
        Ok(())
    }

    fn through_store(
        case: &mut Case,
        mode: Mode,
        dir: &Path,
        doc: &BookDocV3,
    ) -> Result<(), String> {
        let book = doc.book_id().to_string();
        let id = doc.doc_id().to_string();
        let ws = open_workspace(dir)?;
        aging::store(
            ws.library(),
            doc.book_id(),
            doc.doc_id(),
            genesis_v3(doc.book_id()),
            doc.export_updates_since(&Default::default()).map_err(err)?,
        )
        .map_err(err)?;
        if mode == Mode::Full {
            let (_, bytes) = ws
                .library()
                .snapshot_info(&id)
                .map_err(err)?
                .ok_or("the stored book has no snapshot")?;
            case.set("storedSnapshotBytes", bytes);
        }
        ws.shutdown().map_err(err)?;

        // Cold: the workspace reopened, the first read of the book.
        for _ in 0..mode.reps(2, 5) {
            let ws = open_workspace(dir)?;
            case.time("wsFirstRead", || {
                ws.read_book_v3(&book, |d, _| Ok(d.len_ops()))
            })
            .map_err(err)?;
            ws.shutdown().map_err(err)?;
        }

        let ws = open_workspace(dir)?;
        let lib = ws.library();
        for _ in 0..mode.reps(3, 10) {
            case.time("storeLoadCopy", || lib.load_copy(&id))
                .map_err(err)?;
            case.time("wsObserve", || ws.observe(&id)).map_err(err)?;
            case.time("wsEntryList", || {
                ws.call(
                    &Actor::User,
                    "entry.list",
                    json!({ "book": book, "all": true, "trashed": true }),
                )
            })
            .map_err(err)?;
            let book_id = doc.book_id().clone();
            case.time("wsStructureSnapshot", || {
                ws.read_book_v3(&book, move |d, _| {
                    let b = dr_doc::v3::BorrowedBookV3::new(d, &book_id)?;
                    Ok(b.view().structure_snapshot())
                })
            })
            .map_err(err)?;
        }
        // The recorder's minute: one device's words for today.
        let device = dr_model::id::DeviceKey::from_installation_id("dr-testkit-aging-bench");
        for k in 0..mode.reps(5, 50) {
            case.time("wsWritingDayRecord", || {
                ws.call(
                    &Actor::User,
                    "writing_day.record",
                    json!({
                        "book": book,
                        "device": device.as_str(),
                        "day": "2031-01-01",
                        "words": 100 + k,
                    }),
                )
            })
            .map_err(err)?;
        }
        let h = lib
            .open_doc(&id, dr_store::OpenDoc::Existing)
            .map_err(err)?;
        // The other device's recorder minute arriving by sync: the holder
        // validates the update against the book, then imports it.
        let mut remote = BookDocV3::load(
            doc.book_id().clone(),
            dr_doc::peer::random_device_peer(),
            &[doc.export_snapshot().map_err(err)?],
        )
        .map_err(err)?;
        let remote_device =
            dr_model::id::DeviceKey::from_installation_id("dr-testkit-aging-remote");
        let day = dr_model::Day::parse("2031-01-01").expect("a valid date");
        for k in 0..mode.reps(3, 20) {
            let (r, c) = remote.edit(Origin::User, |t| {
                t.writing_day(&remote_device, &day, 50 + k as i64)
            });
            r.map_err(err)?;
            let update = c.ok_or("the remote write committed nothing")?.update;
            case.time("storeImportRemote", || {
                h.import(update, dr_store::Origin::Sync)
            })
            .map_err(err)?;
        }
        case.time("storeCompact", || h.compact_now())
            .map_err(err)?
            .ok_or("nothing to compact")?;
        h.close();
        ws.shutdown().map_err(err)
    }
}
