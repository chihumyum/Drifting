//! The rows an element's or a category's page adds to its ⋯ menu (the 0.1
//! `EditorTopBar`): 「更改类目」 (the category's mark) and 「更改分组」
//! (a folder) as plain rows, 「删除要素」 as the danger row after the
//! hairline; a category page has 「删除类目」 only. Each opens its dialog
//! ([`crate::dialogs`]).
//!
//! The shell draws the ⋯ menu; it asks [`rows`] for the page in front once
//! it has a place for a module's rows (m11-elements.md, 「待协调」 F6).

use std::rc::Rc;

use dr_i18n::keys;
use dr_shell::nav::Target;
use dr_shell::{Workspace, t};
use dr_ui::{components::menu::RowIcon, sand};
use gpui::{App, SharedString, WeakEntity, Window};

use crate::dialogs::{self, AskFor};

/// What a row does: opens its dialog for the window of the workspace.
pub type Run = Rc<dyn Fn(WeakEntity<Workspace>, &mut Window, &mut App)>;

/// One row of the ⋯ menu.
#[derive(Clone)]
pub struct MenuRow {
    pub id: &'static str,
    pub label: SharedString,
    pub icon: RowIcon,
    /// After the hairline, in the danger's ink.
    pub danger: bool,
    pub run: Run,
}

/// The rows `target`'s page adds, plain ones first.
pub fn rows(target: &Target, cx: &App) -> Vec<MenuRow> {
    match target {
        Target::Element(id) => {
            let id = id.to_string();
            let ask = |make: fn(String) -> AskFor, id: &String| -> Run {
                let id = id.clone();
                Rc::new(move |ws, window, cx| dialogs::open(make(id.clone()), ws, window, cx))
            };
            vec![
                MenuRow {
                    id: "element-change-category",
                    label: t(cx, keys::editor_top_bar::menu::CHANGE_CATEGORY),
                    icon: RowIcon::Mark(sand::Kind::Category, None),
                    danger: false,
                    run: ask(AskFor::ChangeCategory, &id),
                },
                MenuRow {
                    id: "element-change-group",
                    label: t(cx, keys::editor_top_bar::menu::CHANGE_GROUP),
                    icon: RowIcon::Brush(dr_ui::sand::Icon::Folder),
                    danger: false,
                    run: ask(AskFor::ChangeGroup, &id),
                },
                MenuRow {
                    id: "element-delete",
                    label: t(cx, keys::editor_top_bar::menu::DELETE_ELEMENT),
                    icon: RowIcon::Brush(dr_ui::sand::Icon::Trash),
                    danger: true,
                    run: ask(AskFor::DeleteElement, &id),
                },
            ]
        }
        Target::Category(id) => {
            let id = id.to_string();
            vec![MenuRow {
                id: "category-delete",
                label: t(cx, keys::editor_top_bar::menu::DELETE_CATEGORY),
                icon: RowIcon::Brush(dr_ui::sand::Icon::Trash),
                danger: true,
                run: Rc::new(move |ws, window, cx| {
                    dialogs::open(AskFor::DeleteCategory(id.clone()), ws, window, cx)
                }),
            }]
        }
        _ => Vec::new(),
    }
}
