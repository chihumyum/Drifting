//! Account notices (M35 「运营公告」, the 0.1 client's
//! `docs/hosted-sync/notices.md`): while an account is signed in, reads what
//! the Hosted service's operator tells it ([`dr_account::notices`]) and lists
//! it in the notification center, `Source::Notice` for a notice to every
//! account and `Source::PersonalNotice` for one to this account alone. The
//! row's words are the notice's title and, on the lines under it, its body,
//! in the interface language (Chinese for a Chinese interface, English
//! otherwise, else whatever was written); plain text.
//!
//! **When.** Installed only in Hosted-configured builds; reads only while
//! the account is connected (or offline, where a read may find the network
//! back), never signed out. It reads once the session is known (at start,
//! after sign-in, on every change of the account's status), when a window
//! comes to the front (at most every 15 s), and then every
//! `refreshAfterSeconds` the service names (60 s by default, kept between
//! 15 s and an hour) while a window is in front, five times less often, at
//! most hourly, in the background. A failed read is tried again after 1, 2,
//! 4 … at most 300 s (full jitter); a service without the routes is asked
//! again after an hour, a refused session after five minutes or at the next
//! change of the account's status. Failures never notify the author; the log
//! says what kind of failure, never a notice's words or the session.
//!
//! **Read.** The center's list is in memory: after a restart the notices
//! still offered are listed again. A notice at or below the account's read
//! mark comes in read. A row is read here when the center opens while it is
//! listed, or closes after it arrived (`dr_shell::notifications`); the
//! newest such notice, or one the author removed, raises the account's mark
//! (`POST …/notices/read`), so the account's other devices take it as read.
//! A removed row (its ×, or 清空) stays away on this device until the service
//! stops offering it (device memory [`DISMISSED_MEMORY_KEY`], per account). A
//! notice the operator withdraws, or that expires, leaves at the next read;
//! signing out takes the account's notices away.

use std::collections::{BTreeMap, BTreeSet};
use std::hash::{BuildHasher as _, Hasher as _};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use dr_account::{
    AccountError, AccountErrorCode, AccountNotices, AccountService, NoticesEndpoint, SessionStatus,
};
use dr_shell::notifications::{Notifications, Source};
use dr_shell::{Settings, Strings};
use gpui::{App, Global, Subscription, Task};
use serde_json::Value;

use crate::Service;

/// How often the runtime looks whether a read is due.
pub const TICK: Duration = Duration::from_secs(15);
/// A window coming to the front reads again only after this long.
pub const FOCUS_MIN_INTERVAL: Duration = Duration::from_secs(15);
/// In the background a notice may take this many times longer to arrive …
const BACKGROUND_FACTOR: u32 = 5;
/// … but no longer than this.
pub const BACKGROUND_MAX: Duration = Duration::from_secs(60 * 60);
/// A service without account notices (404) is asked again after this long.
pub const UNSUPPORTED_RETRY: Duration = Duration::from_secs(60 * 60);
/// A refused session is tried again after this long, or at the next change
/// of the account's status.
pub const REFUSED_RETRY: Duration = Duration::from_secs(5 * 60);
/// The longest wait before a failed read is tried again.
pub const RETRY_MAX: Duration = Duration::from_secs(5 * 60);
/// Device memory: `{ "<account id>": ["<notice id>", …] }`, the notices the
/// author removed from the center on this device.
pub const DISMISSED_MEMORY_KEY: &str = "account.notices_dismissed";
const MAX_DISMISSED: usize = 200;

#[derive(Clone, Copy)]
struct Shown {
    /// Its row in the notification center.
    row: u64,
    seq: u64,
    read: bool,
}

/// What the center shows of one account's notices.
#[derive(Default)]
struct Feed {
    account: Option<String>,
    /// Notices that have a row, by notice id.
    shown: BTreeMap<String, Shown>,
    /// Notices the author removed on this device.
    dismissed: BTreeSet<String>,
    /// The account's read mark as the service last reported it.
    read_through: u64,
    /// The newest notice read or removed here.
    seen_through: u64,
    sent_through: u64,
}

