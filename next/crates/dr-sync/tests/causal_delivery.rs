//! Remote updates that arrive before the updates they build on (M36): never
//! acknowledged, healed by one in-order replay of the feed, for a document
//! that is closed and for one an editor holds open; and the engine's progress
//! kept in the library database, one row per fact.
//!
//! Loopback `FakeSyncServer`, temporary libraries, a synthetic token, and
//! canonical v3 data from `dr_testkit::seed` only. The fake server's
//! `withhold` breaks the in-order contract on purpose, so the second of two
//! updates is listed before the first.

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use dr_doc::prose::ProseReader;
use dr_model::id::DocId;
use dr_store::{Library, OpenDoc, StoreEvent, local_state};
use dr_sync::{
    FakeSyncServer, RemoteObjectPayload, RemoteObjectRecord, SYNC_STATE_SCOPE, SyncEngine,
    SyncError,
};
use dr_testkit::seed::{self, DEFAULT_SEED, Preset};
use dr_workspace::{Actor, Workspace, WorkspaceOptions};
use loro::{LoroDoc, VersionVector};
use serde_json::json;
use tempfile::TempDir;

const TOKEN: &str = "synthetic-causal-delivery-token";
const VERSION: &str = "0.2.0-test";

/// The device that writes: a canonical v3 Tiny book behind a workspace.
struct Author {
    ws: Workspace,
    book: String,
    body: String,
    corpus: Vec<String>,
}

fn author(path: &Path) -> Author {
    let seed = seed::generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
    let book = seed.books[0].book_id().to_string();
    // Every text written later comes from the seed too.
    let corpus: Vec<String> = seed.books[0]
        .prose
        .iter()
        .flat_map(|p| p.view().paragraphs().map(|p| p.text()).collect::<Vec<_>>())
        .filter(|s| !s.is_empty())
        .take(4)
        .collect();
    assert_eq!(corpus.len(), 4);
    let lib = Library::open(path, seed::library_options(VERSION)).unwrap();
    seed.write_to(&lib).unwrap();
    let body = lib
        .docs(Some(&book), None)
        .unwrap()
        .into_iter()
        .find(|d| matches!(DocId::parse(&d.doc_id), Ok(DocId::Body(_))))
        .unwrap()
        .doc_id;
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    Author {
        ws,
        book,
        body,
        corpus,
    }
}

impl Author {
    fn lib(&self) -> &Library {
        self.ws.library()
    }

    /// Replace the body's paragraphs: one commit of this device's peer, on
    /// top of the previous one.
    fn set_body(&self, texts: &[&str]) {
        let Ok(DocId::Body(id)) = DocId::parse(&self.body) else {
            unreachable!("a body document id");
        };
        self.ws
            .call(
                &Actor::User,
                "module.set_prose",
                json!({
                    "book": self.book,
                    "owner": id.entry().as_str(),
                    "module": id.module().as_str(),
                    "paragraphs": texts.iter().map(|t| json!({"text": t})).collect::<Vec<_>>(),
                }),
            )
            .unwrap();
    }
}

fn paragraphs(doc_id: &str, doc: &LoroDoc) -> Vec<String> {
    ProseReader::from_loro(DocId::parse(doc_id).unwrap(), doc)
        .unwrap()
        .view()
        .paragraphs()
        .map(|p| p.text())
        .collect()
}

fn stored_paragraphs(lib: &Library, doc_id: &str) -> Vec<String> {
    paragraphs(doc_id, &lib.load_copy(doc_id).unwrap())
}

fn record_vv(record: &RemoteObjectRecord) -> VersionVector {
    let RemoteObjectPayload::LoroUpdate { vv_base64, .. } = &record.payload else {
        panic!("not a Loro update: {record:?}");
    };
    VersionVector::decode(&URL_SAFE_NO_PAD.decode(vv_base64).unwrap()).unwrap()
}

fn covers(have: &VersionVector, want: &VersionVector) -> bool {
    want.iter()
        .all(|(peer, end)| have.get(peer).copied().unwrap_or(0) >= *end)
}

fn latest_seq(server: &FakeSyncServer) -> u64 {
    server.records().last().map(|r| r.seq).unwrap_or(0)
}

