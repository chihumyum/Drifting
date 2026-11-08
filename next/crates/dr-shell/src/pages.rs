//! The two pages other crates draw (stage 2):
//!
//! - the bookshelf (M01, `dr-view-shelf`): the start page, over the whole
//!   window until a book opens; ⇧⌘W and the red light come back to it;
//! - Project Home (M02, `dr-view-home`): the paper when no tab is active.
//!
//! The app registers both once, after [`crate::init`]. Without them (the
//! shell's own tests and captures) the window opens straight into a book
//! and Home shows only the book's name, as before.
//!
//! Modal flows that belong to no page (the 0.1 library import, M10) are
//! dialogs: [`crate::dialogs::show`].
//!
//! And what a page draws around its text ([`add_page_chrome`]): the
//! chapter page's head and end (M03, `dr-view-page`), the element and
//! category pages' fields (M11, `dr-view-elements`). The shell asks the
//! makers for each editor it opens (one document or the whole book); a
//! maker answers for the pages it knows and `None` for the rest, and the
//! first answer wins.
//!
//! And a left sidebar tab drawn by a module ([`add_left_panel`]): M11's
//! elements panel. The shell asks the makers once per pane the first time
//! that pane shows the tab and keeps what it got; the first answer wins.
//! The panel's head goes in the tab's header row (the shell keeps the row's
//! height, padding and hairline), its body fills the pane and scrolls
//! itself; the shell's own rows for that tab are not drawn.
//!
//! And a page a module draws whole, with no prose editor
//! ([`add_page_view`]): M19's image and PDF materials (the viewer and its
//! region comments). The shell asks the makers before it opens a page's
//! editor; the first answer wins, and the page keeps that view while its
//! tab stays open.
//!
//! And the rows a module adds to a page's ⋯ menu ([`add_page_menu`]): an
//! element's 更改类目 and 删除要素, a category's 删除类目 (M11). The shell
//! keeps the menu's order: share and export, its own sections, the modules'
//! sections, 历史快照…, then everything dangerous last.
//!
//! And the bodies of the three Super Views ([`add_super_view`]: M21's story
//! graph, M22's element overview, M23's review and materials), with two
//! slots in the stage's header, and the right sidebar's 帮手 tab
//! ([`set_companion`], M31). Without them the stage and the tab stay empty.
//! The right sidebar's 素材库 tab is drawn the same way ([`set_library`],
//! M19); without it the shell lists the folders and materials itself.
//!
//! And M24 (`dr-view-sea`): the sea of characters under every window
//! ([`set_backdrop`]: drawn first, held by the bookshelf and the full-window
//! waits, ebbing under the workspace), the first run before the bookshelf
//! ([`set_first_run`]) and the workspace tour ([`set_guide`], the controls
//! marked with [`anchor`] under the ids in [`anchors`]).
//!
//! And what fills the Bottom Panel under the paper ([`add_bottom_panel`]):
//! the timeline (M14) and the chapter in front's plot planner (M15), one
//! at a time. The shell keeps the panel (its height, its top edge, the
//! slide, the toggles); a module gives the view for its [`BottomPane`].

use std::rc::Rc;

use dr_editor::page::PageChrome;
use dr_editor::{BookEditor, ChapterEditor};
use gpui::{
    AnyView, App, Bounds, Entity, FocusHandle, Global, Pixels, SharedString, WeakEntity, Window,
};

use crate::Workspace;
use crate::book::Book;
use crate::nav::Target;
use crate::workspace::{LeftTab, SuperView};

/// The bookshelf a window shows: its view, and the cell its notification
/// bell records its bounds in (the notification center opens from there).
#[derive(Clone)]
pub struct ShelfPage {
    pub view: AnyView,
    pub bell: Option<Entity<Option<Bounds<Pixels>>>>,
}

