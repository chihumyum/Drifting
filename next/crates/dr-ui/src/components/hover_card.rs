//! Hover cards (interaction.md, 「No right-click menus」).
//!
//! Everything a thing can do lives on its hover card, not on a context
//! menu: the pointer rests on the thing for 220ms and its card floats out;
//! leaving the thing gives the pointer 220ms to reach the card. Clicking the
//! thing closes it. When the list holding the thing scrolls, the card
//! closes rather than riding along, and a row that slid under a resting
//! pointer only counts once the list has been still for 180ms and the
//! pointer really moves.
//!
//! Every hover card is one card: 248px, the desk's colour, a 16px corner, a
//! resting line of glass and the floating shadow. One font size; only the
//! title is heavier. What can be pressed sits at the bottom, one row each,
//! in index type with its mark first; danger rows come last, in the danger
//! colour's words only.

use std::{
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    AnyElement, App, Bounds, ElementId, Entity, InteractiveElement, IntoElement, ParentElement,
    Pixels, RenderOnce, SharedString, StatefulInteractiveElement, Styled, Task, Window, canvas,
    div, prelude::FluentBuilder as _, px,
};

use crate::{
    fonts::{Role, weight},
    glass::{self, Ground, Kind, Mode, Spec, Tone},
    sand::{self, KindMark},
    style::DrStyled,
    theme::Theme,
    tokens::{Rgb, menu as m, motion::dwell, radius},
};

use super::{
    button::OnClick,
    menu::{RowIcon, float_shadow, row_icon, slab_edge},
    overlay::{self, Layer, Place},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    /// The pointer is on the thing; the card shows when the delay is up.
    Waiting,
    Open,
    /// The pointer left; the card goes when the grace is up.
    Leaving,
}

pub struct HoverCardState {
    pub phase: Phase,
    over_target: bool,
    over_card: bool,
    /// Where the thing was when its card opened.
    anchor: Option<Bounds<Pixels>>,
    target: Option<Bounds<Pixels>>,
    scrolled_at: Option<Instant>,
    task: Option<Task<()>>,
}

impl HoverCardState {
    fn new() -> HoverCardState {
        HoverCardState {
            phase: Phase::Idle,
            over_target: false,
            over_card: false,
            anchor: None,
            target: None,
            scrolled_at: None,
            task: None,
        }
    }

    /// Opens at once (keyboard, tests, the gallery's capture).
    pub fn open_now(&mut self) {
        self.phase = Phase::Open;
        self.anchor = self.target;
        self.task = None;
    }

    pub fn dismiss(&mut self) {
        self.phase = Phase::Idle;
        self.anchor = None;
        self.task = None;
    }

    /// Whether a row that just came under the pointer may count as pointed
    /// at: not while its list is still settling from a scroll.
    fn settled(&self, at: Instant) -> bool {
        self.scrolled_at
            .is_none_or(|t| at.saturating_duration_since(t) >= dwell::SCROLL_REST)
    }
}

fn after(
    state: &Entity<HoverCardState>,
    delay: Duration,
    cx: &mut App,
    f: impl FnOnce(&mut HoverCardState) + 'static,
) -> Task<()> {
    let state = state.downgrade();
    cx.spawn(async move |cx| {
        cx.background_executor().timer(delay).await;
        let _ = state.update(cx, |s, cx| {
            f(s);
            cx.notify();
        });
    })
}

fn pointer_on_target(state: &Entity<HoverCardState>, cx: &mut App) {
    state.update(cx, |s, cx| {
        s.over_target = true;
        match s.phase {
            Phase::Idle if s.settled(Instant::now()) => {
                s.phase = Phase::Waiting;
                s.task = Some(after(&cx.entity(), dwell::HOVER_CARD_DELAY, cx, |s| {
                    if s.phase == Phase::Waiting {
                        s.open_now();
                    }
                }));
            }
            Phase::Leaving => {
                s.phase = Phase::Open;
                s.task = None;
            }
            _ => {}
        }
        cx.notify();
    });
}

