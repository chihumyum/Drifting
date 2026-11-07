//! The custom titlebar. The window's content runs under it (`appears_transparent`),
//! so the app paints the strip itself and tells the platform which parts drag
//! the window and which are its buttons.
//!
//! - macOS keeps the native traffic lights, moved to [`TRAFFIC_LIGHT_POSITION`].
//!   The app owns titlebar dragging (`app_owns_titlebar_drag`), so a press that
//!   moves starts a native window drag and a double click does what the system
//!   setting says (zoom, minimize or nothing).
//! - Windows has no system buttons once the titlebar is hidden. The app draws
//!   minimize / maximize / close and marks them as window control areas, so
//!   the system still handles them (Snap layouts on hover included) and the
//!   rest of the strip is the caption.

use gpui::{
    Context, InteractiveElement, IntoElement, MouseButton, ParentElement, Pixels, Point, Render,
    StatefulInteractiveElement, Styled, Window, WindowControlArea, div, point, px,
};

use crate::appearance::{self, Palette};

/// The height of the titlebar row, as in the 0.1 client.
pub const TITLEBAR_HEIGHT: Pixels = px(42.);

/// Where the close button's top-left corner sits, from the window's top-left
/// corner. GPUI centres the buttons in a strip `2 * y` taller than they are,
/// so with 14 pt buttons `y = 14` centres them on the 42 pt row. The 0.1
/// client's Tauri value is (18, 23); Tauri measures `y` differently.
pub const TRAFFIC_LIGHT_POSITION: Point<Pixels> = point(px(18.), px(14.));

/// Where titlebar content may start on macOS, clear of the traffic lights
/// (the 0.1 client's `--window-header-leading-inset`).
pub const LEADING_INSET: Pixels = px(94.);

/// Width of one Windows caption button.
const CAPTION_BUTTON_WIDTH: Pixels = px(46.);

/// Which platform conventions the strip follows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TitlebarStyle {
    /// Native traffic lights on the leading edge.
    Mac,
    /// App-drawn caption buttons on the trailing edge.
    Windows,
}

impl TitlebarStyle {
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Windows
        }
    }
}

pub struct TitleBar {
    title: &'static str,
    /// A left press inside the strip that has not moved yet (macOS).
    drag_armed: bool,
}

impl TitleBar {
    pub fn new(title: &'static str) -> Self {
        Self {
            title,
            drag_armed: false,
        }
    }
}

impl Render for TitleBar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = Palette::for_appearance(appearance::current(window, cx));
        let style = TitlebarStyle::current();

        let strip = div()
            .id("titlebar")
            .flex()
            .flex_row()
            .flex_none()
            .items_center()
            .w_full()
            .h(TITLEBAR_HEIGHT)
            .bg(palette.titlebar)
            .border_b_1()
            .border_color(palette.hairline)
            .text_color(palette.muted)
            .text_sm();

        let title = div()
            .flex_1()
            .flex()
            .justify_center()
            .overflow_hidden()
            .child(self.title);

        match style {
            TitlebarStyle::Mac => strip
                .pl(LEADING_INSET)
                // Keep the trailing side symmetric so the title stays centred.
                .pr(LEADING_INSET)
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, _, _, _| this.drag_armed = true),
                )
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(|this, _, _, _| this.drag_armed = false),
                )
                .on_mouse_move(cx.listener(|this, _, window, _| {
                    if this.drag_armed {
                        this.drag_armed = false;
                        window.start_window_move();
                    }
                }))
                .on_click(|event, window, _| {
                    if event.click_count() == 2 {
                        window.titlebar_double_click();
                    }
                })
                .child(title),
            TitlebarStyle::Windows => strip
                .window_control_area(WindowControlArea::Drag)
                .pl(CAPTION_BUTTON_WIDTH * 3.)
                .child(title)
                .child(caption_buttons(window, palette)),
        }
    }
}

fn caption_buttons(window: &Window, palette: Palette) -> impl IntoElement {
    // Segoe MDL2 Assets ships with Windows 10 and 11.
    let maximize_glyph = if window.is_maximized() {
        "\u{E923}"
    } else {
        "\u{E922}"
    };
    div()
        .flex()
        .flex_row()
        .flex_none()
        .h_full()
        .font_family("Segoe MDL2 Assets")
        .text_size(px(10.))
        .text_color(palette.text)
        .child(caption_button(
            "minimize",
            "\u{E921}",
            WindowControlArea::Min,
            palette.control_hover,
        ))
        .child(caption_button(
            "maximize",
            maximize_glyph,
            WindowControlArea::Max,
            palette.control_hover,
        ))
        .child(caption_button(
            "close",
            "\u{E8BB}",
            WindowControlArea::Close,
            palette.close_hover,
        ))
}

fn caption_button(
    id: &'static str,
    glyph: &'static str,
    area: WindowControlArea,
    hover: gpui::Rgba,
) -> impl IntoElement {
    div()
        .id(id)
        .flex()
        .items_center()
        .justify_center()
        .w(CAPTION_BUTTON_WIDTH)
        .h_full()
        .window_control_area(area)
        .hover(move |style| style.bg(hover))
        .child(glyph)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_traffic_lights_sit_inside_the_titlebar_row() {
        // macOS draws 14 pt buttons; GPUI centres them in a 14 + 2y strip.
        let button = px(14.);
        assert_eq!(button + TRAFFIC_LIGHT_POSITION.y * 2., TITLEBAR_HEIGHT);
        // Three buttons, 6 pt apart, end before the leading inset.
        let lights_end = TRAFFIC_LIGHT_POSITION.x + button * 3. + px(6.) * 2.;
        assert!(lights_end < LEADING_INSET);
    }

    #[test]
    fn each_platform_gets_its_own_buttons() {
        let expected = if cfg!(target_os = "macos") {
            TitlebarStyle::Mac
        } else {
            TitlebarStyle::Windows
        };
        assert_eq!(TitlebarStyle::current(), expected);
    }
}
