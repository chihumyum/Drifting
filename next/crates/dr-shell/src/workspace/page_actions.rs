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

/// What putting `chapter` on `storyline` or taking it off writes (the 0.1
/// client's `useChapterStorylineToggle`): its live storylines, the main one
/// first; the toggled one taken out, or added at the end; the first left is
/// the main one. `(add, remove, primary)`, `primary` only when it changes.
pub(crate) fn storyline_toggle(
    on: &[String],
    primary: Option<&str>,
    live: &[&str],
    storyline: &str,
) -> (Vec<String>, Vec<String>, Option<Option<String>>) {
    let mapped: Vec<&str> = on
        .iter()
        .map(String::as_str)
        .filter(|s| live.contains(s))
        .collect();
    let main = primary
        .filter(|p| mapped.contains(p))
        .or_else(|| mapped.first().copied());
    let mut ordered: Vec<&str> = main.into_iter().collect();
    ordered.extend(mapped.iter().filter(|s| Some(**s) != main));
    let (add, remove) = if ordered.contains(&storyline) {
        ordered.retain(|s| *s != storyline);
        (Vec::new(), vec![storyline.to_owned()])
    } else {
        ordered.push(storyline);
        (vec![storyline.to_owned()], Vec::new())
    };
    let next = ordered.first().copied();
    let primary = (next != primary).then(|| next.map(str::to_owned));
    (add, remove, primary)
}

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
    // 编辑故事线: a chapter on its storylines, ticked.
    if let Some(chapter) = chapter
        && !host.book.storylines.is_empty()
    {
        let live: Vec<&str> = host.book.storylines.iter().map(|s| s.id.as_str()).collect();
        let items = host
            .book
            .storylines
            .iter()
            .map(|s| {
                let (add, remove, primary) = storyline_toggle(
                    &chapter.storylines,
                    chapter.primary_storyline.as_deref(),
                    &live,
                    &s.id,
                );
                let (ws, id) = (ws.clone(), chapter.id.clone());
                let label: SharedString = if s.name.trim().is_empty() {
                    t(cx, keys::top_timeline::untitled::STORYLINE)
                } else {
                    s.name.clone().into()
                };
                PageMenuItem {
                    id: format!("storyline-{}", s.id).into(),
                    icon: dr_ui::components::menu::RowIcon::Mark(
                        dr_ui::sand::Kind::Storyline,
                        crate::book::color_of(&s.color),
                    ),
                    label,
                    checked: chapter.storylines.contains(&s.id),
                    danger: false,
                    run: Rc::new(move |_, cx| {
                        let mut input = json!({
                            "book": "",
                            "id": id,
                            "add_storylines": add,
                            "remove_storylines": remove,
                        });
                        if let Some(primary) = &primary {
                            input["primary_storyline"] = json!(primary);
                        }
                        ws.update(cx, |ws, cx| {
                            input["book"] = json!(ws.book_id);
                            ws.run_command("chapter.update", input, cx)
                        })
                    }),
                }
            })
            .collect();
        sections.push(PageMenuSection {
            title: Some(t(cx, keys::editor_top_bar::menu::EDIT_STORYLINES)),
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
    fn a_storyline_is_put_on_or_taken_off_and_the_first_left_is_the_main() {
        let live = ["a", "b", "c"];
        let on = |ids: &[&str]| ids.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let s = |v: &[&str]| on(v);
        // On none: added, and it is the main one.
        assert_eq!(
            storyline_toggle(&[], None, &live, "b"),
            (s(&["b"]), s(&[]), Some(Some("b".into())))
        );
        // Added beside the main one: the main one stays.
        assert_eq!(
            storyline_toggle(&on(&["a"]), Some("a"), &live, "c"),
            (s(&["c"]), s(&[]), None)
        );
        // The main one taken off: the next one is the main one.
        assert_eq!(
            storyline_toggle(&on(&["c", "a"]), Some("a"), &live, "a"),
            (s(&[]), s(&["a"]), Some(Some("c".into())))
        );
        // The last one taken off: no main one.
        assert_eq!(
            storyline_toggle(&on(&["a"]), Some("a"), &live, "a"),
            (s(&[]), s(&["a"]), Some(None))
        );
        // A gone storyline does not count.
        assert_eq!(
            storyline_toggle(&on(&["x", "b"]), Some("x"), &live, "c"),
            (s(&["c"]), s(&[]), Some(Some("b".into())))
        );
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

    #[test]
    fn materials_are_not_shared() {
        assert!(shares("node:1") && shares("element:1") && shares("category:1"));
        assert!(shares("storyline:1"));
        assert!(!shares("material:1"));
    }
}
