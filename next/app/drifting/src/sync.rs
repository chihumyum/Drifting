//! Production Hosted Sync v2 supervisor for the desktop app (`M36`).
//!
//! Connects `dr_sync::SyncRuntime` to:
//! - `dr_view_account::Service` (Hosted configuration, session status, bearer token,
//!   and isolated per-account library root);
//! - `dr_shell::Services.library` (`dr_workspace::Workspace` over `dr_store::Library`);
//! - `dr_shell::release` (best-effort upload drain and clean handle detach before
//!   switching libraries or quitting the app);
//! - `dr_shell::sync` (lower-left paper sync corner mark, 220ms hover card,
//!   bell danger seal, pinned severe notices, holder-release wakeups, and
//!   pre-sign-out drain).

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use dr_account::{AccountService, HostedConfig, LibraryRegistry, SessionStatus, SessionTokenStore};
use dr_platform::{Channel, Identity, SecretStore};
use dr_shell::notifications::{Notifications, Source};
use dr_shell::settings::{self, registry::Section};
use dr_shell::strings::Strings;
use dr_shell::sync::{MarkAction, MarkSpec, MarkVisual};
use dr_sync::{
    SYNC_FAILING_FOR_MS, SYNC_MARK_SHOW_AFTER_MS, SYNC_RETRY_SHOW_AFTER_MS, SyncCornerState,
    SyncRuntime, SyncRuntimeSnapshot, SyncScheduleConfig, SyncSessionMode, SyncStatusAction,
    SyncStatusVisual, attach_workspace_target, evaluate_paper_sync_mark,
};
use dr_ui::sand::Icon;
use dr_view_account::{
    Service as AccountUiService, apply_account_state, open_auth_dialog,
    reconcile_sync_problem_notifications, sync_action_label, sync_status_copy,
};
use futures::FutureExt as _;
use gpui::{App, BorrowAppContext as _, Global, SharedString, Subscription, Task, Window};

/// Development-only switch (`Channel::Development`): `1` keeps secrets in memory
/// so automated multi-window smoke tests never read or write the OS keychain.
pub const DEV_EPHEMERAL_SECRETS_ENV: &str = "DRIFTING_DEV_EPHEMERAL_SECRETS";

/// Development-only switch (`Channel::Development`): seeds a synthetic bearer
/// token for a loopback `http://127.0.0.1` / `localhost` fake sync server.
pub const DEV_SYNTHETIC_TOKEN_ENV: &str = "DRIFTING_DEV_SYNTHETIC_TOKEN";

/// Development-only switch (`Channel::Development`): overrides the background
/// sync poll interval in milliseconds (minimum 100 ms).
pub const DEV_SYNC_POLL_MS_ENV: &str = "DRIFTING_DEV_SYNC_POLL_MS";

/// Development-only switch (`Channel::Development`): overrides the local-edit
/// trailing debounce window in milliseconds (minimum 50 ms).
pub const DEV_SYNC_DEBOUNCE_MS_ENV: &str = "DRIFTING_DEV_SYNC_DEBOUNCE_MS";

struct Supervisor {
    runtime: Arc<SyncRuntime>,
    snapshot: SyncRuntimeSnapshot,
    last_configured: Option<(Option<PathBuf>, SyncSessionMode)>,
    last_account_target_dir: Option<PathBuf>,
    pending_library_switch: Option<(PathBuf, u8)>,
    switch_retry_task: Option<Task<()>>,
    threshold_task: Option<Task<()>>,
    _account_sub: Option<Subscription>,
}

impl Global for Supervisor {}

/// Builds `dr_view_account::Service` for `platform`, honouring development-only
/// ephemeral loopback test switches when `platform.channel == Channel::Development`.
pub fn account_service_for_build(platform: &Identity, data_dir: Option<&Path>) -> AccountUiService {
    if platform.channel == Channel::Development {
        let ephemeral = std::env::var(DEV_EPHEMERAL_SECRETS_ENV)
            .ok()
            .is_some_and(|v| matches!(v.trim(), "1" | "true" | "yes"));
        if ephemeral {
            let config = HostedConfig::for_build(platform);
            let dir = data_dir
                .map(Path::to_path_buf)
                .unwrap_or_else(std::env::temp_dir);
            let secrets = Arc::new(SecretStore::in_memory());
            if let (Some(origin), Ok(raw_token)) =
                (config.origin(), std::env::var(DEV_SYNTHETIC_TOKEN_ENV))
            {
                let token = raw_token.trim();
                let is_loopback = origin.as_str().starts_with("http://127.0.0.1")
                    || origin.as_str().starts_with("http://localhost")
                    || origin.as_str().starts_with("http://[::1]");
                if !token.is_empty() && is_loopback {
                    let store = SessionTokenStore::new(Arc::clone(&secrets));
                    let _ = store.write(origin, token);
                }
            }
            if let Ok(svc) = AccountService::new(config, dir, platform.url_scheme, secrets) {
                return AccountUiService::with_service(Arc::new(svc));
            }
        }
    }
    AccountUiService::for_build(platform, data_dir)
}

