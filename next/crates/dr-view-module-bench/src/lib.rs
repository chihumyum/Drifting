//! The module workbench (`docs/rust-rewrite/custom-modules.md` §8, CM3):
//! one of my modules worked on in a pill of the project in front
//! (`Target::Module`). While its pill is in front and its page shows, the
//! left column holds 「装什么」 and the right column 「长什么样 · 写给 Agent ·
//! Agent」 (`dr_shell::pages::add_page_panels`); another pill in front, and
//! the columns hold what they held before. The bottom panel stays as it is.
//!
//! - [`edit`]: what a change does to the module, without a window.
//! - [`state`]: one workbench: the module, its writes, what it shows.
//! - [`page`]: the paper (name, what it is, the preview's four rows, the
//!   preview); [`panels`]: the side columns.
//!
//! Three ways in, one workbench: 「新建模块…」 and a module row's 「改」 in
//! the entry template editor (`dr-view-templates`), the Agent's
//! 「打开工作台」 card (`dr-view-agent`), and 「编辑」 on 全部项目
//! (`dr-view-shelf`): each opens `Target::Module` ([`open`]).

pub mod edit;
pub mod page;
pub mod panels;
pub mod state;

use std::cell::RefCell;
use std::collections::HashMap;

use dr_i18n::keys;
use dr_model::id::CustomModuleId;
use dr_shell::{
    Workspace,
    nav::{Open, Target},
    pages::{ModulePage, PagePanels, PageTab},
};
use gpui::{App, AppContext as _, Entity, EntityId, Global, SharedString, WeakEntity};

pub use page::BenchPage;
pub use panels::{BlocksPanel, GuidePanel, LookPanel};
pub use state::{Bench, Breadth, Content, GUIDE_TAB, LOOK_TAB};

/// The workbenches open in every window (by the window's workspace and the
/// module), while their pills are open.
#[derive(Default)]
pub struct Benches(pub HashMap<(EntityId, CustomModuleId), WeakEntity<Bench>>);

impl Global for Benches {}

/// The names of my modules a pill shows before its workbench is made (a
/// pill restored with the project, not yet in front), read once.
#[derive(Default)]
struct Names(RefCell<HashMap<CustomModuleId, String>>);

impl Global for Names {}

pub fn init(cx: &mut App) {
    cx.set_global(Benches::default());
    cx.set_global(Names::default());
    dr_shell::pages::add_page_view(cx, |target, host, window, cx| {
        let Target::Module(id) = target else {
            return None;
        };
        let bench = state::bench_for(id, &host, window, cx);
        let focus = bench.read(cx).focus.clone();
        let page = cx.new(|cx| BenchPage::new(bench, window, cx));
        Some(ModulePage {
            view: page.into(),
            focus,
        })
    });
    dr_shell::pages::add_page_panels(cx, |target, host, window, cx| {
        let Target::Module(id) = target else {
            return None;
        };
        let bench = state::bench_for(id, &host, window, cx);
        let left = cx.new(|cx| BlocksPanel::new(bench.clone(), cx));
        let look = cx.new(|cx| LookPanel::new(bench.clone(), cx));
        let guide = cx.new(|cx| GuidePanel::new(bench, cx));
        Some(PagePanels {
            left: left.into(),
            right: vec![
                PageTab {
                    slug: SharedString::new_static(LOOK_TAB),
                    label: keys::module_bench::LOOKS,
                    body: look.into(),
                },
                PageTab {
                    slug: SharedString::new_static(GUIDE_TAB),
                    label: keys::template_editor::FOR_AGENT,
                    body: guide.into(),
                },
            ],
        })
    });
    // The prototype's paper has no timeline, outline or incense in its
    // corner (CW).
    dr_shell::pages::add_page_without_corner_tools(cx, |target| {
        matches!(target, Target::Module(_))
    });
    dr_shell::pages::add_page_title(cx, |target, cx| {
        let Target::Module(id) = target else {
            return None;
        };
        let open = cx
            .try_global::<Benches>()?
            .0
            .iter()
            .filter(|((_, m), _)| m == id)
            .find_map(|(_, b)| b.upgrade())
            .and_then(|b| b.read(cx).name().map(str::to_owned));
        if let Some(name) = open {
            return Some(name.into());
        }
        let names = cx.try_global::<Names>()?;
        if let Some(name) = names.0.borrow().get(id) {
            return Some(name.clone().into());
        }
        let lib = cx.try_global::<dr_shell::Services>()?.library.clone()?;
        let name = dr_workspace::commands::v3::custom_module::my_module(&lib, id)
            .ok()
            .flatten()
            .map(|(_, v)| v.name)?;
        names.0.borrow_mut().insert(id.clone(), name.clone());
        Some(name.into())
    });
}

/// Opens module `id`'s workbench in `ws`'s window: a kept pill of the
/// project in front.
pub fn open(ws: &Entity<Workspace>, id: CustomModuleId, cx: &mut App) {
    ws.update(cx, |ws, cx| ws.open(Target::Module(id), Open::KEEP, cx));
}

/// The workbench of `id` open in `ws`'s window, if any (tests, the bridge).
pub fn bench_of(ws: &Entity<Workspace>, id: &CustomModuleId, cx: &App) -> Option<Entity<Bench>> {
    cx.try_global::<Benches>()?
        .0
        .get(&(ws.entity_id(), id.clone()))?
        .upgrade()
}
