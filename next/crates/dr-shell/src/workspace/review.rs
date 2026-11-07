//! M18 in the workspace: opening the tab a Review card points at, and the
//! comment composer beside the selected text (dr-view-review).

use dr_view_review::{CommentComposer, ComposerEvent, NewComment};
use gpui::{
    AnyElement, Context, Entity, Focusable, IntoElement, ParentElement, Subscription, Window,
    anchored, deferred, px,
};

use super::Workspace;
use super::editors::PageView;
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

    /// ⌘⌥M: the composer comes up beside the selection of the editor that
    /// has focus (one chapter's or the whole book's).
    pub(super) fn on_new_comment(
        &mut self,
        _: &NewComment,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let focused = self
            .editors
            .values()
            .filter_map(|p| p.view.clone())
            .find(|v| {
                v.prose(cx)
                    .read(cx)
                    .focus_handle(cx)
                    .contains_focused(window, cx)
            });
        if let Some(view) = focused {
            self.open_composer(&view, window, cx);
        }
    }

    /// The selection bar's 添加批注 (F4's `CommentRequested`), on `view`.
    pub(super) fn on_comment_requested(
        &mut self,
        view: &PageView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_composer(view, window, cx);
    }

    fn open_composer(&mut self, view: &PageView, window: &mut Window, cx: &mut Context<Self>) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        let prose = view.prose(cx);
        // The document the selection is in.
        let doc = match view {
            PageView::Doc(e) => Some(e.read(cx).doc_id().to_owned()),
            PageView::Book(b) => b.read(cx).current_doc(cx).map(str::to_owned),
        };
        let Some(doc) = doc else {
            return;
        };
        let locale = crate::Strings::get(cx).locale();
        let book = self.book_id.clone();
        let Some(composer) =
            CommentComposer::for_prose(&prose, lib, &book, &doc, locale, window, cx)
        else {
            return;
        };
        let done = cx.subscribe_in(
            &composer,
            window,
            move |ws, _, e: &ComposerEvent, window, cx| {
                if *e == ComposerEvent::Done {
                    ws.composer = None;
                    // Back to writing.
                    let focus = prose.read(cx).focus_handle(cx);
                    window.focus(&focus, cx);
                    cx.notify();
                }
            },
        );
        let at = composer.read(cx).position();
        self.composer = Some(Composer {
            view: composer,
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
