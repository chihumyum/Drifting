//! The Stats tab's readings of the page in front (M20; components.md
//! 「统计面板」): flat type and space, sand readouts, and rows that open what
//! they name with the sidebar cell's ring. Laid out as the 0.1 client's
//! `features/stats` panels.

use dr_i18n::{Arg, I18n, Key, keys};
use dr_ui::components::SandCell;
use dr_ui::sand::{self, KindMark, Readout};
use dr_ui::style::DrStyled;
use dr_ui::tokens::Rgb;
use dr_ui::{Theme, fonts::Role};
use dr_workspace::NavTarget;
use dr_workspace::commands::stats::WordCountsOut;
use gpui::{
    AnyElement, Context, Div, ElementId, InteractiveElement, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder as _, px,
    relative,
};

use crate::clock;
use crate::detail::{
    BookDetail, CORE_ELEMENTS, CategoryDetail, Detail, ElementDetail, MaterialDetail, PageDetail,
    Row, Statuses, StorylineDetail, UNAPPEARED,
};
use crate::model::{self, Live};
use crate::panel::StatsView;
use crate::{Hooks, StatsAction};

use keys::right_sidebar::stats;

/// How a stroke holds its sand (materials.css `.sand-stroke--dry`,
/// `--loose`): finished is a loaded stroke, a draft a dry one, what is
/// still to write loose grains.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Density {
    Loaded,
    Dry,
    Loose,
}

/// One part of a whole, side by side with the others.
pub(crate) struct Segment {
    pub key: String,
    /// 0–1 of the bar.
    pub share: f32,
    pub color: Rgb,
    pub density: Density,
}

/// The type and space of the tab, with its strings.
pub(crate) struct Ui<'a> {
    pub theme: Theme,
    pub i18n: &'a I18n,
    pub id: SharedString,
}

