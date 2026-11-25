//! Settings → Account view (`AccountSettingsView`): status, sign-in/sign-out,
//! cloud sync controls & quota meter, interactive avatar cropper, profile name
//! editor, and password change.

use std::rc::Rc;
use std::sync::Arc;

use dr_account::{
    AccountError, AccountErrorCode, MAX_PASSWORD_LENGTH, MIN_PASSWORD_BYTES, SessionStatus,
    crop_and_encode_avatar_with_transform, decode_avatar_source, validate_profile_name,
};
use dr_i18n::{Key, keys};
use dr_shell::strings::tf;
use dr_shell::sync::SyncUsage;
use dr_shell::t;
use dr_ui::{
    Theme,
    components::{Button, Dialog},
    fonts::Role,
    input::field::{FieldEvent, TextField},
    sand,
    style::DrStyled,
    tokens::{radius, space},
};
use gpui::{
    App, AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Point,
    Render, RenderImage, ScrollDelta, ScrollEvent, SharedString, Styled, Subscription, Task,
    Window, div, img, prelude::FluentBuilder as _, px,
};
use image::{DynamicImage, Frame, GenericImageView as _, RgbaImage, imageops::FilterType};
use smallvec::SmallVec;

use crate::{
    Service, apply_account_state, open_auth_dialog, request_sign_out, shown_account_state,
    sign_out, sign_out_immediate,
};

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
    sync_usage: Option<SyncUsage>,
    usage_fetched_for_user: Option<String>,
    usage_task: Option<Task<()>>,
    task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl AccountSettingsView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        use keys::settings::hosted as h;
        let shown_user = shown_account_state(cx).0.user;
        let initial_name = shown_user
            .as_ref()
            .map(|u| u.name.clone())
            .unwrap_or_default();
        let initial_user_id = shown_user.as_ref().map(|u| u.id.clone());

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
            TextField::new("account-current-password", window, cx)
                .placeholder(cur_pw_ph)
                .secure(true)
        });
        let new_password = cx.new(|cx| {
            TextField::new("account-new-password", window, cx)
                .placeholder(new_pw_ph)
                .secure(true)
        });
        let confirm_password = cx.new(|cx| {
            TextField::new("account-confirm-password", window, cx)
                .placeholder(conf_pw_ph)
                .secure(true)
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
                let user_opt = shown_account_state(cx).0.user;
                let next_id = user_opt.as_ref().map(|u| u.id.clone());
                if next_id != view.last_synced_user_id {
                    view.last_synced_user_id = next_id;
                    view.sync_usage = None;
                    view.usage_fetched_for_user = None;
                    let text = user_opt.map(|u| u.name).unwrap_or_default();
                    view.display_name.update(cx, |f, cx| f.set_text(text, cx));
                }
                cx.notify();
            }));
        }

        let mut view = Self {
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
            sync_usage: None,
            usage_fetched_for_user: None,
            usage_task: None,
            task: None,
            _subscriptions: subs,
        };
        view.refresh_usage_if_needed(cx);
        view
    }

    fn refresh_usage_if_needed(&mut self, cx: &mut Context<Self>) {
        let state = shown_account_state(cx).0;
        let user_id = state.user.as_ref().map(|u| u.id.clone());
        if state.status != SessionStatus::Connected {
            return;
        }
        if user_id.is_some() && self.usage_fetched_for_user == user_id {
            return;
        }
        let Some(fut) = dr_shell::sync::fetch_usage(cx) else {
            return;
        };
        self.usage_fetched_for_user = user_id;
        self.usage_task = Some(cx.spawn(async move |this, cx| {
            let res = fut.await;
            this.update(cx, |v, cx| {
                v.usage_task = None;
                if let Ok(usage) = res {
                    v.sync_usage = Some(usage);
                    cx.notify();
                }
            })
            .ok();
        }));
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

    fn choose_avatar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.profile_busy {
            return;
        }
        let picked = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: None,
        });
        let view_entity = cx.entity();
        self.task = Some(cx.spawn_in(window, async move |this, cx| {
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
            let decoded = cx
                .background_executor()
                .spawn(async move {
                    let bytes = std::fs::read(&path).map_err(|e| {
                        AccountError::new(AccountErrorCode::InvalidAvatar, e.to_string())
                    })?;
                    let source = decode_avatar_source(&bytes)
                        .map_err(|code| AccountError::new(code, "avatar decode failed"))?;
                    let preview = build_preview_render_image(&source);
                    Ok::<_, AccountError>((Arc::new(source), preview))
                })
                .await;
            this.update_in(cx, |v, window, cx| {
                v.profile_busy = false;
                v.task = None;
                match decoded {
                    Ok((source, preview)) => {
                        open_avatar_crop_dialog(source, preview, view_entity.clone(), window, cx);
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

        let (state, _, signing_out) = shown_account_state(cx);

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
                        .on_click(|_, window, cx| request_sign_out(window, cx)),
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

        if state.status.has_account() {
            self.refresh_usage_if_needed(cx);
            let sync_st = dr_shell::sync::status(cx);
            let sync_headline = if sync_st.quota_blocked {
                t(cx, h::QUOTA_BLOCKED)
            } else if sync_st.init_failed {
                t(cx, h::NOT_STARTED)
            } else if sync_st.paused {
                t(cx, h::PAUSED)
            } else if sync_st.retrying {
                t(cx, h::RETRYING)
            } else if sync_st.syncing || sync_st.pending_count > 0 {
                t(cx, h::PENDING)
            } else {
                t(cx, h::ENABLED)
            };

            let mut sync_meta = div().flex().flex_col().gap(px(4.0)).child(
                div()
                    .font_role(Role::Ui)
                    .type_px(s.body, s.line_body)
                    .text_color(if sync_st.quota_blocked || sync_st.init_failed {
                        p.danger.solid()
                    } else {
                        p.ink(1).solid()
                    })
                    .child(dr_ui::text::wrapped(sync_headline)),
            );

            if let Some(last_ms) = sync_st.last_sync_ok_ms {
                let time_label = format_sync_time(last_ms);
                sync_meta = sync_meta.child(
                    div()
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.muted().solid())
                        .child(tf(cx, h::LAST_SYNCED, &[("time", &time_label)])),
                );
            }

            if let Some(usage) = self.sync_usage {
                let quota = usage.quota_bytes.max(1);
                let frac = (usage.used_bytes as f32 / quota as f32).clamp(0.0, 1.0);
                let used_str = format_bytes(usage.used_bytes);
                let quota_str = format_bytes(usage.quota_bytes);
                sync_meta =
                    sync_meta.child(
                        div()
                            .pt(px(space::S2))
                            .flex()
                            .flex_col()
                            .gap(px(4.0))
                            .child(
                                div()
                                    .font_role(Role::Ui)
                                    .type_px(s.caption, s.line_caption)
                                    .text_color(p.ink(2).solid())
                                    .child(t(cx, h::STORAGE)),
                            )
                            .child(
                                sand::Readout::new("account-sync-quota", frac)
                                    .color(if frac > 0.9 { p.danger } else { p.accent }),
                            )
                            .child(
                                div()
                                    .font_role(Role::Ui)
                                    .type_px(s.caption, s.line_caption)
                                    .text_color(p.muted().solid())
                                    .child(dr_ui::text::wrapped(tf(
                                        cx,
                                        h::STORAGE_DESCRIPTION,
                                        &[("used", &used_str), ("quota", &quota_str)],
                                    ))),
                            ),
                    );
            }

            let paused = sync_st.paused;
            let pause_label = if paused {
                t(cx, h::RESUME)
            } else {
                t(cx, h::PAUSE)
            };
            let sync_actions = div()
                .flex()
                .flex_row()
                .flex_wrap()
                .items_center()
                .gap(px(space::S2))
                .child(
                    Button::new("account-sync-now", t(cx, h::SYNC_NOW))
                        .small()
                        .disabled(sync_st.syncing || state.status != SessionStatus::Connected)
                        .on_click(|_, _, cx| dr_shell::sync::sync_now(cx)),
                )
                .child(
                    Button::new("account-sync-pause", pause_label)
                        .small()
                        .disabled(state.status != SessionStatus::Connected)
                        .on_click(move |_, _, cx| dr_shell::sync::set_paused(!paused, cx)),
                )
                .child(
                    Button::new("account-sync-disconnect", t(cx, h::DISCONNECT))
                        .text()
                        .small()
                        .disabled(signing_out)
                        .on_click(|_, window, cx| open_disconnect_sync_dialog(window, cx)),
                );

            let sync_section = div()
                .pt(px(space::S2))
                .pb(px(space::S3))
                .border_b(px(0.5))
                .border_color(p.local_hairline())
                .flex()
                .flex_col()
                .gap(px(space::S3))
                .child(
                    div()
                        .font_role(Role::Ui)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.muted().solid())
                        .child(t(cx, h::SYNC_TITLE)),
                )
                .child(sync_meta)
                .child(sync_actions);

            col = col.child(sync_section);
        }

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
                                        .on_click(move |_, window, cx| {
                                            e_choose.update(cx, |v, cx| v.choose_avatar(window, cx))
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

fn format_bytes(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let b = bytes as f64;
    if b >= GIB {
        format!("{:.2} GB", b / GIB)
    } else if b >= MIB {
        format!("{:.1} MB", b / MIB)
    } else if b >= KIB {
        format!("{:.0} KB", b / KIB)
    } else {
        format!("{bytes} B")
    }
}

fn format_sync_time(ts_ms: u64) -> String {
    let now = dr_shell::sync::current_time_ms();
    let secs = now.saturating_sub(ts_ms) / 1000;
    if secs < 60 {
        "< 1m".to_owned()
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86_400 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86_400)
    }
}

fn build_preview_render_image(source: &DynamicImage) -> Arc<RenderImage> {
    let (w, h) = source.dimensions();
    let max_dim = w.max(h);
    let preview = if max_dim > 512 {
        let scale = 512.0 / max_dim as f32;
        let nw = ((w as f32 * scale).round() as u32).max(1);
        let nh = ((h as f32 * scale).round() as u32).max(1);
        source.resize_exact(nw, nh, FilterType::Triangle)
    } else {
        source.clone()
    };
    let rgba = preview.to_rgba8();
    let mut bgra = RgbaImage::new(rgba.width(), rgba.height());
    for (dst, src) in bgra.pixels_mut().zip(rgba.pixels()) {
        dst.0 = [src.0[2], src.0[1], src.0[0], src.0[3]];
    }
    Arc::new(RenderImage::new(SmallVec::from_elem(Frame::new(bgra), 1)))
}

fn open_disconnect_sync_dialog(window: &mut Window, cx: &mut App) {
    let handle = window.window_handle();
    let slot: Rc<std::cell::Cell<Option<gpui::EntityId>>> = Rc::new(std::cell::Cell::new(None));
    let slot_close = slot.clone();
    let close: dr_shell::dialogs::Close = Rc::new(move |_, cx| {
        if let Some(id) = slot_close.get() {
            dr_shell::dialogs::hide(cx, id);
        }
    });
    let view = cx.new(|_| DisconnectSyncDialog { close });
    slot.set(Some(view.entity_id()));
    dr_shell::dialogs::show_in(handle, cx, view.into());
}

struct DisconnectSyncDialog {
    close: dr_shell::dialogs::Close,
}

impl Render for DisconnectSyncDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use keys::settings::hosted as h;
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let st = dr_shell::sync::status(cx);
        let close_x = self.close.clone();
        let close_cancel = self.close.clone();
        let close_immediate = self.close.clone();
        let close_drain = self.close.clone();

        let mut body = div().flex().flex_col().gap(px(space::S3)).child(
            div()
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(p.ink(2).solid())
                .child(dr_ui::text::wrapped(t(cx, h::DISCONNECT_DESCRIPTION))),
        );
        if st.pending_count > 0 {
            body = body.child(
                div()
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.danger.solid())
                    .child(dr_ui::text::wrapped(tf(
                        cx,
                        h::DISCONNECT_UNUPLOADED,
                        &[("count", &st.pending_count)],
                    ))),
            );
        }

        let immediate_label = if st.pending_count > 0 {
            t(cx, h::DISCONNECT_NOW)
        } else {
            t(cx, h::DISCONNECT_ANYWAY)
        };

        let mut dialog = Dialog::new("disconnect-sync-dialog", t(cx, h::DISCONNECT))
            .width(420.0)
            .on_close(move |window, cx| close_x(window, cx))
            .body(body)
            .action(
                Button::new("disconnect-cancel", t(cx, keys::common::CANCEL))
                    .text()
                    .on_click(move |_, window, cx| close_cancel(window, cx)),
            );
        if st.pending_count > 0 || st.offline || st.retrying {
            dialog = dialog.action(Button::new("disconnect-now", immediate_label).on_click(
                move |_, window, cx| {
                    close_immediate(window, cx);
                    sign_out_immediate(cx);
                },
            ));
        }
        dialog = dialog.action(
            Button::new("disconnect-confirm", t(cx, h::DISCONNECT))
                .primary()
                .on_click(move |_, window, cx| {
                    close_drain(window, cx);
                    sign_out(cx);
                }),
        );
        div().child(dialog)
    }
}

const CROP_VIEWPORT: f32 = 192.0;

fn open_avatar_crop_dialog(
    source: Arc<DynamicImage>,
    preview: Arc<RenderImage>,
    parent: Entity<AccountSettingsView>,
    window: &mut Window,
    cx: &mut App,
) {
    let handle = window.window_handle();
    let slot: Rc<std::cell::Cell<Option<gpui::EntityId>>> = Rc::new(std::cell::Cell::new(None));
    let slot_close = slot.clone();
    let close: dr_shell::dialogs::Close = Rc::new(move |_, cx| {
        if let Some(id) = slot_close.get() {
            dr_shell::dialogs::hide(cx, id);
        }
    });
    let (w, h) = source.dimensions();
    let view = cx.new(|cx| AvatarCropDialog {
        source,
        preview,
        src_w: w.max(1) as f32,
        src_h: h.max(1) as f32,
        zoom: 1.0,
        offset_x: 0.0,
        offset_y: 0.0,
        dragging: None,
        focus_handle: cx.focus_handle(),
        busy: false,
        error: None,
        parent,
        close,
        task: None,
    });
    slot.set(Some(view.entity_id()));
    dr_shell::dialogs::show_in(handle, cx, view.into());
}

struct AvatarCropDialog {
    source: Arc<DynamicImage>,
    preview: Arc<RenderImage>,
    src_w: f32,
    src_h: f32,
    zoom: f32,
    offset_x: f32,
    offset_y: f32,
    dragging: Option<(Point<gpui::Pixels>, f32, f32)>,
    focus_handle: FocusHandle,
    busy: bool,
    error: Option<SharedString>,
    parent: Entity<AccountSettingsView>,
    close: dr_shell::dialogs::Close,
    task: Option<Task<()>>,
}

impl Focusable for AvatarCropDialog {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl AvatarCropDialog {
    fn display_metrics(&self) -> (f32, f32, f32, f32) {
        let min_side = self.src_w.min(self.src_h).max(1.0);
        let scale = (CROP_VIEWPORT / min_side) * self.zoom.clamp(1.0, 3.0);
        let disp_w = self.src_w * scale;
        let disp_h = self.src_h * scale;
        let max_tx = ((disp_w - CROP_VIEWPORT) / 2.0).max(0.0);
        let max_ty = ((disp_h - CROP_VIEWPORT) / 2.0).max(0.0);
        (disp_w, disp_h, max_tx, max_ty)
    }

    fn set_zoom(&mut self, next: f32, cx: &mut Context<Self>) {
        self.zoom = next.clamp(1.0, 3.0);
        cx.notify();
    }

    fn confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Some(svc) = cx.try_global::<Service>().map(|s| s.inner.clone()) else {
            return;
        };
        let source = Arc::clone(&self.source);
        let zoom = self.zoom;
        let offset_x = self.offset_x;
        let offset_y = self.offset_y;
        self.busy = true;
        self.error = None;
        cx.notify();

        self.task = Some(cx.spawn_in(window, async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    let data_url =
                        crop_and_encode_avatar_with_transform(&source, zoom, offset_x, offset_y)
                            .map_err(|code| AccountError::new(code, "avatar crop failed"))?;
                    svc.update_profile(None, Some(Some(&data_url)))
                })
                .await;
            this.update_in(cx, |d, window, cx| {
                d.busy = false;
                d.task = None;
                match res {
                    Ok(state) => {
                        d.parent.update(cx, |v, cx| {
                            v.profile_saved = true;
                            v.profile_error = None;
                            cx.notify();
                        });
                        apply_account_state(state, cx);
                        (d.close.clone())(window, cx);
                    }
                    Err(err) => {
                        d.error = Some(map_account_error(&err, cx));
                        cx.notify();
                    }
                }
            })
            .ok();
        }));
    }
}

