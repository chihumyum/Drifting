//! A multi-line field in a frame, the 0.1 client's `ui-field--area`: a
//! paper slip with a resting line of glass (selected while the caret is in
//! it), 8 × 12 px inside, 16 px corners, at least a few lines high, around
//! dr-ui's frameless [`TextArea`]. The bookshelf's summary and Project
//! Home's 本书简介 use it; dr-ui has the frameless area only (m01-shelf.md,
//! 「待协调」).

use dr_ui::{
    Theme,
    fonts::Role,
    glass::{self, Kind, Mode, Spec, Tone},
    input::area::TextArea,
    style::DrStyled,
    tokens::radius,
};
use gpui::{
    AnyElement, App, CursorStyle, ElementId, Entity, Focusable as _, InteractiveElement as _,
    IntoElement as _, MouseButton, ParentElement as _, Styled as _, Window, div, px,
};

/// `field` framed, at least `rows` lines high (the 0.1 client: 3 in a
/// dialog, 4 for 本书简介).
pub fn area(
    id: impl Into<ElementId>,
    field: &Entity<TextArea>,
    rows: f32,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let handle = field.focus_handle(cx);
    let focused = handle.is_focused(window);
    glass::glass_box(
        id,
        Kind::Rest,
        Mode::default(),
        focused,
        Spec::new(Tone::Clear, radius::SHEET).filled(p.page),
        window,
        cx,
    )
    .w_full()
    .px(px(12.0))
    .py(px(8.0))
    .rounded(px(radius::SHEET))
    .bg(p.page.solid())
    .font_role(Role::Ui)
    .type_px(s.body, s.line_body)
    .text_color(p.ink(1).solid())
    .cursor(CursorStyle::IBeam)
    // A press on the frame's padding puts the caret in the field too.
    .on_mouse_down(MouseButton::Left, move |_, window, cx| {
        handle.focus(window, cx)
    })
    .child(
        div()
            .w_full()
            .min_h(px(s.line_body * rows))
            .child(field.clone()),
    )
    .into_any_element()
}
