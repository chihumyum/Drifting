//! Choosing a number (components.md, 「数值滑块」; ui-controls.css
//! `.ui-range`, `.ui-number`): the editor's font size, line height,
//! paragraph spacing and paper width.
//!
//! - [`Range`] (the 0.1 client's `GlassRange`): a hairline track and a 2px
//!   ink line for the part already travelled (the progress hairline, in ink
//!   rather than the accent). The knob is the Switch's; under the pointer,
//!   or holding the keyboard's focus, a round glass halo comes up round it
//!   and drifts, and held down it deepens like any glass. Click anywhere on
//!   the track to jump there, drag to slide; the arrow keys step it, Page
//!   Up / Page Down a tenth of the range, Home / End to either end. Screen
//!   readers see a slider with its value and bounds.
//! - [`NumberField`]: the number beside it, a small single-line field in
//!   index type with the unit read at its end and two flat strokes to step
//!   it. Typing a valid number in range previews it at once; Enter or
//!   leaving the field settles it (out of range is brought back in, rubbish
//!   is dropped). Up / Down step it.
//!
//! Both take a value and give one back: `new(id, value, min, max)`,
//! `.on_change(|value, window, cx| …)`, `.disabled(bool)`, like every
//! control the settings registry generates.

use std::{cell::RefCell, rc::Rc};

use gpui::{
    App, AppContext as _, Bounds, ElementId, Entity, FocusHandle, Focusable as _,
    InteractiveElement, IntoElement, KeyDownEvent, MouseButton, MouseMoveEvent, MouseUpEvent,
    ParentElement, Pixels, RenderOnce, SharedString, StatefulInteractiveElement, Styled,
    Subscription, Window, canvas, div, prelude::FluentBuilder as _, px,
};

use crate::{
    anim,
    glass::{self, Kind, Mode, Spec, Tone},
    input::{FieldEvent, TextField},
    sand::{self, Icon},
    style::child_id,
    theme::Theme,
};

pub type OnValue = Rc<dyn Fn(f64, &mut Window, &mut App)>;

/// The track's size: 150 x 22, the knob 14, its halo 24.
pub const WIDTH: f32 = 150.0;
pub const HEIGHT: f32 = 22.0;
pub const KNOB: f32 = 14.0;
pub const HALO: f32 = 24.0;
/// The number field's width.
pub const FIELD_WIDTH: f32 = 96.0;

/// A range of numbers and the grain they are chosen in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds1 {
    pub min: f64,
    pub max: f64,
    /// The slider's grain; 0 for none.
    pub step: f64,
}

impl Bounds1 {
    pub fn new(min: f64, max: f64, step: f64) -> Bounds1 {
        let (min, max) = if min <= max { (min, max) } else { (max, min) };
        Bounds1 {
            min,
            max,
            step: step.max(0.0),
        }
    }

    /// `value` inside the range, on the grain counted from `min`, without
    /// float dust (0.1 + 0.2 lands on 0.3).
    pub fn snap(&self, value: f64) -> f64 {
        if !value.is_finite() {
            return self.min;
        }
        let v = value.clamp(self.min, self.max);
        if self.step <= 0.0 {
            return v;
        }
        let k = ((v - self.min) / self.step).round();
        let on = (self.min + k * self.step).clamp(self.min, self.max);
        round_to(on, decimals(self.step).max(decimals(self.min)))
    }

    /// How far along the range `value` is, 0 to 1.
    pub fn progress(&self, value: f64) -> f32 {
        if self.max <= self.min {
            return 0.0;
        }
        (((value - self.min) / (self.max - self.min)).clamp(0.0, 1.0)) as f32
    }

    /// The value under a point `t` of the way along the track, snapped.
    pub fn at(&self, t: f32) -> f64 {
        self.snap(self.min + (self.max - self.min) * f64::from(t.clamp(0.0, 1.0)))
    }

