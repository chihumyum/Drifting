//! What an idea's ⋯ menu (and its hover card in the sidebar) adds, as the
//! 0.1 client's `getMenuItems` for a drift: 构想状态 (漂流 / 休息), 移动到分组
//! (when the book has groups), and 删除节点 last. 转成章节 / 转成要素 are a
//! later milestone.

use std::rc::Rc;

use dr_i18n::keys::editor_top_bar as etb;
use dr_shell::nav::Target;
use dr_shell::pages::{PageMenuHost, PageMenuItem, PageMenuSection};
use dr_shell::strings::t;
use dr_ui::sand::Icon;
use dr_workspace::{Workspace as Library, WsError};
use gpui::App;

use crate::data;

/// Runs `f` on the library off the main thread.
fn background(
    host: &PageMenuHost,
    what: &'static str,
    f: impl Fn(&Library, &str) -> Result<(), WsError> + Send + Sync + 'static,
) -> dr_shell::pages::RunRow {
    let (lib, book) = (host.library.clone(), host.book_id.clone());
    let f = std::sync::Arc::new(f);
    Rc::new(move |_, cx: &mut App| {
        let Some(lib) = lib.clone() else {
            return;
        };
        let (book, f) = (book.clone(), f.clone());
        cx.background_executor()
            .spawn(async move {
                if let Err(error) = f(&lib, &book) {
                    log::warn!("{what} failed: {error}");
                }
            })
            .detach();
    })
}

/// The rows for `target` (an idea's page only).
pub fn sections(target: &Target, host: &PageMenuHost, cx: &App) -> Vec<PageMenuSection> {
    let Target::Idea(id) = target else {
        return Vec::new();
    };
    let id = id.to_string();
    let Some(idea) = host.book.ideas.iter().find(|i| i.id == id) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    // 构想状态: drifting like a seed on its fluff, resting like a sunk stone.
    let status = |value: &'static str, icon: Icon, label| {
        let id = id.clone();
        PageMenuItem {
            id: format!("idea-status-{value}").into(),
            icon: icon.into(),
            label: t(cx, label),
            checked: idea.status == value,
            danger: false,
            run: background(host, "setting an idea's status", move |lib, book| {
                data::set_status(lib, book, &id, value)
            }),
        }
    };
    out.push(PageMenuSection {
        title: Some(t(cx, etb::status_section::DRIFT)),
        items: vec![
            status("drifting", Icon::Fluff, etb::status::DRIFTING),
            status("resting", Icon::StoneSunk, etb::status::RESTING),
        ],
    });
    let mover = |group: Option<String>| {
        let id = id.clone();
        background(host, "moving an idea", move |lib, book| {
            data::move_idea(lib, book, &id, group.as_deref())
        })
    };
    if let Some(section) = crate::panel::idea_move_section(&host.book, idea, mover, cx) {
        out.push(section);
    }
    let trash = {
        let id = id.clone();
        background(host, "deleting an idea", move |lib, book| {
            data::trash_idea(lib, book, &id)
        })
    };
    out.push(PageMenuSection {
        title: None,
        items: vec![PageMenuItem {
            id: "idea-delete".into(),
            icon: Icon::Trash.into(),
            label: t(cx, etb::menu::DELETE_NODE),
            checked: false,
            danger: true,
            run: trash,
        }],
    });
    out
}
