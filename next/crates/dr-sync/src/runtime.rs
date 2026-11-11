//! Background scheduler and lifecycle coordinator for [`SyncEngine`].
//!
//! Drives automatic Hosted Sync v2 in production and integration tests:
//! - Periodic background sync while an account library is open and signed in;
//! - Trailing-debounced sync on local document, asset and purge commits
//!   (coalescing rapid consecutive edits into a single sync cycle, plus one
//!   follow-up cycle if local edits arrive while a cycle is in flight);
//! - Exponential backoff on transient failures, pausing automatic loops on
//!   `401` (`Reauth`) and `413` (`Quota`) until credentials change or the
//!   author clicks Retry;
//! - Ordered drain of pending local uploads before switching accounts,
//!   switching libraries or exiting the app, always bound to the outgoing
//!   generation's own `(Library, base_url, access_token)` so cross-account
//!   contamination is impossible;
//! - Strict silence (zero network requests) in local-only mode or when signed out.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread::{self, JoinHandle, ThreadId};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dr_store::{Library, LibrarySubscription, Origin, StoreError, StoreEvent};
use dr_workspace::{SyncController, SyncNowOutput, SyncStatusSnapshot, Workspace, WsError};
use serde::{Deserialize, Serialize};

use crate::engine::{
    AfterRemoteImportHook, AfterRemotePurgeHook, BeforeRemotePurgeHook, SyncCycleReport, SyncEngine,
};
use crate::health::{SyncHealthSnapshot, SyncHealthTracker};
use crate::protocol::SyncError;

static NEXT_TARGET_ID: AtomicU64 = AtomicU64::new(1);

/// Timing parameters for [`SyncRuntime`].
#[derive(Clone, Debug)]
pub struct SyncScheduleConfig {
    /// Interval between idle background sync checks while connected.
    pub periodic_interval: Duration,
    /// Trailing quiet window after a local edit before uploading.
    pub edit_debounce: Duration,
    /// Maximum delay from the first coalesced edit before forcing an upload
    /// during continuous writing.
    pub max_debounce_wait: Duration,
    /// Initial retry delay after a transient failure.
    pub initial_backoff: Duration,
    /// Maximum retry delay for exponential backoff.
    pub max_backoff: Duration,
    /// Maximum wait time for synchronous drain calls.
    pub drain_timeout: Duration,
}

impl Default for SyncScheduleConfig {
    fn default() -> Self {
        Self {
            periodic_interval: Duration::from_secs(30),
            edit_debounce: Duration::from_millis(1_500),
            max_debounce_wait: Duration::from_secs(8),
            initial_backoff: Duration::from_secs(2),
            max_backoff: Duration::from_secs(60),
            drain_timeout: Duration::from_secs(5),
        }
    }
}

/// Session and library eligibility mode supplied to [`SyncRuntime::configure`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum SyncSessionMode {
    /// Hosted Sync is not configured, or the open library is a local-only library.
    #[default]
    LocalOnly,
    /// Hosted Sync is configured, but no account is signed in.
    SignedOut,
    /// An account library is active offline without a usable bearer token.
    OfflineAccount { library_root: PathBuf },
    /// The session requires re-authentication (`401`) before syncing can resume.
    NeedsReauth { library_root: PathBuf },
    /// Eligible account library with a bearer token for `user_id` at `base_url`.
    Connected {
        base_url: String,
        user_id: String,
        access_token: String,
        library_root: PathBuf,
    },
}

impl SyncSessionMode {
    #[must_use]
    pub fn mode_name(&self) -> &'static str {
        match self {
            Self::LocalOnly => "local_only",
            Self::SignedOut => "signed_out",
            Self::OfflineAccount { .. } => "offline_account",
            Self::NeedsReauth { .. } => "needs_reauth",
            Self::Connected { .. } => "connected",
        }
    }

    #[must_use]
    pub fn hosted_enabled(&self) -> bool {
        matches!(
            self,
            Self::OfflineAccount { .. } | Self::NeedsReauth { .. } | Self::Connected { .. }
        )
    }
}

