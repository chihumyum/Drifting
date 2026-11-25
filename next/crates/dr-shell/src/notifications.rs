//! The notification center: what happened while the author wrote.
//!
//! One list, many sources (the 0.1 client's `notifications.*`): sync, reader
//! comments on a shared link, the Agent's tidying, the Markdown folder, app
//! updates, the follow-up after a crash and the service operator's notices
//! (`docs/hosted-sync/notices.md`). The sources other than the crash
//! follow-up are placeholders until their modules post here.
//!
//! The crash follow-up comes from `dr_platform`: once the app has settled
//! after launch, [`check_crash_follow_up`] takes the newest crash reported
//! since the last run (each crash is asked about once) and posts it.
//!
//! A notice can carry one action ([`NoticeAction`], [`Notifications::post_with`]):
//! a small text button under its words, which runs the poster's callback in
//! the window it was clicked in (M10's 「接着导入」 for a book an import left
//! unfinished).
//!
//! Read: opening the center reads what it lists, and closing it reads what
//! arrived while it was open, whatever the source (0.1's `setCenterOpen`;
//! the workspace calls [`Notifications::mark_read`] on both). A module that
//! needs to know (the account notices) watches the global: while
//! [`Notifications::unread`] is false, every row listed has been read.

use std::rc::Rc;
use std::time::{Duration, SystemTime};

use dr_i18n::{Key, keys};
use gpui::{App, Global, SharedString, Window};

use crate::{Services, strings};

/// How long after the window opens the crash follow-up is checked.
pub const FOLLOW_UP_DELAY: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Source {
    Sync,
    ShareComments,
    MarkdownFolder,
    Update,
    CrashFollowUp,
    /// What the Hosted service's operator tells every signed-in author
    /// (account notices v1, posted by `dr_view_account::notices`).
    Notice,
    /// A notice the operator addressed to this account alone.
    PersonalNotice,
    /// The 0.1 library import (M10): a book it left unfinished.
    Import,
}

impl Source {
    pub fn label(self) -> Key {
        use keys::notifications as n;
        match self {
            Source::Sync => n::cloud_sync::SOURCE,
            Source::ShareComments => n::share_comments::SOURCE,
            Source::MarkdownFolder => n::markdown_folder::SOURCE,
            Source::Update => n::app_update::SOURCE,
            Source::CrashFollowUp => n::crash_follow_up::SOURCE,
            Source::Notice => n::notice::SOURCE,
            Source::PersonalNotice => n::notice::PERSONAL,
            Source::Import => keys::user_menu::IMPORT,
        }
    }
}

/// A notice button's callback: `(notice_id, window, cx)`.
pub type RunNotice = Rc<dyn Fn(u64, &mut Window, &mut App)>;

/// What a notice's button does: `run(notice_id, window, cx)` in the window
/// the notification center was clicked in. The callback removes the notice
/// when it is done with it.
#[derive(Clone)]
pub struct NoticeAction {
    pub label: SharedString,
    pub run: RunNotice,
}

impl std::fmt::Debug for NoticeAction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NoticeAction")
            .field("label", &self.label)
            .finish_non_exhaustive()
    }
}

impl PartialEq for NoticeAction {
    fn eq(&self, other: &Self) -> bool {
        self.label == other.label && Rc::ptr_eq(&self.run, &other.run)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    pub id: u64,
    pub source: Source,
    pub text: SharedString,
    pub at: SystemTime,
    /// The crash id a follow-up is about (for the feedback dialog, M39).
    pub crash_id: Option<String>,
    /// The notice's one button, if it has one.
    pub action: Option<NoticeAction>,
    /// What clicking it opens: a book's document (`node:<id>`; M40's file
    /// that could not be merged opens its chapter).
    pub opens: Option<(String, String)>,
    /// Active problems the author must act on stay pinned at the top and
    /// survive Clear. A notice can offer an action to resolve it.
    pub pinned: bool,
    /// Ongoing background job (e.g. import/export/restore): shows progress bar
    /// and survives Clear while running.
    pub running: bool,
    /// Optional 0.0..=1.0 completion progress for running tasks.
    pub progress: Option<f32>,
}

#[derive(Default)]
pub struct Notifications {
    items: Vec<Notice>,
    next: u64,
    unread: bool,
    /// Latest arriving notice's id and arrival time, for the brief arrival flash.
    latest_arrival: Option<(u64, std::time::Instant)>,
}

impl Global for Notifications {}

/// How long an arriving notice flashes near the top edge.
pub const FLASH_DURATION: Duration = Duration::from_secs(3);

/// The most kept; older ones go first.
pub const LIMIT: usize = 50;

impl Notifications {
    pub fn items(cx: &App) -> &[Notice] {
        &cx.global::<Notifications>().items
    }

