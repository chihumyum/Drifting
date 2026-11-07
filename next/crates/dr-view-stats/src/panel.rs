//! The Stats tab (components.md 「统计面板」): flat type, sand readouts.
//!
//! Three groups, told apart by space alone:
//!
//! 1. the most specific count (the selection, the chapter or idea, the
//!    storyline, the book), the book's when that was not it, and today's
//!    words with a stroke toward the daily goal;
//! 2. writing progress: the book against its target, chapters, the average;
//! 3. recent days: this week, the streak, the last seven days.
//!
//! Counts come from the derived index (`book.word_counts`), the editor's own
//! counts swapped in ([`crate::LiveWords`]); writing days from the book
//! (`book.writing_days`) with this device's part from the recorder. Both are
//! read off the main thread and again after the index or the book moves.

use std::time::Duration;

use dr_i18n::{I18n, Key, Locale, Platform, keys};
use dr_ui::{Theme, fonts::Role, sand::Readout, style::DrStyled};
use dr_workspace::commands::BookIn;
use dr_workspace::commands::stats::{self as ops, WordCountsOut, WritingDaysOut};
use dr_workspace::{Actor, NavTarget, Workspace};
use gpui::{
    Context, ElementId, InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Task, Window, div, px,
};

use crate::live::LiveWords;
use crate::model::{self, Scope};

/// How long after a change the counts are read again (a burst of index
/// writes reads once).
pub const RELOAD_DELAY: Duration = Duration::from_millis(300);

/// Days in the recent list.
const RECENT_DAYS: u32 = 7;

pub struct StatsView {
    id: SharedString,
    lib: Option<Workspace>,
    pub(crate) book: String,
    target: Option<NavTarget>,
    pub(crate) counts: Option<WordCountsOut>,
    days: Option<WritingDaysOut>,
    /// This device's words today, from the recorder.
    mine: Option<i64>,
    device: Option<String>,
    i18n: Option<I18n>,
    load: Option<Task<()>>,
    again: bool,
    timer: Option<Task<()>>,
}

