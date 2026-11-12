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

fn check_v3_invariants(book: &seed::SeededBookV3) {
    let view = book.book.view();
    assert!(
        view.repair_plan().is_empty(),
        "the v3 seeded book needs no repair"
    );
    assert!(view.autolink_name_conflicts().is_empty());
    let entries = view.entries_map();
    let templates = view.templates_map();
    let memberships = view.memberships_raw();
    for e in entries.values().filter(|e| !e.is_trashed()) {
        assert!(dr_model::v3::check_parent_is_level(e.parent.as_ref(), &entries).is_ok());
    }
    for m in &memberships {
        assert!(dr_model::v3::check_membership(&m.host, &m.member, &entries, &templates).is_ok());
    }
    assert_eq!(view.manuscript_levels().len(), 1);
    for tv in view.timeline_views_raw() {
        for l in &tv.lanes {
            assert!(dr_model::v3::check_timeline_lane(&l.entry, &entries, &templates).is_ok());
        }
        for p in &tv.placements {
            assert!(
                dr_model::v3::check_timeline_placement_in_lane(
                    &tv,
                    &p.entry,
                    &memberships,
                    &entries,
                    &templates,
                )
                .is_ok()
            );
        }
        for pin in &tv.pins {
            if let Some(eid) = &pin.entry {
                assert!(dr_model::v3::check_timeline_target_live(eid, &entries).is_ok());
            }
        }
    }
    for p in &book.prose {
        assert!(view.owns_prose(p.doc_id()), "{}", p.doc_id());
    }
}

fn check_scale_v3(preset: Preset) -> seed::SeededV3 {
    let s = seed::generate_v3(preset, DEFAULT_SEED).unwrap();
    let shape = s.shape();
    let spec = preset.spec().unwrap();
    for (name, b) in spec.groups() {
        let g = &shape.bodies[name];
        assert_eq!(
            (g.count, g.total_words, g.min_words, g.max_words),
            (b.count, b.total, b.min, b.max),
            "v3 {} {name}",
            preset.name()
        );
    }
    assert_eq!(shape.chapters, spec.chapters.count);
    assert_eq!(shape.elements, spec.elements.count);
    assert_eq!(shape.relations, spec.relations);
    assert_eq!(shape.acts, spec.acts);
    assert!(shape.writing_days > 0);
    assert!(shape.entity_links > 0);
    if preset != Preset::Tiny {
        assert!(shape.headings.iter().all(|&n| n > 0), "every heading level");
    }
    assert!(shape.tasks > 0);
    let prose_bodies: usize = spec
        .groups()
        .iter()
        .filter(|(n, _)| *n != "todos" && *n != "comments")
        .map(|(_, b)| b.count)
        .sum();
    // The prose, the book, and the two documents beside it.
    assert_eq!(shape.documents, prose_bodies + 3);

    let book = &s.books[0];
    check_v3_invariants(book);
    let view = book.book.view();
    let tpl_ms = dr_model::id::EntryTemplateId::parse(dr_doc::v3::novel::TPL_MANUSCRIPT).unwrap();
    let ms = view
        .root_entry_by_template(&tpl_ms)
        .expect("manuscript root entry");
    let structure = view.structure_snapshot();
    let leaves: Vec<_> = structure
        .manuscript()
        .into_iter()
        .filter(|p| p.root.id == ms.id)
        .flat_map(|p| p.entries)
        .filter(|e| e.ordinal.is_some())
        .map(|e| e.entry.clone())
        .collect();
    assert_eq!(leaves.len(), spec.chapters.count);
    assert!(
        leaves
            .iter()
            .all(|c| !view.memberships_of_member(&c.id).is_empty())
    );
    let comments = view.comments();
    assert_eq!(comments.len(), spec.todos.count + spec.comments.count);
    assert!(
        comments
            .iter()
            .all(|c| c.anchor.is_some() && c.target.is_some() && c.target_module.is_some())
    );
    s
}

#[test]
fn v3_tiny_lite_and_heavy_align_with_v2_scale_and_pinned_fingerprints() {
    for (preset, want_fp) in PINNED {
        let v3 = check_scale_v3(*preset);
        assert_eq!(
            &v3.shape().corpus_fingerprint,
            want_fp,
            "v3 {}",
            preset.name()
        );
        if *preset != Preset::Heavy {
            let v2 = seed::generate(*preset, DEFAULT_SEED).unwrap();
            // A v3 seed writes the two documents beside each book
            // (`stats:`, `checkpoints:`) on top of what a v2 seed writes;
            // everything else matches.
            let mut shape = v3.shape();
            let beside = 2 * v3.books.len();
            assert_eq!(
                shape.documents,
                v2.shape().documents + beside,
                "{}",
                preset.name()
            );
            shape.documents -= beside;
            assert_eq!(
                shape,
                v2.shape(),
                "v3 shape matches v2 for {}",
                preset.name()
            );
            let again = seed::generate_v3(*preset, DEFAULT_SEED).unwrap();
            assert_eq!(
                v3.books[0].book.export_snapshot().unwrap(),
                again.books[0].book.export_snapshot().unwrap()
            );
            for (p, q) in v3.books[0].prose.iter().zip(&again.books[0].prose) {
                assert_eq!(p.export_snapshot().unwrap(), q.export_snapshot().unwrap());
            }
        }
    }
}

