//! Restoring an older backup of a synced library (M41's in-app restore, which
//! replaces only the database file): the restored library resumes the change
//! feed from its own cursor, gets back everything written since the backup
//! (another device's edits and its own uploads), and converges at once.
//!
//! Loopback `FakeSyncServer`, temporary libraries, a synthetic token, and
//! canonical v3 data from `dr_testkit::seed` only.

use std::collections::HashMap;
use std::path::Path;

use dr_model::id::DocId;
use dr_store::{Library, backup};
use dr_sync::{FakeSyncServer, SyncEngine};
use dr_testkit::seed::{self, DEFAULT_SEED, Preset};
use dr_workspace::{Actor, Workspace, WorkspaceOptions};
use serde_json::json;

const TOKEN: &str = "synthetic-restore-backup-token";
const VERSION: &str = "0.2.0-test";

fn open_workspace(path: &Path) -> Workspace {
    Workspace::open(
        Library::open(path, seed::library_options(VERSION)).unwrap(),
        WorkspaceOptions::default(),
    )
    .unwrap()
}

fn set_body(ws: &Workspace, book: &str, body: &str, texts: &[&str]) {
    let Ok(DocId::Body(id)) = DocId::parse(body) else {
        unreachable!("a body document id");
    };
    ws.call(
        &Actor::User,
        "module.set_prose",
        json!({
            "book": book,
            "owner": id.entry().as_str(),
            "module": id.module().as_str(),
            "paragraphs": texts.iter().map(|t| json!({"text": t})).collect::<Vec<_>>(),
        }),
    )
    .unwrap();
}

/// Every document of both libraries: the same ids, versions and values.
fn assert_converged(a: &Library, b: &Library) {
    let ids = |lib: &Library| {
        lib.docs(None, None)
            .unwrap()
            .into_iter()
            .map(|d| d.doc_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(a), ids(b));
    for doc_id in ids(a) {
        let (da, db) = (a.load_copy(&doc_id).unwrap(), b.load_copy(&doc_id).unwrap());
        assert_eq!(da.oplog_vv(), db.oplog_vv(), "{doc_id}: version");
        assert_eq!(da.get_deep_value(), db.get_deep_value(), "{doc_id}: value");
    }
}

fn text_of(lib: &Library, doc_id: &str) -> String {
    format!("{:?}", lib.load_copy(doc_id).unwrap().get_deep_value())
}

#[test]
fn restoring_an_older_backup_resumes_from_its_own_cursor_and_converges() {
    let root = tempfile::tempdir().unwrap();
    let server = FakeSyncServer::start(TOKEN);
    let seed = seed::generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
    let book = seed.books[0].book_id().to_string();
    let corpus: Vec<String> = seed.books[0]
        .prose
        .iter()
        .flat_map(|p| p.view().paragraphs().map(|p| p.text()).collect::<Vec<_>>())
        .filter(|s| !s.is_empty())
        .take(4)
        .collect();
    assert_eq!(corpus.len(), 4);
    let author_path = root.path().join("author");
    {
        let lib = Library::open(&author_path, seed::library_options(VERSION)).unwrap();
        seed.write_to(&lib).unwrap();
        lib.close().unwrap();
    }
    let author = open_workspace(&author_path);
    let bodies: Vec<String> = author
        .library()
        .docs(Some(&book), None)
        .unwrap()
        .into_iter()
        .filter(|d| matches!(DocId::parse(&d.doc_id), Ok(DocId::Body(_))))
        .map(|d| d.doc_id)
        .collect();
    assert!(bodies.len() >= 2);
    let (authors_body, readers_body) = (&bodies[0], &bodies[1]);
    let mut engine_a = SyncEngine::new(server.base_url(), author.library()).unwrap();
    engine_a.sync_once(author.library(), TOKEN).unwrap();

    // The second device syncs everything, then backs its library up.
    let reader_path = root.path().join("reader");
    let reader = open_workspace(&reader_path);
    let mut engine_b = SyncEngine::new(server.base_url(), reader.library()).unwrap();
    engine_b.sync_once(reader.library(), TOKEN).unwrap();
    engine_a.sync_once(author.library(), TOKEN).unwrap();
    assert_converged(author.library(), reader.library());
    let cursor_at_backup = engine_b.cursor();
    let backed_up = (
        text_of(reader.library(), authors_body),
        text_of(reader.library(), readers_body),
    );
    let package = root.path().join("reader-backup.drifting");
    reader
        .library()
        .export_backup(&package, &HashMap::new())
        .unwrap();

    // After the backup: the author edits and the reader pulls it; the reader
    // edits and uploads its own change.
    set_body(&author, &book, authors_body, &[&corpus[3]]);
    engine_a.sync_once(author.library(), TOKEN).unwrap();
    set_body(&reader, &book, readers_body, &[&corpus[2]]);
    engine_b.sync_once(reader.library(), TOKEN).unwrap();
    engine_a.sync_once(author.library(), TOKEN).unwrap();
    assert_converged(author.library(), reader.library());
    assert!(engine_b.cursor() > cursor_at_backup);

    // The reader restores the backup: its database goes back to before both
    // changes, the files beside it stay as they are.
    drop(engine_b);
    reader.shutdown().unwrap();
    let staged = backup::stage(&reader_path, &package, VERSION).unwrap();
    let (restored, _) =
        Library::restore_staged(&reader_path, &staged, seed::library_options(VERSION)).unwrap();
    assert_eq!(
        (
            text_of(&restored, authors_body),
            text_of(&restored, readers_body)
        ),
        backed_up
    );
    let reader = Workspace::open(restored, WorkspaceOptions::default()).unwrap();

    // The author goes on writing, on top of what the restored copy lacks.
    set_body(&author, &book, authors_body, &[&corpus[3], &corpus[1]]);
    engine_a.sync_once(author.library(), TOKEN).unwrap();

    // The restored library carries the cursor of its own data, so the first
    // cycle fetches everything since the backup, in order, and succeeds.
    let mut engine_b = SyncEngine::new(server.base_url(), reader.library()).unwrap();
    assert_eq!(engine_b.cursor(), cursor_at_backup);
    let report = engine_b.sync_once(reader.library(), TOKEN).unwrap();
    assert!(report.downloaded_docs >= 3, "{report:?}");
    engine_a.sync_once(author.library(), TOKEN).unwrap();
    assert_converged(author.library(), reader.library());
    // The author has read the whole feed.
    assert_eq!(engine_b.cursor(), engine_a.cursor());

    // Settled on both sides.
    let again = engine_b.sync_once(reader.library(), TOKEN).unwrap();
    assert_eq!((again.uploaded_docs, again.downloaded_docs), (0, 0));
    assert_converged(author.library(), reader.library());
}
