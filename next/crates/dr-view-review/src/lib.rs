//! dr-view-review: Review (M18).
//!
//! - The right sidebar's Review tab ([`panel`]): the book's comments and
//!   TODOs, filtered (全部 / 批注 / TODO), scoped (当前 or the whole
//!   project), grouped by where they are; edited in place; a TODO completed
//!   with a check stroke drawn in its round button; jumping to the text.
//! - The comment composer ([`CommentComposer`]) that comes up beside the
//!   selected text ([`NewComment`], ⌘⌥M in the prose).
//! - The prose side (sand under the anchored words, multi-paragraph anchors
//!   drawn as dry sand along every row, the ticks, `TODO:` / `待办:`
//!   markers projected into TODOs) is dr-editor's (`decor`); the two meet in
//!   [`dr_editor::decor::ReviewFocus`].
//!
//! The shell wires it in (see docs/rust-rewrite/modules/m18-review.md):
//! [`init`] at start-up, [`panel`] in the Review tab (with an [`Opener`]
//! for the arrows), [`NewComment`] handled by the workspace, the composer
//! drawn over the stage.

pub mod composer;
pub mod model;
pub mod panel;

use std::collections::HashMap;

use dr_doc::book::Collection;
use dr_i18n::{Locale, Platform};
use dr_workspace::{NavTarget, Workspace, WsEvent, events::Subscription};
use gpui::{
    AnyElement, App, AppContext, Entity, Global, IntoElement, KeyBinding, SharedString, actions,
};

pub use composer::{Anchor, CommentComposer, ComposerEvent};
pub use model::{Filter, Group, Listing, Place};
pub use panel::{ReviewView, target_of};

/// Opens a target's tab (its [`NavTarget::key`]): the arrow on a Review
/// card. The shell gives it with [`panel`].
pub type Opener = std::rc::Rc<dyn Fn(&str, &mut gpui::Window, &mut App)>;

actions!(
    review,
    [
        /// Comment on the selected text: the composer comes up beside it.
        NewComment
    ]
);

/// The key context the composer's shortcut lives in (gpui-prose's editor).
pub const EDITOR_CONTEXT: &str = gpui_prose::input::KEY_CONTEXT;

/// The composer's shortcut: ⌘⌥M (Ctrl+Alt+M off macOS).
pub const NEW_COMMENT_KEYS: &str = if cfg!(target_os = "macos") {
    "cmd-alt-m"
} else {
    "ctrl-alt-m"
};

/// The shortcuts of this module.
pub fn bindings() -> Vec<KeyBinding> {
    vec![KeyBinding::new(
        NEW_COMMENT_KEYS,
        NewComment,
        Some(EDITOR_CONTEXT),
    )]
}

struct Hub {
    lib: Option<Workspace>,
    subscription: Option<Subscription>,
    views: HashMap<SharedString, Entity<ReviewView>>,
}

impl Global for Hub {}

/// Routes the library's comment changes to the Review tabs. Call once, at
/// start-up.
pub fn init(lib: Option<Workspace>, cx: &mut App) {
    let (tx, mut rx) = futures::channel::mpsc::unbounded::<String>();
    let subscription = lib.as_ref().map(|lib| {
        lib.subscribe(move |e| {
            if let WsEvent::Book(b) = e
                && b.changes.iter().any(|c| {
                    matches!(
                        c.collection,
                        Collection::Comments
                            | Collection::Relations
                            | Collection::RelationTypes
                            | Collection::Nodes
                            | Collection::Elements
                            | Collection::Categories
                            | Collection::Storylines
                            | Collection::Materials
                    )
                })
            {
                let _ = tx.unbounded_send(b.book.to_string());
            }
        })
    });
    cx.set_global(Hub {
        lib,
        subscription,
        views: HashMap::new(),
    });
    cx.spawn(async move |cx| {
        use futures::StreamExt as _;
        while let Some(first) = rx.next().await {
            let mut books = vec![first];
            while let Ok(more) = rx.try_recv() {
                books.push(more);
            }
            cx.update(|cx| {
                let views: Vec<Entity<ReviewView>> = cx
                    .try_global::<Hub>()
                    .map(|h| h.views.values().cloned().collect())
                    .unwrap_or_default();
                for view in views {
                    view.update(cx, |v, cx| {
                        if books.contains(&v.book) {
                            v.schedule(cx);
                        }
                    });
                }
            });
        }
    })
    .detach();
}

/// Lets go of the library before quitting.
pub fn release(cx: &mut App) {
    if cx.has_global::<Hub>() {
        let hub = cx.global_mut::<Hub>();
        hub.subscription = None;
        hub.views.clear();
        hub.lib = None;
    }
}

/// The Review tab for `book`, following the page `target`. `id` tells two
/// panes apart; `open` opens a card's entity.
pub fn panel(
    id: &str,
    book: &str,
    target: Option<NavTarget>,
    locale: Locale,
    platform: Platform,
    open: Opener,
    cx: &mut App,
) -> AnyElement {
    let Some(view) = ensure_view(id, cx) else {
        return gpui::Empty.into_any_element();
    };
    view.update(cx, |v, cx| {
        v.set_opener(open);
        v.show(book, target, locale, platform, cx);
    });
    view.into_any_element()
}

/// Reveal a specific comment in the named pane. The request survives the
/// pane's initial asynchronous load and does not affect other Review panes.
/// Acknowledges only after loading, scrolling and painting the target visibly. Missing/failed
/// reads return false; a replacement, book switch or view release closes it.
pub fn reveal_comment(
    id: &str,
    book: &str,
    comment: &str,
    cx: &mut App,
) -> Option<futures::channel::oneshot::Receiver<bool>> {
    let view = ensure_view(id, cx)?;
    Some(view.update(cx, |view, cx| view.reveal_comment(book, comment, cx)))
}

fn ensure_view(id: &str, cx: &mut App) -> Option<Entity<ReviewView>> {
    let id = SharedString::from(id.to_owned());
    let (view, lib) = {
        let hub = cx.try_global::<Hub>()?;
        (hub.views.get(&id).cloned(), hub.lib.clone())
    };
    let view = match view {
        Some(v) => v,
        None => {
            let v = cx.new(|_| ReviewView::new(id.clone(), lib));
            let observed = v.downgrade();
            // Pointing at sand in the prose lights its card.
            cx.observe_global::<dr_editor::decor::ReviewFocus>(move |cx| {
                if let Some(v) = observed.upgrade() {
                    v.update(cx, |_, cx| cx.notify());
                }
            })
            .detach();
            cx.global_mut::<Hub>().views.insert(id, v.clone());
            v
        }
    };
    Some(view)
}

/// The Review tab shown as `id`, once [`panel`] has drawn it.
pub fn view(id: &str, cx: &App) -> Option<Entity<ReviewView>> {
    cx.try_global::<Hub>()
        .and_then(|h| h.views.get(&SharedString::from(id.to_owned())).cloned())
}
