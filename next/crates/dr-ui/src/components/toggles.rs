//! Two-state and many-state choices made of glass (components.md, 「Switch」
//! 「范围开关」「Chip」).
//!
//! - [`Switch`]: a capsule whose track is glass: off, only the resting line;
//!   on, the whole track bleeds the accent's still glass. The knob is plain
//!   paper (light ink in the dark) and never takes the colour.
//! - [`ScopeToggle`]: one word that never changes; off a resting line, on
//!   the selected glass. Square corners, like the Dock's lock.
//! - [`Chip`]: one of a group of independent switches (several may be on).
//!   Index type, a 2px corner, a storyline dash before the name, the count
//!   after it.

use std::{rc::Rc, time::Duration};

use gpui::{
    App, BoxShadow, ElementId, Entity, InteractiveElement, IntoElement, ParentElement, RenderOnce,
    SharedString, StatefulInteractiveElement, Styled, Window, canvas, div, point,
    prelude::FluentBuilder as _, px,
};

use crate::{
    anim::{self, Tween},
    fonts::{Role, weight},
    glass::{self, DENSE, GlassState, Kind, Look, Mode, Spec, Tone},
    sand::{self, KindMark},
    style::DrStyled,
    theme::Theme,
    tokens::{Easing, Rgb, glass as g, radius},
};

/// The Switch's knob, which the number slider shares: plain paper (light
/// ink in the dark) that never takes a colour, a 1px soft shadow under it
/// and a hairline round it. `dim` below 1 fades it toward `under`, what it
/// lies on (disabled).
pub(crate) fn paint_knob(
    at: gpui::Bounds<gpui::Pixels>,
    p: &crate::tokens::Palette,
    dim: f32,
    under: Rgb,
    window: &mut Window,
) {
    let r = at.size.width / 2.0;
    let fill = if p.dark { p.ink(2) } else { p.page };
    window.paint_drop_shadows(
        at,
        gpui::Corners::all(r),
        &[BoxShadow {
            color: gpui::black().opacity(0.18 * dim),
            offset: point(px(0.0), px(1.0)),
            blur_radius: px(2.0),
            spread_radius: px(0.0),
            inset: false,
        }],
    );
    window.paint_quad(
        gpui::fill(at, fill.mix(under, 1.0 - dim).solid())
            .corner_radii(r)
            .border_widths(px(0.5))
            .border_color(p.ink(1).alpha(0.06)),
    );
}

pub struct SwitchState {
    on: Tween,
    knob: Tween,
}

#[derive(IntoElement)]
pub struct Switch {
    id: ElementId,
    on: bool,
    disabled: bool,
    tint: Option<Rgb>,
    on_change: Option<super::OnToggle>,
}

impl Switch {
    pub fn new(id: impl Into<ElementId>, on: bool) -> Switch {
        Switch {
            id: id.into(),
            on,
            disabled: false,
            tint: None,
            on_change: None,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The colour the open track bleeds (the accent unless the row has one).
    pub fn tint(mut self, tint: Rgb) -> Self {
        self.tint = Some(tint);
        self
    }

    /// Called with the new value when the author flips it.
    pub fn on_change(mut self, f: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(f));
        self
    }
}

impl RenderOnce for Switch {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let on = self.on;
        let reduce = theme.reduce_motion;
        let rim = glass::use_state(
            self.id.clone(),
            Kind::Rest,
            Mode {
                disabled: self.disabled,
                ..Mode::default()
            },
            false,
            theme,
            window,
            cx,
        );
        let switch: Entity<SwitchState> = window.use_keyed_state(
            crate::style::child_id(&self.id.clone(), "switch"),
            cx,
            |_, _| SwitchState {
                on: Tween::still(if on { 1.0 } else { 0.0 }),
                knob: Tween::still(if on { 1.0 } else { 0.0 }),
            },
        );
        switch.update(cx, |s, _| {
            let at = anim::now();
            let d = |d: u64| {
                if reduce {
                    Duration::ZERO
                } else {
                    Duration::from_millis(d)
                }
            };
            let to = if on { 1.0 } else { 0.0 };
            s.on.retarget(to, at, d(220), Easing::EASE_OUT);
            s.knob
                .retarget(to, at, d(180), Easing::new(0.4, 0.0, 0.2, 1.0));
        });
        let tint = self.tint.unwrap_or(p.accent);
        let (w, h, knob) = (g::SWITCH_W, g::SWITCH_H, g::SWITCH_KNOB);
        let interactive = !self.disabled;
        // Disabled dims the knob and the tint; glass never takes `opacity`,
        // which would thin its cover and show the texture through.
        let dim = if self.disabled { 0.45 } else { 1.0 };
        let paint_rim = rim.clone();
        let el = div()
            .id(self.id)
            .relative()
            .w(px(w))
            .h(px(h))
            .flex_none()
            .rounded_full()
            .bg(p.page.solid())
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, cx| {
                        let now = anim::now();
                        let ground = Spec::new(Tone::Clear, h / 2.0)
                            .filled(p.page)
                            .resolve_ground(p);
                        let r = paint_rim.read(cx);
                        // The track is small glass: it reads the dense patch.
                        // Its line is the clear glass at half; under the
                        // pointer it bleeds half the track's height.
                        let mut look = r.look(now, p.glass_clear, DENSE);
                        look.rim = h / 2.0;
                        look.bleed_lift = p.bleed_lift;
                        glass::paint_rim(bounds, h / 2.0, &look, ground, window, cx);
                        let s = switch.read(cx);
                        let level = s.on.value(now);
                        if level > 0.003 {
                            let lit = Look {
                                opacity: level * dim,
                                g: 1.05,
                                sp: 1.0,
                                flow: 0.0,
                                rim: h * 0.4,
                                origin: DENSE,
                                color: tint,
                                bleed_lift: p.bleed_lift,
                            };
                            glass::paint_rim(bounds, h / 2.0, &lit, ground, window, cx);
                            window.paint_quad(
                                gpui::fill(bounds, tint.alpha(0.12 * level * dim))
                                    .corner_radii(px(h / 2.0)),
                            );
                        }
                        let x = 2.0 + (w - knob - 4.0) * s.knob.value(now);
                        let at = gpui::Bounds {
                            origin: bounds.origin + point(px(x), px((h - knob) / 2.0)),
                            size: gpui::size(px(knob), px(knob)),
                        };
                        paint_knob(at, p, dim, p.page, window);
                        anim::keep_going(!s.on.settled(now) || !s.knob.settled(now), window);
                        glass::request_frames(r, now, window, cx);
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            );
        glass::wire(el, &rim, interactive)
            .when(interactive, |el| el.cursor_pointer())
            .when_some(self.on_change.filter(|_| interactive), |el, f| {
                el.on_click(move |_, w, cx| f(!on, w, cx))
            })
    }
}