impl Ui<'_> {
    pub fn id(&self, name: &str) -> ElementId {
        ElementId::Name(format!("{}-{name}", self.id).into())
    }

    pub fn t(&self, key: Key) -> SharedString {
        self.i18n.t(key).into()
    }

    pub fn fmt(&self, key: Key, args: &[Arg<'_>]) -> SharedString {
        self.i18n.fmt(key, args).into()
    }

    pub fn n(&self, v: i64) -> String {
        model::grouped(v, self.i18n.locale())
    }

    pub fn words(&self, v: u64) -> SharedString {
        self.fmt(stats::WORDS_VALUE, &[("count", &self.n(v as i64))])
    }

    /// Small index type in the muted ink: a row's key, a caption.
    pub fn small(&self, text: impl Into<SharedString>) -> Div {
        let s = self.theme.scale;
        div()
            .font_role(Role::Index)
            .type_px(s.caption, s.line_caption)
            .text_color(self.theme.palette.muted().solid())
            .child(text.into())
    }

    /// A row of a section: its key, and its value at the end.
    pub fn row(&self, key: impl Into<SharedString>, value: impl IntoElement) -> Div {
        let s = self.theme.scale;
        div()
            .flex()
            .flex_row()
            .items_baseline()
            .justify_between()
            .gap(px(12.0))
            .child(self.small(key).flex_none())
            .child(
                div()
                    .min_w_0()
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(self.theme.palette.ink(1).solid())
                    .child(value),
            )
    }

    /// A key and a value in the coordinates' two columns (`.stats-meta`).
    pub fn meta(&self, key: impl Into<SharedString>, value: impl IntoElement) -> Div {
        let s = self.theme.scale;
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.0))
            .child(self.small(key).flex_none().w(px(78.0)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(self.theme.palette.ink(1).solid())
                    .child(value),
            )
    }

    /// A value with the mark of its kind before it.
    pub fn marked(
        &self,
        name: &str,
        mark: sand::Kind,
        color: Option<Rgb>,
        text: SharedString,
    ) -> Div {
        let m = KindMark::new(self.id(name), mark);
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .child(match color {
                Some(c) => m.color(c),
                None => m,
            })
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .child(text),
            )
    }

    /// A section: its title, then its rows (sections are told apart by
    /// space alone).
    pub fn section(&self, title: Option<SharedString>) -> Div {
        let s = self.theme.scale;
        let mut el = div().flex().flex_col().gap(px(6.0));
        if let Some(title) = title {
            el = el.child(
                div()
                    .font_role(Role::Structure)
                    .type_px(s.secondary, s.line_body)
                    .text_color(self.theme.palette.ink(2).solid())
                    .pb(px(2.0))
                    .child(title),
            );
        }
        el
    }

    /// A note when there is nothing to count.
    pub fn note(&self, text: SharedString) -> Div {
        let s = self.theme.scale;
        div()
            .py(px(2.0))
            .font_role(Role::Ui)
            .type_px(s.secondary, s.line_body)
            .text_color(self.theme.palette.muted().solid())
            .child(text)
    }

    /// A value read against its whole.
    pub fn stroke(&self, name: &str, value: f32, color: Option<Rgb>) -> Readout {
        Readout::new(self.id(name), value).color(color.unwrap_or(self.theme.palette.ink(2)))
    }

    /// Parts of a whole side by side (`.stats-strokes`).
    pub fn strokes(&self, name: &str, segments: &[Segment]) -> Div {
        let mut bar = div().w_full().flex().flex_row().gap(px(3.0));
        for seg in segments {
            let id = self.id(&format!("{name}-{}", seg.key));
            let stroke: AnyElement = match seg.density {
                Density::Loaded => Readout::new(id, 1.0)
                    .bare()
                    .color(seg.color)
                    .into_any_element(),
                Density::Dry => div()
                    .opacity(0.5)
                    .child(Readout::new(id, 1.0).bare().color(seg.color))
                    .into_any_element(),
                Density::Loose => Readout::new(id, 0.0).into_any_element(),
            };
            bar = bar.child(
                div()
                    .w(relative(seg.share.clamp(0.0, 1.0)))
                    .min_w(px(3.0))
                    .flex_shrink(1.0)
                    .child(stroke),
            );
        }
        bar
    }

    /// A row that opens what it names: the sidebar cell, its mark in the
    /// thing's colour and a reading at the end.
    pub fn link(
        &self,
        hooks: Option<&Hooks>,
        name: &str,
        row: &Row,
        meta: Option<SharedString>,
    ) -> SandCell {
        let (mark, color) = hooks.map_or((sand::Kind::Element, None), |h| (h.marks)(&row.target));
        self.link_to(
            hooks,
            name,
            row.target.clone(),
            None,
            &row.name,
            mark,
            color,
            meta,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn link_to(
        &self,
        hooks: Option<&Hooks>,
        name: &str,
        target: NavTarget,
        link: Option<String>,
        label: &str,
        mark: sand::Kind,
        color: Option<Rgb>,
        meta: Option<SharedString>,
    ) -> SandCell {
        let label = if label.trim().is_empty() {
            self.i18n.t(keys::common::UNTITLED).to_owned()
        } else {
            label.to_owned()
        };
        let mut cell = SandCell::new(self.id(name), label)
            .mark(mark)
            .color_opt(color);
        if let Some(meta) = meta {
            cell = cell.child(self.small(meta).flex_none());
        }
        match hooks.map(|h| h.act.clone()) {
            Some(act) => cell.on_click(move |_, window, cx| {
                act(
                    StatsAction::Open {
                        target: target.clone(),
                        link: link.clone(),
                    },
                    window,
                    cx,
                )
            }),
            None => cell.disabled(true),
        }
    }
}

/// `MM/DD hh:mm`, with the year when it is not this one (0.1's
/// `formatDateTime`).
pub(crate) fn date_time(secs: i64) -> String {
    let at = clock::local(secs);
    let now = clock::local(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64),
    );
    let md = format!(
        "{:02}/{:02} {:02}:{:02}",
        at.month, at.day, at.hour, at.minute
    );
    if at.year == now.year {
        md
    } else {
        format!("{}/{md}", at.year)
    }
}

/// `512 B`, `1.5 KB`, `3.2 MB`.
pub(crate) fn bytes(n: i64) -> String {
    let n = n.max(0) as f64;
    if n < 1024.0 {
        format!("{n} B")
    } else if n < 1024.0 * 1024.0 {
        format!("{:.1} KB", n / 1024.0)
    } else {
        format!("{:.1} MB", n / (1024.0 * 1024.0))
    }
}

/// `#rrggbb` as a colour.
pub(crate) fn color_of(hex: &str) -> Option<Rgb> {
    let digits = hex.trim().strip_prefix('#')?;
    if digits.len() != 6 {
        return None;
    }
    u32::from_str_radix(digits, 16).ok().map(Rgb::hex)
}

/// An act's colour: its own, or one of the six storyline colours by its
/// place in the book.
pub(crate) fn act_color(theme: &Theme, color: Option<&str>, i: usize) -> Rgb {
    color
        .and_then(color_of)
        .unwrap_or(theme.palette.story[i % theme.palette.story.len()])
}

/// The words of one chapter now (the editor's own count when it is open).
fn chapter_words(counts: Option<&WordCountsOut>, live: &Live, id: &str) -> u64 {
    let Some(c) = counts.and_then(|c| c.chapters.iter().find(|c| c.id == id)) else {
        return 0;
    };
    live.docs.get(&c.doc).map_or(c.count.words, |m| m.words)
}