/// Open [`Library`] attachment plus optional coordinator hooks for remote
/// purges and imports.
pub struct SyncTarget {
    id: u64,
    pub library: Library,
    pub before_remote_purge: Option<BeforeRemotePurgeHook>,
    pub after_remote_purge: Option<AfterRemotePurgeHook>,
    pub after_remote_import: Option<AfterRemoteImportHook>,
}

impl SyncTarget {
    #[must_use]
    pub fn new(library: Library) -> Self {
        Self {
            id: NEXT_TARGET_ID.fetch_add(1, Ordering::Relaxed),
            library,
            before_remote_purge: None,
            after_remote_purge: None,
            after_remote_import: None,
        }
    }

    #[must_use]
    pub fn with_before_remote_purge(mut self, hook: BeforeRemotePurgeHook) -> Self {
        self.before_remote_purge = Some(hook);
        self
    }

    #[must_use]
    pub fn with_after_remote_purge(mut self, hook: AfterRemotePurgeHook) -> Self {
        self.after_remote_purge = Some(hook);
        self
    }

    #[must_use]
    pub fn with_after_remote_import(mut self, hook: AfterRemoteImportHook) -> Self {
        self.after_remote_import = Some(hook);
        self
    }
}

/// Thread-safe snapshot of [`SyncRuntime`] state for UI and CLI inspection.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncRuntimeSnapshot {
    pub mode: String,
    pub health: SyncHealthSnapshot,
    pub cursor: u64,
    pub completed_cycles: u64,
    pub consecutive_backoff_failures: u32,
    pub last_sync_ok_ms: Option<u64>,
    pub last_report: Option<SyncCycleReport>,
    pub pending_docs: usize,
    pub pending_assets: usize,
    pub pending_purges: usize,
    pub blocked_on_open_doc: bool,
}

pub type StateChangeCallback = Arc<dyn Fn(&SyncRuntimeSnapshot) + Send + Sync>;

enum WorkerCommand {
    Configure {
        target: Option<SyncTarget>,
        mode: SyncSessionMode,
        reply: Option<mpsc::Sender<()>>,
    },
    PauseForRelease {
        reply: mpsc::Sender<()>,
    },
    SyncNow {
        reply: mpsc::Sender<Result<SyncCycleReport, SyncError>>,
    },
    DrainBeforeSignOut {
        reply: mpsc::Sender<Result<SyncCycleReport, SyncError>>,
    },
    DrainAndDetach {
        reply: mpsc::Sender<Result<SyncCycleReport, SyncError>>,
    },
}

#[derive(Default)]
struct SharedQueue {
    commands: VecDeque<WorkerCommand>,
    local_dirty_first_at: Option<Instant>,
    local_dirty_due_at: Option<Instant>,
    manual_retry_requested: bool,
    holder_released: bool,
    shutdown: bool,
}

struct SharedState {
    snapshot: Mutex<SyncRuntimeSnapshot>,
    on_change: Mutex<Option<StateChangeCallback>>,
    active_cancel: Mutex<Option<Arc<AtomicBool>>>,
}

impl SharedState {
    fn publish(&self, next: SyncRuntimeSnapshot) {
        let cb = {
            let mut snap = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
            *snap = next.clone();
            self.on_change
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        };
        if let Some(cb) = cb {
            cb(&next);
        }
    }
}

struct ActiveGeneration {
    target_id: u64,
    library: Library,
    library_root: PathBuf,
    base_url: String,
    user_id: String,
    access_token: String,
    engine: SyncEngine,
    _subscription: LibrarySubscription,
    paused_for_action: bool,
    paused_for_release: bool,
    drained_for_signout: bool,
    blocked_on_open_doc: bool,
    completed_cycles: u64,
    backoff_failures: u32,
    last_sync_ok_ms: Option<u64>,
    last_report: Option<SyncCycleReport>,
    immediate_due: bool,
    next_periodic_at: Instant,
    next_retry_at: Option<Instant>,
}

/// Background Hosted Sync v2 runtime.
pub struct SyncRuntime {
    config: SyncScheduleConfig,
    queue: Arc<(Mutex<SharedQueue>, Condvar)>,
    shared: Arc<SharedState>,
    worker: Option<JoinHandle<()>>,
}

