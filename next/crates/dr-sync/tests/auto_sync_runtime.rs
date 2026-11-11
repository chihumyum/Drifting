//! Permanent end-to-end automated verification for `SyncRuntime` + `Workspace`:
//! - Local-only and signed-out modes never issue network requests;
//! - Automatic bidirectional sync (`A -> B` and `B -> A`) over loopback `FakeSyncServer`;
//! - Coalesced debounce on rapid consecutive local edits + concurrent CRDT merge;
//! - Offline interruption, exponential backoff retry, and automatic recovery;
//! - `401` (`Reauth`) pause and recovery upon token update;
//! - `sync.status` and `sync.now` workspace commands;
//! - Drain on quit (`drain_and_detach`) and drain on library / account switch;
//! - Book permanent purge (`book.trash` -> `book.purge`) with held-document
//!   blocking (`AlreadyOpen`), preserved retry cursor, physical asset reclamation
//!   on replica B once released, non-resurrection after offline/reconnect, and
//!   strict isolation of the second book and outside-library sentinel file.

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use dr_doc::v3::novel::{MOD_PROSE, TPL_CHAPTER};
use dr_store::asset::{MAX_COPY_BYTES, SourceImport, Variant, VariantBytes};
use dr_store::{Device, Library, LibraryOptions};
use dr_sync::{
    FakeSyncServer, SyncProblem, SyncRuntime, SyncScheduleConfig, SyncSessionMode,
    attach_workspace_target, sync_problems_of,
};
use dr_testkit::{
    media,
    seed::{self, DEFAULT_SEED, Preset},
};
use dr_workspace::{Actor, NavTarget, RemovedEntity, Workspace, WorkspaceOptions, WsEvent};
use serde_json::{Value, json};

const TOKEN_USER_1: &str = "synthetic-auto-sync-token-u1";
const TOKEN_USER_2: &str = "synthetic-auto-sync-token-u2";

fn fast_schedule() -> SyncScheduleConfig {
    SyncScheduleConfig {
        periodic_interval: Duration::from_millis(180),
        edit_debounce: Duration::from_millis(80),
        max_debounce_wait: Duration::from_millis(260),
        initial_backoff: Duration::from_millis(80),
        max_backoff: Duration::from_millis(320),
        drain_timeout: Duration::from_secs(4),
    }
}

fn lib_options(device: &Device) -> LibraryOptions {
    let mut opts = seed::library_options("0.2.0-test");
    opts.device = Some(device.clone());
    opts
}

fn open_ws(path: &Path, device: &Device) -> Workspace {
    fs::create_dir_all(path).expect("create library dir");
    let lib = Library::open(path, lib_options(device)).expect("open library");
    Workspace::open(lib, WorkspaceOptions::default()).expect("open workspace")
}

fn call_out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name} failed: {e}"))["output"]
        .clone()
}

