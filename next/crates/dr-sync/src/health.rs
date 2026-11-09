//! Sync status state machine (`docs/hosted-sync/sync-status.md`).
//!
//! Computes the paper-corner state, typing-settle visibility, action buttons
//! and notification-bell problems without depending on GPUI.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Busy work must run continuously for 3 seconds before the breathing cloud
/// appears on the paper corner.
pub const SYNC_MARK_SHOW_AFTER_MS: u64 = 3_000;

/// Once shown, the breathing cloud lingers for 1.5 seconds after work finishes,
/// and gaps shorter than 1.5 seconds continue the same busy run.
pub const SYNC_MARK_LINGER_MS: u64 = 1_500;

/// Typing in the editor fades out the `Syncing` cloud; it returns 2 seconds
/// after the last keystroke if sync is still busy.
pub const SYNC_MARK_TYPING_SETTLE_MS: u64 = 2_000;

/// Silent automatic retries stay invisible until failing for 30 seconds, when
/// the slow-blinking `Retrying` cloud appears.
pub const SYNC_RETRY_SHOW_AFTER_MS: u64 = 30_000;

/// Consecutive failed cycles before escalating from `Retrying` to
/// `SyncProblem::Failing`.
pub const SYNC_FAILING_CYCLES: u32 = 3;

/// Continuous failing duration (5 minutes) before escalating to
/// `SyncProblem::Failing`.
pub const SYNC_FAILING_FOR_MS: u64 = 5 * 60_000;

/// Severe sync problems that show the danger `!` seal on the paper corner and
/// pin a notice in the notification bell.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncProblem {
    /// Hosted sync failed to initialize on startup.
    NotStarted,
    /// Session token expired or was revoked (`401`); user must sign in again.
    Reauth,
    /// Cloud storage reached the soft/hard quota (`413 QUOTA_EXCEEDED`).
    Quota,
    /// Sync failed for >= 3 consecutive cycles or >= 5 minutes.
    Failing,
}

/// State of the lower-left paper corner sync mark.
///
/// When synced, paused, or in a local library, the corner state is `None`
/// (nothing is rendered).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "problem", rename_all = "snake_case")]
pub enum SyncCornerState {
    /// Actively uploading or downloading for at least 3 seconds (or within the
    /// 1.5-second completion linger window).
    Syncing,
    /// Retrying in the background for >= 30 seconds (before escalating to
    /// [`SyncProblem::Failing`]).
    Retrying,
    /// Network is offline while Hosted Sync is enabled.
    Offline,
    /// A severe problem requiring attention (`!`).
    Problem(SyncProblem),
}

/// Visual treatment of the paper-corner mark.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatusVisual {
    /// Nothing is rendered.
    Hidden,
    /// Whole cloud icon breathes (`Syncing`, upload and download alike).
    BreathingCloud,
    /// Cloud icon blinks slowly (`Retrying`).
    BlinkingCloud,
    /// Loose-sand cloud (`Offline`).
    LooseSandCloud,
    /// Danger-colored `!` seal (`Problem`).
    DangerExclamation,
}

/// Action buttons offered in the hover card and notification bell entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatusAction {
    Retry,
    SignIn,
    OpenSettings,
}

/// Return the hover-card / bell actions for a given [`SyncCornerState`].
pub fn sync_status_actions_for(state: SyncCornerState) -> Vec<SyncStatusAction> {
    match state {
        SyncCornerState::Syncing => Vec::new(),
        SyncCornerState::Problem(SyncProblem::Reauth) => vec![SyncStatusAction::SignIn],
        SyncCornerState::Problem(SyncProblem::Quota) => {
            vec![SyncStatusAction::OpenSettings, SyncStatusAction::Retry]
        }
        SyncCornerState::Problem(SyncProblem::NotStarted | SyncProblem::Failing)
        | SyncCornerState::Retrying
        | SyncCornerState::Offline => vec![SyncStatusAction::Retry],
    }
}