    pub fn unread(cx: &App) -> bool {
        cx.global::<Notifications>().unread
    }

    pub fn has_pinned(cx: &App) -> bool {
        cx.try_global::<Notifications>()
            .is_some_and(|n| n.items.iter().any(|item| item.pinned))
    }

    pub fn has_clearable(cx: &App) -> bool {
        cx.try_global::<Notifications>()
            .is_some_and(|n| n.items.iter().any(|item| !item.pinned && !item.running))
    }

    pub fn has_running(cx: &App) -> bool {
        cx.try_global::<Notifications>()
            .is_some_and(|n| n.items.iter().any(|item| item.running))
    }

    /// Returns the most recently arrived notice while within [`FLASH_DURATION`].
    pub fn arrival_flash(cx: &App) -> Option<&Notice> {
        let n = cx.try_global::<Notifications>()?;
        let (id, at) = n.latest_arrival?;
        if at.elapsed() > FLASH_DURATION {
            return None;
        }
        n.items.iter().find(|item| item.id == id)
    }

    pub fn set_pinned(id: u64, pinned: bool, cx: &mut App) {
        let n = cx.global_mut::<Notifications>();
        if let Some(item) = n.items.iter_mut().find(|item| item.id == id) {
            item.pinned = pinned;
        }
        n.items.sort_by_key(|item| !item.pinned);
        cx.refresh_windows();
    }

    /// Posts an ongoing task notice with optional `progress` (0.0..=1.0).
    pub fn post_running(
        source: Source,
        text: impl Into<SharedString>,
        progress: Option<f32>,
        cx: &mut App,
    ) -> u64 {
        let id =
            Notifications::insert(source, text.into(), SystemTime::now(), None, None, None, cx);
        let n = cx.global_mut::<Notifications>();
        if let Some(item) = n.items.iter_mut().find(|item| item.id == id) {
            item.running = true;
            item.progress = progress.map(|p| p.clamp(0.0, 1.0));
        }
        cx.refresh_windows();
        id
    }

    /// Updates a running notice's label/progress or finishes it (`running = false`).
    pub fn update_running(
        id: u64,
        text: Option<SharedString>,
        progress: Option<f32>,
        running: bool,
        cx: &mut App,
    ) {
        let n = cx.global_mut::<Notifications>();
        if let Some(item) = n.items.iter_mut().find(|item| item.id == id) {
            if let Some(text) = text {
                item.text = text;
            }
            item.progress = progress.map(|p| p.clamp(0.0, 1.0));
            item.running = running;
        }
        cx.refresh_windows();
    }

    /// Posts a notice, newest first.
    pub fn post(source: Source, text: impl Into<SharedString>, cx: &mut App) -> u64 {
        Notifications::post_at(source, text, SystemTime::now(), None, cx)
    }

    pub fn post_at(
        source: Source,
        text: impl Into<SharedString>,
        at: SystemTime,
        crash_id: Option<String>,
        cx: &mut App,
    ) -> u64 {
        Notifications::insert(source, text.into(), at, crash_id, None, None, cx)
    }

    /// Posts a notice that can open `doc` of `book` and offer a separate action.
    pub fn post_opening(
        source: Source,
        text: impl Into<SharedString>,
        opens: Option<(String, String)>,
        action: Option<NoticeAction>,
        cx: &mut App,
    ) -> u64 {
        Notifications::insert(
            source,
            text.into(),
            SystemTime::now(),
            None,
            action,
            opens,
            cx,
        )
    }

    /// Posts a notice with a button ([`NoticeAction`]), newest first.
    pub fn post_with(
        source: Source,
        text: impl Into<SharedString>,
        action: NoticeAction,
        cx: &mut App,
    ) -> u64 {
        Notifications::insert(
            source,
            text.into(),
            SystemTime::now(),
            None,
            Some(action),
            None,
            cx,
        )
    }

