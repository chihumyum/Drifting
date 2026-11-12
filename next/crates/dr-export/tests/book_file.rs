//! Canonical archive refusal and immutable conversation payload contracts.
use std::io::Write as _;

use dr_export::book_file::{self, BookFileError};
use dr_store::Library;
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

fn book(ws: &Workspace) -> String {
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let b = &seed.books[0];
    dr_testkit::seed::write_book_v3(ws.library(), b).unwrap();
    b.book_id().to_string()
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

    // From a newer Drifting, and from an earlier development build (format
    // 3, before the documents beside the book).
    for (version, name) in [(5, "newer"), (3, "older")] {
        let file = e.dir.path().join(format!("{name}.driftingbook"));
        let mut w = zip::ZipWriter::new(std::fs::File::create(&file).unwrap());
        w.start_file("manifest.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(
            format!(r#"{{"format":"drifting.book","formatVersion":{version}}}"#).as_bytes(),
        )
        .unwrap();
        w.finish().unwrap();
        let refused = book_file::import_book(&e.ws, &file, &|_| {});
        match version {
            5 => assert!(matches!(refused, Err(BookFileError::Newer)), "{refused:?}"),
            _ => assert!(matches!(refused, Err(BookFileError::Older)), "{refused:?}"),
        }
    }

    assert_eq!(ids(&out(&e.ws, "book.list", json!({}))), vec![original]);
    assert_eq!((docs(), assets()), (docs_before, assets_before));
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