fn schedule_for_build(platform: &Identity) -> SyncScheduleConfig {
    let mut cfg = SyncScheduleConfig::default();
    if platform.channel == Channel::Development {
        if let Some(ms) = std::env::var(DEV_SYNC_POLL_MS_ENV)
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
        {
            cfg.periodic_interval = Duration::from_millis(ms.max(100));
            cfg.initial_backoff = Duration::from_millis(ms.clamp(100, 2_000));
        }
        if let Some(ms) = std::env::var(DEV_SYNC_DEBOUNCE_MS_ENV)
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
        {
            cfg.edit_debounce = Duration::from_millis(ms.max(50));
            cfg.max_debounce_wait = Duration::from_millis((ms * 4).max(200));
        }
    }
    cfg
}

/// Starts the Hosted Sync v2 runtime supervisor and wires it into `dr-shell` and
/// `dr-view-account`. Call once during startup after `dr_shell::init` and
/// `dr_view_account::init`.
pub fn init(platform: &Identity, cx: &mut App) {
    let runtime = Arc::new(SyncRuntime::start(schedule_for_build(platform)));
    let initial_snapshot = runtime.snapshot();

    let (tx, mut rx) = futures::channel::mpsc::unbounded::<SyncRuntimeSnapshot>();
    runtime.set_on_state_change(Some(Arc::new(move |snap: &SyncRuntimeSnapshot| {
        let _ = tx.unbounded_send(snap.clone());
    })));

    let account_sub = cx
        .has_global::<AccountUiService>()
        .then(|| cx.observe_global::<AccountUiService>(reconcile));

    let initial_account_target = cx
        .try_global::<AccountUiService>()
        .map(|s| s.state.active_library_dir.clone())
        .filter(|p| !p.as_os_str().is_empty());

    cx.set_global(Supervisor {
        runtime: Arc::clone(&runtime),
        snapshot: initial_snapshot,
        last_configured: None,
        last_account_target_dir: initial_account_target,
        pending_library_switch: None,
        switch_retry_task: None,
        threshold_task: None,
        _account_sub: account_sub,
    });

    // Phase 1 of library release / quit: freeze automatic background sync and
    // settle any in-flight pull before `after_drain` checkpoints capture final
    // frontiers. Phase 2 (`register_final_drain`, registered after `dr_view_page`)
    // uploads all settled local changes and detaches the `Library` handle.
    dr_shell::release::before_release(cx, {
        let runtime = Arc::clone(&runtime);
        move |cx| {
            if cx.has_global::<Supervisor>() {
                cx.update_global::<Supervisor, _>(|sup, _| {
                    sup.last_configured = None;
                });
            }
            let rt = Arc::clone(&runtime);
            let bg = cx.background_executor().spawn(async move {
                rt.pause_for_release();
            });
            async move {
                bg.await;
                Ok(())
            }
            .boxed_local()
        }
    });

    // Re-attach after a library replacement finishes (or if release was aborted).
    dr_shell::release::after_release(cx, reconcile);

    // Pre-sign-out drain from the account menu while the bearer token is still valid.
    dr_shell::sync::set_before_account_action(cx, {
        let runtime = Arc::clone(&runtime);
        move |cx| {
            let connected = cx
                .try_global::<Supervisor>()
                .and_then(|s| s.last_configured.as_ref())
                .is_some_and(|(_, mode)| matches!(mode, SyncSessionMode::Connected { .. }));
            if !connected {
                return None;
            }
            let rt = Arc::clone(&runtime);
            let bg = cx.background_executor().spawn(async move {
                if let Err(err) = rt.drain_before_sign_out() {
                    log::warn!("sync drain before sign-out finished best-effort: {err}");
                }
            });
            Some(async move { bg.await }.boxed_local())
        }
    });

    // Wake the runtime immediately if an open document or active book that was
    // blocking a remote `DocPurge` (`StoreError::AlreadyOpen`) is closed.
    dr_shell::sync::set_holder_released_hook(cx, {
        let runtime = Arc::clone(&runtime);
        move |_| {
            runtime.notify_holder_released();
        }
    });

    // Paper corner mark & hover card evaluator.
    dr_shell::sync::set_mark_hook(cx, build_mark_spec);

    // Foreground receiver for `SyncRuntime` state transitions.
    cx.spawn(async move |cx| {
        use futures::StreamExt as _;
        while let Some(mut snap) = rx.next().await {
            while let Ok(newer) = rx.try_recv() {
                snap = newer;
            }
            cx.update(|cx| on_runtime_snapshot(snap, cx));
        }
    })
    .detach();

    reconcile(cx);
}