type MakeShelf = Rc<dyn Fn(WeakEntity<Workspace>, &mut Window, &mut App) -> ShelfPage>;
type MakeHome = Rc<dyn Fn(WeakEntity<Workspace>, &mut Window, &mut App) -> AnyView>;
type MakeChrome =
    Rc<dyn Fn(&Target, PageHost, &mut Window, &mut App) -> Option<Rc<dyn PageChrome>>>;
type MakeMenu = Rc<dyn Fn(&Target, &PageMenuHost, &App) -> Vec<PageMenuSection>>;
type MakeView = Rc<dyn Fn(&Target, PageViewHost, &mut Window, &mut App) -> Option<ModulePage>>;
type MakeLeftPanel =
    Rc<dyn Fn(LeftTab, WeakEntity<Workspace>, &mut Window, &mut App) -> Option<LeftPanel>>;
type MakeBottom = Rc<dyn Fn(&BottomHost, &mut Window, &mut App) -> Option<BottomPanel>>;

/// What the Bottom Panel holds, top to bottom as the 0.1 client stacked
/// them: the timeline, or the plot planner of the chapter in front.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BottomPane {
    Timeline,
    Planner,
}

/// What a Bottom Panel pane is made for: the window's workspace, the
/// library, the book's lists as the shell has them, and the page in front
/// (the chapter or idea a planner plans).
#[derive(Clone)]
pub struct BottomHost {
    pub workspace: WeakEntity<Workspace>,
    pub library: Option<dr_workspace::Workspace>,
    pub book_id: String,
    pub book: Rc<Book>,
    pub target: Option<Target>,
}

/// Called with the book's new lists while a pane is kept (a planner's
/// chapter renamed).
pub type RefreshBottom = Rc<dyn Fn(&BottomHost, &mut App)>;

/// The least height the panel can be dragged to while a pane shows.
pub type MinHeight = Rc<dyn Fn(&App) -> f32>;

/// A pane a module draws in the Bottom Panel. Its view fills the panel's
/// box (the panel's full height, whatever part of it the slide shows).
#[derive(Clone)]
pub struct BottomPanel {
    pub view: AnyView,
    /// Above the panel's own least height (180), e.g. the timeline's lanes.
    pub min_height: Option<MinHeight>,
    pub refresh: Option<RefreshBottom>,
}

impl BottomPanel {
    pub fn new(view: impl Into<AnyView>) -> BottomPanel {
        BottomPanel {
            view: view.into(),
            min_height: None,
            refresh: None,
        }
    }

    pub fn min_height(mut self, f: impl Fn(&App) -> f32 + 'static) -> BottomPanel {
        self.min_height = Some(Rc::new(f));
        self
    }

    pub fn on_refresh(mut self, f: impl Fn(&BottomHost, &mut App) + 'static) -> BottomPanel {
        self.refresh = Some(Rc::new(f));
        self
    }
}

/// What a Super View's content is made with: the window's workspace (to
/// open pages, close the stage), the library, the book's id and its lists
/// as the shell has them.
#[derive(Clone)]
pub struct SuperViewHost {
    pub workspace: WeakEntity<Workspace>,
    pub library: Option<dr_workspace::Workspace>,
    pub book_id: String,
    pub book: Rc<Book>,
}

/// A Super View a module draws: its body under the stage's header, and
/// two slots in that header.
#[derive(Clone)]
pub struct SuperViewPage {
    pub body: AnyView,
    /// The header's left, after 返回 (M22's 群岛 / 关系 switch before its
    /// count).
    pub head_start: Option<AnyView>,
    /// The header's right end, for a control of the view's own. Not the
    /// line legend: the author put that at the top right of the content
    /// (2026-11-03), so a view draws it in its body.
    pub head_end: Option<AnyView>,
}

impl SuperViewPage {
    pub fn new(body: impl Into<AnyView>) -> SuperViewPage {
        SuperViewPage {
            body: body.into(),
            head_start: None,
            head_end: None,
        }
    }

    pub fn head_start(mut self, view: impl Into<AnyView>) -> SuperViewPage {
        self.head_start = Some(view.into());
        self
    }

