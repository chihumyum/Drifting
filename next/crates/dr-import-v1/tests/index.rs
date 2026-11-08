//! A library imported from 0.1 (M10) gets search, outlines, references and
//! word counts when it opens: the imported documents have no index yet, so
//! the open rebuilds them. The 0.1 library is M10's own synthetic builder.
//!
//! dr-index's end-to-end check; it lives here (dr-import-v1 depends on
//! dr-index) because dr-index depending on dr-import-v1, even for tests,
//! would close a cycle that dx's hot patching refuses.

#[path = "common/mod.rs"]
mod old;

use dr_doc::prose::ProseDoc;
use dr_import_v1::gate::Accept;
use dr_import_v1::run::{self, Options, Outcome};
use dr_index::{attach, derive_view};
use dr_model::DocId;
use dr_store::index::RefKind;
use dr_store::{Library, LibraryOptions};

#[test]
fn an_imported_library_is_indexed_when_it_opens() {
    let src = old::build(true);
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let mut o = Options::new("0.2.0-test");
    o.accept = Accept::NOTHING;
    o.old_root = Some(src.root.clone());
    o.device_dir = Some(dir.path().join("device"));
    // The import builds the indexes itself; this test checks the rebuild on
    // open, so it imports without them.
    o.index = false;
    let (outcome, _) = run::import(&src.db, &root, &o).unwrap();
    assert!(matches!(outcome, Outcome::Imported(_)));

    let mut options = LibraryOptions::new("0.2.0-test");
    attach(&mut options);
    options.rebuild_indexes_on_open = false;
    let lib = Library::open(&root, options).unwrap();
    let stale = lib.stale_index_docs().unwrap();
    assert_eq!(
        stale.len(),
        9,
        "six bodies, the two body templates and the book: {stale:?}"
    );
    assert_eq!(lib.rebuild_stale_indexes().unwrap(), 9);
    assert!(lib.stale_index_docs().unwrap().is_empty());

    // Every body's counts are what dr-doc reads from it; a template is not
    // the book's text (`DocKind::is_book_text`).
    let mut total = 0;
    for id in stale
        .iter()
        .filter(|d| !d.starts_with("book:") && !d.starts_with("template:"))
    {
        let doc_id = DocId::parse(id).unwrap();
        let snap = lib
            .load_copy(id)
            .unwrap()
            .export(loro::ExportMode::Snapshot)
            .unwrap();
        let p = ProseDoc::load(doc_id, 3, &[snap]).unwrap();
        let want = derive_view(&p.view());
        let got = lib.doc_stats(id).unwrap().unwrap();
        assert_eq!((got.words, got.chars), (want.words, want.chars), "{id}");
        total += got.words;
    }
    assert_eq!(lib.book_stats(old::BOOK).unwrap().words, total);
    // The templates are indexed empty: their words are not the book's.
    for id in stale.iter().filter(|d| d.starts_with("template:")) {
        assert_eq!(lib.doc_stats(id).unwrap().unwrap().words, 0, "{id}");
    }
    assert!(lib.search(Some(old::BOOK), "外貌", 10).unwrap().is_empty());

    let chapter = format!("node:{}", old::CHAPTER);
    // 第一章 序 / 我要给阿Q做正传，已经不止一两年了。 / 引文第一段 / 引文第二段 /
    // TODO: 查一查赵太爷的年纪
    assert_eq!(
        lib.doc_stats(&chapter).unwrap().unwrap().words,
        4 + 16 + 5 + 5 + 10
    );
    let outline: Vec<(u8, String, Option<String>)> = lib
        .outline(&chapter)
        .unwrap()
        .into_iter()
        .map(|o| (o.heading, o.text, o.block_id))
        .collect();
    assert_eq!(outline, vec![(1, "第一章 序".into(), Some("h1".into()))]);
    // Search: two characters through LIKE, three through FTS5.
    let hits: Vec<(String, Option<String>)> = lib
        .search(Some(old::BOOK), "阿Q", 10)
        .unwrap()
        .into_iter()
        .map(|h| (h.doc_id, h.block_id))
        .collect();
    // The chapter's paragraph and the storyline's description (阿Q 的一生。).
    assert_eq!(
        hits,
        vec![
            (chapter.clone(), Some("p1".into())),
            (format!("storyline:{}", old::STORYLINE), Some("s-p1".into())),
        ]
    );
    let hits = lib.search(Some(old::BOOK), "赵太爷", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].block_id.as_deref(), Some("p2"));
    // The entity link and the material embed are references.
    let refs = lib.references_to(old::ELEMENT).unwrap();
    assert!(
        refs.iter().any(|r| r.source_doc == chapter
            && r.kind == RefKind::Link
            && r.source_block.as_deref() == Some("p1")),
        "{refs:?}"
    );
    let embeds = lib.references_to(old::IMAGE).unwrap();
    assert!(
        embeds
            .iter()
            .any(|r| r.source_doc == format!("material:{}", old::NOTE) && r.kind == RefKind::Embed),
        "{embeds:?}"
    );
    lib.close().unwrap();
}