/// Registers the final outbound sync drain after all `before_release` writers and
/// `dr_view_page`'s final snapshot checkpoint have settled, right before the shell
/// closes the outgoing `Library` or quits. Best-effort when offline so quitting or
/// switching libraries never hangs or aborts.
pub fn register_final_drain(cx: &mut App) {
    let Some(runtime) = cx
        .try_global::<Supervisor>()
        .map(|s| Arc::clone(&s.runtime))
    else {
        return;
    };
    dr_shell::release::after_drain(cx, move |cx| {
        let rt = Arc::clone(&runtime);
        let bg = cx.background_executor().spawn(async move {
            if let Err(err) = rt.drain_and_detach() {
                log::warn!("sync drain before library release finished best-effort: {err}");
            }
        });
        async move {
            bg.await;
            Ok(())
        }
        .boxed_local()
    });
}

fn retry_action_callback() -> Rc<dyn Fn(&mut Window, &mut App)> {
    Rc::new(|_window, cx| {
        trigger_manual_retry(cx);
    })
}

/// Triggers an immediate retry: re-runs supervisor activation if startup had
/// failed, refreshes an offline Hosted session, and wakes `SyncRuntime`.
pub fn trigger_manual_retry(cx: &mut App) {
    let Some(runtime) = cx
        .try_global::<Supervisor>()
        .map(|s| Arc::clone(&s.runtime))
    else {
        return;
    };
    let had_init_failure = cx
        .try_global::<Supervisor>()
        .is_some_and(|s| s.snapshot.health.init_failed);
    if had_init_failure {
        cx.update_global::<Supervisor, _>(|sup, _| {
            sup.last_configured = None;
        });
        reconcile(cx);
    }
    if let Some(svc) = cx.try_global::<AccountUiService>()
        && matches!(svc.state.status, SessionStatus::Offline)
    {
        let inner = Arc::clone(&svc.inner);
        cx.spawn(async move |cx| {
            let next_state = cx
                .background_executor()
                .spawn(async move { inner.bootstrap() })
                .await;
            cx.update(|cx| apply_account_state(next_state, cx));
        })
        .detach();
    }
    runtime.trigger_retry();
}

