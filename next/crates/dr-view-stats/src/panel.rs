//! The Stats tab (components.md 「统计面板」): flat type, sand readouts.
//!
//! Groups told apart by space alone, top to bottom:
//!
//! 1. the most specific count (the selection, the chapter or idea, the
//!    storyline, the book), the book's when that was not it, and today's
//!    words with a stroke toward the daily goal (M07);
//! 2. the page's own readings (M20, [`crate::sections`]): a chapter's or
//!    idea's coordinates, rhythm and elements; a storyline's coordinates
//!    and core elements; an element's mentions in and out; a category's
//!    health; a material's shape;
//! 3. writing progress: the book against its target, chapters, the average
//!    (a storyline's: its chapters by status first);
//! 4. the whole book's acts, completion and chapter lengths (M20, when the
//!    page is the whole book);
//! 5. recent days: this week, the streak, the last seven days (M07);
//! 6. 「历史快照…」, the page's snapshot history (M09's dialog).
//!
//! Counts come from the derived index (`book.word_counts`), the editor's own
//! counts swapped in ([`crate::LiveWords`]); writing days from the book
//! (`book.writing_days`) with this device's part from the recorder; the
//! page's readings from [`crate::detail`]. All are read off the main thread
//! and again after the index or the book moves.

use std::rc::Rc;
use std::time::Duration;

use dr_i18n::{I18n, Key, Locale, Platform, keys};
use dr_ui::Theme;
use dr_workspace::commands::BookIn;
use dr_workspace::commands::stats::{self as ops, WordCountsOut, WritingDaysOut};
use dr_workspace::{Actor, NavTarget, Workspace};
use gpui::{
    Context, ElementId, InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Task, Window, div, px,
};

use crate::Hooks;
use crate::detail::{self, Loaded};
use crate::live::LiveWords;
use crate::model::{self, Scope};
use crate::sections::Ui;

use keys::right_sidebar::stats;

/// How long after a change the counts are read again (a burst of index
/// writes reads once).
pub const RELOAD_DELAY: Duration = Duration::from_millis(300);

/// Days in the recent list.
const RECENT_DAYS: u32 = 7;

pub struct StatsView {
    id: SharedString,
    lib: Option<Workspace>,
    pub(crate) book: String,
    pub(crate) target: Option<NavTarget>,
    pub(crate) counts: Option<WordCountsOut>,
    days: Option<WritingDaysOut>,
    /// The page's readings, by the key of the page they are of.
    pub(crate) detail: Option<(String, Loaded)>,
    pub(crate) hooks: Option<Hooks>,
    /// The chapter under the pointer in the chapter-length rhythm.
    pub(crate) hover: Option<usize>,
    /// This device's words today, from the recorder.
    mine: Option<i64>,
    device: Option<String>,
    i18n: Option<Rc<I18n>>,
    load: Option<Task<()>>,
    again: bool,
    timer: Option<Task<()>>,
}

type Read = (
    dr_workspace::Result<WordCountsOut>,
    dr_workspace::Result<WritingDaysOut>,
    Option<(String, dr_workspace::Result<Option<Loaded>>)>,
);

impl StatsView {
    pub fn new(id: SharedString, lib: Option<Workspace>) -> StatsView {
        let device = lib.as_ref().and_then(Workspace::writing_device);
        StatsView {
            id,
            lib,
            book: String::new(),
            target: None,
            counts: None,
            days: None,
            detail: None,
            hooks: None,
            hover: None,
            mine: None,
            device,
            i18n: None,
            load: None,
            again: false,
            timer: None,
        }
    }

    /// What the tab shows now: the book, the page, the language, and what
    /// its rows do.
    pub fn show(
        &mut self,
        book: &str,
        target: Option<NavTarget>,
        locale: Locale,
        platform: Platform,
        hooks: Option<Hooks>,
        cx: &mut Context<Self>,
    ) {
        if self
            .i18n
            .as_ref()
            .is_none_or(|i| i.locale() != locale || i.platform() != platform)
        {
            self.i18n = Some(Rc::new(I18n::new(locale, platform)));
        }
        if hooks.is_some() {
            self.hooks = hooks;
        }
        let moved = self.target.as_ref().map(NavTarget::key) != target.as_ref().map(NavTarget::key);
        self.target = target;
        if self.book != book {
            self.book = book.to_owned();
            self.counts = None;
            self.days = None;
            self.detail = None;
            self.mine = None;
            self.hover = None;
            self.reload(cx);
        } else if moved {
            self.hover = None;
            self.reload(cx);
        }
    }

    pub(crate) fn set_mine(&mut self, mine: Option<i64>, cx: &mut Context<Self>) {
        if self.mine != mine {
            self.mine = mine;
            cx.notify();
        }
    }

