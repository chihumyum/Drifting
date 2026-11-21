//! Dialogs other crates draw over the workspace: the one way to put a
//! modal over a window (the bookshelf or a book).
//!
//! - A dialog is the workspace's `dialog` view: one at a time, drawn over
//!   everything, and while it is open the workspace answers none of its own
//!   shortcuts (it is `covered()`); Esc and its own buttons close it.
//! - [`show`] / [`show_in`] / [`hide`]: a crate opens or closes its view
//!   (M10's import shows its list, progress, gate and summary this way, in
//!   the window the author started it in). Callable from anywhere, a click
//!   in the dialog itself included: a window busy with that click is
//!   reached once the click is over
//!   ([`crate::workspace::update_workspace`]).
//! - [`set_feedback`]: the feedback dialog (M39, `dr-view-feedback`) is
//!   made when [`crate::actions::SendFeedback`] is dispatched (the account
//!   menu, Settings → About), a crash follow-up is clicked or 「提交反馈」 is
//!   pressed on the page shown when the library cannot be opened (with its
//!   first line and code written in the message, [`FeedbackOpening`]), and
//!   dropped when it calls the `close` it was given. Without a maker
//!   nothing opens.

use std::rc::Rc;
use std::time::SystemTime;

use gpui::{AnyView, App, Global, Window};

/// The notice a crash follow-up dialog explains: retire it (by `notice`)
/// once the author sent a note or ignored it; closing keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FollowUpNotice {
    pub notice: u64,
    /// F7's crash id (the `drifting.crash_id` tag on the Sentry event).
    pub crash_id: String,
    pub at: SystemTime,
}

/// What a dialog calls to go away.
pub type Close = Rc<dyn Fn(&mut Window, &mut App)>;

/// What the feedback dialog opens with.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FeedbackOpening {
    /// The crash it follows up, when a crash follow-up was clicked.
    pub follow_up: Option<FollowUpNotice>,
    /// The message already written in it (the page shown when the library
    /// cannot be opened: 「没能打开资料库（<code>）」).
    pub message: Option<String>,
}

type MakeFeedback = Rc<dyn Fn(FeedbackOpening, Close, &mut Window, &mut App) -> AnyView>;

#[derive(Clone, Default)]
struct Dialogs {
    feedback: Option<MakeFeedback>,
}

impl Global for Dialogs {}

/// Registers the feedback dialog: `make(opening, close, window, cx)`.
pub fn set_feedback(
    cx: &mut App,
    make: impl Fn(FeedbackOpening, Close, &mut Window, &mut App) -> AnyView + 'static,
) {
    cx.default_global::<Dialogs>().feedback = Some(Rc::new(make));
}

pub(crate) fn make_feedback(
    opening: FeedbackOpening,
    close: Close,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyView> {
    let make = cx.try_global::<Dialogs>()?.feedback.clone()?;
    Some(make(opening, close, window, cx))
}

/// Shows `view` as the dialog (in place of any other) of the workspace an
/// action was dispatched to (`workspace::active_workspace`).
pub fn show(cx: &mut App, view: AnyView) {
    crate::workspace::with_workspace(cx, move |ws, _, cx| put(ws, view, cx));
}

/// Shows `view` as the dialog of the workspace in `window` (the one the
/// author started it in), or, when that window is gone, as [`show`] does.
pub fn show_in(window: gpui::AnyWindowHandle, cx: &mut App, view: AnyView) {
    crate::workspace::with_workspace_in(window, cx, move |ws, _, cx| put(ws, view, cx));
}

fn put(ws: &mut crate::Workspace, view: AnyView, cx: &mut gpui::Context<crate::Workspace>) {
    ws.notifications_open = false;
    ws.account_open = false;
    ws.dialog = Some(view);
    cx.notify();
}

/// Closes `view` in whichever workspace window shows it; that page gets the
/// keyboard back.
pub fn hide(cx: &mut App, view: gpui::EntityId) {
    let shown: Vec<_> = cx
        .windows()
        .into_iter()
        .filter_map(|w| w.downcast::<crate::Workspace>())
        .collect();
    for handle in shown {
        crate::workspace::update_workspace(handle, cx, move |ws, window, cx| {
            if ws.dialog.as_ref().is_some_and(|d| d.entity_id() == view) {
                ws.dialog = None;
                ws.refocus(window, cx);
            }
        });
    }
}
