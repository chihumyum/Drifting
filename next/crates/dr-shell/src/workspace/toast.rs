//! A short notice floating at the bottom of the window (dr-ui's
//! `NotificationPill`): 「已复制位置链接」 after the slash menu's 位置链接.
//! It floats in, stays [`SHOWN`], fades and goes; a new one replaces it.

use std::time::Duration;

use dr_ui::{components::NotificationPill, sand::Icon};
use gpui::{
    AnyElement, Context, IntoElement, ParentElement, SharedString, Styled, deferred, div, px,
};

use super::Workspace;

/// How long a notice stays before it fades.
pub const SHOWN: Duration = Duration::from_millis(1600);
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
    serial: u64,
}

impl Workspace {
    /// Shows `text` at the bottom of the window for a moment.
    pub fn toast(&mut self, text: impl Into<SharedString>, cx: &mut Context<Self>) {
        let serial = self.toast.as_ref().map_or(0, |t| t.serial) + 1;
        self.toast = Some(Toast {
            text: text.into(),
            shown: true,
            serial,
        });
        self.toast_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SHOWN).await;
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

    /// The notice over everything, centred at the bottom.
    pub(super) fn toast_overlay(&self) -> Option<AnyElement> {
        let toast = self.toast.as_ref()?;
        let pill = NotificationPill::new(
            gpui::ElementId::Name(format!("workspace-toast-{}", toast.serial).into()),
            toast.text.clone(),
        )
        .icon(Icon::Check)
        .shown(toast.shown);
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
