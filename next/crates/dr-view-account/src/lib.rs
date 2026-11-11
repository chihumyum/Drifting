//! Hosted account sign-in, first-run welcome step, profile editor, password change,
//! and per-account library switching (M35, `dr-view-account`).

pub mod dialog;
pub mod settings_view;
pub mod sync_mark;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use dr_account::{
    AccountService, AccountState, HostedConfig, PreferenceLedger, SessionStatus, decode_avatar_rgba,
};
use dr_i18n::keys;
use dr_platform::{Identity, SecretStore};
use dr_shell::{
    Services, Settings,
    account::{AccountMenuAction, AccountViewInfo},
    settings::registry::{self, Section},
    t,
};
use dr_ui::{
    Theme,
    components::Button,
    fonts::{Role, weight},
    style::DrStyled,
    tokens::space,
};
use dr_view_sea::first_run::{self, Done, Step};
use gpui::{
    AnyElement, App, AppContext as _, BorrowAppContext as _, Global, IntoElement, ParentElement,
    RenderImage, SharedString, Styled, Window, div, px,
};
use image::{Frame, RgbaImage};
use smallvec::SmallVec;

pub use dialog::{AuthDialog, AuthMode};
pub use settings_view::AccountSettingsView;
pub use sync_mark::{
    PAPER_SYNC_CORNER_INSET, PinnedSyncNotices, SyncStatusCopy, paper_sync_mark_for,
    reconcile_sync_problem_notifications, render_paper_sync_mark, sync_action_label,
    sync_status_copy,
};

/// Device-memory key remembering that the first-run account choice has been answered.
pub const FIRST_RUN_ACCOUNT_SEEN_KEY: &str = "account.first_run_seen";

/// Debounce delay before pushing local preference edits to Hosted.
pub const PREFERENCE_SYNC_DEBOUNCE: Duration = Duration::from_secs(1);

/// Global state for `dr-view-account`.
pub struct Service {
    pub inner: Arc<AccountService>,
    pub state: AccountState,
    pub avatar_cache: Option<(String, Arc<RenderImage>)>,
    pub signing_out: bool,
    preference_sync_task: Option<gpui::Task<()>>,
}

impl Global for Service {}

impl Service {
    /// Construct the account service for this build (`HostedConfig::for_build` + `SecretStore::for_identity`).
    pub fn for_build(identity: &Identity, data_dir: Option<&Path>) -> Self {
        let config = HostedConfig::for_build(identity);
        let dir = data_dir
            .map(Path::to_path_buf)
            .unwrap_or_else(std::env::temp_dir);
        let secrets = Arc::new(SecretStore::for_identity(identity));
        let inner = Arc::new(
            AccountService::new(config, dir, identity.url_scheme, secrets).unwrap_or_else(|_| {
                AccountService::new(
                    HostedConfig::local_only(),
                    std::env::temp_dir(),
                    identity.url_scheme,
                    Arc::new(SecretStore::in_memory()),
                )
                .expect("fallback local-only AccountService")
            }),
        );
        Self::with_service(inner)
    }

    /// Construct from an existing [`AccountService`] (used by tests with `FakeAuthServer`).
    #[must_use]
    pub fn with_service(inner: Arc<AccountService>) -> Self {
        let state = inner.state();
        let avatar_cache = state
            .user
            .as_ref()
            .and_then(|u| u.image.as_deref())
            .and_then(|url| build_avatar_render_image(url).map(|img| (url.to_owned(), img)));
        Self {
            inner,
            state,
            avatar_cache,
            signing_out: false,
            preference_sync_task: None,
        }
    }
}

fn build_avatar_render_image(data_url: &str) -> Option<Arc<RenderImage>> {
    let (w, h, rgba) = decode_avatar_rgba(data_url).ok()?;
    let mut bgra = RgbaImage::new(w, h);
    let (pixels, _) = rgba.as_chunks::<4>();
    for (dst, src) in bgra.pixels_mut().zip(pixels) {
        dst.0 = [src[2], src[1], src[0], src[3]];
    }
    Some(Arc::new(RenderImage::new(SmallVec::from_elem(
        Frame::new(bgra),
        1,
    ))))
}