fn build_mark_spec(
    book_id: Option<&str>,
    is_trailing_pane: bool,
    last_typing_ms: Option<u64>,
    now_ms: u64,
    cx: &App,
) -> Option<MarkSpec> {
    let sup = cx.try_global::<Supervisor>()?;
    let pres = evaluate_paper_sync_mark(
        &sup.snapshot.health,
        book_id,
        is_trailing_pane,
        last_typing_ms,
        now_ms,
    );
    let corner_state = pres.corner?;
    let visual = match pres.visual {
        SyncStatusVisual::Hidden => return None,
        SyncStatusVisual::BreathingCloud => MarkVisual::BreathingCloud,
        SyncStatusVisual::BlinkingCloud => MarkVisual::BlinkingCloud,
        SyncStatusVisual::LooseSandCloud => MarkVisual::LooseSandCloud,
        SyncStatusVisual::DangerExclamation => MarkVisual::DangerExclamation,
    };

    let locale = Strings::get(cx).locale();
    let copy = sync_status_copy(corner_state, locale);

    let pending_total =
        sup.snapshot.pending_docs + sup.snapshot.pending_assets + sup.snapshot.pending_purges;
    let meta = if pending_total > 0 {
        Some(SharedString::from(format!(
            "↑ {} · seq {}",
            pending_total, sup.snapshot.cursor
        )))
    } else if matches!(corner_state, SyncCornerState::Problem(_)) {
        sup.snapshot
            .health
            .last_error
            .as_deref()
            .map(|e| SharedString::from(truncate_error(e, 72)))
    } else if matches!(corner_state, SyncCornerState::Syncing) {
        Some(SharedString::from(format!("seq {}", sup.snapshot.cursor)))
    } else {
        None
    };

    let progress = matches!(corner_state, SyncCornerState::Syncing)
        .then_some(if pending_total > 0 { 0.45 } else { 0.82 });

    let retry_cb = retry_action_callback();
    let actions = pres
        .actions
        .iter()
        .map(|act| match act {
            SyncStatusAction::Retry => {
                let cb = retry_cb.clone();
                MarkAction {
                    id: "retry",
                    icon: Icon::Rotate,
                    label: sync_action_label(*act, locale),
                    run: cb,
                }
            }
            SyncStatusAction::SignIn => MarkAction {
                id: "sign-in",
                icon: Icon::GateIn,
                label: sync_action_label(*act, locale),
                run: Rc::new(open_auth_dialog),
            },
            SyncStatusAction::OpenSettings => MarkAction {
                id: "open-settings",
                icon: Icon::DharmaWheel,
                label: sync_action_label(*act, locale),
                run: Rc::new(|window, cx| {
                    settings::open_section(Section::Account, window, cx);
                }),
            },
        })
        .collect();

    Some(MarkSpec {
        visual,
        faded_for_typing: pres.faded_for_typing,
        title: copy.title,
        detail: copy.detail,
        meta,
        progress,
        actions,
    })
}

