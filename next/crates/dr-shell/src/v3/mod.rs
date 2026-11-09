//! V3 composition contracts. Renderers own editing; the shell owns ordering,
//! navigation, the snapshot and the lifetime of each rendered part.
use crate::{
    book::Book,
    nav::{Lines, Target},
    pages::PageViewHost,
};
use dr_workspace::commands::v3::types::ModuleSpec;
use gpui::{AnyView, App, FocusHandle, Global, Window};
use std::{collections::BTreeMap, rc::Rc};

pub mod card;
pub mod history;
pub mod page;
pub mod sidebar;

#[derive(Clone)]
pub struct ModuleHost {
    pub page: PageViewHost,
    pub entry: String,
    /// `about` is the built-in level description, passed to the prose renderer.
    pub module: ModuleSpec,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisplaySurface {
    Page,
    Sidebar,
}

#[derive(Clone)]
pub struct LevelHost {
    pub page: PageViewHost,
    pub level: String,
    pub surface: DisplaySurface,
}

/// A stateful view is constructed once per part, retained while its tab is
/// open, and refreshed only when the book snapshot changes. Its refresh hook
/// must accept module/template changes without overwriting pending editor input.
pub type Refresh = Rc<dyn Fn(Rc<Book>, &mut App)>;
pub type Reveal = Rc<dyn Fn(Option<Lines>, &mut Window, &mut App)>;

#[derive(Clone)]
pub struct Rendered {
    pub view: AnyView,
    pub focus: Option<FocusHandle>,
    pub refresh: Option<Refresh>,
    pub reveal: Option<Reveal>,
}
impl Rendered {
    pub fn new(view: impl Into<AnyView>) -> Self {
        Self {
            view: view.into(),
            focus: None,
            refresh: None,
            reveal: None,
        }
    }
    pub fn focus(mut self, focus: FocusHandle) -> Self {
        self.focus = Some(focus);
        self
    }
    pub fn on_refresh(mut self, f: impl Fn(Rc<Book>, &mut App) + 'static) -> Self {
        self.refresh = Some(Rc::new(f));
        self
    }
    pub fn on_reveal(mut self, f: impl Fn(Option<Lines>, &mut Window, &mut App) + 'static) -> Self {
        self.reveal = Some(Rc::new(f));
        self
    }
}

type ModuleMaker = Rc<dyn Fn(ModuleHost, &mut Window, &mut App) -> Rendered>;
type DisplayMaker = Rc<dyn Fn(LevelHost, &mut Window, &mut App) -> Rendered>;
type ActionMaker =
    Rc<dyn Fn(&Target, &crate::pages::PageMenuHost, &App) -> Option<crate::pages::RunRow>>;
type CardMaker = Rc<dyn Fn(&Target, &crate::pages::PageMenuHost, &App) -> crate::pages::CardRows>;
type TemplateCreator = Rc<dyn Fn(PageViewHost, &mut Window, &mut App)>;
#[derive(Default)]
struct Registry {
    modules: BTreeMap<String, ModuleMaker>,
    displays: BTreeMap<String, DisplayMaker>,
    settings: Option<DisplayMaker>,
    actions: BTreeMap<card::EntryAction, ActionMaker>,
    cards: Vec<CardMaker>,
    template_creator: Option<TemplateCreator>,
}
impl Global for Registry {}

/// Register once at application initialization. Open string kinds preserve
/// forward compatibility with future module definitions.
pub fn add_module_view(
    cx: &mut App,
    kind: impl Into<String>,
    make: impl Fn(ModuleHost, &mut Window, &mut App) -> Rendered + 'static,
) {
    if !cx.has_global::<Registry>() {
        cx.set_global(Registry::default());
    }
    cx.global_mut::<Registry>()
        .modules
        .insert(kind.into(), Rc::new(make));
}
pub fn add_level_display(
    cx: &mut App,
    display: impl Into<String>,
    make: impl Fn(LevelHost, &mut Window, &mut App) -> Rendered + 'static,
) {
    if !cx.has_global::<Registry>() {
        cx.set_global(Registry::default());
    }
    cx.global_mut::<Registry>()
        .displays
        .insert(display.into(), Rc::new(make));
}
/// The third part of a level page: its settings with their effective values
/// and sources (G2). One maker for every level; the page keeps the instance
/// while the entry stays a level and calls its `on_refresh` on each snapshot.
pub fn add_level_settings(
    cx: &mut App,
    make: impl Fn(LevelHost, &mut Window, &mut App) -> Rendered + 'static,
) {
    cx.default_global::<Registry>().settings = Some(Rc::new(make));
}

pub fn level_settings(host: LevelHost, window: &mut Window, cx: &mut App) -> Option<Rendered> {
    let make = cx.try_global::<Registry>()?.settings.clone()?;
    Some(make(host, window, cx))
}

pub fn module_view(host: ModuleHost, window: &mut Window, cx: &mut App) -> Option<Rendered> {
    let make = cx
        .try_global::<Registry>()?
        .modules
        .get(&host.module.kind)?
        .clone();
    Some(make(host, window, cx))
}
pub fn level_display(host: LevelHost, window: &mut Window, cx: &mut App) -> Option<Rendered> {
    let kind = host
        .page
        .book
        .v3()?
        .levels
        .get(&host.level)?
        .settings
        .display
        .clone();
    let make = cx.try_global::<Registry>()?.displays.get(&kind)?.clone();
    Some(make(host, window, cx))
}
pub fn entry_target(id: &str) -> Option<Target> {
    Some(Target::Entry {
        id: id.parse().ok()?,
        module: None,
    })
}

/// G2 supplies the picker opened by the common card row. Return None when the
/// action does not apply; no no-op callback is needed for a disabled row.
pub fn add_entry_action(
    cx: &mut App,
    action: card::EntryAction,
    make: impl Fn(&Target, &crate::pages::PageMenuHost, &App) -> Option<crate::pages::RunRow> + 'static,
) {
    cx.default_global::<Registry>()
        .actions
        .insert(action, Rc::new(make));
}
pub fn entry_action(
    action: card::EntryAction,
    target: &Target,
    host: &crate::pages::PageMenuHost,
    cx: &App,
) -> Option<crate::pages::RunRow> {
    cx.try_global::<Registry>()?.actions.get(&action)?(target, host, cx)
}
/// Additional card rows, composed with the rows supplied by a particular view.
pub fn add_entry_card_rows(
    cx: &mut App,
    make: impl Fn(&Target, &crate::pages::PageMenuHost, &App) -> crate::pages::CardRows + 'static,
) {
    cx.default_global::<Registry>().cards.push(Rc::new(make));
}
pub fn entry_card_rows(
    target: &Target,
    host: &crate::pages::PageMenuHost,
    cx: &App,
) -> crate::pages::CardRows {
    let mut out = crate::pages::CardRows::default();
    if let Some(registry) = cx.try_global::<Registry>() {
        for make in &registry.cards {
            let rows = make(target, host, cx);
            out.lead.extend(rows.lead);
            out.before_danger.extend(rows.before_danger);
        }
    }
    out
}
/// K5 supplies the new-template flow. The collection button is disabled until
/// it is registered; editing an existing template uses `Target::Template`.
pub fn add_template_creator(
    cx: &mut App,
    create: impl Fn(PageViewHost, &mut Window, &mut App) + 'static,
) {
    cx.default_global::<Registry>().template_creator = Some(Rc::new(create));
}
pub fn has_template_creator(cx: &App) -> bool {
    cx.try_global::<Registry>()
        .is_some_and(|r| r.template_creator.is_some())
}
pub fn create_template(host: PageViewHost, window: &mut Window, cx: &mut App) {
    if let Some(create) = cx
        .try_global::<Registry>()
        .and_then(|r| r.template_creator.clone())
    {
        create(host, window, cx);
    }
}
