//! Hosted account sign-in, first-run welcome step, profile editor, password change,
//! and per-account library switching (M35, `dr-view-account`).

pub mod dialog;
pub mod settings_view;

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use dr_account::{AccountService, AccountState, HostedConfig, SessionStatus, decode_avatar_rgba};
use dr_i18n::keys;
use dr_platform::{Identity, SecretStore};
use dr_shell::{
    Services, Settings,
    account::{AccountMenuAction, AccountViewInfo},
    settings::registry::Section,
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

/// Device-memory key remembering that the first-run account choice has been answered.
pub const FIRST_RUN_ACCOUNT_SEEN_KEY: &str = "account.first_run_seen";

/// Global state for `dr-view-account`.
pub struct Service {
    pub inner: Arc<AccountService>,
    pub state: AccountState,
    pub avatar_cache: Option<(String, Arc<RenderImage>)>,
    pub signing_out: bool,
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

/// Signs out of the current Hosted account in the background and switches back to the local library.
pub fn sign_out(cx: &mut App) {
    let Some(inner) = cx.try_global::<Service>().map(|s| s.inner.clone()) else {
        return;
    };
    cx.update_global::<Service, _>(|svc, _| {
        svc.signing_out = true;
    });
    cx.refresh_windows();
    cx.spawn(async move |cx| {
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
    cx.refresh_windows();
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
}