    pub fn head_end(mut self, view: impl Into<AnyView>) -> SuperViewPage {
        self.head_end = Some(view.into());
        self
    }
}

type MakeSuperView = Rc<dyn Fn(&SuperViewHost, &mut Window, &mut App) -> SuperViewPage>;
type MakeCompanion = Rc<dyn Fn(WeakEntity<Workspace>, &mut Window, &mut App) -> LeftPanel>;

/// A left sidebar tab a module draws: the header row's content and the
/// pane's body. The right sidebar's 帮手 tab is drawn the same way
/// ([`set_companion`]).
#[derive(Clone)]
pub struct LeftPanel {
    pub head: AnyView,
    pub body: AnyView,
}

/// What a ⋯ row does.
pub type RunRow = Rc<dyn Fn(&mut Window, &mut App)>;

/// One row a module adds to a page's ⋯ menu.
#[derive(Clone)]
pub struct PageMenuItem {
    /// Unique in the menu.
    pub id: SharedString,
    /// A brush icon (`Icon::Folder.into()`) or the mark of the thing the
    /// row names (`RowIcon::Mark(Kind::Category, None)`).
    pub icon: dr_ui::components::menu::RowIcon,
    pub label: SharedString,
    /// The current choice of a single-choice section: a tick.
    pub checked: bool,
    /// Delete and the like: at the menu's end, in the danger colour.
    pub danger: bool,
    /// What it does. The menu is closed first; the workspace is free to
    /// update.
    pub run: RunRow,
}

/// A module's rows, under a heading or none (`title: None`).
#[derive(Clone, Default)]
pub struct PageMenuSection {
    pub title: Option<SharedString>,
    pub items: Vec<PageMenuItem>,
}

/// A module's own rows on a page's hover card
/// ([`crate::workspace::page_hover_card`]): `lead` above the page's rows
/// (M14's 转移至未归属, 回到未放置, 在此故事线中新建章节), `before_danger`
/// after them but before what deletes.
#[derive(Clone, Default)]
pub struct CardRows {
    pub lead: Vec<PageMenuSection>,
    pub before_danger: Vec<PageMenuSection>,
}

/// What a module's ⋯ rows are made with: the window's workspace (for the
/// rows' `run`, not to read while the menu is made: it is drawing), the
/// library, and the book's lists as the shell has them.
#[derive(Clone)]
pub struct PageMenuHost {
    pub workspace: WeakEntity<Workspace>,
    pub library: Option<dr_workspace::Workspace>,
    pub book_id: String,
    pub book: Rc<Book>,
}

impl PageMenuHost {
    /// The host for `ws`'s window as it is now (not while it draws).
    pub fn of(ws: &Entity<Workspace>, cx: &App) -> PageMenuHost {
        let w = ws.read(cx);
        PageMenuHost {
            workspace: ws.downgrade(),
            library: w.library.clone(),
            book_id: w.book_id.clone(),
            book: w.book.clone(),
        }
    }
}

/// The editor a page's chrome sits in.
#[derive(Clone)]
pub enum PageEditorRef {
    Doc(WeakEntity<ChapterEditor>),
    Book(WeakEntity<BookEditor>),
}

/// What a page's chrome is given when the shell opens an editor: the
/// library and the book (dr-editor's `page::*` actions), the editor (to
/// hand the caret to the text) and the window's workspace (to open the
/// chapter ⁂ makes).
#[derive(Clone)]
pub struct PageHost {
    pub workspace: WeakEntity<Workspace>,
    pub library: dr_workspace::Workspace,
    pub book: String,
    pub editor: PageEditorRef,
}

/// A page a module draws whole: its view, and what takes the keyboard when
/// the page comes to the front (as an editor's text does).
#[derive(Clone)]
pub struct ModulePage {
    pub view: AnyView,
    pub focus: FocusHandle,
}

