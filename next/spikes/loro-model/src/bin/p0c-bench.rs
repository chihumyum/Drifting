//! P0-C measurements: storage size, cold start, opening a chapter and the
//! whole book, the keystroke write path, compaction, memory growth from
//! import / checkout / fork_at, cursor resolution, Agent write strategies,
//! and the undo cases. Writes `docs/rust-rewrite/acceptance/p0-c-loro-bench.json`.
//!
//! ```text
//! cargo run --release -p loro-model-spike --bin p0c-bench -- [--out <json>] [--scratch <dir>]
//! cargo run --release -p loro-model-spike --bin p0c-bench -- --check [--out <json>]
//! ```
//!
//! Cold-open numbers come from a fresh child process (`open-probe`), so its
//! resident memory is not inflated by generating the seed.

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use loro::{ExportMode, Frontiers, ID, LoroDoc};
use loro_model_spike::agent::{agent_origin, write_forked, write_in_place};
use loro_model_spike::anchor::Anchor;
use loro_model_spike::book::BookIndex;
use loro_model_spike::evidence::{machine, rss_bytes, source_fingerprint, summarize};
use loro_model_spike::ids::Rng;
use loro_model_spike::prose::ProseDoc;
use loro_model_spike::seed::{self, History, Seed, SeedConfig};
use loro_model_spike::store::{Durability, Holder, Store};
use loro_model_spike::undo_cases;
use serde_json::{Value, json};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            let now = LIVE.fetch_add(layout.size(), Relaxed) + layout.size();
            PEAK.fetch_max(now, Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size(), Relaxed);
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        if !p.is_null() {
            if new_size >= layout.size() {
                let now =
                    LIVE.fetch_add(new_size - layout.size(), Relaxed) + new_size - layout.size();
                PEAK.fetch_max(now, Relaxed);
            } else {
                LIVE.fetch_sub(layout.size() - new_size, Relaxed);
            }
        }
        p
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn heap() -> usize {
    LIVE.load(Relaxed)
}
fn reset_peak() {
    PEAK.store(heap(), Relaxed);
}
fn peak() -> usize {
    PEAK.load(Relaxed)
}
fn mb(b: i64) -> f64 {
    (b as f64 / 1_048_576.0 * 100.0).round() / 100.0
}
fn since(h0: usize) -> i64 {
    heap() as i64 - h0 as i64
}
fn ms(t: Instant) -> f64 {
    (t.elapsed().as_secs_f64() * 1000.0 * 1000.0).round() / 1000.0
}

