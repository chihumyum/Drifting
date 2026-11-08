//! The dropdown select (components.md, 「下拉选择」): for more than four
//! choices, or choices that are things (storylines, categories). The
//! trigger is a single-line field holding the current choice's mark, its
//! name and a brush fold at the end; opened, it floats a menu list as wide
//! as the trigger and never narrower than 240, each choice with its mark,
//! the current one in medium weight with a tick.

use std::rc::Rc;

use gpui::{
    App, Bounds, ElementId, Entity, InteractiveElement, IntoElement, ParentElement, Pixels,
    RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::{
    fonts::Role,
    glass::{self, Kind, Mode, Spec, Tone},
    sand::{self, Icon},
    style::{DrStyled, child_id},
    theme::Theme,
    tokens::radius,
};

use super::{
    menu::{Menu, MenuItem, RowIcon, row_icon},
    overlay::{self, Layer, Place},
};

#[derive(Clone, Debug)]
pub struct Choice {
    pub label: SharedString,
    pub icon: RowIcon,
}

impl Choice {
    pub fn new(icon: impl Into<RowIcon>, label: impl Into<SharedString>) -> Choice {
        Choice {
            label: label.into(),
            icon: icon.into(),
        }
    }
}

pub struct SelectState {
    open: bool,
    bounds: Option<Bounds<Pixels>>,
}

#[derive(IntoElement)]
pub struct Select {
    id: ElementId,
    choices: Vec<Choice>,
    selected: usize,
    open: Option<bool>,
    disabled: bool,
    on_change: Option<super::OnIndex>,
}

impl Select {
    pub fn new(id: impl Into<ElementId>, choices: Vec<Choice>, selected: usize) -> Select {
        Select {
            id: id.into(),
            choices,
            selected,
            open: None,
            disabled: false,
            on_change: None,
        }
    }

    /// Holds the list open (galleries, captures).
    pub fn force_open(mut self, open: bool) -> Self {
        self.open = Some(open);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Called with the chosen index when the author picks another.
    pub fn on_change(mut self, f: impl Fn(usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(f));
        self
    }
}

impl RenderOnce for Select {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let state: Entity<SelectState> =
            window.use_keyed_state(child_id(&self.id, "select"), cx, |_, _| SelectState {
                open: false,
                bounds: None,
            });
        if let Some(open) = self.open {
            state.update(cx, |st, _| st.open = open);
        }
        let open = state.read(cx).open;
        let current = self.choices.get(self.selected).cloned();
        let current_label = current.as_ref().map(|c| c.label.clone());
        let bounds_cell = overlay::use_bounds(child_id(&self.id, "bounds"), window, cx);
        let toggle = state.clone();
        let disabled = self.disabled;
        if disabled {
            state.update(cx, |st, _| st.open = false);
        }
        let open = open && !disabled;
        let trigger = glass::glass_box(
            self.id.clone(),
            Kind::Rest,
            Mode {
                disabled,
                ..Mode::default()
            },
            open,
            Spec::new(Tone::Clear, radius::SM).filled(p.page),
            window,
            cx,
        )
        .h(px(s.control_height))
        .min_w(px(160.0))
        .px(px(10.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .rounded(px(radius::SM))
        .bg(p.page.solid())
        .font_role(Role::Ui)
        .type_px(s.body, s.line_body)
        .text_color(if disabled { p.ink(4) } else { p.ink(1) }.solid())
        .when(!disabled, |el| el.cursor_pointer())
        // In the accessibility tree as a combo box named by its choice.
        .role(gpui::Role::ComboBox)
        .when_some(current_label, |el, l| el.aria_label(l))
        .child(overlay::probe(bounds_cell.clone()))
        .when_some(current, |el, c| {
            el.child(row_icon(c.icon, &self.id, p.ink(2).solid()))
                .child(div().flex_1().min_w_0().truncate().child(c.label))
        })
        .child(sand::icon(Icon::ChevronDown, 14.0, p.ink(3).solid()))
        .on_click(move |_, _, cx| {
            if disabled {
                return;
            }
            toggle.update(cx, |st, cx| {
                st.open = !st.open;
                cx.notify();
            })
        });
        let bounds = *bounds_cell.read(cx);
        state.update(cx, |st, _| st.bounds = bounds);
        let list = (open && bounds.is_some()).then(|| {
            let b = bounds.expect("checked");
            let mut menu = Menu::new(child_id(&self.id, "list")).at_least(f32::from(b.size.width));
            for (i, c) in self.choices.iter().enumerate() {
                let f = self.on_change.clone();
                let close = state.clone();
                menu = menu.item(
                    MenuItem::new(
                        child_id(&self.id, format!("choice-{i}")),
                        c.icon,
                        c.label.clone(),
                    )
                    .checked(i == self.selected)
                    .on_click(move |_, w, cx| {
                        close.update(cx, |st, cx| {
                            st.open = false;
                            cx.notify();
                        });
                        if let Some(f) = &f {
                            f(i, w, cx);
                        }
                    }),
                );
            }
            let dismiss = state.clone();
            overlay::float(
                Place::below(b, 4.0),
                Layer::Popover,
                div()
                    .on_mouse_down_out(move |_, _, cx| {
                        dismiss.update(cx, |st, cx| {
                            st.open = false;
                            cx.notify();
                        })
                    })
                    .child(menu),
            )
        });
        div().relative().child(trigger).children(list)
    }
}
