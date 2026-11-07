//! The main window: the titlebar over a placeholder page. F6 (`dr-shell`)
//! grows the page into the three-column workspace.

use anyhow::Result;
use gpui::{
    App, AppContext, Bounds, Context, Entity, FocusHandle, Focusable, InteractiveElement,
    IntoElement, ParentElement, Render, Size, Styled, Subscription, TitlebarOptions, Window,
    WindowBounds, WindowHandle, WindowOptions, div, prelude::FluentBuilder, px, size,
};

use crate::appearance::{self, AppearanceSetting, Palette};
use crate::identity::{APP_NAME, BUNDLE_ID};
use crate::menus::{self, Copy, Cut, Dismiss, OpenSettings, Paste, Redo, SelectAll, Undo};
use crate::probe;
use crate::titlebar::{TRAFFIC_LIGHT_POSITION, TitleBar};

/// The 0.1 client's default and minimum window sizes.
const DEFAULT_SIZE: Size<gpui::Pixels> = size(px(1440.), px(900.));
pub const MIN_SIZE: Size<gpui::Pixels> = size(px(1000.), px(700.));

pub struct MainWindow {
    focus_handle: FocusHandle,
    titlebar: Entity<TitleBar>,
    /// The last edit command the menu or a shortcut delivered here; shows that
    /// ⌘Z … ⌘A reach the focused view until a real editor handles them.
    last_edit_command: Option<&'static str>,
    settings_open: bool,
    _appearance_observer: Subscription,
}

impl MainWindow {
    pub fn options(cx: &App) -> WindowOptions {
        let mut window_size = DEFAULT_SIZE;
        if let Some(display) = cx.primary_display() {
            let visible = display.bounds().size;
            window_size.width = window_size.width.min(visible.width * 0.9);
            window_size.height = window_size.height.min(visible.height * 0.9);
        }
        window_size.width = window_size.width.max(MIN_SIZE.width);
        window_size.height = window_size.height.max(MIN_SIZE.height);

        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                None,
                window_size,
                cx,
            ))),
            titlebar: Some(TitlebarOptions {
                // Still named for the Window menu, Mission Control and the
                // taskbar; macOS hides the text once the titlebar is transparent.
                title: Some(APP_NAME.into()),
                appears_transparent: true,
                traffic_light_position: Some(TRAFFIC_LIGHT_POSITION),
            }),
            app_owns_titlebar_drag: true,
            window_min_size: Some(MIN_SIZE),
            app_id: Some(BUNDLE_ID.to_owned()),
            ..Default::default()
        }
    }

    /// Opens a main window, or brings an open one forward.
    pub fn open_or_activate(cx: &mut App) -> Result<WindowHandle<Self>> {
        if let Some(handle) = Self::find(cx) {
            handle.update(cx, |_, window, _| window.activate_window())?;
            return Ok(handle);
        }
        let handle = cx.open_window(Self::options(cx), |window, cx| {
            cx.new(|cx| Self::new(window, cx))
        })?;
        Ok(handle)
    }

    fn find(cx: &App) -> Option<WindowHandle<Self>> {
        cx.windows()
            .into_iter()
            .find_map(|window| window.downcast::<Self>())
    }

    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus_handle = cx.focus_handle();
        focus_handle.focus(window, cx);

        // A system switch between light and dark (or the development switch on
        // macOS) arrives here; repaint with the other palette.
        let observer = cx.observe_window_appearance(window, |_, window, cx| {
            probe::appearance_changed(appearance::current(window, cx));
            cx.notify();
        });

        probe::window_opened(window, cx);

        Self {
            focus_handle,
            titlebar: cx.new(|_| TitleBar::new(APP_NAME)),
            last_edit_command: None,
            settings_open: false,
            _appearance_observer: observer,
        }
    }

    pub fn show_settings_placeholder(&mut self, cx: &mut Context<Self>) {
        self.settings_open = true;
        cx.notify();
    }

    fn edit_command(&mut self, name: &'static str, cx: &mut Context<Self>) {
        self.last_edit_command = Some(name);
        cx.notify();
    }
}

impl Focusable for MainWindow {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for MainWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let appearance = appearance::current(window, cx);
        let palette = Palette::for_appearance(appearance);
        let setting = cx
            .try_global::<AppearanceSetting>()
            .copied()
            .unwrap_or_default();

        let status = match self.last_edit_command {
            Some(command) => format!(
                "{} · {} · last edit command: {command}",
                appearance.name(),
                setting.describe()
            ),
            None => format!("{} · {}", appearance.name(), setting.describe()),
        };

        div()
            .id("main-window")
            .key_context("Workspace")
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(|this, _: &Undo, _, cx| this.edit_command("Undo", cx)))
            .on_action(cx.listener(|this, _: &Redo, _, cx| this.edit_command("Redo", cx)))
            .on_action(cx.listener(|this, _: &Cut, _, cx| this.edit_command("Cut", cx)))
            .on_action(cx.listener(|this, _: &Copy, _, cx| this.edit_command("Copy", cx)))
            .on_action(cx.listener(|this, _: &Paste, _, cx| this.edit_command("Paste", cx)))
            .on_action(
                cx.listener(|this, _: &SelectAll, _, cx| this.edit_command("Select All", cx)),
            )
            .on_action(cx.listener(|this, _: &Dismiss, _, cx| {
                this.settings_open = false;
                cx.notify();
            }))
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .bg(palette.background)
            .text_color(palette.text)
            .child(self.titlebar.clone())
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .justify_center()
                    .items_center()
                    .gap_2()
                    .child(div().text_3xl().child("Drifting"))
                    .child(div().text_sm().text_color(palette.muted).child(status)),
            )
            .when(self.settings_open, |page| {
                page.child(settings_placeholder(palette))
            })
    }
}

/// Settings arrive with F6; until then the menu item opens this card.
fn settings_placeholder(palette: Palette) -> impl IntoElement {
    div()
        .absolute()
        .inset_0()
        .flex()
        .justify_center()
        .items_center()
        .child(
            div()
                .w(px(360.))
                .p_6()
                .flex()
                .flex_col()
                .gap_2()
                .bg(palette.titlebar)
                .border_1()
                .border_color(palette.hairline)
                .rounded_lg()
                .shadow_lg()
                .child(div().text_lg().child("Settings"))
                .child(
                    div()
                        .text_sm()
                        .text_color(palette.muted)
                        .child("Placeholder · Esc closes"),
                ),
        )
}

/// The Settings… menu item: show the placeholder in the main window.
pub fn open_settings(_: &OpenSettings, cx: &mut App) {
    menus::after_dispatch(cx, |cx| {
        let shown = MainWindow::open_or_activate(cx)
            .and_then(|handle| handle.update(cx, |view, _, cx| view.show_settings_placeholder(cx)));
        if let Err(error) = shown {
            log::error!("could not show Settings: {error:#}");
        }
    });
}