/// Installs `dr-view-account`:
/// - Registers the first-run welcome/account step (`WelcomeStep`) when Hosted is configured;
/// - Hooks the sidebar & shelf account cell and menu (`dr_shell::account::set_hook`);
/// - Registers the `Settings → Account` panel (`"account.hosted"`);
/// - Registers the `auth/` deep-link OAuth callback handler;
/// - Starts background session bootstrap (`GET /api/auth/get-session`).
pub fn init(service: Service, cx: &mut App) {
    let inner = service.inner.clone();
    let initial_state = service.state.clone();
    cx.set_global(service);

    dr_view_feedback::Service::set_session(inner.current_token(), cx);

    // Seed built-in sample books only if the startup library is the local library.
    if !initial_state.is_account_library
        && let Some(lib) = cx.try_global::<Services>().and_then(|s| s.library.clone())
    {
        first_run::write_samples(lib, cx).detach();
    }

    // First-run Welcome / Account step (before M40's FolderStep when `init` runs before `dr_view_sea::shell::init`).
    first_run::add_step(cx, |_, cx| {
        let seen = Settings::device_memory(cx, FIRST_RUN_ACCOUNT_SEEN_KEY)
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let svc = cx.try_global::<Service>()?;
        if seen || !svc.state.hosted_configured || svc.state.status.has_account() {
            return None;
        }
        Some(Rc::new(WelcomeStep) as Rc<dyn Step>)
    });

    // Account cell & menu hook in `dr-shell`.
    dr_shell::account::set_hook(cx, |cx| {
        use keys::settings::hosted::session as sess;
        use keys::user_menu as um;
        let Some(svc) = cx.try_global::<Service>() else {
            return AccountViewInfo::default();
        };
        let state = &svc.state;
        let signed_in = state.status.has_account();
        let display_name = state
            .user
            .as_ref()
            .map(|u| SharedString::from(u.display_name().to_owned()));
        let status_line = Some(match state.status {
            SessionStatus::SignedOut => t(cx, um::LOCAL_STATUS),
            SessionStatus::Checking => t(cx, sess::CHECKING),
            SessionStatus::Connected => t(cx, sess::CONNECTED),
            SessionStatus::Offline => t(cx, sess::OFFLINE),
            SessionStatus::NeedsReauth => t(cx, sess::NEEDS_REAUTH),
        });
        let avatar = svc.avatar_cache.as_ref().map(|(_, img)| img.clone());
        let on_header_click: Option<dr_shell::account::AccountCallback> =
            state.hosted_configured.then(|| {
                Rc::new(|window: &mut Window, cx: &mut App| {
                    dr_shell::settings::open_section(Section::Account, window, cx);
                }) as dr_shell::account::AccountCallback
            });

        let action = if !state.hosted_configured {
            None
        } else if signed_in && state.status != SessionStatus::NeedsReauth {
            let busy = svc.signing_out;
            let label = if busy {
                t(cx, um::SIGNING_OUT)
            } else {
                t(cx, um::SIGN_OUT)
            };
            Some(AccountMenuAction {
                label,
                disabled: busy,
                on_click: Rc::new(|_, cx| sign_out(cx)),
            })
        } else {
            Some(AccountMenuAction {
                label: t(cx, keys::auth::SIGN_IN),
                disabled: false,
                on_click: Rc::new(open_auth_dialog),
            })
        };

        AccountViewInfo {
            signed_in,
            hosted_configured: state.hosted_configured,
            display_name,
            status_line,
            avatar,
            on_header_click,
            action,
        }
    });

    // Settings → Account module row.
    if initial_state.hosted_configured {
        dr_shell::settings::set_module_row(cx, "account.hosted", |window, cx| {
            cx.new(|cx| AccountSettingsView::new(window, cx))
                .into_any_element()
        });
    }

    // OAuth callback deep-link handler (`drifting://auth/callback?...`).
    dr_shell::account::set_auth_link_handler(cx, |url, _window, cx| {
        handle_oauth_deep_link(url.to_owned(), cx);
    });

    // Bootstrap session in background when Hosted is configured.
    if initial_state.hosted_configured {
        let bg_inner = inner;
        cx.spawn(async move |cx| {
            let state = cx
                .background_executor()
                .spawn(async move { bg_inner.bootstrap() })
                .await;
            cx.update(|cx| apply_account_state(state, cx));
        })
        .detach();
    }
}

/// Opens the [`AuthDialog`] modal over the workspace in `window`.
pub fn open_auth_dialog(window: &mut Window, cx: &mut App) {
    let handle = window.window_handle();
    let slot: Rc<std::cell::Cell<Option<gpui::EntityId>>> = Rc::new(std::cell::Cell::new(None));
    let slot_close = slot.clone();
    let close: dr_shell::dialogs::Close = Rc::new(move |_, cx| {
        if let Some(id) = slot_close.get() {
            dr_shell::dialogs::hide(cx, id);
        }
    });
    let view = cx.new(|cx| AuthDialog::new(close, window, cx));
    slot.set(Some(view.entity_id()));
    dr_shell::dialogs::show_in(handle, cx, view.into());
}