impl SyncRuntime {
    /// Start a new background sync runtime in [`SyncSessionMode::LocalOnly`].
    #[must_use]
    pub fn start(config: SyncScheduleConfig) -> Self {
        let initial_snap = SyncRuntimeSnapshot {
            mode: SyncSessionMode::LocalOnly.mode_name().to_owned(),
            health: SyncHealthTracker::new(false).snapshot().clone(),
            ..SyncRuntimeSnapshot::default()
        };
        let queue = Arc::new((Mutex::new(SharedQueue::default()), Condvar::new()));
        let shared = Arc::new(SharedState {
            snapshot: Mutex::new(initial_snap),
            on_change: Mutex::new(None),
            active_cancel: Mutex::new(None),
        });

        let queue_bg = Arc::clone(&queue);
        let shared_bg = Arc::clone(&shared);
        let config_bg = config.clone();
        let worker = thread::Builder::new()
            .name("dr-sync:runtime".into())
            .spawn(move || worker_loop(config_bg, queue_bg, shared_bg))
            .expect("spawn dr-sync runtime thread");

        Self {
            config,
            queue,
            shared,
            worker: Some(worker),
        }
    }

    #[must_use]
    pub fn config(&self) -> &SyncScheduleConfig {
        &self.config
    }

    /// Register a callback invoked whenever [`SyncRuntimeSnapshot`] changes.
    pub fn set_on_state_change(&self, callback: Option<StateChangeCallback>) {
        *self
            .shared
            .on_change
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = callback;
    }

    /// Latest non-blocking health and progress snapshot.
    #[must_use]
    pub fn snapshot(&self) -> SyncRuntimeSnapshot {
        self.shared
            .snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Reconfigure the attached library and session mode asynchronously.
    pub fn configure_async(&self, target: Option<SyncTarget>, mode: SyncSessionMode) {
        let (lock, cvar) = &*self.queue;
        let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
        q.commands.push_back(WorkerCommand::Configure {
            target,
            mode,
            reply: None,
        });
        cvar.notify_one();
    }

    /// Reconfigure the attached library and session mode and wait until the
    /// worker has applied it (including draining any outgoing library/account).
    pub fn configure(&self, target: Option<SyncTarget>, mode: SyncSessionMode) {
        let (tx, rx) = mpsc::channel();
        {
            let (lock, cvar) = &*self.queue;
            let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
            q.commands.push_back(WorkerCommand::Configure {
                target,
                mode,
                reply: Some(tx),
            });
            cvar.notify_one();
        }
        let _ = rx.recv_timeout(self.config.drain_timeout.saturating_mul(2));
    }

    /// Request an immediate retry (e.g. from the paper-corner hover card or
    /// notification bell Retry button) without blocking the UI thread.
    pub fn trigger_retry(&self) {
        let (lock, cvar) = &*self.queue;
        let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
        q.manual_retry_requested = true;
        cvar.notify_one();
    }

    /// Notify the runtime that an open document holder may have closed so a
    /// previously blocked remote `DocPurge` (`AlreadyOpen`) can retry promptly.
    pub fn notify_holder_released(&self) {
        let (lock, cvar) = &*self.queue;
        let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
        q.holder_released = true;
        cvar.notify_one();
    }

    /// Run one full sync cycle now and return its report or error.
    pub fn sync_now(&self) -> Result<SyncCycleReport, SyncError> {
        let (tx, rx) = mpsc::channel();
        {
            let (lock, cvar) = &*self.queue;
            let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
            q.commands.push_back(WorkerCommand::SyncNow { reply: tx });
            cvar.notify_one();
        }
        rx.recv_timeout(self.config.drain_timeout.saturating_mul(3))
            .map_err(|_| SyncError::Offline("sync_now timed out".into()))?
    }

    /// Drain pending local uploads while keeping the library attached, then
    /// pause automatic sync until the session reconfigures (used right before
    /// `POST /api/auth/sign-out` revokes the current bearer token).
    pub fn drain_before_sign_out(&self) -> Result<SyncCycleReport, SyncError> {
        let (tx, rx) = mpsc::channel();
        {
            let (lock, cvar) = &*self.queue;
            let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
            q.commands
                .push_back(WorkerCommand::DrainBeforeSignOut { reply: tx });
            cvar.notify_one();
        }
        rx.recv_timeout(self.config.drain_timeout)
            .unwrap_or_else(|_| Err(SyncError::Offline("sign-out drain timed out".into())))
    }

    /// Freeze automatic background cycles and wait for any in-flight cycle to
    /// settle so final page/snapshot checkpoints can run without concurrent
    /// remote imports before [`Self::drain_and_detach`].
    pub fn pause_for_release(&self) {
        let (tx, rx) = mpsc::channel();
        {
            let (lock, cvar) = &*self.queue;
            let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
            q.commands
                .push_back(WorkerCommand::PauseForRelease { reply: tx });
            cvar.notify_one();
        }
        let _ = rx.recv_timeout(self.config.drain_timeout);
    }

    /// Drain pending local uploads and detach the runtime's [`Library`] handle
    /// so `Workspace::try_shutdown()` / `Library::try_close()` can close cleanly.
    pub fn drain_and_detach(&self) -> Result<SyncCycleReport, SyncError> {
        let (tx, rx) = mpsc::channel();
        {
            let (lock, cvar) = &*self.queue;
            let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
            q.commands
                .push_back(WorkerCommand::DrainAndDetach { reply: tx });
            cvar.notify_one();
        }
        rx.recv_timeout(self.config.drain_timeout)
            .unwrap_or_else(|_| Err(SyncError::Offline("drain_and_detach timed out".into())))
    }
}

impl Drop for SyncRuntime {
    fn drop(&mut self) {
        if let Some(cancel) = self
            .shared
            .active_cancel
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            cancel.store(true, Ordering::SeqCst);
        }
        {
            let (lock, cvar) = &*self.queue;
            let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
            q.shutdown = true;
            cvar.notify_all();
        }
        if let Some(worker) = self.worker.take()
            && worker.thread().id() != thread::current().id()
        {
            let _ = worker.join();
        }
    }
}

