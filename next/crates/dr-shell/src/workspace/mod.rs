//! The workspace window: three columns from the top edge to the bottom
//! (docs/design-system/workspace.md), the tab dock on the paper's top edge,
//! the Super View stage and Settings over everything.
//!
//! [`Workspace`] owns the navigation model, both sidebars and which layers
//! are open. Everything on screen is read from that state each frame; no
//! view keeps a second copy of "what is open".
//!
//! The book comes from F3 (`dr-workspace`): the lists as one [`Book`]
//! snapshot, read off the main thread and read again when F3's bus reports
//! a change. Each open tab's page is an editor ([`editors`]): one prose
//! document's, or the whole book's (M05). Things that go to the trash or are
//! deleted, by anyone, close their tabs.

mod bottom;
pub mod chapter_sort;
mod chrome;
pub mod corner;
mod dock;
pub mod editors;
pub mod find;
pub mod immersive;
pub mod outline;
pub mod page_actions;
mod review;
mod sea;
mod sidebar;
mod stage;
mod super_view;
pub mod toast;

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_workspace::{Workspace as Library, WsEvent};

use dr_ui::{
    Theme,
    anim::Tween,
    glass::{self, Ground},
    tokens::motion,
};
use gpui::{
    AnyView, App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable,
    InteractiveElement, IntoElement, ParentElement, Render, Size, StatefulInteractiveElement as _,
    Styled, Subscription, Task, TitlebarOptions, Window, WindowBounds, WindowOptions, div,
    prelude::FluentBuilder as _, px, size,
};
use serde::{Deserialize, Serialize};

use crate::actions::{
    CloseActiveTab, CloseProject, Dismiss, FindInEditor, GlobalSearch, GoBack, GoForward,
    NewEntity, NextTab, OpenSettings, PreviousTab, ReplaceInEditor, SendFeedback, ShowProjectHome,
    ShowWholeBook, ToggleBottomTimeline, ToggleElementOverview, ToggleImmersiveWriting,
    ToggleLeftSidebar, ToggleNotifications, ToggleReviewMaterials, ToggleRightSidebar,
    ToggleStoryGraph,
};
use crate::book::{self, Book};
use crate::dialogs::{self, FollowUpNotice};
use crate::nav::{self, Navigator, Open, Target, location};
use crate::notifications::{self, Notifications};
use crate::pages::{self, ShelfPage};
use crate::panes::{self, Panes};
use crate::settings::panel::SettingsPanel;
use crate::{Services, Settings, ShellInfo, keymap, menus};

pub use bottom::{BottomLayout, BottomResize};
pub use chrome::{LEADING_INSET, TITLEBAR_HEIGHT, TRAFFIC_LIGHT_POSITION};
pub use dock::DockDrag;
pub use editors::PageEditor;
pub use sea::{FIRST_RUN_DONE, SeaState};
pub use sidebar::{LeftTab, RightTab, page_hover_card};
pub use stage::EditorLook;
pub use super_view::SuperView;

/// The 0.1 client's default and minimum window sizes.
pub const DEFAULT_SIZE: Size<gpui::Pixels> = size(px(1440.), px(900.));
pub const MIN_SIZE: Size<gpui::Pixels> = size(px(1000.), px(700.));
/// A sidebar's width the first time it opens.
pub const DEFAULT_SIDEBAR_WIDTH: f32 = 300.0;

pub(crate) fn init(cx: &mut App) {
    cx.on_action(|_: &OpenSettings, cx| {
        menus::after_dispatch(cx, |cx| {
            with_workspace(cx, |ws, window, cx| ws.open_settings(window, cx));
        })
    });
}

/// The workspace window an app-level action was dispatched to: the active
/// window when it is a workspace (GPUI sends menu actions and shortcuts to
/// it, and a click makes its window the active one), else the frontmost
/// workspace window, else any. GPUI does not tell an app-level handler which
/// window it was dispatched in.
pub fn active_workspace(cx: &App) -> Option<gpui::WindowHandle<Workspace>> {
    cx.active_window()
        .and_then(|w| w.downcast::<Workspace>())
        .or_else(|| {
            cx.window_stack()?
                .into_iter()
                .find_map(|w| w.downcast::<Workspace>())
        })
        .or_else(|| {
            cx.windows()
                .into_iter()
                .find_map(|w| w.downcast::<Workspace>())
        })
}

/// Runs `f` on the workspace an action was dispatched to
/// ([`active_workspace`]), if any.
pub fn with_workspace(
    cx: &mut App,
    f: impl FnOnce(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
) {
    let Some(handle) = active_workspace(cx) else {
        return;
    };
    update_workspace(handle, cx, f);
}

/// Runs `f` on the workspace in `handle`: now, or, when the call comes from
/// inside that window's own update (a click in it, which has the window
/// checked out, so GPUI cannot hand it out again), once that update is over.
pub fn update_workspace(
    handle: gpui::WindowHandle<Workspace>,
    cx: &mut App,
    f: impl FnOnce(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
) {
    let slot = Rc::new(std::cell::Cell::new(Some(f)));
    let now = slot.clone();
    let done = handle.update(cx, move |ws, window, cx| {
        if let Some(f) = now.take() {
            f(ws, window, cx)
        }
    });
    if done.is_ok() {
        return;
    }
    // Still listed: it is busy, not gone.
    let busy = cx
        .windows()
        .iter()
        .any(|w| w.window_id() == handle.window_id());
    if !busy {
        log::warn!("the workspace window is gone");
        return;
    }
    cx.defer(move |cx| {
        let later = handle.update(cx, move |ws, window, cx| {
            if let Some(f) = slot.take() {
                f(ws, window, cx)
            }
        });
        if let Err(error) = later {
            log::error!("could not reach the workspace: {error:#}");
        }
    });
}

/// Runs `f` on the workspace in `window` (one that started something long,
/// such as an import); when that window is gone or is no workspace, on
/// [`with_workspace`]'s.
pub fn with_workspace_in(
    window: gpui::AnyWindowHandle,
    cx: &mut App,
    f: impl FnOnce(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
) {
    let handle = window
        .downcast::<Workspace>()
        .filter(|h| cx.windows().iter().any(|w| w.window_id() == h.window_id()));
    match handle {
        Some(handle) => update_workspace(handle, cx, f),
        None => with_workspace(cx, f),
    }
}

/// Every open workspace writes its layout into the settings file now.
pub fn save_all_layouts(cx: &mut App) {
    for handle in cx
        .windows()
        .into_iter()
        .filter_map(|w| w.downcast::<Workspace>())
    {
        let _ = handle.update(cx, |ws, _, cx| ws.store_layout(cx));
    }
}

pub fn window_options(cx: &App) -> WindowOptions {
    let info = cx.try_global::<ShellInfo>().copied();
    let mut window_size = DEFAULT_SIZE;
    if let Some(display) = cx.primary_display() {
        let visible = display.bounds().size;
        window_size.width = window_size.width.min(visible.width * 0.9);
        window_size.height = window_size.height.min(visible.height * 0.9);
    }
    window_size.width = window_size.width.max(MIN_SIZE.width);
    window_size.height = window_size.height.max(MIN_SIZE.height);
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            window_size,
            cx,
        ))),
        titlebar: Some(TitlebarOptions {
            // Still named for the Window menu, Mission Control and the taskbar.
            title: Some(info.map_or("Drifting", |i| i.app_name).into()),
            appears_transparent: true,
            traffic_light_position: Some(TRAFFIC_LIGHT_POSITION),
        }),
        app_owns_titlebar_drag: true,
        window_min_size: Some(MIN_SIZE),
        app_id: info.map(|i| i.bundle_id.to_owned()),
        ..Default::default()
    }
}