/// Drains pending Hosted sync uploads (via [`dr_shell::sync::run_before_sign_out`])
/// while the session token is still valid, then signs out of the current Hosted
/// account in the background and switches back to the local library.
pub fn sign_out(cx: &mut App) {
    let Some(inner) = cx
        .try_global::<Service>()
        .filter(|s| !s.signing_out)
        .map(|s| s.inner.clone())
    else {
        return;
    };
    cx.update_global::<Service, _>(|svc, _| {
        svc.signing_out = true;
    });
    cx.refresh_windows();
    let pre_drain = dr_shell::sync::run_before_sign_out(cx);
    cx.spawn(async move |cx| {
        if let Some(drain_fut) = pre_drain {
            drain_fut.await;
        }
        let res = cx
            .background_executor()
            .spawn(async move { inner.sign_out() })
            .await;
        cx.update(|cx| {
            if cx.has_global::<Service>() {
                cx.update_global::<Service, _>(|svc, _| {
                    svc.signing_out = false;
                });
            }
            if let Ok(state) = res {
                apply_account_state(state, cx);
            }
            cx.refresh_windows();
        });
    })
    .detach();
}

/// Handles a `drifting://auth/callback?...` deep link off the main thread.
pub fn handle_oauth_deep_link(url: String, cx: &mut App) {
    let Some(inner) = cx.try_global::<Service>().map(|s| s.inner.clone()) else {
        return;
    };
    cx.spawn(async move |cx| {
        let res = cx
            .background_executor()
            .spawn(async move { inner.complete_oauth_callback_url(&url) })
            .await;
        cx.update(|cx| {
            if let Ok(state) = res {
                apply_account_state(state, cx);
            }
        });
    })
    .detach();
}

/// Applies a new [`AccountState`] to the global [`Service`], updates `dr_view_feedback`,
/// marks the first-run welcome step as answered when signed in, and switches the open
/// `dr_store::Library` via `dr_shell::library::replace` if `active_library_dir` changed.
pub fn apply_account_state(state: AccountState, cx: &mut App) {
    if !cx.has_global::<Service>() {
        return;
    }
    let token = cx.global::<Service>().inner.current_token();
    dr_view_feedback::Service::set_session(token, cx);

    if state.status.has_account() {
        Settings::set_device_memory(cx, FIRST_RUN_ACCOUNT_SEEN_KEY, Some(true.into()));
    }

    let target_dir = state.active_library_dir.clone();
    let is_account_lib = state.is_account_library;

    let is_connected = state.status == SessionStatus::Connected;
    cx.update_global::<Service, _>(|svc, _| {
        let next_avatar_url = state
            .user
            .as_ref()
            .and_then(|u| u.image.as_deref())
            .map(ToOwned::to_owned);
        match next_avatar_url {
            Some(url) => {
                let already_cached = svc
                    .avatar_cache
                    .as_ref()
                    .is_some_and(|(cached_url, _)| cached_url == &url);
                if !already_cached {
                    svc.avatar_cache = build_avatar_render_image(&url).map(|img| (url, img));
                }
            }
            None => {
                svc.avatar_cache = None;
            }
        }
        svc.state = state;
    });

    switch_library_if_needed(target_dir, is_account_lib, cx);
    if is_connected {
        sync_preferences_now(cx);
    }
    cx.refresh_windows();
}

/// Schedules a debounced (1s) M37 preference sync round when connected.
pub fn schedule_preference_sync(cx: &mut App) {
    let Some(svc) = cx.try_global::<Service>() else {
        return;
    };
    if svc.state.status != SessionStatus::Connected {
        return;
    }
    let task = cx.spawn(async move |cx| {
        cx.background_executor()
            .timer(PREFERENCE_SYNC_DEBOUNCE)
            .await;
        cx.update(sync_preferences_now);
    });
    cx.global_mut::<Service>().preference_sync_task = Some(task);
}

/// Device-memory key storing the M37 preference sync ledger and last-synced baseline.
pub const PREFERENCE_LEDGER_MEMORY_KEY: &str = "account.preference_ledger";

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
struct StoredPreferenceState {
    #[serde(default)]
    ledger: PreferenceLedger,
    #[serde(default)]
    baseline: BTreeMap<String, serde_json::Value>,
}

/// Whether `key` is an account-synced preference (M37).
///
/// Account-scoped settings (`Scope::Account`, except BYOK model selection
/// `agent.provider` / `agent.model` / `agent.thinking`) and `keys.bindings`
/// follow the account; device-scoped (`Scope::Device`), book-scoped
/// (`Scope::Book`), BYOK keys and `modules` device memory stay local to this
/// device.
pub fn follows_account(key: &str) -> bool {
    if matches!(
        key,
        registry::AGENT_PROVIDER | registry::AGENT_MODEL | registry::AGENT_THINKING
    ) {
        return false;
    }
    key == dr_shell::settings::store::KEY_BINDINGS
        || registry::find(key).is_some_and(|d| d.scope == registry::Scope::Account)
}

