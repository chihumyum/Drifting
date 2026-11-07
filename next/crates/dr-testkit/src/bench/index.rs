//! The derived-index suite (dr-text and dr-index), moved from dr-index's
//! `examples/dr-index-bench.rs` onto the seed:
//!
//! - `rebuild`: the whole seed stored without a deriver, reopened with
//!   dr-index's, every index rebuilt; the words per group of bodies must be
//!   what the seed itself counted, or the suite fails;
//! - `chapter`: the longest chapter in a document holder. Keystrokes (every
//!   twentieth an Enter) each followed by the holder's derivation: the
//!   deriver reads the holder's document in place and hands dr-store a
//!   paragraph patch. The derivation alone and the whole step (derivation
//!   and patch written) are timed apart, typing and Enters apart.
//!   Then dr-store's two writes on their own: every row replaced, and one
//!   row patched;
//! - `keystrokeWrite`: dr-store's keystroke write with and without the
//!   deriver attached (it collects the diffs);
//! - `search`: queries of one, two, three and eight characters, with a
//!   short limit, with the 10 000 hits `book.search` fetches today, and in
//!   chapter order;
//! - `outline`: `Library::outline` against dr-text's outline of the same
//!   document, and the book's totals.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::*;
use crate::rng::Rng;
use crate::seed::{self, DEFAULT_SEED, SeededBook};
use dr_doc::prose::ProseDoc;
use dr_index::{TextDeriver, derive_view, prose_reader};
use dr_model::DocId;
use dr_model::kind::NodeKind;
use dr_store::index::{
    BlockRow, DeriveInput, DerivedPatch, DerivedUpdate, Deriver, DocIndex, DocPatch, Splice,
};
use dr_store::{Library, LibraryOptions, OpenDoc, Origin};

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn suite() -> Suite {
    Suite {
        name: "index",
        about: "dr-index and dr-text: the seed's indexes rebuilt; keystrokes derived as paragraph patches; dr-store's full and patch writes; search; outline",
        inputs: &[
            "crates/dr-index",
            "crates/dr-text",
            "crates/prose-metrics",
            "crates/dr-store/src/index.rs",
        ],
        run,
        expect_quick,
    }
}

fn expect_quick() -> Value {
    json!({
        "chapter": {
            "chars": 1348, "derivations": { "fallbacks": 0, "full": 0, "incremental": 40 },
            "enters": 2, "keystrokes": 40, "paragraphs": 10, "paragraphsRead": 42, "rowsPatched": 42,
        },
        "keystrokeWrite": { "writes": 50 },
        "outline": { "each": 3, "headings": 1 },
        "rebuild": {
            "bookParagraphs": 64, "bookWords": 5400, "rebuilt": 20, "staleDocs": 20, "unreadable": 0,
            "wordsByGroup": {
                "categories": { "docs": 2, "words": 200 },
                "chapters": { "docs": 4, "words": 3000 },
                "elements": { "docs": 6, "words": 900 },
                "ideas": { "docs": 3, "words": 600 },
                "materialNotes": { "docs": 2, "words": 400 },
                "storylines": { "docs": 2, "words": 300 },
            },
        },
        "search": { "each": 3, "hitsAtLimit50": { "chars1": 40, "chars2": 39, "chars3": 8, "chars8": 5 } },
    })
}

/// dr-index's deriver, timing each call.
struct Timed {
    inner: TextDeriver,
    ms: Mutex<Vec<f64>>,
}

impl Deriver for Timed {
    fn derive(&self, input: &DeriveInput<'_>) -> Option<DerivedUpdate> {
        let t = Instant::now();
        let out = self.inner.derive(input);
        self.ms
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(t.elapsed().as_secs_f64() * 1e3);
        out
    }
}

