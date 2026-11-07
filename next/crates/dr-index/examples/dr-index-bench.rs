//! Measurements for dr-text and dr-index (milestone 1).
//!
//! ```text
//! cargo run --release -p dr-index --example dr-index-bench -- \
//!     [--library <M10-imported library dir> --seed-stats <seed output JSON>] \
//!     [--out ../docs/rust-rewrite/acceptance/dr-text-index-m1.json]
//! ```
//!
//! - `chapter`: one 20 000-character chapter (headings every 15 paragraphs,
//!   100 entity links): full and incremental derivation, the copy dr-index
//!   makes until dr-doc can wrap dr-store's document, writing the rows, and
//!   the real holder path after a keystroke.
//! - `keystrokes`: dr-store's write path with and without the deriver.
//! - `heavySynthetic`: 100 chapters, 1.5 million characters (2 000–20 000
//!   each), stored the way M10 stores them, then the whole index rebuilt.
//! - `m10Library` (with `--library`): a copy of a library M10 imported (the
//!   0.1 `stress` seed), rebuilt, with words per kind next to the 0.1
//!   seed's own counts.
//!
//! All text is synthetic: characters drawn from a fixed pool.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use dr_doc::book::BookDoc;
use dr_doc::prose::{ProseDoc, ProseTxn};
use dr_index::incremental;
use dr_index::{TextDeriver, attach, derive_blocks, derived_from, prose_reader};
use dr_model::id::BookId;
use dr_model::kind::EntityKind;
use dr_model::prose::{EntityLink, Heading};
use dr_model::{DocId, Origin};
use dr_store::evidence::{machine, summarize};
use dr_store::index::DocIndex;
use dr_store::synthetic::{self, Rng};
use dr_store::{ContainerChange, DocHandle, Library, LibraryOptions, OpenDoc};
use loro::event::{Diff, DiffEvent, MapDelta};
use loro::{EventTriggerKind, LoroDoc};
use serde_json::{Value, json};

type Fallible<T> = Result<T, Box<dyn std::error::Error>>;

const CHAPTER_CHARS: usize = 20_000;
const SEED: u64 = 20_261_107;

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

/// A chapter written with dr-doc: pool text in paragraphs of 60–300
/// characters, every 15th paragraph a heading (H1, H2, H3 in turn), and
/// `links` two-character entity links spread over it.
fn chapter_prose(doc_id: &DocId, chars: usize, links: usize, seed: u64) -> ProseDoc {
    let mut rng = Rng::new(seed);
    let text = synthetic::chapter(&mut rng, chars);
    let mut p = ProseDoc::create(doc_id.clone(), 7).expect("prose doc");
    let (r, _) = p.edit_at(Origin::Import, Some(0), |t: &mut ProseTxn<'_>| {
        t.insert_paragraphs(0, text.trim_end_matches('\n'))?;
        let newlines = t.view().newlines();
        for (i, nl) in newlines.iter().enumerate().step_by(15) {
            let h = [Heading::H1, Heading::H2, Heading::H3][(i / 15) % 3];
            t.set_heading(*nl, Some(h))?;
        }
        let len = t.view().len();
        for k in 0..links {
            let at = rng.below((len - 3) as u64) as usize;
            let link = EntityLink {
                target: format!("e{}", k % 30),
                kind: EntityKind::Element,
                block: None,
                end_block: None,
            };
            t.link_entity(at..at + 2, &link)?;
        }
        Ok(())
    });
    r.expect("chapter");
    p
}

fn owned(diff: Diff<'_>) -> Diff<'static> {
    match diff {
        Diff::List(l) => Diff::List(l),
        Diff::Text(t) => Diff::Text(t),
        Diff::Map(m) => Diff::Map(MapDelta {
            updated: m
                .updated
                .into_iter()
                .map(|(k, v)| (std::borrow::Cow::Owned(k.into_owned()), v))
                .collect(),
        }),
        Diff::Tree(t) => Diff::Tree(std::borrow::Cow::Owned(t.into_owned())),
        Diff::Counter(c) => Diff::Counter(c),
        Diff::Unknown => Diff::Unknown,
    }
}

/// A raw document like dr-store's, collecting diffs like its holder.
struct Raw {
    doc: LoroDoc,
    changes: Arc<std::sync::Mutex<Vec<ContainerChange>>>,
    _sub: loro::Subscription,
}

impl Raw {
    fn new() -> Self {
        let doc = LoroDoc::new();
        dr_doc::schema::configure(&doc);
        doc.set_peer_id(99).unwrap();
        let changes: Arc<std::sync::Mutex<Vec<ContainerChange>>> = Arc::default();
        let sink = changes.clone();
        let sub = doc.subscribe_root(Arc::new(move |e: DiffEvent<'_>| {
            if matches!(e.triggered_by, EventTriggerKind::Checkout) {
                return;
            }
            let mut s = sink.lock().unwrap();
            for c in e.events {
                s.push(ContainerChange {
                    target: c.target.clone(),
                    path: c.path.to_vec(),
                    diff: owned(c.diff),
                });
            }
        }));
        Self {
            doc,
            changes,
            _sub: sub,
        }
    }

    fn pull(&self, p: &ProseDoc) {
        let bytes = p.export_updates_since(&self.doc.oplog_vv()).unwrap();
        self.doc.import(&bytes).unwrap();
    }

    fn take(&self) -> Vec<ContainerChange> {
        std::mem::take(&mut *self.changes.lock().unwrap())
    }
}

