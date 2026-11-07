//! dr-store measurements, against the write budgets of
//! docs/rust-rewrite/benchmarks.md:
//!
//! - one keystroke through a document holder (commit, export, append,
//!   event), `synchronous=NORMAL` and `FULL`;
//! - opening a 20 000-character chapter with N updates on top of its
//!   snapshot (what the compaction thresholds trade against);
//! - compacting N pending updates;
//! - a 100-chapter, 1.5-million-character book: cold load, first read, and
//!   starting and stopping 100 holders.
//!
//! ```text
//! cargo run --release -p dr-store --bin f2-bench [-- --out FILE]
//! cargo run --release -p dr-store --bin f2-bench -- --check [FILE]
//! ```

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use dr_store::evidence::{check, machine, source_fingerprint, summarize};
use dr_store::synthetic::{self, Rng};
use dr_store::{DocHandle, Durability, Library, LibraryOptions, OpenDoc, Origin};
use loro::LoroDoc;
use serde_json::json;

type Fallible<T> = Result<T, Box<dyn std::error::Error>>;

const DEFAULT_OUT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../docs/rust-rewrite/acceptance/f2-store-bench.json"
);
const CHAPTER_CHARS: usize = 20_000;
const KEYSTROKES: usize = 2000;
const BOOK_CHAPTERS: usize = 100;
const BOOK_CHAPTER_CHARS: usize = 15_000;

fn options(durability: Durability) -> LibraryOptions {
    let mut o = LibraryOptions::new("0.2.0-bench");
    o.durability = durability;
    o.configure_doc = Some(Arc::new(synthetic::configure));
    // Compaction only where the benchmark asks for it.
    o.compaction.max_updates = usize::MAX;
    o.compaction.max_bytes = usize::MAX;
    o.compaction.on_close_min_updates = usize::MAX;
    o
}

fn genesis(doc: &LoroDoc) {
    doc.set_peer_id((1 << 63) | 0xBE7C).expect("genesis peer");
    doc.set_next_commit_timestamp(0);
    doc.get_text(synthetic::BODY)
        .insert(0, "\n")
        .expect("genesis");
}

fn create(lib: &Library, doc_id: &str) -> Fallible<DocHandle> {
    Ok(lib.open_doc(
        doc_id,
        OpenDoc::CreateIfMissing {
            kind: "node",
            book_id: Some("book-bench"),
            genesis: &genesis,
        },
    )?)
}

/// A chapter of `chars` characters written in one go, then compacted.
fn chapter_doc(lib: &Library, doc_id: &str, chars: usize, seed: u64) -> Fallible<DocHandle> {
    let h = create(lib, doc_id)?;
    let text = synthetic::chapter(&mut Rng::new(seed), chars);
    h.write(Origin::Import, move |doc| {
        doc.get_text(synthetic::BODY)
            .insert(0, &text)
            .expect("insert");
    })?;
    h.compact_now()?;
    Ok(h)
}