#[test]
fn v3_seed_writes_into_a_store_and_indexes_by_entry_and_module() {
    let dir = tempfile::tempdir().unwrap();
    let s = seed::generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
    let mut opts = seed::library_options("0.2.0-test");
    dr_index::attach(&mut opts);
    let lib = dr_store::Library::open(dir.path(), opts).unwrap();
    let written = s.write_to(&lib).unwrap();
    assert_eq!(written, s.shape().documents);
    assert_eq!(s.write_to(&lib).unwrap(), 0, "a second write adds nothing");
    lib.rebuild_stale_indexes().unwrap();
    let book = &s.books[0];
    let id = book.book_id().as_str();
    assert_eq!(lib.docs(Some(id), None).unwrap().len(), written);

    let view = book.book.view();
    let tpl_ms = dr_model::id::EntryTemplateId::parse(dr_doc::v3::novel::TPL_MANUSCRIPT).unwrap();
    let ms = view
        .root_entry_by_template(&tpl_ms)
        .expect("manuscript root entry");
    let structure = view.structure_snapshot();
    let chapters: Vec<_> = structure
        .manuscript()
        .into_iter()
        .filter(|p| p.root.id == ms.id)
        .flat_map(|p| p.entries)
        .filter(|e| e.ordinal.is_some())
        .map(|e| e.entry.clone())
        .collect();
    let pairs: Vec<(&str, &str)> = chapters
        .iter()
        .map(|c| (c.id.as_str(), dr_doc::v3::novel::MOD_PROSE))
        .collect();
    let ms_stats = lib.manuscript_stats(Some(id), &pairs).unwrap();
    assert_eq!(
        ms_stats.words as usize,
        s.shape().bodies["chapters"].total_words
    );
    assert!(!lib.entry_module_references_in_book(id).unwrap().is_empty());

    let d1 = seed::digest_v3(&lib, id).unwrap();
    let dir2 = tempfile::tempdir().unwrap();
    let v2 = seed::generate(Preset::Tiny, DEFAULT_SEED).unwrap();
    let converted = seed::book_to_v3(&v2.books[0]).unwrap();
    let lib2 = dr_store::Library::open(dir2.path(), seed::library_options("0.2.0-test")).unwrap();
    seed::write_book_v3(&lib2, &converted).unwrap();
    let d2 = seed::digest_v3(&lib2, id).unwrap();
    assert_eq!(d1, d2);

    // Also verify template:<book>/<tid>/<mid> skips text indexing while body: documents are indexed.
    let tpl_doc_id =
        dr_model::id::DocId::parse(&format!("template:{id}/tpl-chapter/mod-prose")).unwrap();
    let mut tpl_doc = ProseDoc::create(tpl_doc_id, 1).unwrap();
    let (r, _) = tpl_doc.edit(dr_model::origin::Origin::User, |t| {
        t.insert_paragraphs(0, "模板默认字")
    });
    r.unwrap();
    let tpl_id_str = tpl_doc.doc_id().to_string();
    let h_tpl = lib
        .open_doc(
            &tpl_id_str,
            dr_store::OpenDoc::CreateIfMissing {
                kind: dr_store::index::DOC_KIND_TEMPLATE,
                book_id: Some(id),
                genesis: &move |d| {
                    d.import(&tpl_doc.export_snapshot().unwrap()).unwrap();
                },
            },
        )
        .unwrap();
    drop(h_tpl);
    lib.rebuild_stale_indexes().unwrap();
    assert!(
        lib.search_entry_modules(Some(id), None, None, "模板默认字", 10)
            .unwrap()
            .is_empty(),
        "template:<book>/<tid>/<mid> must not enter search or manuscript stats"
    );

    lib.close().unwrap();
    lib2.close().unwrap();
}

