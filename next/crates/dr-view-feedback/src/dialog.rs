//! The feedback dialog (components.md, 「提交反馈」).
//!
//! The dialog shell (dr-ui's `Dialog`): the message field, a small index-type
//! label over the reply-to field, a row with the switch 「附上脱敏诊断摘要」
//! and the text button 「预览」 that opens a read-only hairline card with the
//! summary in the index face. Actions: cancel (「忽略」 for a crash
//! follow-up) and send. Once sent: the done mark and 「已发送」, only
//! 「关闭」 left. When sending fails: 「没能发出」 in the danger colour, and
//! the primary button becomes 「用邮件发送」 with the outward arrow, which it
//! is from the start without the Hosted service.
//!
//! Closing, as in 0.1: the ✕ always closes (a message already on its way
//! still goes, and still retires its notice); a click on the mist closes
//! only while nothing is written and nothing is being sent; Esc and Cancel
//! close unless it is sending. The message is a multi-line field, at least
//! five lines high: Enter starts a new line, ⌘↩ (Ctrl+Enter elsewhere)
//! sends.

use std::time::SystemTime;

use dr_i18n::keys::feedback as fb;
use dr_platform::diagnostics::{self, SummaryInput};
use dr_platform::feedback::{self, Delivery, Draft, FollowUp, Problem, SendError};
use dr_shell::dialogs::{Close, FollowUpNotice};
use dr_shell::notifications::Notifications;
use dr_shell::{ShellInfo, Strings, t};
use dr_ui::{
    Theme,
    components::{Button, Dialog, Switch},
    fonts::Role,
    input::{
        area::TextArea,
        field::{FieldEvent, TextField},
    },
    sand::{self, Icon},
    style::DrStyled,
    tokens::space,
};
use gpui::{
    AppContext as _, Context, Entity, Focusable as _, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement as _, Styled, Subscription,
    Task, Window, div, prelude::FluentBuilder as _, px,
};

use crate::Service;

/// The key context around the dialog.
pub const KEY_CONTEXT: &str = "FeedbackDialog";
/// 0.1's card width.
pub const WIDTH: f32 = 520.0;
/// The message field is at least this many lines high (0.1).
pub const MESSAGE_ROWS: f32 = 5.0;

/// Where the dialog is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Editing,
    Sending,
    Sent,
    /// The send failed; the author can send by mail.
    Failed,
}

