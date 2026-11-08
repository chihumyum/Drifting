//! Authentication dialog (`AuthDialog`): email/password sign-in, sign-up with
//! email verification OTP, passwordless email OTP sign-in, forgot/reset password,
//! and Google PKCE OAuth.

use dr_account::{AccountError, AccountErrorCode, AccountState, OtpPurpose, SignUpOutcome};
use dr_i18n::{Key, keys};
use dr_shell::dialogs::Close;
use dr_shell::strings::tf;
use dr_shell::t;
use dr_ui::{
    Theme,
    components::{Button, Dialog},
    fonts::Role,
    input::field::{FieldEvent, TextField},
    sand::{self, Icon},
    style::DrStyled,
    tokens::space,
};
use gpui::{
    App, AppContext as _, Context, Entity, IntoElement, ParentElement, Render, SharedString,
    Styled, Subscription, Task, Window, div, prelude::FluentBuilder as _, px,
};

use crate::{Service, apply_account_state};

pub const WIDTH: f32 = 420.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthMode {
    SignIn,
    SignUp,
    VerifyEmail,
    EmailOtp,
    ForgotPassword,
}

pub struct AuthDialog {
    mode: AuthMode,
    pen_name: Entity<TextField>,
    email: Entity<TextField>,
    password: Entity<TextField>,
    confirm_password: Entity<TextField>,
    otp: Entity<TextField>,
    otp_sent: bool,
    reset_done: bool,
    waiting_oauth: bool,
    busy: bool,
    error: Option<SharedString>,
    close: Close,
    task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl AuthDialog {
    pub fn new(close: Close, window: &mut Window, cx: &mut Context<Self>) -> Self {
        use keys::auth::fields as f;
        let pen_name_ph = t(cx, f::PEN_NAME_PLACEHOLDER);
        let email_ph = t(cx, f::EMAIL_PLACEHOLDER);
        let password_ph = t(cx, f::PASSWORD_SIGNUP_PLACEHOLDER);
        let code_ph = t(cx, f::CODE_PLACEHOLDER);

        let pen_name =
            cx.new(|cx| TextField::new("auth-pen-name", window, cx).placeholder(pen_name_ph));
        let email = cx.new(|cx| TextField::new("auth-email", window, cx).placeholder(email_ph));
        let password = cx
            .new(|cx| TextField::new("auth-password", window, cx).placeholder(password_ph.clone()));
        let confirm_password = cx
            .new(|cx| TextField::new("auth-confirm-password", window, cx).placeholder(password_ph));
        let otp = cx.new(|cx| TextField::new("auth-otp", window, cx).placeholder(code_ph));

        let mut subs = Vec::new();
        for field in [&pen_name, &email, &password, &confirm_password, &otp] {
            subs.push(cx.subscribe_in(field, window, Self::on_field));
        }

        Self {
            mode: AuthMode::SignIn,
            pen_name,
            email,
            password,
            confirm_password,
            otp,
            otp_sent: false,
            reset_done: false,
            waiting_oauth: false,
            busy: false,
            error: None,
            close,
            task: None,
            _subscriptions: subs,
        }
    }

    pub fn mode(&self) -> AuthMode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: AuthMode, cx: &mut Context<Self>) {
        self.mode = mode;
        self.error = None;
        self.reset_done = false;
        self.waiting_oauth = false;
        if mode != AuthMode::EmailOtp && mode != AuthMode::ForgotPassword {
            self.otp_sent = false;
        }
        cx.notify();
    }

