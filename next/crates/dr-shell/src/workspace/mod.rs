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
//! a change. Each open tab whose page is a prose document is edited in its
//! own `dr-editor` view ([`editors`]); the whole book is still a read-only
//! [`PageSlot`]. Things that go to the trash or are deleted, by anyone,
//! close their tabs.

mod chrome;
pub mod corner;
mod dock;
pub mod editors;
pub mod outline;
mod sidebar;
mod stage;
mod super_view;

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
    App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable, InteractiveElement,
    IntoElement, ListAlignment, ListState, ParentElement, Render, Size, Styled, Subscription, Task,
    TitlebarOptions, Window, WindowBounds, WindowOptions, div, prelude::FluentBuilder as _, px,
    size,
};
use serde::{Deserialize, Serialize};

use crate::actions::{
    CloseActiveTab, CloseProject, Dismiss, FindInEditor, GlobalSearch, GoBack, GoForward,
    NewEntity, NextTab, OpenSettings, PreviousTab, ShowProjectHome, ShowWholeBook,
    ToggleBottomTimeline, ToggleElementOverview, ToggleImmersiveWriting, ToggleLeftSidebar,
    ToggleNotifications, ToggleReviewMaterials, ToggleRightSidebar, ToggleStoryGraph,
};
use crate::book::{self, Book, PageText, Paragraph};
use crate::nav::{self, Navigator, Open, Target, location};
use crate::notifications::{self, Notifications};
use crate::panes::{self, Panes};
use crate::settings::panel::SettingsPanel;
use crate::{Services, Settings, ShellInfo, keymap, menus};

pub use chrome::{LEADING_INSET, TITLEBAR_HEIGHT, TRAFFIC_LIGHT_POSITION};
pub use dock::DockDrag;
pub use editors::PageEditor;
pub use sidebar::{LeftTab, RightTab};
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

/// Runs `f` on the open workspace, if any.
pub fn with_workspace(
    cx: &mut App,
    f: impl FnOnce(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
) {
    let Some(handle) = cx
        .windows()
        .into_iter()
        .find_map(|w| w.downcast::<Workspace>())
    else {
        return;
    };
    if let Err(error) = handle.update(cx, |ws, window, cx| f(ws, window, cx)) {
        log::error!("could not reach the workspace: {error:#}");
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
}

/// What the Escape key closes, topmost first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layer {
    Notifications,
    Settings,
    SuperView,
}

/// One row of a page's list: the page's own heading (its mark and title),
/// a chapter's title on the whole book's page, or a paragraph.
#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    Head,
    Section(String),
    Para(Paragraph),
}

/// The whole book's prose, read-only, and the list that shows it (only the
/// rows on screen are laid out).
pub struct PageSlot {
    pub items: Rc<Vec<Item>>,
    pub list: ListState,
    /// Read at least once.
    pub ready: bool,
    /// Being read; since when.
    pub loading: Option<Instant>,
    /// The editor settings the rows were measured with.
    look: Option<EditorLook>,
    _task: Option<Task<()>>,
    _timer: Option<Task<()>>,
}

impl PageSlot {
    fn new() -> PageSlot {
        PageSlot {
            items: Rc::new(vec![Item::Head]),
            list: ListState::new(1, ListAlignment::Top, px(PAGE_OVERDRAW)),
            ready: false,
            loading: None,
            look: None,
            _task: None,
            _timer: None,
        }
    }

    fn set(&mut self, text: PageText) {
        let mut items = vec![Item::Head];
        for (title, paragraphs) in text.sections {
            if let Some(title) = title {
                items.push(Item::Section(title));
            }
            items.extend(paragraphs.into_iter().map(Item::Para));
        }
        let old = self.items.len();
        if self.ready {
            // Read again after a change: the rows keep their place.
            self.list.splice(0..old, items.len());
        } else {
            self.list.reset(items.len());
        }
        self.items = Rc::new(items);
        self.ready = true;
    }

    /// The page is taking long to read: its pill drifts (`Pill::loading`).
    pub fn slow(&self) -> bool {
        self.loading
            .is_some_and(|since| since.elapsed() >= motion::dwell::LOADING_DELAY)
    }
}

