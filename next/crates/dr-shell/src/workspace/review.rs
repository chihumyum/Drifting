//! M18 in the workspace: opening the tab a Review card points at, and the
//! comment composer beside the selected text (dr-view-review).

use dr_view_review::{CommentComposer, ComposerEvent, NewComment};
use gpui::{
    AnyElement, Context, Entity, Focusable, IntoElement, ParentElement, Subscription, Window,
    anchored, deferred, px,
};

use super::Workspace;
use crate::nav::{Open, Target};

/// The composer shown, and its subscription.
pub struct Composer {
    view: Entity<CommentComposer>,
    at: gpui::Point<gpui::Pixels>,
    _done: Subscription,
}

impl Workspace {
    /// A Review card's arrow: its entity's tab (the editor then shows the
    /// comment).
    pub(super) fn open_review_target(
        &mut self,
        key: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(target) = Target::from_key(key) {
            self.super_view = None;
            self.open(target, Open::KEEP, cx);
        }
    }

    /// ⌘⌥M (or the selection toolbar's 批注): the composer comes up beside
    /// the selection of the editor that has focus.
    pub(super) fn on_new_comment(
        &mut self,
        _: &NewComment,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        let editor = self
            .editors
            .values()
            .filter_map(|p| p.editor.clone())
            .find(|e| {
                let prose = e.read(cx).editor().clone();
                prose.read(cx).focus_handle(cx).contains_focused(window, cx)
            });
        let Some(editor) = editor else {
            return;
        };
        let locale = crate::Strings::get(cx).locale();
        let Some(view) = CommentComposer::for_selection(&editor, lib, locale, window, cx) else {
            return;
        };
        let done = cx.subscribe_in(
            &view,
            window,
            move |ws, _, e: &ComposerEvent, window, cx| {
                if *e == ComposerEvent::Done {
                    ws.composer = None;
                    // Back to writing.
                    let prose = editor.read(cx).editor().clone();
                    let focus = prose.read(cx).focus_handle(cx);
                    window.focus(&focus, cx);
                    cx.notify();
                }
            },
        );
        let at = view.read(cx).position();
        self.composer = Some(Composer {
            view,
            at,
            _done: done,
        });
        cx.notify();
    }

    /// The composer over everything, where the selection ends.
    pub(super) fn composer_overlay(&self) -> Option<AnyElement> {
        let c = self.composer.as_ref()?;
        Some(
            deferred(
                anchored()
                    .position(c.at)
                    .snap_to_window_with_margin(px(12.0))
                    .child(c.view.clone()),
            )
            .into_any_element(),
        )
    }
}