/// One sidebar: open or not (animated), its width and its halves.
pub struct Sidebar<T> {
    pub open: bool,
    pub reveal: Tween,
    pub width: f32,
    pub panes: Panes<T>,
}

impl<T: Copy + PartialEq> Sidebar<T> {
    fn new(saved: Option<SideLayout<T>>, fallback: T, valid: impl Fn(&T) -> bool) -> Self {
        let saved = saved.unwrap_or(SideLayout {
            open: false,
            width: DEFAULT_SIDEBAR_WIDTH,
            panes: Panes::single(fallback),
        });
        Sidebar {
            open: saved.open,
            reveal: Tween::still(if saved.open { 1.0 } else { 0.0 }),
            width: saved.width,
            panes: saved.panes.restored(fallback, valid),
        }
    }

    /// How much of it shows now, 0–1.
    pub fn shown(&self) -> f32 {
        self.reveal.value(dr_ui::anim::now())
    }

    fn set_open(&mut self, open: bool, reduce: bool) {
        self.open = open;
        self.reveal.retarget_motion(
            if open { 1.0 } else { 0.0 },
            dr_ui::anim::now(),
            motion::STRUCTURAL,
            reduce,
        );
    }

    fn saved(&self) -> SideLayout<T> {
        SideLayout {
            open: self.open,
            width: self.width,
            panes: self.panes.clone(),
        }
    }
}

/// A sidebar as the per-book layout stores it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SideLayout<T> {
    pub open: bool,
    pub width: f32,
    pub panes: Panes<T>,
}

/// A book's local layout (loro-schema.md, 「不进书目文档的：本机布局」):
/// the tab tree, the sidebars, the dock lock. Kept in the settings file
/// under the book's id; never in the book document.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BookLayout {
    pub nav: Navigator,
    pub left: SideLayout<LeftTab>,
    pub right: SideLayout<RightTab>,
    #[serde(default)]
    pub dock_locked: bool,
    /// The outline rail in the page's left margin is hidden.
    #[serde(default)]
    pub outline_hidden: bool,
    /// The chapter panel lists the whole book in reading order (with its
    /// acts) instead of by storyline.
    #[serde(default)]
    pub chapters_by_book: bool,
    /// How the chapter panel sorts, and what its cells show on the right.
    #[serde(default)]
    pub chapter_sort: chapter_sort::ChapterSort,
    /// Where the whole book's page was being read (M05).
    #[serde(default)]
    pub book_position: Option<editors::SavedPosition>,
    /// The Bottom Panel: which pane, its height.
    #[serde(default)]
    pub bottom: BottomLayout,
}

/// Where [`Workspace::book_memory`] lives: F2's `local_state` (scope
/// `shell`, key `memory:<book>:<module key>`, the row tied to the book), so
/// it goes when the book is purged, travels with its library and is one
/// copy for every window. Never synced.
pub const BOOK_MEMORY_SCOPE: &str = "shell";

fn memory_prefix(book: &str) -> String {
    format!("memory:{book}:")
}

/// What the Escape key closes, topmost first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layer {
    Notifications,
    /// M06's search panel.
    Search,
    Settings,
    SuperView,
}

