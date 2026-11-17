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
//! A thing that is only words with a card behind them (the consent line's
//! 「相关条款」) is [`HoverCard::pressable`]: a press opens its card at once,
//! for a finger, the keyboard (Enter or Space) or a screen reader, and a
//! press anywhere else or Escape closes it.
//!
//! A card the keyboard opens ([`HoverCard::keys`], KB: a left-column row's
//! card on Space) holds open whatever the pointer does, takes the keyboard
//! itself and lights one row at a time ([`CardAction::keys`]): ↑↓ walk the
//! rows over the hairlines and stop at either end; Enter ([`Confirm`]) and
//! Esc or Space ([`Close`]) are the owner's, who runs the row or closes the
//! card ([`CardKeys`]). It closes when the keyboard goes elsewhere.
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
    AnyElement, App, AppContext as _, Bounds, ElementId, Entity, FocusHandle, InteractiveElement,
    IntoElement, KeyBinding, MouseButton, ParentElement, Pixels, RenderOnce, SharedString,
    StatefulInteractiveElement, Styled, Task, Window, actions, canvas, div,
    prelude::FluentBuilder as _, px,
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

actions!(
    hover_card,
    [
        /// ↑ in a card the keyboard walks: the row above (over a hairline),
        /// none past the first.
        SelectPrevious,
        /// ↓: the row below, none past the last.
        SelectNext,
        /// Enter: the owner runs the row the keyboard is on.
        Confirm,
        /// Esc or Space: the owner closes the card.
        Close,
        /// ← and →: nothing in a card (they are not the list's under it).
        Stay,
    ]
);

/// The key context of a card the keyboard walks.
pub const KEY_CONTEXT: &str = "DrHoverCardKeys";

/// The keys of a card the keyboard walks, in its own context.
pub fn key_bindings() -> Vec<KeyBinding> {
    let c = Some(KEY_CONTEXT);
    vec![
        KeyBinding::new("up", SelectPrevious, c),
        KeyBinding::new("down", SelectNext, c),
        KeyBinding::new("enter", Confirm, c),
        KeyBinding::new("escape", Close, c),
        KeyBinding::new("space", Close, c),
        KeyBinding::new("left", Stay, c),
        KeyBinding::new("right", Stay, c),
    ]
}

/// The keyboard in a hover card (KB, `kernel-v5.md` §15 item 48): open or
/// not, the row it is on, the rows it can stop on and the card's own
/// focus. The owner opens it ([`CardKeys::open`]) and hands it to the card
/// ([`HoverCard::keys`]) and to its rows ([`CardAction::keys`]); whoever
/// builds the rows says which can be stopped on ([`CardKeys::set_rows`]:
/// a row that does nothing cannot).
pub struct CardKeys {
    focus: FocusHandle,
    open: bool,
    at: Option<usize>,
    stops: Vec<bool>,
    /// The rows' ids, in order: the keyboard stays on its row when rows
    /// come and go above it (a switch that adds one).
    ids: Vec<SharedString>,
}

impl CardKeys {
    pub fn new(cx: &mut App) -> CardKeys {
        CardKeys {
            focus: cx.focus_handle(),
            open: false,
            at: None,
            stops: Vec::new(),
            ids: Vec::new(),
        }
    }

