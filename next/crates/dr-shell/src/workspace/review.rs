//! M18 in the workspace: opening the tab a Review card points at, and the
//! comment composer beside the selected text (dr-view-review).

use dr_editor::CommentRequested;
use dr_view_review::{CommentComposer, ComposerEvent, NewComment};
use dr_workspace::dto::Target as CommentTarget;
use gpui::{
    AnyElement, AppContext as _, Bounds, Context, Entity, EntityInputHandler as _, Focusable,
    IntoElement, ParentElement, Subscription, Window, anchored, deferred, point, px,
};
use gpui_prose::ProseEditor;

use super::Workspace;
use super::editors::PageView;
use crate::nav::{Open, Target};

/// The composer shown, and its subscription.
pub struct Composer {
    view: Entity<CommentComposer>,
    at: gpui::Point<gpui::Pixels>,
    _done: Subscription,
}

impl Composer {
    /// M18's composer card.
    pub fn view(&self) -> &Entity<CommentComposer> {
        &self.view
    }
}

impl Workspace {
    /// The same navigation as ShowProjectHome, for an accepted book change.
    pub fn open_home(&mut self, cx: &mut Context<Self>) {
        self.super_view = None;
        self.nav.go_home();
        self.changed(cx);
    }

    /// Reveal a comment which the caller has resolved in the current book.
    /// Floating/unlocated comments belong in Review; located comments also
    /// open their actual page and use M18's existing focus signal.
    pub fn reveal_comment(
        &mut self,
        id: &str,
        target: Option<Target>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<futures::channel::oneshot::Receiver<bool>> {
        if dr_model::id::CommentId::parse(id).is_err()
            || target
                .as_ref()
                .is_some_and(|target| self.book.entry(target).is_none())
        {
            return None;
        }
        self.super_view = None;
        if let Some(target) = target {
            self.open(target, Open::KEEP, cx);
        }
        let reduce = self.reduce_motion(window, cx);
        self.right.set_open(true, reduce);
        self.right.panes.reveal(super::RightTab::Review);
        let pane = match self.right.panes.focused {
            crate::panes::PaneId::Primary => "review-primary",
            crate::panes::PaneId::Secondary => "review-secondary",
        };
        let revealed = dr_view_review::reveal_comment(pane, &self.book_id, id, cx)?;
        dr_editor::decor::ReviewFocus::jump(id, cx);
        self.changed(cx);
        Some(revealed)
    }

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
        self.show_composer(composer, prose, window, cx);
    }

    /// The selection bar's 添加批注 (F4's `CommentRequested`): the composer on
    /// that range of `req.doc`, under its last row. `chapter` is the
    /// document's chapter in `prose` (0 on one document's page).
    pub(super) fn on_comment_requested(
        &mut self,
        req: &CommentRequested,
        prose: Entity<ProseEditor>,
        chapter: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        let Some((kind, id)) = req.doc.split_once(':') else {
            return;
        };
        let target = CommentTarget {
            kind: kind.to_owned(),
            id: id.to_owned(),
        };
        let (start16, end16) = {
            let p = prose.read(cx);
            let Some(c) = p.book().chapters.get(chapter) else {
                return;
            };
            (
                c.doc.offset_to_utf16(req.range.start),
                c.doc.offset_to_utf16(req.range.end),
            )
        };
        // Under the range's last row, lined up with where it starts (as the
        // ⌘⌥M composer).
        let (first, last) = prose.update(cx, |e, cx| {
            (
                e.bounds_for_range(start16..start16 + 1, Bounds::default(), window, cx),
                e.bounds_for_range(
                    end16.saturating_sub(1)..end16,
                    Bounds::default(),
                    window,
                    cx,
                ),
            )
        });
        let at = match (first, last) {
            (Some(f), Some(l)) => point(f.left().min(l.left()), l.bottom() + px(8.0)),
            (_, Some(l)) => point(l.left(), l.bottom() + px(8.0)),
            _ => window.mouse_position(),
        };
        let locale = crate::Strings::get(cx).locale();
        let book = self.book_id.clone();
        let range = (req.range.start, req.range.end);
        let view =
            cx.new(|cx| CommentComposer::new(lib, book, target, range, at, locale, window, cx));
        self.show_composer(view, prose, window, cx);
    }

    /// Shows `view` beside the selection; done, the page gets the keyboard.
    fn show_composer(
        &mut self,
        view: Entity<CommentComposer>,
        prose: Entity<ProseEditor>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let done = cx.subscribe_in(
            &view,
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
