//! The window's own chrome: where the traffic lights sit, which strips move
//! the window, the two sidebar toggles fixed in the top corners, and the
//! Windows caption pill (workspace.md, 「Persistence and responsive
//! behavior」; P0-A for the titlebar mechanics).

use dr_ui::{
    components::IconButton,
    glass::{self, Kind, Mode, Spec, Tone},
    sand::Icon,
    tokens::glass as g,
};
use gpui::{
    App, Context, InteractiveElement, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent,
    ParentElement, Pixels, Point, SharedString, Stateful, StatefulInteractiveElement, Styled,
    Window, WindowControlArea, div, point, px,
};

use super::Workspace;
use crate::actions::{ToggleLeftSidebar, ToggleRightSidebar};
use crate::strings::t;
use dr_i18n::keys;

/// The window-controls row (`--window-titlebar-height`): the traffic lights,
/// the toggles, the dock and the sidebars' tab rows share its centre line.
pub const TITLEBAR_HEIGHT: f32 = 42.0;

/// The close button's top-left corner. GPUI centres the 14pt buttons in a
/// strip `2 * y` taller, so `y = 14` centres them on the 42pt row (the 0.1
/// client's Tauri value is (18, 23); Tauri measures `y` differently).
pub const TRAFFIC_LIGHT_POSITION: Point<Pixels> = point(px(18.), px(14.));

/// Where the left toggle and the first tab row start, clear of the window
/// controls: macOS 94px, Windows 110px (8 + the 96px caption pill + 6).
pub const LEADING_INSET: f32 = if cfg!(target_os = "windows") {
    110.0
} else {
    94.0
};

/// The right toggle's distance from the window's right edge.
pub const TRAILING_INSET: f32 = 8.0;

/// The gap between a toggle and the tabs beside it.
pub const TOGGLE_GAP: f32 = 6.0;

/// Makes `el` a strip that moves the window: on macOS a press that moves
/// starts a native window drag and a double click does what the system
/// setting says; on Windows the strip is the caption.
pub fn drag_region(el: Stateful<gpui::Div>, cx: &mut Context<Workspace>) -> Stateful<gpui::Div> {
    if cfg!(target_os = "windows") {
        return el.window_control_area(WindowControlArea::Drag);
    }
    el.on_mouse_down(
        MouseButton::Left,
        cx.listener(|ws, e: &MouseDownEvent, _, _| ws.drag_armed = e.click_count == 1),
    )
    .on_mouse_up(
        MouseButton::Left,
        cx.listener(|ws, _, _, _| ws.drag_armed = false),
    )
    .on_mouse_move(cx.listener(|ws, e: &MouseMoveEvent, window, _| {
        if ws.drag_armed && e.pressed_button == Some(MouseButton::Left) {
            ws.drag_armed = false;
            window.start_window_move();
        }
    }))
    .on_click(|e, window, _| {
        if e.click_count() == 2 {
            window.titlebar_double_click();
        }
    })
}

/// The two sidebar toggles: a 28px round glass button in each top corner,
/// fixed; the sidebar slides out from under it. Closed, the toggle floats
/// on the desk (a resting line on an opaque fill) with a hollow moon; open,
/// the moon is solid ink and the glass shows only under the hand.
pub fn sidebar_toggles(
    ws: &Workspace,
    _: &mut Window,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let top = (TITLEBAR_HEIGHT - g::ROUND) / 2.0;
    use keys::left_sidebar::top as lt;
    use keys::right_sidebar::top as rt;
    let toggle = |id: &'static str, open: bool, icons: (Icon, Icon), label: SharedString| {
        let button = IconButton::new(id, if open { icons.0 } else { icons.1 }).label(label);
        if open {
            button.in_tray()
        } else {
            button.floating()
        }
    };
    let left = toggle(
        "toggle-left",
        ws.left.open,
        (Icon::MoonLeft, Icon::MoonLeftHollow),
        t(cx, if ws.left.open { lt::CLOSE } else { lt::OPEN }),
    )
    .on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleLeftSidebar), cx));
    let right = toggle(
        "toggle-right",
        ws.right.open,
        (Icon::MoonRight, Icon::MoonRightHollow),
        t(cx, if ws.right.open { rt::CLOSE } else { rt::OPEN }),
    )
    .on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleRightSidebar), cx));
    div()
        .absolute()
        .top_0()
        .left_0()
        .right_0()
        .h(px(TITLEBAR_HEIGHT))
        .child(
            div()
                .absolute()
                .top(px(top))
                .left(px(LEADING_INSET))
                .child(closed_anchor(
                    !ws.left.open,
                    crate::pages::anchors::LEFT_SIDEBAR_CLOSED_TOGGLE,
                    left,
                    cx,
                )),
        )
        .child(
            div()
                .absolute()
                .top(px(top))
                .right(px(TRAILING_INSET))
                .child(closed_anchor(
                    !ws.right.open,
                    crate::pages::anchors::RIGHT_SIDEBAR_CLOSED_TOGGLE,
                    right,
                    cx,
                )),
        )
}