/// The writing statuses' strokes and caption (completion in ink, a
/// storyline's progress in its colour), `None` when every chapter is
/// discarded.
fn status_strokes(
    ui: &Ui<'_>,
    name: &str,
    s: &Statuses,
    color: Rgb,
    storyline: bool,
) -> Option<Div> {
    let active = s.active();
    if active == 0 {
        return None;
    }
    use keys::editor_top_bar::status as written;
    use keys::right_sidebar::status;
    let parts: Vec<(Key, u32, Density)> = if storyline {
        vec![
            (written::FINISHED, s.done, Density::Loaded),
            (written::DRAFT, s.draft + s.todo, Density::Dry),
        ]
    } else {
        vec![
            (status::DONE, s.done, Density::Loaded),
            (status::DRAFT, s.draft, Density::Dry),
            (status::TODO, s.todo, Density::Loose),
        ]
    };
    let segments: Vec<Segment> = parts
        .iter()
        .filter(|(_, n, _)| *n > 0)
        .map(|(k, n, d)| Segment {
            key: k.name().to_owned(),
            share: *n as f32 / active as f32,
            color,
            density: *d,
        })
        .collect();
    let mut caption: String = parts
        .iter()
        .filter(|(_, n, _)| *n > 0)
        .map(|(k, n, _)| {
            ui.i18n.fmt(
                stats::STATUS_COUNT,
                &[("status", &ui.i18n.t(*k)), ("count", n)],
            )
        })
        .collect::<Vec<_>>()
        .join(" · ");
    if s.discarded > 0 {
        caption.push_str(
            &ui.i18n
                .fmt(stats::DISCARDED_PAREN, &[("count", &s.discarded)]),
        );
    }
    Some(
        div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .child(ui.strokes(name, &segments))
            .child(ui.small(caption)),
    )
}

