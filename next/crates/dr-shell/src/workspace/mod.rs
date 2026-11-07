//! The workspace window: three columns from the top edge to the bottom
//! (docs/design-system/workspace.md), the tab dock on the paper's top edge,
//! the Super View stage and Settings over everything.
//!
//! [`Workspace`] owns the navigation model, both sidebars and which layers
//! are open. Everything on screen is read from that state each frame; no
//! view keeps a second copy of "what is open".

mod chrome;
mod dock;
mod panel_tabs;
mod sidebar;
mod stage;
mod super_view;

use std::rc::Rc;
use std::time::Duration;

use dr_ui::{
    Theme,
    anim::Tween,
    glass::{self, Ground},
    tokens::motion,
};
use gpui::{
    App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable, InteractiveElement,
    IntoElement, ParentElement, Render, Size, Styled, Subscription, Task, TitlebarOptions, Window,
    WindowBounds, WindowOptions, div, prelude::FluentBuilder as _, px, size,
};
use serde::{Deserialize, Serialize};

use crate::actions::{
    CloseActiveTab, CloseProject, Dismiss, FindInEditor, GlobalSearch, GoBack, GoForward,
    NewEntity, NextTab, OpenSettings, PreviousTab, ShowProjectHome, ShowWholeBook,
    ToggleBottomTimeline, ToggleElementOverview, ToggleImmersiveWriting, ToggleLeftSidebar,
    ToggleNotifications, ToggleReviewMaterials, ToggleRightSidebar, ToggleStoryGraph,
};
use crate::nav::{self, Navigator, Open, Target, location};
use crate::notifications::{self, Notifications};
use crate::panes::{self, Panes};
use crate::settings::panel::SettingsPanel;
use crate::stand_in::StandIn;
use crate::{Services, Settings, ShellInfo, keymap, menus};

pub use chrome::{LEADING_INSET, TITLEBAR_HEIGHT, TRAFFIC_LIGHT_POSITION};
pub use dock::DockDrag;
pub use sidebar::{LeftTab, RightTab};
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
}

/// What the Escape key closes, topmost first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layer {
    Notifications,
    Settings,
    SuperView,
}

pub struct Workspace {
    focus: FocusHandle,
    pub book: Rc<StandIn>,
    pub nav: Navigator,
    pub left: Sidebar<LeftTab>,
    pub right: Sidebar<RightTab>,
    pub dock_locked: bool,
    pub dock_hovered: bool,
    dock_collapse: Option<Task<()>>,
    pub super_view: Option<SuperView>,
    pub settings: Option<Entity<SettingsPanel>>,
    pub notifications_open: bool,
    /// A left press on a drag region that has not moved yet (macOS).
    drag_armed: bool,
    /// The layout changed since it was last stored.
    layout_dirty: bool,
    layout_save: Option<Task<()>>,
    _observers: Vec<Subscription>,
}

/// How long the dock stays open after the pointer leaves it (the 0.1
/// client's `DOCK_COLLAPSE_DELAY_MS`).
pub const DOCK_COLLAPSE_DELAY: Duration = Duration::from_millis(260);
/// How long after a layout change it is written to the settings file.
pub const LAYOUT_SAVE_DELAY: Duration = Duration::from_millis(500);

impl Workspace {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        let book = Rc::new(StandIn::sample());
        let saved: Option<BookLayout> = Settings::read(cx)
            .layout(book.book_id)
            .and_then(|v| serde_json::from_value(v.clone()).ok());
        let (nav, left, right, dock_locked) = match saved {
            Some(l) => (
                Navigator::restored(l.nav, |t| book.exists(t)),
                Some(l.left),
                Some(l.right),
                l.dock_locked,
            ),
            None => (Navigator::default(), None, None, false),
        };
        let observers = vec![
            cx.observe_window_appearance(window, |_, _, cx| cx.notify()),
            cx.observe_global::<Settings>(|_, cx| cx.notify()),
            cx.observe_global::<Notifications>(|_, cx| cx.notify()),
        ];
        let mut ws = Workspace {
            focus,
            book,
            nav,
            left: Sidebar::new(left, LeftTab::Chapters, |_| true),
            right: Sidebar::new(right, RightTab::Review, |_| true),
            dock_locked,
            dock_hovered: false,
            dock_collapse: None,
            super_view: None,
            settings: None,
            notifications_open: false,
            drag_armed: false,
            layout_dirty: false,
            layout_save: None,
            _observers: observers,
        };
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
        match location::resolve(&link, self.book.as_ref()) {
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
        }
    }

    /// Writes the layout into the settings file now, if it changed.
    pub fn store_layout(&mut self, cx: &mut Context<Self>) {
        if !self.layout_dirty {
            return;
        }
        self.layout_dirty = false;
        self.layout_save = None;
        let Ok(value) = serde_json::to_value(self.layout()) else {
            return;
        };
        let book = self.book.book_id;
        Settings::update(cx, |file| file.set_layout(book, value));
    }

    fn reduce_motion(&self, window: &Window, cx: &App) -> bool {
        Theme::of(window, cx).reduce_motion
    }

    // Navigation.

    pub fn open(&mut self, target: Target, how: Open, cx: &mut Context<Self>) {
        self.nav.open(target, how);
        self.changed(cx);
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

    /// Esc: closes the topmost layer. Returns whether one was open.
    pub fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        match self.top_layer() {
            Some(Layer::Notifications) => self.notifications_open = false,
            Some(Layer::Settings) => {
                self.settings = None;
                self.focus.focus(window, cx);
            }
            Some(Layer::SuperView) => self.super_view = None,
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
                    ws.focus.focus(window, cx);
                    cx.notify();
                }
            })
            .detach();
            panel.update(cx, |panel, cx| panel.focus(window, cx));
            self.settings = Some(panel);
        }
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

    fn hover_dock(&mut self, hovered: bool, cx: &mut Context<Self>) {
        if hovered {
            self.dock_collapse = None;
            if !self.dock_hovered {
                self.dock_hovered = true;
                cx.notify();
            }
            return;
        }
        if !self.dock_hovered || self.dock_collapse.is_some() {
            return;
        }
        self.dock_collapse = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(DOCK_COLLAPSE_DELAY).await;
            this.update(cx, |ws, cx| {
                ws.dock_hovered = false;
                ws.dock_collapse = None;
                cx.notify();
            })
            .ok();
        }));
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
        // immersive mode, search, the bookshelf). The shortcut is bound
        // already so the keymap and Settings → Keys are complete.
        .on_action(|_: &ToggleBottomTimeline, _, _| log::debug!("the timeline is not built yet"))
        .on_action(|_: &ToggleImmersiveWriting, _, _| {
            log::debug!("immersive writing is not built yet")
        })
        .on_action(|_: &FindInEditor, _, _| log::debug!("find is not built yet"))
        .on_action(|_: &GlobalSearch, _, _| log::debug!("search is not built yet"))
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

        let left = sidebar::left(self, window, cx);
        let right = sidebar::right(self, window, cx);
        let mid = stage::mid(self, window, cx);
        let row = div()
            .size_full()
            .flex()
            .flex_row()
            .child(left)
            .child(mid)
            .child(right);

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
            .child(chrome::sidebar_toggles(self, window, cx))
            .when_some(self.super_view, |el, view| {
                el.child(super_view::stage(view, window, cx))
            })
            .when_some(self.settings.clone(), |el, panel| el.child(panel))
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
pub fn title_of(book: &StandIn, target: &Target, cx: &App) -> gpui::SharedString {
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
        Some(title) => gpui::SharedString::new_static(title),
        None => crate::t(cx, untitled),
    }
}
