//! Settings → Account view (`AccountSettingsView`): status, sign-in/sign-out,
//! profile name & avatar editor, and password change.

use dr_account::{
    AccountError, AccountErrorCode, MAX_PASSWORD_LENGTH, MIN_PASSWORD_BYTES, SessionStatus,
    crop_and_encode_avatar, validate_profile_name,
};
use dr_i18n::{Key, keys};
use dr_shell::t;
use dr_ui::{
    Theme,
    components::Button,
    fonts::Role,
    input::field::{FieldEvent, TextField},
    style::DrStyled,
    tokens::space,
};
use gpui::{
    App, AppContext as _, Context, Entity, InteractiveElement, IntoElement, ParentElement, Render,
    SharedString, Styled, Subscription, Task, Window, div, prelude::FluentBuilder as _, px,
};

use crate::{Service, apply_account_state, open_auth_dialog, sign_out};

pub struct AccountSettingsView {
    display_name: Entity<TextField>,
    current_password: Entity<TextField>,
    new_password: Entity<TextField>,
    confirm_password: Entity<TextField>,
    last_synced_user_id: Option<String>,
    profile_busy: bool,
    profile_saved: bool,
    profile_error: Option<SharedString>,
    password_busy: bool,
    password_saved: bool,
    password_error: Option<SharedString>,
    task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl AccountSettingsView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        use keys::settings::hosted as h;
        let initial_name = cx
            .try_global::<Service>()
            .and_then(|s| s.state.user.as_ref().map(|u| u.name.clone()))
            .unwrap_or_default();
        let initial_user_id = cx
            .try_global::<Service>()
            .and_then(|s| s.state.user.as_ref().map(|u| u.id.clone()));

        let name_ph = t(cx, h::DISPLAY_NAME);
        let cur_pw_ph = t(cx, h::CURRENT_PASSWORD);
        let new_pw_ph = t(cx, h::NEW_PASSWORD);
        let conf_pw_ph = t(cx, h::CONFIRM_PASSWORD);

        let display_name = cx.new(|cx| {
            let mut f = TextField::new("account-display-name", window, cx).placeholder(name_ph);
            if !initial_name.is_empty() {
                f.set_text(initial_name, cx);
            }
            f
        });
        let current_password = cx.new(|cx| {
            TextField::new("account-current-password", window, cx).placeholder(cur_pw_ph)
        });
        let new_password =
            cx.new(|cx| TextField::new("account-new-password", window, cx).placeholder(new_pw_ph));
        let confirm_password = cx.new(|cx| {
            TextField::new("account-confirm-password", window, cx).placeholder(conf_pw_ph)
        });

        let mut subs = Vec::new();
        for f in [
            &display_name,
            &current_password,
            &new_password,
            &confirm_password,
        ] {
            subs.push(cx.subscribe(f, |view, _, event: &FieldEvent, cx| {
                if matches!(event, FieldEvent::Changed(_)) {
                    view.profile_saved = false;
                    view.profile_error = None;
                    view.password_saved = false;
                    view.password_error = None;
                    cx.notify();
                }
            }));
        }
        if cx.has_global::<Service>() {
            subs.push(cx.observe_global::<Service>(|view, cx| {
                let user_opt = cx
                    .try_global::<Service>()
                    .and_then(|s| s.state.user.clone());
                let next_id = user_opt.as_ref().map(|u| u.id.clone());
                if next_id != view.last_synced_user_id {
                    view.last_synced_user_id = next_id;
                    let text = user_opt.map(|u| u.name).unwrap_or_default();
                    view.display_name.update(cx, |f, cx| f.set_text(text, cx));
                }
                cx.notify();
            }));
        }