/// Per-book sync status snapshot.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncBookHealthSnapshot {
    pub busy: bool,
    pub busy_since_ms: Option<u64>,
    pub busy_until_ms: Option<u64>,
    pub failing_since_ms: Option<u64>,
    pub consecutive_failed_cycles: u32,
    pub last_error: Option<String>,
    pub problem: Option<SyncProblem>,
}

/// Snapshot of library-wide and per-book sync health.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncHealthSnapshot {
    pub hosted_enabled: bool,
    pub paused: bool,
    pub offline: bool,
    pub init_failed: bool,
    pub reauth_required: bool,
    pub quota_exceeded: bool,
    pub library_busy: bool,
    pub library_busy_since_ms: Option<u64>,
    pub library_busy_until_ms: Option<u64>,
    pub library_failing_since_ms: Option<u64>,
    pub library_failed_cycles: u32,
    pub last_error: Option<String>,
    pub books: BTreeMap<String, SyncBookHealthSnapshot>,
}

fn failing_escalated(
    consecutive_failed_cycles: u32,
    failing_since_ms: Option<u64>,
    now_ms: u64,
) -> bool {
    if consecutive_failed_cycles >= SYNC_FAILING_CYCLES {
        return true;
    }
    if let Some(since) = failing_since_ms
        && now_ms.saturating_sub(since) >= SYNC_FAILING_FOR_MS
    {
        return true;
    }
    false
}

fn retrying_visible(
    consecutive_failed_cycles: u32,
    failing_since_ms: Option<u64>,
    now_ms: u64,
) -> bool {
    if consecutive_failed_cycles == 0 {
        return false;
    }
    let Some(since) = failing_since_ms else {
        return false;
    };
    let elapsed = now_ms.saturating_sub(since);
    elapsed >= SYNC_RETRY_SHOW_AFTER_MS
        && !failing_escalated(consecutive_failed_cycles, failing_since_ms, now_ms)
}

fn busy_visible(
    busy: bool,
    busy_since_ms: Option<u64>,
    busy_until_ms: Option<u64>,
    now_ms: u64,
) -> bool {
    let Some(since) = busy_since_ms else {
        return false;
    };
    if busy {
        now_ms.saturating_sub(since) >= SYNC_MARK_SHOW_AFTER_MS
    } else if let Some(until) = busy_until_ms {
        now_ms < until
    } else {
        false
    }
}

fn library_level_problem(snapshot: &SyncHealthSnapshot, now_ms: u64) -> Option<SyncProblem> {
    if !snapshot.hosted_enabled || snapshot.paused {
        return None;
    }
    if snapshot.init_failed {
        return Some(SyncProblem::NotStarted);
    }
    if snapshot.reauth_required {
        return Some(SyncProblem::Reauth);
    }
    if snapshot.quota_exceeded {
        return Some(SyncProblem::Quota);
    }
    if !snapshot.offline
        && failing_escalated(
            snapshot.library_failed_cycles,
            snapshot.library_failing_since_ms,
            now_ms,
        )
    {
        return Some(SyncProblem::Failing);
    }
    None
}

/// Compute the corner state for `book_id` at `now_ms`.
///
/// Precedence: `Problem` > `Offline` > `Retrying` > `Syncing` > `None`.
pub fn sync_corner_for(
    snapshot: &SyncHealthSnapshot,
    book_id: Option<&str>,
    now_ms: u64,
) -> Option<SyncCornerState> {
    if !snapshot.hosted_enabled || snapshot.paused {
        return None;
    }
    if let Some(problem) = library_level_problem(snapshot, now_ms) {
        return Some(SyncCornerState::Problem(problem));
    }
    let book = book_id.and_then(|id| snapshot.books.get(id));
    if let Some(b) = book {
        if let Some(problem) = b.problem {
            return Some(SyncCornerState::Problem(problem));
        }
        if !snapshot.offline
            && failing_escalated(b.consecutive_failed_cycles, b.failing_since_ms, now_ms)
        {
            return Some(SyncCornerState::Problem(SyncProblem::Failing));
        }
    }
    if snapshot.offline {
        return Some(SyncCornerState::Offline);
    }
    if retrying_visible(
        snapshot.library_failed_cycles,
        snapshot.library_failing_since_ms,
        now_ms,
    ) || book
        .is_some_and(|b| retrying_visible(b.consecutive_failed_cycles, b.failing_since_ms, now_ms))
    {
        return Some(SyncCornerState::Retrying);
    }
    if busy_visible(
        snapshot.library_busy,
        snapshot.library_busy_since_ms,
        snapshot.library_busy_until_ms,
        now_ms,
    ) || book.is_some_and(|b| busy_visible(b.busy, b.busy_since_ms, b.busy_until_ms, now_ms))
    {
        return Some(SyncCornerState::Syncing);
    }
    None
}

