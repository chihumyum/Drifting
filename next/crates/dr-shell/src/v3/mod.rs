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

pub mod page;

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
#[derive(Default)]
struct Registry {
    modules: BTreeMap<String, ModuleMaker>,
    displays: BTreeMap<String, DisplayMaker>,
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
