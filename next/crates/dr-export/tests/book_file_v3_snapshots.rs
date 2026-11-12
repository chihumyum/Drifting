//! V3 entry checkpoint archive contract, adapted from the integrator's
//! cross-module acceptance probe after G1's checkpoint implementation landed.
//! Corpus: canonical dr_testkit v3 Tiny only; all changed prose reuses seed text.
use std::{collections::BTreeMap, io::Read as _, path::Path};

use dr_doc::{prose::ProseReader, v3::BorrowedBookV3};
use dr_export::book_file::{export_book, import_book};
use dr_model::{DocId, id::EntryId};
use dr_store::{DocHead, DocInfo};
use dr_testkit::seed::{DEFAULT_SEED, Preset, generate_v3};
use dr_workspace::{Actor, Workspace, WsError};
use serde_json::{Value, json};

const PRIMARY: &str = "mod-prose";
const SECOND: &str = "archive-second-body";

#[derive(Debug, PartialEq)]
struct DocumentImage {
    info: DocInfo,
    head: Option<DocHead>,
    raw: Value,
    prose: Option<Vec<String>>,
}

type BookImage = BTreeMap<String, DocumentImage>;

// Enumerate every stored document, including retained/hidden documents. Read
// persisted copies, not an effective entry projection. Capture typed raw roots
// before a prose reader materializes its known, operation-free empty roots.
fn book_image(ws: &Workspace, book: &str) -> BookImage {
    ws.library()
        .docs(Some(book), None)
        .unwrap()
        .into_iter()
        .map(|info| {
            let doc = ws.library().load_copy(&info.doc_id).unwrap();
            let raw = dr_doc::v3::raw_document_state(&doc).unwrap();
            let id = DocId::parse(&info.doc_id).unwrap();
            let prose = if id.profile().is_some() {
                let reader = ProseReader::from_loro(id, &doc).unwrap();
                Some(reader.view().paragraphs().map(|p| p.text()).collect())
            } else {
                None
            };
            let image = DocumentImage {
                head: ws.library().head(&info.doc_id).unwrap(),
                raw,
                prose,
                info,
            };
            (image.info.doc_id.clone(), image)
        })
        .collect()
}

fn unchanged(ws: &Workspace, protected: &[(&str, &BookImage)], stage: &str) {
    for (book, expected) in protected {
        assert_eq!(
            &book_image(ws, book),
            *expected,
            "{stage}: protected book {book} changed in inventory/head/raw/prose"
        );
    }
}

// Check isolation even when a public operation returns an error. No repair,
// manifest rewriting, private test hook, retry, or fallback is hidden here.
fn checked<T, E: std::fmt::Debug>(
    ws: &Workspace,
    protected: &[(&str, &BookImage)],
    stage: &str,
    result: Result<T, E>,
) -> T {
    unchanged(ws, protected, stage);
    result.unwrap_or_else(|error| panic!("{stage}: {error:?}"))
}

fn output(ws: &Workspace, command: &str, input: Value) -> Result<Value, WsError> {
    ws.call(&Actor::User, command, input)
        .map(|outcome| outcome["output"].clone())
}