#[test]
fn two_novel_books_in_one_library_have_disjoint_doc_ids_and_purging_one_keeps_the_other() {
    use dr_doc::v3::{
        BookDocV3,
        novel::{
            MOD_DESCRIPTION, MOD_PROSE, TPL_CHAPTER, TPL_CHARACTER, apply_novel_project_template,
        },
    };
    use dr_model::{
        DocId, Origin,
        id::{BodyDocId, BookId, EntryId, EntryTemplateId, ModuleId, TemplateId},
        v3::{book_doc_ids_v3, check_doc_ids_unique_across_books},
    };
    use std::collections::BTreeSet;

    let dir = tempfile::tempdir().unwrap();
    let mut opts = seed::library_options("0.2.0-test");
    dr_index::attach(&mut opts);
    let lib = dr_store::Library::open(dir.path(), opts).unwrap();

    let build_novel_in_lib = |book_id_str: &str, title: &str, peer_seed: u64| {
        let book_id = BookId::parse(book_id_str).unwrap();
        let mut book_doc = BookDocV3::create(book_id.clone(), peer_seed).unwrap();
        let (roots, _) = book_doc.edit(Origin::User, |t| {
            t.meta().name(title)?;
            let roots = apply_novel_project_template(t)?;
            let ch_id = EntryId::new_v7();
            let ch_tpl = EntryTemplateId::parse(TPL_CHAPTER).unwrap();
            t.entries().create(
                &ch_id,
                Some(&roots.manuscript),
                &format!("{title} 第一章"),
                Some(&ch_tpl),
                false,
            )?;
            let char_id = EntryId::new_v7();
            let char_tpl = EntryTemplateId::parse(TPL_CHARACTER).unwrap();
            t.entries().create(
                &char_id,
                Some(&roots.cat_character),
                &format!("{title} 主角"),
                Some(&char_tpl),
                false,
            )?;
            Ok(roots)
        });
        let roots = roots.unwrap();

        let view = book_doc.view();
        let entries = view.entries_map();
        let templates = view.templates_map();
        let description = ModuleId::parse(MOD_DESCRIPTION).unwrap();

        let book_doc_id = DocId::Book(book_id.clone()).to_string();
        let h_book = lib
            .open_doc(
                &book_doc_id,
                dr_store::OpenDoc::CreateIfMissing {
                    kind: dr_store::index::DOC_KIND_BOOK,
                    book_id: Some(book_id.as_str()),
                    genesis: &|d| {
                        d.import(&book_doc.export_snapshot().unwrap()).unwrap();
                    },
                },
            )
            .unwrap();
        drop(h_book);

        // The two documents beside the book, each named by the book's id.
        let mut prose_doc_ids = Vec::new();
        let device = dr_model::id::DeviceKey::from_installation_id(title);
        let mut stats = dr_doc::side::StatsDoc::create(book_id.clone(), peer_seed + 3).unwrap();
        let day = dr_model::Day::parse("2026-11-13").unwrap();
        stats
            .edit(Origin::User, |t| t.writing_day(&device, &day, 42))
            .0
            .unwrap();
        let points = dr_doc::side::CheckpointsDoc::create(book_id.clone(), peer_seed + 4).unwrap();
        for (doc_id, snapshot) in [
            (stats.doc_id().clone(), stats.export_snapshot().unwrap()),
            (points.doc_id().clone(), points.export_snapshot().unwrap()),
        ] {
            assert!(view.owns_prose(&doc_id));
            let h = lib
                .open_doc(
                    &doc_id.to_string(),
                    dr_store::OpenDoc::CreateIfMissing {
                        kind: doc_id.kind().prefix(),
                        book_id: Some(book_id.as_str()),
                        genesis: &|d| {
                            d.import(&snapshot).unwrap();
                        },
                    },
                )
                .unwrap();
            drop(h);
            prose_doc_ids.push(doc_id);
        }
        // Write every entry module prose doc (the 「说明」 of roots and
        // categories, `mod-prose` of chapters and characters).
        for entry in entries.values() {
            if let Some(tpl) = entry.effective_template(&templates) {
                for m in tpl.prose_modules() {
                    let doc_id = DocId::Body(BodyDocId::new(entry.id.clone(), m.id.clone()));
                    assert!(view.owns_prose(&doc_id));
                    let mut p = ProseDoc::create(doc_id.clone(), peer_seed + 1).unwrap();
                    let (r, _) = p.edit(Origin::User, |t| {
                        t.insert_paragraphs(0, &format!("{title} {} {}", entry.title, m.id))
                    });
                    r.unwrap();
                    let id_str = doc_id.to_string();
                    let h = lib
                        .open_doc(
                            &id_str,
                            dr_store::OpenDoc::CreateIfMissing {
                                kind: dr_store::index::DOC_KIND_BODY,
                                book_id: Some(book_id.as_str()),
                                genesis: &|d| {
                                    d.import(&p.export_snapshot().unwrap()).unwrap();
                                },
                            },
                        )
                        .unwrap();
                    drop(h);
                    prose_doc_ids.push(doc_id);
                }
            }
        }
        // Also write template default prose docs for this book.
        for tpl_str in [TPL_CHAPTER, TPL_CHARACTER] {
            let tid = EntryTemplateId::parse(tpl_str).unwrap();
            let mid = ModuleId::parse(MOD_PROSE).unwrap();
            let tpl_id = TemplateId::for_entry_module(&book_id, &tid, &mid);
            let doc_id = DocId::Template(tpl_id);
            assert!(view.owns_prose(&doc_id));
            let mut p = ProseDoc::create(doc_id.clone(), peer_seed + 2).unwrap();
            let (r, _) = p.edit(Origin::User, |t| {
                t.insert_paragraphs(0, &format!("{title} 模板正文 {tpl_str}"))
            });
            r.unwrap();
            let id_str = doc_id.to_string();
            let h = lib
                .open_doc(
                    &id_str,
                    dr_store::OpenDoc::CreateIfMissing {
                        kind: dr_store::index::DOC_KIND_TEMPLATE,
                        book_id: Some(book_id.as_str()),
                        genesis: &|d| {
                            d.import(&p.export_snapshot().unwrap()).unwrap();
                        },
                    },
                )
                .unwrap();
            drop(h);
            prose_doc_ids.push(doc_id);
        }

        // The manuscript root's 「说明」 is one of them.
        let ms_description = DocId::Body(BodyDocId::new(roots.manuscript.clone(), description));
        assert!(prose_doc_ids.contains(&ms_description));

        (book_id, book_doc, prose_doc_ids)
    };

    let (b1_id, b1_doc, b1_prose) = build_novel_in_lib("book-novel-1", "第一本小说", 10);
    let (b2_id, b2_doc, b2_prose) = build_novel_in_lib("book-novel-2", "第二本小说", 20);

    let v1 = b1_doc.view();
    let v2 = b2_doc.view();
    let e1 = v1.entries_map();
    let t1 = v1.templates_map();
    let e2 = v2.entries_map();
    let t2 = v2.templates_map();

    let all_docs_b1 = book_doc_ids_v3(&b1_id, &e1, &t1);
    let all_docs_b2 = book_doc_ids_v3(&b2_id, &e2, &t2);
    check_doc_ids_unique_across_books(&[
        (b1_id.clone(), all_docs_b1),
        (b2_id.clone(), all_docs_b2),
    ])
    .expect("V3-DOCID-LIBRARY-UNIQUE must hold for two novels in one library");

    // Cross-book ownership check: neither book claims any prose doc of the other.
    for d in &b1_prose {
        assert!(!v2.owns_prose(d), "book 2 must not claim book 1 doc {d}");
    }
    for d in &b2_prose {
        assert!(!v1.owns_prose(d), "book 1 must not claim book 2 doc {d}");
    }

    let b1_docs_before: BTreeSet<String> = lib
        .docs(Some(b1_id.as_str()), None)
        .unwrap()
        .into_iter()
        .map(|r| r.doc_id)
        .collect();
    let b2_docs_before: BTreeSet<String> = lib
        .docs(Some(b2_id.as_str()), None)
        .unwrap()
        .into_iter()
        .map(|r| r.doc_id)
        .collect();
    assert!(b1_docs_before.is_disjoint(&b2_docs_before));
    assert_eq!(b1_docs_before.len(), 1 + b1_prose.len());
    assert_eq!(b2_docs_before.len(), 1 + b2_prose.len());

    let b2_values: std::collections::BTreeMap<_, _> = b2_docs_before
        .iter()
        .map(|id| (id.clone(), lib.load_copy(id).unwrap().get_deep_value()))
        .collect();

    // Permanently delete book 1 (all its docs) from the library.
    for doc_id in &b1_docs_before {
        lib.purge_doc(doc_id).unwrap();
    }
    assert!(lib.docs(Some(b1_id.as_str()), None).unwrap().is_empty());

    // Every single document of book 2 remains intact and readable.
    let b2_docs_after: BTreeSet<String> = lib
        .docs(Some(b2_id.as_str()), None)
        .unwrap()
        .into_iter()
        .map(|r| r.doc_id)
        .collect();
    assert_eq!(b2_docs_after, b2_docs_before);
    for doc_id in &b2_docs_after {
        assert_eq!(
            lib.load_copy(doc_id).unwrap().get_deep_value(),
            b2_values[doc_id]
        );
    }

    lib.close().unwrap();
}
