//! The notification center: what happened while the author wrote.
//!
//! One list, many sources (the 0.1 client's `notifications.*`): sync, reader
//! comments on a shared link, the Agent's tidying, the Markdown folder, app
//! updates and the follow-up after a crash. The sources other than the crash
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
    Organize,
    MarkdownFolder,
    Update,
    CrashFollowUp,
    /// The 0.1 library import (M10): a book it left unfinished.
    Import,
}

impl Source {
    pub fn label(self) -> Key {
        use keys::notifications as n;
        match self {
            Source::Sync => n::cloud_sync::SOURCE,
            Source::ShareComments => n::share_comments::SOURCE,
            Source::Organize => n::organize::SOURCE,
            Source::MarkdownFolder => n::markdown_folder::SOURCE,
            Source::Update => n::app_update::SOURCE,
            Source::CrashFollowUp => n::crash_follow_up::SOURCE,
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
}

#[derive(Default)]
pub struct Notifications {
    items: Vec<Notice>,
    next: u64,
    unread: bool,
}

impl Global for Notifications {}

/// The most kept; older ones go first.
pub const LIMIT: usize = 50;

impl Notifications {
    pub fn items(cx: &App) -> &[Notice] {
        &cx.global::<Notifications>().items
    }

    pub fn unread(cx: &App) -> bool {
        cx.global::<Notifications>().unread
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

    /// Posts a notice that opens `doc` of `book` when clicked, newest first.
    pub fn post_opening(
        source: Source,
        text: impl Into<SharedString>,
        opens: Option<(String, String)>,
        cx: &mut App,
    ) -> u64 {
        Notifications::insert(
            source,
            text.into(),
            SystemTime::now(),
            None,
            None,
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
        n.items.insert(
            0,
            Notice {
                id,
                source,
                text,
                at,
                crash_id,
                action,
                opens,
            },
        );
        n.items.truncate(LIMIT);
        n.unread = true;
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
        n.items.clear();
        n.unread = false;
        cx.refresh_windows();
    }

    pub fn mark_read(cx: &mut App) {
        cx.global_mut::<Notifications>().unread = false;
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