struct Runtime {
    feed: Feed,
    /// Grows when the account changes or signs out: what was under way for
    /// the earlier one is dropped when it comes back.
    generation: u64,
    /// The account status and id last seen, to tell a change.
    last_account: Option<(SessionStatus, Option<String>)>,
    refresh: Duration,
    last_read: Option<Instant>,
    unsupported_until: Option<Instant>,
    refused_until: Option<Instant>,
    failures: u32,
    /// The generation a read under way is for.
    reading: Option<u64>,
    queued: bool,
    /// The generation a read mark under way is for.
    sending: Option<u64>,
    retry: Option<Task<()>>,
    _tick: Task<()>,
    _rows: Subscription,
    _windows: Subscription,
}

impl Global for Runtime {}

/// Starts reading notices (`dr_view_account::init`, Hosted-configured
/// builds only).
pub(crate) fn install(cx: &mut App) {
    if cx.has_global::<Runtime>() || !cx.has_global::<Notifications>() {
        return;
    }
    // The author read or removed a row.
    let rows = cx.observe_global::<Notifications>(rows_changed);
    let windows = cx.observe_new::<dr_shell::Workspace>(|_, window, cx| {
        let Some(window) = window else {
            return;
        };
        cx.observe_window_activation(window, |_, window, cx| {
            if window.is_window_active() {
                came_to_front(cx);
            }
        })
        .detach();
    });
    let tick = cx.spawn(async move |cx| {
        loop {
            cx.background_executor().timer(TICK).await;
            cx.update(tick);
        }
    });
    let last_account = account_key(cx);
    cx.set_global(Runtime {
        feed: Feed::default(),
        generation: 0,
        last_account,
        refresh: dr_account::notices::REFRESH_DEFAULT,
        last_read: None,
        unsupported_until: None,
        refused_until: None,
        failures: 0,
        reading: None,
        queued: false,
        sending: None,
        retry: None,
        _tick: tick,
        _rows: rows,
        _windows: windows,
    });
    request(cx);
}

/// The account's status or identity changed (`apply_account_state`):
/// signing in reads at once, signing out takes the notices away.
pub(crate) fn account_changed(cx: &mut App) {
    if !cx.has_global::<Runtime>() {
        return;
    }
    let key = account_key(cx);
    let rt = cx.global_mut::<Runtime>();
    if rt.last_account == key {
        return;
    }
    rt.last_account = key;
    rt.refused_until = None;
    request(cx);
}

/// Reads the account's notices now, unless a read is under way (then once
/// more after it), the service asked to wait, or nobody is signed in.
pub fn request(cx: &mut App) {
    if !cx.has_global::<Runtime>() {
        return;
    }
    let Some((inner, account)) = session(cx) else {
        if signed_off(cx) {
            reset(cx);
        }
        return;
    };
    if cx.global::<Runtime>().feed.account.as_deref() != Some(account.as_str()) {
        reset(cx);
        let dismissed = load_dismissed(&account, cx);
        let feed = &mut cx.global_mut::<Runtime>().feed;
        feed.account = Some(account);
        feed.dismissed = dismissed;
    }
    let now = cx.background_executor().now();
    let rt = cx.global_mut::<Runtime>();
    let waiting = |until: Option<Instant>| until.is_some_and(|t| now < t);
    if waiting(rt.unsupported_until) || waiting(rt.refused_until) {
        return;
    }
    if rt.reading == Some(rt.generation) {
        rt.queued = true;
        return;
    }
    let generation = rt.generation;
    rt.reading = Some(generation);
    rt.queued = false;
    rt.retry = None;
    rt.last_read = Some(now);
    cx.spawn(async move |cx| {
        let result = cx
            .background_executor()
            .spawn(async move { inner.read_notices() })
            .await;
        cx.update(|cx| finished_read(generation, result, cx));
    })
    .detach();
}