impl Render for AvatarCropDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use keys::settings::hosted as h;
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let (disp_w, disp_h, max_tx, max_ty) = self.display_metrics();
        let left = (CROP_VIEWPORT - disp_w) / 2.0 + self.offset_x * max_tx;
        let top = (CROP_VIEWPORT - disp_h) / 2.0 + self.offset_y * max_ty;
        let zoom_pct = ((self.zoom - 1.0) / 2.0).clamp(0.0, 1.0);
        let close_x = self.close.clone();
        let close_cancel = self.close.clone();
        let e_minus = cx.entity();
        let e_plus = cx.entity();
        let e_confirm = cx.entity();

        let viewport = div()
            .id("avatar-crop-viewport")
            .track_focus(&self.focus_handle)
            .relative()
            .w(px(CROP_VIEWPORT))
            .h(px(CROP_VIEWPORT))
            .rounded_full()
            .overflow_hidden()
            .bg(gpui::rgb(0x141210))
            .border_1()
            .border_color(p.hairline())
            .cursor_grab()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, ev: &MouseDownEvent, window, cx| {
                    window.focus(&this.focus_handle, cx);
                    this.dragging = Some((ev.position, this.offset_x, this.offset_y));
                    cx.notify();
                }),
            )
            .on_mouse_move(cx.listener(|this, ev: &MouseMoveEvent, _, cx| {
                let Some((start, ox, oy)) = this.dragging else {
                    return;
                };
                if !ev.dragging() {
                    this.dragging = None;
                    return;
                }
                let (_, _, max_tx, max_ty) = this.display_metrics();
                if max_tx > 0.5 {
                    let dx = f32::from(ev.position.x - start.x);
                    this.offset_x = (ox + dx / max_tx).clamp(-1.0, 1.0);
                }
                if max_ty > 0.5 {
                    let dy = f32::from(ev.position.y - start.y);
                    this.offset_y = (oy + dy / max_ty).clamp(-1.0, 1.0);
                }
                cx.notify();
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _: &MouseUpEvent, _, _| {
                    this.dragging = None;
                }),
            )
            .on_scroll(cx.listener(|this, ev: &ScrollEvent, _, cx| {
                let dy = match ev.delta {
                    ScrollDelta::Lines(pt) => pt.y * 0.1,
                    ScrollDelta::Pixels(pt) => f32::from(pt.y) / 160.0,
                };
                this.set_zoom(this.zoom + dy, cx);
            }))
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                match ev.keystroke.key.as_str() {
                    "left" => {
                        this.offset_x = (this.offset_x - 0.08).clamp(-1.0, 1.0);
                        cx.notify();
                    }
                    "right" => {
                        this.offset_x = (this.offset_x + 0.08).clamp(-1.0, 1.0);
                        cx.notify();
                    }
                    "up" => {
                        this.offset_y = (this.offset_y - 0.08).clamp(-1.0, 1.0);
                        cx.notify();
                    }
                    "down" => {
                        this.offset_y = (this.offset_y + 0.08).clamp(-1.0, 1.0);
                        cx.notify();
                    }
                    "+" | "=" => this.set_zoom(this.zoom + 0.15, cx),
                    "-" => this.set_zoom(this.zoom - 0.15, cx),
                    "escape" if !this.busy => (this.close.clone())(window, cx),
                    _ => {}
                }
            }))
            .child(
                img(self.preview.clone())
                    .absolute()
                    .left(px(left))
                    .top(px(top))
                    .w(px(disp_w))
                    .h(px(disp_h)),
            );

        let zoom_bar = div()
            .w_full()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(space::S2))
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.muted().solid())
                    .child(t(cx, h::CROP_ZOOM)),
            )
            .child(
                Button::new("avatar-crop-zoom-out", "−")
                    .small()
                    .disabled(self.zoom <= 1.01)
                    .on_click(move |_, _, cx| {
                        e_minus.update(cx, |d, cx| d.set_zoom(d.zoom - 0.2, cx))
                    }),
            )
            .child(
                div()
                    .flex_1()
                    .child(sand::Readout::new("avatar-crop-zoom-bar", zoom_pct).color(p.accent)),
            )
            .child(
                Button::new("avatar-crop-zoom-in", "+")
                    .small()
                    .disabled(self.zoom >= 2.99)
                    .on_click(move |_, _, cx| {
                        e_plus.update(cx, |d, cx| d.set_zoom(d.zoom + 0.2, cx))
                    }),
            )
            .child(
                div()
                    .w(px(36.0))
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.ink(2).solid())
                    .child(format!("{:.1}×", self.zoom)),
            );

        let mut body = div()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(space::S4))
            .child(
                div()
                    .w_full()
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.muted().solid())
                    .child(dr_ui::text::wrapped(t(cx, h::CROP_DESCRIPTION))),
            )
            .child(
                div()
                    .p(px(space::S3))
                    .rounded(px(radius::MD))
                    .bg(p.ink(1).alpha(0.03))
                    .child(viewport),
            )
            .child(zoom_bar);

        if let Some(err) = &self.error {
            body = body.child(
                div()
                    .w_full()
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.danger.solid())
                    .child(err.clone()),
            );
        }

        div().child(
            Dialog::new("avatar-crop-dialog", t(cx, h::CROP_TITLE))
                .width(380.0)
                .on_close(move |window, cx| close_x(window, cx))
                .body(body)
                .action(
                    Button::new("avatar-crop-cancel", t(cx, keys::common::CANCEL))
                        .text()
                        .disabled(self.busy)
                        .on_click(move |_, window, cx| close_cancel(window, cx)),
                )
                .action(
                    Button::new("avatar-crop-confirm", t(cx, h::CROP_CONFIRM))
                        .primary()
                        .disabled(self.busy)
                        .busy(self.busy)
                        .on_click(move |_, window, cx| {
                            e_confirm.update(cx, |d, cx| d.confirm(window, cx))
                        }),
                ),
        )
    }
}