/// Compute the library-wide corner state (used when no single book is focused).
pub fn sync_library_corner_for(
    snapshot: &SyncHealthSnapshot,
    now_ms: u64,
) -> Option<SyncCornerState> {
    if !snapshot.hosted_enabled || snapshot.paused {
        return None;
    }
    if let Some(problem) = library_level_problem(snapshot, now_ms) {
        return Some(SyncCornerState::Problem(problem));
    }
    for b in snapshot.books.values() {
        if let Some(problem) = b.problem {
            return Some(SyncCornerState::Problem(problem));
        }
        if !snapshot.offline
            && failing_escalated(b.consecutive_failed_cycles, b.failing_since_ms, now_ms)
        {
            return Some(SyncCornerState::Problem(SyncProblem::Failing));
        }
    }
    if snapshot.offline {
        return Some(SyncCornerState::Offline);
    }
    if retrying_visible(
        snapshot.library_failed_cycles,
        snapshot.library_failing_since_ms,
        now_ms,
    ) || snapshot
        .books
        .values()
        .any(|b| retrying_visible(b.consecutive_failed_cycles, b.failing_since_ms, now_ms))
    {
        return Some(SyncCornerState::Retrying);
    }
    if busy_visible(
        snapshot.library_busy,
        snapshot.library_busy_since_ms,
        snapshot.library_busy_until_ms,
        now_ms,
    ) || snapshot
        .books
        .values()
        .any(|b| busy_visible(b.busy, b.busy_since_ms, b.busy_until_ms, now_ms))
    {
        return Some(SyncCornerState::Syncing);
    }
    None
}

/// Return all active severe [`SyncProblem`]s that should be pinned in the
/// notification bell (`dr_shell::notifications::Source::Sync`).
///
/// Ordinary uploads/downloads (`Syncing`), silent retries (`Retrying`) and
/// `Offline` do not post to the notification bell.
pub fn sync_problems_of(snapshot: &SyncHealthSnapshot, now_ms: u64) -> Vec<SyncProblem> {
    if !snapshot.hosted_enabled || snapshot.paused {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut push_unique = |p: SyncProblem| {
        if !out.contains(&p) {
            out.push(p);
        }
    };
    if let Some(problem) = library_level_problem(snapshot, now_ms) {
        push_unique(problem);
    }
    for b in snapshot.books.values() {
        if let Some(p) = b.problem {
            push_unique(p);
        } else if !snapshot.offline
            && failing_escalated(b.consecutive_failed_cycles, b.failing_since_ms, now_ms)
        {
            push_unique(SyncProblem::Failing);
        }
    }
    out
}

/// Complete presentation state for the lower-left paper sync mark.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaperSyncMarkPresentation {
    pub corner: Option<SyncCornerState>,
    pub visual: SyncStatusVisual,
    pub faded_for_typing: bool,
    pub actions: Vec<SyncStatusAction>,
}

