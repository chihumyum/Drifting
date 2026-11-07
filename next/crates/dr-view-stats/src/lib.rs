//! dr-view-stats: word counts and writing days (module M07).
//!
//! - The Stats tab of the right sidebar ([`panel`]): the most specific count
//!   (selection → chapter or idea → storyline → book), the book's, today's
//!   words toward the daily goal, writing progress and the recent days.
//! - The writing-day recorder ([`recorder`]): this device's words per book
//!   and day, written to the book document's `writing_days` under the 0.1
//!   writing-day device key.
//! - The editor's live counts ([`LiveWords`]), swapped into the index's
//!   totals so the readings follow the typing.
//! - The writing-goal progress for the Project Home (M02):
//!   [`load_progress`] off the main thread, [`today_live`] for this device's
//!   words not stored yet.
//!
//! The shell installs it ([`init`]), flushes it and lets go of the library
//! before quitting ([`flush`], [`release`]) and shows the tab ([`panel`]). docs/rust-rewrite/modules/m07-words.md
//! has the rules and the decisions.

pub mod clock;
pub mod detail;
pub mod live;
pub mod model;
mod panel;
pub mod recorder;
mod sections;

use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use dr_i18n::{Locale, Platform};
use dr_model::Day;
use dr_ui::sand;
use dr_ui::tokens::Rgb;
use dr_workspace::commands::BookIn;
use dr_workspace::commands::stats::{self as ops};
use dr_workspace::{Actor, NavTarget, Subscription, Workspace, WsEvent};
use gpui::{AnyElement, App, AppContext as _, Entity, Global, IntoElement, SharedString, Window};

pub use dr_text::TextMetrics;
pub use live::LiveWords;
pub use model::{Live, Reading, Scope};
pub use panel::StatsView;
pub use recorder::Recorder;

/// What a row of the Stats tab asks the shell for.
#[derive(Clone, Debug, PartialEq)]
pub enum StatsAction {
    /// Open a page. `link`, a location link, goes first: a chapter of the
    /// whole book while the whole book is in front is shown there (the
    /// shell's `open_link`).
    Open {
        target: NavTarget,
        link: Option<String>,
    },
    /// The snapshot history of a prose document (M09's dialog), for the
    /// page called `name`.
    History { doc: String, name: String },
}

/// Does what a row asks ([`StatsAction`]).
pub type Act = Rc<dyn Fn(StatsAction, &mut Window, &mut App)>;
/// A page's kind mark and colour.
pub type Marks = Rc<dyn Fn(&NavTarget) -> (sand::Kind, Option<Rgb>)>;

/// What the tab's rows do, and the mark and colour of a page (the shell
/// knows both): given with [`panel`].
#[derive(Clone)]
pub struct Hooks {
    pub act: Act,
    pub marks: Marks,
}

struct Hub {
    lib: Option<Workspace>,
    recorder: Option<Recorder>,
    subscription: Option<Subscription>,
    views: HashMap<SharedString, Entity<StatsView>>,
}

impl Global for Hub {}

/// Installs the recorder over the library (when there is one) and routes
/// the library's events to the Stats tabs. Call once, at start-up.
pub fn init(lib: Option<Workspace>, cx: &mut App) {
    let (tx, mut rx) = futures::channel::mpsc::unbounded::<Msg>();
    let recorder = lib.as_ref().map(|lib| {
        let tx = tx.clone();
        Recorder::over(lib, move |book| {
            let _ = tx.unbounded_send(Msg::Today(book.to_owned()));
        })
    });
    let subscription = lib.as_ref().map(|lib| {
        let tx = tx.clone();
        lib.subscribe(move |e| {
            let relevant = match e {
                WsEvent::Local(c) => c.table == "index",
                WsEvent::Book(_) => true,
                _ => false,
            };
            if relevant {
                let _ = tx.unbounded_send(Msg::Event(e.clone()));
            }
        })
    });
    cx.set_global(Hub {
        lib,
        recorder,
        subscription,
        views: HashMap::new(),
    });
    // Ends once [`release`] drops the recorder and the subscription (the
    // last senders).
    drop(tx);
    cx.spawn(async move |cx| {
        use futures::StreamExt as _;
        while let Some(first) = rx.next().await {
            let mut batch = vec![first];
            while let Ok(more) = rx.try_recv() {
                batch.push(more);
            }
            cx.update(|cx| route(batch, cx));
        }
    })
    .detach();
}

enum Msg {
    Event(WsEvent),
    /// The recorder's words for a book moved.
    Today(String),
}

fn route(batch: Vec<Msg>, cx: &mut App) {
    let Some(hub) = cx.try_global::<Hub>() else {
        return;
    };
    let views: Vec<Entity<StatsView>> = hub.views.values().cloned().collect();
    let today = |book: &str, cx: &App| {
        cx.try_global::<Hub>()
            .and_then(|h| h.recorder.as_ref())
            .and_then(|r| r.today(book))
    };
    for msg in batch {
        for view in &views {
            match &msg {
                Msg::Today(book) => {
                    let mine = today(book, cx);
                    view.update(cx, |v, cx| {
                        if &v.book == book {
                            v.set_mine(mine, cx);
                        }
                    });
                }
                Msg::Event(WsEvent::Local(c)) => view.update(cx, |v, cx| {
                    if v.shows_doc(&c.key) {
                        v.schedule(cx);
                    }
                }),
                Msg::Event(WsEvent::Book(b)) => view.update(cx, |v, cx| {
                    if v.book == b.book.as_str() {
                        v.schedule(cx);
                    }
                }),
                Msg::Event(_) => {}
            }
        }
    }
}

