//! Shared transitions (motion.md).
//!
//! - [`PageTurn`]: the paper changes to another page by dissolving in, in
//!   place: the next page comes in over the one in front over 180ms; the
//!   one in front stays whole underneath until it is covered, so the ink
//!   never thins. Turned again mid-way, the page that was coming in stays
//!   whole underneath and the next one carries on from the share it had
//!   reached. [`PageTurn::with_level`] tells each page the opacity it is
//!   drawn under, for a page whose content is a cached view
//!   (`ProseEditor::element_at_opacity`).
//! - [`Push`]: heavy ice. A whole block of content is pushed away and
//!   another takes its place, slow to start and then fast (265ms); the
//!   arriving block's four edges bleed a hairline of glass that fades
//!   340ms after it lands. Turned mid-way, both carry on from where they are.
//!
//! The selection wave lives with the pills (`components::choice`).

use std::{rc::Rc, time::Duration};

use gpui::{
    AnyElement, App, ElementId, Entity, IntoElement, ParentElement, RenderOnce, SharedString,
    Styled, Window, canvas, div, prelude::FluentBuilder as _, relative,
};

use crate::{
    anim::{self, Tween},
    glass::{self, Ground, Look},
    theme::Theme,
    tokens::{Easing, motion},
};

type Render = Rc<dyn Fn(&SharedString, &mut Window, &mut App) -> AnyElement>;
type RenderAt = Rc<dyn Fn(&SharedString, f32, &mut Window, &mut App) -> AnyElement>;

pub struct TurnState {
    current: SharedString,
    under: Option<SharedString>,
    level: Tween,
}

#[derive(IntoElement)]
pub struct PageTurn {
    id: ElementId,
    page: SharedString,
    render: RenderAt,
}

impl PageTurn {
    /// Shows `page`, drawn by `render`; changing `page` turns to it.
    pub fn new(
        id: impl Into<ElementId>,
        page: impl Into<SharedString>,
        render: impl Fn(&SharedString, &mut Window, &mut App) -> AnyElement + 'static,
    ) -> PageTurn {
        PageTurn::with_level(id, page, move |key, _, window, cx| render(key, window, cx))
    }

    /// [`PageTurn::new`] whose `render` is also told the opacity the page is
    /// drawn under: the share the page coming in has reached while it turns
    /// (from 0 or where an interrupted turn left it, up to 1), and 1 for the
    /// page whole underneath and for a page at rest. Each frame of a turn
    /// draws again with the new level, and once more at 1 when it ends, so a
    /// cached view inside can be drawn afresh while the level moves
    /// (`ProseEditor::element_at_opacity`) instead of replaying the faint
    /// picture of its first frame.
    pub fn with_level(
        id: impl Into<ElementId>,
        page: impl Into<SharedString>,
        render: impl Fn(&SharedString, f32, &mut Window, &mut App) -> AnyElement + 'static,
    ) -> PageTurn {
        PageTurn {
            id: id.into(),
            page: page.into(),
            render: Rc::new(render),
        }
    }
}

impl RenderOnce for PageTurn {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let page = self.page.clone();
        let state: Entity<TurnState> =
            window.use_keyed_state(self.id.clone(), cx, |_, _| TurnState {
                current: page.clone(),
                under: None,
                level: Tween::still(1.0),
            });
        let now = anim::now();
        state.update(cx, |s, _| {
            if s.current != page {
                let reached = s.level.value(now);
                // The page coming in (or in front) stays whole underneath.
                s.under = Some(s.current.clone());
                s.current = page.clone();
                let from = if reached < 1.0 { reached } else { 0.0 };
                let d = if theme.reduce_motion {
                    Duration::ZERO
                } else {
                    motion::PAGE_BLEND.duration
                };
                s.level = Tween {
                    from,
                    to: 1.0,
                    start: now,
                    duration: d,
                    easing: motion::PAGE_BLEND.easing,
                };
            }
            if s.level.settled(now) {
                s.under = None;
            }
        });
        let s = state.read(cx);
        let under = s.under.clone();
        let blending = under.is_some();
        let level = if blending {
            s.level.value(now).clamp(0.0, 1.0)
        } else {
            1.0
        };
        if blending {
            window.request_animation_frame();
        }
        let render = self.render.clone();
        div()
            .relative()
            .size_full()
            .when_some(under, |el, key| {
                el.child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .child(render(&key, 1.0, window, cx)),
                )
            })
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .when(blending, |el| el.opacity(level))
                    .child((self.render)(&self.page, level, window, cx)),
            )
    }
}