pub struct Workspace {
    focus: FocusHandle,
    /// F3's workspace over the library; `None` without one (tests,
    /// captures, a library that could not be opened).
    pub library: Option<Library>,
    /// The book shown (its id is known before its lists arrive).
    pub book_id: String,
    pub book: Rc<Book>,
    book_task: Option<Task<()>>,
    /// The book changed while it was being read: read it again after.
    book_stale: bool,
    /// Every open tab's editor (by target key), once its page was shown.
    pub editors: HashMap<String, PageEditor>,
    /// What new editors are opened with; kept in step by
    /// [`Workspace::style_editors`].
    editor_settings: dr_editor::EditorSettings,
    editor_base: gpui_prose::ProseStyle,
    /// The page last recorded with F3's `recent.touch`.
    touched: Option<String>,
    /// The page (its target key) opened with [`Open::at_title`]: its
    /// editor does not get the keyboard when it opens.
    title_first: Option<String>,
    /// The left tabs modules draw, made the first time a pane shows them
    /// (pane slug and tab; `None`: no module draws it).
    left_panels: std::cell::RefCell<HashMap<(&'static str, LeftTab), Option<pages::LeftPanel>>>,
    /// The 帮手 tab a module draws, per pane slug (as the left panels).
    companion: std::cell::RefCell<HashMap<&'static str, Option<pages::LeftPanel>>>,
    /// The 素材库 tab a module draws, per pane slug (as the 帮手 tab).
    library_panel: std::cell::RefCell<HashMap<&'static str, Option<pages::LeftPanel>>>,
    /// The Super Views' content modules draw, with the book each was made
    /// for.
    super_views: std::cell::RefCell<HashMap<SuperView, (String, Option<pages::SuperViewPage>)>>,
    /// The notice at the bottom of the window, and the timer that ends it.
    pub toast: Option<toast::Toast>,
    toast_timer: Option<Task<()>>,
    /// The outline rail's 「…」 whose list is open, and the timer that
    /// closes it.
    pub outline_reveal: Option<outline::Reveal>,
    outline_reveal_close: Option<Task<()>>,
    /// Node documents edited since their patches' sources were last
    /// checked (`patch.check_sources`).
    unchecked: std::collections::BTreeSet<String>,
    /// The paragraph the caret was last in: its editor, chapter and line.
    caret_paragraph: Option<(gpui::EntityId, usize, usize)>,
    /// The prose editor last given the keyboard, and its handle.
    focused_editor: Option<gpui::EntityId>,
    gave_focus: Option<FocusHandle>,
    /// The pages on screen, and until when they are turning.
    shown_pages: Vec<String>,
    /// Reduced motion as the open editors have it.
    editor_reduce: bool,
    /// The prose editor whose other paragraphs fade (immersive writing).
    dimmed: Option<gpui::EntityId>,
    /// Documents whose live word count M07 has from an editor.
    live_docs: HashSet<String>,
    /// The whole book's reading position (kept with the layout).
    book_position: Option<editors::SavedPosition>,
    /// The find bar over the focused page, while open.
    pub find: Option<Entity<find::FindBar>>,
    /// The Bottom Panel under the paper ([`bottom`]).
    pub bottom: bottom::Bottom,
    /// The sea under the window, the first run, the tour (M24, [`sea`]).
    pub sea: sea::SeaState,
    /// The sea ebbs under the workspace this frame.
    ebbing: bool,
    /// What modules keep for the book shown ([`BOOK_MEMORY_SCOPE`]), as
    /// read when it opened and kept since.
    modules: std::collections::BTreeMap<String, serde_json::Value>,
    /// The book whose memory has been read (it is read off the main thread
    /// when a book opens).
    modules_for: Option<String>,
    modules_read: Option<Task<()>>,
    turning_until: Option<Instant>,
    pub nav: Navigator,
    pub left: Sidebar<LeftTab>,
    pub right: Sidebar<RightTab>,
    pub dock_locked: bool,
    /// The outline rail is hidden (the corner's outline button).
    pub outline_hidden: bool,
    /// Immersive writing: only the paper (the incense stick, ⌘⇧↩).
    pub immersive: bool,
    /// How it was entered, the reveal, the words since ([`immersive`]).
    pub immersion: immersive::Immersion,
    /// The chapter panel's view: the whole book, not by storyline.
    pub chapters_by_book: bool,
    pub chapter_sort: chapter_sort::ChapterSort,
    /// The chapter panel's folded groups (storyline ids, `unaffiliated`)
    /// per book and sidebar half, for this run (workspace.md: folds,
    /// selection and scroll are kept while the app runs, not stored).
    pub folded: HashMap<(String, crate::panes::PaneId), HashSet<String>>,
    /// Where each sidebar list was scrolled, per book, side, half and tab,
    /// for this run: a list closed with its sidebar comes back where it was.
    list_scroll: std::cell::RefCell<HashMap<String, gpui::UniformListScrollHandle>>,
    /// The chapter panel whose sort menu is open (its pane's slug).
    pub chapter_sort_open: Option<String>,
    /// The page whose corner's ⋯ menu is open (its target key).
    pub corner_menu: Option<String>,
    pub super_view: Option<SuperView>,
    pub settings: Option<Entity<SettingsPanel>>,
    /// M06's search panel, while open.
    pub search: Option<Entity<dr_view_search::SearchPanel>>,
    /// M18: the comment composer beside the selection (`review.rs`).
    pub composer: Option<review::Composer>,
    /// M09's snapshot history of a page, while open (`corner::open_history`).
    pub history: Option<Entity<dr_view_history::HistoryDialog>>,
    pub notifications_open: bool,
    /// The account menu over the left sidebar's account cell is open.
    pub account_open: bool,
    /// A dialog another crate draws ([`dialogs`]: feedback, M39), while open.
    pub dialog: Option<AnyView>,
    /// The bookshelf (M01), when one is registered ([`pages::set_shelf`]):
    /// made the first time it shows, kept while the window lives.
    pub shelf: Option<ShelfPage>,
    /// The bookshelf covers the window (at launch, after ⇧⌘W or the red
    /// light) until a book opens.
    pub shelf_open: bool,
    /// Project Home (M02), when one is registered ([`pages::set_home`]):
    /// made with the workspace, kept while the window lives.
    pub home: Option<AnyView>,
    /// A left press on a drag region that has not moved yet (macOS).
    drag_armed: bool,
    /// The layout changed since it was last stored.
    layout_dirty: bool,
    layout_save: Option<Task<()>>,
    _library_events: Option<dr_workspace::Subscription>,
    _observers: Vec<Subscription>,
}

/// How long after a layout change it is written to the settings file.
pub const LAYOUT_SAVE_DELAY: Duration = Duration::from_millis(500);

impl Workspace {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        let services = cx.try_global::<Services>();
        let library = services.and_then(|s| s.library.clone());
        let preferred = services
            .and_then(|s| s.book.clone())
            .or_else(|| Settings::read(cx).last_book().map(str::to_owned));
        // With a bookshelf, the window opens on it (unless a book was named
        // for this run); without one, straight into the last book.
        let shelf_first = services.is_none_or(|s| s.book.is_none()) && pages::has_shelf(cx);
        let book_id = library
            .as_ref()
            .filter(|_| !shelf_first)
            .and_then(|lib| first_choice(lib, preferred.as_deref()))
            .unwrap_or_default();
        let observers = vec![
            cx.observe_window_appearance(window, |ws, window, cx| {
                ws.style_editors(window, cx);
                cx.notify()
            }),
            cx.observe_global_in::<Settings>(window, |ws, window, cx| {
                ws.style_editors(window, cx);
                cx.notify()
            }),
            cx.observe_global_in::<dr_ui::theme::ThemeSettings>(window, |ws, window, cx| {
                ws.style_editors(window, cx);
                cx.notify()
            }),
            cx.observe_global::<Notifications>(|_, cx| cx.notify()),
        ];
        let editor_settings = editors::editor_settings(cx);
        let editor_base = editors::base_style(&Theme::of(window, cx));
        // F3 links the names its text commands write when the author's
        // setting says so (自动要素链接).
        if let Some(lib) = &library {
            lib.set_auto_links(editor_settings.auto_entity_links);
        }
        let mut ws = Workspace {
            focus,
            library,
            book_id,
            book: Rc::new(Book::default()),
            book_task: None,
            book_stale: false,
            editors: HashMap::new(),
            editor_settings,
            editor_base,
            touched: None,
            title_first: None,
            toast: None,
            toast_timer: None,
            left_panels: Default::default(),
            companion: Default::default(),
            library_panel: Default::default(),
            super_views: Default::default(),
            outline_reveal: None,
            outline_reveal_close: None,
            unchecked: Default::default(),
            caret_paragraph: None,
            focused_editor: None,
            gave_focus: None,
            shown_pages: Vec::new(),
            editor_reduce: Theme::of(window, cx).reduce_motion,
            dimmed: None,
            live_docs: HashSet::new(),
            book_position: None,
            find: None,
            bottom: bottom::Bottom::new(BottomLayout::default()),
            sea: Default::default(),
            ebbing: false,
            modules: Default::default(),
            modules_for: None,
            modules_read: None,
            turning_until: None,
            nav: Navigator::default(),
            left: Sidebar::new(None, LeftTab::Chapters, |_| true),
            right: Sidebar::new(None, RightTab::Review, |_| true),
            dock_locked: false,
            outline_hidden: false,
            immersive: false,
            immersion: Default::default(),
            chapters_by_book: false,
            chapter_sort: Default::default(),
            chapter_sort_open: None,
            folded: Default::default(),
            list_scroll: Default::default(),
            corner_menu: None,
            super_view: None,
            settings: None,
            search: None,
            composer: None,
            history: None,
            notifications_open: false,
            account_open: false,
            dialog: None,
            shelf: None,
            shelf_open: false,
            home: None,
            drag_armed: false,
            layout_dirty: false,
            layout_save: None,
            _library_events: None,
            _observers: observers,
        };
        ws.restore_layout(cx);
        ws.listen_to_library(cx);
        ws.home = pages::make_home(cx.weak_entity(), window, cx);
        if shelf_first {
            ws.show_shelf(window, cx);
            ws.sea_first_run(window, cx);
        } else {
            ws.load_book(preferred, cx);
        }
        ws.listen_on_close(window, cx);
        ws.listen_for_links(window, cx);
        // The crash follow-up waits until the window has settled.
        cx.spawn_in(window, async move |_, cx| {
            cx.background_executor()
                .timer(notifications::FOLLOW_UP_DELAY)
                .await;
            cx.update(|_, cx| notifications::check_crash_follow_up(cx))
                .ok();
        })
        .detach();
        ws
    }

