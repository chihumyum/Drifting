//! The two pages other crates draw (stage 2):
//!
//! - the bookshelf (M01, `dr-view-shelf`; 全部项目 since 2026-11-14): over
//!   the whole window until a book opens, at launch when there is no book
//!   to reopen and from its button; its row of projects
//!   ([`set_projects`]) drops over a book's workspace;
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
//! And the right sidebar's 帮手 tab ([`set_companion`], M31). Without it the
//! tab stays empty. The right sidebar's 素材库 tab is drawn the same way
//! ([`set_library`], M19); without it the shell lists the folders and
//! materials itself. The right sidebar's 「关系」 tab (RL) is drawn the same
//! way ([`set_relations`]); without it the tab stays empty.
//!
//! And M24 (`dr-view-sea`): the sea of characters under every window
//! ([`set_backdrop`]: drawn first, held by the bookshelf and the full-window
//! waits, ebbing under the workspace), the first run before the bookshelf
//! ([`set_first_run`]) and the workspace tour ([`set_guide`], the controls
//! marked with [`anchor`] under the ids in [`anchors`]).
//!
//! And, for the module workbench (CW), images a page hands to the Agent
//! ([`set_agent_images`], [`AgentImages`]) and pages drawn without the
//! tools in the paper's corner ([`add_page_without_corner_tools`]).
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
/// hand the caret to the text) and the window's workspace (to read the
/// book it shows).
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
    /// panel fill or a full-window wait lies over the workspace.
    pub layer: LayerFn,
    /// Settings' 重新显示.
    pub reset: InApp,
    /// Whether this device has already seen at least one guide (used to disable
    /// 「重新显示」 when nothing has been dismissed yet).
    pub has_seen: Rc<dyn Fn(&App) -> bool>,
}

/// The ids of the controls the workspace tour points at (`dr-view-sea`'s
/// `tour::ids` re-exports them).
pub mod anchors {
    /// The left column's Tab row, its manage button (筝柱) with it.
    pub const LEFT_PANEL_TAB: &str = "left-panel-tab";
    /// The left sidebar's toggle (the left crescent), marked only while the
    /// sidebar is closed.
    pub const LEFT_SIDEBAR_CLOSED_TOGGLE: &str = "left-sidebar-closed-toggle";
    /// The left moon pair: the crescent opens the column, the full moon
    /// fills the middle with it.
    pub const LEFT_MOONS: &str = "left-moons";
    /// Project Home's 新建 row (dr-view-home marks it).
    pub const HOME_CREATE: &str = "home-create";
    /// The timeline's toggle at the paper's bottom right (the bamboo).
    pub const TIMELINE_TOGGLE: &str = "timeline-toggle";
    /// The Agent's tab in the right sidebar.
    pub const AGENT_TAB: &str = "agent-tab";
    /// The right sidebar's toggle, marked only while the sidebar is closed.
    pub const RIGHT_SIDEBAR_CLOSED_TOGGLE: &str = "right-sidebar-closed-toggle";
    /// 全部项目, right of the traffic lights.
    pub const ALL_PROJECTS: &str = "all-projects";
    /// The torii right of it: back to Project Home.
    pub const PROJECT_HOME: &str = "project-home";
    /// The wind bell beside it: the notification center.
    pub const NOTIFICATIONS: &str = "notifications";
}

/// What a page brings into the side columns while it is in front and shows
/// on the paper (the module workbench, `custom-modules.md` §8, CM3): the
/// left column's content in place of the Tabs, the right column's tabs in
/// place of 审阅 · 关系 · 素材库 · 统计, then the shell's own 「Agent」 (the
/// same conversation). When the page goes behind another pill, is closed or
/// is covered by a fill, the columns hold what they held before.
#[derive(Clone)]
pub struct PagePanels {
    /// The left column under the title bar's band, its own tab row included.
    pub left: AnyView,
    /// The right column's tabs before 「Agent」.
    pub right: Vec<PageTab>,
}

