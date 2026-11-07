//! The paper's bottom-right corner (the 0.1 client's `.editor-corner`,
//! M03): a glass tray of page tools and, to its right, the incense stick
//! that enters immersive writing. Always there, never hidden under the hand;
//! it stands on the desk beside the page and does not scroll.
//!
//! - **Outline** (`toc-raked`): shows or hides the outline rail in the
//!   page's left margin (M04). Kept in the book's local layout.
//! - **⋯** (`more`): the page's menu. A chapter's has its writing status
//!   (草稿 / 已完成 / 已弃用, the current one ticked) and 删除节点, which puts
//!   it in the trash (its tab closes through F3's event, as for anyone's
//!   deletion). The other kinds' menus come with their modules.
//! - **一炷香** (`incense`): [`ToggleImmersiveWriting`]. In a split only the
//!   right page has it, as in the 0.1 client.
//!
//! The writing status and the trash go through F3's commands as the author,
//! off the main thread; the lists change when F3's bus says the book did.

use dr_i18n::keys;
use dr_ui::{
    Theme,
    components::{
        IconButton, Menu, MenuItem,
        overlay::{self, Align, Layer, Place},
    },
    glass::{self, Kind, Mode, Spec, Tone},
    sand::Icon,
    tokens::glass as g,
};
use dr_workspace::Actor;
use gpui::{
    AnyElement, App, Context, Entity, InteractiveElement, IntoElement, ParentElement, Styled,
    Window, div, px,
};
use serde_json::json;

use super::Workspace;
use crate::actions::ToggleImmersiveWriting;
use crate::nav::Target;
use crate::strings::t;

/// How far the corner stands from the column's right and bottom edges.
pub const CORNER_INSET: f32 = 16.0;

/// A chapter's writing statuses, in the menu's order, with their brushes.
pub const STATUSES: [(&str, Icon); 3] = [
    ("draft", Icon::BrushLifted),
    ("finished", Icon::BrushLaid),
    ("discarded", Icon::BrushBroken),
];

fn status_label(cx: &App, status: &str) -> gpui::SharedString {
    use keys::editor_top_bar::status;
    t(
        cx,
        match status {
            "finished" => status::FINISHED,
            "discarded" => status::DISCARDED,
            _ => status::DRAFT,
        },
    )
}

/// The corner of the page showing `target`; `trailing`: the right page of a
/// split, or the only one.
pub fn corner(
    w: &Workspace,
    ws: &Entity<Workspace>,
    target: Option<&Target>,
    trailing: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    if w.immersive {
        return div().into_any_element();
    }
    let chapter = match target {
        Some(Target::Chapter(id)) => w
            .book
            .chapters
            .iter()
            .find(|c| c.id == id.as_str())
            .cloned(),
        _ => None,
    };
    let key = target.map_or_else(|| "home".to_owned(), Target::key);
    let menu_open = w.corner_menu.as_deref() == Some(key.as_str());
    let more_bounds = overlay::use_bounds(
        gpui::ElementId::Name(format!("corner-more-bounds-{key}").into()),
        window,
        cx,
    );

    let mut tools: Vec<AnyElement> = Vec::new();
    if target.is_some_and(|t| crate::book::doc_of(t).is_some()) {
        let toggle = ws.clone();
        let shown = !w.outline_hidden;
        tools.push(
            IconButton::new(
                gpui::ElementId::Name(format!("corner-outline-{key}").into()),
                Icon::TocRaked,
            )
            .in_tray()
            .selected(shown)
            .label(t(
                cx,
                if shown {
                    keys::editor_top_bar::outline_rail_mode::HIDDEN
                } else {
                    keys::editor_top_bar::outline_rail_mode::VISIBLE
                },
            ))
            .on_click(move |_, _, cx| {
                toggle.update(cx, |ws, cx| {
                    ws.outline_hidden = !ws.outline_hidden;
                    ws.changed(cx);
                })
            })
            .into_any_element(),
        );
    }
    if chapter.is_some() {
        let opener = ws.clone();
        let page = key.clone();
        tools.push(
            div()
                .relative()
                .child(overlay::probe(more_bounds.clone()))
                .child(
                    IconButton::new(
                        gpui::ElementId::Name(format!("corner-more-btn-{key}").into()),
                        Icon::More,
                    )
                    .in_tray()
                    .selected(menu_open)
                    .label(t(cx, keys::editor_top_bar::actions::MORE))
                    .on_click(move |_, _, cx| {
                        let page = page.clone();
                        opener.update(cx, |ws, cx| {
                            ws.corner_menu = if ws.corner_menu.as_ref() == Some(&page) {
                                None
                            } else {
                                Some(page)
                            };
                            cx.notify();
                        })
                    }),
                )
                .into_any_element(),
        );
    }

    let tray = (!tools.is_empty()).then(|| {
        glass::glass_box(
            gpui::ElementId::Name(format!("corner-tray-{key}").into()),
            Kind::Surface,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, (g::PILL_HEIGHT + 2.0 * g::TRAY_PADDING) / 2.0)
                .origin(glass::SAMPLE_ORIGINS[0])
                .rim(12.0)
                .filled(p.page),
            window,
            cx,
        )
        .flex()
        .flex_row()
        .gap(px(2.0))
        .p(px(g::TRAY_PADDING))
        .rounded_full()
        .bg(p.page.solid())
        .children(tools)
    });

    let incense = trailing.then(|| {
        IconButton::new(
            gpui::ElementId::Name(format!("corner-incense-{key}").into()),
            Icon::Incense,
        )
        .floating()
        .label(t(cx, keys::immersive_writing::ENTER))
        .on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleImmersiveWriting), cx))
    });

    let menu = match (&chapter, menu_open, *more_bounds.read(cx)) {
        (Some(chapter), true, Some(bounds)) => Some(more_menu(ws, chapter, bounds, &theme, cx)),
        _ => None,
    };

    div()
        .absolute()
        .right(px(CORNER_INSET))
        .bottom(px(CORNER_INSET))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .children(tray)
        .children(incense)
        .children(menu)
        .into_any_element()
}