/// Evaluate how the paper corner sync mark should render on a paper pane:
/// - In split view, the trailing (right) pane never shows the mark.
/// - Local libraries (`!hosted_enabled`) never show the mark.
/// - While typing (`now_ms - last_typing_ms < 2_000`), `Syncing` fades out,
///   whereas `Problem`, `Offline` and `Retrying` remain visible.
pub fn evaluate_paper_sync_mark(
    snapshot: &SyncHealthSnapshot,
    book_id: Option<&str>,
    is_trailing_pane: bool,
    last_typing_ms: Option<u64>,
    now_ms: u64,
) -> PaperSyncMarkPresentation {
    if is_trailing_pane || !snapshot.hosted_enabled || snapshot.paused {
        return PaperSyncMarkPresentation {
            corner: None,
            visual: SyncStatusVisual::Hidden,
            faded_for_typing: false,
            actions: Vec::new(),
        };
    }
    let corner = sync_corner_for(snapshot, book_id, now_ms);
    let Some(state) = corner else {
        return PaperSyncMarkPresentation {
            corner: None,
            visual: SyncStatusVisual::Hidden,
            faded_for_typing: false,
            actions: Vec::new(),
        };
    };
    let typing_active =
        last_typing_ms.is_some_and(|t| now_ms.saturating_sub(t) < SYNC_MARK_TYPING_SETTLE_MS);
    let faded_for_typing = matches!(state, SyncCornerState::Syncing) && typing_active;
    let visual = match state {
        SyncCornerState::Syncing => SyncStatusVisual::BreathingCloud,
        SyncCornerState::Retrying => SyncStatusVisual::BlinkingCloud,
        SyncCornerState::Offline => SyncStatusVisual::LooseSandCloud,
        SyncCornerState::Problem(_) => SyncStatusVisual::DangerExclamation,
    };
    let actions = sync_status_actions_for(state);
    PaperSyncMarkPresentation {
        corner: Some(state),
        visual,
        faded_for_typing,
        actions,
    }
}

/// Stateful tracker that updates [`SyncHealthSnapshot`] over time as transfers,
/// keystrokes and sync cycles occur.
#[derive(Clone, Debug, Default)]
pub struct SyncHealthTracker {
    snapshot: SyncHealthSnapshot,
    last_typing_ms: Option<u64>,
}

impl SyncHealthTracker {
    pub fn new(hosted_enabled: bool) -> Self {
        Self {
            snapshot: SyncHealthSnapshot {
                hosted_enabled,
                ..SyncHealthSnapshot::default()
            },
            last_typing_ms: None,
        }
    }

    pub fn snapshot(&self) -> &SyncHealthSnapshot {
        &self.snapshot
    }

    pub fn set_hosted_enabled(&mut self, enabled: bool) {
        self.snapshot.hosted_enabled = enabled;
        if !enabled {
            self.snapshot.library_busy = false;
            self.snapshot.library_busy_since_ms = None;
            self.snapshot.library_busy_until_ms = None;
            self.snapshot.books.clear();
        }
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.snapshot.paused = paused;
    }

    pub fn set_offline(&mut self, offline: bool) {
        self.snapshot.offline = offline;
    }

    pub fn set_init_failed(&mut self, failed: bool, message: Option<String>) {
        self.snapshot.init_failed = failed;
        if failed {
            self.snapshot.last_error = message;
        }
    }

    /// Record an editor keystroke at `now_ms`.
    pub fn record_typing(&mut self, now_ms: u64) {
        self.last_typing_ms = Some(now_ms);
    }

    pub fn last_typing_ms(&self) -> Option<u64> {
        self.last_typing_ms
    }

    /// Mark library or book sync work as started at `now_ms`.
    ///
    /// If work resumes within [`SYNC_MARK_LINGER_MS`] of a previous run that had
    /// already become visible (or was accumulating), it continues the same
    /// `busy_since_ms` timestamp so short gaps between uploads/downloads do not
    /// reset the 3-second timer or flicker the cloud.
    pub fn begin_cycle(&mut self, book_id: Option<&str>, now_ms: u64) {
        if let Some(id) = book_id {
            let entry = self.snapshot.books.entry(id.to_string()).or_default();
            let keep_since = entry.busy_until_ms.is_some_and(|until| now_ms <= until)
                || (entry.busy && entry.busy_since_ms.is_some());
            if !keep_since || entry.busy_since_ms.is_none() {
                entry.busy_since_ms = Some(now_ms);
            }
            entry.busy = true;
            entry.busy_until_ms = None;
        } else {
            let keep_since = self
                .snapshot
                .library_busy_until_ms
                .is_some_and(|until| now_ms <= until)
                || (self.snapshot.library_busy && self.snapshot.library_busy_since_ms.is_some());
            if !keep_since || self.snapshot.library_busy_since_ms.is_none() {
                self.snapshot.library_busy_since_ms = Some(now_ms);
            }
            self.snapshot.library_busy = true;
            self.snapshot.library_busy_until_ms = None;
        }
    }

