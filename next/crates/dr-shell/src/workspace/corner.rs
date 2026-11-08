//! The paper's bottom-right corner (the 0.1 client's `.editor-corner`,
//! M03): the timeline's bamboo, a glass tray of page tools and, to its
//! right, the incense stick that enters immersive writing. Always there,
//! never hidden under the hand; it stands on the desk beside the page and
//! does not scroll (and rides above the Bottom Panel when that is open).
//!
//! - **Bamboo** (`bamboo`): [`ToggleBottomTimeline`] (⌘J), the timeline in
//!   the Bottom Panel. Like the incense stick, only on the right page of a
//!   split; only when a module draws the timeline.
//! - **Plot planner** (`plan-go`), first in the tray on a chapter or idea
//!   when a module draws the planner: opens or closes it in the Bottom
//!   Panel (the timeline makes way).
//! - **Outline** (`toc-raked`): shows or hides the outline rail in the
//!   page's left margin (M04). Kept in the book's local layout.
//! - **⋯** (`more`): the page's menu, top to bottom:
//!   - 分享 (M41's Markdown share) on chapter, idea, element, storyline and
//!     category pages, and on a chapter 导出成稿 too;
//!   - a chapter's writing status (草稿 / 已完成 / 已弃用, the current one
//!     ticked);
//!   - the rows modules add for the page ([`crate::pages::add_page_menu`]:
//!     an element's 更改类目 …);
//!   - 历史快照… on every prose page (M09, [`Workspace::open_history`]);
//!   - last, what deletes: a chapter's 删除节点 (into the trash; its tab
//!     closes through F3's event, as for anyone's deletion) and the
//!     modules' dangerous rows.
//!
//!   The whole book's ⋯ has its share and export.
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
    AnyElement, App, AppContext as _, Context, Entity, InteractiveElement, IntoElement,
    ParentElement, Styled, Window, div, px,
};

use super::Workspace;
use crate::actions::{ToggleBottomTimeline, ToggleImmersiveWriting};
use crate::nav::Target;
use crate::pages::{self, BottomPane};
use crate::strings::t;

/// How far the corner stands from the column's right and bottom edges.
pub const CORNER_INSET: f32 = 16.0;