    /// `value` moved by `steps` of the grain (a tenth of the range when
    /// there is no grain), snapped.
    pub fn nudge(&self, value: f64, steps: f64) -> f64 {
        let grain = if self.step > 0.0 {
            self.step
        } else {
            (self.max - self.min) / 10.0
        };
        self.snap(value + grain * steps)
    }

    /// A tenth of the range in whole steps, at least one (Page Up / Down).
    pub fn page(&self) -> f64 {
        if self.step <= 0.0 {
            return 1.0;
        }
        ((self.max - self.min) / 10.0 / self.step).round().max(1.0)
    }
}

/// How many decimals `x` is written with (to 6), so the grain's own
/// precision is kept.
fn decimals(x: f64) -> i32 {
    let mut d = 0;
    let mut v = x.abs();
    while d < 6 && (v - v.round()).abs() > 1e-9 {
        v *= 10.0;
        d += 1;
    }
    d
}

fn round_to(x: f64, decimals: i32) -> f64 {
    let f = 10f64.powi(decimals);
    (x * f).round() / f
}

/// Where the knob's centre is, from the track's left edge, for progress `t`
/// on a track `width` wide: the knob never leaves the track.
pub fn knob_x(t: f32, width: f32) -> f32 {
    KNOB / 2.0 + (width - KNOB) * t.clamp(0.0, 1.0)
}

/// The progress under `x` (from the track's left edge), inverse of
/// [`knob_x`].
pub fn progress_at(x: f32, width: f32) -> f32 {
    let usable = (width - KNOB).max(1.0);
    ((x - KNOB / 2.0) / usable).clamp(0.0, 1.0)
}

#[derive(Default)]
pub struct RangeState {
    bounds: Option<Bounds<Pixels>>,
    dragging: bool,
    pointer: bool,
}

#[derive(IntoElement)]
pub struct Range {
    id: ElementId,
    value: f64,
    bounds: Bounds1,
    disabled: bool,
    wide: bool,
    label: Option<SharedString>,
    on_change: Option<OnValue>,
}

impl Range {
    pub fn new(id: impl Into<ElementId>, value: f64, min: f64, max: f64) -> Range {
        Range {
            id: id.into(),
            value,
            bounds: Bounds1::new(min, max, 1.0),
            disabled: false,
            wide: false,
            label: None,
            on_change: None,
        }
    }

    /// The grain it moves in (default 1; 0 for none).
    pub fn step(mut self, step: f64) -> Self {
        self.bounds = Bounds1::new(self.bounds.min, self.bounds.max, step);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Fill the row instead of a fixed 150px (at least 120).
    pub fn wide(mut self) -> Self {
        self.wide = true;
        self
    }

    /// Its name for screen readers (the setting's name); never drawn.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// Called with the new value, snapped to the grain, whenever the hand
    /// or a key moves it to another.
    pub fn on_change(mut self, f: impl Fn(f64, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(f));
        self
    }
}

/// Calls `f` when `next` differs from `value`.
fn offer(value: f64, next: f64, f: &Option<OnValue>, window: &mut Window, cx: &mut App) {
    if let Some(f) = f
        && (next - value).abs() > f64::EPSILON * value.abs().max(1.0)
    {
        f(next, window, cx);
    }
}

impl RenderOnce for Range {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let id = self.id.clone();
        let interactive = !self.disabled;
        let state: Entity<RangeState> =
            window.use_keyed_state(child_id(&id, "range"), cx, |_, _| RangeState::default());
        let focus: Entity<FocusHandle> =
            window.use_keyed_state(child_id(&id, "focus"), cx, |_, cx| cx.focus_handle());
        let focus = focus.read(cx).clone();
        let halo = glass::use_state(
            child_id(&id, "halo"),
            Kind::Hidden,
            Mode {
                disabled: self.disabled,
                ..Mode::default()
            },
            false,
            theme,
            window,
            cx,
        );
        // The halo is up under the pointer, while dragging and while the
        // keyboard's focus is on it.
        let (pointer, dragging) = {
            let s = state.read(cx);
            (s.pointer, s.dragging)
        };
        let keyboard = focus.is_focused(window) && window.last_input_was_keyboard();
        halo.update(cx, |h, _| {
            h.set_hover(interactive && (pointer || keyboard || dragging));
            h.set_pressed(interactive && dragging);
        });
        if !interactive {
            state.update(cx, |s, _| s.dragging = false);
        }