const DEFAULT_OUT: &str = "../docs/rust-rewrite/acceptance/p0-c-loro-bench.json";
const CHURN_DOC: &str = "node:churned-chapter";
const CHURN_CHARS: usize = 20_000;
const CHURN_ROUNDS: usize = 18;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    if args.get(1).map(String::as_str) == Some("open-probe") {
        let v = open_probe(Path::new(&args[2]))?;
        println!("{}", serde_json::to_string(&v)?);
        return Ok(());
    }
    let out = PathBuf::from(flag("--out").unwrap_or_else(|| DEFAULT_OUT.to_string()));
    if args.iter().any(|a| a == "--check") {
        return check(&out);
    }
    let scratch = PathBuf::from(flag("--scratch").unwrap_or_else(|| {
        std::env::temp_dir()
            .join("p0c-bench")
            .to_string_lossy()
            .into()
    }));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch)?;
    let cfg = SeedConfig::heavy();

    let mut seeds = serde_json::Map::new();
    let mut open = serde_json::Map::new();
    for history in [History::Bulk, History::Typed] {
        let label = match history {
            History::Bulk => "bulk",
            History::Typed => "typed",
        };
        let db = scratch.join(format!("{label}.sqlite"));
        let (seed_desc, storage) = generate_and_store(&cfg, history, &db)?;
        seeds.insert(label.into(), seed_desc);
        let mut v = storage;
        let probe = run_child_probe(&db)?;
        v.as_object_mut().unwrap().insert("coldOpen".into(), probe);
        open.insert(label.into(), v);
    }
    let typed_db = scratch.join("typed.sqlite");
    let churn_db = scratch.join("churned.sqlite");
    let churn = churned(&churn_db)?;

    let mut results = serde_json::Map::new();
    results.insert("seed".into(), Value::Object(seeds));
    results.insert("open".into(), Value::Object(open));
    results.insert("churnedChapter".into(), churn);
    results.insert("keystroke".into(), keystrokes(&typed_db, &scratch)?);
    results.insert(
        "memory".into(),
        json!({
            "typedChapter": memory_probes(&typed_db, None)?,
            "churnedChapter": memory_probes(&churn_db, Some(CHURN_DOC))?,
        }),
    );
    results.insert(
        "cursors".into(),
        json!({
            "typedChapter": cursors(&typed_db, "largest_chapter")?,
            "longestDrift": cursors(&typed_db, "longest_drift")?,
            "churnedChapter": cursors(&churn_db, "churned")?,
        }),
    );
    results.insert("agentWrites".into(), agent_writes(&typed_db)?);
    results.insert("undoCases".into(), undo_json());

    let doc = json!({
        "schemaVersion": 1,
        "probe": "P0-C Loro data model",
        "generatedBy": "cargo run --release -p loro-model-spike --bin p0c-bench",
        "sourceFingerprint": source_fingerprint(),
        "loro": "1.17.1",
        "build": if cfg!(debug_assertions) { "debug" } else { "release" },
        "machine": machine(),
        "notes": [
            "Wall-clock timings on the machine above. Heap = bytes live in the Rust global allocator (Loro, SQLite and our read model); RSS from ps.",
            "coldOpen runs in a fresh child process, so its RSS is the cost of the opened documents plus the runtime.",
            "Synthetic deterministic corpus only (corpusSha256); no manuscript text, paths or user data.",
            "CI checks only the fingerprint and the shape (--check), not the timings."
        ],
        "results": Value::Object(results),
    });
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&out, serde_json::to_string_pretty(&doc)? + "\n")?;
    eprintln!("wrote {}", out.display());
    let _ = std::fs::remove_dir_all(&scratch);
    Ok(())
}

fn check(out: &Path) -> Result<()> {
    let text = std::fs::read_to_string(out).with_context(|| format!("read {}", out.display()))?;
    let v: Value = serde_json::from_str(&text)?;
    let fp = v["sourceFingerprint"].as_str().unwrap_or_default();
    if fp != source_fingerprint() {
        bail!(
            "evidence is stale: source fingerprint {fp} != {}",
            source_fingerprint()
        );
    }
    let cfg = SeedConfig::heavy();
    let seeds = &v["results"]["seed"];
    for h in ["bulk", "typed"] {
        let s = &seeds[h];
        if s["chapters"].as_u64() != Some(cfg.chapters as u64)
            || s["chapterChars"].as_u64() != Some(cfg.chapter_chars as u64)
            || s["chapterMax"].as_u64() != Some(cfg.chapter_max as u64)
            || s["elements"].as_u64() != Some(cfg.elements as u64)
            || s["drifts"].as_u64() != Some(cfg.drifts as u64)
            || s["driftMax"].as_u64() != Some(cfg.drift_max as u64)
        {
            bail!("seed shape mismatch in {h}");
        }
    }
    if seeds["bulk"]["corpusSha256"] != seeds["typed"]["corpusSha256"] {
        bail!("bulk and typed seeds must share one corpus");
    }
    for key in [
        "open",
        "churnedChapter",
        "keystroke",
        "memory",
        "cursors",
        "agentWrites",
        "undoCases",
    ] {
        if v["results"].get(key).is_none() {
            bail!("missing results.{key}");
        }
    }
    eprintln!("{} is current", out.display());
    Ok(())
}

