//! End-to-end v3 sync round-trip over the loopback `FakeSyncServer`:
//! two v3 books, multi-body entries, templates, materials, source/thumbnail
//! assets, hidden/trashed entries and timeline bindings, unknown future fields,
//! entry checkpoints (`entry_snapshot.list` / `preview`), bidirectional edits,
//! reopen persistence, and permanent book purge isolation (`book.trash` ->
//! `book.purge`) without touching the second book or files outside the library.

use std::{collections::BTreeMap, fs, path::Path, sync::atomic::Ordering};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use dr_doc::{
    prose::{ProseDoc, ProseReader},
    v3::{
        BorrowedBookV3,
        novel::{MOD_PROSE, TPL_CHAPTER},
        raw_document_state,
    },
};
use dr_model::{
    id::{BookId, DocId},
    origin::Origin,
};
use dr_store::{
    Device, DocHead, DocInfo, Library, LibraryOptions, OpenDoc,
    asset::{AssetRecord, MAX_COPY_BYTES, SourceImport, Variant, VariantBytes},
    index::DOC_KIND_TEMPLATE,
};
use dr_sync::{FakeSyncServer, RemoteObjectPayload, SyncEngine, SyncError, SyncHttpClient};
use dr_testkit::{
    media,
    seed::{self, DEFAULT_SEED, Preset},
};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, WritePreconditions};
use loro::{ExportMode, LoroDoc, ToJson};
use serde_json::{Value, json};

const TOKEN: &str = "synthetic-v3-token";

fn call_out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name} failed: {e}"))["output"]
        .clone()
}

// Actual author edits use individual public commands and observations. The
// whole-view put below is only initial fixture construction before hiding data.
fn guarded(ws: &Workspace, name: &str, input: Value, docs: &[String]) -> Value {
    let observations = docs
        .iter()
        .map(|d| ws.observe(d).unwrap())
        .collect::<Vec<_>>();
    ws.call_guarded(
        &Actor::User,
        name,
        input,
        WritePreconditions::from_observations(observations),
    )
    .unwrap_or_else(|e| panic!("guarded {name}: {e}"))["output"]
        .clone()
}

fn options(device: &Device) -> LibraryOptions {
    let mut opts = seed::library_options("0.2.0-test");
    opts.device = Some(device.clone());
    opts
}

fn open_workspace(path: &Path, device: &Device) -> Workspace {
    Workspace::open(
        Library::open(path, options(device)).unwrap(),
        WorkspaceOptions::default(),
    )
    .unwrap()
}

fn material(ws: &Workspace, book: &str, id: &str) -> Value {
    call_out(ws, "material.list", json!({"book":book}))
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == id)
        .unwrap_or_else(|| panic!("material {id} missing from {book}"))
        .clone()
}