/// What a module's whole page is made with: the window's workspace, the
/// library, and the book (its id and its lists as the shell has them).
#[derive(Clone)]
pub struct PageViewHost {
    pub workspace: WeakEntity<Workspace>,
    pub library: dr_workspace::Workspace,
    pub book_id: String,
    pub book: Rc<Book>,
}

/// What a page holds the sea as (M24's `HoldKind`, named here so the shell
/// needs no `dr-view-sea`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeaHold {
    /// A page lying on the sea (the bookshelf).
    Surface,
    /// A full-window wait (opening a book, swapping the library).
    Loading,
}

/// Draws something for a window (the sea).
pub type DrawFor = Rc<dyn Fn(&mut Window, &mut App) -> gpui::AnyElement>;
/// Takes a hold on the sea; dropping the value lets go.
pub type HoldSeaFn = Rc<dyn Fn(SeaHold, &mut Window, &mut App) -> Box<dyn std::any::Any>>;
/// Asks something of a window (the sea ebbs).
pub type AskWindow = Rc<dyn Fn(&mut Window, &mut App) -> bool>;
/// Wraps an element (lays it on the sea, marks it for the tour).
pub type WrapEl<K> = Rc<dyn Fn(K, gpui::AnyElement) -> gpui::AnyElement>;
/// Does something in a window (starts the tour).
pub type InWindow = Rc<dyn Fn(&mut Window, &mut App)>;
/// The tour's layer.
pub type LayerFn = Rc<dyn Fn(bool, &mut Window, &mut App) -> Option<gpui::AnyElement>>;
/// Does something in the app (forgets the tour was seen).
pub type InApp = Rc<dyn Fn(&mut App)>;

/// The sea under every window (M24).
#[derive(Clone)]
pub struct Backdrop {
    /// What lies under the window's root (nothing while the sea is off).
    pub draw: DrawFor,
    /// Holds the sea in the window until the value is dropped.
    pub hold: HoldSeaFn,
    /// The sea is ebbing (its last hold let go): the workspace leaves its
    /// desk to it for those seconds.
    pub ebbing: AskWindow,
    /// `el` lying on the sea as bare glass while it ebbs (the sidebars and
    /// the Bottom Panel).
    pub on_sea: WrapEl<SharedString>,
}

/// A first run over the bookshelf: its view, and whether the bookshelf is
/// to be drawn under it yet.
#[derive(Clone)]
pub struct FirstRunPage {
    pub view: AnyView,
    pub shows_shelf: Rc<dyn Fn(&App) -> bool>,
}

/// What a first run calls when it is over.
pub type FirstRunDone = InWindow;
type MakeFirstRun = Rc<dyn Fn(FirstRunDone, &mut Window, &mut App) -> FirstRunPage>;

/// The workspace tour (M24).
#[derive(Clone)]
pub struct Guide {
    /// `el` marked as the control the tour calls `id` ([`anchors`]).
    pub anchor: WrapEl<&'static str>,
    /// A book's workspace shows: the tour starts unless this device saw it.
    pub start: InWindow,
    /// The tour's layer, the workspace root's last child; `covered` while a
    /// Super View or a full-window wait lies over the workspace.
    pub layer: LayerFn,
    /// Settings' 重新显示.
    pub reset: InApp,
}

/// The ids of the controls the workspace tour points at (`dr-view-sea`'s
/// `tour::ids` re-exports them).
pub mod anchors {
    /// The left sidebar's Panel Tabs (章节, 要素, 构想), each half's.
    pub const LEFT_PANEL_TAB: &str = "left-panel-tab";
    /// The left sidebar's toggle, marked only while the sidebar is closed.
    pub const LEFT_SIDEBAR_CLOSED_TOGGLE: &str = "left-sidebar-closed-toggle";
    /// The round button on a panel's head that opens its Super View.
    pub const SUPER_VIEW_ENTRY: &str = "super-view-entry";
    /// Project Home's 新建 section (M02 marks it).
    pub const HOME_CREATE: &str = "home-create";
    /// The timeline's toggle at the paper's bottom right.
    pub const TIMELINE_TOGGLE: &str = "timeline-toggle";
    /// The Agent's Panel Tab in the right sidebar (its tab row, for now).
    pub const AGENT_TAB: &str = "agent-tab";
    /// The right sidebar's toggle, marked only while the sidebar is closed.
    pub const RIGHT_SIDEBAR_CLOSED_TOGGLE: &str = "right-sidebar-closed-toggle";
    /// The torii in the account cell: back to Project Home.
    pub const PROJECT_HOME: &str = "project-home";
    /// The wind bell beside it: the notification center.
    pub const NOTIFICATIONS: &str = "notifications";
}