fn seed_json(seed: &Seed, gen_ms: f64) -> Value {
    let s = &seed.stats;
    json!({
        "generateMs": gen_ms.round(),
        "chapters": s.chapters, "chapterChars": s.chapter_chars, "chapterMin": s.chapter_min,
        "chapterMax": s.chapter_max, "chapterMedian": s.chapter_median,
        "elements": s.elements, "elementChars": s.element_chars,
        "drifts": s.drifts, "driftChars": s.drift_chars, "driftMax": s.drift_max,
        "materialNotes": s.notes, "materialNoteChars": s.note_chars,
        "storylines": s.storylines, "storylineChars": s.storyline_chars,
        "categories": s.categories, "categoryChars": s.category_chars,
        "comments": s.comments, "commentChars": s.comment_chars,
        "todos": s.todos, "todoChars": s.todo_chars, "anchoredComments": s.anchored_comments,
        "patches": s.patches, "paragraphs": s.paragraphs, "headings": s.headings,
        "entityLinks": s.links, "overlappingLinks": s.overlapping_links, "embeds": s.embeds,
        "relations": s.relations, "chapterCommits": s.commits,
        "proseDocuments": seed.prose.len(),
        "corpusSha256": s.corpus_sha256,
        "bookSha256": s.book_sha256,
    })
}

/// Generate the seed and store each document as one snapshot.
fn generate_and_store(cfg: &SeedConfig, history: History, db: &Path) -> Result<(Value, Value)> {
    eprintln!("[{history:?}] generating seed");
    let t = Instant::now();
    let seed = seed::generate(cfg, history);
    let gen_ms = ms(t);
    let desc = seed_json(&seed, gen_ms);

    let t = Instant::now();
    let store = Store::open(db, Durability::Normal)?;
    let mut sizes: BTreeMap<&str, (usize, usize, usize)> = Default::default();
    store.conn.execute_batch("BEGIN")?;
    let book_doc_id = format!("book:{}", seed.book_id);
    store.register(&book_doc_id, "book")?;
    let book_snap = seed.book.doc.export(ExportMode::Snapshot)?;
    put_snapshot(&store, &book_doc_id, &seed.book.doc, &book_snap)?;
    let mut largest = (String::new(), 0usize, 0usize);
    let mut longest_drift = (String::new(), 0usize, 0usize);
    let mut ops_total = 0usize;
    for e in &seed.prose {
        store.register(&e.doc_id, e.kind)?;
        let snap = e.prose.doc.export(ExportMode::Snapshot)?;
        put_snapshot(&store, &e.doc_id, &e.prose.doc, &snap)?;
        let s = sizes.entry(e.kind).or_default();
        s.0 += 1;
        s.1 += snap.len();
        s.2 += e.chars;
        ops_total += e.prose.doc.len_ops();
        if e.kind == "chapter" && e.chars > largest.1 {
            largest = (e.doc_id.clone(), e.chars, snap.len());
        }
        if e.kind == "drift" && e.chars > longest_drift.1 {
            longest_drift = (e.doc_id.clone(), e.chars, snap.len());
        }
    }
    for (k, v) in [
        ("largest_chapter", &largest.0),
        ("longest_drift", &longest_drift.0),
        ("book", &book_doc_id),
    ] {
        store.conn.execute(
            "INSERT OR REPLACE INTO library_meta(key, value) VALUES (?1, ?2)",
            [k, v.as_str()],
        )?;
    }
    store.conn.execute_batch("COMMIT")?;
    let store_ms = ms(t);
    let db_bytes = store.size_bytes()?;
    let kinds: serde_json::Map<String, Value> = sizes
        .iter()
        .map(|(k, (n, b, c))| {
            (
                k.to_string(),
                json!({"documents": n, "snapshotBytes": b, "chars": c}),
            )
        })
        .collect();
    let storage = json!({
        "storeAllSnapshotsMs": store_ms.round(),
        "databaseBytes": db_bytes,
        "bookSnapshotBytes": book_snap.len(),
        "bookOps": seed.book.doc.len_ops(),
        "proseOps": ops_total,
        "snapshotsByKind": Value::Object(kinds),
        "largestChapter": {"chars": largest.1, "snapshotBytes": largest.2},
        "longestDrift": {"chars": longest_drift.1, "snapshotBytes": longest_drift.2},
    });
    Ok((desc, storage))
}