/// One of a page's right-column tabs ([`PagePanels`]).
#[derive(Clone)]
pub struct PageTab {
    /// Unique among the page's tabs (not `agent`, the shell's).
    pub slug: SharedString,
    pub label: dr_i18n::Key,
    /// The tab's body under the tab row (no header row of its own).
    pub body: AnyView,
}

/// The slug of the shell's 「Agent」 among a page's right-column tabs.
pub const AGENT_TAB: &str = "agent";

type MakePanels = Rc<dyn Fn(&Target, PageViewHost, &mut Window, &mut App) -> Option<PagePanels>>;
type PageTitle = Rc<dyn Fn(&Target, &App) -> Option<SharedString>>;

/// Images a page hands to the Agent (CW: the module workbench's paper takes
/// what the Agent column takes, `custom-modules.md` §8 入口 2): files
/// dropped on it, or images pasted. The Agent's module checks them as it
/// checks its own (CM4a).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentImages {
    Files(Vec<std::path::PathBuf>),
    Bytes(Vec<Vec<u8>>),
}

impl AgentImages {
    /// What ⌘V on the clipboard `item` hands the Agent, as its composer
    /// takes it (CM4a): the files on it; else its images when it has no
    /// text (with text, a paste is text: some programs put an image beside
    /// copied words). `None`: nothing for the Agent.
    pub fn on_clipboard(item: &gpui::ClipboardItem) -> Option<AgentImages> {
        let mut files = Vec::new();
        let mut pictures = Vec::new();
        let mut text = false;
        for entry in item.entries() {
            match entry {
                gpui::ClipboardEntry::ExternalPaths(found) => {
                    files.extend(found.paths().iter().cloned())
                }
                gpui::ClipboardEntry::Image(image) => pictures.push(image.bytes().to_vec()),
                gpui::ClipboardEntry::String(_) => text = true,
                #[allow(unreachable_patterns)]
                _ => {}
            }
        }
        if !files.is_empty() {
            Some(AgentImages::Files(files))
        } else if !text && !pictures.is_empty() {
            Some(AgentImages::Bytes(pictures))
        } else {
            None
        }
    }
}

/// Hands images to the 「Agent」 tab's body (the [`set_companion`] panel).
type TakeImages = Rc<dyn Fn(&AnyView, AgentImages, &mut App)>;

type LocateAsset = Rc<dyn Fn(&WeakEntity<Workspace>, &str, &mut Window, &mut App)>;
type CanDropFiles = Rc<dyn Fn(&[std::path::PathBuf], &App) -> bool>;
type OnDropFiles = Rc<dyn Fn(&[std::path::PathBuf], &mut Window, &mut App)>;

#[derive(Clone, Default)]
struct Pages {
    shelf: Option<MakeShelf>,
    projects: Option<MakeHome>,
    v3_home: Option<MakeHome>,
    chrome: Vec<MakeChrome>,
    views: Vec<MakeView>,
    menus: Vec<MakeMenu>,
    v3_bottom: Vec<(BottomPane, MakeBottom)>,
    backdrop: Option<Backdrop>,
    first_run: Option<MakeFirstRun>,
    after_first_run: Vec<InWindow>,
    guide: Option<Guide>,
    companion: Option<MakeCompanion>,
    library: Option<MakeCompanion>,
    relations: Option<MakeCompanion>,
    locate_asset: Option<LocateAsset>,
    pending_locate_asset: Option<String>,
    file_drop: Option<(CanDropFiles, OnDropFiles)>,
    panels: Vec<MakePanels>,
    titles: Vec<PageTitle>,
    agent_images: Option<TakeImages>,
    bare_corners: Vec<BareCorner>,
}

/// Whether a page draws without the tools in the paper's corner.
type BareCorner = Rc<dyn Fn(&Target) -> bool>;

/// Ephemeral sand-frame highlight triggered when jumping from a file's 「用在」
/// row to an entry module, prose block, image field, or relation row, or when
/// revealing a file in `素材库`.
#[derive(Clone, Debug)]
pub struct UsageFlash {
    pub keys: Vec<String>,
    pub at: std::time::Instant,
    pub generation: u64,
}