        let value = self.value;
        let range = self.bounds;
        let t = range.progress(value);
        let dim = if self.disabled { 0.45 } else { 1.0 };
        let on_change = self.on_change.clone().filter(|_| interactive);
        let paint_state = state.clone();
        let paint_halo = halo.clone();
        let paint_change = on_change.clone();
        let track = canvas(
            |_, _, _| (),
            move |bounds, _, window, cx| {
                let now = anim::now();
                paint_state.update(cx, |s, _| s.bounds = Some(bounds));
                // Disabled fades everything toward what the slider lies on.
                let under = match glass::current_ground() {
                    Some(glass::Ground::Flat { inside, .. }) => inside,
                    _ => p.desk,
                };
                let w = f32::from(bounds.size.width);
                let mid = bounds.origin.y + bounds.size.height / 2.0;
                let x0 = bounds.origin.x;
                // The track, then the travelled part.
                window.paint_quad(gpui::fill(
                    Bounds::new(
                        gpui::point(x0, mid - px(0.5)),
                        gpui::size(bounds.size.width, px(1.0)),
                    ),
                    p.rule_strong.mix(under, 1.0 - dim).solid(),
                ));
                let cx_knob = knob_x(t, w);
                window.paint_quad(gpui::fill(
                    Bounds::new(
                        gpui::point(x0, mid - px(1.0)),
                        gpui::size(px(cx_knob), px(2.0)),
                    ),
                    p.ink(3).mix(under, 1.0 - dim).solid(),
                ));
                // The halo, then the knob over it.
                let centre = gpui::point(x0 + px(cx_knob), mid);
                let halo_at = Bounds::new(
                    centre - gpui::point(px(HALO / 2.0), px(HALO / 2.0)),
                    gpui::size(px(HALO), px(HALO)),
                );
                let spec = Spec::new(Tone::Clear, HALO / 2.0);
                let h = paint_halo.read(cx);
                let look = spec.look(h, now, p);
                let ground = spec.resolve_ground(p);
                glass::paint_rim(halo_at, HALO / 2.0, &look, ground, window, cx);
                glass::request_frames(h, now, window, cx);
                let knob_at = Bounds::new(
                    centre - gpui::point(px(KNOB / 2.0), px(KNOB / 2.0)),
                    gpui::size(px(KNOB), px(KNOB)),
                );
                super::toggles::paint_knob(knob_at, p, dim, under, window);

                // A drag in progress follows the pointer anywhere in the
                // window until the button comes up.
                if paint_state.read(cx).dragging {
                    let move_state = paint_state.clone();
                    let change = paint_change.clone();
                    window.on_mouse_event(move |e: &MouseMoveEvent, phase, window, cx| {
                        if !phase.bubble() || !e.dragging() {
                            return;
                        }
                        let Some(b) = move_state.read(cx).bounds else {
                            return;
                        };
                        let x = f32::from(e.position.x - b.origin.x);
                        let next = range.at(progress_at(x, f32::from(b.size.width)));
                        offer(value, next, &change, window, cx);
                    });
                    let up_state = paint_state.clone();
                    let up_halo = paint_halo.clone();
                    window.on_mouse_event(move |_: &MouseUpEvent, phase, _, cx| {
                        if !phase.bubble() {
                            return;
                        }
                        up_state.update(cx, |s, cx| {
                            s.dragging = false;
                            cx.notify();
                        });
                        up_halo.update(cx, |h, cx| {
                            if h.set_pressed(false) {
                                cx.notify();
                            }
                        });
                    });
                }
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();

        let down_state = state.clone();
        let down_change = on_change.clone();
        let down_focus = focus.clone();
        let hover_state = state.clone();
        let key_change = on_change.clone();
        let a11y_up = on_change.clone();
        let a11y_down = on_change.clone();
        div()
            .id(id)
            .relative()
            .h(px(HEIGHT))
            .flex_none()
            .map(|el| {
                if self.wide {
                    el.flex_1().min_w(px(120.0))
                } else {
                    el.w(px(WIDTH))
                }
            })
            .child(track)
            .role(gpui::Role::Slider)
            .when_some(self.label, |el, label| el.aria_label(label))
            .aria_numeric_value(value)
            .aria_min_numeric_value(range.min)
            .aria_max_numeric_value(range.max)
            .when(range.step > 0.0, |el| {
                el.aria_numeric_value_step(range.step)
            })
            .when(interactive, |el| {
                el.cursor_pointer()
                    .track_focus(&focus)
                    .tab_index(0)
                    .on_hover(move |hovered, _, cx| {
                        hover_state.update(cx, |s, cx| {
                            s.pointer = *hovered;
                            cx.notify();
                        });
                    })
                    .on_mouse_down(MouseButton::Left, move |e, window, cx| {
                        window.focus(&down_focus, cx);
                        let b = down_state.update(cx, |s, cx| {
                            s.dragging = true;
                            cx.notify();
                            s.bounds
                        });
                        if let Some(b) = b {
                            let x = f32::from(e.position.x - b.origin.x);
                            let next = range.at(progress_at(x, f32::from(b.size.width)));
                            offer(value, next, &down_change, window, cx);
                        }
                    })
                    .on_key_down(move |e: &KeyDownEvent, window, cx| {
                        let m = &e.keystroke.modifiers;
                        if m.control || m.alt || m.platform || m.function {
                            return;
                        }
                        let next = match e.keystroke.key.as_str() {
                            "left" | "down" => range.nudge(value, -1.0),
                            "right" | "up" => range.nudge(value, 1.0),
                            "pagedown" => range.nudge(value, -range.page()),
                            "pageup" => range.nudge(value, range.page()),
                            "home" => range.min,
                            "end" => range.max,
                            _ => return,
                        };
                        cx.stop_propagation();
                        offer(value, next, &key_change, window, cx);
                    })
                    .on_a11y_action(gpui::AccessibleAction::Increment, move |_, window, cx| {
                        offer(value, range.nudge(value, 1.0), &a11y_up, window, cx);
                    })
                    .on_a11y_action(gpui::AccessibleAction::Decrement, move |_, window, cx| {
                        offer(value, range.nudge(value, -1.0), &a11y_down, window, cx);
                    })
            })
    }
}

/// How a typed number is read and written.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NumberFormat {
    pub min: f64,
    pub max: f64,
    /// Whole numbers only.
    pub integer: bool,
    /// Decimals shown and kept (ignored for whole numbers).
    pub precision: u32,
}

impl NumberFormat {
    pub fn write(&self, value: f64) -> String {
        if self.integer {
            return format!("{}", value.round() as i64);
        }
        let s = format!("{:.*}", self.precision as usize, value);
        if s.contains('.') {
            s.trim_end_matches('0').trim_end_matches('.').to_owned()
        } else {
            s
        }
    }