    /// Mark a sync cycle as succeeded at `now_ms`.
    pub fn finish_cycle_ok(&mut self, book_id: Option<&str>, now_ms: u64) {
        self.snapshot.reauth_required = false;
        self.snapshot.quota_exceeded = false;
        self.snapshot.init_failed = false;
        self.snapshot.offline = false;
        self.snapshot.last_error = None;

        if let Some(id) = book_id {
            let entry = self.snapshot.books.entry(id.to_string()).or_default();
            let was_shown = entry
                .busy_since_ms
                .is_some_and(|since| now_ms.saturating_sub(since) >= SYNC_MARK_SHOW_AFTER_MS);
            entry.busy = false;
            if was_shown {
                entry.busy_until_ms = Some(now_ms + SYNC_MARK_LINGER_MS);
            } else {
                entry.busy_since_ms = None;
                entry.busy_until_ms = None;
            }
            entry.failing_since_ms = None;
            entry.consecutive_failed_cycles = 0;
            entry.last_error = None;
            entry.problem = None;
        } else {
            let was_shown = self
                .snapshot
                .library_busy_since_ms
                .is_some_and(|since| now_ms.saturating_sub(since) >= SYNC_MARK_SHOW_AFTER_MS);
            self.snapshot.library_busy = false;
            if was_shown {
                self.snapshot.library_busy_until_ms = Some(now_ms + SYNC_MARK_LINGER_MS);
            } else {
                self.snapshot.library_busy_since_ms = None;
                self.snapshot.library_busy_until_ms = None;
            }
            self.snapshot.library_failing_since_ms = None;
            self.snapshot.library_failed_cycles = 0;
        }
    }

    /// Record a failed sync cycle at `now_ms`.
    pub fn finish_cycle_err(
        &mut self,
        book_id: Option<&str>,
        err: &crate::protocol::SyncError,
        now_ms: u64,
    ) {
        if let Some(id) = book_id {
            let entry = self.snapshot.books.entry(id.to_string()).or_default();
            entry.busy = false;
            entry.busy_since_ms = None;
            entry.busy_until_ms = None;
        } else {
            self.snapshot.library_busy = false;
            self.snapshot.library_busy_since_ms = None;
            self.snapshot.library_busy_until_ms = None;
        }

        self.snapshot.last_error = Some(err.to_string());
        if err.is_unauthorized() {
            self.snapshot.reauth_required = true;
            return;
        }
        if err.is_quota_exceeded() {
            self.snapshot.quota_exceeded = true;
            return;
        }
        if err.is_offline() {
            self.snapshot.offline = true;
        }

        if let Some(id) = book_id {
            let entry = self.snapshot.books.entry(id.to_string()).or_default();
            if entry.failing_since_ms.is_none() {
                entry.failing_since_ms = Some(now_ms);
            }
            entry.consecutive_failed_cycles = entry.consecutive_failed_cycles.saturating_add(1);
            entry.last_error = Some(err.to_string());
            if failing_escalated(
                entry.consecutive_failed_cycles,
                entry.failing_since_ms,
                now_ms,
            ) {
                entry.problem = Some(SyncProblem::Failing);
            }
        } else {
            if self.snapshot.library_failing_since_ms.is_none() {
                self.snapshot.library_failing_since_ms = Some(now_ms);
            }
            self.snapshot.library_failed_cycles =
                self.snapshot.library_failed_cycles.saturating_add(1);
        }
    }

    /// Evaluate the paper-corner presentation for `book_id` at `now_ms`.
    pub fn presentation_for(
        &self,
        book_id: Option<&str>,
        is_trailing_pane: bool,
        now_ms: u64,
    ) -> PaperSyncMarkPresentation {
        evaluate_paper_sync_mark(
            &self.snapshot,
            book_id,
            is_trailing_pane,
            self.last_typing_ms,
            now_ms,
        )
    }
}
