//! The window's own chrome: where the traffic lights sit, which strips move
//! the window, the buttons fixed right of the traffic lights (全部项目, the
//! Project Home, the notification center, the account menu and the left
//! sidebar's toggle), the right sidebar's toggle in the other corner, and
//! the Windows caption pill (workspace.md, 「Persistence and responsive
//! behavior」; P0-A for the titlebar mechanics).

use dr_ui::{
    Theme,
    components::{IconButton, overlay},
    glass::{self, Kind, Mode, Spec, Tone},
    sand::Icon,
    tokens::glass as g,
};
use gpui::{
    AnyElement, App, Bounds, Context, Entity, InteractiveElement, IntoElement, MouseButton,
    MouseDownEvent, MouseMoveEvent, ParentElement, Pixels, Point, SharedString, Stateful,
    StatefulInteractiveElement, Styled, Window, WindowControlArea, div, point,
    prelude::FluentBuilder as _, px,
};

use super::Workspace;
use crate::actions::{
    ShowProjectHome, ToggleLeftSidebar, ToggleNotifications, ToggleProjects, ToggleRightSidebar,
};
use crate::notifications::Notifications;
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

/// How many buttons stand right of the traffic lights: 全部项目, the Project
/// Home, the notification center, the account menu and the left sidebar's
/// toggle, in that order (author 2026-11-14; they were the left sidebar's
/// foot before).
pub const CLUSTER: usize = 5;

/// Where those buttons end: the left toggle's right edge.
pub const CLUSTER_END: f32 =
    LEADING_INSET + CLUSTER as f32 * g::ROUND + (CLUSTER as f32 - 1.0) * TOGGLE_GAP;

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

/// The buttons right of the traffic lights and the right sidebar's toggle:
/// 28px round glass, fixed; the sidebars slide out from under them. While
/// the left sidebar is closed the five on the left float on the desk (a
/// resting line on an opaque fill) and its moon is hollow; open, the glass
/// shows only under the hand. The right toggle does the same for the right
/// sidebar.
pub fn sidebar_toggles(
    ws: &Workspace,
    window: &mut Window,
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
    let cluster = cluster(ws, left, window, cx);
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
                .child(cluster),
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
/// their alpha. AppKit lays `NSTitlebarContainerView` (the buttons'
/// grandparent) out again when the alpha changes, shrinking it from GPUI's
/// 42 pt strip back to native height and shifting the buttons upward, so we
/// flush any pending titlebar layout and re-apply [`TRAFFIC_LIGHT_POSITION`]
/// through GPUI in the same turn.
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
    for button in &buttons {
        button.setAlphaValue(if hidden { 0.0 } else { 1.0 });
    }
    // SAFETY: the title bar's views outlive this turn on the main thread.
    if let Some(titlebar_container) = buttons
        .first()
        .and_then(|b| unsafe { b.superview() })
        .and_then(|v| unsafe { v.superview() })
    {
        titlebar_container.layoutSubtreeIfNeeded();
    }
    window.set_traffic_light_position(TRAFFIC_LIGHT_POSITION);
}

#[cfg(not(target_os = "macos"))]
pub fn set_traffic_lights_hidden(_: &Window, _: bool) {}

/// Puts the window controls back at [`TRAFFIC_LIGHT_POSITION`]. Only macOS
/// lets an app place them (GPUI has no such call on other platforms), so
/// elsewhere there is nothing to do.
#[cfg(target_os = "macos")]
pub fn place_traffic_lights(window: &Window) {
    window.set_traffic_light_position(TRAFFIC_LIGHT_POSITION);
}

#[cfg(not(target_os = "macos"))]
pub fn place_traffic_lights(_: &Window) {}

/// A sidebar's toggle, marked for M24's tour only while the sidebar is
/// closed (it floats then).
/// 全部项目, the Project Home, the notification center, the account menu,
/// then `left` (the left sidebar's toggle).
fn cluster(
    ws: &Workspace,
    left: IconButton,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    let open = ws.left.open;
    let seat = |button: IconButton| {
        if open {
            button.in_tray()
        } else {
            button.floating()
        }
    };
    let home = ws.nav.current().is_none() && ws.super_view.is_none();
    let bell = overlay::use_bounds("bell-bounds", window, cx);
    let account = overlay::use_bounds("account-bounds", window, cx);
    let projects = seat(
        IconButton::new("projects", Icon::Books)
            .label(t(cx, dr_i18n::keys::all_projects::TITLE))
            .selected(ws.projects_open),
    )
    .on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleProjects), cx));
    let home = crate::pages::anchor(
        crate::pages::anchors::PROJECT_HOME,
        seat(
            IconButton::new("home", Icon::Torii)
                .label(t(cx, keys::project_home::KICKER))
                .selected(home),
        )
        .on_click(|_, window, cx| window.dispatch_action(Box::new(ShowProjectHome), cx)),
        cx,
    );
    let notifications = div()
        .relative()
        .child(overlay::probe(bell))
        .child(crate::pages::anchor(
            crate::pages::anchors::NOTIFICATIONS,
            seat(
                IconButton::new("notifications", Icon::Furin)
                    .label(t(cx, keys::notifications::TITLE))
                    .selected(ws.notifications_open),
            )
            .on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleNotifications), cx)),
            cx,
        ))
        .when(Notifications::has_pinned(cx), |el| {
            el.child(crate::sync::bell_danger_seal(*p))
        });
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(TOGGLE_GAP))
        .child(projects)
        .child(home)
        .child(notifications)
        .child(account_button(ws, account, window, cx))
        .child(closed_anchor(
            !open,
            crate::pages::anchors::LEFT_SIDEBAR_CLOSED_TOGGLE,
            left,
            cx,
        ))
        .into_any_element()
}

/// The account menu's button: the avatar in a round of glass. The menu
/// drops from it.
fn account_button(
    ws: &Workspace,
    bounds: Entity<Option<Bounds<Pixels>>>,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    let floating = !ws.left.open;
    let mut spec = Spec::new(Tone::Clear, g::ROUND / 2.0);
    if floating {
        spec = spec.filled(p.page);
    }
    let toggle = cx.entity();
    glass::glass_box(
        "account",
        if floating { Kind::Rest } else { Kind::Hidden },
        Mode::default(),
        ws.account_open,
        spec,
        window,
        cx,
    )
    .size(px(g::ROUND))
    .flex()
    .flex_none()
    .items_center()
    .justify_center()
    .rounded_full()
    .when(floating, |el| el.bg(p.page.solid()))
    .cursor_pointer()
    .role(gpui::Role::Button)
    .aria_label(crate::account::menu_aria_label(cx))
    .on_click(move |_, _, cx| {
        toggle.update(cx, |ws, cx| {
            ws.account_open = !ws.account_open;
            ws.notifications_open = false;
            cx.notify();
        })
    })
    .child(overlay::probe(bounds))
    .child(crate::account::avatar(20.0, window, cx))
    .into_any_element()
}

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
