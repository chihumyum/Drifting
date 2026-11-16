//! 全部项目's row of projects (author 2026-11-14; m01-shelf.md, 第五轮):
//! what drops from the top of a book's workspace when the button right of
//! the traffic lights is pressed, so another project is one click away
//! without going to 全部项目.
//!
//! - **Its head**: 「全部项目 ›」 on the left goes to 全部项目 (the page
//!   that was the bookshelf); 「新建项目」 and 「导入 ▾」 (a project file,
//!   Drifting 0.1) on the right.
//! - **One row of cards** that scrolls sideways: the open project first
//!   (the still selected glass), then the others by their last change.
//!   A card is its cover (the shelf's, smaller), its name and when it last
//!   changed. A click opens it.
//! - **A card held under the pointer opens sideways** (220 ms, as a hover
//!   card): its state, words, the last 30 days with 16 weeks of writing
//!   days, the target, storylines and elements; the cards after it make
//!   way. Pointing at another card moves the opening there at once; 260 ms
//!   after the pointer leaves the row it folds back. A card that would open
//!   past the row's edge scrolls into view, and the row takes no pointing
//!   until it has settled.
//!
//! The shell (`dr_shell::pages::set_projects`) mounts it at the window's
//! top: it comes down over the title row too, as one sheet, with the
//! traffic lights and the buttons beside them left on top. Esc, a press
//! below it, or the button again puts it away; it
//! reads the shelf's own data (`book.shelf`, M25's covers and writing days)
//! each time it drops.

use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_i18n::{
    keys,
    number::{compact, grouped},
};
use dr_shell::strings::{tf, tp};
use dr_shell::{Settings, Workspace, t};
use dr_ui::{
    Theme,
    anim::{self, Tween},
    components::{
        Menu, MenuItem, MenuWidth,
        overlay::{self, Align, Place},
    },
    fonts::{Role, weight},
    glass::{self, Kind as GlassKind, Mode, Spec, Tone},
    sand::{Icon, Readout},
    style::DrStyled,
    tokens::{Rgb, menu as m, motion, radius},
};
use dr_view_shelf_art::ShelfCover;
use dr_workspace::WsEvent;
use gpui::{
    AnyElement, App, AppContext as _, Bounds, Context, ElementId, Entity, Focusable as _,
    InteractiveElement, IntoElement, ParentElement, Pixels, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement, Styled, Task, WeakEntity, Window, div, prelude::FluentBuilder as _,
    px,
};

use crate::art::{self, ShelfArt};
use crate::data::{ShelfBook, ShelfData, Status, is_template_store_event, progress};
use crate::format;
use crate::templates::NewProjectModal;
use crate::view::{ImportBook, ImportLegacyLibrary};

/// The row's height: its head and one row of cards.
pub const ROW_H: f32 = 284.0;
/// The whole sheet: the window's title row (the traffic lights and the
/// buttons beside them stay on top of it), then the row. It comes down
/// from the window's top edge as one piece, so nothing of the page shows
/// above it.
pub const SHEET_H: f32 = dr_shell::workspace::TITLEBAR_HEIGHT + ROW_H;
/// A card's cover (126 × 226 on the shelf, scaled).
const COVER_W: f32 = 80.0;
const COVER_H: f32 = 143.0;
/// How far a card opens sideways.
const MORE_W: f32 = 196.0;
/// How long the pointer rests on a card before it opens (a hover card's).
const DWELL: Duration = Duration::from_millis(220);
/// How long after the pointer leaves the row the open card folds back.
const LEAVE: Duration = Duration::from_millis(260);
/// How long the row takes no pointing after scrolling a card into view.
const SETTLE: Duration = Duration::from_millis(450);
/// The writing days an open card shows: 16 weeks.
const DAYS: usize = 16 * 7;

