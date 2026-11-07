//! The deriver inside a real dr-store library: the document holder hands it
//! the diffs when idle, the rows land with `indexed_seq`, a library opened
//! with a stale index rebuilds it, and search, outline, references and
//! counts read back what the text says.

use std::sync::Arc;

use dr_doc::prose::{EmbedKind, ProseDoc, ProseTxn};
use dr_index::{TextDeriver, attach, derive_view};
use dr_model::id::{EmbedId, MaterialId};
use dr_model::kind::EntityKind;
use dr_model::prose::{EntityLink, Heading};
use dr_model::{DocId, Origin};
use dr_store::index::RefKind;
use dr_store::{DocHandle, Library, LibraryOptions, OpenDoc};

fn open(root: &std::path::Path, deriver: bool) -> (Library, Option<Arc<TextDeriver>>) {
    let mut o = LibraryOptions::new("0.2.0-test");
    o.configure_doc = Some(Arc::new(dr_doc::schema::configure));
    let d = deriver.then(|| attach(&mut o));
    (Library::open(root, o).unwrap(), d)
}

fn open_doc(lib: &Library, id: &DocId) -> DocHandle {
    let g = dr_doc::prose::genesis(id);
    lib.open_doc(
        &id.to_string(),
        OpenDoc::CreateIfMissing {
            kind: id.kind().prefix(),
            book_id: Some("b1"),
            genesis: &move |d: &loro::LoroDoc| {
                d.import(&g).unwrap();
            },
        },
    )
    .unwrap()
}

/// Write with dr-doc, hand the new bytes to the holder.
fn write(h: &DocHandle, p: &mut ProseDoc, f: impl FnOnce(&mut ProseTxn<'_>) -> dr_doc::Result<()>) {
    let before = p.version();
    let (r, _) = p.edit(Origin::User, f);
    r.unwrap();
    h.import(
        p.export_updates_since(&before).unwrap(),
        dr_store::Origin::Sync,
    )
    .unwrap();
}

fn link(target: &str) -> EntityLink {
    EntityLink {
        target: target.into(),
        kind: EntityKind::Element,
        block: None,
        end_block: None,
    }
}

#[test]
fn holders_derive_from_diffs_and_the_rows_match_the_text() {
    let dir = tempfile::tempdir().unwrap();
    let (lib, deriver) = open(dir.path(), true);
    let deriver = deriver.unwrap();
    let id = DocId::parse("node:c1").unwrap();
    let h = open_doc(&lib, &id);
    let mut p = ProseDoc::create(id.clone(), 5).unwrap();
    write(&h, &mut p, |t| {
        t.insert_paragraphs(0, "第一章\n安娜走进了站台。\nHello world\n尾声")?;
        t.set_heading(0, Some(Heading::H1))?;
        t.set_heading(25, Some(Heading::H3))?;
        t.link_entity(4..6, &link("anna"))?;
        let mid = t.view().paragraph_start(16);
        t.insert_embed(
            mid,
            &EmbedId::parse("m1").unwrap(),
            &EmbedKind::Material(MaterialId::parse("mat").unwrap()),
        )?;
        Ok(())
    });
    assert!(h.reindex_now().unwrap());
    // A keystroke, then the next derivation works from its diff.
    write(&h, &mut p, |t| t.insert_text(6, "·卡列尼娜"));
    assert!(h.reindex_now().unwrap());
    assert!(deriver.stats().incremental >= 1, "{:?}", deriver.stats());

    let want = derive_view(&p.view());
    let stats = lib.doc_stats(&id.to_string()).unwrap().unwrap();
    assert_eq!(
        (stats.words, stats.chars, stats.paragraphs),
        (want.words, want.chars, want.blocks.len() as u64)
    );
    // 第一章 / 安娜·卡列尼娜走进了站台 (the middle dot is no word) / Hello world / 尾声
    assert_eq!(stats.words, 3 + 11 + 2 + 2);
    let outline: Vec<(u8, String)> = lib
        .outline(&id.to_string())
        .unwrap()
        .into_iter()
        .map(|o| (o.heading, o.text))
        .collect();
    assert_eq!(
        outline,
        vec![(1, "第一章".to_string()), (3, "尾声".to_string())]
    );
    let hits = lib.search(Some("b1"), "卡列尼娜", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].snippet, "安娜·卡列尼娜走进了站台。");
    // One- and two-character queries fall back to LIKE.
    assert_eq!(lib.search(Some("b1"), "站", 10).unwrap().len(), 1);
    let refs = lib.references_to("anna").unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!((refs[0].kind, refs[0].count), (RefKind::Link, 1));
    let embeds = lib.references_to("mat").unwrap();
    assert_eq!(embeds.len(), 1);
    assert_eq!(embeds[0].kind, RefKind::Embed);
    h.close();
    lib.close().unwrap();
}

#[test]
fn a_stale_index_is_rebuilt_when_the_library_opens() {
    let dir = tempfile::tempdir().unwrap();
    let id = DocId::parse("node:c1").unwrap();
    {
        // Written by a build without a deriver: nothing derived.
        let (lib, _) = open(dir.path(), false);
        let h = open_doc(&lib, &id);
        let mut p = ProseDoc::create(id.clone(), 5).unwrap();
        write(&h, &mut p, |t| {
            t.insert_paragraphs(0, "一段话\n二段话").map(|_| ())
        });
        h.close();
        assert_eq!(lib.stale_index_docs().unwrap(), vec![id.to_string()]);
        lib.close().unwrap();
    }
    let mut o = LibraryOptions::new("0.2.0-test");
    attach(&mut o);
    o.rebuild_indexes_on_open = false;
    let lib = Library::open(dir.path(), o).unwrap();
    assert_eq!(lib.rebuild_stale_indexes().unwrap(), 1);
    assert!(lib.stale_index_docs().unwrap().is_empty());
    assert_eq!(lib.doc_stats(&id.to_string()).unwrap().unwrap().words, 6);
    assert_eq!(lib.search(None, "二段", 5).unwrap().len(), 1);
    lib.close().unwrap();
}

#[test]
fn book_documents_are_recorded_as_indexed() {
    let dir = tempfile::tempdir().unwrap();
    let (lib, _) = open(dir.path(), true);
    let book = dr_model::id::BookId::parse("b1").unwrap();
    let g = dr_doc::book::genesis(&book);
    let h = lib
        .open_doc(
            "book:b1",
            OpenDoc::CreateIfMissing {
                kind: "book",
                book_id: Some("b1"),
                genesis: &move |d: &loro::LoroDoc| {
                    d.import(&g).unwrap();
                },
            },
        )
        .unwrap();
    assert!(h.reindex_now().unwrap());
    assert!(lib.stale_index_docs().unwrap().is_empty());
    assert_eq!(lib.doc_stats("book:b1").unwrap().unwrap().paragraphs, 0);
    h.close();
    lib.close().unwrap();
}