    /// The saved layout of the book shown: its tabs (checked against the
    /// book once its lists arrive), the sidebars, the dock lock.
    fn restore_layout(&mut self, cx: &mut Context<Self>) {
        let saved: Option<BookLayout> = Settings::read(cx)
            .layout(&self.book_id)
            .and_then(|v| serde_json::from_value(v.clone()).ok());
        let (nav, left, right, dock_locked, outline_hidden, by_book, sort, position) = match &saved
        {
            Some(l) => (
                Navigator::restored(l.nav.clone(), |_| true),
                Some(l.left.clone()),
                Some(l.right.clone()),
                l.dock_locked,
                l.outline_hidden,
                l.chapters_by_book,
                l.chapter_sort,
                l.book_position.clone(),
            ),
            None => (
                Navigator::default(),
                None,
                None,
                false,
                false,
                false,
                Default::default(),
                None,
            ),
        };
        self.bottom.layout = saved.map(|l| l.bottom).unwrap_or_default();
        self.bottom.forget();
        self.read_book_memory(cx);
        self.nav = nav;
        self.left = Sidebar::new(left, LeftTab::Chapters, |_| true);
        self.right = Sidebar::new(right, RightTab::Review, |_| true);
        self.dock_locked = dock_locked;
        self.outline_hidden = outline_hidden;
        self.chapters_by_book = by_book;
        self.chapter_sort = sort;
        self.chapter_sort_open = None;
        self.book_position = position;
        self.editors.clear();
        self.focused_editor = None;
        self.touched = None;
        self.title_first = None;
    }

    // The book, from F3.