type Loaded = (
    dr_workspace::Result<WordCountsOut>,
    dr_workspace::Result<WritingDaysOut>,
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
            mine: None,
            device,
            i18n: None,
            load: None,
            again: false,
            timer: None,
        }
    }

    /// What the tab shows now: the book, the page, the language.
    pub fn show(
        &mut self,
        book: &str,
        target: Option<NavTarget>,
        locale: Locale,
        platform: Platform,
        cx: &mut Context<Self>,
    ) {
        if self
            .i18n
            .as_ref()
            .is_none_or(|i| i.locale() != locale || i.platform() != platform)
        {
            self.i18n = Some(I18n::new(locale, platform));
        }
        self.target = target;
        if self.book != book {
            self.book = book.to_owned();
            self.counts = None;
            self.days = None;
            self.mine = None;
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

    /// Whether a document belongs to the counts shown.
    pub(crate) fn shows_doc(&self, doc: &str) -> bool {
        self.counts
            .as_ref()
            .is_some_and(|c| c.chapters.iter().chain(&c.ideas).any(|d| d.doc == doc))
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
        self.load = Some(cx.spawn(async move |this, cx| {
            let read_book = book.clone();
            let loaded: Loaded = cx
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
                                book: read_book,
                                today: crate::clock::today().to_string(),
                                days: Some(RECENT_DAYS),
                                device,
                            },
                        )
                        .map(|o| o.output);
                    (counts, days)
                })
                .await;
            this.update(cx, |v, cx| v.loaded(&book, loaded, cx)).ok();
        }));
    }

    fn loaded(&mut self, book: &str, (counts, days): Loaded, cx: &mut Context<Self>) {
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
            .get_or_insert_with(|| I18n::new(Locale::default(), Platform::current()));
        let locale = i18n.locale();
        let n = |v: i64| model::grouped(v, locale);
        let words = |v: Option<u64>| -> SharedString {
            match v {
                Some(v) => i18n
                    .fmt(
                        keys::right_sidebar::stats::WORDS_VALUE,
                        &[("count", &n(v as i64))],
                    )
                    .into(),
                None => i18n.t(keys::workspace_word_tally::COUNTING).into(),
            }
        };
        let live = LiveWords::read(cx);
        let counts = self.counts.as_ref();
        let reading = model::reading(self.target.as_ref(), counts, live);
        let book_words = counts.and_then(|c| model::book_words(c, live));
        let id = |name: &str| ElementId::Name(format!("{}-{name}", self.id).into());

        let key_text = |text: SharedString| {
            div()
                .flex_none()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.muted().solid())
                .child(text)
        };
        let value_text = |text: SharedString| {
            div()
                .min_w_0()
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(p.ink(1).solid())
                .child(text)
        };
        let row = |key: SharedString, value: SharedString| {
            div()
                .flex()
                .flex_row()
                .items_baseline()
                .justify_between()
                .gap(px(12.0))
                .child(key_text(key))
                .child(value_text(value))
        };
        let section = |title: Option<SharedString>| {
            let mut el = div().flex().flex_col().gap(px(6.0));
            if let Some(title) = title {
                el = el.child(
                    div()
                        .font_role(Role::Structure)
                        .type_px(s.secondary, s.line_body)
                        .text_color(p.ink(2).solid())
                        .pb(px(2.0))
                        .child(title),
                );
            }
            el
        };

        // 1. The reading.
        let mut first = section(None).child(
            div()
                .flex()
                .flex_col()
                .child(key_text(i18n.t(scope_label(reading.scope)).into()))
                .child(
                    div()
                        .font_role(Role::Ui)
                        .type_px(s.heading, s.heading * 1.3)
                        .text_color(p.ink(1).solid())
                        .child(words(reading.words)),
                ),
        );
        if reading.scope != Scope::Book {
            first = first.child(row(
                i18n.t(keys::workspace_word_tally::BOOK).into(),
                words(book_words),
            ));
        }
        if let Some(days) = &self.days {
            let today = model::today_words(days, self.mine);
            let today_text: SharedString = i18n
                .fmt(
                    keys::right_sidebar::stats::WORDS_VALUE,
                    &[("count", &format!("+{}", n(today)))],
                )
                .into();
            first = first.child(row(
                i18n.t(keys::workspace_word_tally::TODAY).into(),
                today_text,
            ));
            if let Some(f) = model::progress(today.max(0) as u64, days.daily_word_target) {
                first = first
                    .child(Readout::new(id("today"), f).color(p.ink(2)))
                    .child(row(
                        i18n.t(keys::dashboard::today::GOAL).into(),
                        n(days.daily_word_target.unwrap_or(0)).into(),
                    ));
            }
        }

        // 2. Writing progress.
        let mut second = section(Some(
            i18n.t(keys::right_sidebar::stats::WRITING_PROGRESS).into(),
        ));
        if let Some(c) = counts {
            let (chapters, total) = match &self.target {
                Some(NavTarget::Storyline(sl)) => c
                    .storylines
                    .iter()
                    .find(|x| x.id == sl.as_str())
                    .map(|x| {
                        (
                            x.chapters as u64,
                            model::storyline_words(c, sl.as_str(), live),
                        )
                    })
                    .unwrap_or((0, Some(0))),
                _ => (c.chapters.len() as u64, book_words),
            };
            if let Some(NavTarget::Chapter(ch)) = &self.target
                && let Some(i) = c.chapters.iter().position(|x| x.id == ch.as_str())
            {
                second = second.child(row(
                    i18n.t(keys::right_sidebar::stats::BOOK_POSITION).into(),
                    i18n.fmt(
                        keys::right_sidebar::stats::CHAPTER_ORDINAL,
                        &[("count", &(i + 1))],
                    )
                    .into(),
                ));
            }
            if let Some(target) = c.word_target.filter(|t| *t > 0) {
                let written = book_words.unwrap_or(0);
                second = second
                    .child(row(
                        i18n.t(keys::right_sidebar::stats::WRITTEN_TARGET).into(),
                        format!("{} / {}", n(written as i64), n(target)).into(),
                    ))
                    .child(
                        Readout::new(
                            id("book"),
                            model::progress(written, Some(target)).unwrap_or(0.0),
                        )
                        .color(p.ink(2)),
                    );
            }
            second = second.child(row(
                i18n.t(keys::right_sidebar::stats::CHAPTER_COUNT).into(),
                i18n.fmt(
                    keys::right_sidebar::stats::CHAPTERS_VALUE,
                    &[("count", &n(chapters as i64))],
                )
                .into(),
            ));
            if chapters > 0
                && let Some(total) = total
            {
                second = second.child(row(
                    i18n.t(keys::right_sidebar::stats::AVERAGE_PER_CHAPTER)
                        .into(),
                    i18n.fmt(
                        keys::right_sidebar::stats::WORDS_PER_CHAPTER_VALUE,
                        &[("words", &n((total / chapters) as i64))],
                    )
                    .into(),
                ));
            }
        }

        // 3. Recent days.
        let mut third = section(Some(i18n.t(keys::right_sidebar::stats::RECENT).into()));
        if let Some(days) = &self.days {
            let today = model::today_words(days, self.mine);
            let week = days.week - days.today + today;
            // Today's words may not be stored yet.
            let streak = if today > 0 { days.streak_before + 1 } else { 0 };
            third = third
                .child(row(
                    i18n.t(keys::dashboard::today::WEEK).into(),
                    i18n.fmt(
                        keys::right_sidebar::stats::WORDS_VALUE,
                        &[("count", &n(week))],
                    )
                    .into(),
                ))
                .child(row(
                    i18n.t(keys::dashboard::today::STREAK).into(),
                    format!("{streak} {}", i18n.t(keys::project_picker::heat::DAYS_UNIT)).into(),
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
                        .child(key_text(label.into()).w(px(44.0)))
                        .child(
                            div().flex_1().min_w_0().child(
                                Readout::new(id(&format!("day-{day}")), *w as f32 / most as f32)
                                    .color(p.ink(2)),
                            ),
                        )
                        .child(
                            div()
                                .flex_none()
                                .w(px(56.0))
                                .flex()
                                .justify_end()
                                .font_role(Role::Index)
                                .type_px(s.caption, s.line_caption)
                                .text_color(if *w > 0 {
                                    p.ink(2).solid()
                                } else {
                                    p.muted().solid()
                                })
                                .child(n(*w)),
                        ),
                );
            }
            third = third.child(strip);
        }

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
            .child(second)
            .child(third)
    }
}