fn tick(cx: &mut App) {
    if !cx.has_global::<Runtime>() {
        return;
    }
    if session(cx).is_none() {
        if signed_off(cx) {
            reset(cx);
        }
        return;
    }
    let front = in_front(cx);
    let now = cx.background_executor().now();
    let rt = cx.global::<Runtime>();
    let interval = if front {
        rt.refresh
    } else {
        (rt.refresh * BACKGROUND_FACTOR).min(BACKGROUND_MAX)
    };
    let due = rt
        .last_read
        .is_none_or(|at| now.duration_since(at) + Duration::from_secs(1) >= interval);
    if due {
        request(cx);
    }
}

fn came_to_front(cx: &mut App) {
    if !cx.has_global::<Runtime>() {
        return;
    }
    let now = cx.background_executor().now();
    let last = cx.global::<Runtime>().last_read;
    if last.is_none_or(|at| now.duration_since(at) >= FOCUS_MIN_INTERVAL) {
        request(cx);
    }
}

fn finished_read(
    generation: u64,
    result: Result<NoticesEndpoint<AccountNotices>, AccountError>,
    cx: &mut App,
) {
    if !cx.has_global::<Runtime>() {
        return;
    }
    let now = cx.background_executor().now();
    let rt = cx.global_mut::<Runtime>();
    if rt.reading == Some(generation) {
        rt.reading = None;
    }
    if generation != rt.generation {
        return;
    }
    match result {
        Ok(NoticesEndpoint::Supported(list)) => {
            rt.failures = 0;
            rt.refresh = list.refresh_after;
            show(list, cx);
            acknowledge(cx);
        }
        Ok(NoticesEndpoint::Unsupported) => {
            // An older service has no notices: there is nothing to show.
            rt.unsupported_until = Some(now + UNSUPPORTED_RETRY);
            log::info!("the service has no account notices; asking again in an hour");
        }
        // An expired session is the account status' to report.
        Err(error) if error.code == AccountErrorCode::Unauthorized => {
            rt.refused_until = Some(now + REFUSED_RETRY);
            log::info!(
                "the service refused the session for account notices (status {:?})",
                error.status
            );
        }
        Err(error) => {
            rt.failures += 1;
            let wait = backoff(rt.failures);
            log::warn!(
                "account notices could not be read ({:?}, status {:?}); trying again later",
                error.code,
                error.status
            );
            let retry = cx.spawn(async move |cx| {
                cx.background_executor().timer(wait).await;
                cx.update(request);
            });
            cx.global_mut::<Runtime>().retry = Some(retry);
        }
    }
    if std::mem::take(&mut cx.global_mut::<Runtime>().queued) {
        request(cx);
    }
}