/// All setting keys that participate in M37 account preference sync.
pub fn synced_preference_keys() -> Vec<&'static str> {
    let mut keys: Vec<&'static str> = registry::REGISTRY
        .iter()
        .filter(|d| follows_account(d.key))
        .map(|d| d.key)
        .collect();
    keys.push(dr_shell::settings::store::KEY_BINDINGS);
    keys
}

/// Read the effective value of an account-synced preference from `file`.
pub fn read_synced_preference(
    file: &dr_shell::SettingsFile,
    key: &str,
) -> Option<serde_json::Value> {
    if !follows_account(key) {
        return None;
    }
    if key == dr_shell::settings::store::KEY_BINDINGS {
        return Some(serde_json::Value::Object(file.key_bindings()));
    }
    let def = registry::find(key)?;
    Some(file.value(def, None))
}

fn read_explicit_synced_preference(
    file: &dr_shell::SettingsFile,
    key: &str,
) -> Option<serde_json::Value> {
    if !follows_account(key) {
        return None;
    }
    if key == dr_shell::settings::store::KEY_BINDINGS {
        let bindings = file.key_bindings();
        return (!bindings.is_empty()).then_some(serde_json::Value::Object(bindings));
    }
    let def = registry::find(key)?;
    file.stored(def, None)
}

/// Apply a remote account-synced preference value to `file`.
pub fn apply_synced_preference(
    file: &mut dr_shell::SettingsFile,
    key: &str,
    value: &serde_json::Value,
) -> bool {
    if !follows_account(key) {
        return false;
    }
    if key == dr_shell::settings::store::KEY_BINDINGS {
        let existing: Vec<String> = file.key_bindings().keys().cloned().collect();
        for id in existing {
            file.set_key_binding(&id, None);
        }
        if let serde_json::Value::Object(map) = value {
            for (id, v) in map {
                if let Some(s) = v.as_str() {
                    file.set_key_binding(id, Some(s));
                }
            }
        }
        return true;
    }
    if value.is_null() {
        file.reset(key, None)
    } else {
        file.set(key, value.clone(), None).unwrap_or(false)
    }
}

/// Whether `file` has any account-synced preference awaiting upload.
pub fn has_pending_synced_preferences(file: &dr_shell::SettingsFile) -> bool {
    let (_, _, ledger) = snapshot_synced_preferences(file);
    ledger.entries.values().any(|e| e.pending)
}

fn load_stored_preference_state(file: &dr_shell::SettingsFile) -> StoredPreferenceState {
    file.device_memory(PREFERENCE_LEDGER_MEMORY_KEY)
        .and_then(|v| serde_json::from_value::<StoredPreferenceState>(v.clone()).ok())
        .unwrap_or_default()
}

fn save_stored_preference_state(file: &mut dr_shell::SettingsFile, state: &StoredPreferenceState) {
    if let Ok(val) = serde_json::to_value(state) {
        file.set_device_memory(PREFERENCE_LEDGER_MEMORY_KEY, Some(val));
    }
}

/// Runs an M37 preference sync round immediately on the background executor when connected.
pub fn sync_preferences_now(cx: &mut App) {
    let Some(svc) = cx.try_global::<Service>() else {
        return;
    };
    if svc.state.status != SessionStatus::Connected || !cx.has_global::<Settings>() {
        return;
    }
    let inner = svc.inner.clone();
    let (keys, local_values, ledger) = snapshot_synced_preferences(Settings::read(cx));

    let task = cx.spawn(async move |cx| {
        let res = cx
            .background_executor()
            .spawn(async move { inner.sync_preferences(&keys, &local_values, &ledger) })
            .await;
        cx.update(|cx| {
            if let Ok(outcome) = res
                && outcome.supported
                && cx.has_global::<Settings>()
            {
                Settings::update(cx, |file| {
                    apply_preference_sync_outcome(file, &outcome);
                });
                let bindings = Settings::read(cx).key_bindings();
                dr_shell::keymap::apply(&bindings, cx);
            }
        });
    });
    cx.global_mut::<Service>().preference_sync_task = Some(task);
}

/// Synchronously runs one M37 preference sync round against `service` and applies the outcome
/// to `file`.
pub fn sync_preferences_blocking(
    service: &AccountService,
    file: &mut dr_shell::SettingsFile,
) -> Result<dr_account::PreferenceSyncOutcome, dr_account::AccountError> {
    let (keys, local_values, ledger) = snapshot_synced_preferences(file);
    let outcome = service.sync_preferences(&keys, &local_values, &ledger)?;
    if outcome.supported {
        apply_preference_sync_outcome(file, &outcome);
    }
    Ok(outcome)
}

