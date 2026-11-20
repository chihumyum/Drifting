//! Hosted account sign-in, first-run welcome step, profile editor, password change,
//! and per-account library switching (M35, `dr-view-account`).

pub mod consent;
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

pub use consent::consent_line;
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
    /// What the account bar and Settings › Account showed when they began
    /// waiting for a library swap (one started, one deferred behind a
    /// release under way, or one that failed): `Some` only while they wait.
    /// Otherwise they show `state` ([`shown_account_state`]).
    held: Option<(AccountState, Option<Arc<RenderImage>>)>,
    preference_sync_task: Option<gpui::Task<()>>,
    /// How many times [`schedule_preference_sync`] queued a round.
    preference_sync_scheduled_count: usize,
    /// A sync round is writing what the server answered into the settings:
    /// that is not the author changing a setting, and schedules nothing.
    applying_remote_preferences: bool,
    /// The account-scoped settings as they were when last looked at, to tell
    /// a change to one of them from a change to a device-only setting.
    last_observed_synced: BTreeMap<String, Option<serde_json::Value>>,
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
            held: None,
            state,
            avatar_cache,
            signing_out: false,
            preference_sync_task: None,
            preference_sync_scheduled_count: 0,
            applying_remote_preferences: false,
            last_observed_synced: BTreeMap::new(),
        }
    }

    /// Number of times [`schedule_preference_sync`] has queued a debounced sync
    /// round while connected.
    #[must_use]
    pub fn preference_sync_scheduled_count(&self) -> usize {
        self.preference_sync_scheduled_count
    }

    /// What the account bar shows now: what it held while waiting for a
    /// library swap, otherwise `state`.
    fn shown(&self) -> (AccountState, Option<Arc<RenderImage>>) {
        self.held.clone().unwrap_or_else(|| {
            (
                self.state.clone(),
                self.avatar_cache.as_ref().map(|(_, img)| img.clone()),
            )
        })
    }
}

/// The account the account bar and Settings › Account show, its avatar, and
/// whether a sign-out is under way. It is [`Service::state`], except while
/// the library is being switched, or after switching failed: then it stays
/// what it was when that began, the account whose library is open.
#[must_use]
pub fn shown_account_state(cx: &App) -> (AccountState, Option<Arc<RenderImage>>, bool) {
    match cx.try_global::<Service>() {
        Some(svc) => {
            let (state, avatar) = svc.shown();
            (state, avatar, svc.signing_out)
        }
        None => (
            AccountState {
                hosted_configured: false,
                origin: None,
                status: SessionStatus::SignedOut,
                user: None,
                providers: dr_account::AuthProviders::default(),
                active_library_dir: PathBuf::new(),
                is_account_library: false,
            },
            None,
            false,
        ),
    }
}

/// After a library release finished (a swap of ours, the sync supervisor's
/// retry of one, a restore): once the open library is the one `state` names,
/// the account bar stops waiting and shows `state`. Starts no preference
/// sync.
fn reconcile_shown_account(cx: &mut App) {
    if !cx.has_global::<Service>() {
        return;
    }
    let open_root = cx
        .try_global::<Services>()
        .and_then(|s| s.library.as_ref())
        .map(|ws| ws.library().paths().root.clone());
    let svc = cx.global::<Service>();
    if open_root.as_ref() != Some(&svc.state.active_library_dir) || svc.held.is_none() {
        return;
    }
    cx.update_global::<Service, _>(|svc, _| svc.held = None);
    cx.refresh_windows();
}