pub struct FeedbackDialog {
    message: Entity<TextArea>,
    contact: Entity<TextField>,
    follow_up: Option<FollowUpNotice>,
    /// Taken once as the dialog opens, so the preview is exactly what is sent.
    summary: String,
    attach: bool,
    preview: bool,
    phase: Phase,
    close: Close,
    sending: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl FeedbackDialog {
    pub fn new(
        follow_up: Option<FollowUpNotice>,
        close: Close,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> FeedbackDialog {
        let version = cx
            .try_global::<ShellInfo>()
            .map_or(env!("CARGO_PKG_VERSION"), |info| info.version);
        let mut input = SummaryInput::current(version);
        // M42's state, as 0.1 reported its updater's.
        input.update = dr_view_update::snapshot(cx);
        let summary = diagnostics::summary(&input);
        let placeholder = t(
            cx,
            if follow_up.is_some() {
                fb::crash::PLACEHOLDER
            } else {
                fb::PLACEHOLDER
            },
        );
        let optional = t(cx, fb::CONTACT_PLACEHOLDER);
        let message = cx.new(|cx| {
            TextArea::new("feedback-message", window, cx)
                .framed(MESSAGE_ROWS)
                .placeholder(placeholder)
        });
        let contact = cx.new(|cx| {
            TextField::new("feedback-contact", window, cx)
                .small()
                .placeholder(optional)
        });
        let subscriptions = vec![
            cx.subscribe_in(&message, window, Self::on_message),
            cx.subscribe_in(&contact, window, Self::on_contact),
        ];
        let focus = message.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
        FeedbackDialog {
            message,
            contact,
            follow_up,
            summary,
            attach: true,
            preview: false,
            phase: Phase::Editing,
            close,
            sending: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn message_field(&self) -> &Entity<TextArea> {
        &self.message
    }

    pub fn contact_field(&self) -> &Entity<TextField> {
        &self.contact
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn follow_up(&self) -> Option<&FollowUpNotice> {
        self.follow_up.as_ref()
    }

    /// The summary the dialog would attach (the preview's text).
    pub fn summary(&self) -> &str {
        &self.summary
    }

    pub fn attaches_summary(&self) -> bool {
        self.attach
    }

    pub fn set_attach(&mut self, attach: bool, cx: &mut Context<Self>) {
        if !self.locked() {
            self.attach = attach;
            cx.notify();
        }
    }

    pub fn toggle_preview(&mut self, cx: &mut Context<Self>) {
        self.preview = self.attach && !self.preview;
        cx.notify();
    }

    /// The message: ⌘↩ sends (Enter is a new line), Esc closes.
    fn on_message(
        &mut self,
        _: &Entity<TextArea>,
        event: &FieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            FieldEvent::Changed(_) => cx.notify(),
            FieldEvent::Cancelled => self.dismiss(window, cx),
            FieldEvent::Submitted(_) => self.submit(window, cx),
            FieldEvent::Blurred => {}
        }
    }

    /// The reply-to address: Esc closes; Enter does nothing (0.1).
    fn on_contact(
        &mut self,
        _: &Entity<TextField>,
        event: &FieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            FieldEvent::Changed(_) => cx.notify(),
            FieldEvent::Cancelled => self.dismiss(window, cx),
            FieldEvent::Submitted(_) | FieldEvent::Blurred => {}
        }
    }

    fn locked(&self) -> bool {
        matches!(self.phase, Phase::Sending | Phase::Sent)
    }

    fn problems(&self, cx: &gpui::App) -> Vec<Problem> {
        feedback::problems(&self.message.read(cx).text(), &self.contact.read(cx).text())
    }

    /// Whether the primary button hands the message to the mail client.
    pub fn by_email(&self, cx: &gpui::App) -> bool {
        self.phase == Phase::Failed
            || cx
                .try_global::<Service>()
                .is_none_or(|s| s.delivery == Delivery::Email)
    }

    fn draft(&self, cx: &gpui::App) -> Draft {
        Draft {
            message: self.message.read(cx).text(),
            contact_email: self.contact.read(cx).text(),
            diagnostics: self.attach.then(|| self.summary.clone()),
            follow_up: self.follow_up.as_ref().map(|f| FollowUp {
                crash_id: f.crash_id.clone(),
                occurred_at: f.at,
            }),
            locale: Strings::get(cx).locale().code().to_owned(),
        }
    }

    /// Sends (or, by mail, hands over) the message. Nothing happens while
    /// the message is empty or too long, the address is not one, or it is
    /// already on its way.
    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.locked() || !self.problems(cx).is_empty() {
            return;
        }
        let Some(service) = cx.try_global::<Service>().cloned() else {
            return;
        };
        let draft = self.draft(cx);
        let endpoint = match (&service.delivery, self.by_email(cx)) {
            (Delivery::Hosted(endpoint), false) => endpoint.clone(),
            _ => {
                let subject = t(
                    cx,
                    if self.follow_up.is_some() {
                        fb::crash::EMAIL_SUBJECT
                    } else {
                        fb::EMAIL_SUBJECT
                    },
                );
                cx.open_url(&feedback::email_url(&draft, &service.sender(), &subject));
                self.retire(cx);
                (self.close.clone())(window, cx);
                return;
            }
        };
        let payload = feedback::payload(&draft, &service.sender(), SystemTime::now());
        let session = service.session.clone();
        let notice = self.follow_up.as_ref().map(|f| f.notice);
        self.set_phase(Phase::Sending, cx);
        self.sending = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { feedback::send(&endpoint, session.as_deref(), &payload) })
                .await;
            // Retired here, not by the dialog: the ✕ may have closed it
            // while the message was on its way (0.1 did the same).
            if result.is_ok()
                && let Some(notice) = notice
            {
                cx.update(|cx| Notifications::remove(notice, cx));
            }
            this.update(cx, |dialog, cx| dialog.finish(result, cx)).ok();
        }));
    }

    fn finish(&mut self, result: Result<(), SendError>, cx: &mut Context<Self>) {
        self.sending = None;
        match result {
            Ok(()) => self.set_phase(Phase::Sent, cx),
            Err(error) => {
                log::warn!("feedback was not sent: {error}");
                self.set_phase(Phase::Failed, cx);
            }
        }
    }

    fn set_phase(&mut self, phase: Phase, cx: &mut Context<Self>) {
        self.phase = phase;
        let locked = self.locked();
        self.message.update(cx, |f, cx| f.set_disabled(locked, cx));
        self.contact.update(cx, |f, cx| f.set_disabled(locked, cx));
        cx.notify();
    }

    /// A follow-up's notice goes once a note was sent or the author ignored
    /// it.
    fn retire(&self, cx: &mut gpui::App) {
        if let Some(follow_up) = &self.follow_up {
            Notifications::remove(follow_up.notice, cx);
        }
    }

    /// Cancel, Esc, Close: the notice stays. Not while sending.
    pub fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.phase != Phase::Sending {
            (self.close.clone())(window, cx);
        }
    }

    /// The ✕: always closes, the notice stays. A message already on its way
    /// still goes, and still retires its notice once it arrives.
    pub fn close_button(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(sending) = self.sending.take() {
            sending.detach();
        }
        (self.close.clone())(window, cx);
    }

    /// A click on the mist: closes only while nothing is written (spaces
    /// are nothing) and nothing is being sent, so no words are lost (0.1's
    /// `closeOnBackdrop`).
    pub fn mist(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.phase != Phase::Sending && self.message.read(cx).text().trim().is_empty() {
            (self.close.clone())(window, cx);
        }
    }

    /// 「忽略」 on a crash follow-up: retire the notice and close.
    pub fn ignore(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.phase != Phase::Sending {
            self.retire(cx);
            (self.close.clone())(window, cx);
        }
    }
}