fn body_texts(ws: &Workspace, book: &str, entry: &str, module: &str) -> Vec<String> {
    output(
        ws,
        "module.read_prose",
        json!({"book":book,"owner":entry,"module":module}),
    )
    .unwrap()["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["text"].as_str().unwrap().to_owned())
        .collect()
}

fn set_body(ws: &Workspace, book: &str, entry: &str, module: &str, texts: &[String]) {
    let paragraphs: Vec<_> = texts.iter().map(|text| json!({"text":text})).collect();
    output(
        ws,
        "module.set_prose",
        json!({"book":book,"owner":entry,"module":module,"paragraphs":paragraphs}),
    )
    .unwrap();
}

fn body_text(raw_preview: &Value, module: &str) -> String {
    raw_preview["bodies"]
        .as_array()
        .unwrap()
        .iter()
        .find(|body| {
            matches!(
                DocId::parse(body["doc"].as_str().unwrap()),
                Ok(DocId::Body(id)) if id.module().as_str() == module
            )
        })
        .unwrap()["text"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn entry_raw(ws: &Workspace, book: &str, entry: &str) -> Value {
    let doc = ws.library().load_copy(&format!("book:{book}")).unwrap();
    let book_id = book.parse().unwrap();
    let entry_id = EntryId::parse(entry).unwrap();
    BorrowedBookV3::new(&doc, &book_id)
        .unwrap()
        .view()
        .entry_owned_raw_state(&entry_id)
        .unwrap()
}

fn assert_restored(ws: &Workspace, book: &str, entry: &str, preview: &Value) {
    assert_eq!(
        entry_raw(ws, book, entry),
        preview["raw_state"],
        "restored entry must equal the imported historical raw state"
    );
    for historical in preview["bodies"].as_array().unwrap() {
        let name = historical["doc"].as_str().unwrap();
        let id = DocId::parse(name).unwrap();
        let doc = ws.library().load_copy(name).unwrap();
        // Match G1's public preview/restore convention: the reader creates the
        // known empty embeds root without an operation. Unknown roots, rich
        // marks, retained containers and their identities remain exact.
        ProseReader::from_loro(id, &doc).unwrap();
        assert_eq!(
            dr_doc::v3::raw_document_state(&doc).unwrap(),
            historical["raw_state"],
            "restored body {name} differs from its historical raw state"
        );
    }
}

fn assert_format_three(path: &Path) {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut bytes = Vec::new();
    archive
        .by_name("manifest.json")
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    let manifest: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(manifest["format"], "drifting.book");
    assert_eq!(
        manifest["formatVersion"],
        dr_export::book_file::FORMAT_VERSION
    );
}

#[test]
fn snapshot_archive_roundtrip_restores_only_the_imported_entry_and_reopens_exactly() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let store = dr_store::Library::open(&root, dr_workspace::library_options("test")).unwrap();
    let seed = generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
    let source = seed.books[0].book_id().to_string();
    let entry = seed.books[0]
        .book
        .view()
        .entries()
        .into_iter()
        .find(|e| {
            e.template
                .as_ref()
                .is_some_and(|t| t.as_str() == "tpl-chapter")
        })
        .unwrap();
    let source_entry = entry.id.to_string();
    let before_title = entry.title;
    let template = entry.template.unwrap().to_string();
    seed.write_to(&store).unwrap();
    let seed = generate_v3(Preset::Tiny, DEFAULT_SEED + 1).unwrap();
    let third = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(&root, "test").unwrap();
    let third_before = book_image(&ws, &third);

    // Extend the canonical seeded entry via existing public commands. No new
    // prose corpus: the second body copies ordinary text from this seed.
    output(
        &ws,
        "entry_template.put_module",
        json!({"book":source,"template":template,
            "module":{"id":SECOND,"kind":"prose","name":SECOND}}),
    )
    .unwrap();
    let before_primary = body_texts(&ws, &source, &source_entry, PRIMARY);
    let seed_paragraph = before_primary
        .iter()
        .find(|text| !text.is_empty() && !text.contains('\n') && !text.contains('\u{fffc}'))
        .unwrap()
        .clone();
    set_body(
        &ws,
        &source,
        &source_entry,
        SECOND,
        std::slice::from_ref(&seed_paragraph),
    );
    let before_secondary = body_texts(&ws, &source, &source_entry, SECOND);
    let point = output(
        &ws,
        "entry_snapshot.create",
        json!({"book":source,"entry":source_entry}),
    )
    .unwrap();
    assert_eq!(point["bodies"].as_object().unwrap().len(), 2);
    let source_preview = output(
        &ws,
        "entry_snapshot.preview",
        json!({"book":source,"entry":source_entry,"point":point["id"]}),
    )
    .unwrap();
    let expected_primary = body_text(&source_preview, PRIMARY);
    let expected_secondary = body_text(&source_preview, SECOND);

    let after_title = format!("{before_title} {before_title}");
    output(
        &ws,
        "entry.update",
        json!({"book":source,"id":source_entry,"title":after_title}),
    )
    .unwrap();
    let mut after_primary = before_primary.clone();
    after_primary.push(seed_paragraph.clone());
    let mut after_secondary = before_secondary.clone();
    after_secondary.push(seed_paragraph);
    set_body(&ws, &source, &source_entry, PRIMARY, &after_primary);
    set_body(&ws, &source, &source_entry, SECOND, &after_secondary);
    assert_eq!(
        body_texts(&ws, &source, &source_entry, PRIMARY),
        after_primary
    );
    assert_eq!(
        body_texts(&ws, &source, &source_entry, SECOND),
        after_secondary
    );
    assert_ne!(after_primary, before_primary);
    assert_ne!(after_secondary, before_secondary);
    assert_eq!(book_image(&ws, &third), third_before);

    // The source's intended edits are now the protected baseline. Every later
    // export/import/preview/restore and reopen must leave it and book 3 exact.
    let source_before = book_image(&ws, &source);
    let protected = [
        (source.as_str(), &source_before),
        (third.as_str(), &third_before),
    ];
    let path = dir.path().join("snapshot-roundtrip.driftingbook");
    let exported = checked(
        &ws,
        &protected,
        "format-3 export",
        export_book(&ws, &source, &path, &|_| {}),
    );
    assert_format_three(&path);
    let imported = checked(
        &ws,
        &protected,
        "import as a new book",
        import_book(&ws, &path, &|_| {}),
    );
    assert_ne!(imported.book, source);
    assert_ne!(imported.book, third);
    assert_eq!(imported.documents, exported.documents);
    let imported_book = imported.book;
    let doc = ws
        .library()
        .load_copy(&format!("book:{imported_book}"))
        .unwrap();
    let bid = imported_book.parse().unwrap();
    let matching: Vec<_> = BorrowedBookV3::new(&doc, &bid)
        .unwrap()
        .view()
        .entries_raw()
        .into_iter()
        .filter(|e| e.title == after_title)
        .collect();
    assert_eq!(
        matching.len(),
        1,
        "find the imported entry by its authored current title"
    );
    let imported_entry = matching[0].id.to_string();
    assert_ne!(imported_entry, source_entry);
    assert_eq!(
        body_texts(&ws, &imported_book, &imported_entry, PRIMARY),
        after_primary
    );
    assert_eq!(
        body_texts(&ws, &imported_book, &imported_entry, SECOND),
        after_secondary
    );

    let points = checked(
        &ws,
        &protected,
        "list imported entry history",
        output(
            &ws,
            "entry_snapshot.list",
            json!({"book":imported_book,"entry":imported_entry}),
        ),
    );
    assert_eq!(
        points.as_array().unwrap().len(),
        1,
        "the saved entry checkpoint must survive import"
    );
    let imported_point = points[0]["id"].as_str().unwrap().to_owned();
    assert_ne!(imported_point, point["id"].as_str().unwrap());
    assert_eq!(points[0]["book"], imported_book);
    assert_eq!(points[0]["entry"], imported_entry);
    let before_preview = book_image(&ws, &imported_book);
    let preview = checked(
        &ws,
        &protected,
        "preview imported checkpoint",
        output(
            &ws,
            "entry_snapshot.preview",
            json!({"book":imported_book,
            "entry":imported_entry,"point":imported_point}),
        ),
    );
    assert_eq!(
        book_image(&ws, &imported_book),
        before_preview,
        "preview cannot write"
    );
    assert_eq!(preview["metadata"]["title"], before_title);
    assert_eq!(preview["bodies"].as_array().unwrap().len(), 2);
    assert_eq!(body_text(&preview, PRIMARY), expected_primary);
    assert_eq!(body_text(&preview, SECOND), expected_secondary);
    let expected_docs: std::collections::BTreeSet<_> = [
        format!("book:{imported_book}"),
        format!("body:{imported_entry}/{PRIMARY}"),
        format!("body:{imported_entry}/{SECOND}"),
    ]
    .into_iter()
    .collect();
    assert_eq!(
        preview["expected"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>(),
        expected_docs,
        "restore guards must refer only to the imported book and its two bodies"
    );
    let restored = checked(
        &ws,
        &protected,
        "restore imported checkpoint",
        output(
            &ws,
            "entry_snapshot.restore",
            json!({"book":imported_book,
            "entry":imported_entry,"point":imported_point,"expected":preview["expected"]}),
        ),
    );
    assert!(
        restored["before"].as_str().is_some(),
        "pre-restore recovery point is durable"
    );
    assert_restored(&ws, &imported_book, &imported_entry, &preview);
    assert_eq!(
        body_texts(&ws, &imported_book, &imported_entry, PRIMARY),
        before_primary
    );
    assert_eq!(
        body_texts(&ws, &imported_book, &imported_entry, SECOND),
        before_secondary
    );
    let restored_image = book_image(&ws, &imported_book);
    unchanged(&ws, &protected, "before reopen");
    drop(doc);
    ws.shutdown().unwrap();

    let ws = Workspace::open_dir(&root, "test").unwrap();
    unchanged(&ws, &protected, "after reopen");
    assert_eq!(
        book_image(&ws, &imported_book),
        restored_image,
        "restored imported book persists exactly"
    );
    assert_restored(&ws, &imported_book, &imported_entry, &preview);
    let reopened_preview = checked(
        &ws,
        &protected,
        "preview after reopen",
        output(
            &ws,
            "entry_snapshot.preview",
            json!({"book":imported_book,
            "entry":imported_entry,"point":imported_point}),
        ),
    );
    for key in [
        "point",
        "metadata",
        "raw_state",
        "records",
        "template",
        "template_metadata",
        "bodies",
    ] {
        assert_eq!(
            reopened_preview[key], preview[key],
            "historical {key} changed after reopen"
        );
    }
    assert_eq!(
        book_image(&ws, &imported_book),
        restored_image,
        "reopened preview cannot write"
    );
    ws.shutdown().unwrap();
}

fn checkpoint_fixture() -> (tempfile::TempDir, Workspace, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let store = dr_store::Library::open(&root, dr_workspace::library_options("test")).unwrap();
    let seed = generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
    let book = seed.books[0].book_id().to_string();
    let entry = seed.books[0]
        .book
        .view()
        .entries()
        .into_iter()
        .find(|e| {
            e.template
                .as_ref()
                .is_some_and(|t| t.as_str() == "tpl-chapter")
        })
        .unwrap()
        .id
        .to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(root, "test").unwrap();
    (dir, ws, book, entry)
}

fn write_manifest_fixture(ws: &Workspace, book: &str, id: &str, value: Value) {
    let id = id.to_owned();
    let encoded = serde_json::to_string(&value).unwrap();
    let h = ws
        .library()
        .open_doc(&format!("checkpoints:{book}"), dr_store::OpenDoc::Existing)
        .unwrap();
    h.write(dr_store::Origin::User, move |d| {
        d.get_map("entry_checkpoints").insert(&id, encoded).unwrap();
    })
    .unwrap();
    h.close();
}

#[test]
fn genesis_versions_literals_and_checkpoint_extensions_survive_repeated_archives() {
    use dr_workspace::{commands::v3::snapshots as api, naming};
    let (dir, ws, book, entry) = checkpoint_fixture();
    output(
        &ws,
        "entry_template.put_module",
        json!({"book":book,"template":"tpl-chapter",
        "module":{"id":SECOND,"kind":"prose","name":SECOND}}),
    )
    .unwrap();
    // An authored title equal to an identity must remain literal.
    output(
        &ws,
        "entry.update",
        json!({"book":book,"id":entry,"title":entry}),
    )
    .unwrap();
    let a = output(
        &ws,
        "entry_snapshot.create",
        json!({"book":book,"entry":entry}),
    )
    .unwrap();
    let typed: api::Point = serde_json::from_value(a.clone()).unwrap();
    assert_eq!(
        api::checkpoint_manifest_checksum(&typed).unwrap(),
        typed.checksum
    );
    assert!(
        api::checkpoint_history_fingerprint(
            &BTreeMap::new(),
            &api::EntryIn {
                book: book.clone(),
                entry: entry.clone(),
            }
        )
        .is_err()
    );
    let empty_doc = format!("body:{entry}/{SECOND}");
    let genesis = dr_doc::peer::genesis_peer(&empty_doc, dr_doc::schema::GENESIS_VERSION);
    let version = naming::frontiers_from_hex(a["bodies"][&empty_doc].as_str().unwrap()).unwrap();
    assert!(version.iter().all(|id| id.peer == genesis));
    assert!(!version.is_empty());
    let text = body_texts(&ws, &book, &entry, PRIMARY)
        .into_iter()
        .find(|s| !s.is_empty() && !s.contains('\n') && !s.contains('\u{fffc}'))
        .unwrap();
    set_body(&ws, &book, &entry, SECOND, std::slice::from_ref(&text));
    let b = output(
        &ws,
        "entry_snapshot.create",
        json!({"book":book,"entry":entry}),
    )
    .unwrap();
    // Simulate a future non-semantic extension, without changing the known
    // manifest's checksum. The original insert also remains in the op log.
    let extension = json!({"literal":entry,"values":[null,17,true]});
    let mut extended = a.clone();
    extended["future_archive_extension"] = extension.clone();
    write_manifest_fixture(&ws, &book, a["id"].as_str().unwrap(), extended);
    let protected = book_image(&ws, &book);
    let mut previous = book.clone();
    let mut old_point_ids = std::collections::BTreeSet::from([
        a["id"].as_str().unwrap().to_owned(),
        b["id"].as_str().unwrap().to_owned(),
    ]);
    for round in 0..2 {
        let file = dir.path().join(format!("checkpoint-{round}.driftingbook"));
        export_book(&ws, &previous, &file, &|_| {}).unwrap();
        let copy = import_book(&ws, &file, &|_| {}).unwrap().book;
        let entries = output(&ws, "entry.list", json!({"book":copy,"all":true})).unwrap();
        let copied = entries
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["title"] == entry)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(copied, entry);
        let points = output(
            &ws,
            "entry_snapshot.list",
            json!({"book":copy,"entry":copied}),
        )
        .unwrap();
        assert_eq!(points.as_array().unwrap().len(), 2);
        let doc = ws
            .library()
            .load_copy(&format!("checkpoints:{copy}"))
            .unwrap();
        let copy_id = copy.parse().unwrap();
        let manifests = dr_doc::side::BorrowedCheckpoints::new(&doc, &copy_id)
            .unwrap()
            .view()
            .entry_checkpoints();
        let mut mapped_ids = std::collections::BTreeSet::new();
        for point in points.as_array().unwrap() {
            let id = point["id"].as_str().unwrap();
            assert!(!old_point_ids.contains(id));
            mapped_ids.insert(id.to_owned());
            assert_eq!(point["title"], entry);
            let p = output(
                &ws,
                "entry_snapshot.preview",
                json!({"book":copy,"entry":copied,"point":id}),
            )
            .unwrap();
            let raw: Value =
                serde_json::from_str(&manifests.iter().find(|(k, _)| k == id).unwrap().1).unwrap();
            if let Some(saved) = raw.get("future_archive_extension") {
                assert_eq!(saved, &extension);
                let body = format!("body:{copied}/{SECOND}");
                let new_genesis =
                    dr_doc::peer::genesis_peer(&body, dr_doc::schema::GENESIS_VERSION);
                let mapped =
                    naming::frontiers_from_hex(point["bodies"][&body].as_str().unwrap()).unwrap();
                assert!(mapped.iter().all(|id| id.peer == new_genesis));
                assert!(body_text(&p, SECOND).trim().is_empty());
            } else {
                assert!(body_text(&p, SECOND).contains(&text));
            }
        }
        assert!(
            manifests
                .iter()
                .any(|(_, s)| s.contains("future_archive_extension"))
        );
        // A current-content close capture must reuse the latest imported
        // checkpoint: a stale source fingerprint would create a third point.
        let reused = output(
            &ws,
            "entry_snapshot.capture",
            json!({"book":copy,"entry":copied,"reason":"close"}),
        )
        .unwrap();
        assert!(mapped_ids.contains(reused["id"].as_str().unwrap()));
        assert_eq!(book_image(&ws, &book), protected);
        old_point_ids = mapped_ids;
        previous = copy;
    }
    ws.shutdown().unwrap();
}

#[test]
fn damaged_checkpoint_metadata_is_refused_before_any_import_writes() {
    use dr_workspace::{commands::v3::snapshots as api, naming};
    for case in [
        "checksum",
        "owner",
        "body",
        "unicode-version",
        "missing-version",
        "fingerprint",
    ] {
        let (dir, ws, book, entry) = checkpoint_fixture();
        let value = output(
            &ws,
            "entry_snapshot.create",
            json!({"book":book,"entry":entry}),
        )
        .unwrap();
        let mut point: api::Point = serde_json::from_value(value).unwrap();
        match case {
            "checksum" => point.checksum.clear(),
            "owner" => point.book = dr_model::id::BookId::new_v7().to_string(),
            "body" => {
                let version = point.bodies.values().next().unwrap().clone();
                point
                    .bodies
                    .insert(format!("body:{}/{}", EntryId::new_v7(), PRIMARY), version);
            }
            "unicode-version" => point.book_version = "é".into(),
            "missing-version" => {
                point.book_version = naming::frontiers_hex(&loro::Frontiers::from(loro::ID {
                    peer: u64::MAX,
                    counter: 0,
                }))
            }
            "fingerprint" => point.content_hash.clear(),
            _ => unreachable!(),
        }
        if case != "checksum" {
            point.checksum = api::checkpoint_manifest_checksum(&point).unwrap();
        }
        write_manifest_fixture(&ws, &book, &point.id, serde_json::to_value(&point).unwrap());
        let before = book_image(&ws, &book);
        let docs = ws.library().docs(None, None).unwrap();
        let file = dir.path().join("damaged-checkpoint.driftingbook");
        export_book(&ws, &book, &file, &|_| {}).unwrap();
        let progress = std::cell::Cell::new(0);
        let error = import_book(&ws, &file, &|p| progress.set(p.done)).unwrap_err();
        assert!(
            matches!(error, dr_export::book_file::BookFileError::Damaged(_)),
            "{case}: {error:?}"
        );
        assert_eq!(
            progress.get(),
            0,
            "{case}: preflight must finish before writes"
        );
        assert_eq!(ws.library().docs(None, None).unwrap(), docs, "{case}");
        assert_eq!(book_image(&ws, &book), before, "{case}");
        ws.shutdown().unwrap();
    }
}