    /// Reads the counts again after [`RELOAD_DELAY`].
    pub(crate) fn schedule(&mut self, cx: &mut Context<Self>) {
        if self.timer.is_some() {
            return;
        }
        self.timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(RELOAD_DELAY).await;
            this.update(cx, |v, cx| {
                v.timer = None;
                v.reload(cx);
            })
            .ok();
        }));
    }

    /// What the tab shows first now.
    pub fn reading(&self, cx: &gpui::App) -> model::Reading {
        model::reading(
            self.target.as_ref(),
            self.counts.as_ref(),
            LiveWords::read(cx),
        )
    }

    /// The book's words now (the index's, open chapters counted live).
    pub fn book_words(&self, cx: &gpui::App) -> Option<u64> {
        self.counts
            .as_ref()
            .and_then(|c| model::book_words(c, LiveWords::read(cx)))
    }

    /// Today's words shown (all devices), once read.
    pub fn today(&self) -> Option<i64> {
        self.days.as_ref().map(|d| model::today_words(d, self.mine))
    }

    /// The page's readings, once read (`None` before, or for another page).
    pub fn detail(&self) -> Option<&Loaded> {
        let (key, loaded) = self.detail.as_ref()?;
        (self.target.as_ref().map(NavTarget::key).as_deref() == Some(key.as_str()))
            .then_some(loaded)
    }

    /// What the tab's rows do (the shell's [`Hooks`]), once shown.
    pub fn hooks(&self) -> Option<&Hooks> {
        self.hooks.as_ref()
    }

    /// Whether a document belongs to the counts shown.
    pub(crate) fn shows_doc(&self, doc: &str) -> bool {
        self.counts
            .as_ref()
            .is_some_and(|c| c.chapters.iter().chain(&c.ideas).any(|d| d.doc == doc))
            || self
                .detail()
                .and_then(|d| d.doc.as_deref())
                .is_some_and(|d| d == doc)
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        if self.book.is_empty() {
            return;
        }
        if self.load.is_some() {
            self.again = true;
            return;
        }
        let book = self.book.clone();
        let device = self.device.clone();
        let target = self.target.clone();
        self.load = Some(cx.spawn(async move |this, cx| {
            let read_book = book.clone();
            let read: Read = cx
                .background_executor()
                .spawn(async move {
                    let counts = lib
                        .run::<ops::WordCounts>(
                            &Actor::User,
                            BookIn {
                                book: read_book.clone(),
                            },
                        )
                        .map(|o| o.output);
                    let days = lib
                        .run::<ops::WritingDays>(
                            &Actor::User,
                            ops::WritingDaysIn {
                                book: read_book.clone(),
                                today: crate::clock::today().to_string(),
                                days: Some(RECENT_DAYS),
                                device,
                            },
                        )
                        .map(|o| o.output);
                    let detail = target.map(|t| (t.key(), detail::load(&lib, &read_book, &t)));
                    (counts, days, detail)
                })
                .await;
            this.update(cx, |v, cx| v.loaded(&book, read, cx)).ok();
        }));
    }

    fn loaded(&mut self, book: &str, (counts, days, detail): Read, cx: &mut Context<Self>) {
        self.load = None;
        if book == self.book {
            match counts {
                Ok(c) => self.counts = Some(c),
                Err(error) => log::warn!("word counts of {book}: {error}"),
            }
            match days {
                Ok(d) => self.days = Some(d),
                Err(error) => log::warn!("writing days of {book}: {error}"),
            }
            match detail {
                Some((key, Ok(Some(d)))) => self.detail = Some((key, d)),
                Some((_, Ok(None))) | None => self.detail = None,
                Some((key, Err(error))) => log::warn!("stats of {key}: {error}"),
            }
            cx.notify();
        }
        if std::mem::take(&mut self.again) {
            self.reload(cx);
        }
    }
}

/// What a scope's count is called.
fn scope_label(scope: Scope) -> Key {
    use keys::workspace_word_tally as tally;
    match scope {
        Scope::Selection => tally::SELECTION,
        Scope::Chapter => tally::CHAPTER,
        Scope::Idea => tally::DRIFT,
        Scope::Storyline => tally::STORYLINE,
        Scope::Book => tally::BOOK,
    }
}