    /// The number written in `text`, if it is one (spaces round it and a
    /// comma for the decimal point are fine).
    pub fn read(&self, text: &str) -> Option<f64> {
        let t = text.trim().replace(',', ".");
        if t.is_empty() {
            return None;
        }
        t.parse::<f64>().ok().filter(|v| v.is_finite())
    }

    /// `value` in range and kept to the format's precision.
    pub fn settle(&self, value: f64) -> f64 {
        let v = value.clamp(self.min, self.max);
        if self.integer {
            v.round().clamp(self.min.ceil(), self.max.floor())
        } else {
            round_to(v, self.precision as i32)
        }
    }

    /// The smallest step the two strokes take: 1, or one unit of the last
    /// decimal.
    pub fn fine(&self) -> f64 {
        if self.integer {
            1.0
        } else {
            10f64.powi(-(self.precision as i32))
        }
    }

    /// What typing `text` previews: a valid number already in range, else
    /// nothing yet.
    pub fn preview(&self, text: &str) -> Option<f64> {
        self.read(text)
            .filter(|v| *v >= self.min && *v <= self.max)
            .map(|v| self.settle(v))
    }

    /// What Enter or leaving the field settles on: the typed number brought
    /// into range, or `fallback` when the text is not a number.
    pub fn commit(&self, text: &str, fallback: f64) -> f64 {
        self.settle(self.read(text).unwrap_or(fallback))
    }
}

/// What the field's listener and its two strokes need when an event
/// arrives or the field draws: the last render's value and settings.
struct Live {
    value: f64,
    format: NumberFormat,
    disabled: bool,
    unit: Option<SharedString>,
    on_change: Option<OnValue>,
}

pub struct NumberState {
    field: Entity<TextField>,
    live: Rc<RefCell<Live>>,
    _events: Subscription,
}

#[derive(IntoElement)]
pub struct NumberField {
    id: ElementId,
    value: f64,
    format: NumberFormat,
    unit: Option<SharedString>,
    label: Option<SharedString>,
    disabled: bool,
    on_change: Option<OnValue>,
}

impl NumberField {
    pub fn new(id: impl Into<ElementId>, value: f64, min: f64, max: f64) -> NumberField {
        let (min, max) = if min <= max { (min, max) } else { (max, min) };
        NumberField {
            id: id.into(),
            value,
            format: NumberFormat {
                min,
                max,
                integer: true,
                precision: 0,
            },
            unit: None,
            label: None,
            disabled: false,
            on_change: None,
        }
    }

