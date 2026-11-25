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
//! - **⋯** (`more`): the page's menu (`page_actions`): rows modules add for
//!   the page ([`crate::pages::add_page_menu`]), 历史快照… on material prose
//!   pages, and dangerous rows at the bottom. Manuscript export moved to the
//!   workspace avatar menu (`account.rs`).
//! - **一炷香** (`incense`): [`ToggleImmersiveWriting`]. In a split only the
//!   right page has it, as in the 0.1 client.
//!
//! A page registered with [`crate::pages::add_page_without_corner_tools`]
//! (the module workbench, CW) has none of them.
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
    style::DrStyled as _,
    tokens::glass as g,
};
use dr_workspace::Actor;
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, InteractiveElement, IntoElement,
    ParentElement, Styled, Window, div, prelude::FluentBuilder as _, px,
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

/// How many open comments are anchored to `target` (for the corner badge).
fn count_open_comments(book: &crate::book::Book, target: Option<&Target>) -> usize {
    let Some(v3) = book.v3() else {
        return 0;
    };
    match target {
        Some(Target::Entry { id, .. }) => {
            use crate::book::v3::OpenSpotKind as K;
            v3.open_comments
                .iter()
                .filter(|c| match &c.spot {
                    K::EntryTitle { entry }
                    | K::ModuleHeader { entry, .. }
                    | K::Field { entry, .. }
                    | K::KvRow { entry, .. }
                    | K::PlotCell { entry, .. }
                    | K::Patch { entry, .. }
                    | K::Media { entry, .. }
                    | K::Embed { entry, .. } => entry == id.as_str(),
                    K::Asset { .. } => false,
                })
                .count()
        }
        Some(Target::Material(id)) => v3.any_asset_comments(id.as_str()).len(),
        Some(t) if t.is_book() => v3.open_comments.len(),
        _ => 0,
    }
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
    // A filled panel covers the paper: the corner would stand on the
    // filled panel's own foot (the left column's 进模板结构 and 新建模板).
    if w.immersive || w.fill_covers_paper() {
        return div().into_any_element();
    }
    // A page that has none (the module workbench, CW).
    if target.is_some_and(|t| pages::without_corner_tools(t, cx)) {
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
    let planned = matches!(target, Some(Target::Entry { .. }));
    if planned && pages::has_bottom_panel_for(BottomPane::Planner, &w.book, cx) {
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
                    keys::v3_shell::HIDE_OUTLINE
                } else {
                    keys::v3_shell::SHOW_OUTLINE
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
    // Every prose, entry, or flattened book page has page toggles and a ⋯ menu.
    let doc_page = target.and_then(crate::book::doc_of).is_some()
        || matches!(target, Some(Target::Entry { .. }))
        || target.is_some_and(Target::is_book);
    if doc_page {
        let links_on =
            crate::Settings::read(cx).bool(crate::settings::registry::ENTITY_LINK_INTERACTIVE);
        tools.push(
            IconButton::new(
                gpui::ElementId::Name(format!("corner-entity-links-{key}").into()),
                Icon::KnotLinks,
            )
            .in_tray()
            .selected(links_on)
            .label(t(cx, keys::shell_ui::TOGGLE_ENTITY_LINKS))
            .on_click(move |_, _, cx| {
                let next = !crate::Settings::read(cx)
                    .bool(crate::settings::registry::ENTITY_LINK_INTERACTIVE);
                crate::Settings::update(cx, |file| {
                    let _ = file.set(
                        crate::settings::registry::ENTITY_LINK_INTERACTIVE,
                        next.into(),
                        None,
                    );
                });
            })
            .into_any_element(),
        );
        let comments_on =
            crate::Settings::read(cx).bool(crate::settings::registry::COMMENT_MARKS_VISIBLE);
        let open_comments = count_open_comments(&w.book, target);
        let comment_btn = div()
            .relative()
            .child(
                IconButton::new(
                    gpui::ElementId::Name(format!("corner-comments-{key}").into()),
                    Icon::Comment,
                )
                .in_tray()
                .selected(comments_on)
                .label(t(cx, keys::shell_ui::TOGGLE_COMMENT_MARKS))
                .on_click(move |_, _, cx| {
                    let next = !crate::Settings::read(cx)
                        .bool(crate::settings::registry::COMMENT_MARKS_VISIBLE);
                    crate::Settings::update(cx, |file| {
                        let _ = file.set(
                            crate::settings::registry::COMMENT_MARKS_VISIBLE,
                            next.into(),
                            None,
                        );
                    });
                }),
            )
            .when(open_comments > 0, |el| {
                let text = if open_comments > 99 {
                    "99+".to_owned()
                } else {
                    open_comments.to_string()
                };
                el.child(
                    div()
                        .absolute()
                        .top(px(-2.0))
                        .right(px(-2.0))
                        .min_w(px(14.0))
                        .h(px(14.0))
                        .px(px(3.0))
                        .rounded_full()
                        .bg(p.accent.solid())
                        .flex()
                        .items_center()
                        .justify_center()
                        .font_role(dr_ui::fonts::Role::Index)
                        .type_px(9.0, 9.0)
                        .text_color(p.page.solid())
                        .child(text),
                )
            });
        tools.push(comment_btn.into_any_element());

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
            // Round with nothing round its corners, as a floating button:
            // the corner may stand on the desk or on the paper (UP).
            Spec::new(Tone::Clear, (g::PILL_HEIGHT + 2.0 * g::TRAY_PADDING) / 2.0)
                .origin(glass::SAMPLE_ORIGINS[0])
                .rim(12.0)
                .ground(glass::Ground::Uneven),
            window,
            cx,
        )
        .rounded_full()
        .bg(p.page.solid())
        .child(glass::surface(
            glass::Ground::flat(p.page),
            div()
                .flex()
                .flex_row()
                .gap(px(2.0))
                .p(px(g::TRAY_PADDING))
                .children(tools),
        ))
    });

    let timeline = (trailing && pages::has_bottom_panel_for(BottomPane::Timeline, &w.book, cx))
        .then(|| {
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
                    keys::v3_shell::COLLAPSE_TIMELINE
                } else {
                    keys::v3_shell::EXPAND_TIMELINE
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
        _ => None,
    };

    div()
        .debug_selector(|| "paper-corner".into())
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
    let mut has_rows = false;
    for section in super::page_actions::page_actions(ws, host, target, cx) {
        if section.items.is_empty() {
            continue;
        }
        if has_rows {
            menu = menu.separator(theme);
        }
        if let Some(title) = section.title {
            menu = menu.section(title, theme);
        }
        for item in section.items {
            menu = menu.item(menu_item(ws, item));
        }
        has_rows = true;
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
    /// M41: opens the manuscript export dialog over the workspace (for both
    /// `成书` and bookless projects) until it closes.
    pub fn open_export(
        &mut self,
        request: dr_view_export::Request,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.notifications_open = false;
        self.account_open = false;
        let strings = crate::Strings::get(cx);
        let (locale, platform) = (strings.locale(), strings.platform());
        let (lib, book) = (self.library.clone(), self.book_id.clone());
        let preferred_font = crate::settings::fonts::resolved_prose_family(cx);
        let dialog = cx.new(|cx| {
            let mut d =
                dr_view_export::ExportDialog::new(lib, book, request, locale, platform, window, cx);
            d.set_preferred_font(preferred_font);
            d
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
