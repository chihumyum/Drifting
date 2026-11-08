//! dr-view-elements: the element and category pages (module M11).
//!
//! An element's or a category's page is its text in the shell's editor;
//! this crate draws what goes around the text (dr-editor's `PageChrome`,
//! which scrolls with it), as the 0.1 client's `ElementEditorView` and
//! `CategoryEditorView` laid it out:
//!
//! - **Element**: above the text the folio (要素 · its category), the name,
//!   the aliases, the summary and the head of 「记 · 传」; under it 「字段」
//!   and 「关联」 (dr-view-relations, M17).
//! - **Category**: above the text the folio (类目 · name · how many
//!   elements), the name beside the big folded-corner mark, the count and
//!   the colour, the head of 「札记」; under it 「要素清单」.
//! - **Storyline** (M13): above the text the folio, the name beside the big
//!   dash, the summary, the colour, the head of 「札记」; under it 「字段」
//!   and 「章节序列」 ([`storyline`]).
//! - The ⋯ menu's rows for these pages ([`menu`]) and their dialogs
//!   ([`dialogs`]), and the left sidebar's elements panel ([`panel`]).
//!
//! What it shows comes from the shell's book snapshot; what it changes goes
//! through F3 (`element.update`, `category.update`). Relations, patches,
//! the templates, references and the Agent's field review are later
//! milestones (docs/rust-rewrite/modules/m11-elements.md).
//!
//! The app registers it with [`init`]; the shell asks it for the chrome of
//! each element and category page it opens (`dr_shell::pages`).

pub mod category;
pub mod data;
pub mod dialogs;
pub mod element;
pub mod fields;
pub mod menu;
mod page;
pub mod panel;
pub mod storyline;
pub mod swatch;
pub mod template;

use std::collections::HashMap;
use std::rc::Rc;

use dr_editor::{PageChrome, PageInfo};
use dr_shell::nav::Target;
use gpui::{
    AnyElement, AnyView, App, AppContext as _, Entity, Global, IntoElement as _, WeakEntity, Window,
};

pub use category::{CategoryEnd, CategoryHead, Filter};
pub use element::ElementHead;
pub use fields::Fields;

/// The views a page shows around its text.
pub struct Chrome {
    pub head: AnyView,
    pub end: AnyView,
}

impl PageChrome for Chrome {
    fn head(&self, _: &PageInfo, _: &mut Window, _: &mut App) -> Option<AnyElement> {
        Some(self.head.clone().into_any_element())
    }

    fn end(&self, _: &PageInfo, _: &mut Window, _: &mut App) -> Option<AnyElement> {
        Some(self.end.clone().into_any_element())
    }

    fn head_estimate(&self, _: &PageInfo) -> f32 {
        300.0
    }

    fn end_estimate(&self, _: &PageInfo) -> f32 {
        200.0
    }
}

/// The views each open element or category page shows, by id (the newest
/// page of one wins), for tests and the debug bridge.
#[derive(Default)]
struct Views {
    elements: HashMap<String, (WeakEntity<ElementHead>, WeakEntity<Fields>)>,
    categories: HashMap<String, (WeakEntity<CategoryHead>, WeakEntity<CategoryEnd>)>,
    storylines: HashMap<
        String,
        (
            WeakEntity<storyline::StorylineHead>,
            WeakEntity<storyline::StorylineEnd>,
        ),
    >,
    /// 「关联」 under each open element page's fields (M17).
    relations: HashMap<String, WeakEntity<dr_view_relations::Relations>>,
    /// The panels the shell's left sidebars show.
    panels: Vec<WeakEntity<panel::ElementPanel>>,
}

impl Global for Views {}

/// The head and fields of element `id`'s page, while it is open.
pub fn element_page(id: &str, cx: &App) -> Option<(Entity<ElementHead>, Entity<Fields>)> {
    let (head, end) = cx.try_global::<Views>()?.elements.get(id)?;
    Some((head.upgrade()?, end.upgrade()?))
}

/// 「关联」 on element `id`'s page, while it is open.
pub fn element_relations(id: &str, cx: &App) -> Option<Entity<dr_view_relations::Relations>> {
    cx.try_global::<Views>()?.relations.get(id)?.upgrade()
}

/// An element page's end: 「字段」, then 「关联」 (M17, as the 0.1
/// `ElementEditorView` put the relations section under the fields).
pub struct ElementEnd {
    pub fields: Entity<Fields>,
    pub relations: Entity<dr_view_relations::Relations>,
}

impl gpui::Render for ElementEnd {
    fn render(&mut self, _: &mut Window, _: &mut gpui::Context<Self>) -> impl gpui::IntoElement {
        use gpui::{ParentElement as _, Styled as _};
        gpui::div()
            .w_full()
            .flex()
            .flex_col()
            .child(self.fields.clone())
            .child(self.relations.clone())
    }
}

