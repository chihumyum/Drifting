//! Local MCP connection settings and per-book external server configuration.

mod access;
mod extensions;
mod form;

use crate::mcp::McpService;
pub use access::{AccessView, manual_configuration};
use dr_i18n::{Key, keys};
use dr_shell::{
    settings,
    strings::{t, tf},
};
use dr_ui::{Theme, components::Button, fonts::Role, input::TextField, style::DrStyled};
use futures::future::BoxFuture;
use gpui::InteractiveElement as _;
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, IntoElement, ParentElement, Render,
    SharedString, Styled, Subscription, Window, div, px,
};
use std::{cell::RefCell, collections::HashMap, rc::Rc};

pub fn init(service: Entity<McpService>, cx: &mut App) {
    let access: Rc<RefCell<HashMap<gpui::WindowId, Entity<AccessView>>>> = Rc::default();
    let extensions: Rc<RefCell<HashMap<gpui::WindowId, Entity<extensions::ExtensionsView>>>> =
        Rc::default();
    let closed_access = access.clone();
    let closed_extensions = extensions.clone();
    settings::on_panel_closed(cx, move |window, cx| {
        if let Some(view) = closed_access.borrow().get(&window).cloned() {
            view.update(cx, |view, cx| view.close(cx));
        }
        if let Some(view) = closed_extensions.borrow().get(&window).cloned() {
            view.update(cx, |view, cx| view.close(cx));
        }
    });
    let dropped_access = access.clone();
    let dropped_extensions = extensions.clone();
    cx.on_window_closed(move |_, window| {
        dropped_access.borrow_mut().remove(&window);
        dropped_extensions.borrow_mut().remove(&window);
    })
    .detach();
    let access_service = service.clone();
    settings::set_module_row(cx, "agent.mcpAccess", move |window, cx| {
        access
            .borrow_mut()
            .entry(window.window_handle().window_id())
            .or_insert_with(|| cx.new(|cx| AccessView::new(access_service.clone(), window, cx)))
            .clone()
            .into_any_element()
    });
    settings::set_module_row(cx, "agent.extensions", move |window, cx| {
        extensions
            .borrow_mut()
            .entry(window.window_handle().window_id())
            .or_insert_with(|| {
                cx.new(|cx| extensions::ExtensionsView::new(service.clone(), window, cx))
            })
            .clone()
            .into_any_element()
    });
}

fn note(text: impl Into<SharedString>, window: &Window, cx: &App) -> gpui::Div {
    div()
        .font_role(Role::Ui)
        .text_color(Theme::of(window, cx).palette.muted().solid())
        .child(text.into())
}
fn heading(key: Key, cx: &App) -> gpui::Div {
    div()
        .font_role(Role::Structure)
        .text_size(px(18.0))
        .child(t(cx, key))
}

trait MarkControl {
    fn mark(self, id: impl Into<String>) -> AnyElement;
}
impl MarkControl for Button {
    fn mark(self, id: impl Into<String>) -> AnyElement {
        let id = id.into();
        div()
            .debug_selector(move || id)
            .child(self)
            .into_any_element()
    }
}