/// In immersive writing the corner is gone; the incense stick comes back
/// when the pointer nears the corner, and leaves immersive writing.
pub fn leave_immersive(cx: &mut App) -> AnyElement {
    div()
        .id("immersive-leave-zone")
        .group("immersive-leave")
        .absolute()
        .right_0()
        .bottom_0()
        .w(px(160.0))
        .h(px(120.0))
        .child(
            div()
                .absolute()
                .right(px(CORNER_INSET))
                .bottom(px(CORNER_INSET + 4.0))
                .opacity(0.0)
                .group_hover("immersive-leave", |st| st.opacity(1.0))
                .child(
                    IconButton::new("immersive-leave", Icon::Incense)
                        .floating()
                        .selected(true)
                        .label(t(cx, keys::immersive_writing::LEAVE))
                        .on_click(|_, window, cx| {
                            window.dispatch_action(Box::new(ToggleImmersiveWriting), cx)
                        }),
                ),
        )
        .into_any_element()
}

/// A chapter's ⋯ menu: its writing status, then into the trash.
fn more_menu(
    ws: &Entity<Workspace>,
    chapter: &dr_workspace::dto::ChapterInfo,
    bounds: gpui::Bounds<gpui::Pixels>,
    theme: &Theme,
    cx: &mut App,
) -> AnyElement {
    let mut menu = Menu::new("corner-more-menu")
        .section(t(cx, keys::editor_top_bar::status_section::CHAPTER), theme);
    for (status, icon) in STATUSES {
        let ws = ws.clone();
        let id = chapter.id.clone();
        menu = menu.item(
            MenuItem::new(
                gpui::ElementId::Name(format!("status-{status}").into()),
                icon,
                status_label(cx, status),
            )
            .checked(chapter.status == status)
            .on_click(move |_, _, cx| {
                ws.update(cx, |ws, cx| {
                    ws.corner_menu = None;
                    ws.run_command(
                        "chapter.update",
                        json!({"book": ws.book_id, "id": id, "status": status}),
                        cx,
                    )
                });
            }),
        );
    }
    let trash = {
        let ws = ws.clone();
        let id = chapter.id.clone();
        MenuItem::new(
            "chapter-trash",
            Icon::Trash,
            t(cx, keys::editor_top_bar::menu::DELETE_NODE),
        )
        .danger()
        .on_click(move |_, _, cx| {
            ws.update(cx, |ws, cx| {
                ws.corner_menu = None;
                ws.run_command("chapter.trash", json!({"book": ws.book_id, "id": id}), cx)
            });
        })
    };
    menu = menu.separator(theme).item(trash);
    let dismiss = ws.clone();
    overlay::float(
        // Above the button (no room below it), its end lined up with the
        // button's, as the 0.1 client's top-end popover.
        Place::Rect {
            rect: bounds,
            align: Align::End,
            gap: 6.0,
        },
        Layer::Popover,
        div()
            .on_mouse_down_out(move |_, _, cx| {
                dismiss.update(cx, |ws, cx| {
                    ws.corner_menu = None;
                    cx.notify();
                })
            })
            .child(menu),
    )
    .into_any_element()
}

impl Workspace {
    /// Runs one of F3's commands as the author, off the main thread; what it
    /// changes comes back on F3's bus.
    pub fn run_command(
        &mut self,
        name: &'static str,
        input: serde_json::Value,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        cx.background_executor()
            .spawn(async move {
                if let Err(error) = lib.call(&Actor::User, name, input) {
                    log::warn!("{name}: {error}");
                }
            })
            .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_statuses_are_f3s() {
        let names: Vec<&str> = STATUSES.iter().map(|(s, _)| *s).collect();
        assert_eq!(names, ["draft", "finished", "discarded"]);
    }
}
