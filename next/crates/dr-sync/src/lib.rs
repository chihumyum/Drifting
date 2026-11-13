//! M36 Hosted Sync v2: Loro object-log protocol (`loro-v2`), incremental
//! document/asset sync engine and paper-corner sync status state machine.
//!
//! This crate lives in `Layer::Services` and does not depend on GPUI.

pub mod engine;
pub mod fake_server;
pub mod health;
pub mod protocol;
pub mod runtime;

pub use engine::{
    AfterRemoteImportHook, AfterRemotePurgeHook, BeforeRemotePurgeHook, SYNC_STATE_SCOPE,
    SyncCycleReport, SyncEngine,
};
pub use fake_server::FakeSyncServer;
pub use health::{
    PaperSyncMarkPresentation, SYNC_FAILING_CYCLES, SYNC_FAILING_FOR_MS, SYNC_MARK_LINGER_MS,
    SYNC_MARK_SHOW_AFTER_MS, SYNC_MARK_TYPING_SETTLE_MS, SYNC_RETRY_SHOW_AFTER_MS,
    SyncBookHealthSnapshot, SyncCornerState, SyncHealthSnapshot, SyncHealthTracker, SyncProblem,
    SyncStatusAction, SyncStatusVisual, evaluate_paper_sync_mark, sync_corner_for,
    sync_library_corner_for, sync_problems_of, sync_status_actions_for,
};
pub use protocol::{
    CONTENT_SHA256_HEADER, ChangesPage, DEFAULT_HARD_LIMIT_BYTES, DEFAULT_QUOTA_BYTES, HostedUsage,
    MAX_OBJECT_BYTES, OBJECT_META_HEADER, RemoteObjectPayload, RemoteObjectRecord,
    SYNC_CAPABILITIES_HEADER, SYNC_CAPABILITIES_VALUE, SYNC_NAMESPACE_LORO_V2, SyncError,
    SyncHttpClient, check_asset_quota, sha256_digest, validate_staging_path, validate_sync_url,
    verify_payload_integrity, write_verified_file_atomic,
};
pub use runtime::{
    StateChangeCallback, SyncRuntime, SyncRuntimeSnapshot, SyncScheduleConfig, SyncSessionMode,
    SyncTarget, attach_workspace_target,
};

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicBool, Ordering};

    use dr_store::asset::{MAX_COPY_BYTES, SourceImport, Variant, VariantBytes};
    use dr_store::{Library, LibraryOptions, OpenDoc, Origin};
    use tempfile::TempDir;

    use super::*;

    fn test_opts() -> LibraryOptions {
        LibraryOptions::new("0.2.0-test")
    }

    fn write_loro_text(lib: &Library, doc_id: &str, kind: &str, book_id: Option<&str>, text: &str) {
        let handle = lib
            .open_doc(
                doc_id,
                OpenDoc::CreateIfMissing {
                    kind,
                    book_id,
                    genesis: &|_| {},
                },
            )
            .expect("open doc");
        handle
            .write(Origin::User, {
                let text = text.to_string();
                move |doc| {
                    let t = doc.get_text("body");
                    let len = t.len_unicode();
                    let _ = t.insert(len, &text);
                }
            })
            .expect("edit doc");
        handle.close();
    }

    fn read_loro_text(lib: &Library, doc_id: &str) -> String {
        let doc = lib.load_copy(doc_id).expect("load copy");
        doc.get_text("body").to_string()
    }

    #[test]
    fn two_libraries_converge_across_opaque_docs_agent_chats_compaction_and_assets() {
        let server = FakeSyncServer::start("tok-sync-v2");
        let dir_a = TempDir::new().expect("dir a");
        let dir_b = TempDir::new().expect("dir b");

        let lib_a = Library::open(dir_a.path(), test_opts()).expect("open a");
        let lib_b = Library::open(dir_b.path(), test_opts()).expect("open b");

        let mut engine_a = SyncEngine::new(server.base_url(), &lib_a).expect("engine a");
        let mut engine_b = SyncEngine::new(server.base_url(), &lib_b).expect("engine b");

        // Replica A writes an opaque book document, a chapter document, a v3-style
        // custom document kind, an Agent conversation document (`conv:*`), and an
        // asset with source + thumbnail variants.
        write_loro_text(
            &lib_a,
            "book:b1",
            "book-catalog-opaque",
            Some("b1"),
            "Book Title: The Wind; ",
        );
        write_loro_text(
            &lib_a,
            "doc:ch1",
            "manuscript-leaf",
            Some("b1"),
            "Paragraph one from A. ",
        );
        write_loro_text(
            &lib_a,
            "conv:session-1",
            "agent-conversation",
            Some("b1"),
            "[turn 1] User: outline chapter 1\n",
        );

        // Compact replica A before uploading to prove compaction and sync upload
        // are completely independent (`export_for_upload`).
        let handle = lib_a.open_doc("doc:ch1", OpenDoc::Existing).expect("open");
        handle.compact_now().expect("compact");
        handle.close();

        // Import an asset on replica A.
        let src_file = dir_a.path().join("cover-input.png");
        let asset_bytes = b"\x89PNG\r\n\x1a\nsynthetic-cover-bytes-123456";
        fs::write(&src_file, asset_bytes).expect("write src asset");
        lib_a
            .import_asset(&SourceImport {
                book_id: "b1",
                asset_id: "asset-cover-1",
                source: &src_file,
                mime: "image/png",
                ext: "png",
                dimensions: Some((600, 800)),
                limit: MAX_COPY_BYTES,
            })
            .expect("import source asset");
        let thumb_bytes = b"synthetic-thumbnail-bytes";
        lib_a
            .put_variant(
                "asset-cover-1",
                Variant::Thumbnail,
                &VariantBytes {
                    bytes: thumb_bytes.to_vec(),
                    mime: "image/webp".to_string(),
                    ext: "webp".to_string(),
                    width: 150,
                    height: 200,
                },
            )
            .expect("put thumbnail variant");

        // Replica A uploads; Replica B pulls and writes concurrent edits to the
        // same chapter and Agent conversation.
        let rep_a1 = engine_a.sync_once(&lib_a, "tok-sync-v2").expect("sync a1");
        assert_eq!(rep_a1.uploaded_docs, 3);
        assert_eq!(rep_a1.uploaded_assets, 2);

        let rep_b1 = engine_b.sync_once(&lib_b, "tok-sync-v2").expect("sync b1");
        assert_eq!(rep_b1.downloaded_docs, 3);
        assert_eq!(rep_b1.downloaded_assets, 2);

        // Both replicas now make concurrent edits before syncing.
        write_loro_text(&lib_a, "doc:ch1", "manuscript-leaf", Some("b1"), "A2. ");
        write_loro_text(&lib_b, "doc:ch1", "manuscript-leaf", Some("b1"), "B2. ");
        write_loro_text(
            &lib_b,
            "conv:session-1",
            "agent-conversation",
            Some("b1"),
            "[turn 2] Assistant: drafted.\n",
        );

        engine_a.sync_once(&lib_a, "tok-sync-v2").expect("sync a2");
        engine_b.sync_once(&lib_b, "tok-sync-v2").expect("sync b2");
        engine_a.sync_once(&lib_a, "tok-sync-v2").expect("sync a3");

        // Verify document lists and Loro deep values / textos match identically.
        assert_eq!(
            lib_a.docs(None, None).expect("docs a"),
            lib_b.docs(None, None).expect("docs b")
        );
        for info in lib_a.docs(None, None).expect("docs a") {
            let doc_a = lib_a.load_copy(&info.doc_id).expect("load a");
            let doc_b = lib_b.load_copy(&info.doc_id).expect("load b");
            assert_eq!(doc_a.get_deep_value(), doc_b.get_deep_value());
            assert_eq!(doc_a.oplog_vv(), doc_b.oplog_vv());
            assert_eq!(
                read_loro_text(&lib_a, &info.doc_id),
                read_loro_text(&lib_b, &info.doc_id)
            );
        }

        // Verify asset bytes on replica B match replica A byte-for-byte.
        let rec_src_b = lib_b
            .asset("asset-cover-1", Variant::Source)
            .expect("asset src")
            .expect("present");
        assert_eq!(fs::read(&rec_src_b.path).expect("read src b"), asset_bytes);
        let rec_thumb_b = lib_b
            .asset("asset-cover-1", Variant::Thumbnail)
            .expect("asset thumb")
            .expect("present");
        assert_eq!(
            fs::read(&rec_thumb_b.path).expect("read thumb b"),
            thumb_bytes
        );
    }

    #[test]
    fn offline_interruption_resumes_and_converges() {
        let server = FakeSyncServer::start("tok-resume");
        let dir_a = TempDir::new().expect("dir a");
        let dir_b = TempDir::new().expect("dir b");

        let lib_a = Library::open(dir_a.path(), test_opts()).expect("open a");
        let lib_b = Library::open(dir_b.path(), test_opts()).expect("open b");

        write_loro_text(&lib_a, "doc:1", "opaque-kind", Some("b1"), "Doc 1 text");
        write_loro_text(&lib_a, "doc:2", "opaque-kind", Some("b1"), "Doc 2 text");
        write_loro_text(&lib_a, "doc:3", "opaque-kind", Some("b1"), "Doc 3 text");

        let mut engine_a = SyncEngine::new(server.base_url(), &lib_a).expect("engine a");
        // Drop the connection after 1 PUT request on the server.
        server.set_fail_after_requests(Some(1));
        let err = engine_a
            .sync_once_at(&lib_a, "tok-resume", 1_000)
            .expect_err("mid-sync disconnect should fail");
        assert!(err.is_offline());
        assert_eq!(
            engine_a.corner_state(Some("b1"), 1_000),
            Some(SyncCornerState::Offline)
        );

        // Restore connectivity and resume upload on A.
        server.set_fail_after_requests(None);
        let rep_a = engine_a
            .sync_once_at(&lib_a, "tok-resume", 2_000)
            .expect("resume sync a");
        assert_eq!(rep_a.uploaded_docs, 2);
        assert_eq!(engine_a.corner_state(Some("b1"), 2_000), None);

        // Now interrupt replica B halfway through downloading.
        let mut engine_b = SyncEngine::new(server.base_url(), &lib_b).expect("engine b");
        // 1 request for list_changes + 1 request for first object, then fail on second object.
        server.set_fail_after_requests(Some(2));
        let err_b = engine_b
            .sync_once_at(&lib_b, "tok-resume", 3_000)
            .expect_err("mid-download disconnect should fail");
        assert!(err_b.is_offline());
        assert_eq!(engine_b.cursor(), 1);

        // Reconnect and finish downloading the remaining 2 documents.
        server.set_fail_after_requests(None);
        let rep_b = engine_b
            .sync_once_at(&lib_b, "tok-resume", 4_000)
            .expect("resume download b");
        assert_eq!(rep_b.downloaded_docs, 2);
        assert_eq!(lib_b.docs(None, None).expect("docs b").len(), 3);
        for id in ["doc:1", "doc:2", "doc:3"] {
            assert_eq!(read_loro_text(&lib_a, id), read_loro_text(&lib_b, id));
        }
    }

    #[test]
    fn quota_soft_and_hard_limits_block_assets_and_surface_quota_problem() {
        let server = FakeSyncServer::start("tok-quota");
        let dir = TempDir::new().expect("dir");
        let lib = Library::open(dir.path(), test_opts()).expect("open");
        let mut engine = SyncEngine::new(server.base_url(), &lib).expect("engine");

        // 1. Client preflight against 500 MiB soft quota (`DEFAULT_QUOTA_BYTES`).
        server.set_used_bytes_override(Some(DEFAULT_QUOTA_BYTES - 1024));
        let ok_usage = engine
            .check_new_asset_quota(&lib, "tok-quota", 512)
            .expect("within 500 MiB soft limit");
        assert_eq!(ok_usage.quota_bytes, DEFAULT_QUOTA_BYTES);

        let err = engine
            .check_new_asset_quota(&lib, "tok-quota", 2048)
            .expect_err("exceeding 500 MiB soft limit must fail");
        assert!(err.is_quota_exceeded());
        assert_eq!(
            engine.corner_state(None, 5_000),
            Some(SyncCornerState::Problem(SyncProblem::Quota))
        );
        assert_eq!(engine.active_problems(5_000), vec![SyncProblem::Quota]);

        // 2. Server-enforced 413 QUOTA_EXCEEDED during upload when storage hits quota.
        server.set_quota_bytes(100, 200);
        server.set_used_bytes_override(Some(90));
        let src_file = dir.path().join("large.png");
        fs::write(&src_file, [0u8; 32]).expect("write");
        lib.import_asset(&SourceImport {
            book_id: "b1",
            asset_id: "asset-over-quota",
            source: &src_file,
            mime: "image/png",
            ext: "png",
            dimensions: None,
            limit: MAX_COPY_BYTES,
        })
        .expect("import local asset");

        let sync_err = engine
            .sync_once_at(&lib, "tok-quota", 6_000)
            .expect_err("upload over quota should fail");
        assert!(sync_err.is_quota_exceeded());
        assert_eq!(
            engine.corner_state(Some("b1"), 6_000),
            Some(SyncCornerState::Problem(SyncProblem::Quota))
        );
    }

    #[test]
    fn restore_into_empty_library_recovers_all_docs_and_assets() {
        let server = FakeSyncServer::start("tok-restore");
        let dir_origin = TempDir::new().expect("origin");
        let dir_fresh = TempDir::new().expect("fresh");

        let lib_origin = Library::open(dir_origin.path(), test_opts()).expect("open origin");
        write_loro_text(
            &lib_origin,
            "book:main",
            "v3-project",
            Some("b-restore"),
            "Project root",
        );
        write_loro_text(
            &lib_origin,
            "item:ch-01",
            "v3-item",
            Some("b-restore"),
            "Restored chapter body",
        );
        write_loro_text(
            &lib_origin,
            "conv:chat-99",
            "agent-conversation",
            None,
            "Saved Agent conversation",
        );

        let src_file = dir_origin.path().join("map.jpg");
        let map_bytes = b"synthetic-jpeg-map-bytes-for-restore";
        fs::write(&src_file, map_bytes).expect("write map");
        lib_origin
            .import_asset(&SourceImport {
                book_id: "b-restore",
                asset_id: "asset-map",
                source: &src_file,
                mime: "image/jpeg",
                ext: "jpg",
                dimensions: Some((1024, 768)),
                limit: MAX_COPY_BYTES,
            })
            .expect("import map");

        let mut engine_origin =
            SyncEngine::new(server.base_url(), &lib_origin).expect("engine origin");
        engine_origin
            .sync_once(&lib_origin, "tok-restore")
            .expect("upload origin");

        // Open a brand-new empty library on a second device and restore.
        let lib_fresh = Library::open(dir_fresh.path(), test_opts()).expect("open fresh");
        assert!(lib_fresh.docs(None, None).expect("empty").is_empty());

        let mut engine_fresh =
            SyncEngine::new(server.base_url(), &lib_fresh).expect("engine fresh");
        let report = engine_fresh
            .restore_library(&lib_fresh, "tok-restore")
            .expect("restore library");
        assert_eq!(report.downloaded_docs, 3);
        assert_eq!(report.downloaded_assets, 1);

        assert_eq!(
            lib_fresh.docs(None, None).expect("docs fresh"),
            lib_origin.docs(None, None).expect("docs origin")
        );
        for id in ["book:main", "item:ch-01", "conv:chat-99"] {
            assert_eq!(
                read_loro_text(&lib_fresh, id),
                read_loro_text(&lib_origin, id)
            );
        }
        let restored_asset = lib_fresh
            .asset("asset-map", Variant::Source)
            .expect("query asset")
            .expect("asset exists");
        assert_eq!(
            fs::read(&restored_asset.path).expect("read restored asset"),
            map_bytes
        );
        assert!(
            lib_fresh
                .assets_pending_upload()
                .expect("pending")
                .is_empty(),
            "restored assets must be marked uploaded"
        );
    }

    #[test]
    fn sync_status_state_machine_covers_every_visual_and_rule() {
        // 1. Local library never displays anything.
        let mut local_tracker = SyncHealthTracker::new(false);
        local_tracker.begin_cycle(Some("b1"), 1_000);
        let p_local = local_tracker.presentation_for(Some("b1"), false, 10_000);
        assert_eq!(p_local.visual, SyncStatusVisual::Hidden);
        assert_eq!(p_local.corner, None);

        // 2. Synced state displays nothing.
        let mut tracker = SyncHealthTracker::new(true);
        assert_eq!(
            tracker.presentation_for(Some("b1"), false, 1_000).visual,
            SyncStatusVisual::Hidden
        );

        // 3. Syncing under 3 seconds stays hidden; at >= 3 seconds shows
        // BreathingCloud; split-pane trailing paper stays hidden.
        tracker.begin_cycle(Some("b1"), 1_000);
        assert_eq!(
            tracker.presentation_for(Some("b1"), false, 3_999).visual,
            SyncStatusVisual::Hidden
        );
        let p_syncing = tracker.presentation_for(Some("b1"), false, 4_000);
        assert_eq!(p_syncing.corner, Some(SyncCornerState::Syncing));
        assert_eq!(p_syncing.visual, SyncStatusVisual::BreathingCloud);
        assert!(!p_syncing.faded_for_typing);
        assert!(p_syncing.actions.is_empty());

        // Split view: trailing (right) pane never shows the mark.
        assert_eq!(
            tracker.presentation_for(Some("b1"), true, 4_000).visual,
            SyncStatusVisual::Hidden
        );

        // 4. Typing fades out `Syncing` and brings it back 2 seconds after typing stops.
        tracker.record_typing(4_500);
        let p_typing = tracker.presentation_for(Some("b1"), false, 5_000);
        assert_eq!(p_typing.visual, SyncStatusVisual::BreathingCloud);
        assert!(p_typing.faded_for_typing);
        let p_settled = tracker.presentation_for(Some("b1"), false, 6_500);
        assert!(!p_settled.faded_for_typing);

        // 5. Completing a >= 3s run lingers for 1.5s then hides; ordinary
        // syncing never posts to the notification bell.
        tracker.finish_cycle_ok(Some("b1"), 7_000);
        assert!(sync_problems_of(tracker.snapshot(), 7_000).is_empty());
        assert_eq!(
            tracker.presentation_for(Some("b1"), false, 8_499).visual,
            SyncStatusVisual::BreathingCloud
        );
        assert_eq!(
            tracker.presentation_for(Some("b1"), false, 8_500).visual,
            SyncStatusVisual::Hidden
        );

        // 6. Retrying: silent before 30s, BlinkingCloud at >= 30s (with < 3 cycles),
        // does not fade while typing, offers Retry, and does not post to bell.
        let server_err = SyncError::Server {
            status: 502,
            code: None,
            message: "bad gateway".into(),
        };
        tracker.finish_cycle_err(Some("b1"), &server_err, 10_000);
        assert_eq!(
            tracker.presentation_for(Some("b1"), false, 39_999).visual,
            SyncStatusVisual::Hidden
        );
        tracker.record_typing(40_000);
        let p_retry = tracker.presentation_for(Some("b1"), false, 40_000);
        assert_eq!(p_retry.corner, Some(SyncCornerState::Retrying));
        assert_eq!(p_retry.visual, SyncStatusVisual::BlinkingCloud);
        assert!(!p_retry.faded_for_typing);
        assert_eq!(p_retry.actions, vec![SyncStatusAction::Retry]);
        assert!(sync_problems_of(tracker.snapshot(), 40_000).is_empty());

        // 7. 3 consecutive failed cycles escalates to `Problem(Failing)` ->
        // DangerExclamation (`!`) + pinned in notification bell.
        tracker.finish_cycle_err(Some("b1"), &server_err, 45_000);
        tracker.finish_cycle_err(Some("b1"), &server_err, 50_000);
        let p_failing = tracker.presentation_for(Some("b1"), false, 50_000);
        assert_eq!(
            p_failing.corner,
            Some(SyncCornerState::Problem(SyncProblem::Failing))
        );
        assert_eq!(p_failing.visual, SyncStatusVisual::DangerExclamation);
        assert_eq!(p_failing.actions, vec![SyncStatusAction::Retry]);
        assert_eq!(
            sync_problems_of(tracker.snapshot(), 50_000),
            vec![SyncProblem::Failing]
        );

        // 8. Offline shows LooseSandCloud with Retry.
        tracker.finish_cycle_ok(Some("b1"), 55_000);
        tracker.finish_cycle_err(
            Some("b1"),
            &SyncError::Offline("network unreachable".into()),
            60_000,
        );
        let p_offline = tracker.presentation_for(Some("b1"), false, 60_000);
        assert_eq!(p_offline.corner, Some(SyncCornerState::Offline));
        assert_eq!(p_offline.visual, SyncStatusVisual::LooseSandCloud);
        assert_eq!(p_offline.actions, vec![SyncStatusAction::Retry]);

        // 9. Reauth (`401`), Quota (`413`), and NotStarted all show
        // DangerExclamation (`!`) and pin in notification bell with exact actions.
        tracker.finish_cycle_err(Some("b1"), &SyncError::Unauthorized, 70_000);
        let p_reauth = tracker.presentation_for(Some("b1"), false, 70_000);
        assert_eq!(
            p_reauth.corner,
            Some(SyncCornerState::Problem(SyncProblem::Reauth))
        );
        assert_eq!(p_reauth.visual, SyncStatusVisual::DangerExclamation);
        assert_eq!(p_reauth.actions, vec![SyncStatusAction::SignIn]);
        assert_eq!(
            sync_problems_of(tracker.snapshot(), 70_000),
            vec![SyncProblem::Reauth]
        );

        tracker.finish_cycle_ok(Some("b1"), 71_000);
        tracker.finish_cycle_err(
            Some("b1"),
            &SyncError::QuotaExceeded {
                used_bytes: DEFAULT_QUOTA_BYTES + 1,
                quota_bytes: DEFAULT_QUOTA_BYTES,
                hard_limit_bytes: DEFAULT_HARD_LIMIT_BYTES,
            },
            72_000,
        );
        let p_quota = tracker.presentation_for(Some("b1"), false, 72_000);
        assert_eq!(
            p_quota.corner,
            Some(SyncCornerState::Problem(SyncProblem::Quota))
        );
        assert_eq!(p_quota.visual, SyncStatusVisual::DangerExclamation);
        assert_eq!(
            p_quota.actions,
            vec![SyncStatusAction::OpenSettings, SyncStatusAction::Retry]
        );

        tracker.finish_cycle_ok(Some("b1"), 73_000);
        tracker.set_init_failed(true, Some("failed to open sync state".into()));
        let p_not_started = tracker.presentation_for(Some("b1"), false, 74_000);
        assert_eq!(
            p_not_started.corner,
            Some(SyncCornerState::Problem(SyncProblem::NotStarted))
        );
        assert_eq!(p_not_started.visual, SyncStatusVisual::DangerExclamation);
        assert_eq!(p_not_started.actions, vec![SyncStatusAction::Retry]);
    }

    #[test]
    fn origin_validation_integrity_and_atomic_cancellation_guards() {
        // Origin and path traversal guards.
        assert!(
            validate_sync_url(
                "http://127.0.0.1:8080",
                "http://127.0.0.1:8080/api/sync/v1/usage"
            )
            .is_ok()
        );
        assert!(
            validate_sync_url(
                "http://127.0.0.1:8080",
                "http://evil.example.com:8080/api/sync/v1/usage"
            )
            .is_err()
        );
        assert!(
            validate_sync_url(
                "http://127.0.0.1:8080",
                "http://127.0.0.1:8080/api/sync/v1/loro-v2/../secret"
            )
            .is_err()
        );
        assert!(
            validate_sync_url(
                "http://user:pass@127.0.0.1:8080",
                "http://127.0.0.1:8080/api/sync/v1/usage"
            )
            .is_err()
        );

        // Atomic staging + SHA-256 verification + cancellation.
        let dir = TempDir::new().expect("dir");
        let dest = dir.path().join("staged-object.bin");
        let payload = b"verified-loro-update-payload";
        let sha = sha256_digest(payload);

        // Wrong SHA-256 must fail and leave no file.
        assert!(
            write_verified_file_atomic(
                &dest,
                payload,
                "sha256:0000",
                Some(payload.len() as u64),
                None
            )
            .is_err()
        );
        assert!(!dest.exists());

        // Cancelled transfer must fail and leave no file.
        let cancel = AtomicBool::new(true);
        assert!(matches!(
            write_verified_file_atomic(
                &dest,
                payload,
                &sha,
                Some(payload.len() as u64),
                Some(&cancel)
            ),
            Err(SyncError::Cancelled)
        ));
        assert!(!dest.exists());

        // Valid transfer writes atomically.
        cancel.store(false, Ordering::SeqCst);
        write_verified_file_atomic(
            &dest,
            payload,
            &sha,
            Some(payload.len() as u64),
            Some(&cancel),
        )
        .expect("atomic write");
        assert_eq!(fs::read(&dest).expect("read"), payload);
    }
}