fn options(deriver: bool) -> (LibraryOptions, Option<Arc<TextDeriver>>) {
    let mut o = LibraryOptions::new("0.2.0-bench");
    o.configure_doc = Some(Arc::new(dr_doc::schema::configure));
    o.rebuild_indexes_on_open = false;
    let d = deriver.then(|| attach(&mut o));
    (o, d)
}

/// Store a dr-doc document the way M10 does: create, import its bytes.
fn store(lib: &Library, id: &DocId, p: &ProseDoc, book: &str) -> Fallible<DocHandle> {
    let g = dr_doc::prose::genesis(id);
    let h = lib.open_doc(
        &id.to_string(),
        OpenDoc::CreateIfMissing {
            kind: id.kind().prefix(),
            book_id: Some(book),
            genesis: &move |d: &LoroDoc| {
                d.import(&g).unwrap();
            },
        },
    )?;
    h.import(p.export_snapshot()?, dr_store::Origin::Import)?;
    Ok(h)
}

fn chapter(dir: &Path) -> Fallible<Value> {
    let id = DocId::parse("node:bench").unwrap();
    let mut p = chapter_prose(&id, CHAPTER_CHARS, 100, SEED);
    let paragraphs = p.view().paragraph_count();

    // Full derivation on a warm document: what it costs once dr-doc can wrap
    // the holder's own document.
    derive_blocks(&p.view());
    let mut full_warm = Vec::new();
    for _ in 0..30 {
        let t = Instant::now();
        let d = derived_from(&derive_blocks(&p.view()));
        full_warm.push(ms(t));
        assert!(d.words > 0);
    }

    // The copy made today: export a snapshot of dr-store's document, load it
    // into dr-doc, read it whole.
    let raw = Raw::new();
    raw.pull(&p);
    raw.take();
    let mut copy = Vec::new();
    let mut copy_and_full = Vec::new();
    for _ in 0..30 {
        let t = Instant::now();
        let r = prose_reader(&id, &raw.doc)?;
        copy.push(ms(t));
        let d = derived_from(&derive_blocks(&r.view()));
        copy_and_full.push(ms(t));
        assert!(d.words > 0);
    }

    // Incremental derivation after one keystroke, on the warm document.
    let mut blocks = derive_blocks(&p.view());
    let mut rng = Rng::new(SEED + 1);
    let mut incr = Vec::new();
    let mut read = 0usize;
    for _ in 0..500 {
        let len = p.view().len();
        let at = rng.below((len - 1) as u64) as usize;
        let n = rng.range(1, 3);
        let s = synthetic::han(&mut rng, n);
        let (r, _) = p.edit(Origin::User, |t| t.insert_text(at, &s));
        r?;
        raw.pull(&p);
        let changes = raw.take();
        let t = Instant::now();
        let u = incremental::update(&p.view(), &blocks, &changes).expect("incremental");
        let d = derived_from(&u.blocks);
        incr.push(ms(t));
        read += u.read;
        assert!(d.words > 0);
        blocks = u.blocks;
    }

    // Writing the rows: dr-store replaces every paragraph row, its FTS entry,
    // the references and index_state in one transaction.
    let (o, _) = options(false);
    let lib = Library::open(dir.join("write"), o)?;
    let h = store(&lib, &id, &p, "b1")?;
    h.close();
    let derived = derived_from(&derive_blocks(&p.view()));
    let frontiers = p.frontiers();
    let mut write = Vec::new();
    for i in 0..50 {
        let t = Instant::now();
        let written = lib.index_doc(&DocIndex {
            doc_id: "node:bench",
            book_id: Some("b1"),
            seq: 1_000 + i,
            frontiers: &frontiers,
            derived: &derived,
        })?;
        write.push(ms(t));
        assert!(written);
    }
    lib.close()?;
    let patch = simulated_patch_write(&dir.join("write").join("library.sqlite"))?;

    // The real holder: a keystroke written through dr-store, then the
    // derivation it runs when idle (diffs → copy → incremental → write).
    let (o, d) = options(true);
    let d = d.unwrap();
    let lib = Library::open(dir.join("holder"), o)?;
    let h = store(&lib, &id, &p, "b1")?;
    h.reindex_now()?;
    let mut cursor = CHAPTER_CHARS / 2;
    let mut reindex = Vec::new();
    let mut rng = Rng::new(SEED + 2);
    for _ in 0..300 {
        let s = rng.next_u64();
        cursor = h
            .write(dr_store::Origin::User, move |doc| {
                synthetic::keystroke(doc, &mut Rng::new(s), cursor)
            })?
            .0;
        let t = Instant::now();
        h.reindex_now()?;
        reindex.push(ms(t));
    }
    let stats = d.stats();
    h.close();
    lib.close()?;

    Ok(json!({
        "chars": CHAPTER_CHARS,
        "paragraphs": paragraphs,
        "links": 100,
        "words": derived.words,
        "fullDeriveWarmMs": summarize(&full_warm).json(),
        "copyForDrDocMs": summarize(&copy).json(),
        "copyAndFullDeriveMs": summarize(&copy_and_full).json(),
        "incrementalAfterKeystrokeWarmMs": summarize(&incr).json(),
        "incrementalParagraphsReadPerKeystroke": read as f64 / 500.0,
        "writeRowsMs": summarize(&write).json(),
        "simulatedPatchWriteMs": patch,
        "holderReindexAfterKeystrokeMs": summarize(&reindex).json(),
        "holderDerivations": { "incremental": stats.incremental, "full": stats.full, "fallbacks": stats.fallbacks },
    }))
}