    fn insert(
        source: Source,
        text: SharedString,
        at: SystemTime,
        crash_id: Option<String>,
        action: Option<NoticeAction>,
        opens: Option<(String, String)>,
        cx: &mut App,
    ) -> u64 {
        let n = cx.global_mut::<Notifications>();
        n.next += 1;
        let id = n.next;
        let index = n
            .items
            .iter()
            .position(|item| !item.pinned)
            .unwrap_or(n.items.len());
        n.items.insert(
            index,
            Notice {
                id,
                source,
                text,
                at,
                crash_id,
                action,
                opens,
                pinned: false,
                running: false,
                progress: None,
            },
        );
        n.items.truncate(LIMIT);
        n.unread = true;
        n.latest_arrival = Some((id, std::time::Instant::now()));
        cx.refresh_windows();
        id
    }

    pub fn remove(id: u64, cx: &mut App) {
        cx.global_mut::<Notifications>()
            .items
            .retain(|n| n.id != id);
        cx.refresh_windows();
    }

    pub fn clear(cx: &mut App) {
        let n = cx.global_mut::<Notifications>();
        n.items.retain(|item| item.pinned || item.running);
        n.unread = false;
        n.latest_arrival = None;
        cx.refresh_windows();
    }

    /// Every row listed now has been read (the center opened or closed).
    pub fn mark_read(cx: &mut App) {
        let n = cx.global_mut::<Notifications>();
        n.unread = false;
        n.latest_arrival = None;
    }
}

pub(crate) fn install(cx: &mut App) {
    cx.set_global(Notifications::default());
}

/// Posts the newest crash since the last run, once.
pub fn check_crash_follow_up(cx: &mut App) {
    let follow_up = cx
        .try_global::<Services>()
        .and_then(|s| s.crash_reports.as_ref())
        .and_then(|reports| reports.take_follow_up());
    if let Some(follow_up) = follow_up {
        let at = SystemTime::UNIX_EPOCH + Duration::from_secs(follow_up.occurred_at);
        let text = strings::t(cx, keys::feedback::crash::TITLE);
        Notifications::post_at(Source::CrashFollowUp, text, at, Some(follow_up.id), cx);
    }
}

/// 「刚刚」, 「3 分钟前」, … as the 0.1 client wrote them.
pub fn ago(at: SystemTime, now: SystemTime, cx: &App) -> SharedString {
    use keys::notifications::time;
    let secs = now.duration_since(at).map(|d| d.as_secs()).unwrap_or(0);
    let (key, count) = match secs {
        0..60 => return strings::t(cx, time::JUST_NOW),
        60..3600 => (time::MINUTES_AGO, secs / 60),
        3600..86_400 => (time::HOURS_AGO, secs / 3600),
        _ => (time::DAYS_AGO, secs / 86_400),
    };
    strings::tf(cx, key, &[("count", &count)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    fn pinned_sync_notices_stay_first_and_survive_clear(cx: &mut TestAppContext) {
        cx.update(|cx| {
            install(cx);
            assert!(!Notifications::has_pinned(cx));

            let ordinary_a = Notifications::post(Source::Update, "update available", cx);
            let sync_problem = Notifications::post(Source::Sync, "session expired", cx);
            Notifications::set_pinned(sync_problem, true, cx);
            assert!(Notifications::has_pinned(cx));

            // Subsequent ordinary notices insert below pinned rows.
            let ordinary_b = Notifications::post(Source::Import, "import note", cx);
            let ids: Vec<u64> = Notifications::items(cx).iter().map(|n| n.id).collect();
            assert_eq!(ids, vec![sync_problem, ordinary_b, ordinary_a]);

            // Clearing removes ordinary rows while retaining active pinned sync problems.
            Notifications::clear(cx);
            let remaining: Vec<u64> = Notifications::items(cx).iter().map(|n| n.id).collect();
            assert_eq!(remaining, vec![sync_problem]);
            assert!(Notifications::has_pinned(cx));

            // Resolving removes the pinned row and turns off the bell danger seal.
            Notifications::remove(sync_problem, cx);
            assert!(Notifications::items(cx).is_empty());
            assert!(!Notifications::has_pinned(cx));
        });
    }
}
