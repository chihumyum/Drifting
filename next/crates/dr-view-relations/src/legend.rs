//! The canvas legend shared by Super Views. The host owns filtering and the
//! type editor; this surface only renders their rows and forwards actions.

use std::rc::Rc;

use dr_ui::{
    Theme,
    fonts::Role,
    glass::{self, Kind as GlassKind, Mode, Spec, Tone},
    style::DrStyled as _,
    tokens::{Rgb, radius},
};
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

pub struct Row {
    pub id: String,
    pub label: SharedString,
    pub count: usize,
    pub color: Rgb,
    pub visible: bool,
    pub hint: SharedString,
    /// Prose co-occurrence uses grains; explicit relations use a short line.
    pub sand: bool,
}

pub type Toggle = Rc<dyn Fn(&str, &mut Window, &mut App)>;
pub type Edit = Rc<dyn Fn(&mut Window, &mut App)>;

pub struct Legend {
    pub id: &'static str,
    pub rows: Vec<Row>,
    pub empty: SharedString,
    pub edit_label: SharedString,
    pub edit_id: &'static str,
    pub toggle: Toggle,
    pub edit: Edit,
}

pub fn render(legend: Legend, window: &mut Window, cx: &mut App) -> AnyElement {
    let theme = Theme::of(window, cx);
    let locale = dr_shell::strings::Strings::get(cx).locale();
    let p = theme.palette;
    let mut surface = glass::glass_box(
        legend.id,
        GlassKind::Rest,
        Mode::default(),
        false,
        Spec::new(Tone::Clear, radius::MD),
        window,
        cx,
    )
    .p(px(6.0))
    .min_w(px(150.0))
    .max_w(px(240.0))
    .bg(p.paper.alpha(0.94))
    .flex()
    .flex_col()
    .gap(px(2.0))
    .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation());

    if legend.rows.is_empty() {
        surface = surface.child(
            div()
                .px(px(6.0))
                .py(px(3.0))
                .font_role(Role::Index)
                .type_px(10.5, 15.0)
                .text_color(p.muted().solid())
                .child(legend.empty),
        );
    }
    for row in legend.rows {
        let toggle = legend.toggle.clone();
        let row_id = row.id.clone();
        let line_color = row.color.alpha(if row.visible { 1.0 } else { 0.25 });
        let mark = if row.sand {
            crate::look::dotted_rule(row.color).into_any_element()
        } else {
            div().w_full().h(px(1.5)).bg(line_color).into_any_element()
        };
        surface = surface.child(
            div()
                .id(ElementId::Name(row.id.into()))
                .role(gpui::Role::Button)
                .aria_label(row.hint)
                .px(px(6.0))
                .py(px(3.0))
                .rounded(px(radius::SM))
                .cursor_pointer()
                .hover(|s| s.bg(p.rule.alpha(0.18)))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .on_click(move |_, window, cx| toggle(&row_id, window, cx))
                .child(div().w(px(16.0)).flex_none().child(mark))
                .child(
                    div()
                        .flex_1()
                        .font_role(Role::Ui)
                        .type_px(11.0, 15.0)
                        .text_color(p.ink(2).alpha(if row.visible { 1.0 } else { 0.45 }))
                        .child(row.label),
                )
                .child(
                    div()
                        .font_role(Role::Index)
                        .type_px(10.0, 14.0)
                        .text_color(p.muted().alpha(if row.visible { 1.0 } else { 0.45 }))
                        .child(dr_i18n::number::grouped(row.count as u64, locale)),
                ),
        );
    }
    surface
        .child(
            div()
                .id(legend.edit_id)
                .role(gpui::Role::Button)
                .aria_label(legend.edit_label.clone())
                .mt(px(2.0))
                .px(px(6.0))
                .py(px(3.0))
                .rounded(px(radius::SM))
                .cursor_pointer()
                .hover(|s| s.bg(p.rule.alpha(0.18)))
                .font_role(Role::Index)
                .type_px(10.5, 15.0)
                .text_color(p.ink(3).solid())
                .on_click(move |_, window, cx| (legend.edit)(window, cx))
                .child(legend.edit_label),
        )
        .into_any_element()
}
