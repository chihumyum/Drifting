//! The sync part of the sanitized diagnostic summary feedback can attach
//! (M39: `dr_platform::diagnostics::SyncSnapshot`), from the runtime's
//! [`SyncRuntimeSnapshot`].
//!
//! The summary keeps the 0.1 client's keys, which the service and the
//! operator console parse; this decides which state of the new runtime each
//! one shows (docs/rust-rewrite/modules/m39-feedback.md, 「摘要里的同步」):
//!
//! - a library that does not sync (local only, signed out) is exactly
//!   [`SyncSnapshot::local`], as before;
//! - an account library is `hosted`: `cloud-attention` while the runtime has
//!   a problem the author must act on (not started, re-auth, quota, failing,
//!   a book's own problem), `cloud-paused` while paused, else `cloud-ready`;
//! - only counts, flags and stable codes go in ([`SyncError::code`] and the
//!   `CODE_*` here), never `last_error`'s text, a book id or a path.
//!
//! [`SyncError::code`]: crate::protocol::SyncError::code

use dr_platform::diagnostics::{Pending, SyncSnapshot};

use crate::health::{
    SyncBookHealthSnapshot, SyncHealthSnapshot, SyncProblem, failing_escalated, sync_problems_of,
};
use crate::runtime::SyncRuntimeSnapshot;

/// Hosted sync did not start (the engine could not be made).
pub const CODE_NOT_STARTED: &str = "sync.not-started";
/// The session expired or was revoked: the author must sign in again.
pub const CODE_REAUTH_REQUIRED: &str = "sync.reauth-required";
/// The account's cloud storage is full.
pub const CODE_QUOTA_EXCEEDED: &str = "sync.quota-exceeded";
/// The server could not be reached, or the account is offline.
pub const CODE_OFFLINE: &str = "sync.offline";
/// Sync failed three cycles in a row, or for five minutes.
pub const CODE_FAILING: &str = "sync.failing";

/// The code for a problem the author must act on.
pub fn problem_code(problem: SyncProblem) -> &'static str {
    match problem {
        SyncProblem::NotStarted => CODE_NOT_STARTED,
        SyncProblem::Reauth => CODE_REAUTH_REQUIRED,
        SyncProblem::Quota => CODE_QUOTA_EXCEEDED,
        SyncProblem::Failing => CODE_FAILING,
    }
}

/// The summary's sync part for `snapshot` at `now_ms`.
///
/// `session_checking`: the open library is the account's and its session is
/// still being checked at startup, while the runtime waits signed out; the
/// summary then says `loading` (0.1's word for "not known yet") instead of a
/// wrong `local`.
pub fn diagnostics_snapshot(
    snapshot: &SyncRuntimeSnapshot,
    session_checking: bool,
    now_ms: u64,
) -> SyncSnapshot {
    let health = &snapshot.health;
    if !health.hosted_enabled {
        if session_checking {
            return SyncSnapshot {
                authority_status: "loading".into(),
                provider_mode: "hosted".into(),
                ..SyncSnapshot::local()
            };
        }
        return SyncSnapshot::local();
    }

    let book_in_attention = |book: &SyncBookHealthSnapshot| {
        book.problem.is_some()
            || (!health.offline
                && failing_escalated(
                    book.consecutive_failed_cycles,
                    book.failing_since_ms,
                    now_ms,
                ))
    };
    let books = health.books.len() as u64;
    let (ready, paused, attention) = if health.paused {
        (0, books, 0)
    } else {
        let attention = health
            .books
            .values()
            .filter(|b| book_in_attention(b))
            .count() as u64;
        (books - attention, 0, attention)
    };

    let authority_status = if sync_problems_of(health, now_ms).is_empty() {
        if health.paused {
            "cloud-paused"
        } else {
            "cloud-ready"
        }
    } else {
        "cloud-attention"
    };

    let library_failed = health.last_error.is_some() && !health.init_failed;
    let books_failed = health
        .books
        .values()
        .filter(|b| b.last_error.is_some())
        .count() as u64;

    SyncSnapshot {
        authority_status: authority_status.into(),
        provider_mode: "hosted".into(),
        active_projects: books,
        ready_projects: ready,
        provisioning_projects: 0,
        paused_projects: paused,
        attention_projects: attention,
        runtime_mounted: snapshot.attached,
        online: snapshot.attached.then_some(!health.offline),
        suspended: snapshot.attached.then_some(health.paused),
        pending: Pending {
            change_sets: (snapshot.pending_docs + snapshot.pending_purges) as u64,
            segments: 0,
            transfers: snapshot.pending_assets as u64,
            gaps: 0,
            conflicts: 0,
            quarantined: 0,
            failed: u64::from(library_failed) + books_failed,
        },
        error_codes: error_codes(health, now_ms),
    }
}