    /// A new keyboard for a card.
    pub fn make(cx: &mut App) -> Entity<CardKeys> {
        cx.new(|cx| CardKeys::new(cx))
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// The row the keyboard is on, while the card is open.
    pub fn at(&self) -> Option<usize> {
        self.at.filter(|_| self.open)
    }

    /// Opens the card on its first row and gives it the keyboard.
    pub fn open(&mut self, window: &mut Window, cx: &mut App) {
        self.open = true;
        self.at = self.stops.iter().position(|s| *s);
        window.focus(&self.focus, cx);
    }

    /// Closes the card; the keyboard is the owner's to place.
    pub fn close(&mut self) {
        self.open = false;
        self.at = None;
    }

    /// The rows, in order (an id each, unique in the card), and whether
    /// the keyboard can stop on each. The keyboard stays on its row wherever
    /// that row now is; on no row, or on one it cannot stop on any more, it
    /// goes to the first it can.
    pub fn set_rows(&mut self, rows: Vec<(SharedString, bool)>) {
        let on = self.at.and_then(|i| self.ids.get(i).cloned());
        let (ids, stops): (Vec<_>, Vec<_>) = rows.into_iter().unzip();
        self.ids = ids;
        self.stops = stops;
        if !self.open {
            return;
        }
        self.at = on
            .and_then(|id| self.ids.iter().position(|i| *i == id))
            .filter(|&i| self.stops[i])
            .or_else(|| self.stops.iter().position(|s| *s));
    }

    pub fn stops(&self) -> &[bool] {
        &self.stops
    }

    /// One row down (or up), over the rows it cannot stop on; at either end
    /// it stays. Whether it moved.
    pub fn step(&mut self, down: bool) -> bool {
        if !self.open {
            return false;
        }
        let Some(at) = self.at else {
            self.at = self.stops.iter().position(|s| *s);
            return self.at.is_some();
        };
        let next = if down {
            (at + 1..self.stops.len()).find(|&i| self.stops[i])
        } else {
            (0..at).rev().find(|&i| self.stops[i])
        };
        match next {
            Some(i) => {
                self.at = Some(i);
                true
            }
            None => false,
        }
    }

    /// The pointer came onto row `index`: the keyboard goes there. Whether
    /// it moved.
    pub fn point(&mut self, index: usize) -> bool {
        if !self.open || self.at == Some(index) || self.stops.get(index) != Some(&true) {
            return false;
        }
        self.at = Some(index);
        true
    }
}

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
    hold: bool,
    /// Where the thing was when its card opened.
    anchor: Option<Bounds<Pixels>>,
    target: Option<Bounds<Pixels>>,
    scrolled_at: Option<Instant>,
    task: Option<Task<()>>,
    /// Opened by the keyboard ([`HoverCard::keys`]): it goes when the
    /// keyboard closes it.
    keyed: bool,
}