impl Global for UsageFlash {}

impl UsageFlash {
    const DURATION_MS: f32 = 1400.0;

    pub fn trigger(keys: impl IntoIterator<Item = impl Into<String>>, cx: &mut App) {
        let keys: Vec<String> = keys
            .into_iter()
            .map(Into::into)
            .filter(|k| !k.is_empty())
            .collect();
        if keys.is_empty() {
            return;
        }
        let generation = cx
            .try_global::<Self>()
            .map(|u| u.generation + 1)
            .unwrap_or(1);
        cx.set_global(Self {
            keys,
            at: std::time::Instant::now(),
            generation,
        });
        cx.refresh_windows();
    }

    pub fn strength_for(keys: &[impl AsRef<str>], window: &mut Window, cx: &App) -> f32 {
        let Some(u) = cx.try_global::<Self>() else {
            return 0.0;
        };
        if !keys
            .iter()
            .any(|k| u.keys.iter().any(|uk| uk == k.as_ref()))
        {
            return 0.0;
        }
        let elapsed = u.at.elapsed().as_secs_f32() * 1000.0;
        if elapsed >= Self::DURATION_MS {
            return 0.0;
        }
        let strength = (1.0 - elapsed / Self::DURATION_MS).clamp(0.0, 1.0);
        if strength > 0.0 {
            window.request_animation_frame();
        }
        strength
    }
}

/// Registers the handler for revealing a file in the right sidebar's 素材库 tab.
pub fn set_locate_asset(
    cx: &mut App,
    locate: impl Fn(&WeakEntity<Workspace>, &str, &mut Window, &mut App) + 'static,
) {
    cx.default_global::<Pages>().locate_asset = Some(Rc::new(locate));
}

/// Reveals the right sidebar's 素材库 tab and scrolls to / highlights `asset`.
pub fn locate_asset(ws: &WeakEntity<Workspace>, asset: &str, window: &mut Window, cx: &mut App) {
    cx.default_global::<Pages>().pending_locate_asset = Some(asset.to_owned());
    if let Some(entity) = ws.upgrade() {
        entity.update(cx, |ws, cx| ws.reveal_library(window, cx));
    }
    if let Some(cb) = cx
        .try_global::<Pages>()
        .and_then(|p| p.locate_asset.clone())
    {
        cb(ws, asset, window, cx);
    }
}