fn prose_text(ws: &Workspace, doc: &str) -> String {
    call_out(ws, "prose.read", json!({ "doc": doc }))["paragraphs"]
        .as_array()
        .expect("paragraphs array")
        .iter()
        .map(|p| p["text"].as_str().unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n")
}

fn wait_until(timeout: Duration, desc: &str, mut pred: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if pred() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    assert!(pred(), "timed out waiting for: {desc}");
}

#[test]
fn two_devices_auto_sync_offline_recovery_drain_switch_and_book_purge_asset_reclaim() {
    let server = FakeSyncServer::start(TOKEN_USER_1);
    let root = tempfile::tempdir().expect("temp root");

    let dir_a = root.path().join("device-a-lib");
    let dir_b = root.path().join("device-b-lib");
    let dir_c = root.path().join("device-a-switched-lib");
    let staging = root.path().join("staging");
    fs::create_dir_all(&staging).expect("staging dir");

    // Synthetic sentinel outside every library directory: neither bytes nor mtime may change.
    let sentinel_path = root.path().join("outside-library-sentinel.bin");
    let sentinel_bytes = media::png(6, 6);
    fs::write(&sentinel_path, &sentinel_bytes).expect("write sentinel");
    let sentinel_mtime = fs::metadata(&sentinel_path)
        .expect("sentinel metadata")
        .modified()
        .expect("sentinel mtime");
    let check_sentinel = || {
        assert_eq!(
            fs::read(&sentinel_path).expect("read sentinel"),
            sentinel_bytes
        );
        assert_eq!(
            fs::metadata(&sentinel_path)
                .expect("meta")
                .modified()
                .expect("mtime"),
            sentinel_mtime
        );
    };

    let dev_a =
        Device::open_with_machine_id(root.path().join("dev-a"), Some("synthetic-host-a".into()))
            .expect("dev a");
    let dev_b =
        Device::open_with_machine_id(root.path().join("dev-b"), Some("synthetic-host-b".into()))
            .expect("dev b");

    // Seed two canonical v3 books and extract canonical corpus lines.
    let seed_a = seed::generate_v3(Preset::Tiny, DEFAULT_SEED).expect("seed book 1");
    let seed_b = seed::generate_v3(Preset::Tiny, DEFAULT_SEED + 1).expect("seed book 2");
    let book_1 = seed_a.books[0].book_id().as_str().to_owned();
    let book_2 = seed_b.books[0].book_id().as_str().to_owned();
    assert_ne!(book_1, book_2);

    let corpus: Vec<String> = seed_a.books[0]
        .prose
        .iter()
        .flat_map(|p| p.view().paragraphs().map(|p| p.text()).collect::<Vec<_>>())
        .filter(|s| !s.is_empty())
        .take(6)
        .collect();
    assert_eq!(corpus.len(), 6);

    {
        let lib_a = Library::open(&dir_a, lib_options(&dev_a)).expect("seed open a");
        assert!(seed_a.write_to(&lib_a).expect("write seed a") > 0);
        assert!(seed_b.write_to(&lib_a).expect("write seed b") > 0);
        lib_a.close().expect("close seeded lib a");
    }

    let ws_a = open_ws(&dir_a, &dev_a);
    let ws_b = open_ws(&dir_b, &dev_b);

    let rt_a = Arc::new(SyncRuntime::start(fast_schedule()));
    let rt_b = Arc::new(SyncRuntime::start(fast_schedule()));

    // 1. Local-only and SignedOut modes never issue sync HTTP requests.
    rt_a.configure(
        Some(attach_workspace_target(&ws_a, &rt_a)),
        SyncSessionMode::LocalOnly,
    );
    let ch_1 = call_out(&ws_a, "entry.list", json!({ "book": &book_1, "all": true }))
        .as_array()
        .expect("entries")
        .iter()
        .find(|e| e["template"].as_str() == Some(TPL_CHAPTER))
        .expect("chapter in book 1")["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let ch_1_doc = format!("body:{ch_1}/{MOD_PROSE}");
    let ch_2 = call_out(&ws_a, "entry.list", json!({ "book": &book_2, "all": true }))
        .as_array()
        .expect("entries")
        .iter()
        .find(|e| e["template"].as_str() == Some(TPL_CHAPTER))
        .expect("chapter in book 2")["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let ch_2_doc = format!("body:{ch_2}/{MOD_PROSE}");

    rt_a.configure(
        Some(attach_workspace_target(&ws_a, &rt_a)),
        SyncSessionMode::SignedOut,
    );
    {
        let s = ws_a.prose_session(&ch_1_doc).expect("open ch1 session");
        let p = corpus[0].clone();
        s.edit(move |t| t.insert_paragraphs(0, &p))
            .expect("edit while signed out");
    }
    thread::sleep(Duration::from_millis(260));
    assert_eq!(
        server.sync_request_count(),
        0,
        "local-only and signed-out modes must make zero sync requests"
    );
    let status_offline_local = call_out(&ws_a, "sync.status", json!({}));
    assert_eq!(status_offline_local["hosted_enabled"], false);
    assert!(ws_a.call(&Actor::User, "sync.now", json!({})).is_err());

    // Import synthetic PNG assets (source + thumbnail) for both Book 1 and Book 2 on A.
    let png_1_src = media::png(12, 8);
    let png_1_thumb = media::png(4, 4);
    let src_file_1 = staging.join("b1.png");
    fs::write(&src_file_1, &png_1_src).expect("write b1 png");
    ws_a.library()
        .import_asset(&SourceImport {
            book_id: &book_1,
            asset_id: "asset-b1-cover",
            source: &src_file_1,
            mime: "image/png",
            ext: "png",
            dimensions: Some((12, 8)),
            limit: MAX_COPY_BYTES,
        })
        .expect("import b1 src");
    ws_a.library()
        .put_variant(
            "asset-b1-cover",
            Variant::Thumbnail,
            &VariantBytes {
                bytes: png_1_thumb.clone(),
                mime: "image/png".into(),
                ext: "png".into(),
                width: 4,
                height: 4,
            },
        )
        .expect("import b1 thumb");

    let png_2_src = media::png(10, 10);
    let src_file_2 = staging.join("b2.png");
    fs::write(&src_file_2, &png_2_src).expect("write b2 png");
    ws_a.library()
        .import_asset(&SourceImport {
            book_id: &book_2,
            asset_id: "asset-b2-map",
            source: &src_file_2,
            mime: "image/png",
            ext: "png",
            dimensions: Some((10, 10)),
            limit: MAX_COPY_BYTES,
        })
        .expect("import b2 src");

    // 2. Connect both A and B to FakeSyncServer -> B automatically receives both books & assets!
    let mode_a = SyncSessionMode::Connected {
        base_url: server.base_url().to_owned(),
        user_id: "u1".into(),
        access_token: TOKEN_USER_1.into(),
        library_root: dir_a.clone(),
    };
    let mode_b = SyncSessionMode::Connected {
        base_url: server.base_url().to_owned(),
        user_id: "u1".into(),
        access_token: TOKEN_USER_1.into(),
        library_root: dir_b.clone(),
    };
    rt_a.configure(Some(attach_workspace_target(&ws_a, &rt_a)), mode_a.clone());
    rt_b.configure(Some(attach_workspace_target(&ws_b, &rt_b)), mode_b.clone());

    wait_until(
        Duration::from_secs(5),
        "B auto-receives initial books and assets from A",
        || {
            ws_b.library().doc_info(&ch_1_doc).ok().flatten().is_some()
                && ws_b
                    .library()
                    .assets_of_book(&book_1)
                    .map(|a| a.len())
                    .unwrap_or(0)
                    == 2
                && ws_b
                    .library()
                    .assets_of_book(&book_2)
                    .map(|a| a.len())
                    .unwrap_or(0)
                    == 1
                && prose_text(&ws_b, &ch_1_doc) == prose_text(&ws_a, &ch_1_doc)
        },
    );

    // Warm B's Workspace book/prose caches via shelf & prose queries (simulating browsing Bookshelf).
    let shelf_b = call_out(&ws_b, "book.shelf", json!({}));
    assert_eq!(shelf_b.as_array().expect("shelf array").len(), 2);
    let _ = prose_text(&ws_b, &ch_2_doc);

    // 3. Rapid consecutive local edits on B coalesce into 1 debounced upload and arrive on A!
    let cycles_b_before = rt_b.snapshot().completed_cycles;
    {
        let s_b = ws_b.prose_session(&ch_1_doc).expect("open ch1 on B");
        for line in &corpus[1..5] {
            let p = line.clone();
            s_b.edit(move |t| t.insert_paragraphs(0, &p))
                .expect("rapid edit on B");
            thread::sleep(Duration::from_millis(8));
        }
    }
    wait_until(
        Duration::from_secs(5),
        "A auto-receives B's coalesced edits",
        || prose_text(&ws_a, &ch_1_doc) == prose_text(&ws_b, &ch_1_doc),
    );
    let cycles_b_delta = rt_b
        .snapshot()
        .completed_cycles
        .saturating_sub(cycles_b_before);
    assert!(
        (1..=3).contains(&cycles_b_delta),
        "4 rapid edits within 32ms must coalesce rather than firing per edit (got {cycles_b_delta} cycles)"
    );

    // 4. Offline + concurrent edits on A and B -> zero data loss -> reconnect -> CRDT merge!
    server.set_offline(true);
    {
        let s_a = ws_a.prose_session(&ch_2_doc).expect("open ch2 on A");
        let p4 = corpus[4].clone();
        s_a.edit(move |t| t.insert_paragraphs(0, &p4))
            .expect("offline edit on A");
        let count_b = call_out(&ws_b, "prose.read", json!({ "doc": &ch_2_doc }))["paragraphs"]
            .as_array()
            .expect("paras")
            .len();
        let s_b = ws_b.prose_session(&ch_2_doc).expect("open ch2 on B");
        let p5 = corpus[5].clone();
        s_b.edit(move |t| t.insert_paragraphs(count_b, &p5))
            .expect("offline edit on B");
    }
    wait_until(
        Duration::from_secs(3),
        "A records offline state while preserving unsynced edit",
        || rt_a.snapshot().health.offline && rt_a.snapshot().pending_docs > 0,
    );
    assert!(prose_text(&ws_a, &ch_2_doc).contains(&corpus[4]));
    assert!(prose_text(&ws_b, &ch_2_doc).contains(&corpus[5]));

    // Transient 502 error exercises exponential backoff, then clears.
    server.set_forced_status_error(Some(502));
    server.set_offline(false);
    wait_until(
        Duration::from_secs(3),
        "backoff failures increment on 502",
        || rt_a.snapshot().consecutive_backoff_failures >= 1,
    );
    server.set_forced_status_error(None);

    wait_until(
        Duration::from_secs(5),
        "A and B auto-recover and merge concurrent edits",
        || {
            let ta = prose_text(&ws_a, &ch_2_doc);
            let tb = prose_text(&ws_b, &ch_2_doc);
            ta == tb && ta.contains(&corpus[4]) && ta.contains(&corpus[5])
        },
    );

    // 5. 401 Unauthorized pauses automatic loops with `SyncProblem::Reauth` until token updates.
    server.set_expected_token("rotated-loopback-token");
    {
        let s_a = ws_a.prose_session(&ch_1_doc).expect("open ch1 on A");
        let p2 = corpus[2].clone();
        s_a.edit(move |t| t.insert_paragraphs(0, &p2))
            .expect("edit before 401");
    }
    wait_until(
        Duration::from_secs(3),
        "A enters Reauth problem on 401",
        || sync_problems_of(&rt_a.snapshot().health, 100_000).contains(&SyncProblem::Reauth),
    );
    let reqs_after_401 = server.sync_request_count();
    thread::sleep(Duration::from_millis(350));
    // B may poll once and also hit 401, after which BOTH pause!
    let reqs_paused = server.sync_request_count();
    thread::sleep(Duration::from_millis(350));
    assert_eq!(
        server.sync_request_count(),
        reqs_paused,
        "401 Reauth must pause automatic background polling (before={reqs_after_401}, paused={reqs_paused})"
    );

    // Update both A and B with the rotated token -> immediate recovery!
    let mode_a_rot = SyncSessionMode::Connected {
        base_url: server.base_url().to_owned(),
        user_id: "u1".into(),
        access_token: "rotated-loopback-token".into(),
        library_root: dir_a.clone(),
    };
    let mode_b_rot = SyncSessionMode::Connected {
        base_url: server.base_url().to_owned(),
        user_id: "u1".into(),
        access_token: "rotated-loopback-token".into(),
        library_root: dir_b.clone(),
    };
    rt_a.configure(
        Some(attach_workspace_target(&ws_a, &rt_a)),
        mode_a_rot.clone(),
    );
    rt_b.configure(
        Some(attach_workspace_target(&ws_b, &rt_b)),
        mode_b_rot.clone(),
    );
    wait_until(
        Duration::from_secs(5),
        "A and B recover after token rotation",
        || {
            !rt_a.snapshot().health.reauth_required
                && !rt_b.snapshot().health.reauth_required
                && prose_text(&ws_a, &ch_1_doc) == prose_text(&ws_b, &ch_1_doc)
        },
    );

    // 6. Book purge + open-document blocking (`AlreadyOpen`) + physical asset reclamation!
    // Hold `ch_1_doc` open in an editor `ProseSession` on B while A permanently purges `book_1`.
    let b_downloaded_assets = ws_b
        .library()
        .assets_of_book(&book_1)
        .expect("b1 assets on B");
    assert_eq!(b_downloaded_assets.len(), 2);
    for a in &b_downloaded_assets {
        assert!(a.path.exists());
    }
    let b_book2_assets = ws_b
        .library()
        .assets_of_book(&book_2)
        .expect("b2 assets on B");
    assert_eq!(b_book2_assets.len(), 1);

    let removed_on_b: Arc<Mutex<Vec<RemovedEntity>>> = Arc::default();
    let removed_clone = Arc::clone(&removed_on_b);
    let _ws_b_sub = ws_b.subscribe(move |ev| {
        if let WsEvent::Removed(r) = ev {
            removed_clone
                .lock()
                .expect("lock")
                .extend(r.entities.iter().cloned());
        }
    });

    let held_session_on_b = ws_b
        .prose_session(&ch_1_doc)
        .expect("hold open editor session on B");

    ws_a.call(&Actor::User, "book.trash", json!({ "book": &book_1 }))
        .expect("trash book 1 on A");
    ws_a.call(&Actor::User, "book.purge", json!({ "book": &book_1 }))
        .expect("purge book 1 on A");

    // Wait for A to upload purges and B to attempt pulling them and block on `AlreadyOpen`!
    wait_until(
        Duration::from_secs(5),
        "B blocks remote purge on held ProseSession",
        || rt_b.snapshot().blocked_on_open_doc,
    );
    let blocked_cursor = rt_b.snapshot().cursor;
    assert!(
        ws_b.library()
            .purged(&ch_1_doc)
            .expect("purged query")
            .is_none(),
        "held chapter must NOT be purged while open in ProseSession"
    );
    // While blocked, B's downloaded assets for `book_1` remain intact.
    assert_eq!(
        ws_b.library()
            .assets_of_book(&book_1)
            .expect("assets")
            .len(),
        2
    );

    // Release B's open editor session and notify the runtime -> B retries from the
    // preserved cursor, purges all docs of `book_1`, and reclaims B's physical asset files!
    drop(held_session_on_b);
    rt_b.notify_holder_released();

    wait_until(
        Duration::from_secs(5),
        "B finishes book purge and reclaims physical asset files",
        || {
            !rt_b.snapshot().blocked_on_open_doc
                && rt_b.snapshot().cursor > blocked_cursor
                && ws_b.library().book_purged(&book_1).unwrap_or(false)
                && ws_b
                    .library()
                    .assets_of_book(&book_1)
                    .map(|a| a.is_empty())
                    .unwrap_or(false)
        },
    );
    for asset in &b_downloaded_assets {
        assert!(
            !asset.path.exists(),
            "B's physical asset file {} must be deleted after remote book purge",
            asset.path.display()
        );
    }
    assert!(
        removed_on_b
            .lock()
            .expect("lock")
            .iter()
            .any(|e| e.target == NavTarget::Book && e.purged),
        "Workspace must emit Removed(Book, purged: true) so Shelf updates immediately"
    );
    // Book 2 and its physical asset file remain 100% untouched!
    assert_eq!(
        ws_b.library()
            .assets_of_book(&book_2)
            .expect("b2 assets")
            .len(),
        1
    );
    assert!(b_book2_assets[0].path.exists());

    // Offline -> reconnect must never resurrect purged `book_1` or its assets.
    server.set_offline(true);
    thread::sleep(Duration::from_millis(220));
    server.set_offline(false);
    let _ = call_out(&ws_b, "sync.now", json!({}));
    assert!(ws_b.library().book_purged(&book_1).expect("still purged"));
    assert!(
        ws_b.library()
            .assets_of_book(&book_1)
            .expect("empty")
            .is_empty()
    );

    // 7. Library / Account switch drain: write an edit on A, then immediately switch `rt_a`
    // to a second account/library BEFORE debounce fires -> outgoing Library A drains with
    // Account 1's token, `ws_a.try_shutdown()` closes cleanly, and B receives A's last edit!
    let server_2 = FakeSyncServer::start(TOKEN_USER_2);
    let ws_c = open_ws(&dir_c, &dev_a);
    {
        let s_a = ws_a.prose_session(&ch_2_doc).expect("open ch2 on A");
        let p3 = corpus[3].clone();
        s_a.edit(move |t| t.insert_paragraphs(0, &p3))
            .expect("pre-switch edit on A");
    }
    let expected_ch2_after_switch = prose_text(&ws_a, &ch_2_doc);

    // Immediately switch `rt_a` to `(ws_c, server_2, TOKEN_USER_2)` without waiting for debounce!
    rt_a.configure(
        Some(attach_workspace_target(&ws_c, &rt_a)),
        SyncSessionMode::Connected {
            base_url: server_2.base_url().to_owned(),
            user_id: "u2".into(),
            access_token: TOKEN_USER_2.into(),
            library_root: dir_c.clone(),
        },
    );
    // `ws_a` must now shut down cleanly (`Arc::strong_count == 1` on its `Library`)!
    ws_a.try_shutdown()
        .expect("outgoing ws_a closes cleanly after switch drain");

    // B (still on `server` with `u1`) must receive A's pre-switch edit!
    wait_until(
        Duration::from_secs(5),
        "B receives A's pre-switch drained edit",
        || prose_text(&ws_b, &ch_2_doc) == expected_ch2_after_switch,
    );

    // 8. Quit drain (`drain_and_detach`): write an edit on B, immediately call `drain_and_detach()`
    // before debounce fires, close B, and verify a fresh reopened replica sees B's quit-drained edit!
    {
        let s_b = ws_b.prose_session(&ch_2_doc).expect("open ch2 on B");
        let p1 = corpus[1].clone();
        s_b.edit(move |t| t.insert_paragraphs(0, &p1))
            .expect("pre-quit edit on B");
    }
    let expected_ch2_after_quit = prose_text(&ws_b, &ch_2_doc);
    let drain_rep = rt_b.drain_and_detach().expect("quit drain on B");
    assert!(
        drain_rep.uploaded_docs >= 1,
        "quit drain must upload pending local edits immediately"
    );
    ws_b.try_shutdown()
        .expect("ws_b shuts down cleanly after drain_and_detach");

    let dir_verify = root.path().join("device-verify-lib");
    let dev_v =
        Device::open_with_machine_id(root.path().join("dev-v"), Some("synthetic-host-v".into()))
            .expect("dev v");
    let ws_v = open_ws(&dir_verify, &dev_v);
    let rt_v = Arc::new(SyncRuntime::start(fast_schedule()));
    rt_v.configure(
        Some(attach_workspace_target(&ws_v, &rt_v)),
        SyncSessionMode::Connected {
            base_url: server.base_url().to_owned(),
            user_id: "u1".into(),
            access_token: "rotated-loopback-token".into(),
            library_root: dir_verify,
        },
    );
    wait_until(
        Duration::from_secs(5),
        "fresh replica receives quit-drained state",
        || {
            rt_v.snapshot().completed_cycles >= 1
                && ws_v.library().doc_info(&ch_2_doc).ok().flatten().is_some()
                && prose_text(&ws_v, &ch_2_doc) == expected_ch2_after_quit
        },
    );
    assert!(
        ws_v.library()
            .book_purged(&book_1)
            .expect("purged on fresh replica")
    );
    assert!(
        ws_v.library()
            .assets_of_book(&book_1)
            .expect("no b1 assets")
            .is_empty()
    );

    let _ = rt_v.drain_and_detach();
    ws_v.try_shutdown().expect("close verify ws");
    let _ = rt_a.drain_and_detach();
    ws_c.try_shutdown().expect("close ws_c");

    check_sentinel();
}