#[derive(Clone, Default)]
struct Pages {
    shelf: Option<MakeShelf>,
    home: Option<MakeHome>,
    chrome: Vec<MakeChrome>,
    views: Vec<MakeView>,
    menus: Vec<MakeMenu>,
    left_panels: Vec<MakeLeftPanel>,
    bottom: Vec<(BottomPane, MakeBottom)>,
    backdrop: Option<Backdrop>,
    first_run: Option<MakeFirstRun>,
    guide: Option<Guide>,
    super_views: Vec<(SuperView, MakeSuperView)>,
    companion: Option<MakeCompanion>,
    library: Option<MakeCompanion>,
}

impl Global for Pages {}

/// Registers the bookshelf. Each workspace window makes one when it first
/// shows it.
pub fn set_shelf(
    cx: &mut App,
    make: impl Fn(WeakEntity<Workspace>, &mut Window, &mut App) -> ShelfPage + 'static,
) {
    cx.default_global::<Pages>().shelf = Some(Rc::new(make));
}

/// Registers Project Home. Each workspace window makes one with itself and
/// keeps it while the window lives (it follows the book the window shows).
pub fn set_home(
    cx: &mut App,
    make: impl Fn(WeakEntity<Workspace>, &mut Window, &mut App) -> AnyView + 'static,
) {
    cx.default_global::<Pages>().home = Some(Rc::new(make));
}

/// Registers what a page draws around its text: asked once for each page
/// editor the workspace opens (its target and a [`PageHost`]), it gives
/// that page's [`PageChrome`] or `None`.
pub fn add_page_chrome(
    cx: &mut App,
    make: impl Fn(&Target, PageHost, &mut Window, &mut App) -> Option<Rc<dyn PageChrome>> + 'static,
) {
    cx.default_global::<Pages>().chrome.push(Rc::new(make));
}

/// The chrome registered for `target`'s page, if any.
pub(crate) fn chrome_for(
    target: &Target,
    host: PageHost,
    window: &mut Window,
    cx: &mut App,
) -> Option<Rc<dyn PageChrome>> {
    let makers = cx.try_global::<Pages>()?.chrome.clone();
    makers
        .iter()
        .find_map(|make| make(target, host.clone(), window, cx))
}

/// Registers pages a module draws whole: asked before the shell opens a
/// page's editor (its target and a [`PageViewHost`]), it gives that page
/// ([`ModulePage`]), or `None` to leave the page to the editor.
pub fn add_page_view(
    cx: &mut App,
    make: impl Fn(&Target, PageViewHost, &mut Window, &mut App) -> Option<ModulePage> + 'static,
) {
    cx.default_global::<Pages>().views.push(Rc::new(make));
}

/// The page a module draws for `target`, if any.
pub(crate) fn page_view_for(
    target: &Target,
    host: PageViewHost,
    window: &mut Window,
    cx: &mut App,
) -> Option<ModulePage> {
    let makers = cx.try_global::<Pages>()?.views.clone();
    makers
        .iter()
        .find_map(|make| make(target, host.clone(), window, cx))
}

/// Registers rows for pages' ⋯ menus: asked each time a page's menu opens
/// (its target and a [`PageMenuHost`]), it gives that page's sections, or
/// none. Called while the workspace draws: build rows, do not read or
/// update the workspace here (do that in a row's `run`).
pub fn add_page_menu(
    cx: &mut App,
    make: impl Fn(&Target, &PageMenuHost, &App) -> Vec<PageMenuSection> + 'static,
) {
    cx.default_global::<Pages>().menus.push(Rc::new(make));
}