impl StatsView {
    /// The sections of the page in front, for the tab's own order: those
    /// that come right after the reading, those that come after writing
    /// progress, and what the writing progress adds for a storyline.
    pub(crate) fn detail_sections(
        &self,
        ui: &Ui<'_>,
        live: &Live,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Sections {
        let mut out = Sections::default();
        let Some(loaded) = self.detail() else {
            return out;
        };
        let hooks = self.hooks.as_ref();
        let counts = self.counts.as_ref();
        match &loaded.detail {
            Detail::Page(d) => {
                let idea = matches!(self.target, Some(NavTarget::Idea(_)));
                out.after_reading.extend(page(ui, hooks, d, idea));
            }
            Detail::Storyline(d) => {
                let color = self
                    .target
                    .as_ref()
                    .and_then(|t| hooks.and_then(|h| (h.marks)(t).1));
                out.after_reading
                    .push(storyline_coordinates(ui, &loaded.name, d, color));
                out.progress = Some(storyline_progress(ui, d, color));
                out.after_reading.push(core_elements(ui, hooks, d));
            }
            Detail::Element(d) => out
                .after_reading
                .extend(element(ui, hooks, &loaded.name, d)),
            Detail::Category(d) => {
                let color = self
                    .target
                    .as_ref()
                    .and_then(|t| hooks.and_then(|h| (h.marks)(t).1));
                out.after_reading
                    .extend(category(ui, hooks, &loaded.name, d, color));
            }
            Detail::Material(d) => out.after_reading.extend(material(ui, hooks, d)),
            Detail::Book(d) => {
                out.after_progress
                    .extend(self.book(ui, hooks, d, counts, live, window, cx));
            }
        }
        if let (Some(doc), Some(h)) = (&loaded.doc, hooks) {
            let act = h.act.clone();
            let (doc, name) = (doc.clone(), loaded.name.clone());
            out.history = Some(
                dr_ui::components::Button::new(ui.id("history"), ui.t(stats::SNAPSHOT_BUTTON))
                    .small()
                    .icon(sand::Icon::Rotate)
                    .on_click(move |_, window, cx| {
                        act(
                            StatsAction::History {
                                doc: doc.clone(),
                                name: name.clone(),
                            },
                            window,
                            cx,
                        )
                    })
                    .into_any_element(),
            );
        }
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn book(
        &self,
        ui: &Ui<'_>,
        hooks: Option<&Hooks>,
        d: &BookDetail,
        counts: Option<&WordCountsOut>,
        live: &Live,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let mut out = Vec::new();
        if d.chapters.is_empty() {
            out.push(ui.note(ui.t(stats::NO_CHAPTERS)).into_any_element());
            return out;
        }
        let words: Vec<u64> = d
            .chapters
            .iter()
            .map(|(id, _)| chapter_words(counts, live, id))
            .collect();
        let total: u64 = words.iter().sum();
        // Every chapter's act, for the rhythm's colours.
        let mut act_of: Vec<Option<usize>> = vec![None; d.chapters.len()];
        let place: std::collections::HashMap<&str, usize> = d
            .chapters
            .iter()
            .enumerate()
            .map(|(i, (id, _))| (id.as_str(), i))
            .collect();
        for (a, act) in d.acts.iter().enumerate() {
            for c in &act.chapters {
                if let Some(i) = place.get(c.as_str()) {
                    act_of[*i] = Some(a);
                }
            }
        }
        let theme = ui.theme;
        let p = theme.palette;

        // Acts: their share of the book.
        if !d.acts.is_empty() {
            let rows: Vec<(usize, u64, usize)> = d
                .acts
                .iter()
                .enumerate()
                .map(|(a, act)| {
                    let w: u64 = act
                        .chapters
                        .iter()
                        .filter_map(|c| place.get(c.as_str()))
                        .map(|i| words[*i])
                        .sum();
                    let n = act
                        .chapters
                        .iter()
                        .filter(|c| place.contains_key(c.as_str()))
                        .count();
                    (a, w, n)
                })
                .collect();
            let segments: Vec<Segment> = rows
                .iter()
                .filter(|(_, w, _)| *w > 0 && total > 0)
                .map(|(a, w, _)| Segment {
                    key: d.acts[*a].id.clone(),
                    share: *w as f32 / total as f32,
                    color: act_color(&theme, d.acts[*a].color.as_deref(), *a),
                    density: Density::Loaded,
                })
                .collect();
            let mut list = div().flex().flex_col();
            for (a, w, n) in &rows {
                let act = &d.acts[*a];
                let pct = if total > 0 {
                    *w as f64 * 100.0 / total as f64
                } else {
                    0.0
                };
                let meta = ui.fmt(
                    stats::ACT_META,
                    &[
                        ("chapters", n),
                        ("wordsK", &format!("{:.1}", *w as f64 / 1000.0)),
                        ("pct", &(pct.round() as i64)),
                    ],
                );
                // An act opens at its first chapter, in the whole book.
                let first = act.chapters.iter().find(|c| place.contains_key(c.as_str()));
                let target = first
                    .and_then(|c| c.parse().ok())
                    .map_or(NavTarget::Book, NavTarget::Chapter);
                let link = first.map(|c| format!("drifting:chapters/id-{c}/prose.md"));
                list = list.child(ui.link_to(
                    hooks,
                    &format!("act-{}", act.id),
                    target,
                    link,
                    &act.name,
                    sand::Kind::Chapter(seal_of(&act.id)),
                    Some(act_color(&theme, act.color.as_deref(), *a)),
                    Some(meta),
                ));
            }
            out.push(
                ui.section(Some(ui.t(stats::ACT_RHYTHM)))
                    .child(div().pb(px(4.0)).child(ui.strokes("acts", &segments)))
                    .child(list)
                    .into_any_element(),
            );
        }

        // Completion.
        let mut completion = ui.section(Some(ui.t(stats::COMPLETION)));
        match status_strokes(ui, "status", &d.statuses, p.ink(2), false) {
            Some(bar) => {
                let done = (d.statuses.done as f64 * 100.0 / d.chapters.len() as f64).round();
                completion = completion
                    .child(bar)
                    .child(ui.row(ui.t(keys::right_sidebar::status::DONE), format!("{done}%")));
            }
            None => completion = completion.child(ui.note(ui.t(stats::NO_ACTIVE_PROGRESS))),
        }
        out.push(completion.into_any_element());

        // Chapter lengths: one short stroke each, scaled to the longest.
        let most = words.iter().copied().max().unwrap_or(0);
        let hover = self.hover.filter(|i| *i < d.chapters.len());
        let mut strokes = div()
            .id(ui.id("rhythm"))
            .flex()
            .flex_col()
            .py(px(2.0))
            .on_hover(cx.listener(|v, over: &bool, _, cx| {
                if !*over && v.hover.take().is_some() {
                    cx.notify();
                }
            }));
        for (i, (id, _)) in d.chapters.iter().enumerate() {
            let share = if most > 0 {
                (words[i] as f32 / most as f32).max(0.02)
            } else {
                0.02
            };
            let color = act_of[i]
                .map(|a| act_color(&theme, d.acts[a].color.as_deref(), a))
                .unwrap_or(p.ink(4));
            let act = hooks.map(|h| h.act.clone());
            let (target, link) = (
                id.parse().ok().map(NavTarget::Chapter),
                format!("drifting:chapters/id-{id}/prose.md"),
            );
            strokes = strokes.child(
                div()
                    .id(ui.id(&format!("rhythm-{id}")))
                    .w_full()
                    .py(px(1.5))
                    .cursor_pointer()
                    .opacity(match hover {
                        None => 0.85,
                        Some(h) if h == i => 1.0,
                        Some(_) => 0.3,
                    })
                    .on_hover(cx.listener(move |v, over: &bool, _, cx| {
                        if *over && v.hover != Some(i) {
                            v.hover = Some(i);
                            cx.notify();
                        }
                    }))
                    .when_some(act.zip(target), |el, (act, target)| {
                        el.on_click(move |_, window, cx| {
                            act(
                                StatsAction::Open {
                                    target: target.clone(),
                                    link: Some(link.clone()),
                                },
                                window,
                                cx,
                            )
                        })
                    })
                    .child(
                        div().w(relative(share)).min_w(px(3.0)).child(
                            Readout::new(ui.id(&format!("len-{id}")), 1.0)
                                .bare()
                                .height(4.0)
                                .color(color),
                        ),
                    ),
            );
        }
        let untitled = ui.i18n.t(keys::common::UNTITLED);
        let title = |i: usize| {
            let t = d.chapters[i].1.trim();
            if t.is_empty() {
                untitled.to_owned()
            } else {
                t.to_owned()
            }
        };
        let mut readout = div()
            .flex()
            .flex_col()
            .min_h(px(2.0 * theme.scale.line_caption))
            .mt(px(8.0));
        match hover {
            Some(i) => {
                readout = readout.child(
                    ui.small(ui.fmt(
                        stats::TITLE_WITH_WORDS,
                        &[("title", &title(i)), ("words", &ui.n(words[i] as i64))],
                    ))
                    .text_color(p.ink(1).solid()),
                );
            }
            None => {
                let longest =
                    (0..words.len()).max_by(|a, b| words[*a].cmp(&words[*b]).then(b.cmp(a)));
                let shortest =
                    (0..words.len()).min_by(|a, b| words[*a].cmp(&words[*b]).then(a.cmp(b)));
                if let Some(l) = longest {
                    readout = readout.child(ui.small(ui.fmt(
                        stats::LONGEST_WITH_WORDS,
                        &[("title", &title(l)), ("words", &ui.n(words[l] as i64))],
                    )));
                    if let Some(s) = shortest.filter(|s| *s != l) {
                        readout = readout.child(ui.small(ui.fmt(
                            stats::SHORTEST_WITH_WORDS,
                            &[("title", &title(s)), ("words", &ui.n(words[s] as i64))],
                        )));
                    }
                }
            }
        }
        out.push(
            ui.section(Some(ui.t(stats::CHAPTER_LENGTH_RHYTHM)))
                .child(strokes)
                .child(readout)
                .into_any_element(),
        );
        out
    }
}

/// What [`StatsView::detail_sections`] gives the tab.
#[derive(Default)]
pub(crate) struct Sections {
    pub after_reading: Vec<AnyElement>,
    /// A storyline's writing progress (its statuses), in place of the
    /// book's.
    pub progress: Option<AnyElement>,
    pub after_progress: Vec<AnyElement>,
    pub history: Option<AnyElement>,
}

/// The round seal of a chapter's (or act's) id, as the shell picks it.
fn seal_of(id: &str) -> u8 {
    let mut hash: i32 = 0;
    for unit in id.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    ((hash as i64).abs() % 6) as u8
}

fn page(ui: &Ui<'_>, hooks: Option<&Hooks>, d: &PageDetail, idea: bool) -> Vec<AnyElement> {
    let mut coords = ui.section(Some(ui.t(if idea {
        stats::DRIFT_COORDINATES
    } else {
        stats::CHAPTER_COORDINATES
    })));
    match &d.storyline {
        Some((target, name)) => {
            let color = hooks.and_then(|h| (h.marks)(target).1);
            coords = coords.child(ui.meta(
                ui.t(stats::STORYLINE),
                ui.marked(
                    "storyline",
                    sand::Kind::Storyline,
                    color,
                    name.clone().into(),
                ),
            ));
        }
        None => {
            coords = coords.child(ui.meta(
                ui.t(stats::TYPE),
                ui.t(if idea {
                    stats::DRIFT_FREE_FRAGMENT
                } else {
                    stats::CHAPTER
                }),
            ));
        }
    }
    if let Some(n) = d.number.filter(|_| !idea) {
        coords = coords.child(ui.meta(
            ui.t(stats::BOOK_POSITION),
            ui.fmt(stats::CHAPTER_ORDINAL, &[("count", &n)]),
        ));
    }
    if let Some(at) = d.updated_at {
        coords = coords.child(ui.meta(ui.t(stats::LAST_MODIFIED), date_time(at)));
    }
    let pct = (d.shape.dialogue as f64 * 100.0).round();
    let rhythm = ui
        .section(Some(ui.t(stats::WORD_RHYTHM)))
        .child(ui.row(
            ui.t(stats::PARAGRAPH_SENTENCE),
            ui.fmt(
                stats::PARAGRAPH_SENTENCE_VALUE,
                &[
                    ("paragraphs", &d.shape.paragraphs),
                    ("sentences", &d.shape.sentences),
                ],
            ),
        ))
        .child(ui.row(ui.t(stats::DIALOGUE_RATIO), format!("{pct}%")))
        .child(ui.stroke("dialogue", d.shape.dialogue, None));
    let mut elements = ui.section(Some(ui.t(if idea {
        stats::THIS_FRAGMENT_ELEMENTS
    } else {
        stats::THIS_CHAPTER_ELEMENTS
    })));
    if d.elements.is_empty() {
        elements = elements.child(ui.note(ui.t(stats::NO_MENTIONED_ELEMENTS)));
    } else {
        let mut list = div().flex().flex_col();
        for r in &d.elements {
            list = list.child(ui.link(
                hooks,
                &format!("el-{}", r.target.key()),
                r,
                Some(format!("×{}", r.count).into()),
            ));
        }
        elements = elements.child(list);
    }
    vec![
        coords.into_any_element(),
        rhythm.into_any_element(),
        elements.into_any_element(),
    ]
}

fn storyline_coordinates(
    ui: &Ui<'_>,
    name: &str,
    d: &StorylineDetail,
    color: Option<Rgb>,
) -> AnyElement {
    let mut coords = ui
        .section(Some(ui.t(stats::STORYLINE_COORDINATES)))
        .child(ui.meta(
            ui.t(stats::STORYLINE),
            ui.marked(
                "storyline",
                sand::Kind::Storyline,
                color,
                name.to_owned().into(),
            ),
        ));
    if let Some(at) = d.updated_at {
        coords = coords.child(ui.meta(ui.t(stats::RECENT), date_time(at)));
    }
    coords.into_any_element()
}

/// A storyline's writing progress: its chapters by status.
fn storyline_progress(ui: &Ui<'_>, d: &StorylineDetail, color: Option<Rgb>) -> AnyElement {
    let s = Statuses {
        done: d.finished,
        draft: d.draft,
        todo: 0,
        discarded: d.discarded,
    };
    let c = color.unwrap_or(ui.theme.palette.ink(2));
    match status_strokes(ui, "storyline-status", &s, c, true) {
        Some(bar) => bar.into_any_element(),
        None => ui
            .note(ui.t(stats::STORYLINE_NO_CHAPTERS))
            .into_any_element(),
    }
}

fn core_elements(ui: &Ui<'_>, hooks: Option<&Hooks>, d: &StorylineDetail) -> AnyElement {
    let mut sec = ui.section(Some(ui.t(stats::STORYLINE_CORE_ELEMENTS)));
    if d.core.is_empty() {
        return sec
            .child(ui.note(ui.t(stats::STORYLINE_NO_MENTIONED_ELEMENTS)))
            .into_any_element();
    }
    let mut list = div().flex().flex_col();
    for r in d.core.iter().take(CORE_ELEMENTS) {
        list = list.child(ui.link(
            hooks,
            &format!("core-{}", r.target.key()),
            r,
            Some(format!("×{}", r.count).into()),
        ));
    }
    sec = sec.child(list);
    if d.core.len() > CORE_ELEMENTS {
        sec = sec.child(ui.small(ui.fmt(
            stats::MORE_LOW_APPEARANCE_ELEMENTS,
            &[("count", &(d.core.len() - CORE_ELEMENTS))],
        )));
    }
    sec.into_any_element()
}

fn element(ui: &Ui<'_>, hooks: Option<&Hooks>, name: &str, d: &ElementDetail) -> Vec<AnyElement> {
    let category = match &d.category {
        Some((target, cname)) => {
            let color = hooks.and_then(|h| (h.marks)(target).1);
            ui.marked(
                "category",
                sand::Kind::Category,
                color,
                cname.clone().into(),
            )
            .into_any_element()
        }
        None => div().child("—").into_any_element(),
    };
    let mut coords = ui
        .section(Some(ui.t(stats::ELEMENT_COORDINATES)))
        .child(ui.meta(ui.t(stats::CATEGORY), category))
        .child(ui.meta(ui.t(stats::NAME), name.to_owned()));
    if let Some(at) = d.updated_at {
        coords = coords.child(ui.meta(ui.t(stats::UPDATED), date_time(at)));
    }
    use keys::references_panel::{empty, meta, sections};
    let titled = |key: Key, n: usize| {
        let s = ui.theme.scale;
        div()
            .flex()
            .flex_row()
            .items_baseline()
            .gap(px(8.0))
            .pb(px(2.0))
            .child(
                div()
                    .font_role(Role::Structure)
                    .type_px(s.secondary, s.line_body)
                    .text_color(ui.theme.palette.ink(2).solid())
                    .child(ui.t(key)),
            )
            .child(ui.small(n.to_string()))
    };
    let mut incoming = div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(titled(sections::INCOMING, d.incoming.len()));
    if d.incoming.is_empty() {
        incoming = incoming.child(ui.note(ui.t(empty::INCOMING)));
    } else {
        let mut list = div().flex().flex_col();
        for r in &d.incoming {
            list = list.child(ui.link(
                hooks,
                &format!("in-{}", r.target.key()),
                r,
                Some(ui.fmt(
                    meta::BLOCKS_SPANS,
                    &[("blocks", &r.blocks), ("spans", &r.count)],
                )),
            ));
        }
        incoming = incoming.child(list);
    }
    let mut outgoing = div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(titled(sections::OUTGOING, d.outgoing.len()));
    if d.outgoing.is_empty() {
        outgoing = outgoing.child(ui.note(ui.t(empty::OUTGOING)));
    } else {
        let mut list = div().flex().flex_col();
        for r in &d.outgoing {
            list = list.child(ui.link(
                hooks,
                &format!("out-{}", r.target.key()),
                r,
                Some(ui.fmt(meta::SPANS, &[("count", &r.count)])),
            ));
        }
        outgoing = outgoing.child(list);
    }
    vec![
        coords.into_any_element(),
        incoming.into_any_element(),
        outgoing.into_any_element(),
    ]
}

fn category(
    ui: &Ui<'_>,
    hooks: Option<&Hooks>,
    name: &str,
    d: &CategoryDetail,
    color: Option<Rgb>,
) -> Vec<AnyElement> {
    let mut out = vec![
        ui.section(Some(ui.t(stats::CATEGORY_COORDINATES)))
            .child(ui.meta(
                ui.t(stats::CATEGORY),
                ui.marked(
                    "category",
                    sand::Kind::Category,
                    color,
                    name.to_owned().into(),
                ),
            ))
            .child(ui.meta(
                ui.t(stats::ELEMENT_COUNT),
                ui.fmt(stats::ELEMENTS_VALUE, &[("count", &d.elements)]),
            ))
            .into_any_element(),
    ];
    let mut health = ui.section(Some(ui.t(stats::HEALTH)));
    if d.elements == 0 {
        out.push(
            health
                .child(ui.note(ui.t(stats::CATEGORY_NO_ELEMENTS)))
                .into_any_element(),
        );
        return out;
    }
    health = health
        .child(ui.row(
            ui.t(stats::APPEARED),
            format!("{} / {}", d.appeared, d.elements),
        ))
        .child(ui.stroke("appeared", d.appeared as f32 / d.elements as f32, color))
        .child(ui.row(
            ui.t(stats::AVERAGE_APPEARANCE),
            if d.appeared > 0 {
                ui.fmt(
                    stats::AVG_CHAPTERS_PER_ELEMENT,
                    &[("count", &format!("{:.1}", d.average))],
                )
            } else {
                "—".into()
            },
        ));
    out.push(health.into_any_element());
    let mut unappeared = ui.section(Some(ui.t(stats::UNAPPEARED_ELEMENTS)));
    if d.unappeared.is_empty() {
        unappeared = unappeared.child(ui.note(ui.t(stats::ALL_ELEMENTS_APPEARED)));
    } else {
        let mut list = div().flex().flex_col();
        for r in d.unappeared.iter().take(UNAPPEARED) {
            list = list.child(ui.link(hooks, &format!("un-{}", r.target.key()), r, None));
        }
        unappeared = unappeared.child(list);
        if d.unappeared.len() > UNAPPEARED {
            unappeared = unappeared.child(ui.small(ui.fmt(
                stats::MORE_UNAPPEARED_ELEMENTS,
                &[("count", &(d.unappeared.len() - UNAPPEARED))],
            )));
        }
    }
    out.push(unappeared.into_any_element());
    if !d.storylines.is_empty() {
        let mut list = div().flex().flex_col();
        for (line, n) in &d.storylines {
            let meta: SharedString = ui.fmt(stats::ELEMENTS_VALUE, &[("count", n)]);
            list = list.child(match line {
                Some((target, lname)) => {
                    let row = Row {
                        target: target.clone(),
                        name: lname.clone(),
                        count: *n,
                        blocks: 0,
                    };
                    ui.link(hooks, &format!("line-{}", target.key()), &row, Some(meta))
                }
                None => SandCell::new(ui.id("line-floating"), ui.t(stats::FLOATING_STORYLINE))
                    .mark(sand::Kind::Storyline)
                    .disabled(true)
                    .child(ui.small(meta).flex_none()),
            });
        }
        out.push(
            ui.section(Some(ui.t(stats::STORYLINE_DISTRIBUTION)))
                .child(list)
                .into_any_element(),
        );
    }
    out
}

fn material(ui: &Ui<'_>, hooks: Option<&Hooks>, d: &MaterialDetail) -> Vec<AnyElement> {
    use keys::memo_material::kind;
    let kind_label = |k: &str| -> SharedString {
        match k {
            "text" => ui.t(kind::TEXT),
            "image" => ui.t(kind::IMAGE),
            "pdf" => ui.t(kind::PDF),
            other => other.to_owned().into(),
        }
    };
    let mut coords = ui
        .section(Some(ui.t(stats::MATERIAL_COORDINATES)))
        .child(ui.meta(ui.t(stats::TYPE), kind_label(&d.kind)));
    if let Some(at) = d.updated_at {
        coords = coords.child(ui.meta(ui.t(stats::UPDATED), date_time(at)));
    }
    let mut out = vec![coords.into_any_element()];
    let comments = ui.row(ui.t(stats::OPEN_COMMENTS), d.open_comments.to_string());
    match (&d.note, &d.file) {
        (Some(note), _) => {
            let mut sec = ui
                .section(Some(ui.t(stats::NOTE_SHAPE)))
                .child(ui.row(ui.t(stats::NOTE_WORDS), ui.words(note.words)))
                .child(ui.row(
                    ui.t(stats::NOTE_TASKS),
                    if note.tasks == 0 {
                        "—".into()
                    } else {
                        ui.fmt(
                            stats::NOTE_TASKS_VALUE,
                            &[("done", &note.done), ("total", &note.tasks)],
                        )
                    },
                ));
            if note.tasks > 0 {
                sec = sec.child(ui.stroke("tasks", note.done as f32 / note.tasks as f32, None));
            }
            out.push(sec.child(comments).into_any_element());
        }
        (None, file) => {
            let mut sec = ui
                .section(Some(ui.t(stats::MATERIAL_FILE)))
                .child(ui.row(
                    ui.t(stats::FILE_TYPE),
                    file.as_ref().map_or("—".to_owned(), |f| f.mime.clone()),
                ))
                .child(ui.row(
                    ui.t(stats::FILE_SIZE),
                    file.as_ref().map_or("—".to_owned(), |f| bytes(f.size)),
                ));
            if let Some((w, h)) = file.as_ref().and_then(|f| f.width.zip(f.height)) {
                sec = sec.child(ui.row(ui.t(stats::DIMENSIONS), format!("{w} × {h}")));
            }
            out.push(sec.child(comments).into_any_element());
        }
    }
    if !d.embeds.is_empty() {
        let mut list = div().flex().flex_col();
        for (i, (r, k)) in d.embeds.iter().enumerate() {
            list = list.child(ui.link(hooks, &format!("embed-{i}"), r, Some(kind_label(k))));
        }
        out.push(
            ui.section(Some(ui.t(stats::EMBEDDED_MATERIALS)))
                .child(list)
                .into_any_element(),
        );
    }
    if !d.related.is_empty() {
        let mut list = div().flex().flex_col();
        for r in &d.related {
            list = list.child(ui.link(hooks, &format!("rel-{}", r.target.key()), r, None));
        }
        out.push(
            ui.section(Some(ui.t(stats::MATERIAL_RELATIONS)))
                .child(list)
                .into_any_element(),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_and_colours_read_as_in_0_1() {
        assert_eq!(bytes(512), "512 B");
        assert_eq!(bytes(1536), "1.5 KB");
        assert_eq!(bytes(3 * 1024 * 1024 + 200 * 1024), "3.2 MB");
        assert_eq!(color_of("#9B6A4F"), Some(Rgb::hex(0x9B6A4F)));
        assert_eq!(color_of("red"), None);
    }

    #[test]
    fn seals_are_one_of_six() {
        assert_eq!(seal_of(""), 0);
        assert!(["a", "act-1", "幕"].iter().all(|id| seal_of(id) < 6));
    }
}
