//! dr-view-ideas: the 构想 panel in the left sidebar (module M16), the 0.1
//! client's `components/leftBars/DriftPanel.tsx`, the drift half of
//! `LeftSidebarSubHeader.tsx` and `usecase/useDriftGroup.ts` (desktop).
//!
//! - **Groups** nest at most two levels (F3's rule). A top-level group's
//!   head: a chevron, a folder in the group's colour, the name, 「· N」 (its
//!   ideas and its sub-groups'), and under the pointer 新建子分组 and 在此新建
//!   构想. A sub-group's head is quieter (index type, its + under the
//!   pointer). A click folds or unfolds it, a double click renames it in
//!   place; resting on it shows its card: 新建子分组, 在此新建构想, 重命名,
//!   移动到分组… (where its levels fit), 删除分组 (its sub-groups and ideas
//!   move up, as 0.1).
//! - **Ideas**: an eddy in the group's colour (fainter, ink, when in no
//!   group), the title (「未命名」), the date or the words at the right
//!   (hidden under 200 px). A resting idea stays in its place, muted (0.1
//!   merged the rest drawer into the list). A click previews it, a double
//!   click keeps it; resting on it shows its page card (the shell's) with
//!   移动到分组 added. Inside a group its sub-groups come first, then its
//!   ideas; the ideas in no group follow the groups.
//! - **Head**: 「N 条构想」, 展开／折叠全部, the sort menu (排序构想: newest
//!   made, last changed, title; 单元格右侧: date, words, both, neither), 新建
//!   分组 and 新构想 (made and opened).
//! - An idea's ⋯ menu gains 构想状态 (漂流 / 休息), 移动到分组 and 删除节点
//!   ([`menu`]).
//!
//! Everything is read from the shell's book snapshot and written through
//! F3's `idea.*` and `idea_group.*`; F3's events bring the new snapshot.
//! docs/rust-rewrite/modules/m16-ideas.md has the rules and what is left.

pub mod data;
pub mod menu;
pub mod model;
pub mod panel;

pub use panel::{IdeaPanel, PanelHead};

use dr_shell::workspace::LeftTab;
use gpui::{App, AppContext as _, Entity, Global, WeakEntity};

/// Now, ms since the epoch.
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The panels the shell's left sidebars show now (tests, the debug bridge).
#[derive(Default)]
struct Panels(Vec<WeakEntity<IdeaPanel>>);

impl Global for Panels {}

/// The 构想 panels shown now (one per sidebar half that showed the tab).
pub fn panels(cx: &App) -> Vec<Entity<IdeaPanel>> {
    cx.try_global::<Panels>()
        .map(|p| p.0.iter().filter_map(|w| w.upgrade()).collect())
        .unwrap_or_default()
}

/// The panel and its head for one sidebar pane of the window of `ws`.
pub fn make_panel(
    ws: WeakEntity<dr_shell::Workspace>,
    cx: &mut App,
) -> (Entity<IdeaPanel>, Entity<PanelHead>) {
    let list = cx.new(|cx| IdeaPanel::new(ws, cx));
    let head = {
        let list = list.clone();
        cx.new(|cx| PanelHead::new(list, cx))
    };
    (list, head)
}

/// Registers the 构想 tab's panel and an idea's ⋯ rows with the shell.
pub fn init(cx: &mut App) {
    dr_shell::pages::add_left_panel(cx, |tab, ws, _, cx| {
        (tab == LeftTab::Drifts).then(|| {
            let (body, head) = make_panel(ws, cx);
            let panels = cx.default_global::<Panels>();
            panels.0.retain(|p| p.upgrade().is_some());
            panels.0.push(body.downgrade());
            dr_shell::pages::LeftPanel {
                head: head.into(),
                body: body.into(),
            }
        })
    });
    dr_shell::pages::add_page_menu(cx, menu::sections);
}
