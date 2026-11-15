//! DW (`handoff/v5-tracks.md` item 9, `WORKING-COPY-LOCAL`): the working
//! copy a template is edited in never leaves this device. Sync uploads none
//! of its documents (book, prose, the three side documents), none of its
//! asset bytes, and none of its purge records once its documents go; the
//! projects next to it sync as before, and so does the template its writes
//! are saved over.

use std::fs;

use dr_store::Library;
use dr_store::asset::{MAX_COPY_BYTES, SourceImport};
use dr_sync::{FakeSyncServer, RemoteObjectPayload, SyncEngine};
use dr_testkit::{media, seed};
use dr_workspace::{Actor, Workspace, WorkspaceOptions};
use serde_json::{Value, json};

const TOKEN: &str = "synthetic-working-copy-token";

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name} failed: {e}"))["output"]
        .clone()
}

fn string(v: &Value) -> String {
    v.as_str().unwrap().to_owned()
}

/// Whether a stored object belongs to `book`.
fn of_book(payload: &RemoteObjectPayload, book: &str) -> bool {
    match payload {
        RemoteObjectPayload::LoroUpdate {
            doc_id, book_id, ..
        }
        | RemoteObjectPayload::DocPurge {
            doc_id, book_id, ..
        } => book_id.as_deref() == Some(book) || doc_id.contains(book),
        RemoteObjectPayload::AssetBlob { book_id, .. } => book_id == book,
    }
}

#[test]
fn a_working_copy_uploads_no_document_asset_or_purge() {
    let dir = tempfile::tempdir().unwrap();
    let staging = tempfile::tempdir().unwrap();
    let lib = Library::open(
        dir.path().join("library"),
        seed::library_options("0.2.0-test"),
    )
    .unwrap();
    // The project next to it is a seeded one (every document stored).
    let seeded = seed::generate_v3(seed::Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    let project = seeded.books[0].book_id().to_string();
    seeded.write_to(&lib).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let template = string(
        &out(
            &ws,
            "project_template.save",
            json!({"book": project, "name": "模板"}),
        )["id"],
    );
    let copy = string(&out(&ws, "project_template.edit", json!({"id": template}))["book"]);

    // Something written in the copy: prose and a file.
    let ms = out(&ws, "entry.list", json!({"book": copy}))
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["template"] == "tpl-manuscript")
        .map(|x| string(&x["id"]))
        .unwrap();
    let chapter = string(
        &out(
            &ws,
            "entry.create",
            json!({"book": copy, "parent": ms, "template": "tpl-chapter", "title": "试写"}),
        )["id"],
    );
    out(
        &ws,
        "module.set_prose",
        json!({"book": copy, "owner": chapter, "module": "mod-prose", "paragraphs": [{"text": "只在这台设备上"}]}),
    );
    let png = staging.path().join("copy.png");
    fs::write(&png, media::png(6, 4)).unwrap();
    let asset = ws
        .library()
        .import_asset(&SourceImport {
            book_id: &copy,
            asset_id: "asset-working-copy",
            source: &png,
            mime: "image/png",
            ext: "png",
            dimensions: Some((6, 4)),
            limit: MAX_COPY_BYTES,
        })
        .unwrap();
    out(
        &ws,
        "asset.put",
        json!({"book": copy, "id": asset.asset_id, "kind": "image", "mime": asset.mime,
               "size": asset.size, "sha256": asset.sha256, "width": 6, "height": 4}),
    );
    let waiting: Vec<String> = ws
        .library()
        .docs_with_local_changes()
        .unwrap()
        .into_iter()
        .filter(|d| {
            ws.library()
                .doc_info(d)
                .unwrap()
                .is_some_and(|i| i.book_id.as_deref() == Some(copy.as_str()))
        })
        .collect();
    assert_eq!(
        waiting,
        Vec::<String>::new(),
        "the working copy waits to upload"
    );
    assert!(
        !ws.library()
            .assets_pending_upload()
            .unwrap()
            .iter()
            .any(|a| a.book_id == copy),
        "the working copy's file waits to upload"
    );

    let server = FakeSyncServer::start(TOKEN);
    let mut engine = SyncEngine::new(server.base_url(), ws.library()).unwrap();
    engine.sync_once(ws.library(), TOKEN).unwrap();
    let records = server.records();
    assert!(
        records.iter().any(|r| of_book(&r.payload, &project)),
        "the project next to it syncs"
    );
    assert!(
        !records.iter().any(|r| of_book(&r.payload, &copy)),
        "the working copy reached the server: {records:#?}"
    );
    assert_eq!(
        engine.pending_upload_counts(ws.library()).unwrap(),
        (0, 0, 0)
    );

    // Its writes are saved over the template, which syncs like any.
    ws.flush_working_copies().unwrap();
    engine.sync_once(ws.library(), TOKEN).unwrap();
    assert!(
        server.records().iter().any(|r| matches!(
            &r.payload,
            RemoteObjectPayload::LoroUpdate { doc_id, .. } if doc_id == &format!("project-template:{template}")
        )),
        "the template syncs"
    );

    // Its documents gone (as clearing a copy left behind does): no purge
    // record goes up either.
    ws.close();
    for doc in ws.library().docs(Some(&copy), None).unwrap() {
        match ws.library().purge_doc(&doc.doc_id) {
            // Registered, nothing stored yet.
            Ok(()) | Err(dr_store::StoreError::NotFound(_)) => {}
            Err(e) => panic!("{}: {e}", doc.doc_id),
        }
    }
    engine.sync_once(ws.library(), TOKEN).unwrap();
    assert!(
        !server.records().iter().any(|r| of_book(&r.payload, &copy)),
        "a purge of the working copy reached the server"
    );
    assert_eq!(
        engine.pending_upload_counts(ws.library()).unwrap(),
        (0, 0, 0)
    );
    ws.close();
}