/// `n` keystrokes; returns each write's wall time in ms.
fn keystrokes(h: &DocHandle, n: usize, seed: u64) -> Fallible<Vec<f64>> {
    let mut rng = Rng::new(seed);
    let mut cursor = CHAPTER_CHARS / 2;
    let mut ms = Vec::with_capacity(n);
    for _ in 0..n {
        let s = rng.next_u64();
        let t = Instant::now();
        cursor = h
            .write(Origin::User, move |doc| {
                synthetic::keystroke(doc, &mut Rng::new(s), cursor)
            })?
            .0;
        ms.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    Ok(ms)
}

fn ms_since(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn keystroke_write(dir: &Path, durability: Durability) -> Fallible<serde_json::Value> {
    let lib = Library::open(dir, options(durability))?;
    let h = chapter_doc(&lib, "node:keys", CHAPTER_CHARS, 1)?;
    let events = Arc::new(AtomicUsize::new(0));
    let _sub = {
        let events = events.clone();
        h.subscribe(move |_| {
            events.fetch_add(1, Ordering::Relaxed);
        })
    };
    keystrokes(&h, 200, 7)?; // warm up
    let ms = keystrokes(&h, KEYSTROKES, 2)?;
    let bytes = lib.pending_updates("node:keys")?.1;
    Ok(json!({
        "writes": KEYSTROKES,
        "eventsDelivered": events.load(Ordering::Relaxed),
        "ms": summarize(&ms).json(),
        "meanUpdateBytes": bytes / (KEYSTROKES + 200),
    }))
}

fn open_with_updates(dir: &Path) -> Fallible<serde_json::Value> {
    let lib = Library::open(dir, options(Durability::Normal))?;
    let mut rows = Vec::new();
    for n in [0usize, 100, 500, 1000, 2000, 5000] {
        let id = format!("node:n{n}");
        let h = chapter_doc(&lib, &id, CHAPTER_CHARS, 3)?;
        keystrokes(&h, n, 11)?;
        drop(h);
        let (pending, pending_bytes) = lib.pending_updates(&id)?;
        let mut load = Vec::new();
        let mut load_read = Vec::new();
        let mut holder = Vec::new();
        for _ in 0..15 {
            let t = Instant::now();
            let doc = lib.load_copy(&id)?;
            load.push(ms_since(t));
            let t = Instant::now();
            let doc2 = lib.load_copy(&id)?;
            let text = doc2.get_text(synthetic::BODY).to_string();
            load_read.push(ms_since(t));
            assert!(text.len() > CHAPTER_CHARS);
            drop((doc, doc2));
            let t = Instant::now();
            let h = lib.open_doc(&id, OpenDoc::Existing)?;
            holder.push(ms_since(t));
            drop(h);
        }
        rows.push(json!({
            "pendingUpdates": pending,
            "pendingBytes": pending_bytes,
            "loadMs": summarize(&load).json(),
            "loadAndReadTextMs": summarize(&load_read).json(),
            "openHolderMs": summarize(&holder).json(),
        }));
    }
    Ok(json!(rows))
}

fn compaction(dir: &Path) -> Fallible<serde_json::Value> {
    let lib = Library::open(dir, options(Durability::Normal))?;
    let mut rows = Vec::new();
    for n in [100usize, 500, 2000] {
        let id = format!("node:c{n}");
        let h = chapter_doc(&lib, &id, CHAPTER_CHARS, 5)?;
        let mut ms = Vec::new();
        let mut last = None;
        for round in 0..3 {
            keystrokes(&h, n, 100 + round)?;
            let t = Instant::now();
            last = h.compact_now()?;
            ms.push(ms_since(t));
        }
        let stats = last.ok_or("nothing compacted")?;
        rows.push(json!({
            "pendingUpdates": n,
            "compactMs": summarize(&ms).json(),
            "snapshotBytes": stats.snapshot_bytes,
            "deletedUpdates": stats.deleted_updates,
        }));
    }
    Ok(json!(rows))
}

fn full_book(dir: &Path) -> Fallible<serde_json::Value> {
    let lib = Library::open(dir, options(Durability::Normal))?;
    let ids: Vec<String> = (0..BOOK_CHAPTERS)
        .map(|i| format!("node:ch{i:03}"))
        .collect();
    let t = Instant::now();
    for (i, id) in ids.iter().enumerate() {
        chapter_doc(&lib, id, BOOK_CHAPTER_CHARS, 1000 + i as u64)?;
    }
    let build_ms = ms_since(t);
    let mut load = Vec::new();
    let mut read = Vec::new();
    let mut open = Vec::new();
    let mut close = Vec::new();
    for _ in 0..5 {
        let t = Instant::now();
        let docs: Vec<LoroDoc> = ids
            .iter()
            .map(|id| lib.load_copy(id))
            .collect::<Result<_, _>>()?;
        load.push(ms_since(t));
        let t = Instant::now();
        let chars: usize = docs
            .iter()
            .map(|d| d.get_text(synthetic::BODY).to_string().chars().count())
            .sum();
        read.push(ms_since(t));
        assert!(chars >= BOOK_CHAPTERS * BOOK_CHAPTER_CHARS);
        drop(docs);
        let t = Instant::now();
        let handles: Vec<DocHandle> = ids
            .iter()
            .map(|id| lib.open_doc(id, OpenDoc::Existing))
            .collect::<Result<_, _>>()?;
        open.push(ms_since(t));
        let t = Instant::now();
        drop(handles);
        close.push(ms_since(t));
    }
    Ok(json!({
        "chapters": BOOK_CHAPTERS,
        "charsPerChapter": BOOK_CHAPTER_CHARS,
        "buildMs": (build_ms * 10.0).round() / 10.0,
        "coldLoadAllMs": summarize(&load).json(),
        "firstReadAllTextMs": summarize(&read).json(),
        "open100HoldersMs": summarize(&open).json(),
        "close100HoldersMs": summarize(&close).json(),
        "librarySqliteBytes": lib.size_bytes()?,
    }))
}

fn run(out: &Path) -> Fallible<()> {
    let base = std::env::temp_dir().join(format!(
        "f2-bench-{}-{}",
        std::process::id(),
        dr_store::now_ms()
    ));
    std::fs::create_dir_all(&base)?;
    eprintln!("keystroke writes …");
    let normal = keystroke_write(&base.join("keys-normal"), Durability::Normal)?;
    let full = keystroke_write(&base.join("keys-full"), Durability::Full)?;
    eprintln!("open with N updates …");
    let open = open_with_updates(&base.join("open"))?;
    eprintln!("compaction …");
    let compact = compaction(&base.join("compact"))?;
    eprintln!("full book …");
    let book = full_book(&base.join("book"))?;
    let doc = json!({
        "schemaVersion": 1,
        "probe": "F2 dr-store benchmark",
        "generatedBy": "cargo run --release -p dr-store --bin f2-bench",
        "sourceFingerprint": source_fingerprint(),
        "loro": "1.17.1",
        "machine": machine(),
        "corpus": "synthetic: characters from a fixed pool (dr_store::synthetic), paragraphs of 60-300",
        "budgets": {
            "keystrokeWriteMedianMs": { "probe": 2.0, "release": 1.0, "source": "benchmarks.md: 单次按键的写入（中位数）" },
            "coldOpenBookLoroMs": { "release": 300.0, "source": "benchmarks.md: 冷开全书的 Loro 文档" },
        },
        "keystrokeWrite": {
            "chapterChars": CHAPTER_CHARS,
            "what": "DocHandle::write of a 1-6 character insert or a short delete: run on the holder thread, commit, export, append to SQLite, deliver the event, wake the caller",
            "synchronousNormal": normal,
            "synchronousFull": full,
        },
        "openChapterWithPendingUpdates": {
            "chapterChars": CHAPTER_CHARS,
            "what": "snapshot of a 20 000-character chapter plus N keystroke updates; load_copy, load_copy + reading the whole text, and starting a holder",
            "rows": open,
        },
        "compaction": {
            "chapterChars": CHAPTER_CHARS,
            "what": "compact_now after N keystrokes: export a full snapshot, write it and delete the covered rows in one transaction",
            "rows": compact,
        },
        "fullBook": book,
    });
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(out, serde_json::to_string_pretty(&doc)? + "\n")?;
    eprintln!("wrote {}", out.display());
    let _ = std::fs::remove_dir_all(&base);
    Ok(())
}

fn main() -> Fallible<()> {
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    if args.get(1).map(String::as_str) == Some("--check") {
        let path = args
            .get(2)
            .cloned()
            .unwrap_or_else(|| DEFAULT_OUT.to_string());
        check(
            Path::new(&path),
            &[
                "keystrokeWrite",
                "openChapterWithPendingUpdates",
                "compaction",
                "fullBook",
            ],
        )?;
        eprintln!("{path}: matches this build");
        return Ok(());
    }
    let out = PathBuf::from(flag("--out").unwrap_or_else(|| DEFAULT_OUT.to_string()));
    run(&out)
}
