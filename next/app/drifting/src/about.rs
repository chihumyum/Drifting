//! The About window: name, version and licence. One at a time.

use dr_shell::{actions::About, menus};
use dr_ui::{Theme, fonts::Role, style::DrStyled};
use gpui::{
    App, AppContext, Bounds, Context, IntoElement, ParentElement, Render, Styled, Subscription,
    TitlebarOptions, Window, WindowBounds, WindowHandle, WindowOptions, div, px, size,
};

use crate::identity::{self, APP_NAME, BUNDLE_ID};

pub struct AboutWindow {
    _appearance_observer: Subscription,
}

impl Render for AboutWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        div()
            .size_full()
            .flex()
            .flex_col()
            .justify_center()
            .items_center()
            .gap_1()
            .bg(p.desk.solid())
            .text_color(p.ink(1).solid())
            .font_role(Role::Ui)
            .child(
                div()
                    .font_role(Role::Structure)
                    .type_px(s.heading + 4.0, s.heading + 12.0)
                    .child(APP_NAME),
            )
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.muted().solid())
                    .child(identity::version()),
            )
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.muted().solid())
                    .child(env!("CARGO_PKG_LICENSE")),
            )
    }
}

pub fn open(_: &About, cx: &mut App) {
    menus::after_dispatch(cx, |cx| {
        let existing = cx
            .windows()
            .into_iter()
            .find_map(|window| window.downcast::<AboutWindow>());
        let shown = match existing {
            Some(handle) => handle.update(cx, |_, window, _| window.activate_window()),
            None => open_window(cx).map(|_| ()),
        };
        if let Err(error) = shown {
            log::error!("could not show the About window: {error:#}");
        }
    });
}

fn open_window(cx: &mut App) -> anyhow::Result<WindowHandle<AboutWindow>> {
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(360.), px(200.)),
            cx,
        ))),
        titlebar: Some(TitlebarOptions {
            title: Some(format!("About {APP_NAME}").into()),
            appears_transparent: false,
            traffic_light_position: None,
        }),
        is_resizable: false,
        is_minimizable: false,
        app_id: Some(BUNDLE_ID.to_owned()),
        ..Default::default()
    };
    cx.open_window(options, |window, cx| {
        cx.new(|cx| AboutWindow {
            _appearance_observer: cx.observe_window_appearance(window, |_, _, cx| cx.notify()),
        })
    })
}