fn snapshot_synced_preferences(
    file: &dr_shell::SettingsFile,
) -> (
    Vec<&'static str>,
    BTreeMap<String, serde_json::Value>,
    PreferenceLedger,
) {
    let keys = synced_preference_keys();
    let mut local_values = BTreeMap::new();
    for &key in &keys {
        if let Some(val) = read_synced_preference(file, key) {
            local_values.insert(key.to_owned(), val);
        }
    }
    let stored = load_stored_preference_state(file);
    let mut ledger = stored.ledger;
    let now_iso = current_iso_timestamp();
    for &key in &keys {
        let cur = read_explicit_synced_preference(file, key);
        let base = stored.baseline.get(key).cloned();
        if cur != base {
            let entry = ledger.entries.entry(key.to_owned()).or_default();
            if !entry.pending || entry.changed_at.is_empty() {
                entry.changed_at = now_iso.clone();
                entry.pending = true;
            }
        }
    }
    (keys, local_values, ledger)
}

fn apply_preference_sync_outcome(
    file: &mut dr_shell::SettingsFile,
    outcome: &dr_account::PreferenceSyncOutcome,
) {
    for (key, value) in &outcome.applied {
        apply_synced_preference(file, key, value);
    }
    let mut baseline = BTreeMap::new();
    for key in synced_preference_keys() {
        if let Some(val) = read_explicit_synced_preference(file, key) {
            baseline.insert(key.to_owned(), val);
        }
    }
    let state = StoredPreferenceState {
        ledger: outcome.ledger.clone(),
        baseline,
    };
    save_stored_preference_state(file, &state);
}

fn current_iso_timestamp() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z")
}

fn switch_library_if_needed(target_dir: PathBuf, is_account_lib: bool, cx: &mut App) {
    if target_dir.as_os_str().is_empty() {
        return;
    }
    let current_root = cx
        .try_global::<Services>()
        .and_then(|s| s.library.as_ref())
        .map(|ws| ws.library().paths().root.clone());
    let Some(current_root) = current_root else {
        return;
    };
    if current_root == target_dir {
        return;
    }

    dr_shell::library::replace(
        cx,
        move |_old_root, options| {
            dr_store::Library::open(&target_dir, options).map_err(|e| e.to_string())
        },
        move |res, cx| {
            if let Err(err) = res {
                log::warn!("switching library failed: {err}");
                return;
            }
            if !is_account_lib
                && let Some(lib) = cx.try_global::<Services>().and_then(|s| s.library.clone())
            {
                first_run::write_samples(lib, cx).detach();
            }
            cx.refresh_windows();
        },
    );
}

/// First-run welcome step (`PreAlphaFirstRunGate`): offers Email sign-in or continuing locally.
pub struct WelcomeStep;