impl Render for FeedbackDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let entity = cx.entity();
        let follow_up = self.follow_up.is_some();
        let title = t(
            cx,
            if follow_up {
                fb::crash::TITLE
            } else {
                fb::TITLE
            },
        );
        let problems = self.problems(cx);
        let invalid_email = problems.contains(&Problem::InvalidEmail);
        let locked = self.locked();
        let can_send = problems.is_empty() && !locked;
        let by_email = self.by_email(cx);

        let label = |text: SharedString, danger: bool| {
            div()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(if danger {
                    p.danger.solid()
                } else {
                    p.muted().solid()
                })
                .child(text)
        };
        let contact = div()
            .flex()
            .flex_col()
            .gap(px(space::S2))
            .child(label(t(cx, fb::CONTACT), invalid_email))
            .child(self.contact.clone());
        let attach = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(space::S3))
            .child(
                Switch::new("feedback-attach", self.attach)
                    .disabled(locked)
                    .on_change({
                        let entity = entity.clone();
                        move |on, _, cx| entity.update(cx, |d, cx| d.set_attach(on, cx))
                    }),
            )
            .child(
                div()
                    .flex_1()
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(2).solid())
                    .child(t(cx, fb::ATTACH_DIAGNOSTICS)),
            )
            .child(
                Button::new(
                    "feedback-preview",
                    t(
                        cx,
                        if self.attach && self.preview {
                            fb::HIDE_PREVIEW
                        } else {
                            fb::PREVIEW
                        },
                    ),
                )
                .text()
                .small()
                .disabled(!self.attach || locked)
                .on_click({
                    let entity = entity.clone();
                    move |_, _, cx| entity.update(cx, |d, cx| d.toggle_preview(cx))
                }),
            );
        let preview = (self.attach && self.preview).then(|| {
            div()
                .id("feedback-preview-card")
                .max_h(px(200.0))
                .overflow_y_scroll()
                .p(px(space::S4))
                .border(px(0.5))
                .border_color(p.hairline())
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.ink(2).solid())
                .child(self.summary.clone())
        });

        let status = match self.phase {
            Phase::Sent => Some((Icon::StatusDone, fb::SENT, p.ink(2).solid())),
            Phase::Failed => Some((Icon::StatusWarning, fb::FAILED, p.danger.solid())),
            _ => None,
        }
        .map(|(icon, key, color)| {
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(space::S2))
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(color)
                .child(sand::icon(icon, 14.0, color))
                .child(t(cx, key))
        });

        let message = self.message.clone();
        let mut dialog = Dialog::new("feedback-dialog", title)
            .width(WIDTH)
            .on_close({
                let entity = entity.clone();
                move |window, cx| entity.update(cx, |d, cx| d.close_button(window, cx))
            })
            .on_mist({
                let entity = entity.clone();
                move |window, cx| entity.update(cx, |d, cx| d.mist(window, cx))
            })
            .body(message)
            .body(contact)
            .body(attach)
            .when_some(preview, |d, preview| d.body(preview));
        if let Some(follow_up) = &self.follow_up {
            let at = chrono::DateTime::<chrono::Local>::from(follow_up.at);
            dialog = dialog.eyebrow(at.format("%m/%d %H:%M").to_string());
        }
        if let Some(status) = status {
            dialog = dialog.status(status);
        }
        dialog = if self.phase == Phase::Sent {
            dialog.action(Button::new("feedback-close", t(cx, fb::CLOSE)).on_click({
                let entity = entity.clone();
                move |_, window, cx| entity.update(cx, |d, cx| d.dismiss(window, cx))
            }))
        } else {
            let cancel = Button::new(
                "feedback-cancel",
                t(
                    cx,
                    if follow_up {
                        fb::crash::IGNORE
                    } else {
                        fb::CANCEL
                    },
                ),
            )
            .disabled(self.phase == Phase::Sending)
            .on_click({
                let entity = entity.clone();
                move |_, window, cx| {
                    entity.update(cx, |d, cx| {
                        if d.follow_up.is_some() {
                            d.ignore(window, cx)
                        } else {
                            d.dismiss(window, cx)
                        }
                    })
                }
            });
            let send_label = if by_email {
                fb::SEND_BY_EMAIL
            } else if self.phase == Phase::Sending {
                fb::SENDING
            } else {
                fb::SEND
            };
            let send = Button::new("feedback-send", t(cx, send_label))
                .primary()
                .disabled(!can_send)
                .busy(self.phase == Phase::Sending)
                .when(by_email, |b| b.icon(Icon::ArrowOut))
                .on_click({
                    let entity = entity.clone();
                    move |_, window, cx| entity.update(cx, |d, cx| d.submit(window, cx))
                });
            dialog.action(cancel).action(send)
        };

        div().key_context(KEY_CONTEXT).child(dialog)
    }
}