fn truncate_error(s: &str, max_chars: usize) -> String {
    let mut chars = s.chars();
    let head: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

fn reconcile(cx: &mut App) {
    if !cx.has_global::<Supervisor>() || dr_shell::release::is_releasing(cx) {
        return;
    }

    let ws = cx
        .try_global::<dr_shell::Services>()
        .and_then(|s| s.library.clone());
    let ws_root = ws.as_ref().map(|w| w.library().paths().root.clone());

    if let Some(target_dir) = cx
        .try_global::<AccountUiService>()
        .map(|s| s.state.active_library_dir.clone())
        .filter(|p| !p.as_os_str().is_empty())
    {
        let changed =
            cx.global::<Supervisor>().last_account_target_dir.as_ref() != Some(&target_dir);
        if changed {
            let sup = cx.global_mut::<Supervisor>();
            sup.last_account_target_dir = Some(target_dir.clone());
            if ws_root.as_ref() != Some(&target_dir) {
                sup.pending_library_switch = Some((target_dir.clone(), 0));
            } else {
                sup.pending_library_switch = None;
                sup.switch_retry_task = None;
            }
        } else if ws_root.as_ref() == Some(&target_dir) {
            let sup = cx.global_mut::<Supervisor>();
            sup.pending_library_switch = None;
            sup.switch_retry_task = None;
        }
    }

    if let Some((pending_dir, attempts)) = cx.global::<Supervisor>().pending_library_switch.clone()
        && ws_root.as_ref() != Some(&pending_dir)
    {
        let still_active_in_registry = cx
            .try_global::<AccountUiService>()
            .and_then(|svc| {
                let data_dir = svc.inner.data_dir();
                LibraryRegistry::load_or_init(data_dir)
                    .ok()
                    .map(|r| r.active_library_dir(data_dir) == pending_dir)
            })
            .unwrap_or(false);
        if still_active_in_registry && attempts < 30 {
            schedule_library_switch_retry(pending_dir, attempts + 1, cx);
            return;
        }
        let sup = cx.global_mut::<Supervisor>();
        sup.pending_library_switch = None;
        sup.switch_retry_task = None;
    }

    let desired_mode = match cx.try_global::<AccountUiService>() {
        None => SyncSessionMode::LocalOnly,
        Some(svc) if !svc.state.hosted_configured => SyncSessionMode::LocalOnly,
        Some(svc) if svc.state.status == SessionStatus::Checking => {
            // Keep any open workspace wired to the status controller while
            // cold-start session bootstrap resolves in the background.
            if let Some(w) = &ws {
                let runtime = Arc::clone(&cx.global::<Supervisor>().runtime);
                let already_set = cx.global::<Supervisor>().last_configured.is_some();
                if !already_set {
                    let target = attach_workspace_target(w, &runtime);
                    runtime.configure_async(Some(target), SyncSessionMode::SignedOut);
                }
            }
            return;
        }
        Some(svc)
            if !svc.state.is_account_library || svc.state.status == SessionStatus::SignedOut =>
        {
            SyncSessionMode::SignedOut
        }
        Some(svc)
            if ws_root
                .as_ref()
                .is_none_or(|current_root| *current_root != svc.state.active_library_dir) =>
        {
            // Another local library (e.g. an M10 `reimport-v3-*` destination) is
            // currently open instead of the account library: keep Hosted Sync
            // paused in `SignedOut` mode on this workspace.
            if ws_root.is_none() {
                return;
            }
            SyncSessionMode::SignedOut
        }
        Some(svc) if svc.state.status == SessionStatus::NeedsReauth => {
            SyncSessionMode::NeedsReauth {
                library_root: svc.state.active_library_dir.clone(),
            }
        }
        Some(svc) => {
            let Some(current_root) = &ws_root else {
                return;
            };
            let base_url = svc
                .state
                .origin
                .as_ref()
                .map(|o| o.as_str().to_owned())
                .unwrap_or_default();
            let user_id = svc
                .state
                .user
                .as_ref()
                .map(|u| u.id.clone())
                .unwrap_or_default();
            match svc.inner.current_token() {
                Some(access_token) if !base_url.is_empty() && !user_id.is_empty() => {
                    SyncSessionMode::Connected {
                        base_url,
                        user_id,
                        access_token,
                        library_root: current_root.clone(),
                    }
                }
                _ => SyncSessionMode::OfflineAccount {
                    library_root: current_root.clone(),
                },
            }
        }
    };

    let key = (ws_root, desired_mode.clone());
    if cx.global::<Supervisor>().last_configured.as_ref() == Some(&key) {
        return;
    }

    let runtime = Arc::clone(&cx.global::<Supervisor>().runtime);
    let target = ws.as_ref().map(|w| attach_workspace_target(w, &runtime));
    runtime.configure_async(target, desired_mode);
    cx.global_mut::<Supervisor>().last_configured = Some(key);
}

/// Retries an account-library `dr_shell::library::replace` when an earlier
/// cold-start or first-run sign-in switch raced a short-lived background
/// `Workspace` clone (such as `first_run::write_samples`).
fn schedule_library_switch_retry(target_dir: PathBuf, next_attempt: u8, cx: &mut App) {
    if cx.global::<Supervisor>().switch_retry_task.is_some() {
        return;
    }
    cx.global_mut::<Supervisor>().pending_library_switch = Some((target_dir.clone(), next_attempt));
    let task = cx.spawn(async move |cx| {
        cx.background_executor()
            .timer(Duration::from_millis(250))
            .await;
        cx.update(|cx| {
            if !cx.has_global::<Supervisor>() {
                return;
            }
            cx.global_mut::<Supervisor>().switch_retry_task = None;
            if dr_shell::release::is_releasing(cx) {
                return;
            }
            let current_root = cx
                .try_global::<dr_shell::Services>()
                .and_then(|s| s.library.as_ref())
                .map(|w| w.library().paths().root.clone());
            if current_root.as_ref() == Some(&target_dir) {
                cx.global_mut::<Supervisor>().pending_library_switch = None;
                reconcile(cx);
                return;
            }
            let still_wanted = cx
                .try_global::<AccountUiService>()
                .is_some_and(|s| s.state.active_library_dir == target_dir);
            if !still_wanted {
                cx.global_mut::<Supervisor>().pending_library_switch = None;
                reconcile(cx);
                return;
            }
            let open_dir = target_dir.clone();
            dr_shell::library::replace(
                cx,
                move |_old_root, options| {
                    dr_store::Library::open(&open_dir, options).map_err(|e| e.to_string())
                },
                move |res, cx| {
                    if res.is_ok() && cx.has_global::<Supervisor>() {
                        cx.global_mut::<Supervisor>().pending_library_switch = None;
                    }
                    reconcile(cx);
                },
            );
        });
    });
    cx.global_mut::<Supervisor>().switch_retry_task = Some(task);
}

fn on_runtime_snapshot(snap: SyncRuntimeSnapshot, cx: &mut App) {
    if !cx.has_global::<Supervisor>() {
        return;
    }

    let prev_ok_ms = cx.global::<Supervisor>().snapshot.last_sync_ok_ms;
    cx.global_mut::<Supervisor>().snapshot = snap.clone();

    // Propagate 401 token expiry or offline recovery back into `AccountUiService`.
    if snap.health.reauth_required
        && let Some(svc) = cx.try_global::<AccountUiService>()
        && svc.state.status == SessionStatus::Connected
    {
        let mut next = svc.state.clone();
        next.status = SessionStatus::NeedsReauth;
        apply_account_state(next, cx);
    } else if snap.last_sync_ok_ms != prev_ok_ms
        && snap.last_sync_ok_ms.is_some()
        && let Some(svc) = cx.try_global::<AccountUiService>()
        && svc.state.status == SessionStatus::Offline
    {
        let inner = Arc::clone(&svc.inner);
        cx.spawn(async move |cx| {
            let refreshed = cx
                .background_executor()
                .spawn(async move { inner.bootstrap() })
                .await;
            cx.update(|cx| apply_account_state(refreshed, cx));
        })
        .detach();
    }

    refresh_sync_ui(cx);
}

fn refresh_sync_ui(cx: &mut App) {
    if !cx.has_global::<Supervisor>() {
        return;
    }
    let now_ms = dr_shell::sync::current_time_ms();
    let health = cx.global::<Supervisor>().snapshot.health.clone();
    reconcile_sync_problem_notifications(&health, now_ms, Some(retry_action_callback()), cx);

    // Ensure every active `Source::Sync` problem notice stays pinned at the top
    // of the notification center and lights the bell's danger seal.
    let sync_ids: Vec<u64> = Notifications::items(cx)
        .iter()
        .filter(|n| n.source == Source::Sync && !n.pinned)
        .map(|n| n.id)
        .collect();
    for id in sync_ids {
        Notifications::set_pinned(id, true, cx);
    }

    schedule_threshold_wakeup(&health, now_ms, cx);
    cx.refresh_windows();
}

fn schedule_threshold_wakeup(health: &dr_sync::SyncHealthSnapshot, now_ms: u64, cx: &mut App) {
    let mut candidates = Vec::with_capacity(4);
    if let Some(busy_since) = health.library_busy_since_ms {
        let show_at = busy_since.saturating_add(SYNC_MARK_SHOW_AFTER_MS);
        if show_at > now_ms {
            candidates.push(show_at);
        }
    }
    if let Some(linger_until) = health.library_busy_until_ms
        && linger_until > now_ms
    {
        candidates.push(linger_until);
    }
    if let Some(failed_since) = health.library_failing_since_ms {
        let retry_at = failed_since.saturating_add(SYNC_RETRY_SHOW_AFTER_MS);
        if retry_at > now_ms {
            candidates.push(retry_at);
        }
        let failing_at = failed_since.saturating_add(SYNC_FAILING_FOR_MS);
        if failing_at > now_ms {
            candidates.push(failing_at);
        }
    }

    let next_task = candidates.into_iter().min().map(|deadline_ms| {
        let wait_ms = deadline_ms.saturating_sub(now_ms).saturating_add(20);
        cx.spawn(async move |cx| {
            cx.background_executor()
                .timer(Duration::from_millis(wait_ms))
                .await;
            cx.update(refresh_sync_ui);
        })
    });
    cx.global_mut::<Supervisor>().threshold_task = next_task;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    use dr_account::{HostedOrigin, LibraryRegistry};
    use dr_platform::Identity;
    use dr_shell::{Services, SettingsFile, ShellInfo};
    use dr_sync::FakeSyncServer;
    use dr_testkit::seed::{self, Preset};
    use dr_workspace::{Actor, Workspace};
    use gpui::TestAppContext;
    use serde_json::json;

    fn install_shell(ws: Workspace, cx: &mut App) {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-test",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(ws),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
    }

    #[gpui::test]
    fn local_only_supervisor_makes_zero_network_requests(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let server = FakeSyncServer::start("synthetic-local-only-token");
        let tmp = tempfile::tempdir().unwrap();
        let lib_dir = tmp.path().join("library");
        let ws = Workspace::open_dir(&lib_dir, "0.2.0-test").unwrap();
        seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED)
            .unwrap()
            .write_to(ws.library())
            .unwrap();

        let platform = Identity::current();
        let acct = AccountService::new(
            HostedConfig::local_only(),
            tmp.path(),
            platform.url_scheme,
            Arc::new(SecretStore::in_memory()),
        )
        .unwrap();

        cx.update(|cx| {
            install_shell(ws, cx);
            dr_view_account::init(AccountUiService::with_service(Arc::new(acct)), cx);
            init(platform, cx);
            register_final_drain(cx);
        });
        cx.run_until_parked();

        cx.update(|cx| {
            let ws = cx.global::<Services>().library.as_ref().unwrap();
            let status = ws.call(&Actor::User, "sync.status", json!({})).unwrap();
            assert_eq!(status["output"]["mode"], "local_only");
            assert!(dr_shell::sync::evaluate_mark(Some("b1"), false, None, 10_000, cx).is_none());
            assert!(!Notifications::has_pinned(cx));
        });
        assert_eq!(server.sync_request_count(), 0);
    }

    #[gpui::test]
    fn supervisor_auto_syncs_pins_severe_notices_and_drains_on_release(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let token = "synthetic-supervisor-token-001".to_owned();
        let server = FakeSyncServer::start(&token);
        let origin = HostedOrigin::parse(server.base_url()).unwrap();
        let config = HostedConfig::with_origin(origin.clone());

        let tmp = tempfile::tempdir().unwrap();
        let secrets = Arc::new(SecretStore::in_memory());
        SessionTokenStore::new(Arc::clone(&secrets))
            .write(&origin, &token)
            .unwrap();

        // Pre-settle the isolated account library for `u_sup_test`.
        let platform = Identity::current();
        let acct = Arc::new(
            AccountService::new(config, tmp.path(), platform.url_scheme, secrets).unwrap(),
        );
        let settled = acct.bootstrap();
        assert_eq!(settled.status, SessionStatus::Connected);
        assert!(settled.is_account_library);

        let ws_a = Workspace::open_dir(&settled.active_library_dir, "0.2.0-test").unwrap();
        seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED)
            .unwrap()
            .write_to(ws_a.library())
            .unwrap();

        cx.update(|cx| {
            install_shell(ws_a, cx);
            dr_view_account::init(AccountUiService::with_service(Arc::clone(&acct)), cx);
            init(platform, cx);
            register_final_drain(cx);
        });

        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            cx.run_until_parked();
            let synced = cx.update(|cx| {
                cx.global::<Supervisor>().snapshot.completed_cycles >= 1
                    && cx.global::<Supervisor>().snapshot.pending_docs == 0
            });
            if synced {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for initial supervisor sync"
            );
            std::thread::sleep(Duration::from_millis(25));
        }

        // Verify mark visuals (syncing typing fade, trailing pane suppression, severe notice pinning).
        cx.update(|cx| {
            let mut snap = cx.global::<Supervisor>().snapshot.clone();
            snap.health.hosted_enabled = true;
            snap.health.library_busy = true;
            snap.health.library_busy_since_ms = Some(1_000);
            on_runtime_snapshot(snap.clone(), cx);

            // Leading pane after 3.5s shows breathing cloud; trailing pane stays hidden; typing fades it.
            let m_lead = dr_shell::sync::evaluate_mark(Some("b1"), false, None, 4_500, cx)
                .expect("leading syncing mark");
            assert_eq!(m_lead.visual, MarkVisual::BreathingCloud);
            assert!(!m_lead.faded_for_typing);
            assert!(dr_shell::sync::evaluate_mark(Some("b1"), true, None, 4_500, cx).is_none());
            let m_typing = dr_shell::sync::evaluate_mark(Some("b1"), false, Some(4_000), 4_500, cx)
                .expect("typing syncing mark");
            assert!(m_typing.faded_for_typing);

            // Quota problem displays DangerExclamation and pins a Source::Sync row.
            snap.health.library_busy = false;
            snap.health.library_busy_since_ms = None;
            snap.health.quota_exceeded = true;
            on_runtime_snapshot(snap.clone(), cx);
            let m_quota = dr_shell::sync::evaluate_mark(Some("b1"), false, None, 5_000, cx)
                .expect("quota problem mark");
            assert_eq!(m_quota.visual, MarkVisual::DangerExclamation);
            assert!(Notifications::has_pinned(cx));

            // Recovery clears the pinned notice.
            snap.health.quota_exceeded = false;
            on_runtime_snapshot(snap, cx);
            assert!(!Notifications::has_pinned(cx));
        });

        // Write a new book right before switching back to the local library via `dr_shell::library::replace`
        // and verify `register_final_drain` uploads it and releases the handle cleanly.
        let created_book_id = cx.update(|cx| {
            let ws = cx.global::<Services>().library.as_ref().unwrap();
            let created = ws
                .call(
                    &Actor::User,
                    "project.create",
                    json!({ "name": "切库前排空验证" }),
                )
                .unwrap();
            created["output"]["id"].as_str().unwrap().to_owned()
        });

        let local_root = LibraryRegistry::load_or_init(tmp.path())
            .unwrap()
            .local_library_dir(tmp.path());
        let (done_tx, mut done_rx) = futures::channel::oneshot::channel();
        cx.update(|cx| {
            dr_shell::library::replace(
                cx,
                move |_, options| {
                    dr_store::Library::open(&local_root, options).map_err(|e| e.to_string())
                },
                move |res, _| {
                    let _ = done_tx.send(res);
                },
            );
        });

        let swap_deadline = Instant::now() + Duration::from_secs(15);
        let swap_res = loop {
            cx.run_until_parked();
            if let Ok(Some(res)) = done_rx.try_recv() {
                break res;
            }
            assert!(
                Instant::now() < swap_deadline,
                "timed out waiting for library::replace"
            );
            std::thread::sleep(Duration::from_millis(25));
        };
        assert_eq!(swap_res, Ok(()));

        // Verify a second peer receives `created_book_id` from `FakeSyncServer`!
        let peer_dir = tempfile::tempdir().unwrap();
        let ws_peer = Workspace::open_dir(peer_dir.path(), "0.2.0-test").unwrap();
        let mut peer_engine =
            dr_sync::SyncEngine::new(server.base_url(), ws_peer.library()).unwrap();
        peer_engine.sync_once(ws_peer.library(), &token).unwrap();
        let shelf = ws_peer.call(&Actor::User, "book.shelf", json!({})).unwrap();
        let ids: Vec<&str> = shelf["output"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|b| b["id"].as_str())
            .collect();
        assert!(
            ids.contains(&created_book_id.as_str()),
            "expected peer shelf {ids:?} to contain drained book {created_book_id}"
        );
    }

    #[gpui::test]
    fn cold_start_account_switch_retries_past_transient_workspace_clone(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let token = "synthetic-cold-retry-token-002".to_owned();
        let server = FakeSyncServer::start(&token);
        let origin = HostedOrigin::parse(server.base_url()).unwrap();
        let config = HostedConfig::with_origin(origin.clone());

        let tmp = tempfile::tempdir().unwrap();
        let secrets = Arc::new(SecretStore::in_memory());
        SessionTokenStore::new(Arc::clone(&secrets))
            .write(&origin, &token)
            .unwrap();

        // Startup opens `<tmp>/library` before `bootstrap()` resolves the user id,
        // and holds a short-lived `Workspace` clone (simulating `first_run::write_samples`).
        let local_dir = tmp.path().join("library");
        let ws_local = Workspace::open_dir(&local_dir, "0.2.0-test").unwrap();
        let transient_clone = ws_local.clone();

        let platform = Identity::current();
        let acct = Arc::new(
            AccountService::new(config, tmp.path(), platform.url_scheme, secrets).unwrap(),
        );
        assert_eq!(acct.state().status, SessionStatus::Checking);
        assert!(!acct.state().is_account_library);

        cx.update(|cx| {
            install_shell(ws_local, cx);
            dr_view_account::init(AccountUiService::with_service(Arc::clone(&acct)), cx);
            init(platform, cx);
            register_final_drain(cx);
        });

        // Let initial `bootstrap()` fire while `transient_clone` is still alive, then release it.
        cx.run_until_parked();
        drop(transient_clone);

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.executor().advance_clock(Duration::from_millis(300));
            cx.run_until_parked();
            let switched_and_connected = cx.update(|cx| {
                let Some(ws) = cx.global::<Services>().library.as_ref() else {
                    return false;
                };
                let wanted = cx
                    .global::<AccountUiService>()
                    .state
                    .active_library_dir
                    .clone();
                ws.library().paths().root == wanted
                    && cx.global::<Supervisor>().snapshot.mode == "connected"
            });
            if switched_and_connected {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for supervisor retry to switch to account library"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}
