//! The window's own chrome: where the traffic lights sit, which strips move
//! the window, the buttons fixed right of the traffic lights (全部项目, the
//! Project Home, the notification center, the account menu and the left
//! sidebar's overlapping moon pair), the right sidebar's overlapping moon pair
//! in the other corner (`W25Final`, `kernel-v5.md` §17 「栏开关」), and the
//! Windows caption pill.

use dr_ui::{
    Theme,
    components::{IconButton, overlay},
    glass::{self, Kind, Mode, Spec, Tone},
    sand::{self, Icon},
    tokens::glass as g,
};
use gpui::{
    AnyElement, App, Bounds, Context, Entity, InteractiveElement, IntoElement, MouseButton,
    MouseDownEvent, MouseMoveEvent, ParentElement, Pixels, Point, SharedString, Stateful,
    StatefulInteractiveElement, Styled, Window, WindowControlArea, div, point,
    prelude::FluentBuilder as _, px,
};

use super::Workspace;
use super::fill::{FillPlace, MoonHalf};
use super::sidebar::Side;
use crate::actions::{ShowProjectHome, ToggleNotifications, ToggleProjects};
use crate::notifications::Notifications;
use crate::strings::t;
use dr_i18n::keys;

/// The window-controls row (`--window-titlebar-height`): the traffic lights,
/// the toggles, the dock and the sidebars' tab rows share its centre line.
pub const TITLEBAR_HEIGHT: f32 = 42.0;

/// The close button's top-left corner. GPUI centres the 14pt buttons in a
/// strip `2 * y` taller, so `y = 14` centres them on the 42pt row.
pub const TRAFFIC_LIGHT_POSITION: Point<Pixels> = point(px(18.), px(14.));

/// Where the left cluster starts, clear of the window controls: macOS 94px,
/// Windows 110px (8 + the 96px caption pill + 6).
pub const LEADING_INSET: f32 = if cfg!(target_os = "windows") {
    110.0
} else {
    94.0
};

/// Round buttons before the left moon pair: 全部项目, Project Home,
/// Notifications, Account.
pub const CLUSTER_ROUND_BUTTONS: usize = 4;

/// Overlapping moon glyph size (`W25Final`: `size = 18`).
pub const MOON_SIZE: f32 = 18.0;
/// Centre-to-centre distance between the two overlapping moons (`W25Final`: `off = 8`).
pub const MOON_OFFSET: f32 = 8.0;
/// Resting opacity of the back moon (`W25Final`: `dim = 0.42`).
pub const MOON_DIM: f32 = 0.42;
/// Dimmed opacity when the right full moon cannot fill (`Stats` / `Agent`).
/// `W25Final` only says it is dim and does nothing; no board gives a value
/// for the overlapping pair (the retired two-halves switch on `W11Right`
/// drew its disabled half at 0.35).
pub const MOON_DISABLED_DIM: f32 = 0.18;

/// The gap between controls in the titlebar cluster.
pub const TOGGLE_GAP: f32 = 6.0;

/// The right toggle's distance from the window's right edge.
pub const TRAILING_INSET: f32 = 8.0;

/// Centre X of the left crescent moon (`244px` on macOS, `W25Final`).
pub const LEFT_CRESCENT_X: f32 =
    LEADING_INSET + CLUSTER_ROUND_BUTTONS as f32 * (g::ROUND + TOGGLE_GAP) + g::ROUND / 2.0;

/// Where the left cluster ends (the right edge of the left moon pair's hitbox).
pub const CLUSTER_END: f32 = LEFT_CRESCENT_X + MOON_OFFSET + g::ROUND / 2.0;

/// Distance from the right window edge to the inner edge of the right moon pair.
pub const RIGHT_TOGGLE_END: f32 = TRAILING_INSET + g::ROUND + MOON_OFFSET;

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

/// The buttons right of the traffic lights and the two overlapping moon pairs
/// (`W25Final`): no outer ring or glass border on the moons; whichever state
/// the sidebar is in sits in front at full ink, and the other sits `8px` away
/// behind it at `0.42` opacity with the front moon's circle cut out (`gap = 0`).
pub fn sidebar_toggles(
    ws: &Workspace,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let top = (TITLEBAR_HEIGHT - g::ROUND) / 2.0;
    let buttons = cluster(ws, window, cx);
    let left_moons = crate::pages::anchor(
        crate::pages::anchors::LEFT_MOONS,
        moon_pair(ws, Side::Left, window, cx),
        cx,
    );
    let right_moons = moon_pair(ws, Side::Right, window, cx);
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
                .child(buttons),
        )
        .child(
            div()
                .absolute()
                .top(px(top))
                .left(px(LEFT_CRESCENT_X - g::ROUND / 2.0))
                .child(left_moons),
        )
        .child(
            div()
                .absolute()
                .top(px(top))
                .right(px(TRAILING_INSET))
                .child(right_moons),
        )
}

