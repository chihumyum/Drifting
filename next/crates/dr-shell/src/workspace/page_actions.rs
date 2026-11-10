//! What can be done to a page, listed once: the ⋯ menu in the paper's
//! corner and the page's hover card in the sidebar both show this list (the
//! 0.1 client's `getMenuItems`, behind its ⋯ menu and its hover cards).
//!
//! In order: share (and a chapter's 导出成稿); a chapter's writing status;
//! a chapter's 编辑故事线 (every storyline, ticked while the chapter is on
//! it; a click puts it on or takes it off, the first one left is its main
//! storyline, as the 0.1 hover card's choices did); the rows modules add
//! ([`crate::pages::add_page_menu`]); 历史快照…; last, what deletes (a
//! chapter's 删除节点, the modules' dangerous rows).

use std::rc::Rc;

use dr_i18n::keys;
use dr_ui::sand::Icon;
use gpui::{App, Entity, SharedString};

use super::Workspace;
use crate::nav::Target;
use crate::pages::{PageMenuHost, PageMenuItem, PageMenuSection};
use crate::strings::t;

fn row(
    id: &str,
    icon: Icon,
    label: SharedString,
    run: impl Fn(&mut gpui::Window, &mut App) + 'static,
) -> PageMenuItem {
    PageMenuItem {
        id: id.to_owned().into(),
        icon: icon.into(),
        label,
        checked: false,
        danger: false,
        run: Rc::new(run),
    }
}

/// Everything the page showing `target` offers, in sections; the last one
/// holds only dangerous rows. Empty for a page with no prose (Home).
pub fn page_actions(
    ws: &Entity<Workspace>,
    host: &PageMenuHost,
    target: &Target,
    cx: &App,
) -> Vec<PageMenuSection> {
    let mut sections = Vec::new();
    // The modules' rows; what deletes waits for the end.
    let mut dangerous = Vec::new();
    for section in crate::pages::menu_for(target, host, cx) {
        let (danger, plain): (Vec<_>, Vec<_>) =
            section.items.into_iter().partition(|item| item.danger);
        dangerous.extend(danger);
        if !plain.is_empty() {
            sections.push(PageMenuSection {
                title: section.title,
                items: plain,
            });
        }
    }
    if matches!(target, Target::Material(_))
        && let Some(doc) = crate::book::doc_of(target)
    {
        let name = super::title_of(&host.book, target, cx).to_string();
        let ws = ws.clone();
        sections.push(PageMenuSection {
            title: None,
            items: vec![row(
                "page-history",
                Icon::Rotate,
                t(cx, keys::right_sidebar::stats::SNAPSHOT_BUTTON),
                move |window, cx| {
                    ws.update(cx, |ws, cx| ws.open_history(doc.clone(), &name, window, cx));
                },
            )],
        });
    }
    if !dangerous.is_empty() {
        sections.push(PageMenuSection {
            title: None,
            items: dangerous,
        });
    }
    sections
}

/// `sections` with a module's own rows (a hover card's, M14): `lead` first,
/// `before_danger` before the dangerous rows, which stay last.
pub(crate) fn with_rows(
    mut sections: Vec<PageMenuSection>,
    rows: &crate::pages::CardRows,
) -> Vec<PageMenuSection> {
    let dangerous = sections
        .last()
        .is_some_and(|s| !s.items.is_empty() && s.items.iter().all(|i| i.danger));
    let at = sections.len() - usize::from(dangerous);
    let kept = |list: &[PageMenuSection]| -> Vec<PageMenuSection> {
        list.iter()
            .filter(|s| !s.items.is_empty())
            .cloned()
            .collect()
    };
    sections.splice(at..at, kept(&rows.before_danger));
    sections.splice(0..0, kept(&rows.lead));
    sections
}

#[cfg(test)]
mod tests {
    use super::*;

    fn section(ids: &[(&str, bool)]) -> PageMenuSection {
        PageMenuSection {
            title: None,
            items: ids
                .iter()
                .map(|&(id, danger)| PageMenuItem {
                    danger,
                    ..row(id, Icon::More, id.to_owned().into(), |_, _| {})
                })
                .collect(),
        }
    }

    fn ids(sections: &[PageMenuSection]) -> Vec<Vec<String>> {
        sections
            .iter()
            .map(|s| s.items.iter().map(|i| i.id.to_string()).collect())
            .collect()
    }

    #[test]
    fn a_modules_rows_go_before_what_deletes() {
        let page = vec![
            section(&[("share", false)]),
            section(&[("history", false)]),
            section(&[("trash", true)]),
        ];
        let rows = crate::pages::CardRows {
            lead: vec![section(&[("new-chapter", false)])],
            before_danger: vec![section(&[("to-unaffiliated", false)]), section(&[])],
        };
        assert_eq!(
            ids(&with_rows(page, &rows)),
            [
                vec!["new-chapter"],
                vec!["share"],
                vec!["history"],
                vec!["to-unaffiliated"],
                vec!["trash"]
            ]
        );
        // Nothing dangerous: at the end.
        let page = vec![section(&[("history", false)])];
        assert_eq!(
            ids(&with_rows(page, &rows)),
            [
                vec!["new-chapter"],
                vec!["history"],
                vec!["to-unaffiliated"]
            ]
        );
    }
}