/// How far beyond the paper's edges a page lays out rows.
const PAGE_OVERDRAW: f32 = 800.0;

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
    /// The whole book's read-only page, while a tab shows it.
    pub pages: HashMap<String, PageSlot>,
    /// Every open tab's editor (by target key), once its page was shown.
    pub editors: HashMap<String, PageEditor>,
    /// What new editors are opened with; kept in step by
    /// [`Workspace::style_editors`].
    editor_settings: dr_editor::EditorSettings,
    editor_base: gpui_prose::ProseStyle,
    /// The document whose editor was last given the keyboard.
    focused_doc: Option<String>,
    /// The pages on screen, and until when they are turning.
    shown_pages: Vec<String>,
    turning_until: Option<Instant>,
    pub nav: Navigator,
    pub left: Sidebar<LeftTab>,
    pub right: Sidebar<RightTab>,
    pub dock_locked: bool,
    /// The outline rail is hidden (the corner's outline button).
    pub outline_hidden: bool,
    /// Immersive writing: only the paper (the incense stick, ⌘⇧↩).
    pub immersive: bool,
    /// The chapter panel's view: the whole book, not by storyline.
    pub chapters_by_book: bool,
    /// The page whose corner's ⋯ menu is open (its target key).
    pub corner_menu: Option<String>,
    pub super_view: Option<SuperView>,
    pub settings: Option<Entity<SettingsPanel>>,
    /// M06's search panel, while open.
    pub search: Option<Entity<dr_view_search::SearchPanel>>,
    pub notifications_open: bool,
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
        let book_id = library
            .as_ref()
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
            cx.observe_global::<Notifications>(|_, cx| cx.notify()),
        ];
        let editor_settings = editors::editor_settings(cx);
        let editor_base = editors::base_style(&Theme::of(window, cx));
        let mut ws = Workspace {
            focus,
            library,
            book_id,
            book: Rc::new(Book::default()),
            book_task: None,
            book_stale: false,
            pages: HashMap::new(),
            editors: HashMap::new(),
            editor_settings,
            editor_base,
            focused_doc: None,
            shown_pages: Vec::new(),
            turning_until: None,
            nav: Navigator::default(),
            left: Sidebar::new(None, LeftTab::Chapters, |_| true),
            right: Sidebar::new(None, RightTab::Review, |_| true),
            dock_locked: false,
            outline_hidden: false,
            immersive: false,
            chapters_by_book: false,
            corner_menu: None,
            super_view: None,
            settings: None,
            search: None,
            notifications_open: false,
            drag_armed: false,
            layout_dirty: false,
            layout_save: None,
            _library_events: None,
            _observers: observers,
        };
        ws.restore_layout(cx);
        ws.listen_to_library(cx);
        ws.load_book(preferred, cx);
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
        let (nav, left, right, dock_locked, outline_hidden, by_book) = match saved {
            Some(l) => (
                Navigator::restored(l.nav, |_| true),
                Some(l.left),
                Some(l.right),
                l.dock_locked,
                l.outline_hidden,
                l.chapters_by_book,
            ),
            None => (Navigator::default(), None, None, false, false, false),
        };
        self.nav = nav;
        self.left = Sidebar::new(left, LeftTab::Chapters, |_| true);
        self.right = Sidebar::new(right, RightTab::Review, |_| true);
        self.dock_locked = dock_locked;
        self.outline_hidden = outline_hidden;
        self.chapters_by_book = by_book;
        self.pages.clear();
        self.editors.clear();
        self.focused_doc = None;
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
                    self.pages.remove(&target.key());
                    self.editors.remove(&target.key());
                }
                let id = book.id.clone();
                let chapters_changed = self.book.chapter_titles() != book.chapter_titles();
                self.book = Rc::new(book);
                self.retitle_editors(cx);
                if chapters_changed && self.pages.contains_key(&Target::Book.key()) {
                    self.load_page(Target::Book, cx);
                }
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
        let mut book_prose = false;
        for event in events {
            match event {
                WsEvent::Book(b) if b.book.as_str() == self.book_id => reload_book = true,
                WsEvent::Removed(r) if r.book.as_str() == self.book_id => {
                    gone.extend(r.entities.into_iter().map(|e| book::target(e.target)));
                }
                WsEvent::Prose(p) => {
                    book_prose |= p.book.as_ref().is_some_and(|b| b.as_str() == self.book_id);
                }
                _ => {}
            }
        }
        if !gone.is_empty() {
            for target in &gone {
                self.nav.forget(target);
                self.pages.remove(&target.key());
                self.editors.remove(&target.key());
            }
            self.changed(cx);
        }
        // The editors fold their own document's changes in; only the whole
        // book's read-only page is read again.
        if book_prose && self.pages.contains_key(&Target::Book.key()) {
            self.load_page(Target::Book, cx);
        }
        if reload_book {
            self.load_book(None, cx);
        }
    }

    // Pages.

    /// Opens the editors and reads the whole book's page on screen, and
    /// lets go of those whose tabs closed.
    fn ensure_pages(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Pages and editors of closed tabs go.
        let open: HashSet<String> = self
            .nav
            .tabs()
            .iter()
            .flat_map(|t| t.leaves())
            .map(|l| l.target.key())
            .collect();
        self.pages.retain(|key, _| open.contains(key));
        self.editors.retain(|key, _| open.contains(key));
        if self.book.is_empty() {
            return;
        }
        let shown: Vec<Target> = match self.nav.active_tab() {
            Some(tab) => tab.leaves().map(|l| l.target.clone()).collect(),
            None => Vec::new(),
        };
        if shown.contains(&Target::Book) {
            let target = Target::Book;
            if !self.pages.contains_key(&target.key()) {
                self.load_page(target.clone(), cx);
            }
            // A location link's lines: the page scrolls there once.
            if let Some(slot) = self.pages.get(&target.key())
                && slot.ready
                && let Some(lines) = self.nav.take_reveal(&target)
            {
                let block = location::line_to_block(lines.start) as usize;
                slot.list
                    .scroll_to_reveal_item((block + 1).min(slot.items.len() - 1));
            }
        }
        self.ensure_editors(&shown, window, cx);
    }

    /// Reads a page's prose off the main thread.
    fn load_page(&mut self, target: Target, cx: &mut Context<Self>) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        let key = target.key();
        let chapters = match target {
            Target::Book => self.book.chapter_titles(),
            _ => Vec::new(),
        };
        let slot = self.pages.entry(key.clone()).or_insert_with(PageSlot::new);
        slot.loading = Some(Instant::now());
        let read_key = key.clone();
        slot._task = Some(cx.spawn(async move |this, cx| {
            let text = cx
                .background_executor()
                .spawn(async move { PageText::load(&lib, &target, &chapters) })
                .await;
            this.update(cx, |ws, cx| ws.page_loaded(&read_key, text, cx))
                .ok();
        }));
        // Past the loading delay, the pill shows it.
        slot._timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(motion::dwell::LOADING_DELAY)
                .await;
            this.update(cx, |_, cx| cx.notify()).ok();
        }));
    }

    fn page_loaded(
        &mut self,
        key: &str,
        text: dr_workspace::Result<PageText>,
        cx: &mut Context<Self>,
    ) {
        let Some(slot) = self.pages.get_mut(key) else {
            return;
        };
        slot.loading = None;
        slot._timer = None;
        match text {
            Ok(text) => slot.set(text),
            Err(error) => log::warn!("{key}: the page could not be read: {error}"),
        }
        slot._task = None;
        cx.notify();
    }

    /// Rows measured with other editor settings are measured again.
    fn fit_pages(&mut self, look: EditorLook) {
        for slot in self.pages.values_mut() {
            if slot.look != Some(look) {
                if slot.look.is_some() {
                    slot.list.remeasure();
                }
                slot.look = Some(look);
            }
        }
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

    /// Opens a location link (either form). Returns whether it named
    /// something in this book.
    pub fn open_link(&mut self, href: &str, _: &mut Window, cx: &mut Context<Self>) -> bool {
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

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
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
        }
    }

    /// Writes the layout into the settings file now, if it changed.
    pub fn store_layout(&mut self, cx: &mut Context<Self>) {
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

    /// Settings or a Super View covers the workspace: nothing under it
    /// answers the keyboard (the 0.1 client made it `inert`).
    pub fn covered(&self) -> bool {
        self.settings.is_some() || self.super_view.is_some()
    }

    /// The topmost open layer.
    pub fn top_layer(&self) -> Option<Layer> {
        if self.notifications_open {
            Some(Layer::Notifications)
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
            Some(Layer::Settings) => {
                self.settings = None;
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
        self.notifications_open = false;
        if self.settings.is_none() {
            let panel = cx.new(|cx| SettingsPanel::new(window, cx));
            cx.subscribe_in(&panel, window, |ws, _, event, window, cx| match event {
                crate::settings::panel::PanelEvent::Close => {
                    ws.settings = None;
                    ws.refocus(window, cx);
                }
            })
            .detach();
            panel.update(cx, |panel, cx| panel.focus(window, cx));
            self.settings = Some(panel);
        }
        cx.notify();
    }

    /// Immersive writing: the sidebars, the dock, the toggles and the
    /// corner go; only the paper stays (M26 adds fading the paragraphs
    /// around the caret and starting it by typing). Esc, ⌘⇧↩ or the incense
    /// stick in the corner bring them back.
    pub fn set_immersive(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.immersive != on {
            self.immersive = on;
            cx.notify();
        }
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
        .on_action(cx.listener(|ws, _: &Dismiss, window, cx| {
            if !ws.dismiss(window, cx) {
                cx.propagate();
            }
        }))
        // Each of these arrives with its module (F4e, M-timeline, the
        // immersive mode, the bookshelf). The shortcut is bound
        // already so the keymap and Settings → Keys are complete.
        .on_action(|_: &ToggleBottomTimeline, _, _| log::debug!("the timeline is not built yet"))
        .on_action(
            cx.listener(|ws, _: &ToggleImmersiveWriting, _, cx| {
                ws.set_immersive(!ws.immersive, cx)
            }),
        )
        .on_action(|_: &FindInEditor, _, _| log::debug!("find is not built yet"))
        .on_action(cx.listener(|ws, _: &GlobalSearch, window, cx| ws.toggle_search(window, cx)))
        .on_action(|_: &CloseProject, _, _| log::debug!("the bookshelf is not built yet"))
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
        let viewport = window.viewport_size();
        let window_w = f32::from(viewport.width);
        self.fit_sidebars(window_w, window, cx);
        self.ensure_pages(window, cx);
        self.fit_pages(EditorLook::read(cx));

        let immersive = self.immersive;
        let left = (!immersive).then(|| sidebar::left(self, window, cx));
        let right = (!immersive).then(|| sidebar::right(self, window, cx));
        let mid = stage::mid(self, window, cx);
        let row = div()
            .size_full()
            .flex()
            .flex_row()
            .children(left)
            .child(mid)
            .children(right);

        let root = div()
            .id("workspace")
            .key_context(keymap::WORKSPACE)
            .track_focus(&self.focus)
            .relative()
            .size_full()
            .bg(p.desk.solid())
            .text_color(p.ink(1).solid())
            .on_drag_move::<sidebar::ResizeDrag>(cx.listener(sidebar::on_resize))
            .child(row)
            .when(!immersive, |el| {
                el.child(chrome::sidebar_toggles(self, window, cx))
            })
            .when_some(self.super_view, |el, view| {
                el.child(super_view::stage(view, window, cx))
            })
            .when_some(self.settings.clone(), |el, panel| el.child(panel))
            .when_some(self.search.clone(), |el, panel| el.child(panel))
            .child(chrome::windows_caption(window, cx))
            .when(self.notifications_open, |el| {
                el.child(sidebar::notification_center(self, window, cx))
            });
        let root = self.on_actions(root, cx);
        glass::surface(Ground::flat(p.desk), root)
    }
}

impl Workspace {
    /// Keeps both sidebars inside the window and splits or joins their halves.
    fn fit_sidebars(&mut self, window_w: f32, window: &mut Window, cx: &mut Context<Self>) {
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