pub struct PushState {
    current: SharedString,
    index: usize,
    leaving: Option<(SharedString, f32)>,
    progress: Tween,
    outline: Tween,
}

#[derive(IntoElement)]
pub struct Push {
    id: ElementId,
    panel: SharedString,
    index: usize,
    render: Render,
}

impl Push {
    /// Shows `panel` (the `index`-th of its row, which sets the direction).
    pub fn new(
        id: impl Into<ElementId>,
        panel: impl Into<SharedString>,
        index: usize,
        render: impl Fn(&SharedString, &mut Window, &mut App) -> AnyElement + 'static,
    ) -> Push {
        Push {
            id: id.into(),
            panel: panel.into(),
            index,
            render: Rc::new(render),
        }
    }
}

impl RenderOnce for Push {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let reduce = theme.reduce_motion;
        let (panel, index) = (self.panel.clone(), self.index);
        let state: Entity<PushState> =
            window.use_keyed_state(self.id.clone(), cx, |_, _| PushState {
                current: panel.clone(),
                index,
                leaving: None,
                progress: Tween::still(1.0),
                outline: Tween::still(0.0),
            });
        let now = anim::now();
        state.update(cx, |s, _| {
            if s.current != panel {
                // Forward pushes the old block left, back pushes it right.
                let dir = if index >= s.index { 1.0 } else { -1.0 };
                s.leaving = Some((s.current.clone(), dir));
                s.current = panel.clone();
                s.index = index;
                let d = if reduce {
                    Duration::ZERO
                } else {
                    motion::PUSH.duration
                };
                s.progress = Tween {
                    from: 0.0,
                    to: 1.0,
                    start: now,
                    duration: d,
                    easing: motion::PUSH.easing,
                };
                s.outline = Tween::still(1.0);
            }
            if s.leaving.is_some() && s.progress.settled(now) {
                s.leaving = None;
                let d = if reduce {
                    Duration::ZERO
                } else {
                    motion::PUSH_OUTLINE_FADE
                };
                s.outline.retarget(0.0, now, d, Easing::EASE_OUT);
            }
        });
        let s = state.read(cx);
        let t = s.progress.value(now);
        let leaving = s.leaving.clone();
        let outline = s.outline.value(now);
        if leaving.is_some() || !s.outline.settled(now) {
            window.request_animation_frame();
        }
        let dir = leaving.as_ref().map_or(1.0, |(_, d)| *d);
        let render = self.render.clone();
        let edge = canvas(
            |_, _, _| (),
            move |bounds, _, window, cx| {
                if outline <= 0.003 {
                    return;
                }
                let look = Look {
                    opacity: outline,
                    g: 1.0,
                    sp: 0.4,
                    rim: 3.0,
                    bleed_lift: p.bleed_lift,
                    ..Look::new(p.glass_clear, glass::DENSE)
                };
                glass::paint_rim(bounds, 0.0, &look, Ground::Uneven, window, cx);
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        div()
            .relative()
            .size_full()
            .overflow_hidden()
            .when_some(leaving, |el, (key, d)| {
                el.child(
                    div()
                        .absolute()
                        .top_0()
                        .size_full()
                        .left(relative(-d * t))
                        .child(render(&key, window, cx)),
                )
            })
            .child(
                div()
                    .absolute()
                    .top_0()
                    .size_full()
                    .left(relative(dir * (1.0 - t)))
                    .child((self.render)(&self.panel, window, cx))
                    .child(edge),
            )
    }
}