fn mark_local_dirty(
    queue: &Arc<(Mutex<SharedQueue>, Condvar)>,
    edit_debounce: Duration,
    max_debounce_wait: Duration,
) {
    let now = Instant::now();
    let (lock, cvar) = &**queue;
    let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
    let first = *q.local_dirty_first_at.get_or_insert(now);
    let max_deadline = first + max_debounce_wait;
    let candidate = now + edit_debounce;
    q.local_dirty_due_at = Some(candidate.min(max_deadline));
    cvar.notify_one();
}

fn build_active_snapshot(active: &ActiveGeneration) -> SyncRuntimeSnapshot {
    let (pending_docs, pending_assets, pending_purges) = active
        .engine
        .pending_upload_counts(&active.library)
        .unwrap_or((0, 0, 0));
    SyncRuntimeSnapshot {
        mode: "connected".into(),
        health: active.engine.health_snapshot().clone(),
        cursor: active.engine.cursor(),
        completed_cycles: active.completed_cycles,
        consecutive_backoff_failures: active.backoff_failures,
        last_sync_ok_ms: active.last_sync_ok_ms,
        last_report: active.last_report.clone(),
        pending_docs,
        pending_assets,
        pending_purges,
        blocked_on_open_doc: active.blocked_on_open_doc,
    }
}

fn build_inactive_snapshot(
    mode: &SyncSessionMode,
    init_err: Option<String>,
) -> SyncRuntimeSnapshot {
    let mut tracker = SyncHealthTracker::new(mode.hosted_enabled());
    match mode {
        SyncSessionMode::LocalOnly | SyncSessionMode::SignedOut => {}
        SyncSessionMode::OfflineAccount { .. } => {
            tracker.set_offline(true);
        }
        SyncSessionMode::NeedsReauth { .. } => {
            tracker.set_reauth_required(true);
        }
        SyncSessionMode::Connected { .. } => {
            if let Some(msg) = init_err {
                tracker.set_init_failed(true, Some(msg));
            }
        }
    }
    SyncRuntimeSnapshot {
        mode: mode.mode_name().to_owned(),
        health: tracker.snapshot().clone(),
        ..SyncRuntimeSnapshot::default()
    }
}

