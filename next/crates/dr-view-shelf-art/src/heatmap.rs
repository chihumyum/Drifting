//! The library's year on the shelf (the 0.1 client's `WritingHeatmap`,
//! docs/writing-days.md): 53 weeks, Monday at the top, one dab of sand for
//! each day written, larger and fuller the more words, a few loose grains
//! for a day without. The levels are the quartiles of the days written.
//! Beside it, the year's words, the days written, the streak and today.
//! While the pointer is on a book's card the map shows that book alone, in
//! its colour, and the numbers are its own. Pointing at a day opens a card
//! with its words, book by book.
//!
//! On a window too narrow for the whole year the map shows its latest
//! weeks (the 0.1 client scrolled it, opening on today).

use std::{rc::Rc, sync::Arc};

use dr_i18n::keys;
use dr_shell::strings::{Strings, t, tf};
use dr_ui::{
    Theme,
    components::{CardBody, overlay},
    fonts::Role,
    glass::{self, GlassState, Held, Kind as GlassKind, Mode, Spec, Tone},
    sand::{self, KindMark},
    style::DrStyled as _,
    tokens::color::Rgb,
};
use gpui::{
    AnyElement, App, Bounds, Corners, ElementId, InteractiveElement as _, IntoElement,
    MouseMoveEvent, ParentElement as _, Pixels, RenderImage, RenderOnce, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, canvas, div, point, px, size,
};

use crate::format;
use crate::heat::{HEAT_STEP, heat_size, paint_heatmap};
use crate::images;
use crate::year::{WritingYear, level, summarize, thresholds};

/// A book the map can show alone.
#[derive(Clone, Debug, PartialEq)]
pub struct HeatmapBook {
    pub id: SharedString,
    pub name: SharedString,
    /// The book's colour.
    pub color: Rgb,
}

#[derive(IntoElement)]
pub struct WritingHeatmap {
    id: ElementId,
    year: Rc<WritingYear>,
    books: Rc<Vec<HeatmapBook>>,
    focus: Option<SharedString>,
    held: Option<usize>,
}

impl WritingHeatmap {
    /// `year` ([`WritingYear::load`]) for `books`; `focus`: the book whose
    /// card the pointer is on.
    pub fn new(
        id: impl Into<ElementId>,
        year: Rc<WritingYear>,
        books: Rc<Vec<HeatmapBook>>,
        focus: Option<SharedString>,
    ) -> WritingHeatmap {
        WritingHeatmap {
            id: id.into(),
            year,
            books,
            focus,
            held: None,
        }
    }

    /// Holds day `index` under the pointer, its card open (captures).
    pub fn hold_day(mut self, index: usize) -> Self {
        self.held = Some(index);
        self
    }
}

/// The map as last painted, and the day under the pointer.
#[derive(Default)]
pub struct HeatState {
    made_for: Option<(usize, Option<SharedString>, u32, [u32; 6])>,
    loose: Option<Arc<RenderImage>>,
    dabs: Option<Arc<RenderImage>>,
    /// The day under the pointer (its index in the year).
    hot: Option<usize>,
    /// Where the cells are in the window.
    cells: Option<Bounds<Pixels>>,
    /// `hot` was held by the caller, not the pointer.
    held: bool,
}

impl HeatState {
    /// The day under the pointer.
    pub fn hot(&self) -> Option<usize> {
        self.hot
    }
}

fn tag(c: Rgb) -> [u32; 3] {
    [c.r, c.g, c.b].map(|v| (v * 1000.0) as u32)
}

/// A seal of sand in `color`, as the numbers and the card mark a book.
fn blob(id: ElementId, color: Rgb) -> impl IntoElement {
    KindMark::new(id, sand::Kind::Chapter(1)).color(color)
}