/// What a paragraph-level patch would cost dr-store to write (it only has
/// whole-document replacement today, dr-text-index.md "待协调" 2): in one
/// transaction, one paragraph's row and FTS entry, its references and
/// `index_state`, against the same tables, on the same WAL database.
fn simulated_patch_write(db: &Path) -> Fallible<Value> {
    let conn = rusqlite::Connection::open(db)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    let (id, old): (i64, String) = conn.query_row(
        "SELECT id, text FROM block_index WHERE doc_id = 'node:bench' AND ord = 55",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let mut text = old;
    let mut samples = Vec::new();
    for i in 0..200i64 {
        let next = format!("{text}字");
        let t = Instant::now();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO block_fts (block_fts, rowid, text) VALUES ('delete', ?1, ?2)",
            rusqlite::params![id, text],
        )?;
        tx.execute(
            "UPDATE block_index SET text = ?2, chars = ?3 WHERE id = ?1",
            rusqlite::params![id, next, next.chars().count() as i64],
        )?;
        tx.execute(
            "INSERT INTO block_fts (rowid, text) VALUES (?1, ?2)",
            rusqlite::params![id, next],
        )?;
        tx.execute(
            "DELETE FROM reference WHERE source_doc = 'node:bench' AND source_block = (SELECT block_id FROM block_index WHERE id = ?1)",
            [id],
        )?;
        tx.execute(
            "INSERT INTO reference (source_doc, source_block, book_id, target_kind, target_id, kind, count)
             SELECT 'node:bench', block_id, 'b1', 'element', 'e1', 'link', 1 FROM block_index WHERE id = ?1",
            [id],
        )?;
        tx.execute(
            "UPDATE index_state SET indexed_seq = ?2, words = words + 1, chars = chars + 1, updated_ms = ?2 WHERE doc_id = ?1",
            rusqlite::params!["node:bench", 10_000 + i],
        )?;
        tx.commit()?;
        samples.push(ms(t));
        text = next;
    }
    Ok(summarize(&samples).json())
}