/// Hides or shows the window's traffic lights (immersive writing, M26) by
/// their alpha. AppKit lays the title bar out again when the alpha
/// changes and drops the custom position (the 0.1 client measured the
/// close button jumping from x 18 to 9), so the buttons' and their
/// container's frames are read first and put back in the same turn.
#[cfg(target_os = "macos")]
pub fn set_traffic_lights_hidden(window: &Window, hidden: bool) {
    use objc2_app_kit::{NSView, NSWindowButton};
    use raw_window_handle::RawWindowHandle;

    let Ok(handle) = raw_window_handle::HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
        return;
    };
    // SAFETY: GPUI hands out its window's content view, alive while the
    // window is; this runs on the main thread.
    let view: &NSView = unsafe { appkit.ns_view.cast::<NSView>().as_ref() };
    let Some(ns_window) = view.window() else {
        return;
    };
    let buttons: Vec<_> = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .filter_map(|b| ns_window.standardWindowButton(b))
    .collect();
    let frames: Vec<_> = buttons.iter().map(|b| b.frame()).collect();
    // SAFETY: the title bar's view outlives this turn; main thread.
    let container = buttons.first().and_then(|b| unsafe { b.superview() });
    let container_frame = container.as_ref().map(|c| c.frame());
    for button in &buttons {
        button.setAlphaValue(if hidden { 0.0 } else { 1.0 });
    }
    for (button, frame) in buttons.iter().zip(frames) {
        button.setFrame(frame);
    }
    if let (Some(container), Some(frame)) = (container, container_frame) {
        container.setFrame(frame);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_traffic_lights_hidden(_: &Window, _: bool) {}

/// A sidebar's toggle, marked for M24's tour only while the sidebar is
/// closed (it floats then).
fn closed_anchor(
    closed: bool,
    id: &'static str,
    toggle: impl IntoElement,
    cx: &App,
) -> gpui::AnyElement {
    if closed {
        crate::pages::anchor(id, toggle, cx)
    } else {
        toggle.into_any_element()
    }
}

/// Windows: close, minimize, maximize as a glass pill in the top-left
/// corner where the traffic lights are, in their order (the 0.1 client's
/// `WindowsCaption`). Nothing on macOS.
pub fn windows_caption(window: &mut Window, cx: &mut App) -> impl IntoElement {
    let mut row = div().absolute().top_0().left_0();
    if !cfg!(target_os = "windows") {
        return row;
    }
    let max_icon = if window.is_maximized() {
        Icon::WindowRestore
    } else {
        Icon::WindowMax
    };
    use keys::window_caption as wc;
    let max_label = if window.is_maximized() {
        wc::RESTORE
    } else {
        wc::MAXIMIZE
    };
    let labels: [SharedString; 3] = [wc::CLOSE, wc::MINIMIZE, max_label].map(|k| t(cx, k));
    let button = |id: &'static str, icon: Icon, area: WindowControlArea, label: &SharedString| {
        // The outer element is the system's caption button area; the name
        // goes on the button (only an element with a role reaches the
        // accessibility tree).
        div()
            .id(id)
            .window_control_area(area)
            .child(IconButton::new(id, icon).label(label.clone()).in_tray())
    };
    let top = (TITLEBAR_HEIGHT - g::ROUND) / 2.0 - g::TRAY_PADDING;
    // The toolbar's tray: a resting glass line, no fill (the sidebar shows
    // through; 2026-11-05).
    let tray = glass::glass_box(
        "caption",
        Kind::Surface,
        Mode::default(),
        false,
        Spec::new(Tone::Clear, g::ROUND / 2.0 + g::TRAY_PADDING),
        window,
        cx,
    );
    row = row.child(
        div().absolute().top(px(top)).left(px(8.0)).child(
            tray.p(px(g::TRAY_PADDING))
                .flex()
                .flex_row()
                .gap(px(2.0))
                .rounded_full()
                .child(button(
                    "caption-close",
                    Icon::Close,
                    WindowControlArea::Close,
                    &labels[0],
                ))
                .child(button(
                    "caption-min",
                    Icon::Minus,
                    WindowControlArea::Min,
                    &labels[1],
                ))
                .child(button(
                    "caption-max",
                    max_icon,
                    WindowControlArea::Max,
                    &labels[2],
                )),
        ),
    );
    row
}
