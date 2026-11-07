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
//! Other crates can also add a layer ([`add_layer`]): a view drawn last in
//! every workspace window, over the bookshelf or the book, for flows that
//! belong to no page (the 0.1 library import, M10). It draws nothing while
//! it has nothing to show; what it shows floats (dr-ui's `float`).
//!
//! And the chapter page's chrome (M03, `dr-view-page`, [`set_page_chrome`]):
//! the head and end dr-editor draws around each page's text. The shell
//! hands it to every editor it opens.

use std::rc::Rc;

use dr_editor::page::PageChrome;
use dr_editor::{BookEditor, ChapterEditor};
use gpui::{AnyView, App, Bounds, Entity, Global, Pixels, WeakEntity, Window};

use crate::Workspace;

/// The bookshelf a window shows: its view, and the cell its notification
/// bell records its bounds in (the notification center opens from there).
#[derive(Clone)]
pub struct ShelfPage {
    pub view: AnyView,
    pub bell: Option<Entity<Option<Bounds<Pixels>>>>,
}

type MakeShelf = Rc<dyn Fn(WeakEntity<Workspace>, &mut Window, &mut App) -> ShelfPage>;
type MakeHome = Rc<dyn Fn(WeakEntity<Workspace>, &mut Window, &mut App) -> AnyView>;
type MakeChrome = Rc<dyn Fn(PageHost, &mut Window, &mut App) -> Rc<dyn PageChrome>>;

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
    chrome: Option<MakeChrome>,
    layers: Vec<AnyView>,
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

/// Registers Project Home. Each workspace window makes one the first time
/// its paper shows Home, and keeps it while the window lives (it follows
/// the book the window shows).
pub fn set_home(
    cx: &mut App,
    make: impl Fn(WeakEntity<Workspace>, &mut Window, &mut App) -> AnyView + 'static,
) {
    cx.default_global::<Pages>().home = Some(Rc::new(make));
}

/// Registers the chapter page's chrome. Every editor the shell opens (one
/// document or the whole book) gets one made for it, right after it opens.
pub fn set_page_chrome(
    cx: &mut App,
    make: impl Fn(PageHost, &mut Window, &mut App) -> Rc<dyn PageChrome> + 'static,
) {
    cx.default_global::<Pages>().chrome = Some(Rc::new(make));
}

pub(crate) fn make_chrome(
    host: PageHost,
    window: &mut Window,
    cx: &mut App,
) -> Option<Rc<dyn PageChrome>> {
    let make = cx.try_global::<Pages>()?.chrome.clone()?;
    Some(make(host, window, cx))
}

/// Adds a layer drawn over every workspace window's bookshelf and book.
pub fn add_layer(cx: &mut App, view: AnyView) {
    cx.default_global::<Pages>().layers.push(view);
}

pub(crate) fn layers(cx: &App) -> Vec<AnyView> {
    cx.try_global::<Pages>()
        .map(|p| p.layers.clone())
        .unwrap_or_default()
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

/// The window's Project Home, made on first use; `None` when none is
/// registered.
pub(crate) fn home_of(
    ws: &Entity<Workspace>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyView> {
    if let Some(view) = ws.read(cx).home.clone() {
        return Some(view);
    }
    let make = cx.try_global::<Pages>()?.home.clone()?;
    let view = make(ws.downgrade(), window, cx);
    ws.update(cx, |ws, _| ws.home = Some(view.clone()));
    Some(view)
}