/// dr-store's keystroke write, with and without a deriver attached.
fn keystrokes(dir: &Path) -> Fallible<Value> {
    let mut out = serde_json::Map::new();
    for deriver in [false, true] {
        let (o, _) = options(deriver);
        let lib = Library::open(dir.join(format!("keys-{deriver}")), o)?;
        let id = DocId::parse("node:keys").unwrap();
        let p = chapter_prose(&id, CHAPTER_CHARS, 100, SEED);
        let h = store(&lib, &id, &p, "b1")?;
        let mut cursor = CHAPTER_CHARS / 2;
        let mut rng = Rng::new(SEED + 3);
        let mut ms_ = Vec::new();
        for i in 0..2200 {
            let s = rng.next_u64();
            let t = Instant::now();
            cursor = h
                .write(dr_store::Origin::User, move |doc| {
                    synthetic::keystroke(doc, &mut Rng::new(s), cursor)
                })?
                .0;
            if i >= 200 {
                ms_.push(ms(t));
            }
        }
        h.close();
        lib.close()?;
        out.insert(
            if deriver {
                "withDeriver"
            } else {
                "withoutDeriver"
            }
            .into(),
            summarize(&ms_).json(),
        );
    }
    Ok(Value::Object(out))
}

fn heavy_synthetic(dir: &Path) -> Fallible<Value> {
    let root = dir.join("heavy");
    let mut rng = Rng::new(SEED + 4);
    // 100 lengths in 2 000..=20 000 scaled to 1.5 million in all.
    let raw: Vec<usize> = (0..100).map(|_| rng.range(2_000, 20_000)).collect();
    let sum: usize = raw.iter().sum();
    let mut lengths: Vec<usize> = raw
        .iter()
        .map(|n| (n * 1_500_000 / sum).clamp(2_000, 20_000))
        .collect();
    // Clamping lost some: hand it to the chapters that still have room.
    let mut missing = 1_500_000 - lengths.iter().sum::<usize>().min(1_500_000);
    while missing > 0 {
        for n in lengths.iter_mut() {
            let add = (20_000 - *n).min(missing);
            *n += add;
            missing -= add;
        }
    }
    let total_chars: usize = lengths.iter().sum();
    let t = Instant::now();
    {
        let (o, _) = options(false);
        let lib = Library::open(&root, o)?;
        for (i, n) in lengths.iter().enumerate() {
            let id = DocId::parse(&format!("node:c{i:03}")).unwrap();
            let p = chapter_prose(&id, *n, n / 200, SEED + 100 + i as u64);
            store(&lib, &id, &p, "heavy")?.close();
        }
        lib.close()?;
    }
    let build_ms = ms(t);
    let (o, d) = options(true);
    let d = d.unwrap();
    let t = Instant::now();
    let lib = Library::open(&root, o)?;
    let open_ms = ms(t);
    let stale = lib.stale_index_docs()?.len();
    let t = Instant::now();
    let rebuilt = lib.rebuild_stale_indexes()?;
    let rebuild_ms = ms(t);
    let stats = lib.book_stats("heavy")?;
    // Per document, for the distribution (the index is current: force it).
    let mut per_doc = Vec::new();
    for i in 0..100 {
        let id = format!("node:c{i:03}");
        let copy = lib.load_copy(&id)?;
        let t = Instant::now();
        let r = prose_reader(&DocId::parse(&id).unwrap(), &copy)?;
        let _ = derived_from(&derive_blocks(&r.view()));
        per_doc.push(ms(t));
    }
    // The same text counted by the rule directly, as a cross-check.
    let mut words_direct = 0u64;
    for i in 0..100 {
        let id = format!("node:c{i:03}");
        let r = prose_reader(&DocId::parse(&id).unwrap(), &lib.load_copy(&id)?)?;
        words_direct += dr_text::count_words(&dr_text::plain_text(&r.view()));
    }
    lib.close()?;
    Ok(json!({
        "chapters": 100,
        "chars": total_chars,
        "buildLibraryMs": build_ms.round(),
        "openMs": open_ms,
        "staleDocs": stale,
        "rebuilt": rebuilt,
        "rebuildAllMs": rebuild_ms,
        "deriveOneChapterFromSqliteMs": summarize(&per_doc).json(),
        "bookStats": { "docs": stats.docs, "words": stats.words, "chars": stats.chars, "paragraphs": stats.paragraphs },
        "wordsCountedDirectly": words_direct,
        "derivations": { "full": d.stats().full, "incremental": d.stats().incremental },
    }))
}

fn copy_dir(from: &Path, to: &Path) -> Fallible<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let target = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &target)?;
        } else {
            std::fs::copy(e.path(), target)?;
        }
    }
    Ok(())
}