pub struct Projects {
    jobs: crate::jobs::Jobs,
    ws: WeakEntity<Workspace>,
    /// The shelf as last read; `None` until the first read lands.
    data: Option<Rc<ShelfData>>,
    art: Option<Rc<ShelfArt>>,
    task: Option<Task<()>>,
    art_task: Option<Task<()>>,
    /// Which drop of the row this view has shown (the workspace counts).
    seen: u64,
    /// The row coming down (0 → 1).
    drop: Tween,
    /// The card opened sideways, and how far it is open (0 → 1).
    open: Option<String>,
    opening: Tween,
    dwell: Option<Task<()>>,
    leave: Option<Task<()>>,
    /// Pointing counts again from then (a card scrolled into view).
    settle_until: Option<Instant>,
    scroll: ScrollHandle,
    menu_open: bool,
    import_bounds: Entity<Option<Bounds<Pixels>>>,
    form: Option<Entity<NewProjectModal>>,
    _events: Option<dr_workspace::Subscription>,
    _store_events: Option<dr_store::LibrarySubscription>,
    stale: bool,
}

impl Projects {
    pub fn new(ws: WeakEntity<Workspace>, _: &mut Window, cx: &mut Context<Self>) -> Projects {
        let weak = cx.entity().downgrade();
        dr_shell::release::before_release(cx, move |cx| {
            weak.update(cx, |p, _| {
                p.task = None;
                p.art_task = None;
                p._events = None;
                p._store_events = None;
                p.jobs.drained()
            })
            .unwrap_or_else(|_| Box::pin(async { Ok(()) }))
        });
        Projects {
            jobs: Default::default(),
            ws,
            data: None,
            art: None,
            task: None,
            art_task: None,
            seen: 0,
            drop: Tween::still(1.0),
            open: None,
            opening: Tween::still(0.0),
            dwell: None,
            leave: None,
            settle_until: None,
            scroll: ScrollHandle::new(),
            menu_open: false,
            import_bounds: cx.new(|_| None),
            form: None,
            _events: None,
            _store_events: None,
            stale: true,
        }
    }

    pub fn data(&self) -> Option<&Rc<ShelfData>> {
        self.data.as_ref()
    }

    pub fn art(&self) -> Option<&Rc<ShelfArt>> {
        self.art.as_ref()
    }

    pub fn open_card(&self) -> Option<&str> {
        self.open.as_deref()
    }

    /// Opens `book`'s card immediately without animation (for tests).
    pub fn widen_immediately(&mut self, book: &str, cx: &mut Context<Self>) {
        self.drop = Tween::still(1.0);
        self.widen_now(book.to_owned(), true, cx);
    }

    fn library(&self, cx: &App) -> Option<dr_workspace::Workspace> {
        if dr_shell::release::is_releasing(cx) {
            return None;
        }
        self.ws.upgrade().and_then(|ws| ws.read(cx).library.clone())
    }

    /// The book the window has open.
    fn current(&self, cx: &App) -> String {
        self.ws
            .upgrade()
            .map(|ws| ws.read(cx).book_id.clone())
            .unwrap_or_default()
    }

    /// The row dropped again: down from the top, the shelf read afresh,
    /// nothing open.
    fn dropped(&mut self, window: &Window, cx: &mut Context<Self>) {
        let reduce = Theme::of(window, cx).reduce_motion;
        self.drop = Tween::still(0.0);
        self.drop
            .retarget_motion(1.0, anim::now(), motion::STRUCTURAL, reduce);
        self.open = None;
        self.opening = Tween::still(0.0);
        self.menu_open = false;
        self.form = None;
        self.scroll.set_offset(gpui::point(px(0.0), px(0.0)));
        self.listen(cx);
        self.stale = true;
    }