    /// Allow `precision` decimals (default: whole numbers).
    pub fn decimals(mut self, precision: u32) -> Self {
        self.format.integer = precision == 0;
        self.format.precision = precision;
        self
    }

    /// The unit read at the field's end (px, ×).
    pub fn unit(mut self, unit: impl Into<SharedString>) -> Self {
        self.unit = Some(unit.into());
        self
    }

    /// Its name for screen readers; never drawn.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Called with the new value: while typing once the text is a number in
    /// range, on Enter or leaving the field, and from the two strokes.
    pub fn on_change(mut self, f: impl Fn(f64, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(f));
        self
    }
}

fn changes(live: &Rc<RefCell<Live>>, next: f64, window: &mut Window, cx: &mut App) {
    let (value, f) = {
        let l = live.borrow();
        (l.value, l.on_change.clone())
    };
    offer(value, next, &f, window, cx);
}

impl RenderOnce for NumberField {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let id = self.id.clone();
        let format = self.format;
        let value = self.value;
        let interactive = !self.disabled;
        let on_change = self.on_change.clone().filter(|_| interactive);
        let field_id = child_id(&id, "field");
        let unit = self.unit.clone();
        let disabled = self.disabled;
        let steps_id = id.clone();
        let state: Entity<NumberState> =
            window.use_keyed_state(child_id(&id, "number"), cx, |window, cx| {
                let start = format.write(value);
                let live = Rc::new(RefCell::new(Live {
                    value,
                    format,
                    disabled,
                    unit: unit.clone(),
                    on_change: None,
                }));
                // Set up once: the strokes read the current value from
                // `live` whenever the field draws.
                let steps_live = live.clone();
                let field = cx.new(|cx| {
                    let mut f = TextField::new(field_id, window, cx)
                        .small()
                        .mono()
                        .with_text(start);
                    f.set_meta(unit, cx);
                    f.set_disabled(disabled, cx);
                    f.set_trailing(
                        Some(Rc::new(move |window, cx| {
                            steps(&steps_id, &steps_live, window, cx).into_any_element()
                        })),
                        cx,
                    );
                    f
                });
                let heard = live.clone();
                let events = cx.subscribe_in(
                    &field,
                    window,
                    move |_, field: &Entity<TextField>, event: &FieldEvent, window, cx| {
                        let (value, format) = {
                            let l = heard.borrow();
                            (l.value, l.format)
                        };
                        match event {
                            FieldEvent::Changed(text) => {
                                if let Some(next) = format.preview(text) {
                                    changes(&heard, next, window, cx);
                                }
                            }
                            FieldEvent::Submitted(text) => {
                                let next = format.commit(text, value);
                                changes(&heard, next, window, cx);
                                field.update(cx, |f, cx| f.set_text(format.write(next), cx));
                            }
                            FieldEvent::Blurred => {
                                let text = field.read(cx).text();
                                let next = format.commit(&text, value);
                                changes(&heard, next, window, cx);
                                field.update(cx, |f, cx| f.set_text(format.write(next), cx));
                            }
                            FieldEvent::Cancelled => {
                                field.update(cx, |f, cx| f.set_text(format.write(value), cx));
                            }
                        }
                    },
                );
                NumberState {
                    field,
                    live,
                    _events: events,
                }
            });
        let (field, live) = {
            let s = state.read(cx);
            (s.field.clone(), s.live.clone())
        };
        // Only what changed reaches the field: telling it to redraw on every
        // render would redraw the window on every frame.
        let (changed, unit_changed) = {
            let mut l = live.borrow_mut();
            let changed = l.value != value || l.format != format || l.disabled != disabled;
            let unit_changed = l.unit != self.unit;
            l.value = value;
            l.format = format;
            l.disabled = disabled;
            l.unit = self.unit.clone();
            l.on_change = on_change.clone();
            (changed, unit_changed)
        };
        // A value changed elsewhere (the slider, a reset) shows at once,
        // unless the author is typing here.
        let focused = field.focus_handle(cx).is_focused(window);
        let shown = format.write(value);
        let unit = self.unit.clone();
        field.update(cx, |f, cx| {
            if !focused && f.text() != shown && format.read(&f.text()) != Some(value) {
                f.set_text(shown.clone(), cx);
            }
            if unit_changed {
                f.set_meta(unit, cx);
            }
            if changed {
                f.set_disabled(disabled, cx);
            }
        });
        let key_live = live.clone();
        div()
            .id(id)
            .w(px(FIELD_WIDTH))
            .flex_none()
            .role(gpui::Role::SpinButton)
            .when_some(self.label, |el, label| el.aria_label(label))
            .aria_numeric_value(value)
            .aria_min_numeric_value(format.min)
            .aria_max_numeric_value(format.max)
            .text_color(p.ink(1).solid())
            .when(interactive, |el| {
                el.on_key_down(move |e: &KeyDownEvent, window, cx| {
                    let m = &e.keystroke.modifiers;
                    if m.control || m.alt || m.platform || m.function {
                        return;
                    }
                    let dir = match e.keystroke.key.as_str() {
                        "up" => 1.0,
                        "down" => -1.0,
                        _ => return,
                    };
                    cx.stop_propagation();
                    let next = format.settle(value + dir * format.fine());
                    changes(&key_live, next, window, cx);
                })
            })
            .child(field)
    }
}