impl Timed {
    fn take(&self) -> Vec<f64> {
        std::mem::take(&mut *self.ms.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

fn options(deriver: Option<Arc<Timed>>) -> LibraryOptions {
    let mut o = seed::library_options("0.2.0-bench");
    // The suite starts every rebuild itself.
    o.rebuild_indexes_on_open = false;
    o.deriver = deriver.map(|d| d as Arc<dyn Deriver>);
    o
}

fn timed() -> Arc<Timed> {
    Arc::new(Timed {
        inner: TextDeriver::new(),
        ms: Mutex::new(Vec::new()),
    })
}

/// The group a prose document's body was recorded under in the seed.
fn group(book: &SeededBook, p: &ProseDoc) -> &'static str {
    match p.doc_id() {
        DocId::Node(n) => match book.book.view().node(n).map(|n| n.kind) {
            Some(NodeKind::Chapter) => "chapters",
            _ => "ideas",
        },
        DocId::Element(_) => "elements",
        DocId::Storyline(_) => "storylines",
        DocId::Category(_) => "categories",
        DocId::Material(_) => "materialNotes",
        _ => "other",
    }
}

pub fn run(mode: Mode) -> Result<Bench, String> {
    let mut bench = Bench::new("index", mode);
    let seeded = seed::generate(mode.preset(), DEFAULT_SEED).map_err(err)?;
    let shape = seeded.shape();
    bench.corpus = json!({
        "preset": shape.preset,
        "seed": shape.seed,
        "corpusFingerprint": shape.corpus_fingerprint,
    });
    let book = &seeded.books[0];
    let book_id = book.book_id().as_str().to_string();
    let scratch = Scratch::new("index").map_err(err)?;
    let dir = scratch.path().join("library");

    // ---- rebuild: the seed stored without a deriver, then indexed. ----
    {
        let lib = Library::open(&dir, options(None)).map_err(err)?;
        seed::write_book(&lib, book).map_err(err)?;
        lib.close().map_err(err)?;
    }
    let deriver = timed();
    let lib = Library::open(&dir, options(Some(deriver.clone()))).map_err(err)?;
    let case = bench.case(
        "rebuild",
        "every stale index rebuilt from copies loaded from SQLite (Library::rebuild_stale_indexes)",
    );
    let stale = lib.stale_index_docs().map_err(err)?.len();
    let rebuilt = case.time("rebuildAll", || lib.rebuild_stale_indexes().map_err(err))?;
    case.set("staleDocs", stale).set("rebuilt", rebuilt);
    for ms in deriver.take() {
        case.sample("derivePerDocument", ms);
    }
    let mut groups: BTreeMap<&str, (usize, u64)> = BTreeMap::new();
    for p in &book.prose {
        let stats = lib
            .doc_stats(&p.doc_id().to_string())
            .map_err(err)?
            .ok_or_else(|| format!("{} has no index", p.doc_id()))?;
        let g = groups.entry(group(book, p)).or_default();
        g.0 += 1;
        g.1 += stats.words;
    }
    let mut by_group = Map::new();
    for (g, (docs, words)) in &groups {
        let seeded_words = shape.bodies.get(*g).map_or(0, |s| s.total_words) as u64;
        if *words != seeded_words {
            return Err(format!(
                "index: {g} count {words} words, the seed counted {seeded_words}"
            ));
        }
        by_group.insert(g.to_string(), json!({ "docs": docs, "words": words }));
    }
    let totals = lib.book_stats(&book_id).map_err(err)?;
    let s = deriver.inner.stats();
    case.set("wordsByGroup", Value::Object(by_group))
        .set("bookWords", totals.words)
        .set("bookParagraphs", totals.paragraphs)
        .set("unreadable", s.unreadable);

    // ---- chapter: keystrokes through the holder, derived as patches. ----
    let longest = book
        .prose
        .iter()
        .filter(|p| group(book, p) == "chapters")
        .max_by_key(|p| p.view().len())
        .ok_or("the seed has no chapters")?;
    let id = longest.doc_id().to_string();
    let h = lib.open_doc(&id, OpenDoc::Existing).map_err(err)?;
    h.reindex_now().map_err(err)?;
    deriver.take();
    let before = deriver.inner.stats();
    let case = bench.case(
        "chapter",
        "a keystroke written through the holder, then its derivation: read in place, a paragraph patch written",
    );
    let keystrokes = mode.reps(40, 1_000);
    let mut rng = Rng::new(11);
    let mut enters = 0;
    // Each keystroke adds one character.
    for (i, len) in (0..keystrokes).zip(longest.view().len()..) {
        let at = rng.range(0, len.saturating_sub(2));
        let text = if i % 20 == 19 {
            enters += 1;
            "\n"
        } else {
            "字"
        };
        case.time("write", || {
            h.write(Origin::User, move |doc| {
                doc.get_text(dr_doc::schema::prose::BODY)
                    .insert(at, text)
                    .expect("insert")
            })
        })
        .map_err(err)?;
        // An Enter adds a paragraph: dr-store moves the rows after it.
        let metric = if text == "\n" {
            "deriveAndWriteAfterEnter"
        } else {
            "deriveAndWriteAfterTyping"
        };
        let written = case.time(metric, || h.reindex_now().map_err(err))?;
        if !written {
            return Err("index: a keystroke's derivation wrote nothing".into());
        }
    }
    for ms in deriver.take() {
        case.sample("derive", ms);
    }
    let after = deriver.inner.stats();
    let (incremental, full) = (
        after.incremental - before.incremental,
        after.full - before.full,
    );
    let read = after.paragraphs_read - before.paragraphs_read;
    let rows = after.rows_patched - before.rows_patched;
    let stats = lib.doc_stats(&id).map_err(err)?.ok_or("no index")?;
    case.set("keystrokes", keystrokes)
        .set("enters", enters)
        .set("chars", stats.chars)
        .set("paragraphs", stats.paragraphs)
        .set(
            "derivations",
            json!({ "incremental": incremental, "full": full, "fallbacks": after.fallbacks - before.fallbacks }),
        )
        .set("paragraphsRead", read)
        .set("rowsPatched", rows);

    // The rows stored after all the patches are what a full read gives.
    let copy = lib.load_copy(&id).map_err(err)?;
    let reader = prose_reader(longest.doc_id(), &copy).map_err(err)?;
    let full_read = derive_view(&reader.view());
    let refs: Vec<(Option<String>, String, String, u32)> = lib
        .references_from(&id)
        .map_err(err)?
        .into_iter()
        .map(|r| (r.source_block, r.target_kind, r.target_id, r.count))
        .collect();
    let want_refs: Vec<(Option<String>, String, String, u32)> = full_read
        .references
        .iter()
        .map(|r| {
            (
                r.source_block.clone(),
                r.target_kind.clone(),
                r.target_id.clone(),
                r.count,
            )
        })
        .collect();
    if lib.block_lengths(&id).map_err(err)?
        != full_read.blocks.iter().map(|b| b.chars).collect::<Vec<_>>()
        || (stats.words, stats.chars, stats.paragraphs)
            != (
                full_read.words,
                full_read.chars,
                full_read.blocks.len() as u64,
            )
        || refs != want_refs
    {
        return Err("index: the patched rows differ from a full read".into());
    }
    let n = mode.reps(5, 50);
    for _ in 0..n {
        case.time("fullDeriveInPlace", || derive_view(&reader.view()));
    }
    h.close();

    // dr-store's two writes, on their own.
    let frontiers = copy.oplog_frontiers();
    let mut seq = 1_000_000_000i64;
    for _ in 0..n {
        seq += 1;
        let written = case.time("writeEveryRow", || {
            lib.index_doc(&DocIndex {
                doc_id: &id,
                book_id: Some(&book_id),
                seq,
                frontiers: &frontiers,
                derived: &full_read,
            })
            .map_err(err)
        })?;
        if !written {
            return Err("index: a full write was skipped".into());
        }
    }
    let k = full_read.blocks.len() / 2;
    for i in 0..n {
        seq += 1;
        let mut row: BlockRow = full_read.blocks[k].clone();
        row.text.push_str(&"字".repeat(i % 2));
        row.chars = row.text.chars().count() as u32;
        let patch = DerivedPatch {
            base_paragraphs: full_read.blocks.len() as u32,
            splices: vec![Splice {
                at: k as u32,
                removed: 1,
                blocks: vec![row],
            }],
            references: None,
            words: full_read.words,
            chars: full_read.chars,
        };
        let written = case.time("writeOneRowPatch", || {
            lib.patch_index(&DocPatch {
                doc_id: &id,
                book_id: Some(&book_id),
                seq,
                frontiers: &frontiers,
                patch: &patch,
            })
            .map_err(err)
        })?;
        if !written {
            return Err("index: a patch was skipped".into());
        }
    }

    // ---- search ----
    let sample: Vec<char> = full_read
        .blocks
        .iter()
        .skip(3)
        .find(|b| b.chars >= 12 && b.heading == 0)
        .ok_or("the chapter has no long paragraph")?
        .text
        .chars()
        .collect();
    let order: Vec<String> = book
        .book
        .view()
        .chapters()
        .iter()
        .map(|c| format!("node:{}", c.id))
        .collect();
    let order: Vec<&str> = order.iter().map(String::as_str).collect();
    let case = bench.case(
        "search",
        "Library::search for 1, 2, 3 and 8 characters: limit 50, limit 10 000 (book.search today), limit 50 in chapter order",
    );
    let n = mode.reps(3, 50);
    let mut hits = Map::new();
    for len in [1usize, 2, 3, 8] {
        let q: String = sample[2..2 + len].iter().collect();
        let mut found = 0;
        for _ in 0..n {
            found = case
                .time(&format!("chars{len}"), || {
                    lib.search(Some(&book_id), &q, 50).map_err(err)
                })?
                .len();
            case.time(&format!("chars{len}Fetch10000"), || {
                lib.search(Some(&book_id), &q, 10_000).map_err(err)
            })?;
            case.time(&format!("chars{len}InChapterOrder"), || {
                lib.search_in_order(Some(&book_id), &q, 50, &order)
                    .map_err(err)
            })?;
        }
        hits.insert(format!("chars{len}"), json!(found));
    }
    case.set("hitsAtLimit50", Value::Object(hits))
        .set("each", n);

    // ---- outline and totals ----
    let case = bench.case(
        "outline",
        "Library::outline of the longest chapter (checked against dr-text's outline), and the book's totals",
    );
    let want: Vec<(u32, Option<String>, u8, String)> = dr_text::outline(&reader.view())
        .into_iter()
        .map(|o| {
            (
                o.ord as u32,
                o.block_id.map(|b| b.as_str().to_string()),
                o.heading.level() as u8,
                o.text,
            )
        })
        .collect();
    let n = mode.reps(3, 200);
    let mut got = Vec::new();
    for _ in 0..n {
        got = case.time("outline", || lib.outline(&id).map_err(err))?;
        case.time("bookStats", || lib.book_stats(&book_id).map_err(err))?;
    }
    let got: Vec<(u32, Option<String>, u8, String)> = got
        .into_iter()
        .map(|o| (o.ord, o.block_id, o.heading, o.text))
        .collect();
    if got != want {
        return Err("index: Library::outline differs from dr-text's outline".into());
    }
    case.set("headings", got.len()).set("each", n);
    lib.close().map_err(err)?;

    // ---- keystrokeWrite: with and without the deriver ----
    let case = bench.case(
        "keystrokeWrite",
        "DocHandle::write of a one-character insert into the longest chapter, with and without dr-index attached",
    );
    let writes = mode.reps(50, 2_000);
    for (metric, with) in [("withoutDeriver", false), ("withDeriver", true)] {
        let o = options(with.then(timed));
        let lib = Library::open(&dir, o).map_err(err)?;
        let h = lib.open_doc(&id, OpenDoc::Existing).map_err(err)?;
        let len = longest.view().len();
        let mut rng = Rng::new(7);
        for _ in 0..writes {
            let at = rng.range(0, len.saturating_sub(2));
            case.time(metric, || {
                h.write(Origin::User, move |doc| {
                    doc.get_text(dr_doc::schema::prose::BODY)
                        .insert(at, "字")
                        .expect("insert")
                })
            })
            .map_err(err)?;
        }
        h.close();
        lib.close().map_err(err)?;
    }
    case.set("writes", writes);
    Ok(bench)
}