    /// F3's bus while the row is up: a book or saved template changed, came or went.
    fn listen(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.library(cx) else {
            return;
        };
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<()>();
        let tx_ws = tx.clone();
        self._events = Some(lib.subscribe(move |event| {
            let counts = match event {
                WsEvent::Book(_) | WsEvent::Stats(_) => true,
                WsEvent::Checkpoints(_) | WsEvent::Layout(_) => false,
                WsEvent::Removed(_) | WsEvent::Prose(_) => true,
                WsEvent::Local(change) => dr_workspace::is_text_index(change),
            };
            if counts {
                let _ = tx_ws.unbounded_send(());
            }
        }));
        self._store_events = Some(lib.library().subscribe(move |event| {
            if is_template_store_event(event) {
                let _ = tx.unbounded_send(());
            }
        }));
        cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                while rx.try_recv().is_ok() {}
                if this
                    .update(cx, |p, cx| {
                        p.stale = true;
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    /// Reads the shelf, then its covers and writing days, off the main
    /// thread.
    fn reload(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.library(cx) else {
            return;
        };
        if self.task.is_some() {
            return;
        }
        self.stale = false;
        let lib = self.jobs.enter(lib);
        self.task = Some(cx.spawn(async move |this, cx| {
            let data = cx
                .background_executor()
                .spawn(async move { ShelfData::load(&lib) })
                .await;
            this.update(cx, |p, cx| {
                p.task = None;
                match data {
                    Ok(data) => {
                        if let Some(modal) = &p.form {
                            let tpls = data.templates.clone();
                            modal.update(cx, |m, cx| m.set_templates(tpls, cx));
                        }
                        p.data = Some(Rc::new(data));
                        p.load_art(cx);
                    }
                    Err(error) => log::warn!("the projects could not be read: {error}"),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn load_art(&mut self, cx: &mut Context<Self>) {
        let (Some(lib), Some(data)) = (self.library(cx), self.data.clone()) else {
            return;
        };
        let books: Vec<(String, String)> = data
            .books
            .iter()
            .map(|b| (b.id.clone(), b.name.clone()))
            .collect();
        let today = art::today(cx);
        let lib = self.jobs.enter(lib);
        self.art_task = Some(cx.spawn(async move |this, cx| {
            let loaded = cx
                .background_executor()
                .spawn(async move { ShelfArt::load(&lib, &books, &today) })
                .await;
            this.update(cx, |p, cx| {
                p.art_task = None;
                p.art = Some(Rc::new(ShelfArt::from_loaded(loaded)));
                cx.notify();
            })
            .ok();
        }));
    }

    /// The cards in their order: the open project, then by last change.
    fn books(&self, cx: &App) -> Vec<ShelfBook> {
        let Some(data) = &self.data else {
            return Vec::new();
        };
        let current = self.current(cx);
        let mut books = data.books.clone();
        if let Some(i) = books.iter().position(|b| b.id == current) {
            let book = books.remove(i);
            books.insert(0, book);
        }
        books
    }

    // Opening a card sideways.

    fn settling(&self) -> bool {
        self.settle_until.is_some_and(|t| Instant::now() < t)
    }

    fn pointed(&mut self, book: &str, on: bool, window: &Window, cx: &mut Context<Self>) {
        if !on || self.settling() {
            return;
        }
        self.leave = None;
        if self.open.as_deref() == Some(book) {
            self.dwell = None;
            return;
        }
        let book = book.to_owned();
        if self.open.is_some() {
            self.widen(book, window, cx);
            return;
        }
        let reduce = Theme::of(window, cx).reduce_motion;
        self.dwell = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(DWELL).await;
            this.update(cx, |p, cx| {
                p.dwell = None;
                p.widen_now(book, reduce, cx);
            })
            .ok();
        }));
    }

    fn widen(&mut self, book: String, window: &Window, cx: &mut Context<Self>) {
        let reduce = Theme::of(window, cx).reduce_motion;
        self.widen_now(book, reduce, cx);
    }

    fn widen_now(&mut self, book: String, reduce: bool, cx: &mut Context<Self>) {
        self.dwell = None;
        let index = self.books(cx).iter().position(|b| b.id == book);
        self.open = Some(book);
        self.opening = Tween::still(0.0);
        self.opening
            .retarget_motion(1.0, anim::now(), motion::STRUCTURAL, reduce);
        if let Some(index) = index {
            // Keeps the opened card in view; the row is still while it
            // scrolls, so a card sliding under the pointer does not open.
            self.scroll.scroll_to_item(index);
            self.settle_until = Some(Instant::now() + SETTLE);
        }
        cx.notify();
    }

    fn row_left(&mut self, cx: &mut Context<Self>) {
        self.dwell = None;
        if self.open.is_none() {
            return;
        }
        self.leave = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(LEAVE).await;
            this.update(cx, |p, cx| {
                p.leave = None;
                p.open = None;
                cx.notify();
            })
            .ok();
        }));
    }

    // Acting.

    fn open_book(&mut self, book: &str, window: &mut Window, cx: &mut Context<Self>) {
        let book = book.to_owned();
        self.ws
            .update(cx, |ws, cx| ws.open_book(&book, window, cx))
            .ok();
    }

    fn go_to_all_projects(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.ws
            .update(cx, |ws, cx| {
                ws.show_shelf(window, cx);
            })
            .ok();
    }

    fn put_away(&mut self, cx: &mut Context<Self>) {
        self.ws
            .update(cx, |ws, cx| {
                ws.projects_open = false;
                cx.notify();
            })
            .ok();
    }

    /// 「新建项目」: the same dialog as on 全部项目, holding the keyboard the
    /// same way (the open book's prose under it takes nothing; ↩ and ⌘↵
    /// create; Esc closes the dialog and leaves the row down). Closing it
    /// gives the keyboard back to where it was.
    fn start_create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.menu_open = false;
        let my_templates = self
            .data
            .as_ref()
            .map(|d| d.templates.clone())
            .unwrap_or_default();
        let jobs = self.jobs.clone();
        let ws = self.ws.clone();
        let created_this = cx.weak_entity();
        let closed_this = cx.weak_entity();
        let back = window.focused(cx).or_else(|| {
            self.ws
                .upgrade()
                .map(|ws| ws.read(cx).focus_handle().clone())
        });
        let modal = cx.new(|cx| {
            NewProjectModal::new(
                jobs,
                ws,
                my_templates,
                move |id, window, cx| {
                    let _ = created_this.update(cx, |p, cx| {
                        p.form = None;
                        p.open_book(&id, window, cx);
                        cx.notify();
                    });
                },
                move |window, cx| {
                    if let Some(back) = &back {
                        back.focus(window, cx);
                    }
                    let _ = closed_this.update(cx, |p, cx| {
                        p.form = None;
                        cx.notify();
                    });
                },
                cx,
            )
        });
        modal.focus_handle(cx).focus(window, cx);
        self.form = Some(modal);
        cx.notify();
    }

    /// The open 「新建项目」 dialog, for tests.
    pub fn new_project_dialog(&self) -> Option<Entity<NewProjectModal>> {
        self.form.clone()
    }

    fn import(&mut self, legacy: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.menu_open = false;
        self.put_away(cx);
        if legacy {
            window.dispatch_action(Box::new(ImportLegacyLibrary), cx);
        } else {
            window.dispatch_action(Box::new(ImportBook), cx);
        }
    }
}

impl Render for Projects {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let shown = self
            .ws
            .upgrade()
            .map(|ws| ws.read(cx).projects_dropped)
            .unwrap_or(0);
        if shown != self.seen {
            self.seen = shown;
            self.dropped(window, cx);
        }
        if self.stale && self.task.is_none() {
            self.reload(cx);
        }
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let now = anim::now();
        let down = self.drop.value(now);
        let opening = self.opening.value(now);
        anim::keep_going(
            !self.drop.settled(now) || !self.opening.settled(now),
            window,
        );

        let head = head(self, window, cx);
        let books = self.books(cx);
        let current = self.current(cx);
        let entity = cx.entity();
        let mut row = div()
            .id("projects-row")
            .track_scroll(&self.scroll)
            .flex_1()
            .min_h_0()
            .flex()
            .flex_row()
            .items_start()
            .gap(px(14.0))
            .px(px(18.0))
            .pt(px(2.0))
            .pb(px(14.0))
            .overflow_x_scroll()
            .on_hover(move |on: &bool, _, cx| {
                if !*on {
                    entity.update(cx, |p, cx| p.row_left(cx));
                }
            });
        for book in books {
            let wide = self.open.as_deref() == Some(book.id.as_str());
            row = row.child(card(
                self,
                book.clone(),
                book.id == current,
                if wide { opening } else { 0.0 },
                window,
                cx,
            ));
        }
        let body = div()
            .relative()
            .top(px(-(1.0 - down) * SHEET_H))
            .h(px(SHEET_H))
            .w_full()
            .flex()
            .flex_col()
            .bg(p.desk.solid())
            .border_b(px(0.5))
            .border_color(p.hairline())
            .child(
                div()
                    .flex_none()
                    .h(px(dr_shell::workspace::TITLEBAR_HEIGHT)),
            )
            .child(head)
            .child(row);
        let menu = self.menu_open.then(|| import_menu(self, window, cx));
        let form = self.form.clone();
        div()
            .id("projects")
            .w_full()
            .h(px(SHEET_H))
            .overflow_hidden()
            .occlude()
            .shadow(dr_ui::components::menu::float_shadow(p))
            .child(body)
            .children(menu)
            .children(form)
    }
}

/// 「全部项目 ›」, and 「新建项目」「导入 ▾」.
fn head(projects: &Projects, window: &mut Window, cx: &mut Context<Projects>) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let entity = cx.entity();
    let link = |id: &'static str, selected: bool, window: &mut Window, cx: &mut App| {
        glass::glass_box(
            id,
            GlassKind::Hidden,
            Mode::default(),
            selected,
            Spec::new(Tone::Clear, radius::MENU_ROW),
            window,
            cx,
        )
        .h(px(28.0))
        .px(px(8.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .rounded(px(radius::MENU_ROW))
        .cursor_pointer()
        .role(gpui::Role::Button)
        .font_role(Role::Ui)
        .type_px(s.secondary, s.line_body)
        .text_color(p.ink(2).solid())
    };
    let all = {
        let entity = entity.clone();
        link("projects-all", false, window, cx)
            .weight(weight::MEDIUM)
            .aria_label(t(cx, keys::all_projects::TITLE))
            .on_click(move |_, window, cx| {
                entity.update(cx, |p, cx| p.go_to_all_projects(window, cx))
            })
            .child(t(cx, keys::all_projects::TITLE))
            .child(dr_ui::sand::icon(
                Icon::ChevronRight,
                12.0,
                p.ink(3).solid(),
            ))
    };
    let new = {
        let entity = entity.clone();
        link("projects-new", projects.form.is_some(), window, cx)
            .debug_selector(|| "projects-new".into())
            .aria_label(t(cx, keys::all_projects::NEW_PROJECT))
            .on_click(move |_, window, cx| entity.update(cx, |p, cx| p.start_create(window, cx)))
            .child(dr_ui::sand::icon(Icon::Plus, 14.0, p.ink(3).solid()))
            .child(t(cx, keys::all_projects::NEW_PROJECT))
    };
    let import = {
        let entity = entity.clone();
        link("projects-import", projects.menu_open, window, cx)
            .aria_label(t(cx, keys::user_menu::IMPORT))
            .on_click(move |_, _, cx| {
                entity.update(cx, |p, cx| {
                    p.menu_open = !p.menu_open;
                    cx.notify();
                })
            })
            .child(overlay::probe(projects.import_bounds.clone()))
            .child(dr_ui::sand::icon(Icon::ArrowIn, 14.0, p.ink(3).solid()))
            .child(t(cx, keys::user_menu::IMPORT))
            .child(dr_ui::sand::icon(Icon::ChevronDown, 11.0, p.ink(3).solid()))
    };
    div()
        .flex_none()
        .h(px(42.0))
        .px(px(12.0))
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .child(all)
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .child(new)
                .child(import),
        )
        .into_any_element()
}

/// One project: its cover, name and last change; opened sideways, the rest.
fn card(
    projects: &Projects,
    book: ShelfBook,
    current: bool,
    open: f32,
    window: &mut Window,
    cx: &mut Context<Projects>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let now = format::now_ms();
    let title: SharedString = if book.name.trim().is_empty() {
        t(cx, keys::project_picker::desk::UNTITLED)
    } else {
        book.name.clone().into()
    };
    let entity = cx.entity();
    let id = book.id.clone();
    let cover = div()
        .flex_none()
        .w(px(COVER_W))
        .h(px(COVER_H))
        .rounded(px(2.0))
        .overflow_hidden()
        .bg(p.page.solid())
        .when_some(
            projects.art.as_ref().and_then(|a| a.books.get(&book.id)),
            |el, drawn| {
                el.child(
                    ShelfCover::new(
                        ElementId::Name(format!("projects-cover-{}", book.id).into()),
                        book.id.clone(),
                        art::cover_style(cx),
                        drawn.cover.clone(),
                    )
                    .size(COVER_W, COVER_H),
                )
            },
        );
    let lead = if book.has_book {
        div()
            .flex_none()
            .w(px(COVER_W))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(cover)
            .child(
                div()
                    .h(px(40.0))
                    .font_role(Role::Ui)
                    .type_px(s.secondary, 20.0)
                    .text_color(p.ink(1).solid())
                    .line_clamp(2)
                    .child(dr_ui::text::wrapped(title.clone())),
            )
            .child(
                div()
                    .mt(px(-6.0))
                    .font_role(Role::Index)
                    .type_px(13.0, 16.0)
                    .text_color(p.ink(4).solid())
                    .whitespace_nowrap()
                    .children(book.edited_ms.map(|at| format::ago(at, now, cx))),
            )
    } else {
        let locale = Settings::locale(cx);
        let book_id = book.id.clone();
        div()
            .flex_none()
            .w(px(COVER_W))
            .flex()
            .flex_col()
            .gap(px(4.0))
            .child(cover)
            .child(
                div()
                    .mt(px(4.0))
                    .h(px(20.0))
                    .font_role(Role::Ui)
                    .type_px(s.secondary, 20.0)
                    .text_color(p.ink(1).solid())
                    .line_clamp(1)
                    .child(dr_ui::text::wrapped(title.clone())),
            )
            .child(
                div()
                    .id(ElementId::Name(
                        format!("projects-entry-count-{}", book.id).into(),
                    ))
                    .debug_selector(move || format!("projects-entry-count-{book_id}"))
                    .font_role(Role::Index)
                    .type_px(12.0, 15.0)
                    .text_color(p.ink(3).solid())
                    .whitespace_nowrap()
                    .child(tp(
                        cx,
                        keys::k4_book::ENTRY_COUNT,
                        book.entry_count as u64,
                        &[("count", &grouped(book.entry_count as u64, locale))],
                    )),
            )
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(12.0, 15.0)
                    .text_color(p.ink(4).solid())
                    .whitespace_nowrap()
                    .children(book.edited_ms.map(|at| format::ago(at, now, cx))),
            )
    };
    let more = (open > 0.0).then(|| {
        div()
            .flex_none()
            .w(px(MORE_W * open))
            .overflow_hidden()
            .child(more(projects, &book, open, window, cx))
    });
    let enter = entity.clone();
    let pointed_id = book.id.clone();
    let glass = glass::glass_box(
        ElementId::Name(format!("projects-card-{}", book.id).into()),
        GlassKind::Hidden,
        Mode::default(),
        current || open > 0.0,
        Spec::new(Tone::Clear, radius::SM),
        window,
        cx,
    )
    .flex_none()
    .p(px(6.0))
    .flex()
    .flex_row()
    .cursor_pointer()
    .role(gpui::Role::Button)
    .aria_label(tf(
        cx,
        keys::project_picker::desk::OPEN,
        &[("name", &title)],
    ))
    .debug_selector({
        let id = book.id.clone();
        move || format!("projects-card-{id}")
    })
    .on_click(move |_, window, cx| entity.update(cx, |p, cx| p.open_book(&id, window, cx)))
    .child(lead)
    .children(more);
    // The glass keeps its own hover; the opening follows the pointer here.
    div()
        .id(ElementId::Name(
            format!("projects-card-place-{}", book.id).into(),
        ))
        .flex_none()
        .on_hover(move |on: &bool, window, cx| {
            let book = pointed_id.clone();
            enter.update(cx, |p, cx| p.pointed(&book, *on, window, cx))
        })
        .child(glass)
        .into_any_element()
}

