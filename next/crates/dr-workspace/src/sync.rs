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
