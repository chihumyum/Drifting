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
//! And the rows a module adds to a page's ⋯ menu ([`add_page_menu`]): an
//! element's 更改类目 and 删除要素, a category's 删除类目 (M11). The shell
//! keeps the menu's order: share and export, its own sections, the modules'
//! sections, 历史快照…, then everything dangerous last.

use std::rc::Rc;

use dr_editor::page::PageChrome;
use dr_editor::{BookEditor, ChapterEditor};
use gpui::{AnyView, App, Bounds, Entity, Global, Pixels, SharedString, WeakEntity, Window};

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
/// What a ⋯ row does.
pub type RunRow = Rc<dyn Fn(&mut Window, &mut App)>;

/// One row a module adds to a page's ⋯ menu.
#[derive(Clone)]
pub struct PageMenuItem {
    /// Unique in the menu.
    pub id: SharedString,
    pub icon: dr_ui::sand::Icon,
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

#[derive(Clone, Default)]
struct Pages {
    shelf: Option<MakeShelf>,
    home: Option<MakeHome>,
    chrome: Vec<MakeChrome>,
    menus: Vec<MakeMenu>,
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