/// What one overlapping moon pair shows (`W25Final`, `kernel-v5.md` §17
/// 「栏开关」): whichever state the sidebar is in sits in front.
///
/// | state  | front           | back (dim)       |
/// | ------ | --------------- | ---------------- |
/// | closed | hollow crescent | hollow full moon |
/// | open   | crescent        | hollow full moon |
/// | filled | black full moon | crescent         |
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MoonLook {
    /// The crescent is in front (closed, open); the full moon only while
    /// the sidebar fills.
    pub crescent_in_front: bool,
    /// The glyph in front, always at full opacity.
    pub front: Icon,
    /// The glyph behind, with the front one's circle cut out of it.
    pub back: Icon,
    /// The glyph behind: [`MOON_DIM`] at rest, 1 while the pointer is on it
    /// (it only gets darker: its ink and the order stay), and
    /// [`MOON_DISABLED_DIM`] when it does nothing.
    pub back_opacity: f32,
    /// The full moon answers a click (the right one does not on Stats or
    /// Agent).
    pub can_fill: bool,
}

/// The look of `side`'s moon pair now.
pub fn moon_look(ws: &Workspace, side: Side) -> MoonLook {
    let (open, filled, can_fill, cresc_half, full_half, icons) = match side {
        Side::Left => (
            ws.left.open,
            ws.is_filled(FillPlace::Left),
            true,
            MoonHalf::LeftCrescent,
            MoonHalf::LeftFull,
            [
                Icon::MoonLeftHollow,
                Icon::MoonLeft,
                Icon::MoonHollowfullLeft,
                Icon::MoonBlackLeft,
            ],
        ),
        Side::Right => {
            let filled = ws.is_filled(FillPlace::Right);
            (
                ws.right.open,
                filled,
                filled || ws.right_can_fill(),
                MoonHalf::RightCrescent,
                MoonHalf::RightFull,
                [
                    Icon::MoonRightHollow,
                    Icon::MoonRight,
                    Icon::MoonHollowfullRight,
                    Icon::MoonBlackRight,
                ],
            )
        }
    };
    let [cresc_closed, cresc_open, full_hollow, full_black] = icons;
    let cresc = if open { cresc_open } else { cresc_closed };
    let full = if filled { full_black } else { full_hollow };
    let crescent_in_front = !filled;
    let (front, back, back_half, back_enabled) = if crescent_in_front {
        (cresc, full, full_half, can_fill)
    } else {
        (full, cresc, cresc_half, true)
    };
    let back_opacity = if !back_enabled {
        MOON_DISABLED_DIM
    } else if ws.hovered_moon == Some(back_half) {
        1.0
    } else {
        MOON_DIM
    };
    MoonLook {
        crescent_in_front,
        front,
        back,
        back_opacity,
        can_fill,
    }
}