        Self {
            display_name,
            current_password,
            new_password,
            confirm_password,
            last_synced_user_id: initial_user_id,
            profile_busy: false,
            profile_saved: false,
            profile_error: None,
            password_busy: false,
            password_saved: false,
            password_error: None,
            task: None,
            _subscriptions: subs,
        }
    }

    #[must_use]
    pub fn last_synced_user_id(&self) -> Option<&str> {
        self.last_synced_user_id.as_deref()
    }

    fn save_name(&mut self, cx: &mut Context<Self>) {
        if self.profile_busy {
            return;
        }
        let raw_name = self.display_name.read(cx).text();
        let valid_name = match validate_profile_name(&raw_name) {
            Ok(n) => n,
            Err(code) => {
                self.profile_error = Some(map_account_error_code(code, cx));
                cx.notify();
                return;
            }
        };
        let Some(svc) = cx.try_global::<Service>().map(|s| s.inner.clone()) else {
            return;
        };
        self.profile_busy = true;
        self.profile_saved = false;
        self.profile_error = None;
        cx.notify();

        self.task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move { svc.update_profile(Some(&valid_name), None) })
                .await;
            this.update(cx, |v, cx| {
                v.profile_busy = false;
                v.task = None;
                match res {
                    Ok(state) => {
                        v.profile_saved = true;
                        apply_account_state(state, cx);
                    }
                    Err(err) => {
                        v.profile_error = Some(map_account_error(&err, cx));
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn choose_avatar(&mut self, cx: &mut Context<Self>) {
        if self.profile_busy {
            return;
        }
        let picked = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: None,
        });
        let Some(svc) = cx.try_global::<Service>().map(|s| s.inner.clone()) else {
            return;
        };
        self.task = Some(cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            this.update(cx, |v, cx| {
                v.profile_busy = true;
                v.profile_saved = false;
                v.profile_error = None;
                cx.notify();
            })
            .ok();
            let res = cx
                .background_executor()
                .spawn(async move {
                    let bytes = std::fs::read(&path).map_err(|e| {
                        AccountError::new(AccountErrorCode::InvalidAvatar, e.to_string())
                    })?;
                    let data_url = crop_and_encode_avatar(&bytes)
                        .map_err(|code| AccountError::new(code, "avatar crop failed"))?;
                    svc.update_profile(None, Some(Some(&data_url)))
                })
                .await;
            this.update(cx, |v, cx| {
                v.profile_busy = false;
                v.task = None;
                match res {
                    Ok(state) => {
                        v.profile_saved = true;
                        apply_account_state(state, cx);
                    }
                    Err(err) => {
                        v.profile_error = Some(map_account_error(&err, cx));
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn remove_avatar(&mut self, cx: &mut Context<Self>) {
        if self.profile_busy {
            return;
        }
        let Some(svc) = cx.try_global::<Service>().map(|s| s.inner.clone()) else {
            return;
        };
        self.profile_busy = true;
        self.profile_saved = false;
        self.profile_error = None;
        cx.notify();
        self.task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move { svc.update_profile(None, Some(None)) })
                .await;
            this.update(cx, |v, cx| {
                v.profile_busy = false;
                v.task = None;
                match res {
                    Ok(state) => {
                        v.profile_saved = true;
                        apply_account_state(state, cx);
                    }
                    Err(err) => {
                        v.profile_error = Some(map_account_error(&err, cx));
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn submit_password(&mut self, cx: &mut Context<Self>) {
        use keys::settings::hosted::account_errors as ae;
        if self.password_busy {
            return;
        }
        let cur = self.current_password.read(cx).text();
        let next = self.new_password.read(cx).text();
        let conf = self.confirm_password.read(cx).text();

        if cur.is_empty() {
            self.password_error = Some(t(cx, ae::CURRENT_PASSWORD_REQUIRED));
            cx.notify();
            return;
        }
        let char_len = next.chars().count();
        if !(MIN_PASSWORD_BYTES..=MAX_PASSWORD_LENGTH).contains(&char_len) {
            self.password_error = Some(t(cx, ae::INVALID_PASSWORD_LENGTH));
            cx.notify();
            return;
        }
        if next != conf {
            self.password_error = Some(t(cx, ae::PASSWORD_MISMATCH));
            cx.notify();
            return;
        }
        if cur == next {
            self.password_error = Some(t(cx, ae::PASSWORD_UNCHANGED));
            cx.notify();
            return;
        }

        let Some(svc) = cx.try_global::<Service>().map(|s| s.inner.clone()) else {
            return;
        };
        self.password_busy = true;
        self.password_saved = false;
        self.password_error = None;
        cx.notify();

        self.task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move { svc.change_password(&cur, &next) })
                .await;
            this.update(cx, |v, cx| {
                v.password_busy = false;
                v.task = None;
                match res {
                    Ok(state) => {
                        v.password_saved = true;
                        v.current_password.update(cx, |f, cx| f.set_text("", cx));
                        v.new_password.update(cx, |f, cx| f.set_text("", cx));
                        v.confirm_password.update(cx, |f, cx| f.set_text("", cx));
                        apply_account_state(state, cx);
                    }
                    Err(err) => {
                        v.password_error = Some(map_account_error(&err, cx));
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }
}

fn map_account_error(err: &AccountError, cx: &App) -> SharedString {
    map_account_error_code(err.code, cx)
}

fn map_account_error_code(code: AccountErrorCode, cx: &App) -> SharedString {
    use keys::settings::hosted::account_errors as ae;
    let key: Key = match code {
        AccountErrorCode::InvalidName => ae::INVALID_PROFILE_NAME,
        AccountErrorCode::InvalidAvatar => ae::INVALID_AVATAR,
        AccountErrorCode::UnsupportedAvatarFormat => ae::AVATAR_FILE_TYPE,
        AccountErrorCode::AvatarTooLarge => ae::AVATAR_FILE_SIZE,
        AccountErrorCode::InvalidCurrentPassword => ae::INVALID_PASSWORD,
        AccountErrorCode::PasswordTooShort => ae::INVALID_PASSWORD_LENGTH,
        AccountErrorCode::Unauthorized => ae::UNAUTHORIZED,
        _ => ae::GENERIC,
    };
    t(cx, key)
}

impl Render for AccountSettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use keys::settings::hosted as h;
        use keys::settings::hosted::session as sess;

        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let entity = cx.entity();

        let (state, signing_out) = cx
            .try_global::<Service>()
            .map(|svc| (svc.state.clone(), svc.signing_out))
            .unwrap_or_else(|| {
                (
                    dr_account::AccountState {
                        hosted_configured: false,
                        origin: None,
                        status: SessionStatus::SignedOut,
                        user: None,
                        providers: dr_account::AuthProviders::default(),
                        active_library_dir: std::path::PathBuf::new(),
                        is_account_library: false,
                    },
                    false,
                )
            });

        let status_desc = match state.status {
            SessionStatus::SignedOut => t(cx, sess::SIGNED_OUT),
            SessionStatus::Checking => t(cx, sess::CHECKING),
            SessionStatus::Connected => t(cx, sess::CONNECTED),
            SessionStatus::Offline => t(cx, sess::OFFLINE),
            SessionStatus::NeedsReauth => t(cx, sess::NEEDS_REAUTH),
        };

        let header_title: SharedString = match &state.user {
            Some(user) => format!("{} ({})", user.display_name(), user.email).into(),
            None => t(cx, h::NO_ACCOUNT),
        };

        let action_btn = if !state.hosted_configured {
            div().into_any_element()
        } else if state.status.has_account() && state.status != SessionStatus::NeedsReauth {
            let label = if signing_out {
                t(cx, h::WORKING)
            } else {
                t(cx, h::SIGN_OUT)
            };
            div()
                .debug_selector(|| "settings-account-signout".to_owned())
                .child(
                    Button::new("settings-account-signout", label)
                        .small()
                        .disabled(signing_out)
                        .on_click(|_, _, cx| sign_out(cx)),
                )
                .into_any_element()
        } else {
            Button::new("settings-account-signin", t(cx, h::SIGN_IN))
                .primary()
                .small()
                .on_click(|_, window, cx| open_auth_dialog(window, cx))
                .into_any_element()
        };

        let status_row = div()
            .py(px(12.0))
            .border_b(px(0.5))
            .border_color(p.local_hairline())
            .flex()
            .flex_row()
            .items_center()
            .gap(px(space::S4))
            .child(dr_shell::account::avatar(36.0, window, cx))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(s.body, s.line_body)
                            .text_color(p.ink(1).solid())
                            .child(header_title),
                    )
                    .child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(s.secondary, s.line_body)
                            .text_color(p.muted().solid())
                            .child(status_desc),
                    ),
            )
            .child(action_btn);

        let mut col = div()
            .id("settings-account-hosted")
            .flex()
            .flex_col()
            .gap(px(space::S5))
            .child(
                div()
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.muted().solid())
                    .child(t(cx, h::DESCRIPTION)),
            )
            .child(status_row);

        if state.status == SessionStatus::Connected {
            let has_avatar = state.user.as_ref().and_then(|u| u.image.as_ref()).is_some();
            let e_choose = entity.clone();
            let e_remove = entity.clone();
            let e_save_name = entity.clone();
            let e_save_pw = entity.clone();

            let profile_section = div()
                .pt(px(space::S3))
                .flex()
                .flex_col()
                .gap(px(space::S3))
                .child(
                    div()
                        .font_role(Role::Ui)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.muted().solid())
                        .child(t(cx, h::PROFILE_TITLE)),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .gap(px(space::S4))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(2.0))
                                .child(
                                    div()
                                        .font_role(Role::Ui)
                                        .type_px(s.body, s.line_body)
                                        .text_color(p.ink(1).solid())
                                        .child(t(cx, h::AVATAR)),
                                )
                                .child(
                                    div()
                                        .font_role(Role::Ui)
                                        .type_px(s.secondary, s.line_body)
                                        .text_color(p.muted().solid())
                                        .child(t(cx, h::AVATAR_DESCRIPTION)),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(space::S2))
                                .child(
                                    Button::new("account-choose-avatar", t(cx, h::CHOOSE_AVATAR))
                                        .small()
                                        .disabled(self.profile_busy)
                                        .on_click(move |_, _, cx| {
                                            e_choose.update(cx, |v, cx| v.choose_avatar(cx))
                                        }),
                                )
                                .when(has_avatar, |el| {
                                    el.child(
                                        Button::new(
                                            "account-remove-avatar",
                                            t(cx, h::REMOVE_AVATAR),
                                        )
                                        .text()
                                        .small()
                                        .disabled(self.profile_busy)
                                        .on_click(
                                            move |_, _, cx| {
                                                e_remove.update(cx, |v, cx| v.remove_avatar(cx))
                                            },
                                        ),
                                    )
                                }),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(space::S3))
                        .child(div().flex_1().child(self.display_name.clone()))
                        .child(
                            Button::new("account-save-profile", t(cx, h::SAVE_PROFILE))
                                .small()
                                .disabled(self.profile_busy)
                                .on_click(move |_, _, cx| {
                                    e_save_name.update(cx, |v, cx| v.save_name(cx))
                                }),
                        ),
                )
                .when(self.profile_saved, |el| {
                    el.child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(s.secondary, s.line_body)
                            .text_color(p.ink(2).solid())
                            .child(t(cx, h::PROFILE_SAVED)),
                    )
                })
                .when_some(self.profile_error.clone(), |el, err| {
                    el.child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(s.secondary, s.line_body)
                            .text_color(p.danger.solid())
                            .child(err),
                    )
                });

            let password_section = div()
                .pt(px(space::S4))
                .border_t(px(0.5))
                .border_color(p.local_hairline())
                .flex()
                .flex_col()
                .gap(px(space::S3))
                .child(
                    div()
                        .font_role(Role::Ui)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.muted().solid())
                        .child(t(cx, h::PASSWORD_TITLE)),
                )
                .child(
                    div()
                        .font_role(Role::Ui)
                        .type_px(s.secondary, s.line_body)
                        .text_color(p.muted().solid())
                        .child(format!(
                            "{} {}",
                            t(cx, h::PASSWORD_DESCRIPTION),
                            t(cx, h::PASSWORD_SESSIONS)
                        )),
                )
                .child(self.current_password.clone())
                .child(self.new_password.clone())
                .child(self.confirm_password.clone())
                .child(
                    div().flex().flex_row().justify_end().child(
                        Button::new("account-change-password", t(cx, h::CHANGE_PASSWORD))
                            .small()
                            .disabled(self.password_busy)
                            .on_click(move |_, _, cx| {
                                e_save_pw.update(cx, |v, cx| v.submit_password(cx))
                            }),
                    ),
                )
                .when(self.password_saved, |el| {
                    el.child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(s.secondary, s.line_body)
                            .text_color(p.ink(2).solid())
                            .child(t(cx, h::PASSWORD_SAVED)),
                    )
                })
                .when_some(self.password_error.clone(), |el, err| {
                    el.child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(s.secondary, s.line_body)
                            .text_color(p.danger.solid())
                            .child(err),
                    )
                });

            col = col.child(profile_section).child(password_section);
        }

        col
    }
}