impl Step for WelcomeStep {
    fn id(&self) -> &'static str {
        "welcome"
    }

    fn label(&self, cx: &App) -> SharedString {
        t(cx, keys::pre_alpha_guide::TITLE)
    }

    fn width(&self) -> f32 {
        380.0
    }

    fn render(&self, done: Done, window: &mut Window, cx: &mut App) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let done_email = done.clone();
        let done_local = done;

        div()
            .p(px(space::S8))
            .flex()
            .flex_col()
            .gap(px(space::S5))
            .child(
                div()
                    .font_role(Role::Ui)
                    .type_px(s.dialog_title, s.dialog_title + 6.0)
                    .weight(weight::SEMIBOLD)
                    .text_color(p.ink(1).solid())
                    .child(t(cx, keys::pre_alpha_guide::TITLE)),
            )
            .child(
                div()
                    .font_role(Role::Ui)
                    .type_px(s.body, s.line_body)
                    .text_color(p.ink(2).solid())
                    .child(dr_ui::text::wrapped(t(
                        cx,
                        keys::pre_alpha_guide::CRASH_REPORTS,
                    ))),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_end()
                    .gap(px(space::S3))
                    .child(
                        Button::new("first-run-local", t(cx, keys::first_run::LOCAL)).on_click(
                            move |_, window, cx| {
                                Settings::set_device_memory(
                                    cx,
                                    FIRST_RUN_ACCOUNT_SEEN_KEY,
                                    Some(true.into()),
                                );
                                done_local(window, cx);
                            },
                        ),
                    )
                    .child(
                        Button::new("first-run-email", t(cx, keys::first_run::EMAIL))
                            .primary()
                            .on_click(move |_, window, cx| {
                                Settings::set_device_memory(
                                    cx,
                                    FIRST_RUN_ACCOUNT_SEEN_KEY,
                                    Some(true.into()),
                                );
                                done_email(window, cx);
                                open_auth_dialog(window, cx);
                            }),
                    ),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_account::fake_server::FakeAuthServer;
    use dr_shell::{SettingsFile, ShellInfo};
    use gpui::TestAppContext;
    use tempfile::TempDir;

    fn shell_info() -> ShellInfo {
        ShellInfo {
            app_name: "Drifting Next",
            bundle_id: "cc.drifting.next.dev",
            version: "0.2.0-dev",
            url_scheme: "drifting-next-dev",
            forced_appearance: None,
        }
    }

    #[gpui::test]
    fn local_only_keeps_local_account_label_and_skips_welcome_step(cx: &mut TestAppContext) {
        let tmp = TempDir::new().expect("tempdir");
        let svc = Arc::new(
            AccountService::new(
                HostedConfig::local_only(),
                tmp.path(),
                "cc.drifting.next.dev",
                Arc::new(SecretStore::in_memory()),
            )
            .expect("local_only service"),
        );
        cx.update(|cx| {
            let _ = dr_ui::fonts::register(cx);
            dr_shell::init(
                shell_info(),
                Services::default(),
                SettingsFile::in_memory(),
                cx,
            );
            init(Service::with_service(svc), cx);

            assert_eq!(
                dr_shell::account::display_name(cx),
                t(cx, keys::common::LOCAL)
            );
            assert_eq!(
                dr_shell::account::menu_aria_label(cx),
                t(cx, keys::user_menu::LOCAL_MENU)
            );
        });
    }

    #[gpui::test]
    fn hosted_sign_in_updates_display_name_and_renders_dialogs_and_settings(
        cx: &mut TestAppContext,
    ) {
        let server = FakeAuthServer::start();
        let tmp = TempDir::new().expect("tempdir");
        let svc = Arc::new(
            AccountService::new(
                server.config(),
                tmp.path(),
                "cc.drifting.next.dev",
                Arc::new(SecretStore::in_memory()),
            )
            .expect("hosted service"),
        );
        svc.sign_up_email("林昭", "writer@example.test", "correct-horse-battery")
            .expect("sign up");
        let otp = server.last_otp_for("writer@example.test").expect("otp");
        let signed_in_state = svc
            .verify_email_otp("writer@example.test", &otp, Some("correct-horse-battery"))
            .expect("verify email");
        let expected_uid = signed_in_state.user.as_ref().expect("user").id.clone();

        cx.update(|cx| {
            let _ = dr_ui::fonts::register(cx);
            dr_shell::init(
                shell_info(),
                Services::default(),
                SettingsFile::in_memory(),
                cx,
            );
            init(Service::with_service(svc.clone()), cx);
            apply_account_state(signed_in_state, cx);

            assert_eq!(dr_shell::account::display_name(cx).as_ref(), "林昭");
            assert_eq!(
                dr_shell::account::menu_aria_label(cx),
                t(cx, keys::user_menu::ACCOUNT_MENU)
            );
        });

        let window = cx.add_window(AccountSettingsView::new);
        window
            .update(cx, |view, _window, cx| {
                assert_eq!(view.last_synced_user_id(), Some(expected_uid.as_str()));
                let _ = cx;
            })
            .expect("update window");
    }

    #[gpui::test]
    fn settings_account_sign_out_drains_before_revoking_token(cx: &mut TestAppContext) {
        use std::cell::RefCell;
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::task::{Context as TaskContext, Poll, Waker};

        struct DrainGate(Rc<RefCell<(bool, Option<Waker>)>>);
        impl std::future::Future for DrainGate {
            type Output = ();
            fn poll(self: std::pin::Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<()> {
                let mut st = self.0.borrow_mut();
                if st.0 {
                    Poll::Ready(())
                } else {
                    st.1 = Some(cx.waker().clone());
                    Poll::Pending
                }
            }
        }

        cx.executor().allow_parking();
        let server = FakeAuthServer::start();
        server.set_require_signup_verification(false);
        let origin = server.origin();
        let tmp = TempDir::new().expect("tempdir");
        let svc = Arc::new(
            AccountService::new(
                server.config(),
                tmp.path(),
                "cc.drifting.next.dev",
                Arc::new(SecretStore::in_memory()),
            )
            .expect("hosted service"),
        );
        svc.sign_up_email(
            "林昭",
            "drain-signout@example.test",
            "correct-horse-battery",
        )
        .expect("sign up");
        let signed_in_state = svc.state();
        assert_eq!(signed_in_state.status, SessionStatus::Connected);
        let active_token = svc.current_token().expect("active bearer token");

        let hook_calls = Arc::new(AtomicUsize::new(0));
        let token_valid_during_drain = Arc::new(AtomicBool::new(false));
        let gate_state: Rc<RefCell<(bool, Option<Waker>)>> = Rc::new(RefCell::new((false, None)));

        cx.update(|cx| {
            let _ = dr_ui::fonts::register(cx);
            dr_shell::init(
                shell_info(),
                Services::default(),
                SettingsFile::in_memory(),
                cx,
            );
            init(Service::with_service(svc.clone()), cx);
            apply_account_state(signed_in_state, cx);

            let hook_calls = Arc::clone(&hook_calls);
            let token_valid_during_drain = Arc::clone(&token_valid_during_drain);
            let gate_for_hook = Rc::clone(&gate_state);
            let svc_for_hook = Arc::clone(&svc);
            let origin_for_hook = origin.clone();
            let token_for_hook = active_token.clone();

            dr_shell::sync::set_before_account_action(cx, move |cx| {
                hook_calls.fetch_add(1, Ordering::SeqCst);
                let gate = DrainGate(Rc::clone(&gate_for_hook));
                let svc_bg = Arc::clone(&svc_for_hook);
                let origin_bg = origin_for_hook.clone();
                let token_bg = token_for_hook.clone();
                let valid_flag = Arc::clone(&token_valid_during_drain);
                let exec = cx.background_executor().clone();
                Some(Box::pin(async move {
                    gate.await;
                    exec.spawn(async move {
                        let still_stored =
                            svc_bg.current_token().as_deref() == Some(token_bg.as_str());
                        let still_valid_on_server = svc_bg
                            .client()
                            .get_session(&origin_bg, &token_bg)
                            .ok()
                            .flatten()
                            .is_some();
                        valid_flag.store(still_stored && still_valid_on_server, Ordering::SeqCst);
                    })
                    .await;
                }))
            });
        });

        let window = cx.add_window(AccountSettingsView::new);
        let mut vcx = gpui::VisualTestContext::from_window(*window, cx);
        vcx.run_until_parked();

        let signout_bounds = vcx
            .debug_bounds("settings-account-signout")
            .expect("Settings › Account sign-out button must render when signed in");
        vcx.simulate_click(signout_bounds.center(), gpui::Modifiers::none());

        // While draining, `signing_out` is already true, duplicate `sign_out` calls are
        // ignored, and the session token is still valid on `FakeAuthServer`.
        vcx.update(|_window, cx| {
            assert!(cx.global::<Service>().signing_out);
            sign_out(cx);
        });
        assert_eq!(hook_calls.load(Ordering::SeqCst), 1);
        assert_eq!(svc.current_token().as_deref(), Some(active_token.as_str()));
        assert!(
            svc.client()
                .get_session(&origin, &active_token)
                .expect("query session before drain finishes")
                .is_some(),
            "token must remain valid while pre-sign-out drain is running"
        );

        // Release the drain gate and wait for background sign-out + token revocation.
        {
            let mut st = gate_state.borrow_mut();
            st.0 = true;
            if let Some(waker) = st.1.take() {
                waker.wake();
            }
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            vcx.run_until_parked();
            let finished = vcx.update(|_window, cx| {
                let st = cx.global::<Service>();
                !st.signing_out && st.state.status == SessionStatus::SignedOut
            });
            if finished {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for sign_out to finish after drain"
            );
            std::thread::sleep(Duration::from_millis(10));
        }

        assert!(
            token_valid_during_drain.load(Ordering::SeqCst),
            "token must still be stored and valid on server at the end of run_before_sign_out"
        );
        assert_eq!(hook_calls.load(Ordering::SeqCst), 1);
        assert!(svc.current_token().is_none());
        assert!(
            svc.client()
                .get_session(&origin, &active_token)
                .expect("query session after sign-out")
                .is_none(),
            "token must be revoked on FakeAuthServer after drain completes"
        );
    }

    #[test]
    fn settings_file_preference_sync_never_uploads_device_or_byok_keys() {
        use dr_shell::settings::registry::{
            AGENT_MAX_MODEL_ROUNDS, AGENT_MODEL, AGENT_PROVIDER, CRASH_REPORTS, FONT_SIZE,
            TEXT_SIZE, THEME, UI_LOCALE,
        };
        use serde_json::Value;

        let server = FakeAuthServer::start();
        server.set_require_signup_verification(false);
        let tmp_a = TempDir::new().expect("tempdir a");
        let tmp_b = TempDir::new().expect("tempdir b");

        let svc_a = AccountService::new(
            server.config(),
            tmp_a.path(),
            "cc.drifting.next.dev",
            Arc::new(SecretStore::in_memory()),
        )
        .expect("svc a");
        let svc_b = AccountService::new(
            server.config(),
            tmp_b.path(),
            "cc.drifting.next.dev",
            Arc::new(SecretStore::in_memory()),
        )
        .expect("svc b");

        svc_a
            .sign_up_email("Author", "prefs@example.test", "prefs-password-123")
            .expect("sign up a");
        svc_b
            .sign_in_email("prefs@example.test", "prefs-password-123")
            .expect("sign in b");

        // Device A edits synced preferences AND device-only preferences.
        let mut file_a = SettingsFile::in_memory();
        file_a.set(THEME, Value::from("dark"), None).unwrap();
        file_a.set(FONT_SIZE, Value::from(21.0), None).unwrap();
        file_a.set(UI_LOCALE, Value::from("ja"), None).unwrap();
        file_a
            .set(AGENT_MAX_MODEL_ROUNDS, Value::from(80), None)
            .unwrap();
        file_a.set_key_binding("goBack", Some("cmd-alt-left"));

        // Device-only settings:
        file_a.set(TEXT_SIZE, Value::from("largest"), None).unwrap();
        file_a.set(CRASH_REPORTS, Value::from(false), None).unwrap();
        file_a
            .set(AGENT_PROVIDER, Value::from("anthropic"), None)
            .unwrap();
        file_a
            .set(AGENT_MODEL, Value::from("claude-sonnet"), None)
            .unwrap();
        file_a.set_device_memory("shelf.cover_style", Some(Value::from("topo")));

        let out_a = sync_preferences_blocking(&svc_a, &mut file_a).expect("sync a");
        assert!(out_a.supported);
        assert!(!has_pending_synced_preferences(&file_a));

        // Inspect server storage: device-only keys must NEVER appear on the server.
        let stored_on_server = server.preferences_for("prefs@example.test");
        assert!(stored_on_server.contains_key(THEME));
        assert!(stored_on_server.contains_key(FONT_SIZE));
        assert!(stored_on_server.contains_key(UI_LOCALE));
        assert!(stored_on_server.contains_key(AGENT_MAX_MODEL_ROUNDS));
        assert!(stored_on_server.contains_key(dr_shell::settings::store::KEY_BINDINGS));
        assert!(!stored_on_server.contains_key(TEXT_SIZE));
        assert!(!stored_on_server.contains_key(CRASH_REPORTS));
        assert!(!stored_on_server.contains_key(AGENT_PROVIDER));
        assert!(!stored_on_server.contains_key(AGENT_MODEL));
        assert!(!stored_on_server.contains_key("shelf.cover_style"));

        // Device B syncs and receives all account-synced settings, while keeping its own device settings.
        let mut file_b = SettingsFile::in_memory();
        let out_b = sync_preferences_blocking(&svc_b, &mut file_b).expect("sync b");
        assert!(out_b.supported);
        assert_eq!(file_b.get(THEME), Value::from("dark"));
        assert_eq!(file_b.number(FONT_SIZE), 21.0);
        assert_eq!(file_b.get(UI_LOCALE), Value::from("ja"));
        assert_eq!(file_b.get(AGENT_MAX_MODEL_ROUNDS), Value::from(80));
        assert_eq!(file_b.key_bindings()["goBack"], Value::from("cmd-alt-left"));
        // Device B's device-only settings remain at their local defaults:
        assert_eq!(file_b.get(TEXT_SIZE), Value::from("standard"));
        assert_eq!(file_b.get(AGENT_PROVIDER), Value::from("deepseek"));
    }

    #[test]
    fn sync_status_hover_copy_and_action_labels_cover_all_states() {
        use dr_i18n::Locale;
        use dr_sync::{SyncCornerState, SyncProblem, SyncStatusAction};

        for locale in [Locale::ZhCn, Locale::En] {
            for state in [
                SyncCornerState::Syncing,
                SyncCornerState::Retrying,
                SyncCornerState::Offline,
                SyncCornerState::Problem(SyncProblem::NotStarted),
                SyncCornerState::Problem(SyncProblem::Reauth),
                SyncCornerState::Problem(SyncProblem::Quota),
                SyncCornerState::Problem(SyncProblem::Failing),
            ] {
                let copy = sync_status_copy(state, locale);
                assert!(!copy.title.is_empty());
                assert!(!copy.detail.is_empty());
            }
            for action in [
                SyncStatusAction::Retry,
                SyncStatusAction::SignIn,
                SyncStatusAction::OpenSettings,
            ] {
                assert!(!sync_action_label(action, locale).is_empty());
            }
        }
    }
}