/// Every module's sections for `target`'s ⋯ menu, in the order they were
/// registered.
pub(crate) fn menu_for(target: &Target, host: &PageMenuHost, cx: &App) -> Vec<PageMenuSection> {
    let Some(pages) = cx.try_global::<Pages>() else {
        return Vec::new();
    };
    pages
        .menus
        .iter()
        .flat_map(|make| make(target, host, cx))
        .filter(|s| !s.items.is_empty())
        .collect()
}

/// Registers a left sidebar tab's panel: asked once per pane the first time
/// that pane shows a tab (with the tab and the window's workspace), it
/// gives that tab's [`LeftPanel`] or `None`.
pub fn add_left_panel(
    cx: &mut App,
    make: impl Fn(LeftTab, WeakEntity<Workspace>, &mut Window, &mut App) -> Option<LeftPanel> + 'static,
) {
    cx.default_global::<Pages>().left_panels.push(Rc::new(make));
}

/// The panel registered for `tab`, made now, if any.
pub(crate) fn left_panel_for(
    tab: LeftTab,
    ws: WeakEntity<Workspace>,
    window: &mut Window,
    cx: &mut App,
) -> Option<LeftPanel> {
    let makers = cx.try_global::<Pages>()?.left_panels.clone();
    makers
        .iter()
        .find_map(|make| make(tab, ws.clone(), window, cx))
}

/// Registers what fills the Bottom Panel as `pane`: asked when the pane is
/// to show (the timeline once per window and book; a planner each time
/// another chapter or idea comes to the front), it gives the view or
/// `None` (a page it does not plan). Called while the workspace draws: do
/// not read or update the workspace in `make`.
pub fn add_bottom_panel(
    cx: &mut App,
    pane: BottomPane,
    make: impl Fn(&BottomHost, &mut Window, &mut App) -> Option<BottomPanel> + 'static,
) {
    cx.default_global::<Pages>()
        .bottom
        .push((pane, Rc::new(make)));
}

/// Whether a module draws `pane` (its toggle shows only then).
pub fn has_bottom_panel(pane: BottomPane, cx: &App) -> bool {
    cx.try_global::<Pages>()
        .is_some_and(|p| p.bottom.iter().any(|(at, _)| *at == pane))
}

/// The view registered for `pane` and `host`, made now, if any.
pub(crate) fn bottom_panel_for(
    pane: BottomPane,
    host: &BottomHost,
    window: &mut Window,
    cx: &mut App,
) -> Option<BottomPanel> {
    let makers: Vec<MakeBottom> = cx
        .try_global::<Pages>()?
        .bottom
        .iter()
        .filter(|(at, _)| *at == pane)
        .map(|(_, make)| make.clone())
        .collect();
    makers.iter().find_map(|make| make(host, window, cx))
}

/// Registers `view`'s content (M21, M22, M23): made the first time the
/// stage shows `view` for a book in a window, then kept until another book
/// or library; the first registration for a view wins. Called while the
/// workspace draws: do not read or update the workspace in `make`.
pub fn add_super_view(
    cx: &mut App,
    view: SuperView,
    make: impl Fn(&SuperViewHost, &mut Window, &mut App) -> SuperViewPage + 'static,
) {
    cx.default_global::<Pages>()
        .super_views
        .push((view, Rc::new(make)));
}

pub(crate) fn super_view_for(
    view: SuperView,
    host: &SuperViewHost,
    window: &mut Window,
    cx: &mut App,
) -> Option<SuperViewPage> {
    let make = cx
        .try_global::<Pages>()?
        .super_views
        .iter()
        .find(|(v, _)| *v == view)
        .map(|(_, make)| make.clone())?;
    Some(make(host, window, cx))
}

