//! dr-view-feedback: feedback and the crash follow-up (module M39).
//!
//! - **The feedback dialog** ([`FeedbackDialog`], components.md
//!   「提交反馈」): the author's message, a reply-to address and a switch,
//!   on by default, for the sanitized diagnostic summary, which the dialog
//!   takes once as it opens and can preview. ⌘↩ (Ctrl+Enter on Windows)
//!   sends. It goes to the Hosted service over the 0.1 client's versioned
//!   contract (`dr_platform::feedback`: `POST /api/diagnostics/v1/feedback`,
//!   `drifting.feedback` v1); without the service, in development builds,
//!   or when sending fails, the same message goes to the mail client.
//! - **The crash follow-up**: after a crash that was reported, the shell
//!   posts 「上次出了故障」 in the notification center
//!   (`dr_shell::notifications::check_crash_follow_up`, from F7's
//!   `CrashReporting::take_follow_up`). Clicking it opens this dialog about
//!   that crash: its time above the title, the message asks what the author
//!   was doing, and 「忽略」 retires the notice. Sending a note retires it
//!   too; closing keeps it.
//!
//! Nothing here reads the manuscript, the library or the keychain: the
//! summary is counts and codes, sanitized with the 0.1 rules.
//!
//! The app calls [`init`] after `dr_shell::init`; the shell shows the dialog
//! through `dr_shell::dialogs`. docs/rust-rewrite/modules/m39-feedback.md
//! has the decisions.

mod dialog;

use std::path::{Path, PathBuf};

use dr_platform::Identity;
use dr_platform::feedback::{Delivery, Sender};
use gpui::{App, AppContext as _, Global};

pub use dialog::{FeedbackDialog, KEY_CONTEXT, MESSAGE_ROWS, Phase, WIDTH};

/// Where feedback goes and who sends it.
#[derive(Clone, Debug)]
pub struct Service {
    pub delivery: Delivery,
    pub app_version: String,
    /// The app's data folder, where the diagnostics id is kept; it is made
    /// on the first send, as 0.1 made it. `None`: `diag-unavailable`.
    pub data: Option<PathBuf>,
    /// The Hosted session, when the author is signed in. The account module
    /// (M36) sets it with [`Service::set_session`]; until then feedback goes
    /// without one, as 0.1 sent it when signed out.
    pub session: Option<String>,
}

impl Global for Service {}

impl Service {
    /// This build: its delivery (`Delivery::for_build`) and data folder.
    pub fn for_build(identity: &Identity, data: Option<&Path>, app_version: &str) -> Service {
        Service {
            delivery: Delivery::for_build(identity),
            app_version: app_version.to_owned(),
            data: data.map(Path::to_path_buf),
            session: None,
        }
    }

    /// Who sends: the version, the platform and the diagnostics id.
    pub fn sender(&self) -> Sender {
        Sender::new(
            &self.app_version,
            &dr_platform::diagnostics::installation_id(self.data.as_deref()),
        )
    }

    pub fn set_session(session: Option<String>, cx: &mut App) {
        if cx.has_global::<Service>() {
            cx.global_mut::<Service>().session = session;
        }
    }
}

/// Registers the feedback dialog with the shell.
pub fn init(service: Service, cx: &mut App) {
    cx.set_global(service);
    dr_shell::dialogs::set_feedback(cx, |follow_up, close, window, cx| {
        cx.new(|cx| FeedbackDialog::new(follow_up, close, window, cx))
            .into()
    });
}