/// Two devices in step, then two edits of one body on the author's device,
/// each uploaded on its own: `second` builds on `first`.
struct Scenario {
    root: TempDir,
    server: FakeSyncServer,
    author: Author,
    reader: Library,
    engine_b: SyncEngine,
    /// The body on the reader before both edits.
    before: Vec<String>,
    /// The body after both edits.
    after: Vec<String>,
    first: RemoteObjectRecord,
    second: RemoteObjectRecord,
}

fn scenario() -> Scenario {
    let root = tempfile::tempdir().unwrap();
    let server = FakeSyncServer::start(TOKEN);
    let author = author(&root.path().join("author"));
    let mut engine_a = SyncEngine::new(server.base_url(), author.lib()).unwrap();
    engine_a.sync_once(author.lib(), TOKEN).unwrap();
    let reader = Library::open(root.path().join("reader"), seed::library_options(VERSION)).unwrap();
    let mut engine_b = SyncEngine::new(server.base_url(), &reader).unwrap();
    engine_b.sync_once(&reader, TOKEN).unwrap();
    let base = engine_b.cursor();
    assert!(base > 0);
    let before = stored_paragraphs(&reader, &author.body);
    assert_eq!(before, stored_paragraphs(author.lib(), &author.body));

    let edits = [
        vec![author.corpus[3].as_str()],
        vec![author.corpus[3].as_str(), author.corpus[2].as_str()],
    ];
    for edit in &edits {
        author.set_body(edit);
        engine_a.sync_once(author.lib(), TOKEN).unwrap();
    }
    let after = stored_paragraphs(author.lib(), &author.body);
    assert_eq!(after, edits[1]);
    assert_ne!(after, before);
    let mut body_records: Vec<RemoteObjectRecord> = server
        .records()
        .into_iter()
        .filter(|r| {
            r.seq > base
                && matches!(&r.payload, RemoteObjectPayload::LoroUpdate { doc_id, .. }
                    if *doc_id == author.body)
        })
        .collect();
    assert_eq!(body_records.len(), 2, "one record per edit");
    let second = body_records.pop().unwrap();
    let first = body_records.pop().unwrap();
    assert!(covers(&record_vv(&second), &record_vv(&first)));
    assert!(!covers(&record_vv(&first), &record_vv(&second)));
    Scenario {
        root,
        server,
        author,
        reader,
        engine_b,
        before,
        after,
        first,
        second,
    }
}

impl Scenario {
    /// The early update was refused: named, not stored, not marked as on the
    /// server, the reader's body as before.
    fn assert_not_acknowledged(&self, error: &SyncError, confirmed: &VersionVector) {
        let body = &self.author.body;
        assert!(
            matches!(error, SyncError::MissingDependencies { doc_id, seq }
                if doc_id == body && *seq == self.second.seq),
            "{error:?}"
        );
        assert_eq!(&self.reader.remote_vv(body).unwrap(), confirmed);
        assert!(!covers(
            &self.reader.remote_vv(body).unwrap(),
            &record_vv(&self.second)
        ));
        assert!(!covers(
            &self.reader.head(body).unwrap().unwrap().vv,
            &record_vv(&self.first)
        ));
        assert_eq!(stored_paragraphs(&self.reader, body), self.before);
        assert!(self.engine_b.cursor() < self.second.seq);
        // What the database says, as a restarted app would read it.
        assert_eq!(
            SyncEngine::new(self.server.base_url(), &self.reader)
                .unwrap()
                .cursor(),
            self.engine_b.cursor()
        );
    }

    /// Both edits arrived, acknowledged, and the next cycle has nothing left.
    fn assert_healed(&mut self) {
        let body = &self.author.body;
        assert_eq!(stored_paragraphs(&self.reader, body), self.after);
        assert_eq!(
            self.reader.head(body).unwrap().unwrap().vv,
            self.author.lib().head(body).unwrap().unwrap().vv
        );
        assert!(covers(
            &self.reader.remote_vv(body).unwrap(),
            &record_vv(&self.second)
        ));
        assert_eq!(self.engine_b.cursor(), latest_seq(&self.server));
        let again = self.engine_b.sync_once(&self.reader, TOKEN).unwrap();
        assert_eq!((again.downloaded_docs, again.uploaded_docs), (0, 0));
    }
}