fn m10_library(dir: &Path, library: &Path, seed_stats: Option<PathBuf>) -> Fallible<Value> {
    let root = dir.join("m10");
    copy_dir(library, &root)?;
    let _ = std::fs::remove_file(root.join("library.lock"));
    let (o, d) = options(true);
    let d = d.unwrap();
    let t = Instant::now();
    let lib = Library::open(&root, o)?;
    let open_ms = ms(t);
    let stale = lib.stale_index_docs()?;
    let t = Instant::now();
    let rebuilt = lib.rebuild_stale_indexes()?;
    let rebuild_ms = ms(t);
    // Words per kind of body, chapters and ideas told apart by the book.
    let books: Vec<String> = stale
        .iter()
        .filter_map(|s| s.strip_prefix("book:").map(str::to_string))
        .collect();
    let mut kinds: std::collections::BTreeMap<&str, (u64, u64)> = Default::default();
    let mut search = Vec::new();
    for b in &books {
        let snap = lib
            .load_copy(&format!("book:{b}"))?
            .export(loro::ExportMode::Snapshot)?;
        let book = BookDoc::load(BookId::parse(b)?, 5, &[snap])?;
        let v = book.view();
        let chapters: std::collections::HashSet<String> = v
            .chapters()
            .iter()
            .map(|n| format!("node:{}", n.id.as_str()))
            .collect();
        for info in lib.docs(Some(b), None)? {
            let Some(s) = lib.doc_stats(&info.doc_id)? else {
                continue;
            };
            let kind = match info.kind.as_str() {
                "node" if chapters.contains(&info.doc_id) => "chapters",
                "node" => "ideas",
                "element" => "elements",
                "material" => "materialNotes",
                "storyline" => "storylines",
                "category" => "categories",
                _ => "book",
            };
            let e = kinds.entry(kind).or_default();
            e.0 += 1;
            e.1 += s.words;
        }
        // Search over the whole book: queries cut from its own text (one,
        // two, three and eight characters).
        let sample: String = lib
            .search(Some(b), "的", 50)?
            .into_iter()
            .map(|h| h.snippet)
            .max_by_key(|s| s.chars().count())
            .unwrap_or_default();
        let chars: Vec<char> = sample.chars().filter(|c| !c.is_whitespace()).collect();
        let cut = |n: usize| -> String { chars.iter().skip(4).take(n).collect() };
        for q in [cut(1), cut(2), cut(3), cut(8)] {
            let q = q.as_str();
            let t = Instant::now();
            let hits = lib.search(Some(b), q, 50)?;
            search.push(json!({ "query": q, "hits": hits.len(), "ms": ms(t) }));
        }
    }
    let seed: Option<Value> = seed_stats
        .map(|p| -> Fallible<Value> { Ok(serde_json::from_str(&std::fs::read_to_string(p)?)?) })
        .transpose()?;
    fn seed_name(k: &str) -> &str {
        match k {
            "ideas" => "inspirations",
            k => k,
        }
    }
    let per_kind: Vec<Value> = kinds
        .iter()
        .map(|(k, (docs, words))| {
            let old = seed
                .as_ref()
                .map(|s| s["statistics"]["bodies"][seed_name(k)]["totalWords"].clone());
            json!({ "kind": k, "docs": docs, "words": words, "seedWords0_1": old })
        })
        .collect();
    let stats = d.stats();
    lib.close()?;
    Ok(json!({
        "preset": seed.as_ref().map(|s| s["statistics"]["preset"].clone()),
        "docs": stale.len(),
        "openMs": open_ms,
        "rebuilt": rebuilt,
        "rebuildAllMs": rebuild_ms,
        "byKind": per_kind,
        "search": search,
        "derivations": { "full": stats.full, "incremental": stats.incremental, "unreadable": stats.unreadable },
    }))
}

fn main() -> Fallible<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = tempfile::tempdir()?;
    let started = Instant::now();
    let mut e = json!({
        "milestone": "dr-text-index-m1",
        "program": "cargo run --release -p dr-index --example dr-index-bench",
        "sourceFingerprint": dr_index::evidence::source_fingerprint(),
        "loro": "1.17.1",
        "machine": machine(),
        "chapter": chapter(dir.path())?,
        "keystrokeWriteMs": keystrokes(dir.path())?,
        "heavySynthetic": heavy_synthetic(dir.path())?,
    });
    if let Some(lib) = arg(&args, "--library") {
        e["m10Library"] = m10_library(
            dir.path(),
            Path::new(&lib),
            arg(&args, "--seed-stats").map(PathBuf::from),
        )?;
    }
    e["totalSeconds"] = json!((started.elapsed().as_secs_f64() * 10.0).round() / 10.0);
    let text = serde_json::to_string_pretty(&e)? + "\n";
    match arg(&args, "--out") {
        Some(out) => std::fs::write(out, text)?,
        None => print!("{text}"),
    }
    Ok(())
}