/// Stores every unsaved writing day now (before quitting).
pub fn flush(cx: &mut App) {
    if let Some(r) = cx.try_global::<Hub>().and_then(|h| h.recorder.as_ref())
        && !r.flush(Duration::from_millis(500))
    {
        log::warn!("writing days were not all stored before quitting");
    }
}

/// Lets go of the library before quitting: the recorder stops, the
/// subscription and the tabs go, so nothing here keeps the library open.
/// Call after [`flush`].
pub fn release(cx: &mut App) {
    if cx.has_global::<Hub>() {
        let hub = cx.global_mut::<Hub>();
        hub.recorder = None;
        hub.subscription = None;
        hub.views.clear();
        hub.lib = None;
    }
}

/// The Stats tab for `book`, following the page `target`. `id` tells two
/// panes apart (a sidebar half each).
pub fn panel(
    id: &str,
    book: &str,
    target: Option<NavTarget>,
    locale: Locale,
    platform: Platform,
    hooks: Option<Hooks>,
    cx: &mut App,
) -> AnyElement {
    let id = SharedString::from(id.to_owned());
    let (view, lib, recorder_today) = {
        let Some(hub) = cx.try_global::<Hub>() else {
            return gpui::Empty.into_any_element();
        };
        (
            hub.views.get(&id).cloned(),
            hub.lib.clone(),
            hub.recorder.as_ref().and_then(|r| r.today(book)),
        )
    };
    // The recorder follows the book shown from the moment it is shown.
    let shown = view.as_ref().map(|v| v.read(cx).book.clone());
    if shown.as_deref() != Some(book)
        && !book.is_empty()
        && let Some(r) = cx.try_global::<Hub>().and_then(|h| h.recorder.as_ref())
    {
        r.track(book);
    }
    let view = match view {
        Some(v) => v,
        None => {
            let v = cx.new(|_| StatsView::new(id.clone(), lib));
            let observed = v.downgrade();
            cx.observe_global::<LiveWords>(move |cx| {
                if let Some(v) = observed.upgrade() {
                    v.update(cx, |_, cx| cx.notify());
                }
            })
            .detach();
            cx.global_mut::<Hub>().views.insert(id, v.clone());
            v
        }
    };
    view.update(cx, |v, cx| {
        v.show(book, target, locale, platform, hooks, cx);
        v.set_mine(recorder_today, cx);
    });
    view.into_any_element()
}

/// The Stats tab shown as `id`, once [`panel`] has drawn it.
pub fn view(id: &str, cx: &App) -> Option<Entity<StatsView>> {
    cx.try_global::<Hub>()
        .and_then(|h| h.views.get(&SharedString::from(id.to_owned())).cloned())
}

/// This device's words today in `book` that the recorder has tallied (not
/// necessarily stored yet); `None` when it does not follow the book.
pub fn today_live(book: &str, cx: &App) -> Option<i64> {
    cx.try_global::<Hub>()
        .and_then(|h| h.recorder.as_ref())
        .and_then(|r| r.today(book))
}

/// A book's writing goals and how far they are (M02's Project Home).
#[derive(Clone, Debug, PartialEq)]
pub struct Progress {
    /// The book's words (its chapters), from the index.
    pub words: u64,
    /// Every chapter is counted.
    pub counted: bool,
    pub word_target: Option<i64>,
    /// 0–1; `None` without a target.
    pub book: Option<f32>,
    /// Today's words, all devices.
    pub today: i64,
    pub daily_word_target: Option<i64>,
    pub daily: Option<f32>,
    pub week: i64,
    /// Consecutive days with words, ending today.
    pub streak: u32,
}

/// Reads a book's [`Progress`] (call off the main thread). `mine_live` is
/// [`today_live`]: this device's words not stored yet.
pub fn load_progress(
    ws: &Workspace,
    book: &str,
    today: &Day,
    mine_live: Option<i64>,
) -> dr_workspace::Result<Progress> {
    let counts = ws
        .run::<ops::WordCounts>(
            &Actor::User,
            BookIn {
                book: book.to_owned(),
            },
        )?
        .output;
    let days = ws
        .run::<ops::WritingDays>(
            &Actor::User,
            ops::WritingDaysIn {
                book: book.to_owned(),
                today: today.to_string(),
                days: Some(1),
                device: ws.writing_device(),
            },
        )?
        .output;
    let today = model::today_words(&days, mine_live);
    Ok(Progress {
        words: counts.book.words,
        counted: counts.counted,
        word_target: counts.word_target,
        book: model::progress(counts.book.words, counts.word_target),
        today,
        daily_word_target: days.daily_word_target,
        daily: model::progress(today.max(0) as u64, days.daily_word_target),
        week: days.week - days.today + today,
        streak: if today > 0 { days.streak_before + 1 } else { 0 },
    })
}