#[test]
fn an_update_ahead_of_its_dependency_is_refused_and_one_replay_heals_a_closed_doc() {
    let mut s = scenario();
    let body = s.author.body.clone();
    let confirmed = s.reader.remote_vv(&body).unwrap();
    s.server.withhold(s.first.seq);

    let error = s.engine_b.sync_once(&s.reader, TOKEN).unwrap_err();
    s.assert_not_acknowledged(&error, &confirmed);
    // The replay: the cursor went back to the start of the feed, stored.
    assert_eq!(s.engine_b.cursor(), 0);

    // The update it builds on is listed again: the replay applies both.
    s.server.release_withheld();
    let report = s.engine_b.sync_once(&s.reader, TOKEN).unwrap();
    assert!(report.downloaded_docs >= 2, "{report:?}");
    s.assert_healed();
    // Stored complete: reopening loads it (dr-store refuses stored updates
    // with missing dependencies).
    s.reader.close().unwrap();
    let reader =
        Library::open(s.root.path().join("reader"), seed::library_options(VERSION)).unwrap();
    assert_eq!(stored_paragraphs(&reader, &body), s.after);
    reader.close().unwrap();
}

#[test]
fn a_doc_held_open_parks_the_early_update_and_ends_acknowledged_after_the_replay() {
    let mut s = scenario();
    let body = s.author.body.clone();
    let confirmed = s.reader.remote_vv(&body).unwrap();
    let held = s.reader.open_doc(&body, OpenDoc::Existing).unwrap();
    let read_held = |held: &dr_store::DocHandle| {
        let id = body.clone();
        held.read(move |doc| paragraphs(&id, doc)).unwrap()
    };
    s.server.withhold(s.first.seq);

    let error = s.engine_b.sync_once(&s.reader, TOKEN).unwrap_err();
    s.assert_not_acknowledged(&error, &confirmed);
    assert_eq!(s.engine_b.cursor(), 0);
    // Loro keeps the early update waiting in the open document, invisible.
    assert_eq!(read_held(&held), s.before);

    // Its dependency applies it and the update waiting with it; the early
    // update's own record then finds itself covered and is acknowledged.
    s.server.release_withheld();
    s.engine_b.sync_once(&s.reader, TOKEN).unwrap();
    assert_eq!(read_held(&held), s.after);
    s.assert_healed();
    held.close();
    s.reader.close().unwrap();
    let reader =
        Library::open(s.root.path().join("reader"), seed::library_options(VERSION)).unwrap();
    assert_eq!(stored_paragraphs(&reader, &body), s.after);
    reader.close().unwrap();
}

#[test]
fn a_dependency_still_missing_after_the_replay_keeps_failing_without_another_reset() {
    let mut s = scenario();
    let body = s.author.body.clone();
    let confirmed = s.reader.remote_vv(&body).unwrap();
    s.server.withhold(s.first.seq);

    let error = s.engine_b.sync_once(&s.reader, TOKEN).unwrap_err();
    s.assert_not_acknowledged(&error, &confirmed);
    assert_eq!(s.engine_b.cursor(), 0, "the one replay");

    // The replay passes everything listed before the early update and stops
    // there again; no second reset, however often it is tried.
    let stuck = s
        .server
        .records()
        .iter()
        .map(|r| r.seq)
        .filter(|seq| *seq < s.second.seq && *seq != s.first.seq)
        .max()
        .unwrap();
    // The two edits were uploaded one after the other: nothing lies between
    // them, so the stopping place is before the withheld record.
    assert!(stuck < s.first.seq);
    for _ in 0..2 {
        let error = s.engine_b.sync_once(&s.reader, TOKEN).unwrap_err();
        s.assert_not_acknowledged(&error, &confirmed);
        assert_eq!(s.engine_b.cursor(), stuck);
    }
    // Every cycle failed, so the health tracker escalates it.
    assert!(s.engine_b.health_snapshot().library_failed_cycles >= 3);

    // A new engine (the app started again) has one replay of its own.
    s.engine_b = SyncEngine::new(s.server.base_url(), &s.reader).unwrap();
    assert_eq!(s.engine_b.cursor(), stuck);
    let error = s.engine_b.sync_once(&s.reader, TOKEN).unwrap_err();
    s.assert_not_acknowledged(&error, &confirmed);
    assert_eq!(s.engine_b.cursor(), 0);
    let error = s.engine_b.sync_once(&s.reader, TOKEN).unwrap_err();
    s.assert_not_acknowledged(&error, &confirmed);
    assert_eq!(s.engine_b.cursor(), stuck);

    // Once the update it builds on is listed, the next cycle applies both.
    s.server.release_withheld();
    let report = s.engine_b.sync_once(&s.reader, TOKEN).unwrap();
    assert!(report.downloaded_docs >= 2, "{report:?}");
    s.assert_healed();
}