/// A card's figures, as the shelf card has them, and its last 16 weeks (or
/// its entry count and recently modified entries when `成书` is off).
fn more(
    projects: &Projects,
    book: &ShelfBook,
    open: f32,
    window: &mut Window,
    cx: &mut Context<Projects>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let locale = Settings::locale(cx);
    let now = format::now_ms();
    let (status_key, status_ink) = match Status::of(book.edited_ms, now) {
        Status::Writing => (keys::project_picker::status::WRITING, p.ink(2)),
        Status::Draft => (keys::project_picker::status::DRAFT, p.ink(3)),
        Status::Paused => (keys::project_picker::status::PAUSED, p.ink(4)),
    };
    let index = |text: SharedString, ink: Rgb| {
        div()
            .font_role(Role::Index)
            .type_px(13.0, 16.0)
            .text_color(ink.solid())
            .whitespace_nowrap()
            .child(text)
    };
    if !book.has_book {
        let recent_list = (!book.recent_entries.is_empty()).then(|| {
            let book_id = book.id.clone();
            let mut rows = div()
                .id(ElementId::Name(
                    format!("projects-recent-entries-{}", book.id).into(),
                ))
                .debug_selector(move || format!("projects-recent-entries-{book_id}"))
                .mt(px(2.0))
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(index(t(cx, keys::all_projects::RECENT_ENTRIES), p.ink(4)));
            for item in &book.recent_entries {
                let entry_title: SharedString = if item.title.trim().is_empty() {
                    t(cx, keys::k4_book::UNTITLED_ENTRY)
                } else {
                    item.title.clone().into()
                };
                rows = rows.child(
                    div()
                        .flex()
                        .flex_row()
                        .items_baseline()
                        .justify_between()
                        .gap(px(8.0))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .font_role(Role::Ui)
                                .type_px(s.caption, s.caption * 1.35)
                                .text_color(p.ink(2).solid())
                                .truncate()
                                .child(entry_title),
                        )
                        .when_some(item.edited_ms, |el, at| {
                            el.child(
                                div()
                                    .flex_none()
                                    .font_role(Role::Index)
                                    .type_px(11.0, 14.0)
                                    .text_color(p.ink(4).solid())
                                    .child(format::ago(at, now, cx)),
                            )
                        }),
                );
            }
            rows
        });
        return div()
            .w(px(MORE_W))
            .pl(px(14.0))
            .pr(px(4.0))
            .pt(px(2.0))
            .flex()
            .flex_col()
            .gap(px(7.0))
            .opacity(((open - 0.3) / 0.7).clamp(0.0, 1.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .gap(px(8.0))
                    .child(index(t(cx, status_key), status_ink))
                    .children(
                        book.edited_ms
                            .map(|at| index(format::ago(at, now, cx), p.ink(4))),
                    ),
            )
            .child(
                div()
                    .font_role(Role::Prose)
                    .type_px(19.0, 23.0)
                    .text_color(p.ink(1).solid())
                    .child(tp(
                        cx,
                        keys::k4_book::ENTRY_COUNT,
                        book.entry_count as u64,
                        &[("count", &grouped(book.entry_count as u64, locale))],
                    )),
            )
            .children(recent_list)
            .into_any_element();
    }
    let pair = |label: SharedString, value: SharedString| {
        div()
            .flex()
            .flex_row()
            .justify_between()
            .gap(px(8.0))
            .child(index(label, p.ink(4)))
            .child(index(value, p.ink(2)))
    };
    let words = book
        .words
        .map(|n| compact(n, locale))
        .unwrap_or_else(|| t(cx, keys::workspace_word_tally::COUNTING).to_string());
    let recent = projects
        .art
        .as_ref()
        .map(|a| a.year.recent(&book.id, DAYS))
        .unwrap_or_default();
    let last30: u64 = recent.iter().rev().take(30).sum();
    let unit = t(cx, keys::project_picker::desk::WORDS_UNIT);
    let progress_row = book
        .words
        .and_then(|w| progress(w, book.word_target))
        .map(|value| {
            let target = book.word_target.unwrap_or(0).max(0) as u64;
            let book_id = book.id.clone();
            div()
                .id(ElementId::Name(
                    format!("projects-progress-wrap-{}", book.id).into(),
                ))
                .debug_selector(move || format!("projects-progress-wrap-{book_id}"))
                .flex()
                .flex_col()
                .gap(px(5.0))
                .child(index(
                    tf(
                        cx,
                        keys::project_picker::desk::GOAL,
                        &[
                            ("pct", &((value * 100.0).round() as u32)),
                            ("target", &compact(target, locale)),
                        ],
                    ),
                    p.ink(3),
                ))
                .child(
                    Readout::new(
                        ElementId::Name(format!("projects-progress-{}", book.id).into()),
                        value,
                    )
                    .color(p.ink(2)),
                )
        });
    let counts = format!(
        "{} {} · {} {}",
        grouped(book.storylines as u64, locale),
        tp(
            cx,
            keys::project_picker::desk::STORYLINES_UNIT,
            book.storylines as u64,
            &[]
        ),
        grouped(book.elements as u64, locale),
        tp(
            cx,
            keys::project_picker::desk::ELEMENTS_UNIT,
            book.elements as u64,
            &[]
        ),
    );
    let words_id = book.id.clone();
    let heat_id = book.id.clone();
    div()
        .w(px(MORE_W))
        .pl(px(14.0))
        .pr(px(4.0))
        .pt(px(2.0))
        .flex()
        .flex_col()
        .gap(px(7.0))
        .opacity(((open - 0.3) / 0.7).clamp(0.0, 1.0))
        .child(index(t(cx, status_key), status_ink))
        .child(
            div()
                .id(ElementId::Name(
                    format!("projects-words-{}", book.id).into(),
                ))
                .debug_selector(move || format!("projects-words-{words_id}"))
                .flex()
                .flex_row()
                .items_baseline()
                .gap(px(4.0))
                .child(
                    div()
                        .font_role(Role::Prose)
                        .type_px(22.0, 26.0)
                        .text_color(p.ink(1).solid())
                        .child(words),
                )
                .child(index(unit.clone(), p.ink(4))),
        )
        .child(pair(
            t(cx, keys::project_picker::desk::RECENT),
            if last30 > 0 {
                format!("+{} {unit}", grouped(last30, locale)).into()
            } else {
                "—".into()
            },
        ))
        .child(
            div()
                .id(ElementId::Name(format!("projects-heat-{}", book.id).into()))
                .debug_selector(move || format!("projects-heat-{heat_id}"))
                .child(heat(&recent, art::book_color(&book.id, p), p)),
        )
        .children(progress_row)
        .child(index(counts.into(), p.ink(4)))
        .into_any_element()
}

