//! Dialogs other crates draw over the workspace: the one way to put a
//! modal over a window (the bookshelf or a book).
//!
//! - A dialog is the workspace's `dialog` view: one at a time, drawn over
//!   everything, and while it is open the workspace answers none of its own
//!   shortcuts (it is `covered()`); Esc and its own buttons close it.
//! - [`show`] / [`hide`]: a crate opens or closes its view (M10's import
//!   shows its progress, gate and summary this way).
//! - [`set_feedback`]: the feedback dialog (M39, `dr-view-feedback`) is
//!   made when [`crate::actions::SendFeedback`] is dispatched (the account
//!   menu, Settings → About) or a crash follow-up is clicked, and dropped
//!   when it calls the `close` it was given. Without a maker nothing opens.

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

type MakeFeedback = Rc<dyn Fn(Option<FollowUpNotice>, Close, &mut Window, &mut App) -> AnyView>;

#[derive(Clone, Default)]
struct Dialogs {
    feedback: Option<MakeFeedback>,
}

impl Global for Dialogs {}

/// Registers the feedback dialog: `make(follow_up, close, window, cx)`.
pub fn set_feedback(
    cx: &mut App,
    make: impl Fn(Option<FollowUpNotice>, Close, &mut Window, &mut App) -> AnyView + 'static,
) {
    cx.default_global::<Dialogs>().feedback = Some(Rc::new(make));
}

pub(crate) fn make_feedback(
    follow_up: Option<FollowUpNotice>,
    close: Close,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyView> {
    let make = cx.try_global::<Dialogs>()?.feedback.clone()?;
    Some(make(follow_up, close, window, cx))
}

/// Shows `view` as the workspace window's dialog (in place of any other).
pub fn show(cx: &mut App, view: AnyView) {
    crate::workspace::with_workspace(cx, move |ws, _, cx| {
        ws.notifications_open = false;
        ws.account_open = false;
        ws.dialog = Some(view);
        cx.notify();
    });
}

/// Closes `view` if it is the dialog shown; the page gets the keyboard back.
pub fn hide(cx: &mut App, view: gpui::EntityId) {
    crate::workspace::with_workspace(cx, move |ws, window, cx| {
        if ws.dialog.as_ref().is_some_and(|d| d.entity_id() == view) {
            ws.dialog = None;
            ws.refocus(window, cx);
        }
    });
}