#[test]
fn sync_progress_lives_in_the_library_one_row_per_fact() {
    let root = tempfile::tempdir().unwrap();
    let server = FakeSyncServer::start(TOKEN);
    let author = author(&root.path().join("author"));
    let mut engine_a = SyncEngine::new(server.base_url(), author.lib()).unwrap();
    engine_a.sync_once(author.lib(), TOKEN).unwrap();

    // A state file from before the move is neither read nor kept.
    let reader_path = root.path().join("reader");
    let reader = Library::open(&reader_path, seed::library_options(VERSION)).unwrap();
    let old_file = reader_path.join("sync-cursor-v2.json");
    fs::write(
        &old_file,
        br#"{"cursor":99999,"registered_docs":["body:synthetic/stale"],"uploaded_purges":[]}"#,
    )
    .unwrap();
    let mut engine_b = SyncEngine::new(server.base_url(), &reader).unwrap();
    assert_eq!(engine_b.cursor(), 0);
    assert!(!old_file.exists());

    let changes = Arc::new(Mutex::new(Vec::<String>::new()));
    let _subscription = reader.subscribe({
        let changes = Arc::clone(&changes);
        let prefix = format!("{SYNC_STATE_SCOPE}/");
        move |event| {
            if let StoreEvent::Local(change) = event
                && change.table == local_state::TABLE
                && change.key.starts_with(&prefix)
            {
                changes.lock().unwrap().push(change.key.clone());
            }
        }
    });
    let cursor_key = format!("{SYNC_STATE_SCOPE}/cursor");
    let registered = |lib: &Library| {
        lib.local_entries(SYNC_STATE_SCOPE, None)
            .unwrap()
            .into_iter()
            .filter(|e| e.key.starts_with("doc/"))
            .collect::<Vec<_>>()
    };

    // First pull: each document gets a row of its own, written once.
    engine_b.sync_once(&reader, TOKEN).unwrap();
    let docs: Vec<String> = reader
        .docs(None, None)
        .unwrap()
        .into_iter()
        .map(|d| d.doc_id)
        .collect();
    assert!(docs.len() > 1);
    let rows = registered(&reader);
    assert_eq!(
        rows.iter().map(|e| e.key.clone()).collect::<Vec<_>>(),
        docs.iter().map(|d| format!("doc/{d}")).collect::<Vec<_>>()
    );
    let seen = std::mem::take(&mut *changes.lock().unwrap());
    for doc_id in &docs {
        let key = format!("{SYNC_STATE_SCOPE}/doc/{doc_id}");
        assert_eq!(seen.iter().filter(|k| **k == key).count(), 1, "{key}");
    }
    assert_eq!(
        reader.local_get(SYNC_STATE_SCOPE, "cursor").unwrap(),
        Some(latest_seq(&server).to_string())
    );

    // More records, all for a document already known: each moves the cursor
    // row and nothing else is written; the document rows stay as they were.
    for texts in [
        [author.corpus[3].as_str()],
        [author.corpus[2].as_str()],
        [author.corpus[1].as_str()],
    ] {
        author.set_body(&texts);
        engine_a.sync_once(author.lib(), TOKEN).unwrap();
    }
    let from = engine_b.cursor();
    let pulled = usize::try_from(latest_seq(&server) - from).unwrap();
    assert!(pulled >= 3);
    engine_b.sync_once(&reader, TOKEN).unwrap();
    assert_eq!(*changes.lock().unwrap(), vec![cursor_key; pulled]);
    assert_eq!(registered(&reader), rows);
    assert_eq!(
        reader.local_get(SYNC_STATE_SCOPE, "cursor").unwrap(),
        Some(engine_b.cursor().to_string())
    );

    // A new engine on the same library resumes from these rows.
    drop(engine_b);
    let engine_b = SyncEngine::new(server.base_url(), &reader).unwrap();
    assert_eq!(engine_b.cursor(), latest_seq(&server));
    assert!(!engine_b.has_pending_uploads(&reader).unwrap());
}