/// Registers the right sidebar's 帮手 tab (M31): asked once per pane the
/// first time that pane shows the tab, as [`add_left_panel`]; its head
/// goes in the tab's header row, its body fills the pane. Called while the
/// workspace draws: do not read or update the workspace in `make`.
pub fn set_companion(
    cx: &mut App,
    make: impl Fn(WeakEntity<Workspace>, &mut Window, &mut App) -> LeftPanel + 'static,
) {
    cx.default_global::<Pages>().companion = Some(Rc::new(make));
}

pub(crate) fn companion_for(
    ws: WeakEntity<Workspace>,
    window: &mut Window,
    cx: &mut App,
) -> Option<LeftPanel> {
    let make = cx.try_global::<Pages>()?.companion.clone()?;
    Some(make(ws, window, cx))
}

/// Registers the right sidebar's 素材库 tab (M19), as [`set_companion`]:
/// asked once per pane the first time that pane shows the tab; its head
/// goes in the tab's header row, its body fills the pane. Called while the
/// workspace draws: do not read or update the workspace in `make`.
pub fn set_library(
    cx: &mut App,
    make: impl Fn(WeakEntity<Workspace>, &mut Window, &mut App) -> LeftPanel + 'static,
) {
    cx.default_global::<Pages>().library = Some(Rc::new(make));
}

pub(crate) fn library_for(
    ws: WeakEntity<Workspace>,
    window: &mut Window,
    cx: &mut App,
) -> Option<LeftPanel> {
    let make = cx.try_global::<Pages>()?.library.clone()?;
    Some(make(ws, window, cx))
}

/// Registers the sea under every window (M24).
pub fn set_backdrop(cx: &mut App, backdrop: Backdrop) {
    cx.default_global::<Pages>().backdrop = Some(backdrop);
}

pub(crate) fn backdrop(cx: &App) -> Option<Backdrop> {
    cx.try_global::<Pages>()?.backdrop.clone()
}

/// Registers the first run: made over the bookshelf the first time the app
/// opens on this device; it calls `done` when it is over.
pub fn set_first_run(
    cx: &mut App,
    make: impl Fn(FirstRunDone, &mut Window, &mut App) -> FirstRunPage + 'static,
) {
    cx.default_global::<Pages>().first_run = Some(Rc::new(make));
}

pub(crate) fn make_first_run(
    done: FirstRunDone,
    window: &mut Window,
    cx: &mut App,
) -> Option<FirstRunPage> {
    let make = cx.try_global::<Pages>()?.first_run.clone()?;
    Some(make(done, window, cx))
}

/// Registers the workspace tour.
pub fn set_guide(cx: &mut App, guide: Guide) {
    cx.default_global::<Pages>().guide = Some(guide);
}

pub(crate) fn guide(cx: &App) -> Option<Guide> {
    cx.try_global::<Pages>()?.guide.clone()
}

/// `el` marked for the tour as `id` ([`anchors`]); itself without a tour.
pub fn anchor(id: &'static str, el: impl gpui::IntoElement, cx: &App) -> gpui::AnyElement {
    let el = el.into_any_element();
    match cx.try_global::<Pages>().and_then(|p| p.guide.as_ref()) {
        Some(guide) => (guide.anchor)(id, el),
        None => el,
    }
}

pub(crate) fn has_shelf(cx: &App) -> bool {
    cx.try_global::<Pages>().is_some_and(|p| p.shelf.is_some())
}

pub(crate) fn make_shelf(
    ws: WeakEntity<Workspace>,
    window: &mut Window,
    cx: &mut App,
) -> Option<ShelfPage> {
    let make = cx.try_global::<Pages>()?.shelf.clone()?;
    Some(make(ws, window, cx))
}

/// A window's Project Home, made with the workspace (before it first
/// renders); `None` when none is registered.
pub(crate) fn make_home(
    ws: WeakEntity<Workspace>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyView> {
    let make = cx.try_global::<Pages>()?.home.clone()?;
    Some(make(ws, window, cx))
}