impl RenderOnce for WritingHeatmap {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let locale = Strings::get(cx).locale();
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| HeatState::default());
        let year = self.year.clone();
        let columns = year.columns();
        let (width, height) = heat_size(columns);
        let focus = self
            .focus
            .as_ref()
            .and_then(|id| self.books.iter().find(|b| &b.id == id))
            .cloned();
        let daily = year.daily(focus.as_ref().map(|b| b.id.as_ref()));
        let levels_of = thresholds(&year.total);
        let summary = summarize(&daily);

        // The months over their first whole week, three weeks apart at least.
        let mut months: Vec<(usize, String)> = Vec::new();
        let mut last: isize = -9;
        for (i, day) in year.days.iter().enumerate() {
            let column = (i / 7) as isize;
            if !day.ends_with("-01") || column - last < 3 || column > columns as isize - 2 {
                continue;
            }
            months.push((column as usize, format::month(day, locale)));
            last = column;
        }
        let muted = p.muted().solid();
        let month_row = div()
            .relative()
            .h(px(18.0))
            .ml(px(22.0))
            .w(px(width))
            .font_role(Role::Index)
            .type_px(11.0, 11.0)
            .text_color(muted)
            .children(months.into_iter().map(|(column, text)| {
                div()
                    .absolute()
                    .top_0()
                    .left(px(column as f32 * HEAT_STEP))
                    .whitespace_nowrap()
                    .child(text)
            }));
        let weekdays = div()
            .flex_none()
            .w(px(16.0))
            .flex()
            .flex_col()
            .font_role(Role::Index)
            .type_px(10.0, 11.0)
            .text_color(muted)
            .children(
                [
                    Some(keys::project_picker::heat::MON),
                    None,
                    Some(keys::project_picker::heat::WED),
                    None,
                    Some(keys::project_picker::heat::FRI),
                    None,
                    None,
                ]
                .into_iter()
                .map(|k| div().h(px(HEAT_STEP)).children(k.map(|k| t(cx, k)))),
            );

        // The sand, painted for this year, book, scale and ink.
        let dab_ink = p.sand_on(focus.as_ref().map_or(p.ink(3), |b| b.color), p.desk);
        let loose_ink = p.sand_on(p.ink(3), p.desk);
        let painter = state.clone();
        let (focus_id, year_ptr) = (
            focus.as_ref().map(|b| b.id.clone()),
            Rc::as_ptr(&year) as usize,
        );
        let levels: Vec<u8> = daily.iter().map(|&w| level(w, levels_of)).collect();
        let pigment = p.pigment;
        let sand = canvas(
            |_, _, _| (),
            move |bounds: Bounds<Pixels>, _, window, cx| {
                let dpr = window.scale_factor().min(2.0);
                let [a, b, c] = tag(dab_ink);
                let [d, e, f] = tag(loose_ink);
                let want = (
                    year_ptr,
                    focus_id.clone(),
                    (dpr * 100.0) as u32,
                    [a, b, c, d, e, f],
                );
                let fresh = painter
                    .read(cx)
                    .made_for
                    .as_ref()
                    .is_none_or(|m| *m != want);
                if fresh {
                    let (dabs, grains) = paint_heatmap(&levels, columns, dpr);
                    let loose = images::tinted(
                        &grains.alpha,
                        grains.width,
                        grains.height,
                        loose_ink,
                        pigment,
                    );
                    let dabs =
                        images::tinted(&dabs.alpha, dabs.width, dabs.height, dab_ink, pigment);
                    let old = painter.update(cx, |s, _| {
                        s.made_for = Some(want);
                        (s.loose.replace(loose), s.dabs.replace(dabs))
                    });
                    for image in [old.0, old.1].into_iter().flatten() {
                        let _ = window.drop_image(image);
                    }
                }
                painter.update(cx, |s, _| s.cells = Some(bounds));
                let st = painter.read(cx);
                for image in [st.loose.clone(), st.dabs.clone()].into_iter().flatten() {
                    let _ = window.paint_image(bounds, bounds, Corners::default(), image, 0, false);
                }
            },
        )
        .size_full();
        state.update(cx, |s, _| match self.held {
            Some(day) => (s.hot, s.held) = (Some(day), true),
            None if s.held => (s.hot, s.held) = (None, false),
            None => {}
        });
        let hot = state.read(cx).hot;
        let ring = hot.map(|i| {
            div()
                .absolute()
                .left(px((i / 7) as f32 * HEAT_STEP - 1.0))
                .top(px((i % 7) as f32 * HEAT_STEP - 1.0))
                .size(px(13.0))
                .rounded(px(3.0))
                .border_1()
                .border_color(p.ink(2).alpha(0.55))
        });
        let (moved, left) = (state.clone(), state.clone());
        let days = year.days.len();
        let cells = div()
            .id(gpui::ElementId::Name(format!("{}-cells", self.id).into()))
            .relative()
            .flex_none()
            .w(px(width))
            .h(px(height))
            .role(gpui::Role::Image)
            .aria_label(tf(
                cx,
                keys::project_picker::heat::SUMMARY,
                &[
                    ("words", &dr_i18n::number::compact(summary.words, locale)),
                    ("days", &summary.days_written),
                ],
            ))
            .debug_selector(|| "heat-cells".into())
            .child(sand)
            .children(ring)
            .on_mouse_move(move |e: &MouseMoveEvent, _, cx| {
                let Some(bounds) = moved.read(cx).cells else {
                    return;
                };
                let local = e.position - bounds.origin;
                let column = ((f32::from(local.x) + 1.5) / HEAT_STEP).floor();
                let row = ((f32::from(local.y) + 1.5) / HEAT_STEP).floor();
                let index = column as isize * 7 + row as isize;
                let hot = (column >= 0.0 && (0.0..7.0).contains(&row) && (index as usize) < days)
                    .then_some(index as usize);
                moved.update(cx, |s, cx| {
                    if s.hot != hot {
                        s.hot = hot;
                        cx.notify();
                    }
                });
            })
            .on_hover(move |on, _, cx| {
                if !*on {
                    left.update(cx, |s, cx| {
                        if s.hot.take().is_some() {
                            cx.notify();
                        }
                    });
                }
            });
        // As wide as the year, narrower only when the window is.
        let map = div()
            .flex_shrink(1.0)
            .max_w_full()
            .min_w_0()
            .overflow_hidden()
            .flex()
            .flex_col()
            .items_end()
            .child(
                div().flex().flex_col().child(month_row).child(
                    div()
                        .flex()
                        .flex_row()
                        .gap(px(6.0))
                        .child(weekdays)
                        .child(cells),
                ),
            );

        // The numbers beside it.
        let words_unit = t(cx, keys::project_picker::desk::WORDS_UNIT);
        let days_unit = t(cx, keys::project_picker::heat::DAYS_UNIT);
        let dt_width = 5.2 * s.secondary;
        let figure = |value: String, unit: SharedString| {
            div()
                .flex()
                .flex_row()
                .items_baseline()
                .whitespace_nowrap()
                .font_role(Role::Index)
                .type_px(s.caption, s.caption)
                .text_color(p.ink(4).solid())
                .child(
                    div()
                        .mr(px(3.0))
                        .type_px(15.0, 15.0)
                        .text_color(p.ink(1).solid())
                        .child(value),
                )
                .child(unit)
        };
        let term = |text: SharedString| {
            div()
                .flex_none()
                .w(px(dt_width))
                .overflow_hidden()
                .font_role(Role::Ui)
                .type_px(s.secondary, s.secondary)
                .text_color(p.muted().solid())
                .child(text)
        };
        let line = |dt: AnyElement, dd: AnyElement| {
            div()
                .flex()
                .flex_row()
                .items_baseline()
                .gap(px(10.0))
                .min_w_0()
                .child(dt)
                .child(dd)
        };
        let first_term = match &focus {
            Some(book) => div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .max_w(px(8.0 * s.secondary))
                .overflow_hidden()
                .font_role(Role::Prose)
                .type_px(s.secondary, s.secondary)
                .text_color(p.ink(1).solid())
                .child(blob(
                    ElementId::Name(format!("{}-focus", self.id).into()),
                    book.color,
                ))
                .child(
                    div()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .child(book.name.clone()),
                )
                .into_any_element(),
            None => term(t(cx, keys::project_picker::heat::YEAR)).into_any_element(),
        };
        let nums = div()
            .flex()
            .flex_col()
            .flex_grow(1.0)
            .flex_shrink(1.0)
            .flex_basis(px(150.0))
            .gap(px(7.0))
            .min_w_0()
            .mb(px(2.0))
            .child(line(
                first_term,
                figure(
                    dr_i18n::number::compact(summary.words, locale),
                    words_unit.clone(),
                )
                .into_any_element(),
            ))
            .child(line(
                term(t(cx, keys::project_picker::heat::DAYS_WRITTEN)).into_any_element(),
                figure(summary.days_written.to_string(), days_unit.clone()).into_any_element(),
            ))
            .child(line(
                term(t(cx, keys::project_picker::heat::STREAK)).into_any_element(),
                figure(summary.streak.to_string(), days_unit).into_any_element(),
            ))
            .child(line(
                term(t(cx, keys::project_picker::heat::TODAY)).into_any_element(),
                figure(
                    dr_i18n::number::grouped(summary.today, locale),
                    words_unit.clone(),
                )
                .into_any_element(),
            ));

        // A day's card.
        let card = hot.zip(state.read(cx).cells).map(|(i, cells)| {
            let at = Bounds {
                origin: cells.origin
                    + point(
                        px((i / 7) as f32 * HEAT_STEP - 1.0),
                        px((i % 7) as f32 * HEAT_STEP - 1.0),
                    ),
                size: size(px(13.0), px(13.0)),
            };
            let title = format::day(&year.days[i], locale);
            let count = format!(
                "{} {words_unit}",
                dr_i18n::number::grouped(daily[i], locale)
            );
            let mut rows: Vec<(HeatmapBook, u64)> = if focus.is_some() {
                Vec::new()
            } else {
                self.books
                    .iter()
                    .filter_map(|b| {
                        let w = year.by_book.get(b.id.as_ref())?.get(i).copied()?;
                        (w > 0).then(|| (b.clone(), w))
                    })
                    .collect()
            };
            rows.sort_by_key(|r| std::cmp::Reverse(r.1));
            let body = CardBody::new(ElementId::Name(format!("{}-day", self.id).into()), title)
                .count(count);
            let body = if rows.is_empty() {
                body
            } else {
                body.section(
                    rows.into_iter()
                        .enumerate()
                        .map(|(k, (book, words))| {
                            div()
                                .px(px(14.0))
                                .py(px(3.0))
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(8.0))
                                .child(blob(
                                    ElementId::Name(format!("{}-day-{k}", self.id).into()),
                                    book.color,
                                ))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .overflow_hidden()
                                        .whitespace_nowrap()
                                        .text_ellipsis()
                                        .child(book.name),
                                )
                                .child(
                                    div()
                                        .font_role(Role::Index)
                                        .text_color(p.ink(1).solid())
                                        .child(dr_i18n::number::grouped(words, locale)),
                                )
                                .into_any_element()
                        })
                        .collect(),
                )
            };
            overlay::float(
                overlay::Place::Rect {
                    rect: at,
                    align: overlay::Align::Center,
                    gap: 6.0,
                },
                overlay::Layer::Popover,
                div().debug_selector(|| "heat-day-card".into()).child(body),
            )
        });

        let rim = glass::held_layer(
            GlassState::held(GlassKind::Rest, Mode::default(), Held::Rest, 0.0),
            Spec::new(Tone::Clear, 2.0),
            theme,
        );
        div()
            .id(self.id.clone())
            .relative()
            .w_full()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_end()
            .gap_x(px(28.0))
            .gap_y(px(14.0))
            .px(px(18.0))
            .pt(px(14.0))
            .pb(px(16.0))
            .rounded(px(2.0))
            .role(gpui::Role::Group)
            .aria_label(t(cx, keys::project_picker::heat::LABEL))
            .child(div().absolute().top_0().left_0().size_full().child(rim))
            .child(map)
            .child(nums)
            .children(card)
    }
}