/// Consumes any pending asset locate request when a `LibraryPanel` mounts or refreshes.
pub fn take_pending_locate_asset(cx: &mut App) -> Option<String> {
    if !cx.has_global::<Pages>() {
        return None;
    }
    cx.global_mut::<Pages>().pending_locate_asset.take()
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

/// Registers 全部项目's row of projects: the view that drops from the top of
/// the workspace when the button right of the traffic lights is pressed.
/// Each workspace window makes one when it first shows it.
pub fn set_projects(
    cx: &mut App,
    make: impl Fn(WeakEntity<Workspace>, &mut Window, &mut App) -> AnyView + 'static,
) {
    cx.default_global::<Pages>().projects = Some(Rc::new(make));
}

/// Registers the v3 Project Home. Legacy books keep [`set_home`]'s view.
pub fn set_v3_home(
    cx: &mut App,
    make: impl Fn(WeakEntity<Workspace>, &mut Window, &mut App) -> AnyView + 'static,
) {
    cx.default_global::<Pages>().v3_home = Some(Rc::new(make));
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

/// Registers what a page brings into the side columns ([`PagePanels`]):
/// asked once for a page, the first time it is in front with its columns
/// shown (its target and a [`PageViewHost`]), it gives the panels or `None`
/// to leave the columns as they are. The shell keeps them while the page's
/// pill stays open.
pub fn add_page_panels(
    cx: &mut App,
    make: impl Fn(&Target, PageViewHost, &mut Window, &mut App) -> Option<PagePanels> + 'static,
) {
    cx.default_global::<Pages>().panels.push(Rc::new(make));
}

/// The panels a module brings for `target`'s page, if any.
pub(crate) fn page_panels_for(
    target: &Target,
    host: PageViewHost,
    window: &mut Window,
    cx: &mut App,
) -> Option<PagePanels> {
    let makers = cx.try_global::<Pages>()?.panels.clone();
    makers
        .iter()
        .find_map(|make| make(target, host.clone(), window, cx))
}

/// Registers the name a pill, a page or a link shows for a target the book
/// does not know (one of my modules: its workbench knows its name).
pub fn add_page_title(
    cx: &mut App,
    title: impl Fn(&Target, &App) -> Option<SharedString> + 'static,
) {
    cx.default_global::<Pages>().titles.push(Rc::new(title));
}

/// The name a module gives `target` ([`add_page_title`]), if any.
pub fn page_title(target: &Target, cx: &App) -> Option<SharedString> {
    cx.try_global::<Pages>()?
        .titles
        .iter()
        .find_map(|title| title(target, cx))
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

/// Registers a v3 Bottom Panel. Legacy registrations are never asked for a v3
/// book. The host and lifecycle are the same as [`add_bottom_panel`].
pub fn add_v3_bottom_panel(
    cx: &mut App,
    pane: BottomPane,
    make: impl Fn(&BottomHost, &mut Window, &mut App) -> Option<BottomPanel> + 'static,
) {
    cx.default_global::<Pages>()
        .v3_bottom
        .push((pane, Rc::new(make)));
}

/// Whether a renderer exists for this book's version.
pub fn has_bottom_panel_for(pane: BottomPane, book: &Book, cx: &App) -> bool {
    // The version is not known until the first snapshot arrives. Do not
    // instantiate legacy views against an as-yet-unread v3 book.
    if book.is_empty() {
        return false;
    }
    cx.try_global::<Pages>().is_some_and(|p| {
        let makers = &p.v3_bottom;
        makers.iter().any(|(at, _)| *at == pane)
    })
}

/// Whether a module draws `pane` (its toggle shows only then).
pub fn has_bottom_panel(pane: BottomPane, cx: &App) -> bool {
    cx.try_global::<Pages>()
        .is_some_and(|p| p.v3_bottom.iter().any(|(at, _)| *at == pane))
}

/// The view registered for `pane` and `host`, made now, if any.
pub(crate) fn bottom_panel_for(
    pane: BottomPane,
    host: &BottomHost,
    window: &mut Window,
    cx: &mut App,
) -> Option<BottomPanel> {
    let pages = cx.try_global::<Pages>()?;
    let registered = &pages.v3_bottom;
    let makers: Vec<MakeBottom> = registered
        .iter()
        .filter(|(at, _)| *at == pane)
        .map(|(_, make)| make.clone())
        .collect();
    makers.iter().find_map(|make| make(host, window, cx))
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

/// Registers the right sidebar's 「关系」 tab (RL, `dr-view-relations`), as
/// [`set_library`]: asked once per pane the first time that pane shows the
/// tab; its head goes in the tab's header row, its body fills the pane.
/// Called while the workspace draws: do not read or update the workspace
/// in `make`.
pub fn set_relations(
    cx: &mut App,
    make: impl Fn(WeakEntity<Workspace>, &mut Window, &mut App) -> LeftPanel + 'static,
) {
    cx.default_global::<Pages>().relations = Some(Rc::new(make));
}

pub(crate) fn relations_for(
    ws: WeakEntity<Workspace>,
    window: &mut Window,
    cx: &mut App,
) -> Option<LeftPanel> {
    let make = cx.try_global::<Pages>()?.relations.clone()?;
    Some(make(ws, window, cx))
}

/// Registers what takes images a page hands to the Agent
/// ([`crate::Workspace::give_agent_images`]): given the 「Agent」 tab's body
/// (the view [`set_companion`] made), it puts them in that panel's composer
/// as if they were dropped or pasted there (M31, CM4a).
pub fn set_agent_images(cx: &mut App, take: impl Fn(&AnyView, AgentImages, &mut App) + 'static) {
    cx.default_global::<Pages>().agent_images = Some(Rc::new(take));
}

pub(crate) fn agent_images(cx: &App) -> Option<TakeImages> {
    cx.try_global::<Pages>()?.agent_images.clone()
}

/// Registers pages drawn without the tools in the paper's corner (the
/// timeline's bamboo, the tray with the outline's button, the incense
/// stick): `bare` answers for the targets it knows. Only the module
/// workbench (CW; its prototype has none) asks for it.
pub fn add_page_without_corner_tools(cx: &mut App, bare: impl Fn(&Target) -> bool + 'static) {
    cx.default_global::<Pages>()
        .bare_corners
        .push(Rc::new(bare));
}

/// Whether `target`'s page is drawn without the corner's tools
/// ([`add_page_without_corner_tools`]).
pub fn without_corner_tools(target: &Target, cx: &App) -> bool {
    cx.try_global::<Pages>()
        .is_some_and(|p| p.bare_corners.iter().any(|bare| bare(target)))
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

/// Registers `run` for a window whose bookshelf shows first with the first
/// run over: when its first run ends, or as the window opens on a device that
/// saw the first run already (or without one registered). The workspace may
/// be in the middle of an update then: reach it through
/// [`crate::workspace::with_workspace_in`].
pub fn after_first_run(cx: &mut App, run: impl Fn(&mut Window, &mut App) + 'static) {
    cx.default_global::<Pages>()
        .after_first_run
        .push(Rc::new(run));
}

pub(crate) fn first_run_over(window: &mut Window, cx: &mut App) {
    let hooks = cx
        .try_global::<Pages>()
        .map(|pages| pages.after_first_run.clone())
        .unwrap_or_default();
    for hook in hooks {
        hook(window, cx);
    }
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

/// [`anchor`] for later: what marks an element as `id`, for a component
/// that draws the element itself (one segment of a [`dr_ui::components::Segmented`]).
pub fn anchor_with(
    id: &'static str,
    cx: &App,
) -> impl FnOnce(gpui::AnyElement) -> gpui::AnyElement + 'static {
    let mark = cx
        .try_global::<Pages>()
        .and_then(|p| p.guide.as_ref())
        .map(|guide| guide.anchor.clone());
    move |el| match mark {
        Some(mark) => mark(id, el),
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

pub(crate) fn make_projects(
    ws: WeakEntity<Workspace>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyView> {
    let make = cx.try_global::<Pages>()?.projects.clone()?;
    Some(make(ws, window, cx))
}

pub(crate) fn make_v3_home(
    ws: WeakEntity<Workspace>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyView> {
    let make = cx.try_global::<Pages>()?.v3_home.clone()?;
    Some(make(ws, window, cx))
}

/// Registers what takes files dropped onto 全部项目 (M41, `dr-view-transfer`:
/// `.driftingtemplate`). Only that page takes them: with a project open, a
/// dropped file is not imported (作者 2026-11-16 十六乙).
pub fn set_all_projects_file_drop(
    cx: &mut App,
    can_drop: impl Fn(&[std::path::PathBuf], &App) -> bool + 'static,
    on_drop: impl Fn(&[std::path::PathBuf], &mut Window, &mut App) + 'static,
) {
    cx.default_global::<Pages>().file_drop = Some((Rc::new(can_drop), Rc::new(on_drop)));
}

pub(crate) fn can_drop_on_all_projects(paths: &[std::path::PathBuf], cx: &App) -> bool {
    cx.try_global::<Pages>()
        .and_then(|p| p.file_drop.as_ref())
        .is_some_and(|(can_drop, _)| can_drop(paths, cx))
}

pub(crate) fn drop_on_all_projects(
    paths: &[std::path::PathBuf],
    window: &mut Window,
    cx: &mut App,
) {
    if let Some((_, on_drop)) = cx.try_global::<Pages>().and_then(|p| p.file_drop.clone()) {
        on_drop(paths, window, cx);
    }
}