/// Brings the center in line with what the service offers now.
fn show(list: AccountNotices, cx: &mut App) {
    note_dismissals(cx);
    let offered: BTreeSet<String> = list.notices.iter().map(|n| n.id.clone()).collect();
    // Withdrawn or expired: taken out of `shown` first, so its row going is
    // not taken for the author's doing.
    let feed = &mut cx.global_mut::<Runtime>().feed;
    let gone: Vec<u64> = feed
        .shown
        .extract_if(.., |id, _| !offered.contains(id))
        .map(|(_, shown)| shown.row)
        .collect();
    let dismissed_before = feed.dismissed.len();
    feed.dismissed.retain(|id| offered.contains(id));
    let forgot = feed.dismissed.len() != dismissed_before;
    feed.read_through = feed.read_through.max(list.read_through);
    for row in gone {
        Notifications::remove(row, cx);
    }
    if forgot {
        save_dismissed(cx);
    }

    let locale = Strings::get(cx).locale().code();
    let now = SystemTime::now();
    for notice in &list.notices {
        let feed = &mut cx.global_mut::<Runtime>().feed;
        let read = notice.seq <= feed.read_through;
        if let Some(shown) = feed.shown.get_mut(&notice.id) {
            // Read on another of the account's devices.
            shown.read |= read;
            continue;
        }
        if feed.dismissed.contains(&notice.id) {
            feed.seen_through = feed.seen_through.max(notice.seq);
            continue;
        }
        let Some(text) = notice.text_for(locale) else {
            continue;
        };
        let words = if text.body.is_empty() {
            text.title.clone()
        } else {
            format!("{}\n{}", text.title, text.body)
        };
        let source = if notice.personal {
            Source::PersonalNotice
        } else {
            Source::Notice
        };
        // A service clock ahead of this device must not date a notice in
        // the future.
        let at = notice.published_at.map_or(now, |at| at.min(now));
        let was_unread = Notifications::unread(cx);
        let row = Notifications::post_at(source, words, at, None, cx);
        if read && !was_unread {
            // Already read on one of the account's devices.
            Notifications::mark_read(cx);
        }
        cx.global_mut::<Runtime>().feed.shown.insert(
            notice.id.clone(),
            Shown {
                row,
                seq: notice.seq,
                read,
            },
        );
    }
}

/// The center changed: the author may have read or removed a notice.
fn rows_changed(cx: &mut App) {
    if !cx
        .try_global::<Runtime>()
        .is_some_and(|rt| rt.feed.account.is_some())
    {
        return;
    }
    note_dismissals(cx);
    if !Notifications::unread(cx) {
        for shown in cx.global_mut::<Runtime>().feed.shown.values_mut() {
            shown.read = true;
        }
    }
    acknowledge(cx);
}

/// A shown notice whose row is gone was removed by the author: it stays away.
fn note_dismissals(cx: &mut App) {
    let listed: BTreeSet<u64> = Notifications::items(cx).iter().map(|n| n.id).collect();
    let feed = &mut cx.global_mut::<Runtime>().feed;
    let removed: Vec<(String, Shown)> = feed
        .shown
        .extract_if(.., |_, shown| !listed.contains(&shown.row))
        .collect();
    if removed.is_empty() {
        return;
    }
    for (id, shown) in removed {
        feed.seen_through = feed.seen_through.max(shown.seq);
        feed.dismissed.insert(id);
    }
    save_dismissed(cx);
}

/// Raises the account's read mark to the newest notice read or removed
/// here. One request at a time; a failure is tried again at the next read.
fn acknowledge(cx: &mut App) {
    let Some((inner, _)) = session(cx) else {
        return;
    };
    let now = cx.background_executor().now();
    let rt = cx.global_mut::<Runtime>();
    let feed = &mut rt.feed;
    for shown in feed.shown.values() {
        if shown.read {
            feed.seen_through = feed.seen_through.max(shown.seq);
        }
    }
    let through = feed.seen_through;
    if through <= feed.read_through.max(feed.sent_through)
        || rt.sending == Some(rt.generation)
        || rt.unsupported_until.is_some_and(|t| now < t)
    {
        return;
    }
    let generation = rt.generation;
    rt.sending = Some(generation);
    cx.spawn(async move |cx| {
        let result = cx
            .background_executor()
            .spawn(async move { inner.mark_notices_read(through) })
            .await;
        cx.update(|cx| finished_mark(generation, through, result, cx));
    })
    .detach();
}