impl Render for StatsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let i18n = self
            .i18n
            .get_or_insert_with(|| Rc::new(I18n::new(Locale::default(), Platform::current())))
            .clone();
        let ui = Ui {
            theme,
            i18n: &i18n,
            id: self.id.clone(),
        };
        let n = |v: i64| ui.n(v);
        let words = |v: Option<u64>| -> SharedString {
            match v {
                Some(v) => ui.words(v),
                None => ui.t(keys::workspace_word_tally::COUNTING),
            }
        };
        let live = LiveWords::read(cx).clone();
        let counts = self.counts.as_ref();
        let reading = model::reading(self.target.as_ref(), counts, &live);
        let book_words = counts.and_then(|c| model::book_words(c, &live));

        // 1. The reading.
        let mut first = ui.section(None).child(
            div()
                .flex()
                .flex_col()
                .child(ui.small(ui.t(scope_label(reading.scope))))
                .child(
                    div()
                        .font_role(dr_ui::fonts::Role::Ui)
                        .type_px(s.heading, s.heading * 1.3)
                        .text_color(p.ink(1).solid())
                        .child(words(reading.words)),
                ),
        );
        if reading.scope != Scope::Book {
            first = first.child(ui.row(ui.t(keys::workspace_word_tally::BOOK), words(book_words)));
        }
        if let Some(days) = &self.days {
            let today = model::today_words(days, self.mine);
            first = first.child(ui.row(
                ui.t(keys::workspace_word_tally::TODAY),
                ui.fmt(stats::WORDS_VALUE, &[("count", &format!("+{}", n(today)))]),
            ));
            if let Some(f) = model::progress(today.max(0) as u64, days.daily_word_target) {
                first = first.child(ui.stroke("today", f, None)).child(ui.row(
                    ui.t(keys::dashboard::today::GOAL),
                    n(days.daily_word_target.unwrap_or(0)),
                ));
            }
        }

        // 2 and 4: the page's own readings.
        let sections = self.detail_sections(&ui, &live, window, cx);
        let counts = self.counts.as_ref();

        // 3. Writing progress.
        let mut second = ui.section(Some(ui.t(stats::WRITING_PROGRESS)));
        if let Some(progress) = sections.progress {
            second = second.child(progress);
        }
        if let Some(c) = counts {
            let (chapters, total) = match &self.target {
                Some(NavTarget::Storyline(sl)) => c
                    .storylines
                    .iter()
                    .find(|x| x.id == sl.as_str())
                    .map(|x| {
                        (
                            x.chapters as u64,
                            model::storyline_words(c, sl.as_str(), &live),
                        )
                    })
                    .unwrap_or((0, Some(0))),
                _ => (c.chapters.len() as u64, book_words),
            };
            // The book's target (a storyline shows its own chapters only).
            let storyline = matches!(self.target, Some(NavTarget::Storyline(_)));
            if let Some(target) = c.word_target.filter(|t| *t > 0 && !storyline) {
                let written = book_words.unwrap_or(0);
                second = second
                    .child(ui.row(
                        ui.t(stats::WRITTEN_TARGET),
                        format!("{} / {}", n(written as i64), n(target)),
                    ))
                    .child(ui.stroke(
                        "book",
                        model::progress(written, Some(target)).unwrap_or(0.0),
                        None,
                    ));
            }
            second = second.child(ui.row(
                ui.t(stats::CHAPTER_COUNT),
                ui.fmt(stats::CHAPTERS_VALUE, &[("count", &n(chapters as i64))]),
            ));
            if chapters > 0
                && let Some(total) = total
            {
                second = second.child(ui.row(
                    ui.t(stats::AVERAGE_PER_CHAPTER),
                    ui.fmt(
                        stats::WORDS_PER_CHAPTER_VALUE,
                        &[("words", &n((total / chapters) as i64))],
                    ),
                ));
            }
        }

        // 5. Recent days.
        let mut third = ui.section(Some(ui.t(stats::RECENT)));
        if let Some(days) = &self.days {
            let today = model::today_words(days, self.mine);
            let week = days.week - days.today + today;
            // Today's words may not be stored yet.
            let streak = if today > 0 { days.streak_before + 1 } else { 0 };
            third = third
                .child(ui.row(
                    ui.t(keys::dashboard::today::WEEK),
                    ui.fmt(stats::WORDS_VALUE, &[("count", &n(week))]),
                ))
                .child(ui.row(
                    ui.t(keys::dashboard::today::STREAK),
                    format!("{streak} {}", i18n.t(keys::project_picker::heat::DAYS_UNIT)),
                ));
            let last = days.days.len().saturating_sub(1);
            let list: Vec<(String, i64)> = days
                .days
                .iter()
                .enumerate()
                .map(|(i, d)| (d.day.clone(), if i == last { today } else { d.words }))
                .collect();
            let most = list
                .iter()
                .map(|(_, w)| *w)
                .chain(days.daily_word_target)
                .max()
                .unwrap_or(1)
                .max(1);
            let mut strip = div().flex().flex_col().gap(px(4.0)).pt(px(4.0));
            for (i, (day, w)) in list.iter().enumerate().rev() {
                let label = if i == last {
                    i18n.t(keys::project_picker::heat::TODAY).to_owned()
                } else {
                    day.get(5..).unwrap_or(day).to_owned()
                };
                strip = strip.child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(10.0))
                        .child(ui.small(label).flex_none().w(px(44.0)))
                        .child(div().flex_1().min_w_0().child(ui.stroke(
                            &format!("day-{day}"),
                            *w as f32 / most as f32,
                            None,
                        )))
                        .child(
                            ui.small(n(*w))
                                .flex_none()
                                .w(px(56.0))
                                .flex()
                                .justify_end()
                                .text_color(if *w > 0 { p.ink(2) } else { p.muted() }.solid()),
                        ),
                );
            }
            third = third.child(strip);
        }

        use dr_ui::style::DrStyled as _;
        div()
            .id(ElementId::Name(self.id.clone()))
            .size_full()
            .overflow_y_scroll()
            .px(px(16.0))
            .pt(px(10.0))
            .pb(px(24.0))
            .flex()
            .flex_col()
            .gap(px(22.0))
            .child(first)
            .children(sections.after_reading)
            .child(second)
            .children(sections.after_progress)
            .child(third)
            .children(sections.history.map(|h| div().flex().child(h)))
    }
}