/// The two flat strokes at the field's end: up, then down.
fn steps(id: &ElementId, live: &Rc<RefCell<Live>>, window: &mut Window, cx: &mut App) -> gpui::Div {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let (value, format, disabled) = {
        let l = live.borrow();
        (l.value, l.format, l.disabled)
    };
    let step = |dir: f64, icon: Icon, name: &'static str| {
        let at_end = if dir > 0.0 {
            value >= format.max
        } else {
            value <= format.min
        };
        let off = disabled || at_end;
        let live = live.clone();
        let rest = p.ink(3);
        let deep = p.ink(1).solid();
        div()
            .id(child_id(id, name))
            .w(px(14.0))
            .h(px(11.0))
            .flex()
            .items_center()
            .justify_center()
            .text_color(if off { rest.mix(p.page, 0.65) } else { rest }.solid())
            .when(!off, |el| {
                el.cursor_pointer()
                    .hover(move |st| st.text_color(deep))
                    // The field keeps its focus and its text.
                    .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
                    .on_click(move |_, window, cx| {
                        let (value, format) = {
                            let l = live.borrow();
                            (l.value, l.format)
                        };
                        changes(
                            &live,
                            format.settle(value + dir * format.fine()),
                            window,
                            cx,
                        );
                    })
            })
            .child(StrokeGlyph { icon })
    };
    div()
        .flex()
        .flex_col()
        .flex_none()
        .ml(px(2.0))
        .child(step(1.0, Icon::ChevronUp, "up"))
        .child(step(-1.0, Icon::ChevronDown, "down"))
}

