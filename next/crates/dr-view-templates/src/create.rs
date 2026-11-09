use dr_i18n::keys::template_editor as k;
use dr_shell::{pages::PageViewHost, t};
use dr_ui::{
    components::overlay::{self, Layer, Place},
    components::{Menu, MenuItem},
    sand::Icon,
};
use gpui::{
    App, AppContext as _, Context, FocusHandle, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, Window, div,
};

struct CreateMenu {
    host: PageViewHost,
    at: gpui::Point<gpui::Pixels>,
    focus: FocusHandle,
}

pub(super) fn open(host: PageViewHost, window: &mut Window, cx: &mut App) {
    let menu = cx.new(|cx| CreateMenu {
        host,
        at: window.mouse_position(),
        focus: cx.focus_handle(),
    });
    let focus = menu.read(cx).focus.clone();
    window.focus(&focus, cx);
    dr_shell::dialogs::show_in(window.window_handle(), cx, menu.into());
}

impl Render for CreateMenu {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut menu = Menu::new("k5-create-menu");
        for (kind, key) in [("level", k::LEVEL_TEMPLATE), ("leaf", k::LEAF_TEMPLATE)] {
            let host = self.host.clone();
            menu = menu.item(
                MenuItem::new(
                    if kind == "level" {
                        "k5-create-level"
                    } else {
                        "k5-create-leaf"
                    },
                    Icon::Plus,
                    t(cx, key),
                )
                .on_click(move |_, window, cx| {
                    let host = host.clone();
                    let editor =
                        cx.new(|cx| crate::TemplateEditor::new(host, None, kind, window, cx));
                    dr_shell::dialogs::show_in(window.window_handle(), cx, editor.into());
                }),
            );
        }
        let id = cx.entity_id();
        overlay::float(
            Place::Point(self.at),
            Layer::Popover,
            div()
                .id("k5-create-menu-host")
                .track_focus(&self.focus)
                .occlude()
                .on_key_down(move |event, _, cx| {
                    if event.keystroke.key == "escape" {
                        dr_shell::dialogs::hide(cx, id);
                    }
                })
                .on_mouse_down_out(move |_, _, cx| dr_shell::dialogs::hide(cx, id))
                .child(menu),
        )
    }
}