#[derive(IntoElement)]
pub struct ScopeToggle {
    id: ElementId,
    label: SharedString,
    on: bool,
    disabled: bool,
    on_change: Option<super::OnToggle>,
}

impl ScopeToggle {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>, on: bool) -> ScopeToggle {
        ScopeToggle {
            id: id.into(),
            label: label.into(),
            on,
            disabled: false,
            on_change: None,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Called with the new value when the author flips it.
    pub fn on_change(mut self, f: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(f));
        self
    }
}

impl RenderOnce for ScopeToggle {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let interactive = !self.disabled;
        let ink = if self.disabled {
            p.ink(4)
        } else if self.on {
            p.ink(1)
        } else {
            p.ink(2)
        };
        glass::glass_box(
            self.id,
            Kind::Rest,
            Mode {
                disabled: self.disabled,
                ..Mode::default()
            },
            self.on,
            Spec::new(Tone::Clear, 0.0),
            window,
            cx,
        )
        .h(px(s.control_height - 6.0))
        .px(px(8.0))
        .flex()
        .flex_none()
        .items_center()
        .font_role(Role::Ui)
        .type_px(s.secondary, s.line_body)
        .text_color(ink.solid())
        .role(gpui::Role::CheckBox)
        .aria_label(self.label.clone())
        .aria_toggled(if self.on {
            gpui::Toggled::True
        } else {
            gpui::Toggled::False
        })
        .child(self.label)
        .when(interactive, |el| el.cursor_pointer())
        .when_some(self.on_change.filter(|_| interactive), |el, f| {
            let on = self.on;
            el.on_click(move |_, w, cx| f(!on, w, cx))
        })
    }
}

#[derive(IntoElement)]
pub struct Chip {
    id: ElementId,
    label: SharedString,
    on: bool,
    color: Option<Rgb>,
    count: Option<usize>,
    disabled: bool,
    on_change: Option<super::OnToggle>,
}

impl Chip {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>, on: bool) -> Chip {
        Chip {
            id: id.into(),
            label: label.into(),
            on,
            color: None,
            count: None,
            disabled: false,
            on_change: None,
        }
    }

    /// The type's colour, carried by a sand dash before the name.
    pub fn color(mut self, color: Rgb) -> Self {
        self.color = Some(color);
        self
    }

    pub fn count(mut self, count: usize) -> Self {
        self.count = Some(count);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Called with the new value when the author flips it.
    pub fn on_change(mut self, f: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(f));
        self
    }
}

impl RenderOnce for Chip {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let empty = self.count == Some(0);
        let ink = if empty || self.disabled {
            p.ink(5)
        } else {
            p.ink(2)
        };
        let id = self.id.clone();
        let interactive = !self.disabled;
        let on = self.on;
        glass::glass_box(
            self.id,
            Kind::Rest,
            Mode {
                disabled: self.disabled,
                ..Mode::default()
            },
            self.on,
            {
                let spec =
                    Spec::new(Tone::Clear, radius::SM).strength(if empty { 0.5 } else { 1.0 });
                if self.on { spec.filled(p.page) } else { spec }
            },
            window,
            cx,
        )
        .h(px(s.control_height - 6.0))
        .px(px(8.0))
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.0))
        .rounded(px(radius::SM))
        .when(self.on, |el| el.bg(p.page.solid()))
        .font_role(Role::Index)
        .type_px(s.caption, s.line_caption)
        .text_color(ink.solid())
        .when_some(self.color, |el, color| {
            el.child(
                KindMark::new(
                    crate::style::child_id(&id.clone(), "mark"),
                    sand::Kind::Storyline,
                )
                .color(color)
                .strength(if self.on { 1.0 } else { 0.35 }),
            )
        })
        .child(self.label)
        .when_some(self.count, |el, n| {
            el.child(
                div()
                    .text_color(if empty { p.ink(5) } else { p.ink(3) }.solid())
                    .child(n.to_string()),
            )
        })
        .when(interactive, |el| el.cursor_pointer())
        .when_some(self.on_change.filter(|_| interactive), |el, f| {
            el.on_click(move |_, w, cx| f(!on, w, cx))
        })
        .weight(weight::REGULAR)
    }
}

/// The rim state of a control, for components that paint more than one
/// layer over the same glass.
pub fn rim_state(state: &Entity<GlassState>, cx: &App) -> GlassState {
    *state.read(cx)
}
