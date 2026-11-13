//! A short notice floating at the bottom of the window (dr-ui's
//! `NotificationPill`): 「已复制位置链接」 after the slash menu's 位置链接.
//! It floats in, stays [`SHOWN`], fades and goes; a new one replaces it.
//!
//! A notice can offer to undo one step of the author's (author 2026-11-13):
//! after turning a 层级 off, moving an entry or changing its template, it
//! says what was done and carries 「撤销」; once undone, it says what was
//! undone and carries 「重做」 ([`super::undo`]). Such a notice stays
//! [`OFFERED`], goes when a newer step of the author's in that book makes
//! the offer stale, and offers nothing once another book is open.

use std::time::Duration;

use dr_i18n::keys;
use dr_ui::{
    components::{Button, NotificationPill},
    sand::Icon,
};
use gpui::{
    AnyElement, App, Context, IntoElement, ParentElement, SharedString, Styled, deferred, div, px,
};
use serde_json::Value;

use super::Workspace;
use crate::pages::PageViewHost;

/// How long a notice stays before it fades.
pub const SHOWN: Duration = Duration::from_millis(1600);
/// How long a notice offering 「撤销」 or 「重做」 stays before it fades.
pub const OFFERED: Duration = Duration::from_secs(6);
/// How long its fade takes before it is gone.
const FADE: Duration = Duration::from_millis(400);
/// Above the bottom of the window.
const BOTTOM: f32 = 28.0;

/// The notice on screen.
#[derive(Clone, Debug, PartialEq)]
pub struct Toast {
    pub text: SharedString,
    /// False while it fades.
    pub shown: bool,
    /// The step its button undoes or redoes, if it has one.
    pub offer: Option<Offer>,
    serial: u64,
}

/// What a notice's 「撤销」 / 「重做」 acts on: one journal row of the author's
/// in one book ([`dr_workspace::Workspace::undo_in`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub book: String,
    pub seq: i64,
    /// 「重做」: the step was undone.
    pub redo: bool,
}

impl Workspace {
    /// Shows `text` at the bottom of the window for a moment.
    pub fn toast(&mut self, text: impl Into<SharedString>, cx: &mut Context<Self>) {
        self.notice(text.into(), None, cx);
    }

    /// Shows `text` with 「撤销」 for the author's step that journal row
    /// `seq` of `book` recorded (what the command returned as `journal`).
    pub fn offer_undo(
        &mut self,
        text: impl Into<SharedString>,
        book: &str,
        seq: i64,
        cx: &mut Context<Self>,
    ) {
        let offer = Offer {
            book: book.to_owned(),
            seq,
            redo: false,
        };
        self.notice(text.into(), Some(offer), cx);
    }

    pub(super) fn notice(
        &mut self,
        text: SharedString,
        offer: Option<Offer>,
        cx: &mut Context<Self>,
    ) {
        let serial = self.toast.as_ref().map_or(0, |t| t.serial) + 1;
        let stays = if offer.is_some() { OFFERED } else { SHOWN };
        self.toast = Some(Toast {
            text,
            shown: true,
            offer,
            serial,
        });
        self.toast_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(stays).await;
            let fading = this.update(cx, |ws, cx| match ws.toast.as_mut() {
                Some(t) if t.serial == serial => {
                    t.shown = false;
                    cx.notify();
                    true
                }
                _ => false,
            });
            if !matches!(fading, Ok(true)) {
                return;
            }
            cx.background_executor().timer(FADE).await;
            this.update(cx, |ws, cx| {
                if ws.toast.as_ref().is_some_and(|t| t.serial == serial) {
                    ws.toast = None;
                    cx.notify();
                }
            })
            .ok();
        }));
        cx.notify();
    }

    /// Takes the notice away now when it offers a step the author can no
    /// longer take that way: journal row `newer` of the author's came after
    /// it, in `book` (`None`: in no book or another one).
    pub(super) fn drop_stale_offer(
        &mut self,
        newer: i64,
        book: Option<&str>,
        cx: &mut Context<Self>,
    ) {
        let stale = self
            .toast
            .as_ref()
            .and_then(|t| t.offer.as_ref())
            .is_some_and(|o| {
                // A new step anywhere ends every redo; an undo, only a new
                // step in its own book.
                o.seq < newer && (o.redo || book == Some(o.book.as_str()))
            });
        if stale {
            self.toast = None;
            self.toast_timer = None;
            cx.notify();
        }
    }

    /// The offer of the notice on screen, while its book is the open one.
    fn live_offer(&self) -> Option<&Offer> {
        let offer = self.toast.as_ref()?.offer.as_ref()?;
        (!self.shelf_open && offer.book == self.book_id).then_some(offer)
    }

    /// The notice's 「撤销」 / 「重做」, as pressing it does: nothing when the
    /// notice offers nothing for the open book.
    pub fn press_toast_offer(&mut self, cx: &mut Context<Self>) {
        let Some(offer) = self.live_offer().cloned() else {
            return;
        };
        let text = self.toast.as_ref().map(|t| t.text.clone());
        self.toast = None;
        self.toast_timer = None;
        cx.notify();
        self.undo_in_book(offer.redo, Some(offer.seq), text, cx);
    }

    /// The notice over everything, centred at the bottom.
    pub(super) fn toast_overlay(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let toast = self.toast.as_ref()?;
        let mut pill = NotificationPill::new(
            gpui::ElementId::Name(format!("workspace-toast-{}", toast.serial).into()),
            toast.text.clone(),
        )
        .icon(Icon::Check)
        .shown(toast.shown);
        if let Some(offer) = self.live_offer() {
            let label = if offer.redo {
                keys::mobile_workspace::editor_accessory::REDO
            } else {
                keys::mobile_workspace::editor_accessory::UNDO
            };
            pill = pill.action(
                Button::new(
                    gpui::ElementId::Name(format!("workspace-toast-offer-{}", toast.serial).into()),
                    crate::t(cx, label),
                )
                .on_click(cx.listener(|ws, _, _, cx| ws.press_toast_offer(cx))),
            );
        }
        Some(
            deferred(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom(px(BOTTOM))
                    .flex()
                    .justify_center()
                    .child(pill),
            )
            .with_priority(300)
            .into_any_element(),
        )
    }
}

/// `label · name` for a notice, or the label alone without a name.
pub fn offer_text(label: SharedString, name: &str) -> SharedString {
    let name = name.trim();
    if name.is_empty() {
        label
    } else {
        format!("{label} · {name}").into()
    }
}

/// After a write of the author's from a page of `host`'s book: offers to
/// undo it ([`Workspace::offer_undo`]), saying `label` and the entry's
/// title. `answer` is what the command returned (its `journal` row);
/// nothing shows without one, or once the window shows another book.
pub fn offer_undo_after(
    host: &PageViewHost,
    label: SharedString,
    entry: &str,
    answer: &Value,
    cx: &mut App,
) {
    let Some(seq) = answer["journal"].as_i64() else {
        return;
    };
    let Some(ws) = host.workspace.upgrade() else {
        return;
    };
    let name = host
        .book
        .v3()
        .and_then(|v| v.entry(entry))
        .map(|e| e.title.clone())
        .unwrap_or_default();
    let text = offer_text(label, &name);
    let book = host.book_id.clone();
    let library = host.library.clone();
    ws.update(cx, |ws, cx| {
        let same = ws.book_id == book
            && ws
                .library
                .as_ref()
                .is_some_and(|lib| std::ptr::eq(lib.library(), library.library()));
        if same {
            ws.offer_undo(text, &book, seq, cx);
        }
    });
}
