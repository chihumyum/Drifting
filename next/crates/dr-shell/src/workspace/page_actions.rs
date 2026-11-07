//! What can be done to a page, listed once: the ⋯ menu in the paper's
//! corner and the page's hover card in the sidebar both show this list (the
//! 0.1 client's `getMenuItems`, behind its ⋯ menu and its hover cards).
//!
//! In order: share (and a chapter's 导出成稿); a chapter's writing status;
//! the rows modules add ([`crate::pages::add_page_menu`]); 历史快照…; last,
//! what deletes (a chapter's 删除节点, the modules' dangerous rows).

use std::rc::Rc;

use dr_i18n::keys;
use dr_ui::sand::Icon;
use gpui::{App, Entity, SharedString};
use serde_json::json;

use super::Workspace;
use super::corner::STATUSES;
use crate::nav::Target;
use crate::pages::{PageMenuHost, PageMenuItem, PageMenuSection};
use crate::strings::t;

/// Whether M41 shares `doc` as Markdown: a chapter or an idea, an element,
/// a storyline, a category (not a material).
fn shares(doc: &str) -> bool {
    ["node:", "element:", "storyline:", "category:"]
        .iter()
        .any(|kind| doc.starts_with(kind))
}

fn status_label(cx: &App, status: &str) -> SharedString {
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

fn row(
    id: &str,
    icon: Icon,
    label: SharedString,
    run: impl Fn(&mut gpui::Window, &mut App) + 'static,
) -> PageMenuItem {
    PageMenuItem {
        id: id.to_owned().into(),
        icon,
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
    let Some(doc) = crate::book::doc_of(target) else {
        return Vec::new();
    };
    let chapter = match target {
        Target::Chapter(id) => host.book.chapters.iter().find(|c| c.id == id.as_str()),
        _ => None,
    };
    let mut sections = Vec::new();
    // Share, and a chapter's manuscript.
    let mut top = Vec::new();
    if shares(&doc) {
        let (ws, doc) = (ws.clone(), doc.clone());
        top.push(row(
            "page-share",
            Icon::Share,
            t(cx, keys::markdown_share::MENU),
            move |window, cx| {
                let request = dr_view_export::Request::Markdown(
                    dr_view_export::MarkdownTarget::Doc(doc.clone()),
                );
                ws.update(cx, |ws, cx| ws.open_export(request, window, cx));
            },
        ));
    }
    if let Some(chapter) = chapter {
        let (ws, id) = (ws.clone(), chapter.id.clone());
        top.push(row(
            "page-export",
            Icon::CaseRise,
            t(cx, keys::manuscript_export::MENU),
            move |window, cx| {
                let request = dr_view_export::Request::Manuscript {
                    chapter: Some(id.clone()),
                };
                ws.update(cx, |ws, cx| ws.open_export(request, window, cx));
            },
        ));
    }
    if !top.is_empty() {
        sections.push(PageMenuSection {
            title: None,
            items: top,
        });
    }
    // A chapter's writing status.
    if let Some(chapter) = chapter {
        let items = STATUSES
            .iter()
            .map(|&(status, icon)| {
                let (ws, id) = (ws.clone(), chapter.id.clone());
                let mut item = row(
                    &format!("status-{status}"),
                    icon,
                    status_label(cx, status),
                    move |_, cx| {
                        let id = id.clone();
                        ws.update(cx, |ws, cx| {
                            ws.run_command(
                                "chapter.update",
                                json!({"book": ws.book_id, "id": id, "status": status}),
                                cx,
                            )
                        })
                    },
                );
                item.checked = chapter.status == status;
                item
            })
            .collect();
        sections.push(PageMenuSection {
            title: Some(t(cx, keys::editor_top_bar::status_section::CHAPTER)),
            items,
        });
    }
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
    // The snapshot history (M09).
    let name = super::title_of(&host.book, target, cx).to_string();
    let history = {
        let (ws, doc) = (ws.clone(), doc.clone());
        row(
            "page-history",
            Icon::Rotate,
            t(cx, keys::right_sidebar::stats::SNAPSHOT_BUTTON),
            move |window, cx| {
                let doc = doc.clone();
                ws.update(cx, |ws, cx| ws.open_history(doc, &name, window, cx));
            },
        )
    };
    sections.push(PageMenuSection {
        title: None,
        items: vec![history],
    });
    if let Some(chapter) = chapter {
        let (ws, id) = (ws.clone(), chapter.id.clone());
        let mut trash = row(
            "chapter-trash",
            Icon::Trash,
            t(cx, keys::editor_top_bar::menu::DELETE_NODE),
            move |_, cx| {
                let id = id.clone();
                ws.update(cx, |ws, cx| {
                    ws.run_command("chapter.trash", json!({"book": ws.book_id, "id": id}), cx)
                })
            },
        );
        trash.danger = true;
        dangerous.insert(0, trash);
    }
    if !dangerous.is_empty() {
        sections.push(PageMenuSection {
            title: None,
            items: dangerous,
        });
    }
    sections
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn materials_are_not_shared() {
        assert!(shares("node:1") && shares("element:1") && shares("category:1"));
        assert!(shares("storyline:1"));
        assert!(!shares("material:1"));
    }
}
