//! A sidebar half's tab row: words side by side, a glass block under the
//! selected one that slides with the panel's push (265 ms, the same curve,
//! landing together; motion.md 「重冰推进」).
//!
//! It is dr-ui's `Segmented` block with two differences the sidebar needs:
//! the push timing instead of the spring, and a click on the selected tab
//! is reported (it closes the half). Built from dr-ui's glass painter; see
//! f6-shell.md 「待协调」 for moving it into dr-ui.

use std::{rc::Rc, time::Instant};

use dr_ui::{
    Theme, anim,
    fonts::Role,
    glass::{self, DENSE, Ground, Look},
    style::DrStyled,
    tokens::motion,
};
use gpui::{
    App, Bounds, ElementId, Entity, InteractiveElement, IntoElement, MouseButton, ParentElement,
    Pixels, RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, canvas, div,
    prelude::FluentBuilder as _, px,
};

type OnClick = Rc<dyn Fn(usize, &mut Window, &mut App)>;

#[derive(Default)]
pub struct TabsState {
    rects: Vec<Option<(f32, f32)>>,
    selected: usize,
    from: Option<(f32, f32)>,
    start: Option<Instant>,
}

impl TabsState {
    fn block_at(&self, at: Instant) -> Option<(f32, f32)> {
        let (tx, tw) = (*self.rects.get(self.selected)?)?;
        match (self.from, self.start) {
            (Some((fx, fw)), Some(start)) => {
                let t = motion::PUSH.duration.as_secs_f32();
                let p = (at.saturating_duration_since(start).as_secs_f32() / t).clamp(0.0, 1.0);
                let e = motion::PUSH.easing.at(p);
                Some((fx + (tx - fx) * e, fw + (tw - fw) * e))
            }
            _ => Some((tx, tw)),
        }
    }

    fn moving(&self, at: Instant) -> bool {
        self.start
            .is_some_and(|s| at.saturating_duration_since(s) < motion::PUSH.duration)
    }
}

#[derive(IntoElement)]
pub struct PanelTabs {
    id: ElementId,
    labels: Vec<SharedString>,
    selected: usize,
    on_click: Option<OnClick>,
}

impl PanelTabs {
    pub fn new(id: impl Into<ElementId>, labels: Vec<SharedString>, selected: usize) -> Self {
        PanelTabs {
            id: id.into(),
            labels,
            selected,
            on_click: None,
        }
    }

    /// Any tab clicked, the selected one included.
    pub fn on_click(mut self, f: impl Fn(usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(f));
        self
    }
}

/// The tab label's size: 13px at the standard size (workspace.md).
pub fn label_size(theme: &Theme) -> f32 {
    theme.scale.caption - 1.0
}

/// Horizontal padding of one tab.
pub const TAB_PAD: f32 = 10.0;

impl RenderOnce for PanelTabs {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let n = self.labels.len();
        let selected = self.selected;
        let reduce = theme.reduce_motion;
        let state: Entity<TabsState> =
            window.use_keyed_state(self.id.clone(), cx, |_, _| TabsState {
                selected,
                ..TabsState::default()
            });
        state.update(cx, |st, _| {
            st.rects.resize(n, None);
            if st.selected != selected {
                let at = anim::now();
                st.from = if reduce { None } else { st.block_at(at) };
                st.start = (!reduce).then_some(at);
                st.selected = selected;
            }
        });
        let height = theme.scale.control_height - 4.0;
        let block_state = state.clone();
        let block = canvas(
            |_, _, _| (),
            move |bounds, _, window, cx| {
                let now = anim::now();
                let st = block_state.read(cx);
                let Some((x, w)) = st.block_at(now) else {
                    return;
                };
                let rect = Bounds {
                    origin: gpui::point(px(x), bounds.origin.y),
                    size: gpui::size(px(w), bounds.size.height),
                };
                let outside = match glass::current_ground() {
                    Some(Ground::Flat { inside, .. }) => inside,
                    _ => p.desk,
                };
                window.paint_quad(gpui::fill(rect, p.page.solid()));
                let travelled = st.from.map(|(fx, _)| (x - fx).abs() * 1.2).unwrap_or(0.0);
                let look = Look {
                    flow: travelled,
                    bleed_lift: p.bleed_lift,
                    ..Look::new(p.glass_clear, DENSE)
                };
                glass::paint_rim(
                    rect,
                    0.0,
                    &look,
                    Ground::Flat {
                        inside: p.page,
                        outside,
                    },
                    window,
                    cx,
                );
                anim::keep_going(st.moving(now), window);
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        let mut row = div()
            .id(self.id.clone())
            .relative()
            .h(px(height))
            .flex()
            .flex_row()
            .flex_none()
            .items_stretch()
            .font_role(Role::Structure)
            .type_px(label_size(&theme), height)
            .child(block);
        for (i, label) in self.labels.into_iter().enumerate() {
            let on = i == selected;
            let ink = if on { p.ink(1) } else { p.ink(3) };
            let hover = p.ink(2).solid();
            let f = self.on_click.clone();
            let measure_state = state.clone();
            row = row.child(
                div()
                    .id(dr_ui::style::child_id(&self.id, label.clone()))
                    .relative()
                    .px(px(TAB_PAD))
                    .flex()
                    .items_center()
                    .text_color(ink.solid())
                    .cursor_pointer()
                    .when(!on, |el| el.hover(move |st| st.text_color(hover)))
                    .child(
                        canvas(
                            move |bounds: Bounds<Pixels>, _, cx| {
                                let x = f32::from(bounds.origin.x);
                                let w = f32::from(bounds.size.width);
                                measure_state.update(cx, |st, _| {
                                    if let Some(slot) = st.rects.get_mut(i) {
                                        *slot = Some((x, w));
                                    }
                                });
                            },
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full(),
                    )
                    .child(label)
                    // A press on a tab is not a window drag.
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .when_some(f, |el, f| el.on_click(move |_, w, cx| f(i, w, cx))),
            );
        }
        row
    }
}
