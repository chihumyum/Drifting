//! Telling the author what is going on (components.md, 「空状态」「加载与进度」).
//!
//! - [`EmptyState`]: one plain sentence in secondary ink, centred, never
//!   italic; above it the hollow mark of what is missing, or a faint icon of
//!   the place; below it, when something can be made on the spot, a text
//!   button; and, on an empty view, where to start (each action with the
//!   shortcut bound to it, in index type, neither boxed).
//! - [`Loading`]: the brush's broken circle (缺角圆相) turning once in 0.9s,
//!   shown only after a wait passes 240ms and then faded in over 0.16s.
//!   Block (20px, words under it) or inline (14px).
//! - [`Progress`]: a 1px track with a 2px accent fill; without a total, a
//!   short piece walks back and forth.
//! - [`NotificationPill`]: a notice floating over the work: an opaque paper
//!   slip with a resting glass line (a small corner, as toasts take) that
//!   floats in (160ms, rising 3px) and fades as a whole when it goes.

use std::{rc::Rc, time::Instant};

use gpui::{
    AnyElement, App, ElementId, Entity, IntoElement, ParentElement, RenderOnce, SharedString,
    Styled, Window, canvas, div, point, prelude::FluentBuilder as _, px, size,
};

use crate::{
    anim::{self, Tween},
    fonts::Role,
    glass::{self, Ground, Kind, Mode, Spec, Tone},
    sand::{self, Icon, KindMark},
    style::DrStyled,
    theme::Theme,
    tokens::{Easing, motion, radius},
};

use super::button::{Button, spinner};

#[derive(IntoElement)]
pub struct EmptyState {
    id: ElementId,
    sentence: SharedString,
    mark: Option<sand::Kind>,
    icon: Option<Icon>,
    action: Option<AnyElement>,
    hints: Vec<(SharedString, SharedString)>,
}

impl EmptyState {
    pub fn new(id: impl Into<ElementId>, sentence: impl Into<SharedString>) -> EmptyState {
        EmptyState {
            id: id.into(),
            sentence: sentence.into(),
            mark: None,
            icon: None,
            action: None,
            hints: Vec::new(),
        }
    }

    /// The hollow mark of the kind of thing that is missing.
    pub fn mark(mut self, kind: sand::Kind) -> Self {
        self.mark = Some(kind);
        self
    }

    /// A faint icon of the place, when what is missing is not a kind.
    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    /// A text button to make one here.
    pub fn action(mut self, button: Button) -> Self {
        self.action = Some(button.text().into_any_element());
        self
    }

    /// Where to start: an action and the shortcut bound to it now.
    pub fn hint(mut self, action: impl Into<SharedString>, keys: impl Into<SharedString>) -> Self {
        self.hints.push((action.into(), keys.into()));
        self
    }
}

impl RenderOnce for EmptyState {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        div()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(10.0))
            .py(px(24.0))
            .font_role(Role::Ui)
            .type_px(s.secondary, s.line_body)
            .text_color(p.muted().solid())
            .when_some(self.mark, |el, kind| {
                el.child(
                    KindMark::new(crate::style::child_id(&self.id.clone(), "mark"), kind)
                        .hollow(true)
                        .scale(2.0),
                )
            })
            .when_some(self.icon, |el, icon| {
                el.child(sand::icon(icon, 24.0, p.ink(4).solid()))
            })
            .child(
                div()
                    .w_full()
                    .text_center()
                    .child(crate::text::wrapped(self.sentence)),
            )
            .children(self.action)
            .when(!self.hints.is_empty(), |el| {
                el.child(div().pt(px(6.0)).flex().flex_col().gap(px(4.0)).children(
                    self.hints.into_iter().map(|(action, keys)| {
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(16.0))
                            .justify_between()
                            .min_w(px(200.0))
                            .child(div().text_color(p.muted().solid()).child(action))
                            .child(
                                div()
                                    .font_role(Role::Index)
                                    .text_color(p.ink(3).solid())
                                    .child(keys),
                            )
                    }),
                ))
            })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LoadingSize {
    #[default]
    Block,
    Inline,
}

pub struct LoadingState {
    since: Instant,
}

#[derive(IntoElement)]
pub struct Loading {
    id: ElementId,
    size: LoadingSize,
    label: Option<SharedString>,
    /// Shows at once, skipping the 240ms wait (a capture, a long known wait).
    immediate: bool,
}

impl Loading {
    pub fn new(id: impl Into<ElementId>) -> Loading {
        Loading {
            id: id.into(),
            size: LoadingSize::Block,
            label: None,
            immediate: false,
        }
    }

    pub fn inline(mut self) -> Self {
        self.size = LoadingSize::Inline;
        self
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn immediate(mut self) -> Self {
        self.immediate = true;
        self
    }
}

impl RenderOnce for Loading {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let state: Entity<LoadingState> = window.use_keyed_state(self.id.clone(), cx, |_, _| {
            LoadingState { since: anim::now() }
        });
        let now = anim::now();
        let waited = now.saturating_duration_since(state.read(cx).since);
        let delay = if self.immediate {
            std::time::Duration::ZERO
        } else {
            motion::dwell::LOADING_DELAY
        };
        let shown = if waited < delay {
            window.request_animation_frame();
            0.0
        } else {
            let t = (waited - delay).as_secs_f32() / motion::dwell::LOADING_FADE.as_secs_f32();
            Easing::EASE_OUT.at(t)
        };
        let px_size = match self.size {
            LoadingSize::Block => 20.0,
            LoadingSize::Inline => 14.0,
        };
        let ink = p.muted().alpha(shown);
        div()
            .flex()
            .when(self.size == LoadingSize::Block, |el| {
                el.flex_col().items_center().gap(px(8.0))
            })
            .when(self.size == LoadingSize::Inline, |el| {
                el.items_center().gap(px(6.0))
            })
            .font_role(Role::Ui)
            .type_px(s.secondary, s.line_body)
            .text_color(ink)
            .child(spinner(px_size, ink, window, theme.reduce_motion))
            .children(self.label)
    }
}

