//! The dr-doc suite (F1), moved from `dr-doc`'s `tests/measure.rs` onto the
//! seed: reading one chapter (load, paragraphs, lookups, positions, links), a
//! keystroke through `ProseDoc::edit`, and reading the book document
//! (chapters, relations, comments, existence checks, the repair check).

use super::*;
use crate::rng::Rng;
use crate::seed::{self, DEFAULT_SEED};
use dr_doc::Unit;
use dr_doc::book::BookDoc;
use dr_doc::prose::ProseDoc;
use dr_model::book::EntityRef;
use dr_model::kind::{EntityKind, NodeKind};
use dr_model::{DocId, Origin};

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn suite() -> Suite {
    Suite {
        name: "doc",
        about: "dr-doc: one chapter read and typed into, the book document read (chapters, relations, comments, existence, repair check)",
        inputs: &["crates/dr-doc", "crates/dr-model"],
        run,
        expect_quick,
    }
}

fn expect_quick() -> Value {
    json!({
        "bookRead": { "chapters": 4, "comments": 6, "elements": 6, "lookups": 20, "needsRepair": false, "relations": 6, "reps": 3 },
        "chapterRead": { "chars": 1318, "entityLinks": 14, "lookups": 20, "paragraphs": 8, "reps": 3 },
        "keystrokeEdit": { "enters": 2, "writes": 50 },
    })
}

pub fn run(mode: Mode) -> Result<Bench, String> {
    let mut bench = Bench::new("doc", mode);
    let seeded = seed::generate(mode.preset(), DEFAULT_SEED).map_err(err)?;
    let shape = seeded.shape();
    bench.corpus = json!({
        "preset": shape.preset,
        "seed": shape.seed,
        "corpusFingerprint": shape.corpus_fingerprint,
    });
    let book = &seeded.books[0];
    let longest = book
        .prose
        .iter()
        .filter(|p| match p.doc_id() {
            DocId::Node(n) => book
                .book
                .view()
                .node(n)
                .is_some_and(|n| n.kind == NodeKind::Chapter),
            _ => false,
        })
        .max_by_key(|p| p.view().len())
        .ok_or("the seed has no chapters")?;
    let reps = mode.reps(3, 20);
    let lookups = mode.reps(20, 500);

    // One chapter, read.
    let snap = longest.export_snapshot().map_err(err)?;
    let id = longest.doc_id().clone();
    let case = bench.case(
        "chapterRead",
        "the longest chapter: load from its snapshot, read every paragraph (first and warm), paragraph_at / paragraph_in, a position round trip, the entity links",
    );
    let mut chars = 0;
    let mut paragraphs = 0;
    let mut links = 0;
    for _ in 0..reps {
        let d = case
            .time("load", || {
                ProseDoc::load(id.clone(), 2, std::slice::from_ref(&snap))
            })
            .map_err(err)?;
        paragraphs = case.time("readAllFirst", || d.view().paragraphs().count());
        case.time("readAllWarm", || {
            d.view().paragraphs().map(|p| p.runs.len()).sum::<usize>()
        });
        chars = d.view().len();
        let mut rng = Rng::new(11);
        for _ in 0..lookups {
            let at = rng.range(0, chars - 1);
            case.time("paragraphAt", || {
                d.view().paragraph_at(at).map(|p| p.range.len())
            })
            .map_err(err)?;
            case.time("paragraphIn", || d.view().paragraph_in(at, 1).len());
            case.time("posRoundTrip", || {
                let p = d.view().pos(Unit::Char, at)?;
                d.view().pos(Unit::Utf16, p.utf16)
            })
            .map_err(err)?;
        }
        links = case.time("entityLinks", || d.view().entity_links().len());
    }
    case.set("chars", chars)
        .set("paragraphs", paragraphs)
        .set("entityLinks", links)
        .set("lookups", lookups)
        .set("reps", reps);

    // Keystrokes.
    let mut d = ProseDoc::load(id.clone(), 3, &[snap]).map_err(err)?;
    let case = bench.case(
        "keystrokeEdit",
        "ProseDoc::edit of a one-character insert mid-chapter (every 25th an Enter), with the commit's update bytes for storage",
    );
    let writes = mode.reps(50, 2_000);
    let mut enters = 0;
    let mut rng = Rng::new(13);
    for k in 0..writes {
        let at = rng.range(0, d.view().len() - 2);
        let enter = k % 25 == 24;
        enters += enter as usize;
        let (r, c) = case.time("edit", || {
            d.edit(Origin::User, |t| {
                if enter {
                    t.split(at).map(|_| ())
                } else {
                    t.insert_text(at, "字")
                }
            })
        });
        r.map_err(err)?;
        c.ok_or("an edit committed nothing")?;
    }
    case.set("writes", writes).set("enters", enters);

    // The book document.
    let bsnap = book.book.export_snapshot().map_err(err)?;
    let bid = book.book.book_id().clone();
    let case = bench.case(
        "bookRead",
        "the book document: load from its snapshot, list chapters, relations, comments, relations of one element, existence checks, the repair check and plan",
    );
    let mut counts = (0, 0, 0, 0, false);
    for _ in 0..reps {
        let b = case
            .time("load", || {
                BookDoc::load(bid.clone(), 2, std::slice::from_ref(&bsnap))
            })
            .map_err(err)?;
        let v = b.view();
        let chapters = case.time("chapters", || v.chapters().len());
        let relations = case.time("relations", || v.relations());
        let comments = case.time("comments", || v.comments().len());
        let elements = v.elements();
        if let Some(e) = elements.first() {
            let end = EntityRef::new(EntityKind::Element, e.id.to_string());
            case.time("relationsOf", || v.relations_of(&end).len());
        }
        let mut rng = Rng::new(17);
        for _ in 0..lookups {
            let e = &elements[rng.range(0, elements.len() - 1)];
            let r = EntityRef::new(EntityKind::Element, e.id.to_string());
            case.time("entityExists", || v.entity_exists(&r));
        }
        let needs = case.time("needsRepair", || v.needs_repair());
        case.time("repairPlan", || v.repair_plan().is_empty());
        counts = (chapters, relations.len(), comments, elements.len(), needs);
    }
    case.set("chapters", counts.0)
        .set("relations", counts.1)
        .set("comments", counts.2)
        .set("elements", counts.3)
        .set("needsRepair", counts.4)
        .set("lookups", lookups)
        .set("reps", reps);
    Ok(bench)
}