fn finished_mark(
    generation: u64,
    through: u64,
    result: Result<NoticesEndpoint<u64>, AccountError>,
    cx: &mut App,
) {
    if !cx.has_global::<Runtime>() {
        return;
    }
    let rt = cx.global_mut::<Runtime>();
    if rt.sending == Some(generation) {
        rt.sending = None;
    }
    if generation != rt.generation {
        return;
    }
    match result {
        Ok(NoticesEndpoint::Supported(mark)) => {
            let feed = &mut rt.feed;
            feed.sent_through = feed.sent_through.max(through);
            feed.read_through = feed.read_through.max(mark);
            // A notice read while the request was under way.
            if feed.seen_through > through {
                acknowledge(cx);
            }
        }
        Ok(NoticesEndpoint::Unsupported) => {}
        Err(error) => log::warn!(
            "the account's notice read mark could not be raised ({:?}, status {:?}); trying again at the next read",
            error.code,
            error.status
        ),
    }
}

/// Signed out, or another account: the notices shown leave the center.
fn reset(cx: &mut App) {
    let rt = cx.global_mut::<Runtime>();
    if rt.feed.account.is_none() && rt.feed.shown.is_empty() {
        return;
    }
    // Cleared first, so taking the rows away is not the author's doing.
    let rows: Vec<u64> = std::mem::take(&mut rt.feed)
        .shown
        .into_values()
        .map(|shown| shown.row)
        .collect();
    rt.generation += 1;
    rt.queued = false;
    rt.retry = None;
    rt.failures = 0;
    for row in rows {
        Notifications::remove(row, cx);
    }
}

/// The service and account id to read for, while the account is connected
/// or offline.
fn session(cx: &App) -> Option<(Arc<AccountService>, String)> {
    let svc = cx.try_global::<Service>()?;
    let state = &svc.state;
    if !state.hosted_configured
        || !matches!(
            state.status,
            SessionStatus::Connected | SessionStatus::Offline
        )
    {
        return None;
    }
    let user = state.user.as_ref()?;
    Some((svc.inner.clone(), user.id.clone()))
}

/// Nobody is signed in (as opposed to a session being checked or refused,
/// which keeps what is listed).
fn signed_off(cx: &App) -> bool {
    cx.try_global::<Service>().is_none_or(|svc| {
        !svc.state.hosted_configured
            || svc.state.status == SessionStatus::SignedOut
            || svc.state.user.is_none()
    })
}

fn account_key(cx: &App) -> Option<(SessionStatus, Option<String>)> {
    let svc = cx.try_global::<Service>()?;
    Some((
        svc.state.status,
        svc.state.user.as_ref().map(|u| u.id.clone()),
    ))
}

/// Whether one of the app's windows is the active one.
fn in_front(cx: &mut App) -> bool {
    cx.windows().into_iter().any(|window| {
        window
            .update(cx, |_, window, _| window.is_window_active())
            .unwrap_or(false)
    })
}

/// 1, 2, 4 … at most [`RETRY_MAX`], times a random factor (0.1's supervisor).
fn backoff(failures: u32) -> Duration {
    let cap = Duration::from_secs(1u64 << failures.saturating_sub(1).min(18)).min(RETRY_MAX);
    let random = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    cap.mul_f64(random as f64 / u64::MAX as f64)
}

fn load_dismissed(account: &str, cx: &App) -> BTreeSet<String> {
    Settings::device_memory(cx, DISMISSED_MEMORY_KEY)
        .as_ref()
        .and_then(|all| all.get(account))
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .take(MAX_DISMISSED)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn save_dismissed(cx: &mut App) {
    let feed = &cx.global::<Runtime>().feed;
    let Some(account) = feed.account.clone() else {
        return;
    };
    let ids: Vec<Value> = feed
        .dismissed
        .iter()
        .take(MAX_DISMISSED)
        .cloned()
        .map(Value::String)
        .collect();
    let mut all = Settings::device_memory(cx, DISMISSED_MEMORY_KEY)
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    if ids.is_empty() {
        all.remove(&account);
    } else {
        all.insert(account, Value::Array(ids));
    }
    Settings::set_device_memory(
        cx,
        DISMISSED_MEMORY_KEY,
        (!all.is_empty()).then_some(Value::Object(all)),
    );
}