fn text(ws: &Workspace, doc: &str) -> String {
    call_out(ws, "prose.read", json!({"doc":doc}))["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["text"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug, PartialEq)]
struct DocumentImage {
    info: DocInfo,
    head: Option<DocHead>,
    raw: Value,
    prose: Option<Vec<String>>,
}

#[derive(Debug, PartialEq)]
struct AssetImage {
    metadata: AssetRecord,
    bytes: Vec<u8>,
}

#[derive(Debug, PartialEq)]
struct BookImage {
    docs: BTreeMap<String, DocumentImage>,
    assets: BTreeMap<String, AssetImage>,
}

// All registered documents, even those absent from effective queries. Compare
// typed roots before any reader materializes its operation-free empty roots.
fn book_image(lib: &Library, book: &str) -> BookImage {
    let docs = lib
        .docs(Some(book), None)
        .unwrap()
        .into_iter()
        .map(|info| {
            let doc = lib.load_copy(&info.doc_id).unwrap();
            let raw = raw_document_state(&doc).unwrap();
            let id = DocId::parse(&info.doc_id).unwrap();
            let prose = id.profile().map(|_| {
                ProseReader::from_loro(id.clone(), &doc)
                    .unwrap()
                    .view()
                    .paragraphs()
                    .map(|p| p.text())
                    .collect()
            });
            (
                info.doc_id.clone(),
                DocumentImage {
                    head: lib.head(&info.doc_id).unwrap(),
                    info,
                    raw,
                    prose,
                },
            )
        })
        .collect();
    let assets = lib
        .assets_of_book(book)
        .unwrap()
        .into_iter()
        .map(|metadata| {
            let bytes = fs::read(&metadata.path).unwrap();
            (
                format!("{}/{}", metadata.asset_id, metadata.variant.as_str()),
                AssetImage { metadata, bytes },
            )
        })
        .collect();
    BookImage { docs, assets }
}

fn unchanged(lib: &Library, book: &str, expected: &BookImage, stage: &str) {
    let actual = book_image(lib, book);
    assert_eq!(
        actual.docs.keys().collect::<Vec<_>>(),
        expected.docs.keys().collect::<Vec<_>>(),
        "{stage}: {book} inventory"
    );
    for (id, expected) in &expected.docs {
        assert_eq!(
            &actual.docs[id], expected,
            "{stage}: {id} metadata/head/typed raw/prose"
        );
    }
    assert_eq!(
        actual.assets.keys().collect::<Vec<_>>(),
        expected.assets.keys().collect::<Vec<_>>(),
        "{stage}: {book} asset inventory"
    );
    for (id, expected) in &expected.assets {
        assert_eq!(
            &actual.assets[id], expected,
            "{stage}: {id} all local asset metadata/bytes"
        );
    }
}

fn converged(a: &Library, b: &Library, book: &str) {
    let a = book_image(a, book);
    let b = book_image(b, book);
    assert_eq!(
        a.docs.keys().collect::<Vec<_>>(),
        b.docs.keys().collect::<Vec<_>>()
    );
    for (id, a) in &a.docs {
        let b = &b.docs[id];
        assert_eq!(a.info, b.info, "{id}: identity/ownership");
        assert_eq!(a.raw, b.raw, "{id}: typed raw");
        assert_eq!(a.prose, b.prose, "{id}: actual prose");
        let (a, b) = (a.head.as_ref().unwrap(), b.head.as_ref().unwrap());
        assert_eq!(a.vv, b.vv, "{id}: version vector");
        assert_eq!(a.frontiers, b.frontiers, "{id}: frontier");
    }
    assert_eq!(
        a.assets.keys().collect::<Vec<_>>(),
        b.assets.keys().collect::<Vec<_>>()
    );
    for (id, a) in &a.assets {
        let b = &b.assets[id];
        let (am, bm) = (&a.metadata, &b.metadata);
        // Paths and local creation/upload times differ between devices.
        assert_eq!(
            (
                &am.asset_id,
                am.variant,
                &am.book_id,
                &am.mime,
                &am.ext,
                am.size,
                &am.sha256,
                am.width,
                am.height
            ),
            (
                &bm.asset_id,
                bm.variant,
                &bm.book_id,
                &bm.mime,
                &bm.ext,
                bm.size,
                &bm.sha256,
                bm.width,
                bm.height
            ),
            "{id}: all transport metadata"
        );
        assert!(am.uploaded_ms.is_some() && bm.uploaded_ms.is_some());
        assert_eq!(a.bytes, b.bytes, "{id}: bytes");
    }
}

fn preview(ws: &Workspace, book: &str, entry: &str, point: &str) -> Value {
    let list = call_out(
        ws,
        "entry_snapshot.list",
        json!({"book":book,"entry":entry}),
    );
    assert!(list.as_array().unwrap().iter().any(|p| p["id"] == point));
    let mut p = call_out(
        ws,
        "entry_snapshot.preview",
        json!({"book":book,"entry":entry,"point":point}),
    );
    // Current restore guards intentionally change after author edits; historical
    // identity, versions, checksum, typed raw and all historical bodies must not.
    p.as_object_mut().unwrap().remove("expected");
    p
}

fn purged(lib: &Library, book: &str, expected: &[DocInfo]) {
    assert!(lib.book_purged(book).unwrap());
    assert!(lib.docs(Some(book), None).unwrap().is_empty());
    assert_eq!(lib.purged_docs(Some(book)).unwrap().len(), expected.len());
    for info in expected {
        assert!(
            lib.doc_info(&info.doc_id).unwrap().is_none(),
            "{} still registered",
            info.doc_id
        );
        assert!(
            lib.head(&info.doc_id).unwrap().is_none(),
            "{} still has head",
            info.doc_id
        );
        assert!(lib.load_copy(&info.doc_id).is_err());
        let tombstone = lib.purged(&info.doc_id).unwrap().unwrap();
        assert_eq!(
            (&tombstone.doc_id, &tombstone.kind, &tombstone.book_id),
            (&info.doc_id, &info.kind, &info.book_id)
        );
    }
}

fn sentinel(path: &Path, expected: &[u8]) {
    assert_eq!(
        fs::read(path).unwrap(),
        expected,
        "outside-library sentinel changed"
    );
}

fn canonical_library(path: &Path) -> (Library, String, String) {
    let seed = seed::generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
    let book = seed.books[0].book_id().to_string();
    let lib = Library::open(path, seed::library_options("0.2.0-test")).unwrap();
    seed.write_to(&lib).unwrap();
    let body = lib
        .docs(Some(&book), None)
        .unwrap()
        .into_iter()
        .find(|d| matches!(DocId::parse(&d.doc_id), Ok(DocId::Body(_))))
        .unwrap()
        .doc_id;
    (lib, book, body)
}

#[derive(Clone, Copy, Debug)]
enum RemoteDocumentChange {
    Purge,
    CoveredUpdate,
    NewUpdate,
}

// The guardian's cross-book purge probe, extended to both LoroUpdate paths and
// existing tombstones. Every case uses two actual canonical v3 books. Only the
// untrusted metadata differs from the document's stored identity.
fn reject_conflicting_document_identity(change: RemoteDocumentChange, already_purged: bool) {
    for conflict in ["other-book", "missing-book", "kind"] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("library");
        let (lib, book_a, _) = canonical_library(&path);
        let second = seed::generate_v3(Preset::Tiny, DEFAULT_SEED + 1).unwrap();
        let book_b = second.books[0].book_id().to_string();
        assert_ne!(book_a, book_b);
        second.write_to(&lib).unwrap();
        let info = lib
            .docs(Some(&book_b), None)
            .unwrap()
            .into_iter()
            .find(|d| matches!(DocId::parse(&d.doc_id), Ok(DocId::Body(_))))
            .unwrap();
        let sentinel_path = root.path().join("outside-sentinel.txt");
        fs::write(&sentinel_path, b"synthetic sentinel").unwrap();
        let sentinel_modified = fs::metadata(&sentinel_path).unwrap().modified().unwrap();

        let remote = lib.load_copy(&info.doc_id).unwrap();
        if matches!(change, RemoteDocumentChange::NewUpdate) {
            remote.set_peer_id(u64::MAX - 2).unwrap();
            remote
                .get_map("future_remote_root")
                .insert("untrusted_update", true)
                .unwrap();
            remote.commit();
        }
        let remote_vv = remote.oplog_vv();
        let head = lib.head(&info.doc_id).unwrap().unwrap();
        let covered = remote_vv
            .iter()
            .all(|(peer, end)| head.vv.get(peer).copied().unwrap_or(0) >= *end);
        assert_eq!(covered, !matches!(change, RemoteDocumentChange::NewUpdate));
        let bytes = remote.export(ExportMode::all_updates()).unwrap();
        let (kind, book_id) = match conflict {
            "other-book" => (info.kind.clone(), Some(book_a.clone())),
            "missing-book" => (info.kind.clone(), None),
            "kind" => ("future-opaque-kind".into(), info.book_id.clone()),
            _ => unreachable!(),
        };
        let payload = match change {
            RemoteDocumentChange::Purge => RemoteObjectPayload::DocPurge {
                doc_id: info.doc_id.clone(),
                kind,
                book_id,
                purged_ms: 1,
            },
            RemoteDocumentChange::CoveredUpdate | RemoteDocumentChange::NewUpdate => {
                RemoteObjectPayload::LoroUpdate {
                    doc_id: info.doc_id.clone(),
                    kind,
                    book_id,
                    vv_base64: URL_SAFE_NO_PAD.encode(remote_vv.encode()),
                    is_snapshot: false,
                }
            }
        };
        let server = FakeSyncServer::start(TOKEN);
        let mut engine = SyncEngine::new(server.base_url(), &lib).unwrap();
        engine.sync_once(&lib, TOKEN).unwrap();
        if already_purged {
            lib.purge_doc(&info.doc_id).unwrap();
            engine.sync_once(&lib, TOKEN).unwrap();
        }
        // With no uploads pending, only the changes request may succeed. An
        // import-path download before identity validation would return Offline.
        assert!(lib.docs_with_local_changes().unwrap().is_empty());
        let cursor = engine.cursor();
        let images = [book_image(&lib, &book_a), book_image(&lib, &book_b)];
        let tombstones = lib.purged_docs(None).unwrap();
        let confirmed_vv = lib.remote_vv(&info.doc_id).unwrap();
        let state_path = path.join("sync-cursor-v2.json");
        let state = fs::read(&state_path).unwrap();
        let record = SyncHttpClient::new(server.base_url())
            .unwrap()
            .put_object(
                TOKEN,
                "synthetic-conflicting-identity",
                &payload,
                &bytes,
                None,
            )
            .unwrap();
        assert_eq!(record.seq, cursor + 1);

        // First attempt and a real disk reopen must reject the same record,
        // preserve both books, and retain its retry position/acknowledgements.
        let check_rejection = |lib: &Library, engine: &mut SyncEngine, stage: &str| {
            server.set_fail_after_requests(Some(1));
            let result = engine.sync_once(lib, TOKEN);
            for (book, image) in [(&book_a, &images[0]), (&book_b, &images[1])] {
                unchanged(lib, book, image, stage);
            }
            let error = result.unwrap_err();
            assert!(
                matches!(error, SyncError::IntegrityMismatch { .. }),
                "{change:?}/{conflict}/purged={already_purged}/{stage}: {error:?}"
            );
            assert_eq!(lib.purged_docs(None).unwrap(), tombstones);
            assert_eq!(lib.remote_vv(&info.doc_id).unwrap(), confirmed_vv);
            assert_eq!(engine.cursor(), cursor);
            assert_eq!(fs::read(&state_path).unwrap(), state);
            sentinel(&sentinel_path, b"synthetic sentinel");
            assert_eq!(
                fs::metadata(&sentinel_path).unwrap().modified().unwrap(),
                sentinel_modified
            );
        };
        check_rejection(&lib, &mut engine, "refused contradictory document identity");
        drop(engine);
        lib.close().unwrap();
        let lib = Library::open(&path, seed::library_options("0.2.0-test")).unwrap();
        let mut engine = SyncEngine::new(server.base_url(), &lib).unwrap();
        assert_eq!(engine.cursor(), cursor);
        check_rejection(
            &lib,
            &mut engine,
            "reopen/retry contradictory document identity",
        );
        lib.close().unwrap();
    }
}

#[test]
fn contradictory_doc_purge_cannot_delete_another_real_v3_books_body() {
    reject_conflicting_document_identity(RemoteDocumentChange::Purge, false);
}

#[test]
fn contradictory_loro_metadata_is_rejected_before_covered_or_new_updates() {
    for change in [
        RemoteDocumentChange::CoveredUpdate,
        RemoteDocumentChange::NewUpdate,
    ] {
        reject_conflicting_document_identity(change, false);
    }
}

#[test]
fn contradictory_metadata_cannot_acknowledge_existing_v3_tombstones() {
    for change in [
        RemoteDocumentChange::Purge,
        RemoteDocumentChange::CoveredUpdate,
        RemoteDocumentChange::NewUpdate,
    ] {
        reject_conflicting_document_identity(change, true);
    }
}

#[test]
fn a_held_v3_document_blocks_remote_purge_without_consuming_its_cursor() {
    let root = tempfile::tempdir().unwrap();
    let (lib, book, body) = canonical_library(&root.path().join("library"));
    let sentinel_path = root.path().join("outside-sentinel.txt");
    fs::write(&sentinel_path, b"synthetic sentinel").unwrap();
    let original = book_image(&lib, &book);
    assert!(!lib.docs_with_local_changes().unwrap().is_empty());
    let held = lib.open_doc(&body, OpenDoc::Existing).unwrap();
    let info = lib.doc_info(&body).unwrap().unwrap();
    let server = FakeSyncServer::start(TOKEN);
    let payload = RemoteObjectPayload::DocPurge {
        doc_id: body.clone(),
        kind: info.kind.clone(),
        book_id: Some(book.clone()),
        purged_ms: 1,
    };
    SyncHttpClient::new(server.base_url())
        .unwrap()
        .put_object(
            TOKEN,
            "synthetic-held-purge",
            &payload,
            &serde_json::to_vec(&payload).unwrap(),
            None,
        )
        .unwrap();
    let mut engine = SyncEngine::new(server.base_url(), &lib).unwrap();
    let result = engine.sync_once(&lib, TOKEN);
    assert!(
        matches!(result,Err(SyncError::Store(dr_store::StoreError::AlreadyOpen(ref id))) if id == &body),
        "{result:?}"
    );
    assert_eq!(engine.cursor(), 0, "failed deletion must be retried");
    assert!(lib.purged(&body).unwrap().is_none());
    unchanged(&lib, &book, &original, "refused remote purge");
    sentinel(&sentinel_path, b"synthetic sentinel");
    held.close();
    drop(engine);
    let mut engine = SyncEngine::new(server.base_url(), &lib).unwrap();
    let report = engine.sync_once(&lib, TOKEN).unwrap();
    assert_eq!(report.applied_purges, 1);
    assert!(lib.doc_info(&body).unwrap().is_none());
    assert!(lib.head(&body).unwrap().is_none());
    let tombstone = lib.purged(&body).unwrap().unwrap();
    assert_eq!(
        (tombstone.kind, tombstone.book_id),
        (info.kind, info.book_id)
    );
    let after = book_image(&lib, &book);
    for (id, image) in &original.docs {
        if id != &body {
            assert_eq!(&after.docs[id], image, "unrelated document changed");
        }
    }
    assert_eq!(
        engine.restore_library(&lib, TOKEN).unwrap().downloaded_docs,
        0
    );
    assert!(lib.doc_info(&body).unwrap().is_none());
    sentinel(&sentinel_path, b"synthetic sentinel");
    lib.close().unwrap();
}

#[test]
fn damaged_remote_loro_preserves_real_v3_author_data_and_reopen_state() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("library");
    let (lib, book, body) = canonical_library(&path);
    let sentinel_path = root.path().join("outside-sentinel.txt");
    fs::write(&sentinel_path, b"synthetic sentinel").unwrap();
    let before = book_image(&lib, &book);
    assert!(!lib.docs_with_local_changes().unwrap().is_empty());
    let advertised = LoroDoc::new();
    advertised.set_peer_id(u64::MAX - 1).unwrap();
    advertised
        .get_map("synthetic")
        .insert("future", true)
        .unwrap();
    advertised.commit();
    let info = lib.doc_info(&body).unwrap().unwrap();
    let server = FakeSyncServer::start(TOKEN);
    SyncHttpClient::new(server.base_url())
        .unwrap()
        .put_object(
            TOKEN,
            "synthetic-damaged-loro",
            &RemoteObjectPayload::LoroUpdate {
                doc_id: body.clone(),
                kind: info.kind,
                book_id: info.book_id,
                vv_base64: URL_SAFE_NO_PAD.encode(advertised.oplog_vv().encode()),
                is_snapshot: false,
            },
            b"synthetic invalid Loro bytes",
            None,
        )
        .unwrap();
    let mut engine = SyncEngine::new(server.base_url(), &lib).unwrap();
    let error = engine.sync_once(&lib, TOKEN).unwrap_err();
    assert!(matches!(error, SyncError::Store(_)), "{error:?}");
    assert_eq!(engine.cursor(), 0, "damaged input must not be acknowledged");
    assert!(
        lib.remote_vv(&body).unwrap().get(&(u64::MAX - 1)).is_none(),
        "damaged advertised version must not be confirmed"
    );
    unchanged(&lib, &book, &before, "damaged remote Loro");
    sentinel(&sentinel_path, b"synthetic sentinel");
    drop(engine);
    lib.close().unwrap();
    let lib = Library::open(&path, seed::library_options("0.2.0-test")).unwrap();
    unchanged(&lib, &book, &before, "reopen after damaged remote Loro");
    assert_eq!(
        SyncEngine::new(server.base_url(), &lib).unwrap().cursor(),
        0
    );
    sentinel(&sentinel_path, b"synthetic sentinel");
    lib.close().unwrap();
}