impl HoverCardState {
    fn new() -> HoverCardState {
        HoverCardState {
            phase: Phase::Idle,
            over_target: false,
            over_card: false,
            hold: false,
            anchor: None,
            target: None,
            scrolled_at: None,
            task: None,
            keyed: false,
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
            Phase::Waiting if !s.over_target && !s.hold => s.dismiss(),
            Phase::Open if !s.over_target && !s.over_card && !s.hold => {
                s.phase = Phase::Leaving;
                s.task = Some(after(&cx.entity(), dwell::HOVER_CARD_GRACE, cx, |s| {
                    if s.phase == Phase::Leaving && !s.over_card && !s.over_target && !s.hold {
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
    hold: bool,
    beside: bool,
    press: Option<SharedString>,
    keys: Option<Entity<CardKeys>>,
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
            hold: false,
            beside: false,
            press: None,
            keys: None,
        }
    }

    /// A card the keyboard walks (KB): open while `keys` is, whatever the
    /// pointer does, with the keyboard in it; ↑↓ walk its rows (the rows
    /// built with [`CardAction::keys`] and the same `keys`), ← → do
    /// nothing, Enter and Esc or Space go on to the owner ([`Confirm`],
    /// [`Close`]). When the keyboard goes elsewhere it closes.
    pub fn keys(mut self, keys: Entity<CardKeys>) -> Self {
        self.keys = Some(keys);
        self
    }

    /// Prevents an open card from dismissing while a child sub-flyout is active.
    pub fn keep_open(mut self, hold: bool) -> Self {
        self.hold = hold;
        self
    }

    /// A press opens the card instead of closing it: the thing is a button
    /// named `label` and a stop for the keyboard's focus, Enter or Space
    /// opens the card, and a press outside the thing and its card or Escape
    /// closes it (the 0.1 client's `ConsentLine`).
    pub fn pressable(mut self, label: impl Into<SharedString>) -> Self {
        self.press = Some(label.into());
        self
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
        // The keyboard's card: open while the keyboard holds it, gone once
        // the keyboard is elsewhere.
        let keyed = self.keys.as_ref().is_some_and(|keys| {
            let (open, focused) = {
                let k = keys.read(cx);
                (k.open, k.focus.is_focused(window))
            };
            if open && !focused {
                keys.update(cx, |k, cx| {
                    k.close();
                    cx.notify();
                });
            }
            open && focused
        });
        state.update(cx, |s, _| {
            if keyed {
                s.keyed = true;
                if s.phase != Phase::Open {
                    s.open_now();
                }
            } else if s.keyed {
                s.keyed = false;
                s.dismiss();
            }
        });
        let hold = self.hold || keyed;
        state.update(cx, |s, cx| {
            let was_held = s.hold;
            s.hold = hold;
            if hold && s.phase == Phase::Leaving {
                s.phase = Phase::Open;
                s.task = None;
            } else if was_held && !hold && s.phase == Phase::Open && !s.over_target && !s.over_card
            {
                s.phase = Phase::Leaving;
                s.task = Some(after(&cx.entity(), dwell::HOVER_CARD_GRACE, cx, |s| {
                    if s.phase == Phase::Leaving && !s.over_card && !s.over_target && !s.hold {
                        s.dismiss();
                    }
                }));
            }
        });
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
        let pressable = self.press.is_some();
        let expanded = matches!(state.read(cx).phase, Phase::Open | Phase::Leaving);
        let target = div()
            .id(self.id.clone())
            .relative()
            .child(probe)
            .child(self.target)
            .when_some(self.press, |el, label| {
                let focus: Entity<gpui::FocusHandle> = window.use_keyed_state(
                    crate::style::child_id(&self.id, "focus"),
                    cx,
                    |_, cx| cx.focus_handle(),
                );
                let focus = focus.read(cx).clone();
                let (keyed, spoken, outside) = (state.clone(), state.clone(), state.clone());
                el.role(gpui::Role::Button)
                    .aria_label(label)
                    .aria_expanded(expanded)
                    .track_focus(&focus)
                    .tab_index(0)
                    .cursor_pointer()
                    .on_key_down(move |e: &gpui::KeyDownEvent, _, cx| {
                        let m = &e.keystroke.modifiers;
                        if m.control || m.alt || m.platform || m.function || m.shift {
                            return;
                        }
                        let open = match e.keystroke.key.as_str() {
                            "enter" | "space" => true,
                            "escape" => false,
                            _ => return,
                        };
                        cx.stop_propagation();
                        keyed.update(cx, |s, cx| {
                            if open {
                                s.open_now();
                            } else {
                                s.dismiss();
                            }
                            cx.notify();
                        });
                    })
                    .on_a11y_action(gpui::AccessibleAction::Click, move |_, _, cx| {
                        spoken.update(cx, |s, cx| {
                            s.open_now();
                            cx.notify();
                        });
                    })
                    // A press elsewhere closes it; one on the card is the card's.
                    .on_mouse_down_out(move |_, _, cx| {
                        outside.update(cx, |s, cx| {
                            if s.phase != Phase::Idle && !s.over_card {
                                s.dismiss();
                                cx.notify();
                            }
                        });
                    })
            })
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
                    if pressable {
                        s.open_now();
                    } else {
                        s.dismiss();
                    }
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
            let keys = self.keys.clone().filter(|_| keyed);
            overlay::float(
                place,
                Layer::Popover,
                div()
                    .id(crate::style::child_id(&self.id.clone(), "card"))
                    .occlude()
                    .when_some(keys, |el, keys| {
                        let focus = keys.read(cx).focus.clone();
                        let (up, down) = (keys.clone(), keys);
                        el.track_focus(&focus)
                            .key_context(KEY_CONTEXT)
                            .on_action(move |_: &SelectPrevious, _, cx| {
                                up.update(cx, |k, cx| {
                                    if k.step(false) {
                                        cx.notify();
                                    }
                                })
                            })
                            .on_action(move |_: &SelectNext, _, cx| {
                                down.update(cx, |k, cx| {
                                    if k.step(true) {
                                        cx.notify();
                                    }
                                })
                            })
                            .on_action(|_: &Stay, _, _| {})
                    })
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
    keys: Option<(Entity<CardKeys>, usize)>,
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
            keys: None,
        }
    }

    /// Row `index` of a card the keyboard walks ([`HoverCard::keys`]): it
    /// is lit, as under the pointer (the flowing ring), when the keyboard is
    /// on it, and only then; the pointer coming onto it moves the keyboard
    /// here, so one row of the card is lit at a time (a system menu). Tests
    /// find the row by the debug selector `{id}`, lit `{id}-keyboard`.
    pub fn keys(mut self, keys: &Entity<CardKeys>, index: usize) -> Self {
        self.keys = Some((keys.clone(), index));
        self
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
        let spec = Spec::new(
            if self.danger {
                Tone::Danger
            } else {
                Tone::Clear
            },
            radius::MENU_ROW,
        )
        .rim(3.0);
        let row = match self.keys {
            None => glass::glass_box(
                self.id,
                Kind::Hidden,
                Mode::default(),
                self.current,
                spec,
                window,
                cx,
            ),
            Some((keys, index)) => keyed_row(self.id, self.current, spec, keys, index, window, cx),
        };
        row.mx(px(m::HOVER_CARD_PAD - 8.0))
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

/// A card row the keyboard walks: lit (the flowing ring, as under the
/// pointer) only while the keyboard is on it; the pointer coming onto it
/// moves the keyboard there; a press still deepens it.
fn keyed_row(
    id: ElementId,
    current: bool,
    spec: Spec,
    keys: Entity<CardKeys>,
    index: usize,
    window: &mut Window,
    cx: &mut App,
) -> gpui::Stateful<gpui::Div> {
    let theme = Theme::of(window, cx);
    let lit = keys.read(cx).at() == Some(index);
    let state = glass::use_state(
        id.clone(),
        Kind::Hidden,
        Mode::default(),
        current && !lit,
        theme,
        window,
        cx,
    );
    state.update(cx, |s, _| {
        s.set_hover(lit);
    });
    let (down, up, out) = (state.clone(), state.clone(), state.clone());
    let selector = id.clone();
    div()
        .id(id)
        .relative()
        .child(glass::layer(state, spec, theme))
        // Tests find a row by its id, a lit one by `{id}-keyboard`.
        .debug_selector(move || {
            if lit {
                format!("{selector}-keyboard")
            } else {
                selector.to_string()
            }
        })
        .on_hover(move |hovered, _, cx| {
            if *hovered {
                keys.update(cx, |k, cx| {
                    if k.point(index) {
                        cx.notify();
                    }
                });
            }
        })
        .on_mouse_down(MouseButton::Left, move |_, _, cx| {
            down.update(cx, |s, cx| {
                if s.set_pressed(true) {
                    cx.notify();
                }
            })
        })
        .on_mouse_up(MouseButton::Left, move |_, _, cx| {
            up.update(cx, |s, cx| {
                if s.set_pressed(false) {
                    cx.notify();
                }
            })
        })
        .on_mouse_up_out(MouseButton::Left, move |_, _, cx| {
            out.update(cx, |s, cx| {
                if s.set_pressed(false) {
                    cx.notify();
                }
            })
        })
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

    /// A card with no title: a sentence ([`CardBody::summary`]) and its
    /// rows, for words that only explain themselves (the consent line's).
    pub fn untitled(id: impl Into<ElementId>) -> CardBody {
        CardBody::new(id, SharedString::default())
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
        let titled = !self.title.is_empty();
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
            .when(titled, |el| el.child(head))
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
                        .pt(px(if titled { 6.0 } else { 12.0 }))
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
                .child(slab_edge(p, radius::SHEET))
                .child(body),
        )
    }
}