    /// Reads the book's lists off the main thread (again, if it changed).
    fn load_book(&mut self, preferred: Option<String>, cx: &mut Context<Self>) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        if self.book_task.is_some() {
            self.book_stale = true;
            return;
        }
        let want = if self.book_id.is_empty() {
            preferred
        } else {
            Some(self.book_id.clone())
        };
        self.book_task = Some(cx.spawn(async move |this, cx| {
            let started = Instant::now();
            let loaded = cx
                .background_executor()
                .spawn(async move { Book::load_any(&lib, want.as_deref()) })
                .await;
            let ms = started.elapsed().as_secs_f64() * 1e3;
            this.update(cx, |ws, cx| ws.book_loaded(loaded, ms, cx))
                .ok();
        }));
    }

    fn book_loaded(
        &mut self,
        loaded: dr_workspace::Result<Option<Book>>,
        ms: f64,
        cx: &mut Context<Self>,
    ) {
        self.book_task = None;
        match loaded {
            Ok(Some(book)) => {
                log::debug!("book {} read in {ms:.1} ms", book.id);
                if book.id != self.book_id {
                    self.book_id = book.id.clone();
                    self.restore_layout(cx);
                }
                // Tabs whose things are gone close (they went while the
                // app was closed, or since the last read).
                let gone: Vec<Target> = self
                    .nav
                    .tabs()
                    .iter()
                    .flat_map(|t| t.leaves())
                    .map(|l| l.target.clone())
                    .filter(|t| !book.exists(t))
                    .collect();
                for target in &gone {
                    self.nav.forget(target);
                    self.editors.remove(&target.key());
                }
                let id = book.id.clone();
                self.book = Rc::new(book);
                self.retitle_editors(cx);
                Settings::update(cx, |file| file.set_last_book(&id));
                if !gone.is_empty() {
                    self.changed(cx);
                }
                cx.notify();
            }
            Ok(None) => {
                log::info!("the library has no book");
                self.book_id.clear();
                self.book = Rc::new(Book::default());
                cx.notify();
            }
            Err(error) => log::warn!("the book could not be read: {error}"),
        }
        if std::mem::take(&mut self.book_stale) {
            self.load_book(None, cx);
        }
    }

    /// F3's bus: changes to the book, removals, prose. Events arrive on
    /// document holder threads; they are queued and handled here in batches.
    fn listen_to_library(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<WsEvent>();
        self._library_events = Some(lib.subscribe(move |event| {
            if matches!(
                event,
                WsEvent::Book(_) | WsEvent::Removed(_) | WsEvent::Prose(_)
            ) {
                let _ = tx.unbounded_send(event.clone());
            }
        }));
        cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while let Some(first) = rx.next().await {
                let mut batch = vec![first];
                while let Ok(more) = rx.try_recv() {
                    batch.push(more);
                }
                if this
                    .update(cx, |ws, cx| ws.on_library_events(batch, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    /// What a batch of F3 events means for the window.
    pub fn on_library_events(&mut self, events: Vec<WsEvent>, cx: &mut Context<Self>) {
        let mut reload_book = false;
        let mut gone = Vec::new();
        for event in events {
            match event {
                WsEvent::Book(b) if b.book.as_str() == self.book_id => reload_book = true,
                WsEvent::Removed(r) if r.book.as_str() == self.book_id => {
                    gone.extend(r.entities.into_iter().map(|e| book::target(e.target)));
                }
                _ => {}
            }
        }
        if !gone.is_empty() {
            for target in &gone {
                self.nav.forget(target);
                self.editors.remove(&target.key());
            }
            self.changed(cx);
        }
        // The editors fold their documents' changes in themselves.
        if reload_book {
            self.load_book(None, cx);
        }
    }

    // Pages.

    /// Opens the editors of the pages on screen and lets go of those whose
    /// tabs closed.
    fn ensure_pages(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let open: HashSet<String> = self
            .nav
            .tabs()
            .iter()
            .flat_map(|t| t.leaves())
            .map(|l| l.target.key())
            .collect();
        if !open.contains(&Target::Book.key()) {
            self.keep_reading_position(cx);
        }
        self.editors.retain(|key, _| open.contains(key));
        self.release_words(cx);
        if self.book.is_empty() {
            return;
        }
        self.touch_front(cx);
        let shown: Vec<Target> = match self.nav.active_tab() {
            Some(tab) => tab.leaves().map(|l| l.target.clone()).collect(),
            None => Vec::new(),
        };
        self.ensure_editors(&shown, window, cx);
    }

    /// Deep links (`<scheme>://open/<book>/chapters/…#L3`): F7's queue
    /// wakes us from whichever thread delivered them; the main thread
    /// drains `open/` and navigates.
    fn listen_for_links(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(links) = cx
            .try_global::<Services>()
            .and_then(|s| s.deep_links.clone())
        else {
            return;
        };
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<()>();
        links.set_waker(move || {
            let _ = tx.unbounded_send(());
        });
        // Links that arrived before the window existed.
        self.open_queued_links(window, cx);
        cx.spawn_in(window, async move |this, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                let alive = this.update_in(cx, |ws, window, cx| {
                    window.activate_window();
                    ws.open_queued_links(window, cx);
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    fn open_queued_links(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(links) = cx
            .try_global::<Services>()
            .and_then(|s| s.deep_links.clone())
        else {
            return;
        };
        for link in links.drain_matching("open/") {
            self.open_link(&link, window, cx);
        }
    }

    /// The page in front changed: F3's recent pages remember it (Project
    /// Home's 「继续写」 reads them). The whole book is not a page of its own
    /// there.
    fn touch_front(&mut self, cx: &mut Context<Self>) {
        let front = self.nav.active_tab().map(|t| t.focused().target.clone());
        let key = front.as_ref().map(Target::key);
        if key == self.touched {
            return;
        }
        self.touched = key;
        let Some(doc) = front.as_ref().and_then(book::doc_of) else {
            return;
        };
        if let Some((kind, id)) = doc.split_once(':') {
            let input = serde_json::json!({
                "book": self.book_id,
                "target": { "kind": kind, "id": id },
            });
            self.run_command("recent.touch", input, cx);
        }
    }

    /// Opens a location link (either form). Returns whether it named
    /// something in this book.
    pub fn open_link(&mut self, href: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let scheme = cx
            .try_global::<ShellInfo>()
            .map_or("drifting", |i| i.url_scheme);
        let Some(link) = location::parse(href, scheme) else {
            log::info!("not a location link");
            return false;
        };
        let Some(catalog) = self
            .library
            .as_ref()
            .and_then(|lib| lib.catalog(&self.book_id).ok())
        else {
            log::info!("no book to resolve a location link in");
            return false;
        };
        match location::resolve(&link, &catalog) {
            Ok((target, lines)) => {
                self.super_view = None;
                // Reading the whole book: the link's chapter is shown there.
                if self.reveal_in_book(&target, lines, window, cx) {
                    cx.notify();
                    return true;
                }
                self.nav.open_at(target, lines);
                self.changed(cx);
                true
            }
            Err(error) => {
                log::info!("location link not resolved: {error:?}");
                false
            }
        }
    }

    /// When the whole book is the page in front and `target` is one of its
    /// chapters, shows it there (its line, or its title) instead of opening
    /// its own tab. Returns whether it did.
    fn reveal_in_book(
        &mut self,
        target: &Target,
        lines: Option<nav::Lines>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let reading_book = self
            .nav
            .active_tab()
            .is_some_and(|t| t.focused().target == Target::Book);
        let (true, Target::Chapter(id)) = (reading_book, target) else {
            return false;
        };
        let Some(book) = self.book_editor().cloned() else {
            return false;
        };
        let doc = format!("node:{id}");
        book.update(cx, |b, cx| match lines {
            Some(lines) => b.reveal_line(&doc, lines.start as usize, window, cx),
            None => b.jump_to(&doc, window, cx),
        })
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
    }

    // The bookshelf (M01) and the book it opens.

    /// Shows the bookshelf over the window. Returns `false` when none is
    /// registered or it is up already.
    pub fn show_shelf(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.shelf_open {
            return false;
        }
        if self.shelf.is_none() {
            self.shelf = pages::make_shelf(cx.weak_entity(), window, cx);
        }
        if self.shelf.is_none() {
            return false;
        }
        self.store_layout(cx);
        self.set_immersive(false, cx);
        self.shelf_open = true;
        self.super_view = None;
        self.notifications_open = false;
        self.sea_shelf(window, cx);
        cx.notify();
        true
    }

    /// Opens `book` from the bookshelf: its saved tabs and sidebars come
    /// back (or Home, the first time), and the bookshelf goes.
    pub fn open_book(&mut self, book: &str, window: &mut Window, cx: &mut Context<Self>) {
        if book != self.book_id || self.book.is_empty() {
            // M24: a full-window wait on the sea until the page is ready.
            self.sea_opening(window, cx);
        }
        self.shelf_open = false;
        self.notifications_open = false;
        self.super_view = None;
        self.focus.focus(window, cx);
        if book != self.book_id || self.book.is_empty() {
            self.store_layout(cx);
            // A read of the book shown before is dropped, not applied.
            self.book_task = None;
            self.book_stale = false;
            self.book_id = book.to_owned();
            self.book = Rc::new(Book::default());
            self.restore_layout(cx);
            self.load_book(None, cx);
        }
        cx.notify();
    }

    /// A notice's document (M40's file that could not be merged): its page
    /// in this book; in another book, that book opens.
    pub(crate) fn open_noticed(
        &mut self,
        book: &str,
        doc: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.notifications_open = false;
        if book != self.book_id {
            self.open_book(book, window, cx);
            return;
        }
        let target = doc
            .strip_prefix("node:")
            .and_then(|id| editors::link_target(&self.book, &dr_model::kind::EntityKind::Node, id));
        if let Some(target) = target {
            self.open(target, Open::KEEP, cx);
        }
        cx.notify();
    }

    /// The library is about to be swapped ([`crate::library::replace`]):
    /// everything here that holds it goes (the open pages' editors, the
    /// bookshelf, Project Home, search, snapshot history, the comment
    /// composer, the subscription). The window's layout is stored first; a
    /// dialog over it stays.
    pub(crate) fn let_go_of_library(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.store_layout(cx);
        self.editors.clear();
        self.release_words(cx);
        self.focused_editor = None;
        self.gave_focus = None;
        self.dimmed = None;
        self.find = None;
        self.search = None;
        self.history = None;
        self.composer = None;
        self.corner_menu = None;
        self.book_task = None;
        self.book_stale = false;
        self._library_events = None;
        self.shelf = None;
        self.shelf_open = false;
        self.home = None;
        self.left_panels.borrow_mut().clear();
        self.companion.borrow_mut().clear();
        self.library_panel.borrow_mut().clear();
        self.super_views.borrow_mut().clear();
        self.bottom.forget();
        self.modules.clear();
        self.modules_for = None;
        self.modules_read = None;
        self.sea_swapping(window, cx);
        self.library = None;
        self.book_id = String::new();
        self.book = Rc::new(Book::default());
        self.focus.focus(window, cx);
        cx.notify();
    }

    /// The swapped library ([`crate::library::replace`]): the window
    /// follows its changes again and shows the bookshelf (without one, the
    /// book opened last, or the library's first).
    pub(crate) fn adopt_library(
        &mut self,
        lib: Library,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.library = Some(lib.clone());
        self.sea_swapped();
        self.listen_to_library(cx);
        self.home = pages::make_home(cx.weak_entity(), window, cx);
        if !self.show_shelf(window, cx) {
            let last = Settings::read(cx).last_book().map(str::to_owned);
            if let Some(book) = first_choice(&lib, last.as_deref()) {
                self.open_book(&book, window, cx);
            }
        }
        cx.notify();
    }

    /// The red light: in a book it goes back to the bookshelf; on the
    /// bookshelf (or without one) it closes the window.
    fn listen_on_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !pages::has_shelf(cx) {
            return;
        }
        let this = cx.weak_entity();
        window.on_window_should_close(cx, move |window, cx| {
            this.update(cx, |ws, cx| !ws.show_shelf(window, cx))
                .unwrap_or(true)
        });
    }

    /// Something in the layout changed: repaint, and store it soon.
    fn changed(&mut self, cx: &mut Context<Self>) {
        self.layout_dirty = true;
        cx.notify();
        let task = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(LAYOUT_SAVE_DELAY).await;
            this.update(cx, |ws, cx| ws.store_layout(cx)).ok();
        });
        self.layout_save = Some(task);
    }

    pub fn layout(&self) -> BookLayout {
        BookLayout {
            nav: self.nav.clone(),
            left: self.left.saved(),
            right: self.right.saved(),
            dock_locked: self.dock_locked,
            outline_hidden: self.outline_hidden,
            chapters_by_book: self.chapters_by_book,
            chapter_sort: self.chapter_sort,
            book_position: self.book_position.clone(),
            bottom: self.bottom.layout.clone(),
        }
    }

    /// What a module keeps for the book shown under `key` on this device
    /// (never in the book; [`BOOK_MEMORY_SCOPE`]). Read once
    /// [`Workspace::book_memory_ready`].
    pub fn book_memory(&self, key: &str) -> Option<&serde_json::Value> {
        self.modules.get(key)
    }

    /// Whether the book shown has had its memory read (a module applies
    /// what it kept from then on; the workspace notifies when it is).
    pub fn book_memory_ready(&self) -> bool {
        self.library.is_none() || self.modules_for.as_deref() == Some(self.book_id.as_str())
    }

    /// Keeps `value` for the book shown under `key`: at once here, in F2's
    /// `local_state` off the main thread.
    pub fn set_book_memory(&mut self, key: &str, value: serde_json::Value, cx: &mut Context<Self>) {
        if self.book_id.is_empty() || self.modules.get(key) == Some(&value) {
            return;
        }
        self.modules.insert(key.to_owned(), value.clone());
        let Some(lib) = self.library.clone() else {
            return;
        };
        let (book, row) = (
            self.book_id.clone(),
            format!("{}{key}", memory_prefix(&self.book_id)),
        );
        cx.background_spawn(async move {
            if let Err(error) =
                lib.library()
                    .local_set(BOOK_MEMORY_SCOPE, &row, &value.to_string(), Some(&book))
            {
                log::warn!("a module's memory could not be kept: {error}");
            }
        })
        .detach();
    }

    /// Reads the book shown's memory off the main thread. What a module
    /// kept while it was read wins over what was stored.
    fn read_book_memory(&mut self, cx: &mut Context<Self>) {
        self.modules.clear();
        self.modules_for = None;
        let Some(lib) = self.library.clone().filter(|_| !self.book_id.is_empty()) else {
            self.modules_read = None;
            return;
        };
        let book = self.book_id.clone();
        self.modules_read = Some(cx.spawn(async move |this, cx| {
            let prefix = memory_prefix(&book);
            let read = {
                let book = book.clone();
                cx.background_spawn(async move {
                    lib.library().local_entries(BOOK_MEMORY_SCOPE, Some(&book))
                })
                .await
            };
            let entries = read.unwrap_or_else(|error| {
                log::warn!("the book's module memory could not be read: {error}");
                Vec::new()
            });
            this.update(cx, |ws, cx| {
                if ws.book_id != book {
                    return;
                }
                for e in entries {
                    let (Some(key), Ok(value)) = (
                        e.key.strip_prefix(&prefix),
                        serde_json::from_str::<serde_json::Value>(&e.value),
                    ) else {
                        continue;
                    };
                    ws.modules.entry(key.to_owned()).or_insert(value);
                }
                ws.modules_for = Some(book);
                ws.modules_read = None;
                cx.notify();
            })
            .ok();
        }));
    }

    /// Writes the layout into the settings file now, if it changed.
    pub fn store_layout(&mut self, cx: &mut Context<Self>) {
        // The whole book's reading position moves without a layout change.
        if self.keep_reading_position(cx) {
            self.layout_dirty = true;
        }
        if !self.layout_dirty {
            return;
        }
        self.layout_dirty = false;
        self.layout_save = None;
        if self.book_id.is_empty() {
            return;
        }
        let Ok(value) = serde_json::to_value(self.layout()) else {
            return;
        };
        let book = self.book_id.clone();
        Settings::update(cx, |file| file.set_layout(&book, value));
    }

    fn reduce_motion(&self, window: &Window, cx: &App) -> bool {
        Theme::of(window, cx).reduce_motion
    }

    // Navigation.

    pub fn open(&mut self, target: Target, how: Open, cx: &mut Context<Self>) {
        if how.title {
            self.title_first = Some(target.key());
        }
        self.nav.open(target, how);
        self.changed(cx);
    }

    /// A chapter dropped on another in the chapter panel takes that place
    /// in reading order: after it when it came from above, before it when
    /// from below (F3's `chapter.move`; the lists change when F3 says the
    /// book did).
    pub fn move_chapter(&mut self, id: &str, onto: &str, cx: &mut Context<Self>) {
        let at = |x: &str| self.book.chapters.iter().position(|c| c.id == x);
        let (Some(from), Some(to)) = (at(id), at(onto)) else {
            return;
        };
        if from == to {
            return;
        }
        let place = if from < to {
            serde_json::json!({ "after": onto })
        } else {
            serde_json::json!({ "before": onto })
        };
        self.run_command(
            "chapter.move",
            serde_json::json!({ "book": self.book_id, "id": id, "place": place }),
            cx,
        );
    }

    pub fn promote(&mut self, target: &Target, cx: &mut Context<Self>) {
        if self.nav.promote(target) {
            self.changed(cx);
        }
    }

    // Sidebars.

    pub fn toggle_left(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let reduce = self.reduce_motion(window, cx);
        self.left.set_open(!self.left.open, reduce);
        self.changed(cx);
    }

    pub fn toggle_right(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let reduce = self.reduce_motion(window, cx);
        self.right.set_open(!self.right.open, reduce);
        self.changed(cx);
    }

    // Layers.

    /// Settings, a Super View or a dialog covers the workspace: nothing
    /// under it answers the keyboard (the 0.1 client made it `inert`).
    pub fn covered(&self) -> bool {
        self.settings.is_some() || self.super_view.is_some() || self.shelf_open || self.modal()
    }

    /// A modal dialog is open (another crate's, or M09's snapshot history):
    /// the workspace answers none of its own shortcuts until it closes.
    pub fn modal(&self) -> bool {
        self.dialog.is_some() || self.history.is_some()
    }

    /// The feedback dialog ([`dialogs::set_feedback`]), as a crash
    /// follow-up when `follow_up` names one. Without a registered dialog
    /// nothing opens.
    pub fn open_feedback(
        &mut self,
        follow_up: Option<FollowUpNotice>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.notifications_open = false;
        let ws = cx.entity().downgrade();
        let close: dialogs::Close = std::rc::Rc::new(move |window, cx| {
            ws.update(cx, |ws, cx| {
                ws.dialog = None;
                ws.refocus(window, cx);
            })
            .ok();
        });
        self.dialog = dialogs::make_feedback(follow_up, close, window, cx);
        cx.notify();
    }

    /// The topmost open layer.
    pub fn top_layer(&self) -> Option<Layer> {
        if self.notifications_open {
            Some(Layer::Notifications)
        } else if self.search.is_some() {
            Some(Layer::Search)
        } else if self.settings.is_some() {
            Some(Layer::Settings)
        } else if self.super_view.is_some() {
            Some(Layer::SuperView)
        } else {
            None
        }
    }

    /// Esc: closes the topmost layer, else leaves immersive writing.
    /// Returns whether there was something to close.
    pub fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.top_layer().is_none() && self.immersive {
            self.set_immersive(false, cx);
            return true;
        }
        match self.top_layer() {
            Some(Layer::Notifications) => self.notifications_open = false,
            Some(Layer::Search) => {
                self.search = None;
                self.refocus(window, cx);
            }
            Some(Layer::Settings) => {
                self.settings = None;
                crate::settings::panel_closed(window.window_handle().window_id(), cx);
                self.refocus(window, cx);
            }
            Some(Layer::SuperView) => {
                self.super_view = None;
                self.refocus(window, cx);
            }
            None => return false,
        }
        cx.notify();
        true
    }

    pub fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.modal() {
            return;
        }
        self.notifications_open = false;
        if self.settings.is_none() {
            let panel = cx.new(|cx| SettingsPanel::new(window, cx));
            cx.subscribe_in(&panel, window, |ws, _, event, window, cx| match event {
                crate::settings::panel::PanelEvent::Close => {
                    ws.settings = None;
                    crate::settings::panel_closed(window.window_handle().window_id(), cx);
                    ws.refocus(window, cx);
                }
            })
            .detach();
            panel.update(cx, |panel, cx| panel.focus(window, cx));
            self.settings = Some(panel);
        }
        cx.notify();
    }

    /// ⌘⇧F: M06's search panel. A hit opens its page through a location
    /// link (the paragraph scrolls into view) or, for a material, the page.
    pub fn toggle_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.search.take().is_some() {
            self.focus.focus(window, cx);
            cx.notify();
            return;
        }
        let strings = crate::Strings::get(cx);
        let (locale, platform) = (strings.locale(), strings.platform());
        let book = self.book.clone();
        let marks: dr_view_search::Marks = Rc::new(move |t| book.mark(&book::target(t.clone())));
        let (lib, id) = (self.library.clone(), self.book_id.clone());
        let panel = cx.new(|cx| {
            dr_view_search::SearchPanel::new(lib, id, marks, locale, platform, window, cx)
        });
        cx.subscribe_in(&panel, window, |ws, _, event, window, cx| {
            ws.search = None;
            ws.focus.focus(window, cx);
            if let dr_view_search::SearchEvent::Jump(jump) = event {
                let opened = jump
                    .link
                    .as_deref()
                    .is_some_and(|link| ws.open_link(link, window, cx));
                if !opened {
                    ws.super_view = None;
                    ws.open(book::target(jump.target.clone()), Open::KEEP, cx);
                }
            }
            cx.notify();
        })
        .detach();
        panel.update(cx, |p, cx| p.focus(window, cx));
        self.search = Some(panel);
        cx.notify();
    }

    pub fn toggle_super_view(&mut self, view: SuperView, cx: &mut Context<Self>) {
        self.notifications_open = false;
        // A Super View ends immersive writing (M26).
        self.set_immersive(false, cx);
        self.super_view = if self.super_view == Some(view) {
            None
        } else {
            Some(view)
        };
        cx.notify();
    }

    fn on_actions(
        &self,
        el: gpui::Stateful<gpui::Div>,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        // A modal dialog is open: none of the workspace's own shortcuts
        // until it closes (Esc and its buttons are the dialog's).
        if self.modal() {
            return el;
        }
        el.on_action(
            cx.listener(|ws, _: &ToggleLeftSidebar, window, cx| ws.toggle_left(window, cx)),
        )
        .on_action(
            cx.listener(|ws, _: &ToggleRightSidebar, window, cx| ws.toggle_right(window, cx)),
        )
        .on_action(cx.listener(|ws, _: &GoBack, _, cx| {
            // Back closes a Super View first, as in the 0.1 client.
            if ws.super_view.take().is_some() {
                cx.notify();
            } else if ws.nav.back() {
                ws.changed(cx);
            }
        }))
        .on_action(cx.listener(|ws, _: &GoForward, _, cx| {
            if ws.nav.forward() {
                ws.changed(cx);
            }
        }))
        .on_action(cx.listener(|ws, _: &PreviousTab, _, cx| {
            // Settings or a Super View covers the workspace.
            if ws.covered() {
                return;
            }
            if ws.nav.cycle(-1) {
                ws.changed(cx);
            }
        }))
        .on_action(cx.listener(|ws, _: &NextTab, _, cx| {
            // Settings or a Super View covers the workspace.
            if ws.covered() {
                return;
            }
            if ws.nav.cycle(1) {
                ws.changed(cx);
            }
        }))
        .on_action(cx.listener(|ws, _: &CloseActiveTab, _, cx| {
            // Settings or a Super View covers the workspace.
            if ws.covered() {
                return;
            }
            if ws.nav.close_active() {
                ws.changed(cx);
            }
        }))
        .on_action(cx.listener(|ws, _: &NewEntity, _, cx| {
            ws.super_view = None;
            if ws.nav.go_home() {
                ws.changed(cx);
            }
        }))
        .on_action(cx.listener(|ws, _: &ShowProjectHome, _, cx| {
            ws.super_view = None;
            ws.nav.go_home();
            ws.changed(cx);
        }))
        .on_action(cx.listener(|ws, _: &ShowWholeBook, _, cx| {
            ws.super_view = None;
            ws.open(Target::Book, Open::PREVIEW, cx);
        }))
        .on_action(cx.listener(|ws, _: &ToggleStoryGraph, _, cx| {
            ws.toggle_super_view(SuperView::StoryGraph, cx)
        }))
        .on_action(cx.listener(|ws, _: &ToggleElementOverview, _, cx| {
            ws.toggle_super_view(SuperView::Elements, cx)
        }))
        .on_action(cx.listener(|ws, _: &ToggleReviewMaterials, _, cx| {
            ws.toggle_super_view(SuperView::ReviewMaterials, cx)
        }))
        .on_action(cx.listener(|ws, _: &ToggleNotifications, _, cx| {
            ws.notifications_open = !ws.notifications_open;
            if ws.notifications_open {
                Notifications::mark_read(cx);
            }
            cx.notify();
        }))
        .on_action(
            cx.listener(|ws, _: &SendFeedback, window, cx| ws.open_feedback(None, window, cx)),
        )
        .on_action(cx.listener(|ws, _: &Dismiss, window, cx| {
            if !ws.dismiss(window, cx) {
                cx.propagate();
            }
        }))
        // ⌘J: the timeline in the Bottom Panel (`bottom.rs`).
        .on_action(cx.listener(|ws, _: &ToggleBottomTimeline, _, cx| ws.toggle_timeline(cx)))
        .on_action(
            cx.listener(|ws, _: &ToggleImmersiveWriting, _, cx| {
                ws.set_immersive(!ws.immersive, cx)
            }),
        )
        .on_action(cx.listener(|ws, _: &FindInEditor, window, cx| ws.open_find(window, cx)))
        .on_action(cx.listener(|ws, _: &ReplaceInEditor, window, cx| ws.open_replace(window, cx)))
        .on_action(cx.listener(Self::on_new_comment))
        .on_action(cx.listener(|ws, _: &GlobalSearch, window, cx| ws.toggle_search(window, cx)))
        .on_action(cx.listener(|ws, _: &CloseProject, window, cx| {
            ws.show_shelf(window, cx);
        }))
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        if self.shelf_open
            && let Some(shelf) = self.shelf.clone()
        {
            return self.render_shelf(shelf, window, cx);
        }
        let viewport = window.viewport_size();
        let window_w = f32::from(viewport.width);
        self.fit_sidebars(window_w, window, cx);
        self.ensure_pages(window, cx);
        // M24: while a full-window wait holds the sea, only the sea shows
        // (the page in front gets ready under it).
        if self.sea_settle(window) {
            let root = div()
                .id("workspace")
                .key_context(keymap::WORKSPACE)
                .track_focus(&self.focus)
                .relative()
                .size_full()
                .children(Self::backdrop(window, cx))
                .child(chrome::windows_caption(window, cx));
            let root = self.on_actions(root, cx);
            return glass::surface(Ground::flat(p.desk), root).into_any_element();
        }
        self.ebbing = Self::sea_ebbs(window, cx);
        self.sync_traffic_lights(window, cx);
        let ebbing = self.ebbing;
        self.sea_guide(window, cx);

        let immersive = self.immersive;
        let left = (!immersive)
            .then(|| sidebar::left(self, window, cx))
            .map(|el| Self::on_sea("sea-left", el, ebbing, cx));
        let right = (!immersive)
            .then(|| sidebar::right(self, window, cx))
            .map(|el| Self::on_sea("sea-right", el, ebbing, cx));
        let mid = stage::mid(self, window, cx);
        let row = div()
            .size_full()
            .flex()
            .flex_row()
            .children(left)
            .child(mid)
            .children(right);

        let stage = self
            .super_view
            .map(|view| super_view::stage(self, view, window, cx));
        let root = div()
            .id("workspace")
            .key_context(keymap::WORKSPACE)
            .track_focus(&self.focus)
            .relative()
            .size_full()
            .when(!ebbing, |el| el.bg(p.desk.solid()))
            .text_color(p.ink(1).solid())
            .on_drag_move::<sidebar::ResizeDrag>(cx.listener(sidebar::on_resize))
            .on_drag_move::<BottomResize>(cx.listener(bottom::on_resize))
            // M26: a press off the paper leaves what typing began; the top
            // band brings the traffic lights and tab dots back.
            .capture_any_mouse_down(cx.listener(|ws, e: &gpui::MouseDownEvent, window, cx| {
                ws.pressed_while_immersed(e.position, window, cx)
            }))
            .on_mouse_move(cx.listener(|ws, e: &gpui::MouseMoveEvent, _, cx| {
                ws.pointer_while_immersed(f32::from(e.position.y), cx)
            }))
            .capture_key_down(cx.listener(|ws, e: &gpui::KeyDownEvent, _, cx| {
                if !e.keystroke.modifiers.modified() {
                    ws.conceal(cx)
                }
            }))
            .on_hover(cx.listener(|ws, hovered: &bool, _, cx| {
                if !hovered {
                    ws.conceal(cx)
                }
            }))
            .children(Self::backdrop(window, cx))
            .child(row)
            .when(!immersive, |el| {
                el.child(chrome::sidebar_toggles(self, window, cx))
            })
            .children(stage)
            .when_some(self.settings.clone(), |el, panel| el.child(panel))
            .when_some(self.search.clone(), |el, panel| el.child(panel))
            .children(self.composer_overlay())
            .when_some(self.dialog.clone(), |el, dialog| el.child(dialog))
            .children(self.toast_overlay())
            .when_some(self.history.clone(), |el, dialog| el.child(dialog))
            .child(chrome::windows_caption(window, cx))
            .when(self.notifications_open, |el| {
                el.child(sidebar::notification_center(self, window, cx))
            })
            .when(self.account_open && !self.immersive, |el| {
                el.child(sidebar::account_menu(self, window, cx))
            })
            .children(self.guide_layer(self.super_view.is_some(), window, cx));
        let root = self.on_actions(root, cx);
        glass::surface(Ground::flat(p.desk), root).into_any_element()
    }
}

impl Workspace {
    /// The sea ebbs under the workspace (M24): the paper's desk and the
    /// Bottom Panel leave their colour to it.
    pub fn ebbing(&self) -> bool {
        self.ebbing
    }
}

impl Workspace {
    /// The bookshelf over the whole window, with Settings and the
    /// notification center (opening from the bookshelf's bell) above it.
    fn render_shelf(
        &mut self,
        shelf: ShelfPage,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let p = Theme::of(window, cx).palette;
        if let Some(bell) = shelf.bell.as_ref().and_then(|b| *b.read(cx)) {
            dr_ui::components::overlay::use_bounds("bell-bounds", window, cx)
                .update(cx, |b, _| *b = Some(bell));
        }
        let strip = chrome::drag_region(
            div()
                .id("shelf-drag-strip")
                .absolute()
                .top_0()
                .left_0()
                .right_0()
                .h(px(chrome::TITLEBAR_HEIGHT)),
            cx,
        );
        self.sea_shelf(window, cx);
        // M24: the first run lies over the bookshelf, which shows under it
        // once it says so.
        let first_run = sea::first_run_layer(self, cx);
        let shelf_shows = first_run.as_ref().is_none_or(|(_, shows)| *shows);
        let root = div()
            .id("workspace")
            .key_context(keymap::WORKSPACE)
            .track_focus(&self.focus)
            .relative()
            .size_full()
            .bg(p.desk.solid())
            .text_color(p.ink(1).solid())
            .children(Self::backdrop(window, cx))
            .when(shelf_shows, |el| el.child(shelf.view))
            .children(first_run.map(|(view, _)| view))
            .child(strip)
            .when_some(self.settings.clone(), |el, panel| el.child(panel))
            .when_some(self.dialog.clone(), |el, dialog| el.child(dialog))
            .children(self.toast_overlay())
            .child(chrome::windows_caption(window, cx))
            .when(self.notifications_open, |el| {
                el.child(sidebar::notification_center(self, window, cx))
            });
        let root = self.on_actions(root, cx);
        glass::surface(Ground::flat(p.desk), root).into_any_element()
    }
}

impl Workspace {
    /// Keeps both sidebars inside the window and splits or joins their halves.
    fn fit_sidebars(&mut self, window_w: f32, window: &mut Window, cx: &mut Context<Self>) {
        let previous_right_panes = self.right.panes.panes.clone();
        let left_min = sidebar::min_width(sidebar::Side::Left, false, window, cx);
        let right_min = sidebar::min_width(sidebar::Side::Right, false, window, cx);
        let other = |s: f32, w: f32| if s > 0.0 { w } else { 0.0 };
        let (l_open, r_open) = (self.left.open as u8 as f32, self.right.open as u8 as f32);
        self.left.width = panes::clamp_width(
            self.left.width,
            left_min,
            window_w,
            other(r_open, self.right.width),
        );
        self.right.width = panes::clamp_width(
            self.right.width,
            right_min,
            window_w,
            other(l_open, self.left.width),
        );
        let left_split = sidebar::min_width(sidebar::Side::Left, true, window, cx);
        let right_split = sidebar::min_width(sidebar::Side::Right, true, window, cx);
        self.left
            .panes
            .resize(self.left.width >= left_split, &LeftTab::ORDER);
        self.right
            .panes
            .resize(self.right.width >= right_split, &RightTab::ORDER);
        if self.right.panes.panes != previous_right_panes {
            // Cached module bodies observe visibility through Workspace.
            // Resizing can hide a pane without a tab or toggle action.
            cx.notify();
        }
    }
}

pub(crate) use nav::Side as PageSide;

/// The name a pill, a page or a link shows for `target`: its title, the
/// whole book's tab name, or 「未命名…」 for its kind.
pub fn title_of(book: &Book, target: &Target, cx: &App) -> gpui::SharedString {
    use dr_i18n::keys::top_timeline::{singletons, untitled};
    let untitled = match target {
        Target::Book => return crate::t(cx, singletons::ALL_CHAPTERS),
        Target::Chapter(_) => untitled::CHAPTER,
        Target::Idea(_) => untitled::DRIFT,
        Target::Storyline(_) => untitled::STORYLINE,
        Target::Element(_) => untitled::ELEMENT,
        Target::Category(_) => untitled::CATEGORY,
        Target::Material(_) => untitled::LIBRARY_ITEM,
    };
    match book.title(target).filter(|t| !t.trim().is_empty()) {
        Some(title) => title.to_owned().into(),
        None => crate::t(cx, untitled),
    }
}

/// The book to try first without reading any: the one asked for or opened
/// last, if the library has it, else the first the library lists (an id
/// only; whether it is in the trash shows once it is read).
fn first_choice(lib: &Library, preferred: Option<&str>) -> Option<String> {
    let ids: Vec<String> = match lib.library().docs(None, Some("book")) {
        Ok(docs) => docs
            .into_iter()
            .filter_map(|d| d.doc_id.strip_prefix("book:").map(str::to_owned))
            .collect(),
        Err(error) => {
            log::warn!("the library's books could not be listed: {error}");
            return None;
        }
    };
    preferred
        .and_then(|p| ids.iter().find(|id| id.as_str() == p).cloned())
        .or_else(|| ids.into_iter().next())
}