#[derive(IntoElement)]
pub struct Progress {
    value: Option<f32>,
}

impl Progress {
    /// `Some(0–1)` for a known share, `None` without a total.
    pub fn new(value: Option<f32>) -> Progress {
        Progress { value }
    }
}

impl RenderOnce for Progress {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let reduce = theme.reduce_motion;
        let value = self.value;
        div().w_full().h(px(2.0)).relative().child(
            canvas(
                |_, _, _| (),
                move |bounds, _, window, _| {
                    let w = f32::from(bounds.size.width);
                    let track = gpui::Bounds {
                        origin: bounds.origin + point(px(0.0), px(0.5)),
                        size: size(bounds.size.width, px(1.0)),
                    };
                    window.paint_quad(gpui::fill(track, p.ink(1).alpha(0.12)));
                    let (x, fill_w) = match value {
                        Some(v) => (0.0, w * v.clamp(0.0, 1.0)),
                        None => {
                            let piece = (w * 0.22).max(24.0);
                            let t = if reduce {
                                0.0
                            } else {
                                window.request_animation_frame();
                                let lap = 1.6f32;
                                let secs = anim::now()
                                    .duration_since(*START.get_or_init(Instant::now))
                                    .as_secs_f32();
                                let phase = (secs % lap) / lap;
                                // There and back, easing at both ends.
                                let tri = 1.0 - (2.0 * phase - 1.0).abs();
                                Easing::EASE.at(tri)
                            };
                            ((w - piece) * t, piece)
                        }
                    };
                    window.paint_quad(gpui::fill(
                        gpui::Bounds {
                            origin: bounds.origin + point(px(x), px(0.0)),
                            size: size(px(fill_w), px(2.0)),
                        },
                        p.accent.solid(),
                    ));
                },
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        )
    }
}

static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

pub struct NoticeState {
    level: Tween,
}

#[derive(IntoElement)]
pub struct NotificationPill {
    id: ElementId,
    text: SharedString,
    icon: Option<Icon>,
    action: Option<AnyElement>,
    shown: bool,
    danger: bool,
}

impl NotificationPill {
    pub fn new(id: impl Into<ElementId>, text: impl Into<SharedString>) -> NotificationPill {
        NotificationPill {
            id: id.into(),
            text: text.into(),
            icon: None,
            action: None,
            shown: true,
            danger: false,
        }
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    /// A problem the author must deal with: the danger colour's mark.
    pub fn danger(mut self) -> Self {
        self.danger = true;
        self
    }

    pub fn action(mut self, button: Button) -> Self {
        self.action = Some(button.text().small().into_any_element());
        self
    }

    /// Fades the notice out (keep rendering it until it has gone).
    pub fn shown(mut self, shown: bool) -> Self {
        self.shown = shown;
        self
    }
}

impl RenderOnce for NotificationPill {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let shown = self.shown;
        let reduce = theme.reduce_motion;
        let state: Entity<NoticeState> = window.use_keyed_state(
            crate::style::child_id(&self.id.clone(), "notice"),
            cx,
            |_, _| NoticeState {
                level: Tween::still(0.0),
            },
        );
        state.update(cx, |n, _| {
            let at = anim::now();
            let (to, m) = if shown {
                (1.0, motion::FLOAT_IN)
            } else {
                (
                    0.0,
                    motion::Motion::new(motion::sand::FADE, Easing::EASE_OUT),
                )
            };
            n.level.retarget_motion(to, at, m, reduce);
        });
        let now = anim::now();
        let level = state.read(cx).level.value(now);
        if !state.read(cx).level.settled(now) {
            window.request_animation_frame();
        }
        let rise = if shown {
            motion::FLOAT_IN_RISE * (1.0 - level)
        } else {
            0.0
        };
        let mark_ink = if self.danger { p.danger } else { p.ink(3) };
        // Glass never takes `opacity` (it would thin the cover and show the
        // texture through): while the slip fades, its rim is the uniform
        // line at the same strength and its fill fades by alpha.
        let settled = level >= 0.999;
        let spec = if settled {
            Spec::new(Tone::Clear, radius::SM).filled(p.page)
        } else {
            Spec::new(Tone::Clear, radius::SM)
                .ground(Ground::Uneven)
                .strength(level)
        };
        glass::glass_box(
            self.id,
            Kind::Rest,
            Mode::default(),
            false,
            spec,
            window,
            cx,
        )
        .relative()
        .top(px(rise))
        .bg(p.page.alpha(level))
        .rounded(px(radius::SM))
        .h(px(s.control_height + 6.0))
        .pl(px(12.0))
        .pr(px(if self.action.is_some() { 6.0 } else { 14.0 }))
        .font_role(Role::Ui)
        .type_px(s.secondary, s.line_body)
        .text_color(p.ink(2).solid())
        .child(
            // What lies inside sits on the slip's paper.
            glass::surface(
                Ground::flat(p.page),
                div()
                    .size_full()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .when(!settled, |el| el.opacity(level))
                    .when_some(self.icon, |el, icon| {
                        el.child(sand::icon(icon, 16.0, mark_ink.solid()))
                    })
                    .child(self.text)
                    .children(self.action),
            ),
        )
    }
}

/// Keeps callbacks shareable between a notice and its owner.
pub type OnDismiss = Rc<dyn Fn(&mut Window, &mut App)>;