/// A chapter's writing statuses, in the menu's order, with their brushes.
pub const STATUSES: [(&str, Icon); 3] = [
    ("draft", Icon::BrushLifted),
    ("finished", Icon::BrushLaid),
    ("discarded", Icon::BrushBroken),
];

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
    let key = target.map_or_else(|| "home".to_owned(), Target::key);
    let menu_open = w.corner_menu.as_deref() == Some(key.as_str());
    let more_bounds = overlay::use_bounds(
        gpui::ElementId::Name(format!("corner-more-bounds-{key}").into()),
        window,
        cx,
    );

    let mut tools: Vec<AnyElement> = Vec::new();
    let planned = matches!(target, Some(Target::Chapter(_) | Target::Idea(_)));
    if planned && pages::has_bottom_panel(BottomPane::Planner, cx) {
        let toggle = ws.clone();
        let open = w.bottom.layout.planner_open;
        tools.push(
            IconButton::new(
                gpui::ElementId::Name(format!("corner-planner-{key}").into()),
                Icon::PlanGo,
            )
            .in_tray()
            .selected(open)
            .label(t(
                cx,
                if open {
                    keys::editor_top_bar::actions::COLLAPSE_PLOT_PLANNER
                } else {
                    keys::editor_top_bar::actions::EXPAND_PLOT_PLANNER
                },
            ))
            .on_click(move |_, _, cx| toggle.update(cx, |ws, cx| ws.toggle_planner(cx)))
            .into_any_element(),
        );
    }
    if target.is_some() {
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
    // Every prose page has a ⋯ menu (its snapshot history at least); the
    // whole book's holds its share and export (M41).
    let doc_page = target.and_then(crate::book::doc_of).is_some();
    if doc_page || target == Some(&Target::Book) {
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

    let timeline = (trailing && pages::has_bottom_panel(BottomPane::Timeline, cx)).then(|| {
        let shown = !w.bottom.layout.timeline_hidden && !w.bottom.layout.planner_open;
        IconButton::new(
            gpui::ElementId::Name(format!("corner-timeline-{key}").into()),
            Icon::Bamboo,
        )
        .floating()
        .selected(shown)
        .label(t(
            cx,
            if shown {
                keys::bottom_status_bar::COLLAPSE_TIMELINE
            } else {
                keys::bottom_status_bar::EXPAND_TIMELINE
            },
        ))
        .on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleBottomTimeline), cx))
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

    let menu = match (doc_page, target, menu_open, *more_bounds.read(cx)) {
        (true, Some(target), true, Some(bounds)) => {
            let host = crate::pages::PageMenuHost {
                workspace: ws.downgrade(),
                library: w.library.clone(),
                book_id: w.book_id.clone(),
                book: w.book.clone(),
            };
            Some(more_menu(ws, target, &host, bounds, &theme, cx))
        }
        (false, _, true, Some(bounds)) if target == Some(&Target::Book) => {
            Some(book_menu(ws, bounds, cx))
        }
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
        .children(
            timeline.map(|t| crate::pages::anchor(crate::pages::anchors::TIMELINE_TOGGLE, t, cx)),
        )
        .children(tray)
        .children(incense)
        .children(menu)
        .into_any_element()
}

/// 分享: the page (or the whole book) as Markdown (M41).
fn share_item(
    ws: &Entity<Workspace>,
    target: dr_view_export::MarkdownTarget,
    cx: &mut App,
) -> MenuItem {
    let ws = ws.clone();
    MenuItem::new(
        "corner-share",
        Icon::Share,
        t(cx, keys::markdown_share::MENU),
    )
    .on_click(move |_, window, cx| {
        let target = target.clone();
        ws.update(cx, |ws, cx| {
            ws.corner_menu = None;
            ws.open_export(dr_view_export::Request::Markdown(target), window, cx);
        });
    })
}

/// M41's two rows at the top of a ⋯ menu (the 0.1 order): share the page
/// (or the whole book) as Markdown, export the manuscript.
fn export_items(menu: Menu, ws: &Entity<Workspace>, chapter: Option<&str>, cx: &mut App) -> Menu {
    let share = share_item(
        ws,
        match chapter {
            Some(id) => dr_view_export::MarkdownTarget::Doc(format!("node:{id}")),
            None => dr_view_export::MarkdownTarget::Book,
        },
        cx,
    );
    let export = {
        let ws = ws.clone();
        let chapter = chapter.map(str::to_owned);
        MenuItem::new(
            "corner-export",
            Icon::CaseRise,
            t(cx, keys::manuscript_export::MENU),
        )
        .on_click(move |_, window, cx| {
            let chapter = chapter.clone();
            ws.update(cx, |ws, cx| {
                ws.corner_menu = None;
                ws.open_export(dr_view_export::Request::Manuscript { chapter }, window, cx);
            });
        })
    };
    menu.item(share).item(export)
}

/// The whole book's ⋯ menu: share it, export it.
fn book_menu(
    ws: &Entity<Workspace>,
    bounds: gpui::Bounds<gpui::Pixels>,
    cx: &mut App,
) -> AnyElement {
    let menu = export_items(Menu::new("corner-book-menu"), ws, None, cx);
    let dismiss = ws.clone();
    overlay::float(
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

/// A row of the page's actions in the ⋯ menu: the menu closes, then the
/// row runs.
fn menu_item(ws: &Entity<Workspace>, item: crate::pages::PageMenuItem) -> MenuItem {
    let ws = ws.clone();
    let run = item.run.clone();
    let row = MenuItem::new(
        gpui::ElementId::Name(item.id.clone()),
        item.icon,
        item.label,
    )
    .checked(item.checked)
    .on_click(move |_, window, cx| {
        ws.update(cx, |ws, cx| {
            ws.corner_menu = None;
            cx.notify();
        });
        run(window, cx);
    });
    if item.danger { row.danger() } else { row }
}

/// A page's ⋯ menu: [`super::page_actions::page_actions`], sections parted
/// by hairlines.
fn more_menu(
    ws: &Entity<Workspace>,
    target: &Target,
    host: &crate::pages::PageMenuHost,
    bounds: gpui::Bounds<gpui::Pixels>,
    theme: &Theme,
    cx: &mut App,
) -> AnyElement {
    let mut menu = Menu::new("corner-more-menu");
    for (i, section) in super::page_actions::page_actions(ws, host, target, cx)
        .into_iter()
        .enumerate()
    {
        if i > 0 {
            menu = menu.separator(theme);
        }
        if let Some(title) = section.title {
            menu = menu.section(title, theme);
        }
        for item in section.items {
            menu = menu.item(menu_item(ws, item));
        }
    }
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
    /// M41: the manuscript export or the Markdown share, over the workspace
    /// in the slot other crates' dialogs use, until it closes.
    pub fn open_export(
        &mut self,
        request: dr_view_export::Request,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let strings = crate::Strings::get(cx);
        let (locale, platform) = (strings.locale(), strings.platform());
        let (lib, book) = (self.library.clone(), self.book_id.clone());
        let dialog = cx.new(|cx| {
            dr_view_export::ExportDialog::new(lib, book, request, locale, platform, window, cx)
        });
        cx.subscribe_in(&dialog, window, |ws, _, event, window, cx| {
            if *event == dr_view_export::ExportEvent::Close {
                ws.dialog = None;
                ws.refocus(window, cx);
                cx.notify();
            }
        })
        .detach();
        self.dialog = Some(dialog.into());
        cx.notify();
    }

    /// M09: the snapshot history of prose document `doc` (its page is called
    /// `name`), over the workspace until it closes.
    pub fn open_history(
        &mut self,
        doc: String,
        name: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let strings = crate::Strings::get(cx);
        let (locale, platform) = (strings.locale(), strings.platform());
        let lib = self.library.clone();
        let dialog =
            cx.new(|cx| dr_view_history::HistoryDialog::new(lib, doc, name, locale, platform, cx));
        cx.subscribe_in(&dialog, window, |ws, _, event, window, cx| {
            if *event == dr_view_history::HistoryEvent::Close {
                ws.history = None;
                ws.focus.focus(window, cx);
                cx.notify();
            }
        })
        .detach();
        self.history = Some(dialog);
        cx.notify();
    }

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
