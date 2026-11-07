//! The seed's contract, asserted instead of committed as JSON: exact scale,
//! determinism (pinned corpus fingerprints), a valid book, storage.

use dr_doc::prose::ProseDoc;
use dr_testkit::seed::{self, DEFAULT_SEED, Preset};

/// The corpus fingerprints of the default seed. A change here is a change
/// of every benchmark's corpus: say so in the commit, and expect measured
/// evidence that names the old fingerprint to need a rerun.
const PINNED: &[(Preset, &str)] = &[
    (
        Preset::Tiny,
        "e0f5e2d7629f66b78df7069a445ff39798efc1832796e105e4cf164d5e0262af",
    ),
    (
        Preset::Lite,
        "4c3aa1566c98be7334032ca77090b496eae2b8dc0045ac9a6bd5bf5c4c6eed1a",
    ),
    (
        Preset::Heavy,
        "5b319924c784252a98d35588c557a642ff4fb6b347f3a3603a9f1696a54bfb48",
    ),
];

fn check_scale(preset: Preset) -> seed::Seeded {
    let s = seed::generate(preset, DEFAULT_SEED).unwrap();
    let shape = s.shape();
    let spec = preset.spec().unwrap();
    for (name, b) in spec.groups() {
        let g = &shape.bodies[name];
        assert_eq!(
            (g.count, g.total_words, g.min_words, g.max_words),
            (b.count, b.total, b.min, b.max),
            "{} {name}",
            preset.name()
        );
    }
    assert_eq!(shape.chapters, spec.chapters.count);
    assert_eq!(shape.elements, spec.elements.count);
    assert_eq!(shape.relations, spec.relations);
    assert_eq!(shape.acts, spec.acts);
    assert!(shape.writing_days > 0);
    assert!(shape.entity_links > 0);
    // Tiny bodies are too short to reach the third heading.
    if preset != Preset::Tiny {
        assert!(shape.headings.iter().all(|&n| n > 0), "every heading level");
    }
    assert!(shape.tasks > 0);
    // One prose document per body, plus the book document; comments and
    // TODOs live in the book document.
    let prose_bodies: usize = spec
        .groups()
        .iter()
        .filter(|(n, _)| *n != "todos" && *n != "comments")
        .map(|(_, b)| b.count)
        .sum();
    assert_eq!(shape.documents, prose_bodies + 1);

    let book = &s.books[0];
    let view = book.book.view();
    assert!(
        view.repair_plan().is_empty(),
        "the seeded book needs no repair"
    );
    assert!(view.element_name_conflicts().is_empty());
    let chapters = view.chapters();
    assert!(
        chapters
            .windows(2)
            .all(|w| w[0].book_order < w[1].book_order)
    );
    assert!(chapters.iter().all(|c| !c.storylines.is_empty()));
    let comments = view.comments();
    assert_eq!(comments.len(), spec.todos.count + spec.comments.count);
    assert!(
        comments
            .iter()
            .all(|c| c.anchor.is_some() && c.target.is_some())
    );
    for p in &book.prose {
        assert!(view.owns_prose(p.doc_id()), "{}", p.doc_id());
    }
    s
}

#[test]
fn tiny_and_lite_have_their_exact_scale() {
    check_scale(Preset::Tiny);
    check_scale(Preset::Lite);
}

#[test]
fn heavy_has_the_scale_of_the_old_stress_seed() {
    let s = check_scale(Preset::Heavy);
    let shape = s.shape();
    assert_eq!(shape.bodies["chapters"].total_words, 1_500_000);
    assert_eq!(shape.bodies["elements"].count, 300);
    assert_eq!(shape.bodies["ideas"].count, 200);
}

/// `docs/dev-cli/acceptance/seed-presets.json` is the 0.1 client's audit of
/// its `lite` and `stress` seeds; it goes away with the old client (stage
/// 7), and the constants in `preset.rs` stay.
#[test]
fn budgets_match_the_old_seed_audit_while_it_exists() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/dev-cli/acceptance/seed-presets.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let audit: serde_json::Value = serde_json::from_str(&text).unwrap();
    for (preset, old) in [(Preset::Lite, "lite"), (Preset::Heavy, "stress")] {
        let spec = preset.spec().unwrap();
        for (name, b) in spec.groups() {
            let old_name = if name == "ideas" {
                "inspirations"
            } else {
                name
            };
            let g = &audit["results"][old]["bodies"][old_name];
            let got = [b.count, b.total, b.min, b.max].map(|x| x as u64);
            let want = ["count", "totalWords", "minWords", "maxWords"].map(|k| {
                g[k].as_u64()
                    .unwrap_or_else(|| panic!("{old} {old_name} {k}"))
            });
            assert_eq!(got, want, "{old} {old_name}");
        }
    }
}

#[test]
fn the_same_seed_gives_identical_documents_and_pinned_fingerprints() {
    for (preset, want) in PINNED {
        if *preset == Preset::Heavy {
            continue; // pinned below, generated once
        }
        let a = seed::generate(*preset, DEFAULT_SEED).unwrap();
        let b = seed::generate(*preset, DEFAULT_SEED).unwrap();
        assert_eq!(a.shape(), b.shape());
        assert_eq!(&a.shape().corpus_fingerprint, want, "{}", preset.name());
        let (x, y) = (&a.books[0], &b.books[0]);
        assert_eq!(
            x.book.export_snapshot().unwrap(),
            y.book.export_snapshot().unwrap()
        );
        for (p, q) in x.prose.iter().zip(&y.prose) {
            assert_eq!(p.export_snapshot().unwrap(), q.export_snapshot().unwrap());
        }
    }
    let other = seed::generate(Preset::Tiny, DEFAULT_SEED + 1).unwrap();
    assert_ne!(other.shape().corpus_fingerprint, PINNED[0].1);
}

#[test]
fn heavy_fingerprint_is_pinned() {
    let s = seed::generate(Preset::Heavy, DEFAULT_SEED).unwrap();
    assert_eq!(s.shape().corpus_fingerprint, PINNED[2].1);
}

#[test]
fn a_seed_writes_into_a_store_and_reads_back() {
    let dir = tempfile::tempdir().unwrap();
    let s = seed::generate(Preset::Tiny, DEFAULT_SEED).unwrap();
    let lib = dr_store::Library::open(dir.path(), seed::library_options("0.2.0-test")).unwrap();
    let written = s.write_to(&lib).unwrap();
    assert_eq!(written, s.shape().documents);
    assert_eq!(s.write_to(&lib).unwrap(), 0, "a second write adds nothing");
    let book = &s.books[0];
    let id = book.book_id().as_str();
    assert_eq!(lib.docs(Some(id), None).unwrap().len(), written);
    for p in &book.prose {
        let copy = lib.load_copy(&p.doc_id().to_string()).unwrap();
        let back = ProseDoc::load(
            p.doc_id().clone(),
            7,
            &[copy.export(loro::ExportMode::Snapshot).unwrap()],
        )
        .unwrap();
        assert_eq!(back.view().plain_text(), p.view().plain_text());
        assert_eq!(back.view().entity_links(), p.view().entity_links());
    }
    lib.close().unwrap();
}