/// The last 16 weeks of writing days: a dot of the book's colour where
/// there were words (deeper for more), a speck of ink where there were none.
fn heat(days: &[u64], color: Rgb, p: &dr_ui::tokens::color::Palette) -> AnyElement {
    let max = days.iter().copied().max().unwrap_or(0).max(1) as f32;
    let start = days.len().saturating_sub(DAYS);
    let days = &days[start..];
    let mut grid = div().flex().flex_row().gap(px(2.0));
    for week in days.chunks(7) {
        let mut column = div().flex().flex_col().gap(px(2.0));
        for &words in week {
            column = column.child(if words > 0 {
                let strength = 0.3 + 0.6 * (words as f32 / max).sqrt();
                div()
                    .size(px(6.0))
                    .rounded(px(1.5))
                    .bg(p.sand_on(color, p.desk).alpha(strength * p.pigment))
            } else {
                div()
                    .size(px(6.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(div().size(px(2.0)).rounded_full().bg(p.ink(6).solid()))
            });
        }
        grid = grid.child(column);
    }
    grid.into_any_element()
}

/// 「导入 ▾」's menu: a project file, or a Drifting 0.1 library.
fn import_menu(projects: &Projects, window: &mut Window, cx: &mut Context<Projects>) -> AnyElement {
    let _ = window;
    let anchor = *projects.import_bounds.read(cx);
    let entity = cx.entity();
    let pick = move |legacy: bool| {
        let entity = entity.clone();
        move |_: &gpui::ClickEvent, window: &mut Window, cx: &mut App| {
            entity.update(cx, |p, cx| p.import(legacy, window, cx))
        }
    };
    let menu = Menu::new("projects-import-menu")
        .width(MenuWidth::Wide)
        .item(
            MenuItem::new(
                "projects-import-file",
                Icon::ArrowIn,
                t(cx, keys::all_projects::IMPORT_FILE),
            )
            .on_click(pick(false)),
        )
        .item(
            MenuItem::new(
                "projects-import-legacy",
                Icon::GateIn,
                t(cx, keys::all_projects::IMPORT_LEGACY),
            )
            .on_click(pick(true)),
        );
    let place = match anchor {
        Some(rect) => Place::Rect {
            rect,
            align: Align::End,
            gap: m::HOVER_CARD_GAP,
        },
        None => Place::Center,
    };
    overlay::float_in_dialog(place, menu).into_any_element()
}
