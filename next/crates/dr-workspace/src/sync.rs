//! Sync status query (`sync.status`), manual trigger (`sync.now`) and
//! coordinator controller hook on [`crate::Workspace`].
//!
//! Dispatched directly by [`crate::Workspace::call`] without altering the
//! static Agent tool capability registry (`crate::registry`).

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// Snapshot returned by `Workspace::sync_status` and `sync.status`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncStatusSnapshot {
    pub mode: String,
    pub hosted_enabled: bool,
    pub paused: bool,
    pub offline: bool,
    pub reauth_required: bool,
    pub quota_exceeded: bool,
    pub busy: bool,
    pub cursor: u64,
    pub completed_cycles: u64,
    pub consecutive_failures: u32,
    pub last_sync_ok_ms: Option<u64>,
    pub last_error: Option<String>,
    pub pending_docs: usize,
    pub pending_assets: usize,
    pub pending_purges: usize,
    pub blocked_on_open_doc: bool,
}

impl Default for SyncStatusSnapshot {
    fn default() -> Self {
        Self {
            mode: "local_only".into(),
            hosted_enabled: false,
            paused: false,
            offline: false,
            reauth_required: false,
            quota_exceeded: false,
            busy: false,
            cursor: 0,
            completed_cycles: 0,
            consecutive_failures: 0,
            last_sync_ok_ms: None,
            last_error: None,
            pending_docs: 0,
            pending_assets: 0,
            pending_purges: 0,
            blocked_on_open_doc: false,
        }
    }
}

/// Summary returned by `Workspace::sync_now` and `sync.now`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncNowOutput {
    pub uploaded_docs: usize,
    pub uploaded_assets: usize,
    pub uploaded_purges: usize,
    pub downloaded_docs: usize,
    pub downloaded_assets: usize,
    pub applied_purges: usize,
    pub cursor: u64,
}

/// Runtime sync controller attached to a [`crate::Workspace`] by the app or
/// sync harness.
pub trait SyncController: Send + Sync {
    fn status(&self) -> SyncStatusSnapshot;
    fn sync_now(&self) -> Result<SyncNowOutput>;
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::{Actor, Workspace, WorkspaceOptions, library_options};

    #[test]
    fn check_book_revision_freshness_detects_superseded_and_behind_live_frontiers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = dr_store::Library::open(dir.path(), library_options("test")).expect("store");
        let ws = Workspace::open(store, WorkspaceOptions::default()).expect("workspace");
        let created = ws
            .call(
                &Actor::User,
                "project.create",
                json!({ "name": "RevCheck" }),
            )
            .expect("create book");
        let book_id = created["output"]["id"].as_str().expect("book id");

        let rev1 = ws
            .read_book_v3(book_id, |_, version| Ok(version))
            .expect("rev1");
        ws.call(
            &Actor::User,
            "book.update",
            json!({ "book": book_id, "name": "RevCheck 2" }),
        )
        .expect("rename 1");
        let rev2 = ws
            .read_book_v3(book_id, |_, version| Ok(version))
            .expect("rev2");
        assert_ne!(rev1, rev2);

        // `rev1` is strictly older than `rev2`, while `rev2` matches live (`behind_live == false`).
        assert_eq!(
            ws.check_book_revision_freshness(book_id, &rev1, Some(&rev2))
                .expect("freshness rev1 vs rev2"),
            (true, false)
        );
        // `rev2` vs `rev2` is not strictly older and matches live.
        assert_eq!(
            ws.check_book_revision_freshness(book_id, &rev2, Some(&rev2))
                .expect("freshness rev2 vs rev2"),
            (false, false)
        );

        ws.call(
            &Actor::User,
            "book.update",
            json!({ "book": book_id, "name": "RevCheck 3" }),
        )
        .expect("rename 2");
        // Now `rev2` is behind live (`rev3`), while `rev1` is strictly older than `rev2` AND `rev2` is behind live.
        assert_eq!(
            ws.check_book_revision_freshness(book_id, &rev1, Some(&rev2))
                .expect("freshness rev1 vs rev2 behind rev3"),
            (true, true)
        );
        assert_eq!(
            ws.check_book_revision_freshness(book_id, &rev2, Some(&rev1))
                .expect("freshness rev2 vs rev1 behind rev3"),
            (false, true)
        );
    }
}
