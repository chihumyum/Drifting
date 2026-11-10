pub mod clock;
pub mod live;
pub mod model;
pub mod recorder;
mod sections;
pub mod v3;
pub mod v3_panel;

use std::collections::HashMap;
use std::time::Duration;

use dr_model::Day;
use dr_workspace::commands::stats::{self as ops};
use dr_workspace::{Actor, Subscription, Workspace, WsEvent};
use gpui::{App, Entity, Global, SharedString};

pub use dr_text::TextMetrics;
pub use live::LiveWords;
pub use model::Live;
pub use recorder::Recorder;

struct Hub {
    lib: Option<Workspace>,
    recorder: Option<Recorder>,
    subscription: Option<Subscription>,
    v3_views: HashMap<SharedString, Entity<v3_panel::View>>,
}

impl Global for Hub {}

/// A notification for Home when this device's unflushed daily tally moves.
#[derive(Default)]
pub struct WritingDaysChanged(u64);
impl Global for WritingDaysChanged {}

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
        v3_views: HashMap::new(),
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
    let v3_views: Vec<_> = hub.v3_views.values().cloned().collect();
    let today = |book: &str, cx: &App| {
        cx.try_global::<Hub>()
            .and_then(|h| h.recorder.as_ref())
            .and_then(|r| r.today(book))
    };
    for msg in batch {
        if matches!(msg, Msg::Today(_)) {
            cx.default_global::<WritingDaysChanged>().0 += 1;
        }
        for view in &v3_views {
            match &msg {
                Msg::Today(book) => {
                    let mine = today(book, cx);
                    view.update(cx, |v, cx| {
                        if &v.book == book {
                            v.set_mine(mine, cx);
                        }
                    });
                }
                Msg::Event(WsEvent::Book(b)) => view.update(cx, |v, cx| {
                    if v.book == b.book.as_str() {
                        v.reload(cx);
                    }
                }),
                Msg::Event(WsEvent::Local(c)) if c.table == "index" => {
                    view.update(cx, |v, cx| v.reload(cx))
                }
                _ => {}
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
        hub.v3_views.clear();
        hub.lib = None;
    }
}

/// This device's words today in `book` that the recorder has tallied (not
/// necessarily stored yet); `None` when it does not follow the book.
pub fn today_live(book: &str, cx: &App) -> Option<i64> {
    cx.try_global::<Hub>()
        .and_then(|h| h.recorder.as_ref())
        .and_then(|r| r.today(book))
}

/// Establish the current manuscript baseline when Home opens, before typing.
pub fn track_book(book: &str, cx: &App) {
    if let Some(r) = cx.try_global::<Hub>().and_then(|h| h.recorder.as_ref()) {
        r.track(book);
    }
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
    let counts = v3::load_at(ws, book, v3::Scope::Book, today)?;
    let metrics = counts.book_words(&Live::default());
    let words = metrics.map_or(0, |m| m.words);
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
        words,
        counted: metrics.is_some(),
        word_target: counts.word_target,
        book: model::progress(words, counts.word_target),
        today,
        daily_word_target: days.daily_word_target,
        daily: model::progress(today.max(0) as u64, days.daily_word_target),
        week: days.week - days.today + today,
        streak: if today > 0 { days.streak_before + 1 } else { 0 },
    })
}
