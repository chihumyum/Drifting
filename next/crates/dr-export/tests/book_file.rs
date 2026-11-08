//! `.driftingbook` v2 on real libraries: a book made through F3's commands
//! (prose with entity links, an anchored comment, a relation, an image with
//! its file, something in the trash, a writing day) goes out and comes back
//! as a new book beside the original, twice, and into another library;
//! damaged, foreign, 0.1 and newer files are refused with nothing written.

use std::collections::BTreeSet;
use std::io::Write as _;

use dr_export::book_file::{self, BookFileError, Progress};
use dr_model::kind::EntityKind;
use dr_model::prose::EntityLink;
use dr_store::Library;
use dr_store::asset::{Variant, VariantBytes};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use serde_json::{Value, json};

struct Env {
    dir: tempfile::TempDir,
    ws: Workspace,
}

impl Drop for Env {
    fn drop(&mut self) {
        self.ws.close();
    }
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path().join("library"), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    Env { dir, ws }
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_owned()
}

fn ids(list: &Value) -> Vec<String> {
    list.as_array().unwrap().iter().map(id).collect()
}

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n-not-a-real-image-but-bytes";

/// A small book with one of everything that has to keep pointing at the
/// right thing.
fn book(ws: &Workspace) -> String {
    let b = id(&out(ws, "book.create", json!({"name": "慢钟"})));
    let line = id(&out(
        ws,
        "storyline.create",
        json!({"book": b, "name": "修理单"}),
    ));
    let cat = id(&out(
        ws,
        "category.create",
        json!({"book": b, "name": "人物", "color": "#9B6A4F"}),
    ));
    let anna = id(&out(
        ws,
        "element.create",
        json!({"book": b, "name": "安娜", "category": cat}),
    ));
    let gone = id(&out(
        ws,
        "element.create",
        json!({"book": b, "name": "旧人"}),
    ));
    let one = id(&out(
        ws,
        "chapter.create",
        json!({"book": b, "title": "一", "storyline": line, "text": "安娜走进钟楼。\n钟停了。"}),
    ));
    out(
        ws,
        "chapter.create",
        json!({"book": b, "title": "二", "text": "雨夜。"}),
    );
    out(
        ws,
        "idea.create",
        json!({"book": b, "title": "构想", "text": "钟会再走吗"}),
    );
    // 安娜 links to her element.
    let link = EntityLink {
        target: anna.clone(),
        kind: EntityKind::Element,
        block: None,
        end_block: None,
    };
    ws.prose_session(&format!("node:{one}"))
        .unwrap()
        .edit(move |t| t.link_entity(0..2, &link))
        .unwrap();
    out(
        ws,
        "comment.create",
        json!({"book": b, "kind": "note", "body": "这里要慢一点",
               "target": {"kind": "node", "id": one}, "range": [2, 6]}),
    );
    let rt = id(&out(
        ws,
        "relation_type.create",
        json!({"book": b, "name": "常去", "orientation": "symmetric",
               "source_kinds": ["element", "node"], "target_kinds": ["element", "node"]}),
    ));
    out(
        ws,
        "relation.create",
        json!({"book": b, "from": {"kind": "element", "id": anna},
               "to": {"kind": "node", "id": one}, "relation_type": rt}),
    );
    // An image with its file.
    let asset = dr_model::id::new_uuid_v7();
    let lib = ws.library();
    let mut import = lib.begin_asset_import(&b, &asset).unwrap();
    import
        .write_variant(
            Variant::Source,
            &VariantBytes {
                bytes: PNG.to_vec(),
                mime: "image/png".into(),
                ext: "png".into(),
                width: 2,
                height: 2,
            },
        )
        .unwrap();
    import.commit().unwrap();
    let sha = lib.asset(&asset, Variant::Source).unwrap().unwrap().sha256;
    out(
        ws,
        "asset.put",
        json!({"book": b, "id": asset, "kind": "image", "mime": "image/png",
               "size": PNG.len(), "sha256": sha, "width": 2, "height": 2}),
    );
    out(
        ws,
        "material.create",
        json!({"book": b, "kind": "image", "title": "钟面", "asset": asset}),
    );
    out(ws, "element.trash", json!({"book": b, "id": gone}));
    // Body templates: prose documents of their own, carried with the book.
    out(
        ws,
        "category_template.set_body",
        json!({"book": b, "category": cat, "paragraphs": [{"heading": 1, "text": "外貌"}, {"text": ""}]}),
    );
    out(
        ws,
        "chapter_template.set_body",
        json!({"book": b, "storyline": line, "paragraphs": [{"heading": 2, "text": "开场"}]}),
    );
    out(
        ws,
        "writing_day.record",
        json!({"book": b, "device": "device-000000000000000000000001", "day": "2026-11-08", "words": 120}),
    );
    b
}