fn error_codes(health: &SyncHealthSnapshot, now_ms: u64) -> Vec<String> {
    let mut codes: Vec<String> = Vec::new();
    let flags = [
        (health.init_failed, CODE_NOT_STARTED),
        (health.reauth_required, CODE_REAUTH_REQUIRED),
        (health.quota_exceeded, CODE_QUOTA_EXCEEDED),
        (health.offline, CODE_OFFLINE),
        (
            !health.offline
                && failing_escalated(
                    health.library_failed_cycles,
                    health.library_failing_since_ms,
                    now_ms,
                ),
            CODE_FAILING,
        ),
    ];
    codes.extend(
        flags
            .into_iter()
            .filter(|(on, _)| *on)
            .map(|(_, code)| code.to_owned()),
    );
    for book in health.books.values() {
        if let Some(problem) = book.problem {
            codes.push(problem_code(problem).to_owned());
        } else if !health.offline
            && failing_escalated(
                book.consecutive_failed_cycles,
                book.failing_since_ms,
                now_ms,
            )
        {
            codes.push(CODE_FAILING.to_owned());
        }
    }
    codes.extend(health.last_error_code.clone());
    codes.sort();
    codes.dedup();
    codes
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{Duration, UNIX_EPOCH};

    use dr_platform::diagnostics::{SummaryInput, summary};
    use dr_platform::sanitize;

    use super::*;
    use crate::health::{SYNC_FAILING_FOR_MS, SyncHealthTracker};
    use crate::protocol::SyncError;
    use crate::runtime::SyncSessionMode;

    // Synthetic prose and paths, never a real manuscript or library.
    const MANUSCRIPT: &str = "他推开门的时候，雨已经停了，街上只剩下潮湿的灯光。";
    const PATH: &str = "/Users/example/Library/Drifting/library/书稿.sqlite";
    const NOW: u64 = 1_793_433_600_000;

    fn input(sync: SyncSnapshot) -> SummaryInput {
        let mut input = SummaryInput::current("0.2.0-dev");
        input.app.platform = "macos".into();
        input.app.architecture = "aarch64".into();
        input.generated_at = UNIX_EPOCH + Duration::from_millis(NOW);
        input.sync = sync;
        input
    }

    /// What the runtime publishes for a mode it does not attach an engine
    /// to (as `build_inactive_snapshot` makes it).
    fn inactive(mode: &SyncSessionMode, tracker: &SyncHealthTracker) -> SyncRuntimeSnapshot {
        SyncRuntimeSnapshot {
            mode: mode.mode_name().to_owned(),
            health: tracker.snapshot().clone(),
            ..SyncRuntimeSnapshot::default()
        }
    }

    /// An attached, signed-in generation whose engine's tracker is `tracker`.
    fn attached(tracker: &SyncHealthTracker) -> SyncRuntimeSnapshot {
        SyncRuntimeSnapshot {
            mode: "connected".into(),
            attached: true,
            health: tracker.snapshot().clone(),
            completed_cycles: 1,
            ..SyncRuntimeSnapshot::default()
        }
    }

    fn connected_tracker() -> SyncHealthTracker {
        let mut tracker = SyncHealthTracker::new(true);
        tracker.begin_cycle(None, NOW - 10_000);
        tracker.finish_cycle_ok(None, NOW - 9_000);
        tracker
    }

    fn server_error(status: u16) -> SyncError {
        SyncError::Server {
            status,
            code: Some("UPSTREAM".into()),
            message: MANUSCRIPT.into(),
        }
    }

    fn root() -> PathBuf {
        PathBuf::from(PATH)
    }

    #[test]
    fn a_library_that_does_not_sync_is_summarised_exactly_as_before() {
        let today = summary(&input(SyncSnapshot::local()));
        for mode in [SyncSessionMode::LocalOnly, SyncSessionMode::SignedOut] {
            let tracker = SyncHealthTracker::new(mode.hosted_enabled());
            let sync = diagnostics_snapshot(&inactive(&mode, &tracker), false, NOW);
            assert_eq!(sync, SyncSnapshot::local(), "{mode:?}");
            assert_eq!(summary(&input(sync)), today, "{mode:?}");
        }
        // The runtime as it starts, before anything configures it.
        let sync = diagnostics_snapshot(&SyncRuntimeSnapshot::default(), false, NOW);
        assert_eq!(summary(&input(sync)), today);
    }

    #[test]
    fn a_session_still_being_checked_is_loading_not_local() {
        let tracker = SyncHealthTracker::new(false);
        let sync =
            diagnostics_snapshot(&inactive(&SyncSessionMode::SignedOut, &tracker), true, NOW);
        assert_eq!(
            sync,
            SyncSnapshot {
                authority_status: "loading".into(),
                provider_mode: "hosted".into(),
                ..SyncSnapshot::local()
            }
        );
        // Once the runtime syncs, the runtime's state is what counts.
        let sync = diagnostics_snapshot(&attached(&connected_tracker()), true, NOW);
        assert_eq!(sync.authority_status, "cloud-ready");
    }

    #[test]
    fn a_healthy_account_library_is_hosted_and_ready_with_its_pending_counts() {
        let mut snapshot = attached(&connected_tracker());
        snapshot.pending_docs = 3;
        snapshot.pending_purges = 2;
        snapshot.pending_assets = 4;
        // Busy is not a problem.
        snapshot.health.library_busy = true;
        snapshot.health.library_busy_since_ms = Some(NOW - 5_000);
        let sync = diagnostics_snapshot(&snapshot, false, NOW);
        assert_eq!(
            sync,
            SyncSnapshot {
                authority_status: "cloud-ready".into(),
                provider_mode: "hosted".into(),
                active_projects: 0,
                ready_projects: 0,
                provisioning_projects: 0,
                paused_projects: 0,
                attention_projects: 0,
                runtime_mounted: true,
                online: Some(true),
                suspended: Some(false),
                pending: Pending {
                    change_sets: 5,
                    segments: 0,
                    transfers: 4,
                    gaps: 0,
                    conflicts: 0,
                    quarantined: 0,
                    failed: 0,
                },
                error_codes: Vec::new(),
            }
        );
        let value: serde_json::Value = serde_json::from_str(&summary(&input(sync))).unwrap();
        assert_eq!(value["sync"]["providerMode"], "hosted");
        assert_eq!(value["sync"]["pending"]["changeSets"], 5);
        assert_eq!(value["sync"]["pending"]["transfers"], 4);
    }

    #[test]
    fn re_auth_shows_whether_it_came_from_a_cycle_or_from_the_session() {
        // A cycle was refused (401) while the engine was attached.
        let mut tracker = connected_tracker();
        tracker.finish_cycle_err(None, &SyncError::Unauthorized, NOW);
        let sync = diagnostics_snapshot(&attached(&tracker), false, NOW);
        assert_eq!(sync.authority_status, "cloud-attention");
        assert!(sync.runtime_mounted);
        assert_eq!(sync.online, Some(true));
        assert_eq!(sync.pending.failed, 1);
        assert_eq!(sync.error_codes, [CODE_REAUTH_REQUIRED]);

        // The account then needs a new sign-in; no engine runs.
        let mode = SyncSessionMode::NeedsReauth {
            library_root: root(),
        };
        let mut tracker = SyncHealthTracker::new(mode.hosted_enabled());
        tracker.set_reauth_required(true);
        let sync = diagnostics_snapshot(&inactive(&mode, &tracker), false, NOW);
        assert_eq!(sync.authority_status, "cloud-attention");
        assert_eq!(sync.provider_mode, "hosted");
        assert!(!sync.runtime_mounted);
        assert_eq!((sync.online, sync.suspended), (None, None));
        assert_eq!(sync.pending, Pending::default());
        assert_eq!(sync.error_codes, [CODE_REAUTH_REQUIRED]);
    }

    #[test]
    fn a_full_quota_needs_attention() {
        let mut tracker = connected_tracker();
        tracker.finish_cycle_err(
            None,
            &SyncError::QuotaExceeded {
                used_bytes: 600,
                quota_bytes: 500,
                hard_limit_bytes: 1_000,
            },
            NOW,
        );
        let sync = diagnostics_snapshot(&attached(&tracker), false, NOW);
        assert_eq!(sync.authority_status, "cloud-attention");
        assert_eq!(sync.pending.failed, 1);
        assert_eq!(sync.error_codes, [CODE_QUOTA_EXCEEDED]);
    }

    #[test]
    fn offline_is_ready_but_not_online() {
        // The server could not be reached by an attached engine.
        let mut tracker = connected_tracker();
        tracker.finish_cycle_err(None, &SyncError::Offline(PATH.into()), NOW);
        let sync = diagnostics_snapshot(&attached(&tracker), false, NOW);
        assert_eq!(sync.authority_status, "cloud-ready");
        assert_eq!(sync.online, Some(false));
        assert_eq!(sync.pending.failed, 1);
        assert_eq!(sync.error_codes, [CODE_OFFLINE]);

        // The account itself is offline: no engine runs.
        let mode = SyncSessionMode::OfflineAccount {
            library_root: root(),
        };
        let mut tracker = SyncHealthTracker::new(mode.hosted_enabled());
        tracker.set_offline(true);
        let sync = diagnostics_snapshot(&inactive(&mode, &tracker), false, NOW);
        assert_eq!(sync.authority_status, "cloud-ready");
        assert_eq!(sync.provider_mode, "hosted");
        assert!(!sync.runtime_mounted);
        assert_eq!(sync.online, None);
        assert_eq!(sync.pending.failed, 0);
        assert_eq!(sync.error_codes, [CODE_OFFLINE]);

        // Offline for a long time is still offline, not failing.
        let mut tracker = connected_tracker();
        for at in [NOW - SYNC_FAILING_FOR_MS - 1, NOW - 2, NOW - 1] {
            tracker.finish_cycle_err(None, &SyncError::Offline("x".into()), at);
        }
        let sync = diagnostics_snapshot(&attached(&tracker), false, NOW);
        assert_eq!(sync.authority_status, "cloud-ready");
        assert_eq!(sync.error_codes, [CODE_OFFLINE]);
    }

    #[test]
    fn a_sync_that_could_not_start_needs_attention_and_names_why() {
        let mode = SyncSessionMode::Connected {
            base_url: "https://sync.invalid".into(),
            user_id: "u_synthetic".into(),
            access_token: "synthetic-token".into(),
            library_root: root(),
        };
        let mut tracker = SyncHealthTracker::new(mode.hosted_enabled());
        tracker.record_init_failure(&SyncError::InvalidOrigin(PATH.into()));
        let sync = diagnostics_snapshot(&inactive(&mode, &tracker), false, NOW);
        assert_eq!(sync.authority_status, "cloud-attention");
        assert!(!sync.runtime_mounted);
        assert_eq!(sync.pending.failed, 0, "no cycle ran");
        assert_eq!(sync.error_codes, ["sync.invalid-origin", CODE_NOT_STARTED]);
    }

    #[test]
    fn failing_escalates_after_three_cycles_or_five_minutes() {
        let mut tracker = connected_tracker();
        tracker.finish_cycle_err(None, &server_error(503), NOW - 2);
        let sync = diagnostics_snapshot(&attached(&tracker), false, NOW);
        assert_eq!(
            sync.authority_status, "cloud-ready",
            "one failure is a retry"
        );
        assert_eq!(sync.pending.failed, 1);
        assert_eq!(sync.error_codes, ["sync.http-503"]);

        tracker.finish_cycle_err(None, &server_error(502), NOW - 1);
        tracker.finish_cycle_err(None, &server_error(502), NOW);
        let sync = diagnostics_snapshot(&attached(&tracker), false, NOW);
        assert_eq!(sync.authority_status, "cloud-attention");
        assert_eq!(sync.pending.failed, 1, "one library, however many cycles");
        assert_eq!(sync.error_codes, [CODE_FAILING, "sync.http-502"]);

        // One failure, five minutes ago.
        let mut tracker = connected_tracker();
        tracker.finish_cycle_err(None, &server_error(500), NOW - SYNC_FAILING_FOR_MS);
        let sync = diagnostics_snapshot(&attached(&tracker), false, NOW);
        assert_eq!(sync.authority_status, "cloud-attention");
        assert_eq!(sync.error_codes, [CODE_FAILING, "sync.http-500"]);

        // A good cycle clears it all.
        tracker.finish_cycle_ok(None, NOW);
        let sync = diagnostics_snapshot(&attached(&tracker), false, NOW);
        assert_eq!(sync.authority_status, "cloud-ready");
        assert_eq!(sync.pending.failed, 0);
        assert!(sync.error_codes.is_empty());
    }

    #[test]
    fn paused_is_suspended_and_counts_its_books_as_paused() {
        let mut tracker = connected_tracker();
        tracker.finish_cycle_ok(Some("b1"), NOW);
        tracker.finish_cycle_ok(Some("b2"), NOW);
        tracker.set_paused(true);
        let sync = diagnostics_snapshot(&attached(&tracker), false, NOW);
        assert_eq!(sync.authority_status, "cloud-paused");
        assert_eq!(sync.suspended, Some(true));
        assert_eq!(sync.online, Some(true));
        assert_eq!(
            (
                sync.active_projects,
                sync.ready_projects,
                sync.paused_projects,
                sync.attention_projects
            ),
            (2, 0, 2, 0)
        );
        assert!(sync.error_codes.is_empty());
    }

    #[test]
    fn books_in_attention_are_counted_and_coded() {
        let mut tracker = connected_tracker();
        tracker.finish_cycle_ok(Some("b-ok"), NOW - 3);
        for at in [NOW - 3, NOW - 2, NOW - 1] {
            tracker.finish_cycle_err(Some("b-failing"), &server_error(503), at);
        }
        // One failure only: a retry, not attention, but its last cycle failed.
        tracker.finish_cycle_err(Some("b-retrying"), &SyncError::Cancelled, NOW);
        tracker.finish_cycle_ok(None, NOW);
        let sync = diagnostics_snapshot(&attached(&tracker), false, NOW);
        assert_eq!(sync.authority_status, "cloud-attention");
        assert_eq!(
            (
                sync.active_projects,
                sync.ready_projects,
                sync.paused_projects,
                sync.attention_projects,
                sync.provisioning_projects
            ),
            (3, 2, 0, 1, 0)
        );
        assert_eq!(
            sync.pending.failed, 2,
            "the two books whose last cycle failed"
        );
        assert_eq!(sync.error_codes, [CODE_FAILING]);

        // A book's own problem has its own code.
        let mut tracker = connected_tracker();
        tracker.finish_cycle_ok(Some("b1"), NOW);
        let mut snapshot = attached(&tracker);
        snapshot.health.books.get_mut("b1").unwrap().problem = Some(SyncProblem::Quota);
        let sync = diagnostics_snapshot(&snapshot, false, NOW);
        assert_eq!(sync.attention_projects, 1);
        assert_eq!(sync.error_codes, [CODE_QUOTA_EXCEEDED]);
    }

    #[test]
    fn every_failure_kind_has_a_plain_code_without_its_text() {
        let errors = [
            SyncError::InvalidOrigin(PATH.into()),
            SyncError::InvalidPath(PATH.into()),
            SyncError::IntegrityMismatch {
                expected: MANUSCRIPT.into(),
                actual: PATH.into(),
            },
            SyncError::ObjectTooLarge { size: 9, limit: 1 },
            SyncError::Cancelled,
            SyncError::Unauthorized,
            SyncError::QuotaExceeded {
                used_bytes: 2,
                quota_bytes: 1,
                hard_limit_bytes: 3,
            },
            SyncError::Offline(PATH.into()),
            server_error(503),
            SyncError::MissingDependencies {
                doc_id: "doc-书稿".into(),
                seq: 7,
            },
            SyncError::Store(dr_store::StoreError::AlreadyOpen("doc-书稿".into())),
            SyncError::Store(dr_store::StoreError::Io(std::io::Error::other(PATH))),
            SyncError::Store(dr_store::StoreError::Asset(MANUSCRIPT.into())),
            SyncError::Loro(loro::LoroError::DecodeError(MANUSCRIPT.into())),
            SyncError::LoroEncode(loro::LoroEncodeError::FrontiersNotFound(PATH.into())),
            SyncError::Io(std::io::Error::other(MANUSCRIPT)),
            SyncError::Json(serde_json::from_str::<u8>(MANUSCRIPT).unwrap_err()),
        ];
        let codes: Vec<String> = errors.iter().map(SyncError::code).collect();
        assert_eq!(
            codes,
            [
                "sync.invalid-origin",
                "sync.invalid-path",
                "sync.integrity-mismatch",
                "sync.object-too-large",
                "sync.cancelled",
                "sync.reauth-required",
                "sync.quota-exceeded",
                "sync.offline",
                "sync.http-503",
                "sync.missing-dependencies",
                "sync.store-already-open",
                "sync.store-io",
                "sync.store",
                "sync.loro",
                "sync.loro-encode",
                "sync.io",
                "sync.json",
            ]
        );
        for code in &codes {
            assert_eq!(&sanitize::error_code(code), code, "a plain identifier");
        }

        // The text stays on the device: the summary carries only the code.
        for err in &errors {
            let mut tracker = connected_tracker();
            tracker.finish_cycle_err(None, err, NOW);
            let text = summary(&input(diagnostics_snapshot(
                &attached(&tracker),
                false,
                NOW,
            )));
            assert!(text.contains(&format!("\"{}\"", err.code())), "{text}");
            assert!(!text.contains("雨已经停了"), "{text}");
            assert!(!text.contains("书稿"), "{text}");
            assert!(!text.contains("/Users"), "{text}");
            assert!(!text.contains("UPSTREAM"), "{text}");
        }
    }
}