/// A 9px stroke in its parent's text colour (so hover reaches it).
#[derive(IntoElement)]
struct StrokeGlyph {
    icon: Icon,
}

impl RenderOnce for StrokeGlyph {
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let color = window.text_style().color;
        sand::icon(self.icon, 9.0, color)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapping_lands_on_the_grain_inside_the_range() {
        let r = Bounds1::new(12.0, 28.0, 1.0);
        assert_eq!(r.snap(17.4), 17.0);
        assert_eq!(r.snap(17.5), 18.0);
        assert_eq!(r.snap(40.0), 28.0);
        assert_eq!(r.snap(-3.0), 12.0);
        assert_eq!(r.snap(f64::NAN), 12.0);
        let lh = Bounds1::new(1.2, 2.4, 0.05);
        assert_eq!(lh.snap(1.7749), 1.75);
        assert_eq!(lh.snap(1.2 + 0.1 + 0.2), 1.5);
        assert_eq!(lh.nudge(1.5, 1.0), 1.55);
        assert_eq!(lh.nudge(2.4, 1.0), 2.4);
        // Counted from the minimum, not from zero.
        let odd = Bounds1::new(3.0, 20.0, 2.0);
        assert_eq!(odd.snap(6.0), 7.0);
    }

    #[test]
    fn the_knob_stays_on_the_track_and_the_hand_finds_it() {
        assert_eq!(knob_x(0.0, WIDTH), KNOB / 2.0);
        assert_eq!(knob_x(1.0, WIDTH), WIDTH - KNOB / 2.0);
        for t in [0.0, 0.25, 0.5, 0.9, 1.0] {
            let back = progress_at(knob_x(t, WIDTH), WIDTH);
            assert!((back - t).abs() < 1e-5, "{t} -> {back}");
        }
        // Past either end the value sticks to it.
        assert_eq!(progress_at(-20.0, WIDTH), 0.0);
        assert_eq!(progress_at(WIDTH + 20.0, WIDTH), 1.0);
        let r = Bounds1::new(560.0, 960.0, 10.0);
        assert_eq!(r.at(progress_at(knob_x(0.5, WIDTH), WIDTH)), 760.0);
        assert_eq!(r.page(), 4.0);
    }

    #[test]
    fn typing_previews_only_numbers_in_range_and_commit_brings_it_in() {
        let f = NumberFormat {
            min: 12.0,
            max: 28.0,
            integer: true,
            precision: 0,
        };
        assert_eq!(f.preview("1"), None, "half-typed 18");
        assert_eq!(f.preview("18"), Some(18.0));
        assert_eq!(f.preview(" 18 "), Some(18.0));
        assert_eq!(f.preview("180"), None);
        assert_eq!(f.commit("180", 18.0), 28.0);
        assert_eq!(f.commit("abc", 18.0), 18.0);
        assert_eq!(f.commit("", 18.0), 18.0);
        assert_eq!(f.write(18.0), "18");
        let lh = NumberFormat {
            min: 1.0,
            max: 3.0,
            integer: false,
            precision: 2,
        };
        assert_eq!(lh.preview("1,8"), Some(1.8));
        assert_eq!(lh.commit("1.756", 1.8), 1.76);
        assert_eq!(lh.write(1.80), "1.8");
        assert_eq!(lh.write(2.0), "2");
        assert_eq!(lh.fine(), 0.01);
        assert_eq!(lh.settle(1.8 + lh.fine()), 1.81);
    }
}