/// Every id a book's lists name.
fn every_id(ws: &Workspace, b: &str) -> BTreeSet<String> {
    let mut all = BTreeSet::from([b.to_owned()]);
    for (name, input) in [
        ("chapter.list", json!({"book": b, "trashed": true})),
        ("idea.list", json!({"book": b, "trashed": true})),
        ("element.list", json!({"book": b, "trashed": true})),
        ("storyline.list", json!({"book": b})),
        ("category.list", json!({"book": b})),
        ("relation.list", json!({"book": b})),
        ("comment.list", json!({"book": b})),
        ("material.list", json!({"book": b})),
    ] {
        all.extend(ids(&out(ws, name, input)));
    }
    all
}

fn reindex(ws: &Workspace, b: &str) {
    for d in ws.library().docs(Some(b), None).unwrap() {
        ws.library().reindex_doc(&d.doc_id).unwrap();
    }
}

/// What a reader of the book sees, without ids.
fn shape(ws: &Workspace, b: &str) -> Value {
    let chapters = out(ws, "chapter.list", json!({"book": b}));
    let text: Vec<Value> = ids(&chapters)
        .iter()
        .map(|c| out(ws, "prose.read", json!({"doc": format!("node:{c}")}))["paragraphs"].clone())
        .map(|ps| {
            Value::from(
                ps.as_array()
                    .unwrap()
                    .iter()
                    .map(|p| p["text"].clone())
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    let comments = out(ws, "comment.list", json!({"book": b}));
    json!({
        "name": out(ws, "book.get", json!({"book": b}))["name"],
        "chapters": chapters.as_array().unwrap().iter().map(|c| c["title"].clone()).collect::<Vec<_>>(),
        "text": text,
        "ideas": out(ws, "idea.list", json!({"book": b})).as_array().unwrap().len(),
        "elements": out(ws, "element.list", json!({"book": b})).as_array().unwrap().iter().map(|e| e["name"].clone()).collect::<Vec<_>>(),
        "trashed": out(ws, "element.list", json!({"book": b, "trashed": true})).as_array().unwrap().iter().filter(|e| e["trashed"] == true).count(),
        "comments": comments.as_array().unwrap().iter().map(|c| json!([c["body"], c["quote"], c["anchored"]])).collect::<Vec<_>>(),
        "relations": out(ws, "relation.list", json!({"book": b})).as_array().unwrap().len(),
        "days": out(ws, "book.writing_days", json!({"book": b, "today": "2026-11-08"}))["today"],
        "templates": templates(ws, b),
    })
}

/// The book's body templates: each category's and storyline's.
fn templates(ws: &Workspace, b: &str) -> Value {
    let mut all = Vec::new();
    for c in ids(&out(ws, "category.list", json!({"book": b}))) {
        all.push(out(
            ws,
            "category_template.body",
            json!({"book": b, "category": c}),
        ));
    }
    for s in ids(&out(ws, "storyline.list", json!({"book": b}))) {
        all.push(out(
            ws,
            "chapter_template.body",
            json!({"book": b, "storyline": s}),
        ));
    }
    Value::from(all)
}

#[test]
fn a_book_goes_out_and_comes_back_as_a_new_book() {
    let e = env();
    let original = book(&e.ws);
    let file = e.dir.path().join("慢钟.driftingbook");
    let steps = std::cell::RefCell::new(Vec::new());
    let wrote = book_file::export_book(&e.ws, &original, &file, &|p: Progress| {
        steps.borrow_mut().push(p)
    })
    .unwrap();
    assert_eq!(wrote.title, "慢钟");
    assert_eq!(wrote.assets, 1);
    assert_eq!(
        wrote.documents, 6,
        "the book, three written prose documents and two templates: {wrote:?}"
    );
    let last = *steps.borrow().last().unwrap();
    assert_eq!(last.done, last.total);

    let before = shape(&e.ws, &original);
    let got = book_file::import_book(&e.ws, &file, &|_| {}).unwrap();
    assert_ne!(got.book, original);
    assert_eq!(got.title, "慢钟");
    let books = ids(&out(&e.ws, "book.list", json!({})));
    assert_eq!(books.len(), 2);
    assert!(books.contains(&got.book));

    // The copy reads as the original, and shares no id with it.
    assert_eq!(shape(&e.ws, &got.book), before);
    assert_eq!(shape(&e.ws, &original), before, "the original is untouched");
    let shared: Vec<_> = every_id(&e.ws, &original)
        .intersection(&every_id(&e.ws, &got.book))
        .cloned()
        .collect();
    assert!(shared.is_empty(), "{shared:?}");

    // Links point inside the copy: 安娜 in its first chapter is its 安娜.
    reindex(&e.ws, &got.book);
    let one = ids(&out(&e.ws, "chapter.list", json!({"book": got.book})))[0].clone();
    let mentions = out(
        &e.ws,
        "mention.list",
        json!({"book": got.book, "from": {"kind": "node", "id": one}}),
    );
    let anna = out(&e.ws, "element.list", json!({"book": got.book}))
        .as_array()
        .unwrap()
        .iter()
        .find(|el| el["name"] == "安娜")
        .map(id)
        .unwrap();
    assert_eq!(mentions[0]["to"], json!({"kind": "element", "id": anna}));
    // So do the relation, the comment and the chapter's storyline.
    let rel = &out(&e.ws, "relation.list", json!({"book": got.book}))[0];
    assert_eq!(rel["from"]["id"], anna);
    assert_eq!(rel["to"]["id"], one);
    let comment = &out(&e.ws, "comment.list", json!({"book": got.book}))[0];
    assert_eq!(comment["target"]["id"], one);
    assert_eq!(comment["anchored"], true);
    let lines = ids(&out(&e.ws, "storyline.list", json!({"book": got.book})));
    assert_eq!(
        out(&e.ws, "chapter.list", json!({"book": got.book}))[0]["storylines"],
        json!(lines)
    );
    // The templates are the copy's own documents, under its owners' ids.
    let cat = ids(&out(&e.ws, "category.list", json!({"book": got.book})))[0].clone();
    assert_eq!(
        out(
            &e.ws,
            "category_template.document",
            json!({"book": got.book, "category": cat})
        )["doc"],
        format!("template:category:{cat}")
    );
    let docs: BTreeSet<String> =
        e.ws.library()
            .docs(Some(&got.book), None)
            .unwrap()
            .into_iter()
            .map(|d| d.doc_id)
            .collect();
    assert!(
        docs.contains(&format!("template:category:{cat}")),
        "{docs:?}"
    );
    assert!(
        docs.contains(&format!("template:storyline:{}", lines[0])),
        "{docs:?}"
    );
    // The image's file came along under the copy's ids.
    let material = &out(&e.ws, "material.list", json!({"book": got.book}))[0];
    let asset = material["asset"].as_str().unwrap();
    let record =
        e.ws.library()
            .asset(asset, Variant::Source)
            .unwrap()
            .unwrap();
    assert_eq!(record.book_id, got.book);
    assert_eq!(std::fs::read(&record.path).unwrap(), PNG);
    assert_eq!(
        out(&e.ws, "asset.get", json!({"book": got.book, "id": asset}))["size"],
        PNG.len()
    );
    // The index is rebuilt: the copy counts its words.
    let words =
        |b: &str| out(&e.ws, "book.word_counts", json!({"book": b}))["book"]["words"].clone();
    reindex(&e.ws, &original);
    assert_eq!(words(&got.book), words(&original));

    // The same file again: a third book beside the other two.
    let again = book_file::import_book(&e.ws, &file, &|_| {}).unwrap();
    assert_ne!(again.book, got.book);
    assert_eq!(ids(&out(&e.ws, "book.list", json!({}))).len(), 3);
    assert_eq!(shape(&e.ws, &again.book), before);
}

#[test]
fn a_book_moves_into_another_library_and_out_again() {
    let a = env();
    let b = env();
    let original = book(&a.ws);
    let before = shape(&a.ws, &original);
    let file = a.dir.path().join("book.driftingbook");
    book_file::export_book(&a.ws, &original, &file, &|_| {}).unwrap();
    let got = book_file::import_book(&b.ws, &file, &|_| {}).unwrap();
    assert_eq!(shape(&b.ws, &got.book), before);
    // The copy exports and imports again.
    let second = b.dir.path().join("again.driftingbook");
    book_file::export_book(&b.ws, &got.book, &second, &|_| {}).unwrap();
    let third = book_file::import_book(&a.ws, &second, &|_| {}).unwrap();
    assert_eq!(shape(&a.ws, &third.book), before);
    assert_eq!(shape(&a.ws, &original), before);
}

#[test]
fn bad_files_are_refused_and_nothing_is_written() {
    let e = env();
    let original = book(&e.ws);
    let file = e.dir.path().join("book.driftingbook");
    book_file::export_book(&e.ws, &original, &file, &|_| {}).unwrap();
    let docs = || e.ws.library().docs(None, None).unwrap().len();
    let assets =
        || std::fs::read_dir(e.dir.path().join("library").join("assets")).map_or(0, |d| d.count());
    let (docs_before, assets_before) = (docs(), assets());

    // A damaged document: one byte changed inside the zip's stored data.
    let mut bytes = std::fs::read(&file).unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes.clone())).unwrap();
    let start = zip.by_name("docs/0.loro").unwrap().data_start().unwrap() as usize;
    bytes[start + 4] ^= 0xff;
    let damaged = e.dir.path().join("damaged.driftingbook");
    std::fs::write(&damaged, &bytes).unwrap();
    assert!(matches!(
        book_file::import_book(&e.ws, &damaged, &|_| {}),
        Err(BookFileError::Damaged(_))
    ));

    let foreign = e.dir.path().join("notes.driftingbook");
    std::fs::write(&foreign, "just text").unwrap();
    assert!(matches!(
        book_file::import_book(&e.ws, &foreign, &|_| {}),
        Err(BookFileError::NotABook)
    ));

    // A 0.1 file: a CBOR map naming the format.
    let legacy = e.dir.path().join("old.driftingbook");
    let mut cbor = vec![0xa7, 0x66];
    cbor.extend_from_slice(b"format\x6ddrifting.book");
    std::fs::write(&legacy, &cbor).unwrap();
    assert!(matches!(
        book_file::import_book(&e.ws, &legacy, &|_| {}),
        Err(BookFileError::Legacy)
    ));

    // From a newer Drifting.
    let newer = e.dir.path().join("newer.driftingbook");
    let mut w = zip::ZipWriter::new(std::fs::File::create(&newer).unwrap());
    w.start_file("manifest.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    w.write_all(br#"{"format":"drifting.book","formatVersion":3}"#)
        .unwrap();
    w.finish().unwrap();
    assert!(matches!(
        book_file::import_book(&e.ws, &newer, &|_| {}),
        Err(BookFileError::Newer)
    ));

    assert_eq!(ids(&out(&e.ws, "book.list", json!({}))), vec![original]);
    assert_eq!((docs(), assets()), (docs_before, assets_before));
}

/// Seeded books (every kind of entity, Plot Grids, patches, anchored
/// comments, materials, links by name) come back with the same digest:
/// dr-testkit reads a book by names, not ids.
#[test]
fn seeded_books_come_back_with_the_same_digest() {
    let mut books = dr_testkit::seed::generate(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap()
    .books;
    books.push(dr_testkit::samples::slow_clock().unwrap());
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = Library::open(&root, library_options("test")).unwrap();
    for b in &books {
        dr_testkit::seed::write_book(&lib, b).unwrap();
    }
    lib.close().unwrap();
    let ws = Workspace::open_dir(&root, "test").unwrap();
    let other = env();
    for b in &books {
        let id = b.book_id().as_str().to_owned();
        let file = dir.path().join(format!("{id}.driftingbook"));
        book_file::export_book(&ws, &id, &file, &|_| {}).unwrap();
        let want = dr_testkit::seed::digest(ws.library(), &id).unwrap();
        let here = book_file::import_book(&ws, &file, &|_| {}).unwrap();
        assert_eq!(
            dr_testkit::seed::digest(ws.library(), &here.book).unwrap(),
            want,
            "{id}"
        );
        let there = book_file::import_book(&other.ws, &file, &|_| {}).unwrap();
        assert_eq!(
            dr_testkit::seed::digest(other.ws.library(), &there.book).unwrap(),
            want,
            "{id} in another library"
        );
    }
    ws.close();
}

#[test]
fn conversation_archive_copy_preserves_immutable_payloads() {
    use dr_doc::conversation::BorrowedConversation;
    use dr_model::DocId;
    use dr_model::conversation::{ConversationEntry, ConversationEntryKind};
    use dr_model::id::ConversationId;

    let e = env();
    let b = book(&e.ws);
    // A valid imported id may be short and collide with a schema root.
    let conversation = ConversationId::parse("entries").unwrap();
    let doc_id = DocId::Conversation(conversation.clone()).to_string();
    let genesis = dr_doc::conversation::genesis(&conversation);
    let h =
        e.ws.library()
            .open_doc(
                &doc_id,
                dr_store::OpenDoc::CreateIfMissing {
                    kind: "conversation",
                    book_id: Some(&b),
                    genesis: &move |doc| {
                        doc.import(&genesis).unwrap();
                    },
                },
            )
            .unwrap();
    let entry = ConversationEntry {
        id: "session-1:1".into(),
        session: "session-1".into(),
        turn: 1,
        kind: ConversationEntryKind::ToolResult,
        payload: json!({"book": b, "conversation": conversation.as_str(), "signature": doc_id}),
    };
    let written = entry.clone();
    h.write(dr_store::Origin::User, move |doc| {
        BorrowedConversation::new(doc, &conversation)
            .unwrap()
            .append(&written)
            .unwrap();
    })
    .unwrap();
    h.close();
    let archive = e.dir.path().join("conversation.driftingbook");
    book_file::export_book(&e.ws, &b, &archive, &|_| {}).unwrap();
    let imported = book_file::import_book(&e.ws, &archive, &|_| {}).unwrap();
    let docs =
        e.ws.library()
            .docs(Some(&imported.book), Some("conversation"))
            .unwrap();
    assert_eq!(docs.len(), 1);
    assert_ne!(docs[0].doc_id, doc_id);
    let DocId::Conversation(new_id) = DocId::parse(&docs[0].doc_id).unwrap() else {
        unreachable!()
    };
    let copied = e.ws.library().load_copy(&docs[0].doc_id).unwrap();
    assert_eq!(
        BorrowedConversation::new(&copied, &new_id)
            .unwrap()
            .entries()
            .unwrap(),
        vec![entry]
    );
    assert_eq!(copied.get_text("body").len_unicode(), 0);
}