fn pointer_left(state: &Entity<HoverCardState>, from_card: bool, cx: &mut App) {
    state.update(cx, |s, cx| {
        if from_card {
            s.over_card = false;
        } else {
            s.over_target = false;
        }
        match s.phase {
            Phase::Waiting if !s.over_target => s.dismiss(),
            Phase::Open if !s.over_target && !s.over_card => {
                s.phase = Phase::Leaving;
                s.task = Some(after(&cx.entity(), dwell::HOVER_CARD_GRACE, cx, |s| {
                    if s.phase == Phase::Leaving && !s.over_card && !s.over_target {
                        s.dismiss();
                    }
                }));
            }
            _ => {}
        }
        cx.notify();
    });
}

/// A thing with a hover card. `card` builds the card when it shows.
#[derive(IntoElement)]
pub struct HoverCard {
    id: ElementId,
    target: AnyElement,
    card: super::Build,
    open: Option<bool>,
    beside: bool,
}

impl HoverCard {
    pub fn new(
        id: impl Into<ElementId>,
        target: impl IntoElement,
        card: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
    ) -> HoverCard {
        HoverCard {
            id: id.into(),
            target: target.into_any_element(),
            card: Rc::new(card),
            open: None,
            beside: false,
        }
    }

    /// Holds the card open (or closed) regardless of the pointer.
    pub fn force_open(mut self, open: bool) -> Self {
        self.open = Some(open);
        self
    }

    /// Floats the card beside the thing, tops level (right of it, or left
    /// when the right has no room), instead of below it: for a card in a
    /// side column.
    pub fn beside(mut self) -> Self {
        self.beside = true;
        self
    }
}

impl RenderOnce for HoverCard {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| HoverCardState::new());
        if let Some(open) = self.open {
            state.update(cx, |s, _| {
                if open && s.phase != Phase::Open {
                    s.open_now();
                } else if !open && s.phase == Phase::Open {
                    s.dismiss();
                }
            });
        }
        let probe_state = state.clone();
        let probe = canvas(
            move |bounds, _, cx| {
                probe_state.update(cx, |s, cx| {
                    s.target = Some(bounds);
                    if s.anchor.is_none() && s.phase == Phase::Open {
                        s.anchor = Some(bounds);
                    }
                    // The list under the thing moved it: close, don't ride along.
                    if let Some(anchor) = s.anchor
                        && anchor.origin != bounds.origin
                        && matches!(s.phase, Phase::Open | Phase::Leaving)
                    {
                        s.dismiss();
                        cx.notify();
                    }
                });
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        let (hover, moved, scrolled, clicked) =
            (state.clone(), state.clone(), state.clone(), state.clone());
        let target = div()
            .id(self.id.clone())
            .relative()
            .child(probe)
            .child(self.target)
            .on_hover(move |on, _, cx| {
                if *on {
                    pointer_on_target(&hover, cx);
                } else {
                    pointer_left(&hover, false, cx);
                }
            })
            .on_mouse_move(move |_, _, cx| {
                let waiting = moved.read(cx).phase == Phase::Idle;
                let settling = moved.read(cx).scrolled_at.is_some();
                if waiting && settling {
                    moved.update(cx, |s, _| s.scrolled_at = None);
                    pointer_on_target(&moved, cx);
                }
            })
            .on_scroll(move |_, _, cx| {
                scrolled.update(cx, |s, cx| {
                    s.scrolled_at = Some(Instant::now());
                    if s.phase != Phase::Idle {
                        s.dismiss();
                        cx.notify();
                    }
                });
            })
            .on_mouse_down(gpui::MouseButton::Left, move |_, _, cx| {
                clicked.update(cx, |s, cx| {
                    s.dismiss();
                    cx.notify();
                });
            });
        let st = state.read(cx);
        let open = matches!(st.phase, Phase::Open | Phase::Leaving);
        let anchor = st.anchor.or(st.target);
        let card = (open && anchor.is_some()).then(|| {
            let bounds = anchor.expect("checked");
            let (on_card, off_card) = (state.clone(), state.clone());
            let place = if self.beside {
                Place::Beside {
                    rect: bounds,
                    gap: m::HOVER_CARD_GAP,
                }
            } else {
                Place::below(bounds, m::HOVER_CARD_GAP)
            };
            overlay::float(
                place,
                Layer::Popover,
                div()
                    .id(crate::style::child_id(&self.id.clone(), "card"))
                    .on_hover(move |on, _, cx| {
                        if *on {
                            on_card.update(cx, |s, cx| {
                                s.over_card = true;
                                if s.phase == Phase::Leaving {
                                    s.phase = Phase::Open;
                                    s.task = None;
                                }
                                cx.notify();
                            });
                        } else {
                            pointer_left(&off_card, true, cx);
                        }
                    })
                    .child((self.card)(window, cx)),
            )
        });
        div().relative().child(target).children(card)
    }
}