/// The head and element list of category `id`'s page, while it is open.
pub fn category_page(id: &str, cx: &App) -> Option<(Entity<CategoryHead>, Entity<CategoryEnd>)> {
    let (head, end) = cx.try_global::<Views>()?.categories.get(id)?;
    Some((head.upgrade()?, end.upgrade()?))
}

/// Now, ms since the epoch.
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The elements panel for one sidebar pane of the window of `ws`: its list
/// and its head row (the shell hosts both once it has a place for them).
pub fn make_panel(
    ws: gpui::WeakEntity<dr_shell::Workspace>,
    cx: &mut App,
) -> (Entity<panel::ElementPanel>, Entity<panel::PanelHead>) {
    let list = cx.new(|cx| panel::ElementPanel::new(ws.clone(), cx));
    let head = {
        let list = list.clone();
        cx.new(|cx| panel::PanelHead::new(list, ws, cx))
    };
    (list, head)
}

/// The elements panels the shell's left sidebars show now (one per half
/// that has shown the 要素 tab).
pub fn sidebar_panels(cx: &App) -> Vec<Entity<panel::ElementPanel>> {
    cx.try_global::<Views>()
        .map(|v| v.panels.iter().filter_map(|p| p.upgrade()).collect())
        .unwrap_or_default()
}

/// The head and end of storyline `id`'s page, while it is open.
pub fn storyline_page(
    id: &str,
    cx: &App,
) -> Option<(
    Entity<storyline::StorylineHead>,
    Entity<storyline::StorylineEnd>,
)> {
    let (head, end) = cx.try_global::<Views>()?.storylines.get(id)?;
    Some((head.upgrade()?, end.upgrade()?))
}

/// Registers the element, category and storyline pages' chrome and ⋯
/// rows and the left sidebar's 要素 panel with the shell, and makes their
/// dialogs.
pub fn init(cx: &mut App) {
    dialogs::init(cx);
    menu::register(cx);
    dr_shell::pages::add_left_panel(cx, |tab, ws, _, cx| {
        (tab == dr_shell::workspace::LeftTab::Elements).then(|| {
            let (body, head) = make_panel(ws, cx);
            let views = cx.default_global::<Views>();
            views.panels.retain(|p| p.upgrade().is_some());
            views.panels.push(body.downgrade());
            dr_shell::pages::LeftPanel {
                head: head.into(),
                body: body.into(),
            }
        })
    });
    dr_shell::pages::add_page_chrome(cx, |target, host, window, cx| {
        let ws = host.workspace;
        let chrome = match target {
            Target::Element(id) => {
                let id = id.to_string();
                let head = {
                    let (id, ws) = (id.clone(), ws.clone());
                    cx.new(|cx| ElementHead::new(id, ws, window, cx))
                };
                // 「字段」 is no longer the page's last section: 「关联」 follows.
                let fields = cx.new(|cx| {
                    Fields::new(fields::Owner::Element(id.clone()), false, ws.clone(), cx)
                });
                let relations = dr_view_relations::relations(
                    dr_view_relations::model::end("element", &id),
                    ws,
                    window,
                    cx,
                );
                let views = cx.default_global::<Views>();
                views
                    .elements
                    .insert(id.clone(), (head.downgrade(), fields.downgrade()));
                views.relations.insert(id, relations.downgrade());
                let end = cx.new(|_| ElementEnd { fields, relations });
                Chrome {
                    head: head.into(),
                    end: end.into(),
                }
            }
            Target::Category(id) => {
                let id = id.to_string();
                let head = {
                    let (id, ws) = (id.clone(), ws.clone());
                    cx.new(|cx| CategoryHead::new(id, ws, window, cx))
                };
                let end = cx.new(|cx| CategoryEnd::new(id.clone(), ws, cx));
                cx.default_global::<Views>()
                    .categories
                    .insert(id, (head.downgrade(), end.downgrade()));
                Chrome {
                    head: head.into(),
                    end: end.into(),
                }
            }
            // M13: the storyline page.
            Target::Storyline(id) => {
                let id = id.to_string();
                let head = {
                    let (id, ws) = (id.clone(), ws.clone());
                    cx.new(|cx| storyline::StorylineHead::new(id, ws, window, cx))
                };
                let end = cx.new(|cx| storyline::StorylineEnd::new(id.clone(), ws, cx));
                cx.default_global::<Views>()
                    .storylines
                    .insert(id, (head.downgrade(), end.downgrade()));
                Chrome {
                    head: head.into(),
                    end: end.into(),
                }
            }
            _ => return None,
        };
        Some(Rc::new(chrome) as Rc<dyn PageChrome>)
    });
}