fn drain_outgoing_generation(
    active: &mut ActiveGeneration,
    shared: &SharedState,
) -> Result<SyncCycleReport, SyncError> {
    if active.drained_for_signout {
        return Ok(SyncCycleReport {
            cursor: active.engine.cursor(),
            ..SyncCycleReport::default()
        });
    }
    let has_pending = active
        .engine
        .has_pending_uploads(&active.library)
        .unwrap_or(false);
    if !has_pending {
        return Ok(SyncCycleReport {
            cursor: active.engine.cursor(),
            ..SyncCycleReport::default()
        });
    }
    let start_ms = current_time_ms();
    active.engine.health_mut().begin_cycle(None, start_ms);
    shared.publish(build_active_snapshot(active));

    let res = active
        .engine
        .drain_local_changes(&active.library, &active.access_token);
    if let Ok(rep) = &res {
        active.last_sync_ok_ms = Some(current_time_ms());
        active.last_report = Some(rep.clone());
    }
    shared.publish(build_active_snapshot(active));
    res
}

fn worker_loop(
    config: SyncScheduleConfig,
    queue: Arc<(Mutex<SharedQueue>, Condvar)>,
    shared: Arc<SharedState>,
) {
    let worker_tid: ThreadId = thread::current().id();
    let mut current_mode = SyncSessionMode::LocalOnly;
    let mut active: Option<ActiveGeneration> = None;

    loop {
        enum NextStep {
            Quit,
            Command(WorkerCommand),
            RunCycle { manual: bool },
        }

        let step = {
            let (lock, cvar) = &*queue;
            let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if q.shutdown {
                    break NextStep::Quit;
                }
                if let Some(cmd) = q.commands.pop_front() {
                    break NextStep::Command(cmd);
                }
                if q.manual_retry_requested {
                    q.manual_retry_requested = false;
                    if active.as_ref().is_some_and(|g| !g.paused_for_release) {
                        q.local_dirty_first_at = None;
                        q.local_dirty_due_at = None;
                        break NextStep::RunCycle { manual: true };
                    }
                }
                if q.holder_released {
                    q.holder_released = false;
                    if let Some(generation) = active.as_mut()
                        && generation.blocked_on_open_doc
                        && !generation.paused_for_action
                        && !generation.paused_for_release
                    {
                        generation.next_retry_at = None;
                        generation.immediate_due = true;
                    }
                }

                let now = Instant::now();
                let mut wake_at: Option<Instant> = None;

                if let Some(generation) = active.as_ref()
                    && !generation.paused_for_action
                    && !generation.paused_for_release
                {
                    if generation.immediate_due {
                        q.local_dirty_first_at = None;
                        q.local_dirty_due_at = None;
                        break NextStep::RunCycle { manual: false };
                    }
                    if let Some(due) = q.local_dirty_due_at {
                        if now >= due {
                            // If we are currently backing off after an error, respect
                            // `next_retry_at` so rapid edits while offline do not spin.
                            if generation.next_retry_at.is_none_or(|r| now >= r) {
                                q.local_dirty_first_at = None;
                                q.local_dirty_due_at = None;
                                break NextStep::RunCycle { manual: false };
                            }
                        } else if generation.next_retry_at.is_none_or(|r| due < r) {
                            wake_at = Some(wake_at.map_or(due, |w| w.min(due)));
                        }
                    }
                    if let Some(retry_at) = generation.next_retry_at {
                        if now >= retry_at {
                            q.local_dirty_first_at = None;
                            q.local_dirty_due_at = None;
                            break NextStep::RunCycle { manual: false };
                        }
                        wake_at = Some(wake_at.map_or(retry_at, |w| w.min(retry_at)));
                    } else if now >= generation.next_periodic_at {
                        q.local_dirty_first_at = None;
                        q.local_dirty_due_at = None;
                        break NextStep::RunCycle { manual: false };
                    } else {
                        wake_at = Some(wake_at.map_or(generation.next_periodic_at, |w| {
                            w.min(generation.next_periodic_at)
                        }));
                    }
                }

                if let Some(deadline) = wake_at {
                    let wait = deadline.saturating_duration_since(now);
                    let (guard, _) = cvar
                        .wait_timeout(q, wait)
                        .unwrap_or_else(|e| e.into_inner());
                    q = guard;
                } else {
                    q = cvar.wait(q).unwrap_or_else(|e| e.into_inner());
                }
            }
        };

        match step {
            NextStep::Quit => {
                *shared
                    .active_cancel
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = None;
                drop(active.take());
                break;
            }
            NextStep::Command(WorkerCommand::Configure {
                target,
                mode,
                reply,
            }) => {
                // Check if this is an in-place update to the exact same open
                // `(target_id, library_root, base_url, user_id)`.
                let same_generation = match (&active, &target, &mode) {
                    (
                        Some(generation),
                        Some(t),
                        SyncSessionMode::Connected {
                            base_url,
                            user_id,
                            library_root,
                            ..
                        },
                    ) => {
                        generation.target_id == t.id
                            && generation.library_root == *library_root
                            && generation.base_url == *base_url
                            && generation.user_id == *user_id
                    }
                    _ => false,
                };

                if same_generation {
                    if let (Some(generation), SyncSessionMode::Connected { access_token, .. }) =
                        (active.as_mut(), &mode)
                    {
                        generation.paused_for_release = false;
                        if generation.access_token != *access_token {
                            generation.access_token = access_token.clone();
                            generation.paused_for_action = false;
                            generation.drained_for_signout = false;
                            generation.engine.health_mut().set_reauth_required(false);
                            generation.backoff_failures = 0;
                            generation.next_retry_at = None;
                            generation.immediate_due = true;
                            shared.publish(build_active_snapshot(generation));
                        }
                    }
                    // Drop duplicate `target` after replying if any.
                    drop(target);
                    if let Some(tx) = reply {
                        let _ = tx.send(());
                    }
                    continue;
                }

                // Different library, different user, or leaving `Connected`:
                // drain the outgoing generation with its OWN credentials first,
                // then drop its Library handle before attaching the next one.
                if let Some(mut outgoing) = active.take() {
                    let _ = drain_outgoing_generation(&mut outgoing, &shared);
                    *shared
                        .active_cancel
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = None;
                    drop(outgoing);
                }

                {
                    let (lock, _) = &*queue;
                    let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
                    q.local_dirty_first_at = None;
                    q.local_dirty_due_at = None;
                }

                current_mode = mode.clone();
                match (target, mode) {
                    (
                        Some(target),
                        SyncSessionMode::Connected {
                            base_url,
                            user_id,
                            access_token,
                            library_root,
                        },
                    ) => match SyncEngine::new(&base_url, &target.library) {
                        Ok(mut engine) => {
                            engine.set_before_remote_purge(target.before_remote_purge);
                            engine.set_after_remote_purge(target.after_remote_purge);
                            engine.set_after_remote_import(target.after_remote_import);
                            let cancel = engine.cancel_handle();
                            *shared
                                .active_cancel
                                .lock()
                                .unwrap_or_else(|e| e.into_inner()) = Some(cancel);

                            let queue_for_sub = Arc::clone(&queue);
                            let debounce = config.edit_debounce;
                            let max_wait = config.max_debounce_wait;
                            let sub = target.library.subscribe(move |event| {
                                if thread::current().id() == worker_tid {
                                    return;
                                }
                                match event {
                                    StoreEvent::Doc(doc_ev) => {
                                        if doc_ev.origin != Origin::Sync {
                                            mark_local_dirty(&queue_for_sub, debounce, max_wait);
                                        }
                                    }
                                    StoreEvent::Local(change) => {
                                        if matches!(
                                            change.table.as_str(),
                                            "doc" | "asset" | "purged_doc"
                                        ) {
                                            mark_local_dirty(&queue_for_sub, debounce, max_wait);
                                        }
                                    }
                                }
                            });

                            let generation = ActiveGeneration {
                                target_id: target.id,
                                library: target.library,
                                library_root,
                                base_url,
                                user_id,
                                access_token,
                                engine,
                                _subscription: sub,
                                paused_for_action: false,
                                paused_for_release: false,
                                drained_for_signout: false,
                                blocked_on_open_doc: false,
                                completed_cycles: 0,
                                backoff_failures: 0,
                                last_sync_ok_ms: None,
                                last_report: None,
                                immediate_due: true,
                                next_periodic_at: Instant::now() + config.periodic_interval,
                                next_retry_at: None,
                            };
                            shared.publish(build_active_snapshot(&generation));
                            active = Some(generation);
                        }
                        Err(err) => {
                            drop(target);
                            shared.publish(build_inactive_snapshot(
                                &current_mode,
                                Some(err.to_string()),
                            ));
                        }
                    },
                    (unused_target, non_connected) => {
                        drop(unused_target);
                        shared.publish(build_inactive_snapshot(&non_connected, None));
                    }
                }

                if let Some(tx) = reply {
                    let _ = tx.send(());
                }
            }
            NextStep::Command(WorkerCommand::PauseForRelease { reply }) => {
                if let Some(generation) = active.as_mut() {
                    generation.paused_for_release = true;
                }
                let _ = reply.send(());
            }
            NextStep::Command(WorkerCommand::DrainBeforeSignOut { reply }) => {
                let res = if let Some(generation) = active.as_mut() {
                    let r = drain_outgoing_generation(generation, &shared);
                    generation.paused_for_action = true;
                    generation.drained_for_signout = true;
                    r
                } else {
                    Ok(SyncCycleReport::default())
                };
                let _ = reply.send(res);
            }
            NextStep::Command(WorkerCommand::DrainAndDetach { reply }) => {
                let res = if let Some(mut outgoing) = active.take() {
                    let r = drain_outgoing_generation(&mut outgoing, &shared);
                    *shared
                        .active_cancel
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = None;
                    drop(outgoing);
                    r
                } else {
                    Ok(SyncCycleReport::default())
                };
                {
                    let (lock, _) = &*queue;
                    let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
                    q.local_dirty_first_at = None;
                    q.local_dirty_due_at = None;
                }
                shared.publish(build_inactive_snapshot(&current_mode, None));
                let _ = reply.send(res);
            }
            NextStep::Command(WorkerCommand::SyncNow { reply }) => {
                let res = if let Some(generation) = active.as_mut() {
                    {
                        let (lock, _) = &*queue;
                        let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
                        q.local_dirty_first_at = None;
                        q.local_dirty_due_at = None;
                    }
                    run_generation_cycle(generation, true, &config, &queue, &shared)
                } else {
                    Err(SyncError::Offline(format!(
                        "Hosted Sync is not active ({})",
                        current_mode.mode_name()
                    )))
                };
                let _ = reply.send(res);
            }
            NextStep::RunCycle { manual } => {
                if let Some(generation) = active.as_mut() {
                    let _ = run_generation_cycle(generation, manual, &config, &queue, &shared);
                }
            }
        }
    }
}