/// One action row at the bottom of a hover card.
#[derive(IntoElement)]
pub struct CardAction {
    id: ElementId,
    icon: RowIcon,
    label: SharedString,
    danger: bool,
    current: bool,
    on_click: Option<OnClick>,
}

impl CardAction {
    pub fn new(
        id: impl Into<ElementId>,
        icon: impl Into<RowIcon>,
        label: impl Into<SharedString>,
    ) -> CardAction {
        CardAction {
            id: id.into(),
            icon: icon.into(),
            label: label.into(),
            danger: false,
            current: false,
            on_click: None,
        }
    }

    pub fn danger(mut self) -> Self {
        self.danger = true;
        self
    }

    /// The choice in effect (a status): its ring stays, its words deepen.
    pub fn current(mut self, current: bool) -> Self {
        self.current = current;
        self
    }

    pub fn on_click(
        mut self,
        f: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(f));
        self
    }
}

impl RenderOnce for CardAction {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let ink = if self.danger {
            p.danger
        } else if self.current {
            p.ink(1)
        } else {
            p.ink(2)
        };
        let id = self.id.clone();
        glass::glass_box(
            self.id,
            Kind::Hidden,
            Mode::default(),
            self.current,
            Spec::new(
                if self.danger {
                    Tone::Danger
                } else {
                    Tone::Clear
                },
                radius::MENU_ROW,
            )
            .rim(3.0),
            window,
            cx,
        )
        .mx(px(m::HOVER_CARD_PAD - 8.0))
        .px(px(8.0))
        .py(px(4.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .rounded(px(radius::MENU_ROW))
        .font_role(Role::Index)
        .type_px(s.secondary, s.line_body)
        .text_color(ink.solid())
        .cursor_pointer()
        // In the accessibility tree as the menu rows are (the debug bridge
        // presses card rows by name too).
        .role(gpui::Role::MenuItem)
        .aria_label(self.label.clone())
        .child(row_icon(self.icon, &id, ink.solid()))
        .child(self.label)
        .when_some(self.on_click, |el, f| {
            el.on_click(move |e, w, cx| f(e, w, cx))
        })
    }
}

/// The card itself: title (with the thing's own mark and an index count on
/// the right), a line of metadata, a summary, then sections parted by
/// hairlines; actions go last.
#[derive(IntoElement)]
pub struct CardBody {
    id: ElementId,
    title: SharedString,
    mark: Option<(sand::Kind, Option<Rgb>)>,
    count: Option<SharedString>,
    meta: Vec<AnyElement>,
    summary: Option<SharedString>,
    quote: Option<(SharedString, Option<SharedString>)>,
    sections: Vec<Vec<AnyElement>>,
}

impl CardBody {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> CardBody {
        CardBody {
            id: id.into(),
            title: title.into(),
            mark: None,
            count: None,
            meta: Vec::new(),
            summary: None,
            quote: None,
            sections: Vec::new(),
        }
    }

    pub fn mark(mut self, kind: sand::Kind, color: Option<Rgb>) -> Self {
        self.mark = Some((kind, color));
        self
    }