/// After a 0.1 import pointed the signed-in account at its new library and
/// that library is open (`dr-view-import`): the account state names it, so
/// the sync supervisor, which syncs only the account's own library, connects
/// to it. Starts no preference sync and no library swap.
pub fn follow_library_registry(cx: &mut App) {
    if !cx.has_global::<Service>() {
        return;
    }
    let state = cx.global::<Service>().inner.reload_active_library();
    cx.update_global::<Service, _>(|svc, _| {
        svc.state.active_library_dir = state.active_library_dir;
        svc.state.is_account_library = state.is_account_library;
    });
    reconcile_shown_account(cx);
    cx.refresh_windows();
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
pub fn init(mut service: Service, cx: &mut App) {
    let inner = service.inner.clone();
    if cx.has_global::<Settings>() {
        service.last_observed_synced = explicit_synced_snapshot(Settings::read(cx));
    }
    let initial_state = service.state.clone();
    cx.set_global(service);

    dr_view_feedback::Service::set_session(inner.current_token(), cx);

    // Seed built-in sample books only if the startup library is the local library.
    if !initial_state.is_account_library
        && let Some(lib) = cx.try_global::<Services>().and_then(|s| s.library.clone())
    {
        first_run::write_samples(lib, cx).detach();
    }

    // M35: a library swap that failed and was retried later (the sync
    // supervisor's, `app/drifting/src/sync.rs`) brings the account bar to
    // the account once its library is open.
    dr_shell::release::after_release(cx, reconcile_shown_account);

    // M37: changing a setting that goes with the account schedules a
    // debounced preference sync; device-only settings, BYOK, layout and what
    // a sync round itself writes back do not.
    dr_shell::settings::on_changed(cx, |cx| {
        if !cx.has_global::<Service>() || !cx.has_global::<Settings>() {
            return;
        }
        let next = explicit_synced_snapshot(Settings::read(cx));
        let should_schedule = cx.update_global::<Service, _>(|svc, _| {
            let changed = svc.last_observed_synced != next;
            svc.last_observed_synced = next;
            changed && !svc.applying_remote_preferences
        });
        if should_schedule {
            schedule_preference_sync(cx);
        }
    });

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
        if !cx.has_global::<Service>() {
            return AccountViewInfo::default();
        }
        let (state, avatar, busy) = shown_account_state(cx);
        let signed_in = state.status.has_account();
        let display_name = state
            .user
            .as_ref()
            .map(|u| SharedString::from(u.display_name().to_owned()));
        let display_name_is_fallback = state
            .user
            .as_ref()
            .is_some_and(|u| u.profile_name().is_none());
        let status_line = Some(match state.status {
            SessionStatus::SignedOut => t(cx, um::LOCAL_STATUS),
            SessionStatus::Checking => t(cx, sess::CHECKING),
            SessionStatus::Connected => t(cx, sess::CONNECTED),
            SessionStatus::Offline => t(cx, sess::OFFLINE),
            SessionStatus::NeedsReauth => t(cx, sess::NEEDS_REAUTH),
        });
        let on_header_click: Option<dr_shell::account::AccountCallback> =
            state.hosted_configured.then(|| {
                Rc::new(|window: &mut Window, cx: &mut App| {
                    dr_shell::settings::open_section(Section::Account, window, cx);
                }) as dr_shell::account::AccountCallback
            });

        let action = if !state.hosted_configured {
            None
        } else if signed_in && state.status != SessionStatus::NeedsReauth {
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
            display_name_is_fallback,
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
    let shown_before = cx.update_global::<Service, _>(|svc, _| {
        let shown_before = svc.shown();
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
        shown_before
    });

    // The account bar changes with the library: at once when no swap is
    // needed, otherwise it holds what it showed until the swap succeeded
    // ([`reconcile_shown_account`]). Already holding, it keeps what it holds:
    // that is still the open library's account.
    let waits = switch_library_if_needed(target_dir, is_account_lib, cx);
    cx.update_global::<Service, _>(|svc, _| {
        if !waits {
            svc.held = None;
        } else if svc.held.is_none() {
            svc.held = Some(shown_before);
        }
    });
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
    cx.update_global::<Service, _>(|svc, _| {
        svc.preference_sync_scheduled_count += 1;
        svc.preference_sync_task = Some(task);
    });
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
    // `null` is the default of a key that has no stored value (the interface
    // language follows the system), unless the key takes it as a value (no
    // cap on the Agent's rounds).
    let takes_null = registry::find(key).is_some_and(|def| def.validate(value).is_some());
    if value.is_null() && !takes_null {
        file.reset(key, None)
    } else {
        file.set(key, value.clone(), None).unwrap_or(false)
    }
}

/// Whether this device's preference sync holds a change for `key` (a ledger
/// entry later than [`dr_account::UNCHANGED_AT`]): a value the account or
/// this device chose, which the 0.1 import never replaces.
pub fn has_synced_change(file: &dr_shell::SettingsFile, key: &str) -> bool {
    load_stored_preference_state(file)
        .ledger
        .entries
        .get(key)
        .is_some_and(|e| {
            dr_account::compare_iso_timestamps(&e.changed_at, dr_account::UNCHANGED_AT)
                == std::cmp::Ordering::Greater
        })
}

/// M37's [`dr_account::Adopt`]: for a key of this client that holds no
/// change in the account's bag, the value the 0.1 client synced under its
/// own name (`dr_shell::settings::v1`), with its change time. The 0.1
/// entries themselves are never written: a 0.1 client may still run on
/// another device.
pub fn adopt_from_v1(
    key: &str,
    bag: &BTreeMap<String, dr_account::RemotePreference>,
) -> Option<dr_account::RemotePreference> {
    use dr_shell::settings::v1;
    let old = v1::synced_source(key)?;
    let stored = bag.get(old)?;
    let value = v1::convert_synced(old, &stored.value, v1::this_os())?;
    Some(dr_account::RemotePreference {
        value,
        changed_at: stored.changed_at.clone(),
    })
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

fn explicit_synced_snapshot(
    file: &dr_shell::SettingsFile,
) -> BTreeMap<String, Option<serde_json::Value>> {
    synced_preference_keys()
        .into_iter()
        .map(|k| (k.to_owned(), read_explicit_synced_preference(file, k)))
        .collect()
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
            .spawn(async move {
                inner.sync_preferences_adopting(&keys, &local_values, &ledger, &adopt_from_v1)
            })
            .await;
        cx.update(|cx| {
            if let Ok(outcome) = res
                && outcome.supported
                && cx.has_global::<Settings>()
            {
                if cx.has_global::<Service>() {
                    cx.update_global::<Service, _>(|svc, _| {
                        svc.applying_remote_preferences = true;
                    });
                }
                Settings::update(cx, |file| {
                    apply_preference_sync_outcome(file, &outcome);
                });
                if cx.has_global::<Service>() {
                    let observed = explicit_synced_snapshot(Settings::read(cx));
                    cx.update_global::<Service, _>(|svc, _| {
                        svc.applying_remote_preferences = false;
                        svc.last_observed_synced = observed;
                    });
                }
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
    let outcome =
        service.sync_preferences_adopting(&keys, &local_values, &ledger, &adopt_from_v1)?;
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

/// Starts swapping the open library for `target_dir` when it is another
/// one. True when the account bar is to wait (this swap, or a release
/// already under way); false when no swap was needed. A failed swap leaves
/// the account bar on the open library's account and says so in a toast.
fn switch_library_if_needed(target_dir: PathBuf, is_account_lib: bool, cx: &mut App) -> bool {
    if target_dir.as_os_str().is_empty() {
        return false;
    }
    // Another release is under way (an earlier sign-in's swap, a restore):
    // which library ends up open is not known yet, and `replace` would refuse
    // at once. Leave the bar where it is; when that release ends,
    // [`reconcile_shown_account`] shows `state` if its library is the one
    // open, and the sync supervisor retries the swap if it is not.
    if dr_shell::release::is_releasing(cx) {
        log::info!("a library release is under way; the account bar waits for it");
        return true;
    }
    let current_root = cx
        .try_global::<Services>()
        .and_then(|s| s.library.as_ref())
        .map(|ws| ws.library().paths().root.clone());
    let Some(current_root) = current_root else {
        return false;
    };
    if current_root == target_dir {
        return false;
    }

    dr_shell::library::replace(
        cx,
        move |_old_root, options| {
            dr_store::Library::open(&target_dir, options).map_err(|e| e.to_string())
        },
        move |res, cx| {
            if let Err(err) = res {
                log::warn!("switching library failed: {err}");
                dr_shell::workspace::with_workspace(cx, |ws, _, cx| {
                    let text = t(cx, keys::settings::hosted::LIBRARY_SWITCH_FAILED);
                    ws.toast_error(text, cx);
                });
                return;
            }
            reconcile_shown_account(cx);
            if !is_account_lib
                && let Some(lib) = cx.try_global::<Services>().and_then(|s| s.library.clone())
            {
                first_run::write_samples(lib, cx).detach();
            }
            cx.refresh_windows();
        },
    );
    true
}

/// First-run welcome step (`PreAlphaFirstRunGate`): offers Email sign-in or
/// continuing locally, and ends with the consent line (2026-11-13): every
/// way on passes this page, the local one too, and a Hosted build sends
/// fault reports without a session as well. What is agreed to waits in the
/// line's hover card, which opens downward, clear of the ways on above it.
/// The sign-in dialog has no copy of the line, wherever it is opened from.
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
            .child(consent_line("first-run-consent", window, cx))
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

    /// The welcome step draws with its consent line (2026-11-13) and the
    /// line's hover card in place of the old paragraph.
    #[gpui::test]
    fn the_welcome_draws_with_its_consent_line(cx: &mut TestAppContext) {
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
        cx.update(|cx| {
            let _ = dr_ui::init(cx);
            dr_shell::init(
                shell_info(),
                Services::default(),
                SettingsFile::in_memory(),
                cx,
            );
            init(Service::with_service(svc), cx);
        });

        struct Welcome;
        impl gpui::Render for Welcome {
            fn render(
                &mut self,
                window: &mut Window,
                cx: &mut gpui::Context<Self>,
            ) -> impl IntoElement {
                div()
                    .w(px(380.0))
                    .child(WelcomeStep.render(Rc::new(|_, _| {}), window, cx))
            }
        }
        let draw = |cx: &mut TestAppContext, window: gpui::AnyWindowHandle| {
            cx.run_until_parked();
            cx.update_window(window, |_, window, cx| window.draw(cx).clear(cx))
                .expect("draw");
        };
        let welcome = cx.add_window(|_, _| Welcome);
        draw(cx, welcome.into());

        // A press on 「相关条款」 opens its card at once, below the line.
        let cx = &mut gpui::VisualTestContext::from_window(welcome.into(), cx);
        let terms = cx.debug_bounds("consent-terms").expect("the consent words");
        assert!(
            cx.debug_bounds("consent-card").is_none(),
            "card shown unasked"
        );
        cx.simulate_click(terms.center(), gpui::Modifiers::default());
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx)
        });
        let card = cx
            .debug_bounds("consent-card")
            .expect("a press opens the card");
        assert!(card.top() >= terms.bottom(), "the card opens downward");
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

    /// M37 over a bag a 0.1 client filled (its key names, `preference-fields.ts`):
    /// this client takes the mapped values for keys that hold no change of
    /// its own, newest change winning, and leaves every 0.1 entry as it was.
    #[test]
    fn the_01_clients_synced_preferences_are_adopted_and_left_in_the_bag() {
        use dr_account::{PreferenceWrite, RemotePreference, UNCHANGED_AT};
        use dr_shell::settings::registry::{
            AGENT_MAX_MODEL_ROUNDS, AUTO_IMMERSIVE, FONT_SIZE, LINE_HEIGHT, PAGE_WIDTH,
            PARAGRAPH_INDENT, PARAGRAPH_SPACING, THEME, TYPEWRITER, TYPEWRITER_POSITION, UI_LOCALE,
        };
        use dr_shell::settings::store::KEY_BINDINGS;
        use serde_json::{Value, json};

        let email = "old-prefs@example.test";
        let server = FakeAuthServer::start();
        server.set_require_signup_verification(false);
        let tmp_old = TempDir::new().expect("tempdir 0.1");
        let tmp_a = TempDir::new().expect("tempdir a");
        let tmp_b = TempDir::new().expect("tempdir b");
        let service = |dir: &TempDir| {
            AccountService::new(
                server.config(),
                dir.path(),
                "cc.drifting.next.dev",
                Arc::new(SecretStore::in_memory()),
            )
            .expect("service")
        };
        let (svc_old, svc_a, svc_b) = (service(&tmp_old), service(&tmp_a), service(&tmp_b));
        svc_old
            .sign_up_email("Author", email, "old-prefs-password-123")
            .expect("sign up");
        svc_a
            .sign_in_email(email, "old-prefs-password-123")
            .expect("sign in a");
        svc_b
            .sign_in_email(email, "old-prefs-password-123")
            .expect("sign in b");

        // The bag as a 0.1 client leaves it: every synced field, the
        // untouched ones seeded at `UNCHANGED_AT`, its full shortcut map.
        let at = "2026-10-20T09:00:00.000Z";
        let write = |key: &str, value: Value, changed_at: &str| PreferenceWrite {
            key: key.into(),
            value,
            changed_at: changed_at.into(),
        };
        let bindings = json!({
            "closeActiveTab": "Mod+W", "findInEditor": "Mod+F", "globalSearch": "Mod+Shift+F",
            "saveCurrentEditor": "Mod+S", "goBack": "Mod+Alt+B", "goForward": "Mod+]",
            "prevTab": "Mod+Alt+ArrowLeft", "nextTab": "Mod+Alt+ArrowRight",
            "toggleBottomTimeline": "Mod+J", "toggleImmersiveWriting": "Mod+Shift+Enter",
            "newEntity": "Mod+,", "closeProject": "Mod+Shift+W"
        });
        let old_bag = [
            write("themeMode", json!("dark"), at),
            write("accentColor", json!("#aa5500"), at),
            write("agentEditRevealAnimation", json!(true), UNCHANGED_AT),
            write("bodyFontSize", json!(19), at),
            write("lineHeight", json!(1.7), at),
            write("paragraphIndent", json!("two"), at),
            write("editorIndentStep", json!(2), UNCHANGED_AT),
            write("paragraphSpacing", json!(2.8), at),
            write("maxLineWidth", json!(840), at),
            write("autoImmersiveWriting", json!(false), UNCHANGED_AT),
            write("typewriterMode", json!(true), at),
            write("typewriterPosition", json!(60), UNCHANGED_AT),
            write("caretColor", json!("#6b7fa6"), UNCHANGED_AT),
            write("entityLinkColorMode", json!("contextual"), UNCHANGED_AT),
            write("autoElementLinkEnabled", json!(true), UNCHANGED_AT),
            write("uiLocale", json!("ja"), at),
            write("agentTurnIterationLimit", Value::Null, at),
            write("shortcutBindings", bindings, at),
        ];
        let origin = server.origin();
        let token = svc_old.current_token().expect("0.1 token");
        svc_old
            .client()
            .put_preferences(&origin, &token, &old_bag)
            .expect("the 0.1 client's bag");
        // Another device of this client already chose a line height.
        svc_old
            .client()
            .put_preferences(
                &origin,
                &token,
                &[write(LINE_HEIGHT, json!(1.3), "2026-11-01T09:00:00.000Z")],
            )
            .expect("a change of this client");
        let old_entries = |bag: &BTreeMap<String, RemotePreference>| -> String {
            let old: BTreeMap<&String, &RemotePreference> = bag
                .iter()
                .filter(|(k, _)| old_bag.iter().any(|w| &w.key == *k))
                .collect();
            assert_eq!(old.len(), old_bag.len(), "no 0.1 entry is removed");
            serde_json::to_string(&old).unwrap()
        };
        let before = old_entries(&server.preferences_for(email));

        // Device A: changed its font size here before signing in.
        let mut file_a = SettingsFile::in_memory();
        file_a.set(FONT_SIZE, json!(22), None).unwrap();
        let out = sync_preferences_blocking(&svc_a, &mut file_a).expect("sync a");
        assert!(out.supported);
        assert_eq!(file_a.get(THEME), json!("dark"));
        assert_eq!(file_a.number(FONT_SIZE), 22.0, "a newer change here wins");
        assert_eq!(
            file_a.number(LINE_HEIGHT),
            1.3,
            "a change of this client wins"
        );
        assert_eq!(file_a.get(PARAGRAPH_INDENT), json!("two"));
        assert_eq!(
            file_a.number(PARAGRAPH_SPACING),
            2.5,
            "clamped to this range"
        );
        assert_eq!(file_a.number(PAGE_WIDTH), 840.0);
        assert!(file_a.bool(TYPEWRITER));
        assert_eq!(
            file_a.number(TYPEWRITER_POSITION),
            50.0,
            "an untouched 0.1 seed is no change"
        );
        assert!(!file_a.bool(AUTO_IMMERSIVE));
        assert_eq!(file_a.get(UI_LOCALE), json!("ja"));
        assert_eq!(
            file_a.get(AGENT_MAX_MODEL_ROUNDS),
            Value::Null,
            "no cap stays no cap"
        );
        let keys = file_a.key_bindings();
        assert_eq!(keys["goBack"], "alt-secondary-b");
        assert!(
            !keys.contains_key("newEntity"),
            "⌘, opens the settings here: the default stays"
        );
        assert_eq!(keys.len(), 1);
        assert!(!has_pending_synced_preferences(&file_a));

        let bag = server.preferences_for(email);
        assert_eq!(old_entries(&bag), before, "every 0.1 entry byte for byte");
        assert_eq!(bag[THEME].value, json!("dark"));
        assert_eq!(bag[THEME].changed_at, at);
        assert_eq!(bag[FONT_SIZE].value, json!(22.0));
        assert_eq!(bag[PARAGRAPH_SPACING].value, json!(2.5));
        assert_eq!(bag[AGENT_MAX_MODEL_ROUNDS].value, Value::Null);
        assert_eq!(
            bag[KEY_BINDINGS].value,
            json!({"goBack": "alt-secondary-b"})
        );

        // Device B finds them under this client's names.
        let mut file_b = SettingsFile::in_memory();
        sync_preferences_blocking(&svc_b, &mut file_b).expect("sync b");
        assert_eq!(file_b.get(THEME), json!("dark"));
        assert_eq!(file_b.number(FONT_SIZE), 22.0);
        assert_eq!(file_b.get(AGENT_MAX_MODEL_ROUNDS), Value::Null);
        assert_eq!(file_b.key_bindings()["goBack"], "alt-secondary-b");

        // Taken once: the 0.1 client changing its theme later is not taken,
        // and its entry is still not touched.
        svc_old
            .client()
            .put_preferences(
                &origin,
                &token,
                &[write(
                    "themeMode",
                    json!("light"),
                    "2026-11-20T09:00:00.000Z",
                )],
            )
            .expect("a later 0.1 change");
        let later = old_entries(&server.preferences_for(email));
        sync_preferences_blocking(&svc_a, &mut file_a).expect("sync a again");
        assert_eq!(file_a.get(THEME), json!("dark"));
        assert_eq!(old_entries(&server.preferences_for(email)), later);
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

    #[gpui::test]
    fn changing_account_scoped_setting_in_settings_schedules_preference_sync_without_device_noise(
        cx: &mut TestAppContext,
    ) {
        use dr_shell::settings::registry::{
            AGENT_MODEL, AGENT_PROVIDER, CRASH_REPORTS, FONT_SIZE, REDUCE_MOTION, TEXT_SIZE, THEME,
        };
        use serde_json::Value;

        cx.executor().allow_parking();
        let server = FakeAuthServer::start();
        server.set_require_signup_verification(false);
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
        svc.sign_up_email("Author", "live-prefs@example.test", "prefs-password-123")
            .expect("sign up");
        let signed_in_state = svc.state();

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
        });

        // Wait for the initial sign-in preference sync round to settle.
        cx.run_until_parked();
        let baseline_scheduled =
            cx.update(|cx| cx.global::<Service>().preference_sync_scheduled_count());

        // Device-scoped, BYOK, layout, and device-memory mutations must NOT
        // schedule account preference sync.
        cx.update(|cx| {
            Settings::update(cx, |f| f.set(TEXT_SIZE, Value::from("large"), None).ok());
            Settings::update(cx, |f| f.set(REDUCE_MOTION, Value::from(true), None).ok());
            Settings::update(cx, |f| f.set(CRASH_REPORTS, Value::from(false), None).ok());
            Settings::update(cx, |f| {
                f.set(AGENT_PROVIDER, Value::from("anthropic"), None).ok()
            });
            Settings::update(cx, |f| {
                f.set(AGENT_MODEL, Value::from("claude-sonnet"), None).ok()
            });
            Settings::set_device_memory(cx, "shelf.cover_style", Some(Value::from("topo")));
        });
        assert_eq!(
            cx.update(|cx| cx.global::<Service>().preference_sync_scheduled_count()),
            baseline_scheduled,
            "device-only and BYOK settings must not trigger schedule_preference_sync"
        );

        // Editing account-scoped settings schedules debounced preference sync
        // immediately and uploads them after the 1s debounce window.
        cx.update(|cx| {
            Settings::update(cx, |f| f.set(THEME, Value::from("dark"), None).ok());
            Settings::update(cx, |f| f.set(FONT_SIZE, Value::from(20.0), None).ok());
            Settings::update(cx, |f| f.set_key_binding("goBack", Some("cmd-alt-b")));
        });
        assert_eq!(
            cx.update(|cx| cx.global::<Service>().preference_sync_scheduled_count()),
            baseline_scheduled + 3,
            "each account-scoped setting change schedules debounced preference sync"
        );

        cx.executor()
            .advance_clock(PREFERENCE_SYNC_DEBOUNCE + Duration::from_millis(200));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            cx.run_until_parked();
            let prefs = server.preferences_for("live-prefs@example.test");
            if prefs.contains_key(THEME)
                && prefs.contains_key(FONT_SIZE)
                && prefs.contains_key(dr_shell::settings::store::KEY_BINDINGS)
            {
                assert_eq!(prefs[THEME].value, Value::from("dark"));
                assert_eq!(prefs[FONT_SIZE].value, Value::from(20.0));
                assert_eq!(
                    prefs[dr_shell::settings::store::KEY_BINDINGS].value["goBack"],
                    Value::from("cmd-alt-b")
                );
                assert!(!prefs.contains_key(TEXT_SIZE));
                assert!(!prefs.contains_key(AGENT_PROVIDER));
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for debounced preference sync upload"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// M35: a sign-in whose library swap fails leaves the account bar and
    /// Settings › Account on the library that is open, with a toast; the
    /// session inside stays the new account. A later swap to that account's
    /// library (the sync supervisor's retry) brings the bar along without
    /// starting another preference sync.
    #[gpui::test]
    fn a_failed_library_swap_keeps_the_account_bar_on_the_open_library(cx: &mut TestAppContext) {
        use std::cell::Cell;

        cx.executor().allow_parking();
        let server = FakeAuthServer::start();
        server.set_require_signup_verification(false);
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
        svc.sign_up_email("Alice", "alice-swap@example.test", "correct-horse-alice")
            .expect("sign up");
        let local_dir = svc.sign_out().expect("back to local").active_library_dir;
        let local = dr_workspace::Workspace::open_dir(&local_dir, "0.2.0-dev").unwrap();

        // Every library release is refused until the test lets it through.
        let refuse = Rc::new(Cell::new(true));
        cx.update(|cx| {
            let _ = dr_ui::init(cx);
            dr_shell::init(
                shell_info(),
                Services {
                    library: Some(local),
                    ..Services::default()
                },
                SettingsFile::in_memory(),
                cx,
            );
            let refuse = refuse.clone();
            dr_shell::release::before_release(cx, move |_| {
                let refused = refuse.get();
                Box::pin(async move {
                    if refused {
                        Err("simulated release failure".to_owned())
                    } else {
                        Ok(())
                    }
                })
            });
            init(Service::with_service(svc.clone()), cx);
        });
        cx.run_until_parked();
        let workspace = cx.add_window(dr_shell::Workspace::new);
        let settings = cx.add_window(AccountSettingsView::new);
        cx.run_until_parked();

        let open_root = |cx: &mut TestAppContext| {
            cx.update(|cx| {
                cx.global::<Services>()
                    .library
                    .as_ref()
                    .map(|ws| ws.library().paths().root.clone())
            })
        };
        let wait_until = |cx: &mut TestAppContext, what: &str, done: &dyn Fn(&mut App) -> bool| {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                cx.run_until_parked();
                if cx.update(done) {
                    return;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "timed out waiting for {what}"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        };

        // Sign in: the session is Alice's and her library is wanted, but the
        // swap is refused.
        let alice = svc
            .sign_in_email("alice-swap@example.test", "correct-horse-alice")
            .expect("sign in");
        let alice_dir = alice.active_library_dir.clone();
        let alice_id = alice.user.as_ref().expect("user").id.clone();
        let alice_token = svc.current_token().expect("token");
        assert_ne!(alice_dir, local_dir);
        cx.update(|cx| {
            apply_account_state(alice, cx);
            assert_eq!(
                dr_shell::account::display_name(cx),
                t(cx, keys::common::LOCAL),
                "the bar waits for the swap"
            );
        });
        let failed = cx.update(|cx| t(cx, keys::settings::hosted::LIBRARY_SWITCH_FAILED));
        wait_until(cx, "the failed swap's toast", &|cx| {
            workspace
                .read_with(cx, |ws, _| ws.toast.as_ref().map(|t| t.text.clone()))
                .ok()
                .flatten()
                .is_some()
        });
        assert_eq!(
            workspace
                .read_with(cx, |ws, _| ws.toast.as_ref().map(|t| t.text.clone()))
                .unwrap(),
            Some(failed)
        );
        assert_eq!(open_root(cx), Some(local_dir.clone()));
        cx.update(|cx| {
            assert_eq!(
                dr_shell::account::display_name(cx),
                t(cx, keys::common::LOCAL)
            );
            assert_eq!(
                dr_shell::account::menu_aria_label(cx),
                t(cx, keys::user_menu::LOCAL_MENU)
            );
            let (shown, avatar, _) = shown_account_state(cx);
            assert_eq!(shown.status, SessionStatus::SignedOut);
            assert!(shown.user.is_none() && avatar.is_none());
            // The session inside is untouched: still Alice's.
            let state = &cx.global::<Service>().state;
            assert_eq!(state.status, SessionStatus::Connected);
            assert_eq!(state.active_library_dir, alice_dir);
        });
        settings
            .update(cx, |view, _, _| {
                assert_eq!(view.last_synced_user_id(), None)
            })
            .unwrap();
        assert_eq!(svc.current_token().as_deref(), Some(alice_token.as_str()));
        assert_eq!(
            dr_account::LibraryRegistry::load_or_init(tmp.path())
                .unwrap()
                .active_library_dir(tmp.path()),
            alice_dir
        );

        // The supervisor's retry: a plain library replace to Alice's library,
        // not through `apply_account_state`. Forget the sign-in's sync round
        // first, so a new one would show.
        cx.update(|cx| cx.global_mut::<Service>().preference_sync_task = None);
        refuse.set(false);
        let retry_dir = alice_dir.clone();
        cx.update(|cx| {
            dr_shell::library::replace(
                cx,
                move |_, options| {
                    dr_store::Library::open(&retry_dir, options).map_err(|e| e.to_string())
                },
                |res, _| res.expect("the retried swap"),
            );
        });
        wait_until(cx, "the retried swap", &|cx| {
            dr_shell::account::display_name(cx).as_ref() == "Alice"
        });
        assert_eq!(open_root(cx), Some(alice_dir.clone()));
        cx.update(|cx| {
            assert_eq!(
                dr_shell::account::menu_aria_label(cx),
                t(cx, keys::user_menu::ACCOUNT_MENU)
            );
            let svc = cx.global::<Service>();
            assert!(svc.held.is_none(), "the bar no longer waits");
            assert_eq!(shown_account_state(cx).0, svc.state);
            assert!(
                svc.preference_sync_task.is_none(),
                "the bar catching up starts no preference sync"
            );
        });
        settings
            .update(cx, |view, _, _| {
                assert_eq!(view.last_synced_user_id(), Some(alice_id.as_str()))
            })
            .unwrap();

        cx.update(|cx| {
            if let Some(lib) = cx.global::<Services>().library.as_ref() {
                lib.close();
            }
        });
    }

    /// M35: with no library swap pending, the account bar shows `state` as
    /// it is, even one written straight into the `Service` (as a test of
    /// `dr-view-transfer` does) rather than through `apply_account_state`.
    #[gpui::test]
    fn with_no_swap_pending_the_bar_shows_state_as_written(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let server = FakeAuthServer::start();
        server.set_require_signup_verification(false);
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
        svc.sign_up_email("Cleo", "cleo-direct@example.test", "correct-horse-cleo")
            .expect("sign up");
        cx.update(|cx| {
            let _ = dr_ui::fonts::register(cx);
            dr_shell::init(
                shell_info(),
                Services::default(),
                SettingsFile::in_memory(),
                cx,
            );
            init(Service::with_service(svc.clone()), cx);
        });
        cx.run_until_parked();
        cx.update(|cx| {
            assert!(cx.global::<Service>().held.is_none());
            assert_eq!(dr_shell::account::display_name(cx).as_ref(), "Cleo");
        });

        let renamed = svc.update_profile(Some("Cleo Writes"), None).unwrap();
        cx.update(|cx| {
            cx.update_global::<Service, _>(|svc, _| svc.state = renamed.clone());
            assert_eq!(shown_account_state(cx).0, renamed);
            assert_eq!(dr_shell::account::display_name(cx).as_ref(), "Cleo Writes");
            assert_eq!(
                dr_shell::account::author_name(cx).as_deref(),
                Some("Cleo Writes")
            );
        });
    }

    /// M35: a second account state arriving while a sign-in's swap is still
    /// releasing the library leaves the bar waiting, raises no toast of its
    /// own, and the bar follows whatever the held release ends in.
    #[gpui::test]
    fn a_second_state_during_a_held_swap_waits_for_it_to_succeed(cx: &mut TestAppContext) {
        second_state_during_a_held_swap(cx, Ok(()));
    }

    #[gpui::test]
    fn a_second_state_during_a_held_swap_waits_for_it_to_fail(cx: &mut TestAppContext) {
        second_state_during_a_held_swap(cx, Err("simulated release failure".into()));
    }

    fn second_state_during_a_held_swap(cx: &mut TestAppContext, release: Result<(), String>) {
        use std::cell::RefCell;
        use std::task::{Poll, Waker};

        type Gate = Rc<RefCell<(Option<Result<(), String>>, Option<Waker>)>>;

        cx.executor().allow_parking();
        let server = FakeAuthServer::start();
        server.set_require_signup_verification(false);
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
        svc.sign_up_email("Bea", "bea-held@example.test", "correct-horse-bea")
            .expect("sign up");
        let local_dir = svc.sign_out().expect("back to local").active_library_dir;
        let local = dr_workspace::Workspace::open_dir(&local_dir, "0.2.0-dev").unwrap();

        // Every library release waits until the test opens the gate with
        // its result.
        let gate: Gate = Rc::default();
        cx.update(|cx| {
            let _ = dr_ui::init(cx);
            dr_shell::init(
                shell_info(),
                Services {
                    library: Some(local),
                    ..Services::default()
                },
                SettingsFile::in_memory(),
                cx,
            );
            let gate = gate.clone();
            dr_shell::release::before_release(cx, move |_| {
                let gate = gate.clone();
                Box::pin(std::future::poll_fn(move |task| {
                    let mut gate = gate.borrow_mut();
                    match gate.0.clone() {
                        Some(result) => Poll::Ready(result),
                        None => {
                            gate.1 = Some(task.waker().clone());
                            Poll::Pending
                        }
                    }
                }))
            });
            init(Service::with_service(svc.clone()), cx);
        });
        cx.run_until_parked();
        let workspace = cx.add_window(dr_shell::Workspace::new);
        cx.run_until_parked();

        // Every toast the workspace raises, in order.
        let toasts: Rc<RefCell<Vec<SharedString>>> = Rc::default();
        let entity = cx.update(|cx| workspace.entity(cx).unwrap());
        cx.update(|cx| {
            let toasts = toasts.clone();
            let mut last = None;
            cx.observe(&entity, move |ws, cx| {
                let now = ws.read(cx).toast.clone();
                if let Some(toast) = now.filter(|t| t.shown)
                    && last.as_ref() != Some(&toast)
                {
                    toasts.borrow_mut().push(toast.text.clone());
                    last = Some(toast);
                }
            })
            .detach();
        });
        let wait_until = |cx: &mut TestAppContext, what: &str, done: &dyn Fn(&mut App) -> bool| {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                cx.run_until_parked();
                if cx.update(done) {
                    return;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "timed out waiting for {what}"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        let open_root = |cx: &mut TestAppContext| {
            cx.update(|cx| {
                cx.global::<Services>()
                    .library
                    .as_ref()
                    .map(|ws| ws.library().paths().root.clone())
            })
        };

        // The sign-in's swap starts and its release is held; then a second
        // state of the same account arrives (a session refresh).
        let bea = svc
            .sign_in_email("bea-held@example.test", "correct-horse-bea")
            .expect("sign in");
        let bea_dir = bea.active_library_dir.clone();
        cx.update(|cx| apply_account_state(bea, cx));
        cx.run_until_parked();
        assert!(cx.update(|cx| dr_shell::release::is_releasing(cx)));
        let again = svc.state();
        cx.update(|cx| apply_account_state(again, cx));
        cx.run_until_parked();
        cx.update(|cx| {
            assert_eq!(
                dr_shell::account::display_name(cx),
                t(cx, keys::common::LOCAL),
                "the bar waits for the held release"
            );
        });
        assert!(
            toasts.borrow().is_empty(),
            "no toast while the release is held: {:?}",
            toasts.borrow()
        );

        let failed = cx.update(|cx| t(cx, keys::settings::hosted::LIBRARY_SWITCH_FAILED));
        let succeeds = release.is_ok();
        {
            let mut gate = gate.borrow_mut();
            gate.0 = Some(release);
            if let Some(waker) = gate.1.take() {
                waker.wake();
            }
        }
        if succeeds {
            wait_until(cx, "the held swap", &|cx| {
                dr_shell::account::display_name(cx).as_ref() == "Bea"
            });
            assert_eq!(open_root(cx), Some(bea_dir));
            assert!(
                toasts.borrow().is_empty(),
                "no failure toast at any point: {:?}",
                toasts.borrow()
            );
        } else {
            wait_until(cx, "the held swap to fail", &|cx| {
                !dr_shell::release::is_releasing(cx)
            });
            cx.run_until_parked();
            assert_eq!(open_root(cx), Some(local_dir));
            cx.update(|cx| {
                assert_eq!(
                    dr_shell::account::display_name(cx),
                    t(cx, keys::common::LOCAL)
                );
            });
            assert_eq!(
                *toasts.borrow(),
                vec![failed],
                "one failure toast, the first swap's"
            );
        }

        cx.update(|cx| {
            if let Some(lib) = cx.global::<Services>().library.as_ref() {
                lib.close();
            }
        });
    }
}