fn run_generation_cycle(
    generation: &mut ActiveGeneration,
    manual: bool,
    config: &SyncScheduleConfig,
    queue: &Arc<(Mutex<SharedQueue>, Condvar)>,
    shared: &SharedState,
) -> Result<SyncCycleReport, SyncError> {
    generation.immediate_due = false;
    if manual {
        generation.paused_for_action = false;
        generation.engine.health_mut().set_reauth_required(false);
        generation.engine.health_mut().set_quota_exceeded(false);
    }

    let start_ms = current_time_ms();
    generation.engine.health_mut().begin_cycle(None, start_ms);
    shared.publish(build_active_snapshot(generation));

    let result = generation
        .engine
        .sync_once(&generation.library, &generation.access_token);
    generation.next_periodic_at = Instant::now() + config.periodic_interval;

    match &result {
        Ok(report) => {
            generation.completed_cycles = generation.completed_cycles.saturating_add(1);
            generation.backoff_failures = 0;
            generation.next_retry_at = None;
            generation.paused_for_action = false;
            generation.blocked_on_open_doc = false;
            generation.last_sync_ok_ms = Some(current_time_ms());
            generation.last_report = Some(report.clone());

            // If new local uploads remain (e.g. a new genesis doc registered
            // externally or an edit landed mid-cycle), coalesce into one
            // debounced follow-up cycle.
            if generation
                .engine
                .has_pending_uploads(&generation.library)
                .unwrap_or(false)
            {
                mark_local_dirty(queue, config.edit_debounce, config.max_debounce_wait);
            }
        }
        Err(err) => {
            if err.is_unauthorized() || err.is_quota_exceeded() {
                generation.paused_for_action = true;
                generation.next_retry_at = None;
                generation.blocked_on_open_doc = false;
            } else {
                generation.blocked_on_open_doc =
                    matches!(err, SyncError::Store(StoreError::AlreadyOpen(_)));
                let shift = generation.backoff_failures.min(10);
                let factor = 1u32 << shift;
                let backoff = config
                    .initial_backoff
                    .saturating_mul(factor)
                    .min(config.max_backoff);
                generation.backoff_failures = generation.backoff_failures.saturating_add(1);
                generation.next_retry_at = Some(Instant::now() + backoff);
            }
        }
    }

    shared.publish(build_active_snapshot(generation));
    result
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct WorkspaceSyncController {
    runtime: Weak<SyncRuntime>,
}

impl SyncController for WorkspaceSyncController {
    fn status(&self) -> SyncStatusSnapshot {
        let Some(rt) = self.runtime.upgrade() else {
            return SyncStatusSnapshot::default();
        };
        let snap = rt.snapshot();
        SyncStatusSnapshot {
            mode: snap.mode,
            hosted_enabled: snap.health.hosted_enabled,
            paused: snap.health.paused,
            offline: snap.health.offline,
            reauth_required: snap.health.reauth_required,
            quota_exceeded: snap.health.quota_exceeded,
            busy: snap.health.library_busy,
            cursor: snap.cursor,
            completed_cycles: snap.completed_cycles,
            consecutive_failures: snap.health.library_failed_cycles,
            last_sync_ok_ms: snap.last_sync_ok_ms,
            last_error: snap.health.last_error,
            pending_docs: snap.pending_docs,
            pending_assets: snap.pending_assets,
            pending_purges: snap.pending_purges,
            blocked_on_open_doc: snap.blocked_on_open_doc,
        }
    }

    fn sync_now(&self) -> dr_workspace::Result<SyncNowOutput> {
        let Some(rt) = self.runtime.upgrade() else {
            return Err(WsError::Conflict("sync runtime is not running".into()));
        };
        let report = rt
            .sync_now()
            .map_err(|e| WsError::Conflict(e.to_string()))?;
        Ok(SyncNowOutput {
            uploaded_docs: report.uploaded_docs,
            uploaded_assets: report.uploaded_assets,
            uploaded_purges: report.uploaded_purges,
            downloaded_docs: report.downloaded_docs,
            downloaded_assets: report.downloaded_assets,
            applied_purges: report.applied_purges,
            cursor: report.cursor,
        })
    }
}

/// Build a [`SyncTarget`] wired to `ws`'s coordinator hooks (idle-slot release
/// before remote `DocPurge`, post-merge deterministic repair, journal/gate
/// cleanup on whole-book purge) and attach `runtime` as `ws`'s
/// [`SyncController`] (`sync.status` / `sync.now`).
#[must_use]
pub fn attach_workspace_target(ws: &Workspace, runtime: &Arc<SyncRuntime>) -> SyncTarget {
    ws.set_sync_controller(Some(Arc::new(WorkspaceSyncController {
        runtime: Arc::downgrade(runtime),
    })));
    let weak_before = ws.downgrade();
    let weak_after_purge = ws.downgrade();
    let weak_after_import = ws.downgrade();

    SyncTarget::new(ws.library().clone())
        .with_before_remote_purge(Arc::new(move |doc_id| {
            if let Some(ws) = weak_before.upgrade() {
                let _ = ws.release_idle_doc_for_remote_purge(doc_id);
            }
        }))
        .with_after_remote_purge(Arc::new(move |_doc_id, purged_book| {
            if let Some(book_id) = purged_book
                && let Some(ws) = weak_after_purge.upgrade()
            {
                ws.cleanup_purged_book(book_id);
            }
        }))
        .with_after_remote_import(Arc::new(move |doc_id| {
            if let Some(ws) = weak_after_import.upgrade() {
                ws.repair_after_sync(doc_id);
            }
        }))
}