    /// Words, chapters, entries: index figures beside the title.
    pub fn count(mut self, count: impl Into<SharedString>) -> Self {
        self.count = Some(count.into());
        self
    }

    pub fn meta(mut self, child: impl IntoElement) -> Self {
        self.meta.push(child.into_any_element());
        self
    }

    pub fn summary(mut self, text: impl Into<SharedString>) -> Self {
        self.summary = Some(text.into());
        self
    }

    /// A passage on a slip of the page, in the prose face (the 0.1
    /// client's `.hover-card__quote`), with a quiet line under it.
    pub fn quote(mut self, text: impl Into<SharedString>, note: Option<SharedString>) -> Self {
        self.quote = Some((text.into(), note));
        self
    }

    /// A section of rows (actions, choices), parted from the one above by a
    /// hairline. Danger rows go in the last section.
    pub fn section(mut self, rows: Vec<AnyElement>) -> Self {
        self.sections.push(rows);
        self
    }
}

impl RenderOnce for CardBody {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let pad = m::HOVER_CARD_PAD;
        let rule = || {
            div()
                .mx(px(pad))
                .my(px(m::SEPARATOR_MARGIN))
                .h(px(m::SEPARATOR))
                .bg(p.hairline())
        };
        let id = self.id.clone();
        let head = div()
            .px(px(pad))
            .pt(px(12.0))
            .flex()
            .flex_row()
            .items_baseline()
            .gap(px(6.0))
            .when_some(self.mark, |el, (kind, color)| {
                let mark = KindMark::new(crate::style::child_id(&id.clone(), "mark"), kind);
                el.child(div().self_center().child(match color {
                    Some(c) => mark.color(c),
                    None => mark,
                }))
            })
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .weight(weight::SEMIBOLD)
                    .text_color(p.ink(1).solid())
                    .child(self.title),
            )
            .when_some(self.count, |el, c| {
                el.child(
                    div()
                        .font_role(Role::Index)
                        .text_color(p.ink(3).solid())
                        .child(c),
                )
            });
        let mut body = div()
            .relative()
            .flex()
            .flex_col()
            .pb(px(6.0))
            .font_role(Role::Ui)
            .type_px(s.secondary, s.line_body)
            .text_color(p.ink(2).solid())
            .child(head)
            .when(!self.meta.is_empty(), |el| {
                el.child(
                    div()
                        .px(px(pad))
                        .pt(px(2.0))
                        .flex()
                        .flex_row()
                        .flex_wrap()
                        .items_center()
                        .gap(px(8.0))
                        .text_color(p.ink(3).solid())
                        .children(self.meta),
                )
            })
            .when_some(self.summary, |el, t| {
                el.child(
                    div()
                        .px(px(pad))
                        .pt(px(6.0))
                        .pb(px(4.0))
                        .child(crate::text::wrapped(t)),
                )
            })
            .when_some(self.quote, |el, (text, note)| {
                el.child(
                    div()
                        .mx(px(pad))
                        .mt(px(8.0))
                        .mb(px(4.0))
                        .px(px(10.0))
                        .py(px(7.0))
                        .rounded(px(radius::MD))
                        .bg(p.page.solid())
                        .font_role(Role::Prose)
                        .line_height(px(s.secondary * 1.7))
                        .text_color(p.ink(2).solid())
                        .child(crate::text::wrapped(text)),
                )
                .when_some(note, |el, note| {
                    el.child(
                        div()
                            .px(px(pad))
                            .pb(px(4.0))
                            .font_role(Role::Index)
                            .text_color(p.ink(3).solid())
                            .child(note),
                    )
                })
            });
        for rows in self.sections {
            body = body
                .child(rule())
                .child(div().flex().flex_col().children(rows));
        }
        glass::surface(
            Ground::flat(p.desk),
            div()
                .id(self.id)
                .relative()
                .w(px(m::HOVER_CARD_WIDTH))
                .rounded(px(radius::SHEET))
                .shadow(float_shadow(p))
                .occlude()
                .child(slab_edge(p, radius::SHEET))
                .child(body),
        )
    }
}