    fn on_field(
        &mut self,
        _: &Entity<TextField>,
        event: &FieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            FieldEvent::Changed(_) => {
                self.error = None;
                cx.notify();
            }
            FieldEvent::Cancelled => {
                if !self.busy {
                    (self.close.clone())(window, cx);
                }
            }
            FieldEvent::Submitted(_) => self.submit(window, cx),
            FieldEvent::Blurred => {}
        }
    }

    pub fn start_google(&mut self, cx: &mut Context<Self>) {
        let Some(svc) = cx.try_global::<Service>().map(|s| s.inner.clone()) else {
            return;
        };
        match svc.start_google_oauth() {
            Ok(url) => {
                self.waiting_oauth = true;
                self.error = None;
                cx.open_url(&url);
                cx.notify();
            }
            Err(err) => {
                self.error = Some(map_auth_error(&err, cx));
                cx.notify();
            }
        }
    }

    pub fn send_code(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let email_val = self.email.read(cx).text().trim().to_string();
        if email_val.is_empty() {
            self.error = Some(t(cx, keys::auth::errors::SEND_CODE_FAILED));
            cx.notify();
            return;
        }
        let Some(svc) = cx.try_global::<Service>().map(|s| s.inner.clone()) else {
            return;
        };
        let mode = self.mode;
        self.busy = true;
        self.error = None;
        cx.notify();

        self.task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    match mode {
                        AuthMode::ForgotPassword => svc.request_password_reset(&email_val),
                        AuthMode::VerifyEmail => {
                            svc.send_verification_otp(&email_val, OtpPurpose::EmailVerification)
                        }
                        _ => svc.send_verification_otp(&email_val, OtpPurpose::SignIn),
                    }
                })
                .await;
            this.update(cx, |d, cx| {
                d.busy = false;
                d.task = None;
                match res {
                    Ok(()) => {
                        d.otp_sent = true;
                        d.error = None;
                    }
                    Err(err) => {
                        d.error = Some(map_auth_error(&err, cx));
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Some(svc) = cx.try_global::<Service>().map(|s| s.inner.clone()) else {
            return;
        };
        let name = self.pen_name.read(cx).text().trim().to_string();
        let email = self.email.read(cx).text().trim().to_string();
        let password = self.password.read(cx).text();
        let confirm = self.confirm_password.read(cx).text();
        let otp = self.otp.read(cx).text().trim().to_string();

        match self.mode {
            AuthMode::SignIn => {
                if email.is_empty() || password.is_empty() {
                    self.error = Some(t(cx, keys::auth::errors::SIGN_IN_CHECK));
                    cx.notify();
                    return;
                }
                self.busy = true;
                self.error = None;
                cx.notify();
                self.task = Some(cx.spawn_in(window, async move |this, cx| {
                    let res = cx
                        .background_executor()
                        .spawn(async move { svc.sign_in_email(&email, &password) })
                        .await;
                    this.update_in(cx, |d, window, cx| {
                        d.busy = false;
                        d.task = None;
                        match res {
                            Ok(state) => d.finish_signed_in(state, window, cx),
                            Err(err) if err.code == AccountErrorCode::EmailNotVerified => {
                                d.mode = AuthMode::VerifyEmail;
                                d.otp_sent = true;
                                d.error = None;
                                cx.notify();
                            }
                            Err(err) => {
                                d.error = Some(map_auth_error(&err, cx));
                                cx.notify();
                            }
                        }
                    })
                    .ok();
                }));
            }
            AuthMode::SignUp => {
                if name.is_empty() || email.is_empty() || password.is_empty() {
                    self.error = Some(t(cx, keys::auth::errors::SIGN_UP_RETRY));
                    cx.notify();
                    return;
                }
                self.busy = true;
                self.error = None;
                cx.notify();
                self.task = Some(cx.spawn_in(window, async move |this, cx| {
                    let res = cx
                        .background_executor()
                        .spawn(async move { svc.sign_up_email(&name, &email, &password) })
                        .await;
                    this.update_in(cx, |d, window, cx| {
                        d.busy = false;
                        d.task = None;
                        match res {
                            Ok(SignUpOutcome::SignedIn(state)) => {
                                d.finish_signed_in(state, window, cx);
                            }
                            Ok(SignUpOutcome::VerificationRequired { .. }) => {
                                d.mode = AuthMode::VerifyEmail;
                                d.otp_sent = true;
                                d.error = None;
                                cx.notify();
                            }
                            Err(err) => {
                                d.error = Some(map_auth_error(&err, cx));
                                cx.notify();
                            }
                        }
                    })
                    .ok();
                }));
            }
            AuthMode::VerifyEmail => {
                if otp.is_empty() {
                    self.error = Some(t(cx, keys::auth::errors::VERIFY_FAILED));
                    cx.notify();
                    return;
                }
                self.busy = true;
                self.error = None;
                cx.notify();
                let pw_opt = (!password.is_empty()).then_some(password);
                self.task = Some(cx.spawn_in(window, async move |this, cx| {
                    let res = cx
                        .background_executor()
                        .spawn(async move { svc.verify_email_otp(&email, &otp, pw_opt.as_deref()) })
                        .await;
                    this.update_in(cx, |d, window, cx| {
                        d.busy = false;
                        d.task = None;
                        match res {
                            Ok(state) => d.finish_signed_in(state, window, cx),
                            Err(err) => {
                                d.error = Some(map_auth_error(&err, cx));
                                cx.notify();
                            }
                        }
                    })
                    .ok();
                }));
            }
            AuthMode::EmailOtp => {
                if !self.otp_sent {
                    self.send_code(cx);
                    return;
                }
                if otp.is_empty() {
                    self.error = Some(t(cx, keys::auth::errors::VERIFY_FAILED));
                    cx.notify();
                    return;
                }
                self.busy = true;
                self.error = None;
                cx.notify();
                self.task = Some(cx.spawn_in(window, async move |this, cx| {
                    let res = cx
                        .background_executor()
                        .spawn(async move { svc.sign_in_email_otp(&email, &otp) })
                        .await;
                    this.update_in(cx, |d, window, cx| {
                        d.busy = false;
                        d.task = None;
                        match res {
                            Ok(state) => d.finish_signed_in(state, window, cx),
                            Err(err) => {
                                d.error = Some(map_auth_error(&err, cx));
                                cx.notify();
                            }
                        }
                    })
                    .ok();
                }));
            }
            AuthMode::ForgotPassword => {
                if !self.otp_sent {
                    self.send_code(cx);
                    return;
                }
                if password != confirm {
                    self.error = Some(t(cx, keys::auth::forgot::PASSWORD_MISMATCH));
                    cx.notify();
                    return;
                }
                if otp.is_empty() || password.is_empty() {
                    self.error = Some(t(cx, keys::auth::forgot::RESET_FAILED));
                    cx.notify();
                    return;
                }
                self.busy = true;
                self.error = None;
                cx.notify();
                self.task = Some(cx.spawn(async move |this, cx| {
                    let res = cx
                        .background_executor()
                        .spawn(async move { svc.reset_password(&email, &otp, &password) })
                        .await;
                    this.update(cx, |d, cx| {
                        d.busy = false;
                        d.task = None;
                        match res {
                            Ok(()) => {
                                d.reset_done = true;
                                d.error = None;
                            }
                            Err(_) => {
                                d.error = Some(t(cx, keys::auth::forgot::RESET_FAILED));
                            }
                        }
                        cx.notify();
                    })
                    .ok();
                }));
            }
        }
    }

    fn finish_signed_in(
        &mut self,
        state: AccountState,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        apply_account_state(state, cx);
        (self.close.clone())(window, cx);
    }
}

pub(crate) fn map_auth_error(err: &AccountError, cx: &App) -> SharedString {
    use keys::auth::errors as e;
    let key: Key = match err.code {
        AccountErrorCode::InvalidCredentials => e::SIGN_IN_CHECK,
        AccountErrorCode::InvalidOtp | AccountErrorCode::OtpExpired => e::VERIFY_FAILED,
        AccountErrorCode::OAuthStateExpired => e::OAUTH_EXPIRED,
        AccountErrorCode::OAuthStateMismatch | AccountErrorCode::InvalidOAuthCallback => {
            e::OAUTH_FAILED
        }
        AccountErrorCode::EmailAlreadyExists | AccountErrorCode::InvalidName => e::SIGN_UP_RETRY,
        _ => e::SIGN_IN_CHECK,
    };
    t(cx, key)
}

impl Render for AuthDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use keys::auth;
        use keys::auth::fields as f;
        use keys::auth::forgot as fg;
        use keys::auth::otp as otp_k;
        use keys::auth::social as soc;
        use keys::auth::titles as ti;
        use keys::auth::verify as vf;

        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let entity = cx.entity();

        let title_key = match self.mode {
            AuthMode::SignIn => ti::SIGNIN,
            AuthMode::SignUp => ti::SIGNUP,
            AuthMode::VerifyEmail => ti::VERIFY,
            AuthMode::EmailOtp => ti::OTP,
            AuthMode::ForgotPassword => ti::FORGOT,
        };
        let title = t(cx, title_key);
        let email_text = self.email.read(cx).text();
        let google_enabled = cx
            .try_global::<Service>()
            .is_some_and(|svc| svc.state.providers.google);

        let field_block = |label_text: SharedString, field: Entity<TextField>| {
            div()
                .flex()
                .flex_col()
                .gap(px(space::S2))
                .child(
                    div()
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.muted().solid())
                        .child(label_text),
                )
                .child(field)
        };

        let mut body = div().flex().flex_col().gap(px(space::S4));

        if matches!(self.mode, AuthMode::SignIn | AuthMode::SignUp) && google_enabled {
            let google_label = if self.waiting_oauth {
                t(cx, soc::WAITING)
            } else {
                tf(cx, soc::CONTINUE_WITH, &[("provider", &"Google")])
            };
            let e_google = entity.clone();
            body = body
                .child(
                    Button::new("auth-google", google_label)
                        .disabled(self.busy)
                        .on_click(move |_, _, cx| e_google.update(cx, |d, cx| d.start_google(cx))),
                )
                .child(
                    div()
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.muted().solid())
                        .child(t(cx, soc::OR)),
                );
        }

        match self.mode {
            AuthMode::SignIn => {
                let e_otp = entity.clone();
                let e_forgot = entity.clone();
                let e_signup = entity.clone();
                body = body
                    .child(field_block(t(cx, f::EMAIL), self.email.clone()))
                    .child(field_block(t(cx, f::PASSWORD), self.password.clone()))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .justify_between()
                            .child(
                                Button::new("auth-use-otp", t(cx, auth::USE_OTP))
                                    .text()
                                    .small()
                                    .on_click(move |_, _, cx| {
                                        e_otp.update(cx, |d, cx| d.set_mode(AuthMode::EmailOtp, cx))
                                    }),
                            )
                            .child(
                                Button::new("auth-forgot", t(cx, auth::FORGOT_PASSWORD))
                                    .text()
                                    .small()
                                    .on_click(move |_, _, cx| {
                                        e_forgot.update(cx, |d, cx| {
                                            d.set_mode(AuthMode::ForgotPassword, cx)
                                        })
                                    }),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(space::S2))
                            .font_role(Role::Ui)
                            .type_px(s.secondary, s.line_body)
                            .text_color(p.muted().solid())
                            .child(t(cx, auth::NO_ACCOUNT))
                            .child(
                                Button::new("auth-to-signup", t(cx, auth::CREATE_ACCOUNT))
                                    .text()
                                    .small()
                                    .on_click(move |_, _, cx| {
                                        e_signup
                                            .update(cx, |d, cx| d.set_mode(AuthMode::SignUp, cx))
                                    }),
                            ),
                    );
            }
            AuthMode::SignUp => {
                let e_signin = entity.clone();
                body = body
                    .child(field_block(t(cx, f::PEN_NAME), self.pen_name.clone()))
                    .child(field_block(t(cx, f::EMAIL), self.email.clone()))
                    .child(field_block(t(cx, f::PASSWORD), self.password.clone()))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(space::S2))
                            .font_role(Role::Ui)
                            .type_px(s.secondary, s.line_body)
                            .text_color(p.muted().solid())
                            .child(t(cx, auth::HAS_ACCOUNT))
                            .child(
                                Button::new("auth-to-signin", t(cx, auth::SIGN_IN))
                                    .text()
                                    .small()
                                    .on_click(move |_, _, cx| {
                                        e_signin
                                            .update(cx, |d, cx| d.set_mode(AuthMode::SignIn, cx))
                                    }),
                            ),
                    );
            }
            AuthMode::VerifyEmail => {
                let e_resend = entity.clone();
                let e_back = entity.clone();
                body = body
                    .child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(s.secondary, s.line_body)
                            .text_color(p.ink(2).solid())
                            .child(tf(cx, vf::SENT, &[("email", &email_text)])),
                    )
                    .child(field_block(t(cx, f::CODE), self.otp.clone()))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .justify_between()
                            .child(
                                Button::new("auth-resend", t(cx, auth::RESEND))
                                    .text()
                                    .small()
                                    .on_click(move |_, _, cx| {
                                        e_resend.update(cx, |d, cx| d.send_code(cx))
                                    }),
                            )
                            .child(
                                Button::new("auth-back-signin", t(cx, auth::BACK_TO_SIGN_IN))
                                    .text()
                                    .small()
                                    .on_click(move |_, _, cx| {
                                        e_back.update(cx, |d, cx| d.set_mode(AuthMode::SignIn, cx))
                                    }),
                            ),
                    );
            }
            AuthMode::EmailOtp => {
                let sub = if self.otp_sent {
                    tf(cx, otp_k::CODE_SUB, &[("email", &email_text)])
                } else {
                    t(cx, otp_k::EMAIL_SUB)
                };
                let e_resend = entity.clone();
                let e_back = entity.clone();
                body = body
                    .child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(s.secondary, s.line_body)
                            .text_color(p.ink(2).solid())
                            .child(sub),
                    )
                    .child(field_block(t(cx, f::EMAIL), self.email.clone()))
                    .when(self.otp_sent, |el| {
                        el.child(field_block(t(cx, f::CODE), self.otp.clone()))
                            .child(
                                Button::new("auth-otp-resend", t(cx, auth::RESEND))
                                    .text()
                                    .small()
                                    .on_click(move |_, _, cx| {
                                        e_resend.update(cx, |d, cx| d.send_code(cx))
                                    }),
                            )
                    })
                    .child(
                        Button::new("auth-otp-back", t(cx, auth::BACK))
                            .text()
                            .small()
                            .on_click(move |_, _, cx| {
                                e_back.update(cx, |d, cx| d.set_mode(AuthMode::SignIn, cx))
                            }),
                    );
            }
            AuthMode::ForgotPassword => {
                let sub = if self.reset_done {
                    t(cx, fg::DONE)
                } else if self.otp_sent {
                    tf(cx, fg::CODE_SUB, &[("email", &email_text)])
                } else {
                    t(cx, fg::SUB)
                };
                let e_back = entity.clone();
                body = body
                    .child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(s.secondary, s.line_body)
                            .text_color(p.ink(2).solid())
                            .child(sub),
                    )
                    .child(field_block(t(cx, f::EMAIL), self.email.clone()))
                    .when(self.otp_sent && !self.reset_done, |el| {
                        el.child(field_block(t(cx, f::CODE), self.otp.clone()))
                            .child(field_block(t(cx, fg::NEW_PASSWORD), self.password.clone()))
                            .child(field_block(
                                t(cx, fg::CONFIRM_PASSWORD),
                                self.confirm_password.clone(),
                            ))
                    })
                    .child(
                        Button::new("auth-forgot-back", t(cx, auth::BACK_TO_SIGN_IN))
                            .text()
                            .small()
                            .on_click(move |_, _, cx| {
                                e_back.update(cx, |d, cx| d.set_mode(AuthMode::SignIn, cx))
                            }),
                    );
            }
        }

        let primary_label = match self.mode {
            AuthMode::SignIn => {
                if self.busy {
                    t(cx, auth::SIGNING_IN)
                } else {
                    t(cx, auth::SIGN_IN)
                }
            }
            AuthMode::SignUp => {
                if self.busy {
                    t(cx, auth::CREATING)
                } else {
                    t(cx, auth::SIGN_UP)
                }
            }
            AuthMode::VerifyEmail => {
                if self.busy {
                    t(cx, vf::VERIFYING)
                } else {
                    t(cx, vf::SUBMIT)
                }
            }
            AuthMode::EmailOtp => {
                if !self.otp_sent {
                    t(cx, auth::SEND_CODE)
                } else if self.busy {
                    t(cx, auth::SIGNING_IN)
                } else {
                    t(cx, auth::SIGN_IN)
                }
            }
            AuthMode::ForgotPassword => {
                if self.reset_done {
                    t(cx, auth::BACK_TO_SIGN_IN)
                } else if !self.otp_sent {
                    t(cx, auth::SEND_CODE)
                } else {
                    t(cx, fg::RESET_SUBMIT)
                }
            }
        };

        let mut dialog = Dialog::new("auth-dialog", title)
            .eyebrow(t(cx, auth::DIALOG_LABEL))
            .width(WIDTH)
            .on_close({
                let close = self.close.clone();
                move |window, cx| close(window, cx)
            })
            .body(body);

        if let Some(err) = &self.error {
            let color = p.danger.solid();
            dialog = dialog.status(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(space::S2))
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(color)
                    .child(sand::icon(Icon::StatusWarning, 14.0, color))
                    .child(err.clone()),
            );
        }

        let e_submit = entity.clone();
        let reset_done = self.reset_done;
        let submit_btn = Button::new("auth-submit", primary_label)
            .primary()
            .disabled(self.busy)
            .busy(self.busy)
            .on_click(move |_, window, cx| {
                e_submit.update(cx, |d, cx| {
                    if reset_done {
                        d.set_mode(AuthMode::SignIn, cx);
                    } else {
                        d.submit(window, cx);
                    }
                })
            });

        div().child(dialog.action(submit_btn))
    }
}
