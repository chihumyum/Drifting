//! The About window: name, version and licence. One at a time.

use gpui::{
    App, AppContext, Bounds, Context, IntoElement, ParentElement, Render, Styled, Subscription,
    TitlebarOptions, Window, WindowBounds, WindowHandle, WindowOptions, div, px, size,
};

use crate::appearance::{self, Palette};
use crate::identity::{self, APP_NAME, BUNDLE_ID};
use crate::menus::{self, About};

pub struct AboutWindow {
    _appearance_observer: Subscription,
}

impl Render for AboutWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = Palette::for_appearance(appearance::current(window, cx));
        div()
            .size_full()
            .flex()
            .flex_col()
            .justify_center()
            .items_center()
            .gap_1()
            .bg(palette.background)
            .text_color(palette.text)
            .child(div().text_xl().child(APP_NAME))
            .child(
                div()
                    .text_sm()
                    .text_color(palette.muted)
                    .child(identity::version()),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(palette.muted)
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