fn put_snapshot(store: &Store, doc_id: &str, doc: &LoroDoc, bytes: &[u8]) -> Result<()> {
    store.conn.execute(
        "INSERT OR REPLACE INTO loro_snapshot(doc_id, upto_seq, vv, frontiers, bytes, ts) VALUES (?1, 0, ?2, ?3, ?4, 0)",
        rusqlite::params![doc_id, doc.oplog_vv().encode(), doc.oplog_frontiers().encode(), bytes],
    )?;
    Ok(())
}

fn meta(store: &Store, key: &str) -> Result<String> {
    Ok(store.conn.query_row(
        "SELECT value FROM library_meta WHERE key = ?1",
        [key],
        |r| r.get(0),
    )?)
}

fn run_child_probe(db: &Path) -> Result<Value> {
    let out = std::process::Command::new(std::env::current_exe()?)
        .arg("open-probe")
        .arg(db)
        .output()?;
    if !out.status.success() {
        bail!(
            "open-probe failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(serde_json::from_slice(&out.stdout)?)
}

/// Cold open in a fresh process: the database, the book document and its
/// index, the largest chapter, the whole book, and every document.
fn open_probe(db: &Path) -> Result<Value> {
    let rss0 = rss_bytes().unwrap_or(0) as i64;
    let t = Instant::now();
    let store = Store::open(db, Durability::Normal)?;
    let open_db_ms = ms(t);
    let book_id = meta(&store, "book")?;
    let largest = meta(&store, "largest_chapter")?;

    let h0 = heap();
    let t = Instant::now();
    let book = store.load(&book_id)?.context("book")?;
    let load_book_ms = ms(t);
    let t = Instant::now();
    let idx = BookIndex::read(&book);
    let index_ms = ms(t);
    let book_heap = since(h0);

    let mut chapter_ms = Vec::new();
    let mut chapter_read_ms = Vec::new();
    let mut chapter_heap = 0;
    let mut chapter_paragraphs = 0;
    for _ in 0..10 {
        let h0 = heap();
        let t = Instant::now();
        let doc = store.load(&largest)?.context("chapter")?;
        chapter_ms.push(ms(t));
        let t = Instant::now();
        let paras = ProseDoc::from_doc(doc.clone()).paragraphs();
        chapter_read_ms.push(ms(t));
        chapter_paragraphs = paras.len();
        drop(paras);
        chapter_heap = since(h0);
        drop(doc);
    }

    let h0 = heap();
    reset_peak();
    let t = Instant::now();
    let mut docs = Vec::new();
    for (id, _) in &idx.chapters {
        docs.push(store.load(&format!("node:{id}"))?.context("chapter")?);
    }
    let load_all_ms = ms(t);
    let loaded_heap = since(h0);
    // What a virtualised view needs first: the rich text of one screenful
    // (about 3000 characters) per chapter, on cold documents.
    let mut window = Vec::new();
    for d in &docs {
        let text = d.get_text("body");
        let t = Instant::now();
        let end = text.len_unicode().min(3000);
        let delta = text.slice_delta(0, end, loro::cursor::PosType::Unicode)?;
        window.push(ms(t));
        assert!(!delta.is_empty());
    }
    let window_heap = since(h0);
    let t = Instant::now();
    let mut chars = 0;
    for d in &docs {
        chars += d.get_text("body").to_string().chars().count();
    }
    let to_string_ms = ms(t);
    let t = Instant::now();
    let mut runs = 0;
    for d in &docs {
        runs += d.get_text("body").to_delta().len();
    }
    let to_delta_ms = ms(t);
    let t = Instant::now();
    let mut paragraphs = 0;
    for d in &docs {
        paragraphs += ProseDoc::from_doc(d.clone()).paragraphs().len();
    }
    let paragraphs_ms = ms(t);
    let whole_heap = since(h0);
    let whole_peak = peak() as i64 - h0 as i64;
    let whole_rss = rss_bytes().unwrap_or(0) as i64 - rss0;

    let loaded: HashSet<String> = idx
        .chapters
        .iter()
        .map(|(id, _)| format!("node:{id}"))
        .collect();
    let t = Instant::now();
    let mut rest = Vec::new();
    for id in store.doc_ids(None)? {
        if !loaded.contains(&id) && id != book_id {
            let d = store.load(&id)?.context("doc")?;
            d.get_text("body").to_string();
            rest.push(d);
        }
    }
    let rest_ms = ms(t);
    let every_heap = since(h0);
    let every_rss = rss_bytes().unwrap_or(0) as i64 - rss0;
    Ok(json!({
        "processBaselineRssMB": mb(rss0),
        "openDatabaseMs": open_db_ms,
        "bookDocument": {"loadMs": load_book_ms, "indexMs": index_ms, "heapMB": mb(book_heap), "chapters": idx.chapters.len()},
        "largestChapter": {
            "loadMs": summarize(&chapter_ms).json(),
            "readParagraphsMs": summarize(&chapter_read_ms).json(),
            "heapMB": mb(chapter_heap),
            "paragraphs": chapter_paragraphs,
        },
        "wholeBook": {
            "chapters": docs.len(),
            "chars": chars,
            "loadMs": load_all_ms,
            "heapAfterLoadMB": mb(loaded_heap),
            "firstScreenSliceDeltaMs": summarize(&window).json(),
            "heapAfterFirstScreensMB": mb(window_heap),
            "toStringMs": to_string_ms,
            "toDeltaMs": to_delta_ms,
            "deltaRuns": runs,
            "readParagraphsMs": paragraphs_ms,
            "paragraphs": paragraphs,
            "heapMB": mb(whole_heap),
            "peakHeapMB": mb(whole_peak),
            "rssGrowthMB": mb(whole_rss),
        },
        "everyDocument": {
            "documents": docs.len() + rest.len() + 1,
            "loadRestMs": rest_ms,
            "heapMB": mb(every_heap),
            "rssGrowthMB": mb(every_rss),
        },
    }))
}

/// A chapter with a long revision history, stored and reopened.
fn churned(db: &Path) -> Result<Value> {
    eprintln!("[churned] generating");
    let t = Instant::now();
    let (prose, typed) = seed::churned_chapter(CHURN_DOC, CHURN_CHARS, CHURN_ROUNDS);
    let gen_ms = ms(t);
    let store = Store::open(db, Durability::Normal)?;
    store.register(CHURN_DOC, "chapter")?;
    let snap = prose.doc.export(ExportMode::Snapshot)?;
    put_snapshot(&store, CHURN_DOC, &prose.doc, &snap)?;
    store.conn.execute(
        "INSERT OR REPLACE INTO library_meta(key, value) VALUES ('churned', ?1)",
        [CHURN_DOC],
    )?;
    let chars = prose.len();
    let changes = prose.doc.len_changes();
    let ops = prose.doc.len_ops();
    drop(prose);
    let mut load = Vec::new();
    let mut read = Vec::new();
    let mut heap_mb = 0.0;
    for _ in 0..10 {
        let h0 = heap();
        let t = Instant::now();
        let doc = store.load(CHURN_DOC)?.context("churned")?;
        load.push(ms(t));
        let t = Instant::now();
        ProseDoc::from_doc(doc.clone()).paragraphs();
        read.push(ms(t));
        heap_mb = mb(since(h0));
    }
    Ok(json!({
        "generateMs": gen_ms.round(),
        "charsNow": chars,
        "charsTypedInTotal": typed,
        "changes": changes,
        "ops": ops,
        "snapshotBytes": snap.len(),
        "loadMs": summarize(&load).json(),
        "readParagraphsMs": summarize(&read).json(),
        "heapMB": heap_mb,
    }))
}

/// Commit + export + append for one keystroke, as F2's document holder does.
fn keystrokes(db: &Path, scratch: &Path) -> Result<Value> {
    let mut out = serde_json::Map::new();
    for durability in [Durability::Normal, Durability::Full] {
        let copy = scratch.join(format!("keys-{durability:?}.sqlite"));
        std::fs::copy(db, &copy)?;
        let store = Store::open(&copy, durability)?;
        let doc_id = meta(&store, "largest_chapter")?;
        let doc = store.load_for_edit(&doc_id)?.context("chapter")?;
        let prose = ProseDoc::from_doc(doc.clone());
        let mut holder = Holder::loaded(&doc_id, doc);
        let mut rng = Rng::new(7);
        let mut caret = prose.len() / 2;
        let mut samples = Vec::new();
        let mut bytes = Vec::new();
        let han: Vec<char> = "的一是在不了有和人这中大为上个".chars().collect();
        for i in 0..2000 {
            let t = Instant::now();
            if i % 40 == 39 {
                caret = prose.split(caret);
            } else {
                let c = rng.pick(&han).to_string();
                prose.insert_text(caret, &c);
                caret += 1;
            }
            let n = holder.commit(&store, "user")?;
            samples.push(ms(t));
            bytes.push(n as f64);
        }
        let (pending, pending_bytes) = store.pending(&doc_id)?;
        let t = Instant::now();
        let c = store.compact(&doc_id, &prose.doc)?;
        let compact_ms = ms(t);
        out.insert(
            format!("{durability:?}").to_lowercase(),
            json!({
                "keystrokes": samples.len(),
                "commitAndAppendMs": summarize(&samples).json(),
                "updateBytes": summarize(&bytes).json(),
                "pendingUpdatesBeforeCompaction": pending,
                "pendingBytesBeforeCompaction": pending_bytes,
                "compactMs": compact_ms,
                "compactSnapshotBytes": c.snapshot_bytes,
                "compactDeletedUpdates": c.deleted_updates,
            }),
        );
    }
    Ok(Value::Object(out))
}

/// Memory growth when a cold document imports an update, checks out an
/// older version or forks at one; what freeing caches gives back; and the
/// alternative of opening a separate copy from storage for history views.
fn memory_probes(db: &Path, doc_id: Option<&str>) -> Result<Value> {
    let store = Store::open(db, Durability::Normal)?;
    let doc_id = match doc_id {
        Some(d) => d.to_string(),
        None => meta(&store, "largest_chapter")?,
    };
    let mut out = serde_json::Map::new();

    // A remote update into a cold document.
    let h0 = heap();
    let doc = store.load(&doc_id)?.context("chapter")?;
    let cold = since(h0);
    let remote = doc.fork();
    remote.set_peer_id(424_242)?;
    remote.get_text("body").insert(10, "远端")?;
    remote.commit();
    let upd = remote.export(ExportMode::updates(&doc.oplog_vv()))?;
    drop(remote);
    let h1 = heap();
    let t = Instant::now();
    doc.import(&upd)?;
    let import_ms = ms(t);
    let after_import = since(h1);
    let h2 = heap();
    doc.free_history_cache();
    doc.free_diff_calculator();
    let freed_import = -since(h2);
    out.insert("coldDocumentHeapMB".into(), json!(mb(cold)));
    out.insert("importSmallUpdateMs".into(), json!(import_ms));
    out.insert(
        "importSmallUpdateHeapDeltaMB".into(),
        json!(mb(after_import)),
    );
    out.insert("freeCachesAfterImportMB".into(), json!(mb(freed_import)));

    // Checkout one change back, then back to latest.
    let back = one_change_back(&doc);
    let h3 = heap();
    let t = Instant::now();
    doc.checkout(&back)?;
    let checkout_ms = ms(t);
    let after_checkout = since(h3);
    doc.checkout_to_latest();
    let after_latest = since(h3);
    let h4 = heap();
    doc.free_history_cache();
    doc.free_diff_calculator();
    let freed_checkout = -since(h4);
    out.insert("checkoutOneBackMs".into(), json!(checkout_ms));
    out.insert("checkoutHeapDeltaMB".into(), json!(mb(after_checkout)));
    out.insert(
        "afterCheckoutToLatestHeapDeltaMB".into(),
        json!(mb(after_latest)),
    );
    out.insert(
        "freeCachesAfterCheckoutMB".into(),
        json!(mb(freed_checkout)),
    );
    drop(doc);

    // fork_at on the open document.
    let doc = store.load(&doc_id)?.context("chapter")?;
    let back = one_change_back(&doc);
    let h5 = heap();
    reset_peak();
    let t = Instant::now();
    let fork = doc.fork_at(&back)?;
    let fork_ms = ms(t);
    let with_fork = since(h5);
    let fork_peak = peak() as i64 - h5 as i64;
    drop(fork);
    let after_drop = since(h5);
    let h6 = heap();
    doc.free_history_cache();
    doc.free_diff_calculator();
    let freed_fork = -since(h6);
    out.insert("forkAtOneBackMs".into(), json!(fork_ms));
    out.insert("forkAtHeapWhileAliveMB".into(), json!(mb(with_fork)));
    out.insert("forkAtPeakMB".into(), json!(mb(fork_peak)));
    out.insert(
        "openDocRetainsAfterForkDroppedMB".into(),
        json!(mb(after_drop)),
    );
    out.insert("freeCachesAfterForkMB".into(), json!(mb(freed_fork)));

    // fork_at far back (a tenth into the history).
    let first = far_back(&doc);
    let h7 = heap();
    let t = Instant::now();
    let fork = doc.fork_at(&first)?;
    let far_ms = ms(t);
    let far_heap = since(h7);
    drop(fork);
    let far_after = since(h7);
    out.insert("forkAtTenthOfHistoryMs".into(), json!(far_ms));
    out.insert("forkAtTenthOfHistoryHeapMB".into(), json!(mb(far_heap)));
    out.insert(
        "openDocRetainsAfterFarForkDroppedMB".into(),
        json!(mb(far_after)),
    );
    drop(doc);

    // A history view on a separate copy loaded from storage: the open
    // document is never touched.
    let open_doc = store.load(&doc_id)?.context("chapter")?;
    open_doc.get_text("body").to_string();
    let h8 = heap();
    reset_peak();
    let t = Instant::now();
    let copy = store.load(&doc_id)?.context("copy")?;
    let back = far_back(&copy);
    copy.checkout(&back)?;
    let old_text = copy.get_text("body").len_unicode();
    let copy_ms = ms(t);
    let copy_peak = peak() as i64 - h8 as i64;
    drop(copy);
    let copy_after = since(h8);
    out.insert("separateCopyCheckoutMs".into(), json!(copy_ms));
    out.insert("separateCopyPeakMB".into(), json!(mb(copy_peak)));
    out.insert("afterDroppingCopyHeapDeltaMB".into(), json!(mb(copy_after)));
    out.insert("separateCopyOldChars".into(), json!(old_text));
    Ok(Value::Object(out))
}

fn one_change_back(doc: &LoroDoc) -> Frontiers {
    let f = doc.oplog_frontiers();
    let id = f.iter().next().expect("frontier");
    Frontiers::from_id(ID::new(id.peer, (id.counter - 1).max(0)))
}

fn far_back(doc: &LoroDoc) -> Frontiers {
    let vv = doc.oplog_vv();
    let (peer, counter) = vv
        .iter()
        .max_by_key(|(_, c)| **c)
        .map(|(p, c)| (*p, *c))
        .unwrap();
    Frontiers::from_id(ID::new(peer, counter / 10))
}

/// Anchor resolution: live characters, deleted characters (history replay),
/// and the replacement cursors Loro hands back.
fn cursors(db: &Path, key: &str) -> Result<Value> {
    let store = Store::open(db, Durability::Normal)?;
    let doc_id = meta(&store, key)?;
    let doc = store.load_for_edit(&doc_id)?.context("doc")?;
    let prose = ProseDoc::from_doc(doc.clone());
    let mut rng = Rng::new(99);
    let mut anchors = Vec::new();
    for _ in 0..200 {
        let len = prose.len();
        let s = rng.range(0, len - 40);
        anchors.push(Anchor::new(&prose.text(), s..s + rng.range(2, 30)).unwrap());
    }
    let mut live = Vec::new();
    for a in &anchors {
        let t = Instant::now();
        let r = a.resolve(&doc).unwrap();
        live.push(ms(t));
        assert!(r.updated.is_none());
    }
    for a in anchors.iter().take(50) {
        let r = a.resolve(&doc).unwrap();
        prose.delete(r.range.clone());
    }
    doc.commit();
    let mut replay = Vec::new();
    let mut updated = Vec::new();
    for a in anchors.iter().take(50) {
        let t = Instant::now();
        let r = a.resolve(&doc).unwrap();
        replay.push(ms(t));
        updated.push(r.updated.unwrap_or_else(|| a.clone()));
    }
    let mut again = Vec::new();
    for a in &updated {
        let t = Instant::now();
        a.resolve(&doc).unwrap();
        again.push(ms(t));
    }
    Ok(json!({
        "chars": prose.len(),
        "liveResolveMs": summarize(&live).json(),
        "deletedResolveMs": summarize(&replay).json(),
        "replacementResolveMs": summarize(&again).json(),
    }))
}

/// In-place vs forked Agent writes on the largest chapter and longest drift.
fn agent_writes(db: &Path) -> Result<Value> {
    let store = Store::open(db, Durability::Normal)?;
    let mut out = serde_json::Map::new();
    for key in ["largest_chapter", "longest_drift"] {
        let doc_id = meta(&store, key)?;
        let doc = store.load_for_edit(&doc_id)?.context("doc")?;
        let prose = ProseDoc::from_doc(doc);
        let para: String = "代理写入的一段文字。".repeat(20);
        let edit = |p: &ProseDoc| {
            let at = p.paragraph_start(p.len() / 2);
            p.insert_text(at, &para);
            p.split(at + para.chars().count());
        };
        let mut inplace = Vec::new();
        let mut inplace_bytes = Vec::new();
        for i in 0..30 {
            let t = Instant::now();
            let n = write_in_place(&prose, &agent_origin("bench", i), edit);
            inplace.push(ms(t));
            inplace_bytes.push(n as f64);
        }
        let mut forked = Vec::new();
        let mut fork_peak = 0i64;
        for i in 0..30 {
            let h0 = heap();
            reset_peak();
            let t = Instant::now();
            write_forked(&prose, &agent_origin("bench", 100 + i), 777, edit);
            forked.push(ms(t));
            fork_peak = fork_peak.max(peak() as i64 - h0 as i64);
        }
        out.insert(
            key.into(),
            json!({
                "chars": prose.len(),
                "inPlaceMs": summarize(&inplace).json(),
                "inPlaceUpdateBytes": summarize(&inplace_bytes).json(),
                "forkedMs": summarize(&forked).json(),
                "forkedPeakHeapMB": mb(fork_peak),
            }),
        );
    }
    Ok(Value::Object(out))
}

fn undo_json() -> Value {
    undo_cases::run_all()
        .into_iter()
        .map(|c| {
            json!({
                "issue": c.issue,
                "case": c.name,
                "ourUsage": c.our_usage,
                "wrong": c.wrong(),
                "expected": c.expected,
                "actual": c.actual,
                "undoSteps": c.undo_steps,
            })
        })
        .collect()
}