#[test]
fn v3_books_assets_hidden_fields_checkpoints_and_book_purge_round_trip_over_fake_server() {
    let server = FakeSyncServer::start(TOKEN);
    let root = tempfile::tempdir().expect("temp root");
    let dir_a = root.path().join("replica-a");
    let dir_b = root.path().join("replica-b");
    let staging = root.path().join("staging");
    fs::create_dir_all(&dir_a).unwrap();
    fs::create_dir_all(&dir_b).unwrap();
    fs::create_dir_all(&staging).unwrap();

    let outside_sentinel = root.path().join("outside-sentinel-manuscript.txt");
    let sentinel_bytes = b"outside library boundary sentinel bytes".to_vec();
    fs::write(&outside_sentinel, &sentinel_bytes).unwrap();
    let sentinel_modified = fs::metadata(&outside_sentinel).unwrap().modified().unwrap();

    let device_a = Device::open_with_machine_id(
        root.path().join("device-a"),
        Some("synthetic-machine-a".into()),
    )
    .unwrap();
    let device_b = Device::open_with_machine_id(
        root.path().join("device-b"),
        Some("synthetic-machine-b".into()),
    )
    .unwrap();
    assert_ne!(device_a.installation_id(), device_b.installation_id());
    sentinel(&outside_sentinel, &sentinel_bytes);

    // Seed two distinct canonical v3 Tiny books into replica A.
    let seed_a = seed::generate_v3(Preset::Tiny, DEFAULT_SEED).expect("seed v3 book A");
    let seed_b = seed::generate_v3(Preset::Tiny, DEFAULT_SEED + 1).expect("seed v3 book B");
    let book_a = seed_a.books[0].book_id().as_str().to_owned();
    let book_b = seed_b.books[0].book_id().as_str().to_owned();
    assert_ne!(book_a, book_b, "two v3 books must have distinct BookIds");

    // Every prose fixture comes from the canonical seed, including later edits.
    let corpus: Vec<String> = seed_a.books[0]
        .prose
        .iter()
        .flat_map(|p| p.view().paragraphs().map(|p| p.text()).collect::<Vec<_>>())
        .filter(|s| !s.is_empty())
        .take(8)
        .collect();
    assert_eq!(corpus.len(), 8);
    assert_ne!(corpus[0], corpus[1]);
    let ws_a = {
        let lib_a = Library::open(&dir_a, options(&device_a)).expect("open lib_a for seed");
        assert!(seed_a.write_to(&lib_a).expect("write seed_a") > 0);
        assert!(seed_b.write_to(&lib_a).expect("write seed_b") > 0);
        lib_a.close().expect("close seeded lib_a");
        let lib_a = Library::open(&dir_a, options(&device_a)).expect("reopen lib_a");
        Workspace::open(lib_a, WorkspaceOptions::default()).expect("open ws_a")
    };

    assert_eq!(
        call_out(&ws_a, "book.get", json!({ "book": &book_a }))["id"],
        book_a
    );
    assert_eq!(
        ws_a.observe(&format!("book:{book_a}")).unwrap().value["meta"]["v"],
        3
    );
    assert_eq!(
        call_out(&ws_a, "book.get", json!({ "book": &book_b }))["id"],
        book_b
    );
    assert_eq!(
        ws_a.observe(&format!("book:{book_b}")).unwrap().value["meta"]["v"],
        3
    );

    // Add a second prose module, a patches module, and a kv module to tpl-chapter in Book A.
    for (id, kind) in [
        ("mod-notes", "prose"),
        ("mod-patches", "patches"),
        ("mod-kv", "kv"),
    ] {
        ws_a.call(
            &Actor::User,
            "entry_template.put_module",
            json!({
                "book": &book_a,
                "template": TPL_CHAPTER,
                "module": { "id": id, "kind": kind, "name": id }
            }),
        )
        .unwrap();
    }

    // Create a template prose document for each book so `template:<book>/<tpl>/<mod>` is exercised.
    for (book_id, text) in [(&book_a, corpus[0].as_str()), (&book_b, corpus[1].as_str())] {
        let tpl_doc_id =
            DocId::parse(&format!("template:{book_id}/{TPL_CHAPTER}/{MOD_PROSE}")).unwrap();
        let mut tpl_doc = ProseDoc::create(tpl_doc_id, 1).unwrap();
        let (r, _) = tpl_doc.edit(Origin::User, |t| t.insert_paragraphs(0, text));
        r.unwrap();
        let tpl_id_str = tpl_doc.doc_id().to_string();
        let handle = ws_a
            .library()
            .open_doc(
                &tpl_id_str,
                OpenDoc::CreateIfMissing {
                    kind: DOC_KIND_TEMPLATE,
                    book_id: Some(book_id.as_str()),
                    genesis: &move |d| {
                        d.import(&tpl_doc.export_snapshot().unwrap()).unwrap();
                    },
                },
            )
            .unwrap();
        drop(handle);
    }

    // Create a multi-body chapter entry in Book A with patches, kv, and an entry checkpoint.
    let ch_a = call_out(
        &ws_a,
        "entry.create",
        json!({
            "book": &book_a,
            "template": TPL_CHAPTER,
            "title": "同步主章",
            "bodies": {
                MOD_PROSE: corpus[0],
                "mod-notes": corpus[1]
            }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let patch_id = call_out(
        &ws_a,
        "module.put_patch",
        json!({
            "book": &book_a,
            "entry": &ch_a,
            "module": "mod-patches",
            "title": "补丁标题",
            "body": corpus[2]
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    ws_a.call(
        &Actor::User,
        "module.put_kv",
        json!({
            "book": &book_a,
            "entry": &ch_a,
            "module": "mod-kv",
            "row": { "id": "kv-weather", "key": "天气", "value": "夜雨" }
        }),
    )
    .unwrap();

    // Create a second entry in Book A, bind it to a timeline pin, attach unknown future fields
    // and an unknown body root, then trash it so its binding & prose are hidden in effective views
    // but retained in raw Loro state.
    let hidden_entry_a = call_out(
        &ws_a,
        "entry.create",
        json!({
            "book": &book_a,
            "template": TPL_CHAPTER,
            "title": "回收但保留的章节",
            "bodies": {
                MOD_PROSE: corpus[3]
            }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let views_a = call_out(&ws_a, "timeline_view.list", json!({ "book": &book_a }));
    let first_view_id = views_a[0]["id"].as_str().unwrap().to_owned();
    let mut view_payload = views_a[0].clone();
    view_payload["pins"] = json!([
        {
            "id": "pin-hidden-binding",
            "label": "暗桩时间钉",
            "at": 12.5,
            "entry": &hidden_entry_a
        }
    ]);
    ws_a.call(
        &Actor::User,
        "timeline_view.put",
        json!({
            "book": &book_a,
            "view": view_payload
        }),
    )
    .unwrap();

    // Inject unknown future field on `ch_a` and `hidden_entry_a` in Book A's raw Loro map,
    // and an unknown root map on `ch_a`'s primary body doc.
    {
        let h_book = ws_a
            .library()
            .open_doc(&format!("book:{book_a}"), OpenDoc::Existing)
            .unwrap();
        let ch_a_clone = ch_a.clone();
        let hidden_clone = hidden_entry_a.clone();
        h_book
            .write(dr_store::Origin::User, move |d| {
                let entries = d.get_map("entries");
                for (eid, tag) in [
                    (&ch_a_clone, "future-active-entry"),
                    (&hidden_clone, "future-trashed-entry"),
                ] {
                    let entry_map = entries.ensure_mergeable_map(eid).unwrap();
                    let future = entry_map.ensure_mergeable_map("future_ext").unwrap();
                    future.insert("retained_flag", tag).unwrap();
                }
            })
            .unwrap();
    }
    {
        let h_body = ws_a
            .library()
            .open_doc(&format!("body:{ch_a}/{MOD_PROSE}"), OpenDoc::Existing)
            .unwrap();
        h_body
            .write(dr_store::Origin::User, |d| {
                d.get_map("future_body_root")
                    .insert("custom_marker", "v3-opaque-body-root")
                    .unwrap();
            })
            .unwrap();
    }

    call_out(
        &ws_a,
        "entry_template.remove_module",
        json!({
            "book":book_a,"template":TPL_CHAPTER,"module":"mod-notes"
        }),
    );

    // Create a checkpoint on `ch_a` in Book A before trashing `hidden_entry_a`.
    let point_a = call_out(
        &ws_a,
        "entry_snapshot.create",
        json!({ "book": &book_a, "entry": &ch_a }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Now trash `hidden_entry_a` so effective queries hide it while raw state retains it.
    ws_a.call(
        &Actor::User,
        "entry.trash",
        json!({ "book": &book_a, "id": &hidden_entry_a }),
    )
    .unwrap();

    // Also create a checkpoint on Book B's first chapter.
    let entries_b = call_out(&ws_a, "entry.list", json!({ "book": &book_b, "all": true }))
        .as_array()
        .unwrap()
        .clone();
    let ch_b = entries_b
        .iter()
        .find(|e| e["template"].as_str() == Some(TPL_CHAPTER))
        .expect("chapter in Book B")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let point_b = call_out(
        &ws_a,
        "entry_snapshot.create",
        json!({ "book": &book_b, "entry": &ch_b }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Import synthetic PNG assets (Source + Thumbnail) and materials for both Book A and Book B.
    let src_bytes_a = media::png(12, 8);
    let thumb_bytes_a = media::png(4, 4);
    let src_path_a = staging.join("book-a-source.png");
    fs::write(&src_path_a, &src_bytes_a).unwrap();
    let asset_a = ws_a
        .library()
        .import_asset(&SourceImport {
            book_id: &book_a,
            asset_id: "asset-book-a-cover",
            source: &src_path_a,
            mime: "image/png",
            ext: "png",
            dimensions: Some((12, 8)),
            limit: MAX_COPY_BYTES,
        })
        .unwrap();
    let thumb_a = ws_a
        .library()
        .put_variant(
            &asset_a.asset_id,
            Variant::Thumbnail,
            &VariantBytes {
                bytes: thumb_bytes_a.clone(),
                mime: "image/png".to_string(),
                ext: "png".to_string(),
                width: 4,
                height: 4,
            },
        )
        .unwrap();
    ws_a.call(
        &Actor::User,
        "asset.put",
        json!({
            "book": &book_a,
            "id": &asset_a.asset_id,
            "kind": "image",
            "mime": &asset_a.mime,
            "size": asset_a.size,
            "sha256": &asset_a.sha256,
            "width": 12,
            "height": 8
        }),
    )
    .unwrap();
    let mat_img_a = call_out(
        &ws_a,
        "material.create",
        json!({
            "book": &book_a,
            "kind": "image",
            "title": "A书封面图",
            "asset": &asset_a.asset_id
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mat_txt_a = call_out(
        &ws_a,
        "material.create",
        json!({
            "book": &book_a,
            "kind": "text",
            "title": "A书设定笔记",
            "text": corpus[4]
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let src_bytes_b = media::png(10, 10);
    let thumb_bytes_b = media::png(3, 3);
    let src_path_b = staging.join("book-b-source.png");
    fs::write(&src_path_b, &src_bytes_b).unwrap();
    let asset_b = ws_a
        .library()
        .import_asset(&SourceImport {
            book_id: &book_b,
            asset_id: "asset-book-b-map",
            source: &src_path_b,
            mime: "image/png",
            ext: "png",
            dimensions: Some((10, 10)),
            limit: MAX_COPY_BYTES,
        })
        .unwrap();
    let thumb_b = ws_a
        .library()
        .put_variant(
            &asset_b.asset_id,
            Variant::Thumbnail,
            &VariantBytes {
                bytes: thumb_bytes_b.clone(),
                mime: "image/png".to_string(),
                ext: "png".to_string(),
                width: 3,
                height: 3,
            },
        )
        .unwrap();
    ws_a.call(
        &Actor::User,
        "asset.put",
        json!({
            "book": &book_b,
            "id": &asset_b.asset_id,
            "kind": "image",
            "mime": &asset_b.mime,
            "size": asset_b.size,
            "sha256": &asset_b.sha256,
            "width": 10,
            "height": 10
        }),
    )
    .unwrap();
    let mat_img_b = call_out(
        &ws_a,
        "material.create",
        json!({
            "book": &book_b,
            "kind": "image",
            "title": "B书海图",
            "asset": &asset_b.asset_id
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mat_txt_b = call_out(
        &ws_a,
        "material.create",
        json!({
            "book": &book_b,
            "kind": "text",
            "title": "B书航行日志",
            "text": corpus[5]
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Open replica B (initially empty) and run A -> FakeSyncServer -> B.
    let ws_b = open_workspace(&dir_b, &device_b);
    assert!(ws_b.library().docs(None, None).unwrap().is_empty());
    assert_ne!(
        ws_a.library().peer_for(&format!("book:{book_a}")).unwrap(),
        ws_b.library().peer_for(&format!("book:{book_a}")).unwrap()
    );
    let mut engine_a = SyncEngine::new(server.base_url(), ws_a.library()).unwrap();
    let mut engine_b = SyncEngine::new(server.base_url(), ws_b.library()).unwrap();

    let initial_a = book_image(ws_a.library(), &book_a);
    let pending = ws_a.library().docs_with_local_changes().unwrap();
    assert!(!pending.is_empty());
    server.set_offline(true);
    assert!(
        engine_a
            .sync_once(ws_a.library(), TOKEN)
            .unwrap_err()
            .is_offline()
    );
    unchanged(ws_a.library(), &book_a, &initial_a, "offline upload");
    assert_eq!(ws_a.library().docs_with_local_changes().unwrap(), pending);
    sentinel(&outside_sentinel, &sentinel_bytes);
    server.set_offline(false);
    engine_a.cancel_handle().store(true, Ordering::SeqCst);
    assert!(matches!(
        engine_a.sync_once(ws_a.library(), TOKEN),
        Err(SyncError::Cancelled)
    ));
    unchanged(ws_a.library(), &book_a, &initial_a, "cancelled upload");
    assert_eq!(ws_a.library().docs_with_local_changes().unwrap(), pending);
    engine_a.cancel_handle().store(false, Ordering::SeqCst);
    sentinel(&outside_sentinel, &sentinel_bytes);

    let push_a = engine_a.sync_once(ws_a.library(), TOKEN).unwrap();
    assert!(push_a.uploaded_docs > 0);
    assert_eq!(push_a.uploaded_assets, 4);

    let pull_b = engine_b.sync_once(ws_b.library(), TOKEN).unwrap();
    assert_eq!(pull_b.downloaded_docs, push_a.uploaded_docs);
    assert_eq!(pull_b.downloaded_assets, 4);

    // 1. Verify both v3 books, doc inventories, and digests match on replica B.
    assert_eq!(
        call_out(&ws_b, "book.get", json!({ "book": &book_a }))["id"],
        book_a
    );
    assert_eq!(
        ws_b.observe(&format!("book:{book_a}")).unwrap().value["meta"]["v"],
        3
    );
    assert_eq!(
        call_out(&ws_b, "book.get", json!({ "book": &book_b }))["id"],
        book_b
    );
    assert_eq!(
        ws_b.observe(&format!("book:{book_b}")).unwrap().value["meta"]["v"],
        3
    );
    assert_eq!(
        seed::digest_v3(ws_a.library(), &book_a).unwrap(),
        seed::digest_v3(ws_b.library(), &book_a).unwrap()
    );
    assert_eq!(
        seed::digest_v3(ws_a.library(), &book_b).unwrap(),
        seed::digest_v3(ws_b.library(), &book_b).unwrap()
    );

    let docs_a_on_a = ws_a.library().docs(Some(&book_a), None).unwrap();
    let docs_a_on_b = ws_b.library().docs(Some(&book_a), None).unwrap();
    assert_eq!(docs_a_on_a.len(), docs_a_on_b.len());
    let docs_b_on_a = ws_a.library().docs(Some(&book_b), None).unwrap();
    let docs_b_on_b = ws_b.library().docs(Some(&book_b), None).unwrap();
    assert_eq!(docs_b_on_a.len(), docs_b_on_b.len());

    // 2. Verify multi-body prose, patches, KV, template prose, and text materials on replica B.
    assert_eq!(
        call_out(
            &ws_b,
            "module.read_prose",
            json!({ "book": &book_a, "owner": &ch_a, "module": MOD_PROSE })
        )["paragraphs"][0]["text"],
        corpus[0]
    );
    assert_eq!(
        call_out(
            &ws_b,
            "module.read_prose",
            json!({ "book": &book_a, "owner": &ch_a, "module": "mod-notes" })
        )["paragraphs"][0]["text"],
        corpus[1]
    );
    assert_eq!(material(&ws_b, &book_a, &mat_txt_a)["kind"], "text");
    assert_eq!(text(&ws_b, &format!("material:{mat_txt_a}")), corpus[4]);
    assert_eq!(material(&ws_b, &book_b, &mat_txt_b)["kind"], "text");
    assert_eq!(text(&ws_b, &format!("material:{mat_txt_b}")), corpus[5]);

    // 3. Verify hidden/trashed entry, retained prose, hidden timeline pin binding, and unknown fields on B.
    let views_on_b = call_out(&ws_b, "timeline_view.list", json!({ "book": &book_a }));
    let eff_view_b = views_on_b
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"].as_str() == Some(&first_view_id))
        .unwrap();
    assert!(
        eff_view_b["pins"][0]["entry"].is_null(),
        "effective timeline_view.list must project trashed pin.entry as null"
    );

    let book_a_copy_b = ws_b.library().load_copy(&format!("book:{book_a}")).unwrap();
    let book_a_id = BookId::parse(&book_a).unwrap();
    let borrowed_a_on_b = BorrowedBookV3::new(&book_a_copy_b, &book_a_id).unwrap();
    let raw_views_b = borrowed_a_on_b.view().timeline_views_raw();
    let raw_pin_entry = raw_views_b
        .iter()
        .find(|v| v.id.as_str() == first_view_id)
        .unwrap()
        .pins[0]
        .entry
        .as_ref()
        .map(|id| id.as_str().to_owned());
    assert_eq!(
        raw_pin_entry.as_deref(),
        Some(hidden_entry_a.as_str()),
        "raw timeline pin binding to trashed entry must survive sync"
    );
    let deep_book_a_b = book_a_copy_b.get_deep_value().to_json_value();
    assert_eq!(
        deep_book_a_b["entries"][&ch_a]["future_ext"]["retained_flag"],
        "future-active-entry"
    );
    assert_eq!(
        deep_book_a_b["entries"][&hidden_entry_a]["future_ext"]["retained_flag"],
        "future-trashed-entry"
    );
    let patch_data = call_out(
        &ws_b,
        "module.read",
        json!({"book":book_a,"entry":ch_a,"module":"mod-patches"}),
    );
    assert!(
        patch_data["patches"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == patch_id && p["body"] == corpus[2])
    );
    let kv_data = call_out(
        &ws_b,
        "module.read",
        json!({"book":book_a,"entry":ch_a,"module":"mod-kv"}),
    );
    assert!(
        kv_data["kv"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == "kv-weather" && p["value"] == "夜雨")
    );

    let body_copy_b = ws_b
        .library()
        .load_copy(&format!("body:{ch_a}/{MOD_PROSE}"))
        .unwrap();
    let raw_body_b = raw_document_state(&body_copy_b).unwrap();
    assert!(
        raw_body_b.to_string().contains("v3-opaque-body-root"),
        "unknown future root on prose body must survive sync"
    );

    // 4. Verify entry_snapshot.list and entry_snapshot.preview on replica B for both books.
    let list_snap_a_b = call_out(
        &ws_b,
        "entry_snapshot.list",
        json!({ "book": &book_a, "entry": &ch_a }),
    );
    assert!(
        list_snap_a_b
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"].as_str() == Some(&point_a))
    );
    let preview_a_b = call_out(
        &ws_b,
        "entry_snapshot.preview",
        json!({ "book": &book_a, "entry": &ch_a, "point": &point_a }),
    );
    assert_eq!(preview_a_b["bodies"].as_array().unwrap().len(), 2);

    let preview_b_b = call_out(
        &ws_b,
        "entry_snapshot.preview",
        json!({ "book": &book_b, "entry": &ch_b, "point": &point_b }),
    );
    assert!(!preview_b_b["bodies"].as_array().unwrap().is_empty());

    // 5. Verify Source and Thumbnail physical asset records & bytes on replica B.
    for (asset_id, expected_book, expected_src, expected_thumb, expected_sha) in [
        (
            &asset_a.asset_id,
            &book_a,
            &src_bytes_a,
            &thumb_bytes_a,
            &asset_a.sha256,
        ),
        (
            &asset_b.asset_id,
            &book_b,
            &src_bytes_b,
            &thumb_bytes_b,
            &asset_b.sha256,
        ),
    ] {
        let rec_src = ws_b
            .library()
            .asset(asset_id, Variant::Source)
            .unwrap()
            .expect("source asset on B");
        assert_eq!(rec_src.book_id, *expected_book);
        assert_eq!(rec_src.sha256, *expected_sha);
        assert_eq!(&fs::read(&rec_src.path).unwrap(), expected_src);

        let rec_thumb = ws_b
            .library()
            .asset(asset_id, Variant::Thumbnail)
            .unwrap()
            .expect("thumbnail asset on B");
        assert_eq!(rec_thumb.book_id, *expected_book);
        assert_eq!(&fs::read(&rec_thumb.path).unwrap(), expected_thumb);
    }
    assert_eq!(thumb_a.variant, Variant::Thumbnail);
    assert_eq!(thumb_b.variant, Variant::Thumbnail);
    assert_eq!(
        material(&ws_b, &book_a, &mat_img_a)["asset"],
        asset_a.asset_id
    );
    assert_eq!(
        material(&ws_b, &book_b, &mat_img_b)["asset"],
        asset_b.asset_id
    );

    converged(ws_a.library(), ws_b.library(), &book_a);
    converged(ws_a.library(), ws_b.library(), &book_b);
    sentinel(&outside_sentinel, &sentinel_bytes);
    let historical_a = preview(&ws_a, &book_a, &ch_a, &point_a);
    let historical_b = preview(&ws_a, &book_b, &ch_b, &point_b);
    assert_eq!(preview(&ws_b, &book_a, &ch_a, &point_a), historical_a);
    assert_eq!(preview(&ws_b, &book_b, &ch_b, &point_b), historical_b);

    let verify_hidden = |ws: &Workspace| {
        let before = book_image(ws.library(), &book_a);
        // Effective queries must hide the trashed entry/binding, without
        // projecting those filtered values back into the raw document.
        let entries = call_out(ws, "entry.list", json!({"book":book_a,"all":true}));
        assert!(
            !entries
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["id"] == hidden_entry_a)
        );
        let views = call_out(ws, "timeline_view.list", json!({"book":book_a}));
        let view = views
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == first_view_id)
            .unwrap();
        assert!(view["pins"][0]["entry"].is_null());
        let doc = ws.library().load_copy(&format!("book:{book_a}")).unwrap();
        let deep = doc.get_deep_value().to_json_value();
        for (entry, expected) in [
            (&ch_a, "future-active-entry"),
            (&hidden_entry_a, "future-trashed-entry"),
        ] {
            assert_eq!(
                deep["entries"][entry]["future_ext"]["retained_flag"],
                expected
            );
        }
        let borrowed = BorrowedBookV3::new(&doc, &BookId::parse(&book_a).unwrap()).unwrap();
        let views = borrowed.view().timeline_views_raw();
        let stored = views
            .iter()
            .find(|v| v.id.as_str() == first_view_id)
            .unwrap();
        assert_eq!(
            stored.pins[0].entry.as_ref().unwrap().as_str(),
            hidden_entry_a
        );
        let modules = call_out(ws, "module.list", json!({"book":book_a,"id":ch_a}));
        assert!(
            modules
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["id"] == "mod-notes" && m["retained"] == true)
        );
        for id in [
            format!("body:{hidden_entry_a}/{MOD_PROSE}"),
            format!("body:{ch_a}/mod-notes"),
        ] {
            let current = book_image(ws.library(), &book_a);
            assert_eq!(
                current.docs[&id].raw, initial_a.docs[&id].raw,
                "retained/hidden raw {id}"
            );
            assert_eq!(
                current.docs[&id].prose, initial_a.docs[&id].prose,
                "actual hidden prose {id}"
            );
        }
        assert_eq!(
            text(ws, &format!("body:{hidden_entry_a}/{MOD_PROSE}")),
            corpus[3]
        );
        let current = book_image(ws.library(), &book_a);
        let id = format!("body:{ch_a}/{MOD_PROSE}");
        assert_eq!(
            current.docs[&id].raw["future_body_root"],
            initial_a.docs[&id].raw["future_body_root"]
        );
        assert_eq!(preview(ws, &book_a, &ch_a, &point_a), historical_a);
        unchanged(
            ws.library(),
            &book_a,
            &before,
            "effective queries/checkpoint preview",
        );
    };
    verify_hidden(&ws_a);
    verify_hidden(&ws_b);

    // 6. Actual guarded edits on both books and both devices, including an
    // individual timeline rename while its stored pin target is hidden.
    guarded(
        &ws_b,
        "entry.update",
        json!({"book":book_b,"id":ch_b,"title":"B端改名后的首章"}),
        &[format!("book:{book_b}")],
    );
    guarded(
        &ws_b,
        "module.set_prose",
        json!({"book":book_b,"owner":ch_b,"module":MOD_PROSE,"paragraphs":[{"text":corpus[6]}]}),
        &[format!("book:{book_b}"), format!("body:{ch_b}/{MOD_PROSE}")],
    );
    guarded(
        &ws_a,
        "material.update",
        json!({"book":book_b,"id":mat_txt_b,"title":"A端改名后的航行日志"}),
        &[format!("book:{book_b}")],
    );
    guarded(
        &ws_a,
        "prose.replace",
        json!({"doc":format!("material:{mat_txt_b}"),"find":corpus[5],"replace":corpus[7]}),
        &[format!("material:{mat_txt_b}")],
    );
    guarded(
        &ws_a,
        "entry.update",
        json!({"book":book_a,"id":ch_a,"title":"A端编辑后的主章"}),
        &[format!("book:{book_a}")],
    );
    guarded(
        &ws_a,
        "prose.replace",
        json!({"doc":format!("body:{ch_a}/{MOD_PROSE}"),"find":corpus[0],"replace":corpus[6]}),
        &[format!("body:{ch_a}/{MOD_PROSE}")],
    );
    guarded(
        &ws_b,
        "timeline_view.rename",
        json!({"book":book_a,"view":first_view_id,"name":"B端时间线"}),
        &[format!("book:{book_a}")],
    );
    engine_b.sync_once(ws_b.library(), TOKEN).unwrap();
    engine_a.sync_once(ws_a.library(), TOKEN).unwrap();
    engine_b.sync_once(ws_b.library(), TOKEN).unwrap();
    for book in [&book_a, &book_b] {
        converged(ws_a.library(), ws_b.library(), book);
    }
    verify_hidden(&ws_a);
    verify_hidden(&ws_b);
    sentinel(&outside_sentinel, &sentinel_bytes);

    // Close the actual libraries, not only Workspace slots. Each device keeps
    // its own installation identity and persisted cursor on reopen.
    let saved_a = [
        book_image(ws_a.library(), &book_a),
        book_image(ws_a.library(), &book_b),
    ];
    let saved_b = [
        book_image(ws_b.library(), &book_a),
        book_image(ws_b.library(), &book_b),
    ];
    let (cursor_a, cursor_b) = (engine_a.cursor(), engine_b.cursor());
    drop(engine_a);
    drop(engine_b);
    ws_a.shutdown().unwrap();
    ws_b.shutdown().unwrap();
    let ws_a = open_workspace(&dir_a, &device_a);
    let ws_b = open_workspace(&dir_b, &device_b);
    let mut engine_a = SyncEngine::new(server.base_url(), ws_a.library()).unwrap();
    let mut engine_b = SyncEngine::new(server.base_url(), ws_b.library()).unwrap();
    assert_eq!((engine_a.cursor(), engine_b.cursor()), (cursor_a, cursor_b));
    for (lib, saved) in [(ws_a.library(), &saved_a), (ws_b.library(), &saved_b)] {
        for (book, image) in [(&book_a, &saved[0]), (&book_b, &saved[1])] {
            unchanged(lib, book, image, "reopen both devices");
        }
    }
    for ws in [&ws_a, &ws_b] {
        assert_eq!(
            call_out(ws, "entry.get", json!({"book":book_b,"id":ch_b}))["title"],
            "B端改名后的首章"
        );
        assert_eq!(text(ws, &format!("body:{ch_b}/{MOD_PROSE}")), corpus[6]);
        assert_eq!(
            material(ws, &book_b, &mat_txt_b)["title"],
            "A端改名后的航行日志"
        );
        assert_eq!(text(ws, &format!("material:{mat_txt_b}")), corpus[7]);
        assert_eq!(
            call_out(ws, "entry.get", json!({"book":book_a,"id":ch_a}))["title"],
            "A端编辑后的主章"
        );
        assert_eq!(preview(ws, &book_b, &ch_b, &point_b), historical_b);
        verify_hidden(ws);
    }

    // 7. Soft trash is still a Loro update. Keep every body, retained module,
    // template, material, checkpoint and asset before actual book.purge.
    let protected_a = book_image(ws_a.library(), &book_b);
    let protected_b = book_image(ws_b.library(), &book_b);
    let before_trash_a = book_image(ws_a.library(), &book_a);
    let before_trash_b = book_image(ws_b.library(), &book_a);
    call_out(&ws_a, "book.trash", json!({"book":book_a}));
    engine_a.sync_once(ws_a.library(), TOKEN).unwrap();
    engine_b.sync_once(ws_b.library(), TOKEN).unwrap();
    for (ws, before) in [(&ws_a, &before_trash_a), (&ws_b, &before_trash_b)] {
        let after = book_image(ws.library(), &book_a);
        assert_eq!(
            after.docs.keys().collect::<Vec<_>>(),
            before.docs.keys().collect::<Vec<_>>()
        );
        for (id, image) in &before.docs {
            if id != &format!("book:{book_a}") {
                assert_eq!(&after.docs[id], image, "soft trash retained {id}");
            }
        }
        assert_eq!(after.assets, before.assets);
        assert!(ws.library().purged_docs(Some(&book_a)).unwrap().is_empty());
        let doc = ws.library().load_copy(&format!("book:{book_a}")).unwrap();
        assert!(!doc.get_deep_value().to_json_value()["meta"]["deleted_at"].is_null());
        assert_eq!(preview(ws, &book_a, &ch_a, &point_a), historical_a);
    }
    unchanged(
        ws_a.library(),
        &book_b,
        &protected_a,
        "soft trash other book",
    );
    unchanged(
        ws_b.library(),
        &book_b,
        &protected_b,
        "soft trash other book",
    );
    sentinel(&outside_sentinel, &sentinel_bytes);

    let expected_docs = ws_a.library().docs(Some(&book_a), None).unwrap();
    let local_files = ws_a.library().assets_of_book(&book_a).unwrap();
    let remote_files = ws_b.library().assets_of_book(&book_a).unwrap();
    assert_eq!(remote_files.len(), 2);
    for asset in &remote_files {
        assert!(asset.path.exists());
    }
    let purge_out = call_out(&ws_a, "book.purge", json!({"book":book_a}));
    assert_eq!(
        purge_out["docs"].as_u64().unwrap() as usize,
        expected_docs.len()
    );
    assert_eq!(purge_out["assets"], 1); // asset IDs, not the two variant files
    purged(ws_a.library(), &book_a, &expected_docs);
    assert!(ws_a.library().assets_of_book(&book_a).unwrap().is_empty());
    for asset in &local_files {
        assert!(
            !asset.path.exists(),
            "local purge left {}",
            asset.variant.as_str()
        );
    }
    unchanged(
        ws_a.library(),
        &book_b,
        &protected_a,
        "local permanent purge",
    );
    let push = engine_a.sync_once(ws_a.library(), TOKEN).unwrap();
    assert_eq!(push.uploaded_purges, expected_docs.len());
    // Remote deletion cannot bypass F2's held-document protection. Closing
    // Workspace slots is an explicit coordinator boundary, not an engine hack.
    ws_b.close();
    let pull = engine_b.sync_once(ws_b.library(), TOKEN).unwrap();
    assert_eq!(pull.applied_purges, expected_docs.len());
    for (ws, protected) in [(&ws_a, &protected_a), (&ws_b, &protected_b)] {
        purged(ws.library(), &book_a, &expected_docs);
        unchanged(ws.library(), &book_b, protected, "remote permanent purge");
    }
    // Once the whole book (`book:<id>` and all its stored documents) is purged
    // on B, B's already-downloaded physical asset files and SQLite asset rows
    // for that book are reclaimed without touching Book B or outside files.
    assert!(ws_b.library().assets_of_book(&book_a).unwrap().is_empty());
    for asset in &remote_files {
        assert!(
            !asset.path.exists(),
            "remote book purge left downloaded {} file on disk",
            asset.variant.as_str()
        );
    }
    sentinel(&outside_sentinel, &sentinel_bytes);

    // Real offline failure, then reconnect with freshly constructed engines.
    server.set_offline(true);
    assert!(
        engine_a
            .sync_once(ws_a.library(), TOKEN)
            .unwrap_err()
            .is_offline()
    );
    assert!(
        engine_b
            .sync_once(ws_b.library(), TOKEN)
            .unwrap_err()
            .is_offline()
    );
    for (ws, protected) in [(&ws_a, &protected_a), (&ws_b, &protected_b)] {
        purged(ws.library(), &book_a, &expected_docs);
        unchanged(ws.library(), &book_b, protected, "offline after purge");
    }
    server.set_offline(false);
    drop(engine_a);
    drop(engine_b);
    let mut engine_a = SyncEngine::new(server.base_url(), ws_a.library()).unwrap();
    let mut engine_b = SyncEngine::new(server.base_url(), ws_b.library()).unwrap();
    engine_a.sync_once(ws_a.library(), TOKEN).unwrap();
    // The public restore path resets B's cursor to zero and replays old Loro
    // updates, blobs and purges. Existing tombstones must keep documents and
    // purged-book assets out.
    let replay = engine_b.restore_library(ws_b.library(), TOKEN).unwrap();
    assert_eq!(replay.downloaded_docs, 0);
    assert_eq!(replay.downloaded_assets, 0);
    engine_a.sync_once(ws_a.library(), TOKEN).unwrap();
    for (ws, protected) in [(&ws_a, &protected_a), (&ws_b, &protected_b)] {
        purged(ws.library(), &book_a, &expected_docs);
        unchanged(
            ws.library(),
            &book_b,
            protected,
            "reconnect and history replay",
        );
        assert_eq!(preview(ws, &book_b, &ch_b, &point_b), historical_b);
    }
    assert!(ws_b.library().assets_of_book(&book_a).unwrap().is_empty());
    for asset in &remote_files {
        assert!(
            !asset.path.exists(),
            "cursor-0 replay resurrected purged {} file",
            asset.variant.as_str()
        );
    }
    assert!(ws_a.library().assets_of_book(&book_a).unwrap().is_empty());
    sentinel(&outside_sentinel, &sentinel_bytes);
    drop(engine_a);
    drop(engine_b);
    ws_a.shutdown().unwrap();
    ws_b.shutdown().unwrap();
    // Tombstones and protected bytes survive a final full disk reopen too.
    for (dir, device, protected) in [
        (&dir_a, &device_a, &protected_a),
        (&dir_b, &device_b, &protected_b),
    ] {
        let ws = open_workspace(dir, device);
        purged(ws.library(), &book_a, &expected_docs);
        unchanged(
            ws.library(),
            &book_b,
            protected,
            "final reopen after deletion",
        );
        assert_eq!(preview(&ws, &book_b, &ch_b, &point_b), historical_b);
        ws.shutdown().unwrap();
    }
    sentinel(&outside_sentinel, &sentinel_bytes);
    assert_eq!(
        fs::metadata(&outside_sentinel).unwrap().modified().unwrap(),
        sentinel_modified
    );
    eprintln!(
        "v3 contract: 2 devices, 2 books, {} purged documents, {} protected documents, 4 source/thumbnail variants; hidden bodies/future fields/checkpoint preview/reopen/offline/replay/sentinel/remote-asset-reclaim verified",
        expected_docs.len(),
        protected_b.docs.len()
    );
}
