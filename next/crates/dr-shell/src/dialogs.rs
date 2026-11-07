//! Dialogs other crates draw over the workspace (the same pattern as
//! [`crate::pages`]): for now the feedback dialog (M39, `dr-view-feedback`).
//!
//! The app registers the maker once, after [`crate::init`]. The workspace
//! shows the dialog when [`crate::actions::SendFeedback`] is dispatched (the
//! account menu, Settings → About) or a crash follow-up in the notification
//! center is clicked, over the bookshelf too, and drops it when the dialog
//! calls the `close` it was given. Without a maker nothing opens.

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