fn moon_pair(
    ws: &Workspace,
    side: Side,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    use keys::left_sidebar::top as lt;
    use keys::right_sidebar::top as rt;
    use keys::v5_fill as vf;

    let p = Theme::of(window, cx).palette;
    let pair_w = g::ROUND + MOON_OFFSET;
    let half_w = pair_w / 2.0;
    let glyph_top = (g::ROUND - MOON_SIZE) / 2.0;
    let look = moon_look(ws, side);
    let can_fill = look.can_fill;

    let (
        open,
        cresc_cx,
        full_cx,
        cresc_half,
        full_half,
        cresc_id,
        full_id,
        cresc_label,
        full_label,
        closed_anchor_id,
    ) = match side {
        Side::Left => {
            let open = ws.left.open;
            let filled = ws.is_filled(FillPlace::Left);
            (
                open,
                g::ROUND / 2.0,
                g::ROUND / 2.0 + MOON_OFFSET,
                MoonHalf::LeftCrescent,
                MoonHalf::LeftFull,
                "toggle-left",
                "fill-left",
                t(cx, if open { lt::CLOSE } else { lt::OPEN }),
                t(cx, if filled { vf::EXIT_FILL } else { vf::FILL_LEFT }),
                crate::pages::anchors::LEFT_SIDEBAR_CLOSED_TOGGLE,
            )
        }
        Side::Right => {
            let open = ws.right.open;
            let filled = ws.is_filled(FillPlace::Right);
            (
                open,
                g::ROUND / 2.0 + MOON_OFFSET,
                g::ROUND / 2.0,
                MoonHalf::RightCrescent,
                MoonHalf::RightFull,
                "toggle-right",
                "fill-right",
                t(cx, if open { rt::CLOSE } else { rt::OPEN }),
                t(
                    cx,
                    if filled {
                        vf::EXIT_FILL
                    } else {
                        vf::FILL_RIGHT
                    },
                ),
                crate::pages::anchors::RIGHT_SIDEBAR_CLOSED_TOGGLE,
            )
        }
    };
    // Opening starts at zero drawn width: the tabs are not painted yet.
    // Keep their existing toggle fallback through the reveal so the tour
    // cannot mistake that first frame for a missing step. It prefers the
    // actual Tab/Agent anchor as soon as that control is painted.
    let toggle_fallback = !open
        || match side {
            Side::Left => ws.left.shown() < 1.0,
            Side::Right => ws.right.shown() < 1.0,
        };

    let (front_cx, back_cx) = if look.crescent_in_front {
        (cresc_cx, full_cx)
    } else {
        (full_cx, cresc_cx)
    };
    let cut_on_right = front_cx > back_cx;
    // `W25Final`: both glyphs are drawn in the same ink. Pointing at the one
    // behind only lifts its opacity; pointing at the one in front changes
    // nothing.
    let ink = p.ink(2).solid();
    let (front_icon, back_icon, back_opacity) = (look.front, look.back, look.back_opacity);

    let back_glyph = div()
        .absolute()
        .left(px(back_cx - MOON_SIZE / 2.0))
        .top(px(glyph_top))
        .size(px(MOON_SIZE))
        .opacity(back_opacity)
        .child(sand::icon_cutout(back_icon, MOON_SIZE, ink, cut_on_right));

    let front_glyph = div()
        .absolute()
        .left(px(front_cx - MOON_SIZE / 2.0))
        .top(px(glyph_top))
        .size(px(MOON_SIZE))
        .child(sand::icon(front_icon, MOON_SIZE, ink));

    let cresc_on_left = cresc_cx < full_cx;
    let cresc_hit = div()
        .id(cresc_id)
        .debug_selector(move || cresc_id.to_string())
        .w(px(half_w))
        .h(px(g::ROUND))
        .cursor_pointer()
        .role(gpui::Role::Button)
        .aria_label(cresc_label)
        .on_hover(cx.listener(move |ws, &hovered, _, cx| {
            let next = if hovered {
                Some(cresc_half)
            } else if ws.hovered_moon == Some(cresc_half) {
                None
            } else {
                ws.hovered_moon
            };
            if ws.hovered_moon != next {
                ws.hovered_moon = next;
                cx.notify();
            }
        }))
        .on_click(cx.listener(move |ws, _, window, cx| {
            ws.click_crescent(side, window, cx);
        }));
    let cresc_hit = div()
        .absolute()
        .top_0()
        .left(px(if cresc_on_left { 0.0 } else { half_w }))
        .child(closed_anchor(
            toggle_fallback,
            closed_anchor_id,
            cresc_hit,
            cx,
        ));

    let mut full_hit = div()
        .id(full_id)
        .debug_selector(move || full_id.to_string())
        .absolute()
        .top_0()
        .left(px(if cresc_on_left { half_w } else { 0.0 }))
        .w(px(half_w))
        .h(px(g::ROUND))
        .role(gpui::Role::Button)
        .aria_label(full_label);
    if can_fill {
        full_hit = full_hit
            .cursor_pointer()
            .on_hover(cx.listener(move |ws, &hovered, _, cx| {
                let next = if hovered {
                    Some(full_half)
                } else if ws.hovered_moon == Some(full_half) {
                    None
                } else {
                    ws.hovered_moon
                };
                if ws.hovered_moon != next {
                    ws.hovered_moon = next;
                    cx.notify();
                }
            }))
            .on_click(cx.listener(move |ws, _, window, cx| {
                ws.click_full_moon(side, window, cx);
            }));
    }

    div()
        .relative()
        .w(px(pair_w))
        .h(px(g::ROUND))
        .child(back_glyph)
        .child(front_glyph)
        .child(cresc_hit)
        .child(full_hit)
        .into_any_element()
}

/// Hides or shows the window's traffic lights (immersive writing, M26) by
/// their alpha.
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

/// Puts the window controls back at [`TRAFFIC_LIGHT_POSITION`].
#[cfg(target_os = "macos")]
pub fn place_traffic_lights(window: &Window) {
    window.set_traffic_light_position(TRAFFIC_LIGHT_POSITION);
}

#[cfg(not(target_os = "macos"))]
pub fn place_traffic_lights(_: &Window) {}

/// 全部项目, the Project Home, the notification center, and the account menu.
fn cluster(ws: &Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    let open = ws.left.open;
    let seat = |button: IconButton| {
        if open {
            button.in_tray()
        } else {
            button.floating()
        }
    };
    let home = ws.nav.current().is_none() && ws.filled().is_none();
    let bell = overlay::use_bounds("bell-bounds", window, cx);
    let account = overlay::use_bounds("account-bounds", window, cx);
    let projects = crate::pages::anchor(
        crate::pages::anchors::ALL_PROJECTS,
        seat(
            IconButton::new("projects", Icon::Books)
                .label(t(cx, dr_i18n::keys::all_projects::TITLE))
                .selected(ws.projects_open),
        )
        .on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleProjects), cx)),
        cx,
    );
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
        .into_any_element()
}

/// The account menu's button: the avatar in a round of glass.
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
/// corner where the traffic lights are, in their order.
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
        div()
            .id(id)
            .window_control_area(area)
            .child(IconButton::new(id, icon).label(label.clone()).in_tray())
    };
    let top = (TITLEBAR_HEIGHT - g::ROUND) / 2.0 - g::TRAY_PADDING;
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
