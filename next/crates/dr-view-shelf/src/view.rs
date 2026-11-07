//! The bookshelf view: the rail, the books, the dialogs.

use std::rc::Rc;
use std::time::Instant;

use dr_i18n::keys;
use dr_shell::actions::{Dismiss, ToggleNotifications};
use dr_shell::strings::{tf, tp};
use dr_shell::{Services, Settings, Workspace, t};
use dr_ui::{
    Theme,
    components::{
        Button, Dialog, IconButton, PanelIconButton,
        overlay::{self},
    },
    fonts::Role,
    glass::{self, Ground, Kind as GlassKind, Mode, Spec, Tone},
    input::field::{FieldEvent, TextField},
    sand::{Icon, Readout},
    style::DrStyled,
    tokens::radius,
};
use dr_workspace::{
    Actor, Workspace as Library, WsEvent,
    commands::{
        BookIn,
        book::{BookCreate, BookCreateIn, BookRestore, BookTrash, BookUpdate, BookUpdateIn},
    },
};
use gpui::{
    AnyElement, App, AppContext as _, Bounds, ClickEvent, Context, ElementId, Entity, FocusHandle,
    Focusable, InteractiveElement, IntoElement, ParentElement, Pixels, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Task, WeakEntity, Window, actions, div,
    prelude::FluentBuilder as _, px,
};

use crate::data::{ShelfBook, ShelfData, Status, progress};
use crate::format::{self, compact, grouped};

actions!(
    shelf,
    [
        /// Imports a `.driftingbook` (M41 handles it; the bookshelf only has
        /// the entry).
        ImportBook,
        /// Imports a Drifting 0.1 library (M10 handles it; the bookshelf
        /// only has the entry).
        ImportLegacyLibrary,
        /// Creates or saves the book in the open form (⌘↵ / Ctrl+↵, as in
        /// the 0.1 client; Enter in a field does it too).
        SubmitDialog,
    ]
);

/// The rail's width (`.pp__frame`'s first column).
const RAIL_W: f32 = 232.0;
/// The books' column: at most this wide (`.pp__frame > .pp__inner`).
const BOOKS_MAX_W: f32 = 1180.0;
/// Below this window width the books stand in one column.
const ONE_COLUMN_BELOW: f32 = 1080.0;
/// A card's least height (`.pp-card` with its cover is 250px; without the
/// cover, which is M25, the body sets it).
const CARD_MIN_H: f32 = 196.0;

/// Which dialog is open, for tests and the debug bridge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShelfDialog {
    Create,
    Edit(String),
    Trash(String),
    RecentlyDeleted,
}

enum DialogState {
    Form {
        /// `None`: a new book.
        editing: Option<ShelfBook>,
        name: Entity<TextField>,
        summary: Entity<TextField>,
    },
    Trash {
        book: ShelfBook,
    },
    Deleted,
}

pub struct Shelf {
    ws: WeakEntity<Workspace>,
    lib: Option<Library>,
    focus: FocusHandle,
    /// The shelf as last read; `None` until the first read lands.
    pub data: Option<Rc<ShelfData>>,
    task: Option<Task<()>>,
    /// Something changed since the last read.
    stale: bool,
    dialog: Option<DialogState>,
    /// A write of the open dialog is running.
    busy: bool,
    /// What went wrong with the dialog's last write.
    error: Option<dr_i18n::Key>,
    menu_open: bool,
    /// Where the bell and the account cell were laid out (the notification
    /// center and the account menu open from them).
    bell: Entity<Option<Bounds<Pixels>>>,
    account: Entity<Option<Bounds<Pixels>>>,
    made: Instant,
    /// When the cards were first drawn, ms after the shelf was made.
    pub cards_ms: Option<f64>,
    _events: Option<dr_workspace::Subscription>,
    _fields: Vec<Subscription>,
}

impl Shelf {
    pub fn new(ws: WeakEntity<Workspace>, _: &mut Window, cx: &mut Context<Self>) -> Shelf {
        let lib = cx.try_global::<Services>().and_then(|s| s.library.clone());
        let mut shelf = Shelf {
            ws,
            lib,
            focus: cx.focus_handle(),
            data: None,
            task: None,
            stale: true,
            dialog: None,
            busy: false,
            error: None,
            menu_open: false,
            bell: cx.new(|_| None),
            account: cx.new(|_| None),
            made: Instant::now(),
            cards_ms: None,
            _events: None,
            _fields: Vec::new(),
        };
        shelf.listen(cx);
        shelf.reload(cx);
        shelf
    }

    /// The bell's bounds cell, for the shell's notification center.
    pub fn bell(&self) -> Entity<Option<Bounds<Pixels>>> {
        self.bell.clone()
    }

    pub fn dialog(&self) -> Option<ShelfDialog> {
        Some(match self.dialog.as_ref()? {
            DialogState::Form { editing: None, .. } => ShelfDialog::Create,
            DialogState::Form {
                editing: Some(b), ..
            } => ShelfDialog::Edit(b.id.clone()),
            DialogState::Trash { book } => ShelfDialog::Trash(book.id.clone()),
            DialogState::Deleted => ShelfDialog::RecentlyDeleted,
        })
    }

    /// The dialog's name and summary fields, for tests.
    pub fn form_fields(&self) -> Option<(Entity<TextField>, Entity<TextField>)> {
        match self.dialog.as_ref()? {
            DialogState::Form { name, summary, .. } => Some((name.clone(), summary.clone())),
            _ => None,
        }
    }

    pub fn menu_open(&self) -> bool {
        self.menu_open
    }

    /// Whether the window shows the bookshelf now.
    fn shown(&self, cx: &App) -> bool {
        self.ws.upgrade().is_some_and(|ws| ws.read(cx).shelf_open)
    }

    // Reading.

    /// F3's bus: a book changed, came or went, its prose changed (the last
    /// edit) or a document's derived index was written (the words; right
    /// after an import or seeding the index is built in the background).
    /// The shelf reads again when it next shows.
    fn listen(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<()>();
        self._events = Some(lib.subscribe(move |event| {
            let counts = match event {
                WsEvent::Book(_) | WsEvent::Removed(_) | WsEvent::Prose(_) => true,
                WsEvent::Local(change) => change.table == "index",
            };
            if counts {
                let _ = tx.unbounded_send(());
            }
        }));
        cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                while rx.try_recv().is_ok() {}
                let alive = this.update(cx, |shelf, cx| {
                    shelf.stale = true;
                    if shelf.shown(cx) {
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    /// Reads the shelf off the main thread (again after, if it changed
    /// meanwhile).
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            self.stale = false;
            self.data = Some(Rc::new(ShelfData::default()));
            return;
        };
        if self.task.is_some() {
            return;
        }
        self.stale = false;
        self.task = Some(cx.spawn(async move |this, cx| {
            let started = Instant::now();
            let data = cx
                .background_executor()
                .spawn(async move { ShelfData::load(&lib) })
                .await;
            this.update(cx, |shelf, cx| {
                shelf.task = None;
                match data {
                    Ok(data) => {
                        log::debug!(
                            "shelf read in {:.1} ms ({} books)",
                            started.elapsed().as_secs_f64() * 1e3,
                            data.books.len()
                        );
                        shelf.data = Some(Rc::new(data));
                    }
                    Err(error) => log::warn!("the shelf could not be read: {error}"),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    // Acting.

    /// Opens `book` in the window: the bookshelf gives way to its tabs.
    pub fn open(&mut self, book: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.menu_open = false;
        let book = book.to_owned();
        self.ws
            .update(cx, |ws, cx| ws.open_book(&book, window, cx))
            .ok();
    }

    pub fn start_create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_form(None, window, cx);
    }

    pub fn start_edit(&mut self, book: ShelfBook, window: &mut Window, cx: &mut Context<Self>) {
        self.open_form(Some(book), window, cx);
    }

    fn open_form(
        &mut self,
        editing: Option<ShelfBook>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (name_text, summary_text) = editing
            .as_ref()
            .map(|b| (b.name.clone(), b.summary.clone()))
            .unwrap_or_default();
        let name_hint = t(cx, keys::project_picker::form::NAME_PLACEHOLDER);
        let summary_hint = t(cx, keys::project_picker::form::SUMMARY_PLACEHOLDER);
        let name = cx.new(|cx| {
            TextField::new("shelf-form-name", window, cx)
                .placeholder(name_hint)
                .with_text(name_text)
        });
        let summary = cx.new(|cx| {
            TextField::new("shelf-form-summary", window, cx)
                .placeholder(summary_hint)
                .with_text(summary_text)
        });
        let on_field = |shelf: &mut Shelf,
                        _: &Entity<TextField>,
                        e: &FieldEvent,
                        window: &mut Window,
                        cx: &mut Context<Shelf>| match e {
            // Enter in either field creates or saves (⌘↵ in the 0.1
            // client; see m01-shelf.md).
            FieldEvent::Submitted(_) => shelf.submit_form(window, cx),
            FieldEvent::Cancelled => shelf.close_dialog(window, cx),
            _ => {}
        };
        self._fields = vec![
            cx.subscribe_in(&name, window, on_field),
            cx.subscribe_in(&summary, window, on_field),
        ];
        name.focus_handle(cx).focus(window, cx);
        self.dialog = Some(DialogState::Form {
            editing,
            name,
            summary,
        });
        self.error = None;
        self.menu_open = false;
        cx.notify();
    }

    pub fn ask_trash(&mut self, book: ShelfBook, window: &mut Window, cx: &mut Context<Self>) {
        self.dialog = Some(DialogState::Trash { book });
        self.error = None;
        self.menu_open = false;
        // A dangerous dialog opens on Cancel; Esc reaches the bookshelf.
        self.focus.focus(window, cx);
        cx.notify();
    }

    pub fn open_deleted(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dialog = Some(DialogState::Deleted);
        self.error = None;
        self.menu_open = false;
        self.focus.focus(window, cx);
        cx.notify();
    }

    pub fn close_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.dialog = None;
        self._fields.clear();
        self.error = None;
        self.focus.focus(window, cx);
        cx.notify();
    }

    /// Creates the book (and opens it) or saves the edit.
    pub fn submit_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(DialogState::Form {
            editing,
            name,
            summary,
        }) = &self.dialog
        else {
            return;
        };
        let Some(lib) = self.lib.clone() else {
            return;
        };
        if self.busy {
            return;
        }
        let typed = name.read(cx).text().trim().to_owned();
        let summary = summary.read(cx).text().trim().to_owned();
        let editing = editing.clone();
        let untitled = t(cx, keys::project_picker::desk::UNTITLED).to_string();
        self.busy = true;
        self.error = None;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match editing {
                        None => lib
                            .run::<BookCreate>(
                                &Actor::User,
                                BookCreateIn {
                                    name: if typed.is_empty() { untitled } else { typed },
                                    summary,
                                },
                            )
                            .map(|o| Some(o.output.id)),
                        Some(book) => lib
                            .run::<BookUpdate>(
                                &Actor::User,
                                BookUpdateIn {
                                    book: book.id.clone(),
                                    name: (!typed.is_empty() && typed != book.name)
                                        .then_some(typed),
                                    summary: (summary != book.summary).then_some(summary),
                                    word_target: None,
                                    daily_word_target: None,
                                },
                            )
                            .map(|_| None),
                    }
                })
                .await;
            this.update_in(cx, |shelf, window, cx| {
                shelf.busy = false;
                match result {
                    Ok(created) => {
                        shelf.dialog = None;
                        shelf._fields.clear();
                        shelf.stale = true;
                        if let Some(id) = created {
                            shelf.open(&id, window, cx);
                        }
                    }
                    Err(error) => {
                        log::warn!("the book could not be saved: {error}");
                        shelf.error = Some(keys::common::SAVE_FAILED);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Moves the book of the open trash dialog to Recently Deleted.
    pub fn confirm_trash(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(DialogState::Trash { book }) = &self.dialog else {
            return;
        };
        let Some(lib) = self.lib.clone() else {
            return;
        };
        if self.busy {
            return;
        }
        let id = book.id.clone();
        self.busy = true;
        self.error = None;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { lib.run::<BookTrash>(&Actor::User, BookIn { book: id }) })
                .await;
            this.update_in(cx, |shelf, window, cx| {
                shelf.busy = false;
                match result {
                    Ok(_) => {
                        shelf.stale = true;
                        shelf.close_dialog(window, cx);
                    }
                    Err(error) => {
                        log::warn!("the book could not be moved to the trash: {error}");
                        shelf.error = Some(keys::project_picker::trash::FAILED);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Brings a book back from Recently Deleted.
    pub fn restore(&mut self, book: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        if self.busy {
            return;
        }
        let id = book.to_owned();
        self.busy = true;
        self.error = None;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { lib.run::<BookRestore>(&Actor::User, BookIn { book: id }) })
                .await;
            this.update(cx, |shelf, cx| {
                shelf.busy = false;
                match result {
                    Ok(_) => shelf.stale = true,
                    Err(error) => {
                        log::warn!("the book could not be restored: {error}");
                        shelf.error = Some(keys::project_picker::trash::RESTORE_FAILED);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Opens or closes the account menu; Esc closes it too.
    pub fn toggle_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.menu_open = !self.menu_open;
        if self.menu_open {
            self.focus.focus(window, cx);
        }
        cx.notify();
    }
}

impl Focusable for Shelf {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Shelf {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.stale && self.task.is_none() {
            self.reload(cx);
        }
        if self.cards_ms.is_none() && self.data.is_some() {
            self.cards_ms = Some(self.made.elapsed().as_secs_f64() * 1e3);
        }
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let wide = f32::from(window.viewport_size().width) >= ONE_COLUMN_BELOW;
        let rail = rail(self, window, cx);
        let books = books(self, wide, window, cx);
        let dialog = self.dialog.is_some().then(|| dialog(self, window, cx));
        let menu = self.menu_open.then(|| account_menu(self, window, cx));
        let root = div()
            .id("shelf")
            .key_context("Shelf")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_row()
            .bg(p.desk.solid())
            .text_color(p.ink(1).solid())
            .on_action(
                cx.listener(|shelf, _: &SubmitDialog, window, cx| shelf.submit_form(window, cx)),
            )
            .on_action(cx.listener(|shelf, _: &Dismiss, window, cx| {
                if shelf.menu_open {
                    shelf.menu_open = false;
                    cx.notify();
                } else if shelf.dialog.is_some() {
                    shelf.close_dialog(window, cx);
                } else {
                    cx.propagate();
                }
            }))
            .on_action(|_: &ImportBook, _, _| {
                log::debug!("importing a .driftingbook is not built yet (M41)")
            })
            .on_action(|_: &ImportLegacyLibrary, _, _| {
                log::debug!("importing a 0.1 library is not built yet (M10)")
            })
            .child(rail)
            .child(books)
            .children(dialog)
            .children(menu);
        glass::surface(Ground::flat(p.desk), root)
    }
}

// The rail.

fn rail(shelf: &mut Shelf, window: &mut Window, cx: &mut Context<Shelf>) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let locale = Settings::locale(cx);
    let library = match &shelf.data {
        Some(data) => tp(
            cx,
            keys::project_picker::rail::LIBRARY,
            data.books.len() as u64,
            &[
                ("count", &data.books.len()),
                ("words", &compact(data.words(), locale)),
            ],
        ),
        None => SharedString::default(),
    };
    let trashed = shelf.data.as_ref().map_or(0, |d| d.trashed.len());
    let entity = cx.entity();
    let deleted = {
        let entity = entity.clone();
        move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
            entity.update(cx, |shelf, cx| shelf.open_deleted(window, cx))
        }
    };
    div()
        .id("shelf-rail")
        .flex_none()
        .w(px(RAIL_W))
        .h_full()
        .pt(px(52.0))
        .pr(px(12.0))
        .pb(px(14.0))
        .pl(px(16.0))
        .flex()
        .flex_col()
        .child(
            div()
                .px(px(10.0))
                .font_role(Role::Structure)
                .type_px(22.0, 26.4)
                .text_color(p.ink(1).solid())
                .child(t(cx, keys::project_picker::header::TITLE_EM)),
        )
        .child(
            div()
                .mx(px(10.0))
                .mt(px(10.0))
                .font_role(Role::Index)
                .type_px(s.caption, s.caption * 1.4)
                .text_color(p.muted().solid())
                .child(library),
        )
        .child(div().flex_1())
        .child(rail_cell(
            "shelf-import-book",
            Icon::ArrowIn,
            t(cx, keys::project_picker::rail::IMPORT),
            Some(".driftingbook".into()),
            t(cx, keys::user_menu::IMPORT_BOOK),
            |_, window, cx| window.dispatch_action(Box::new(ImportBook), cx),
            window,
            cx,
        ))
        .child(rail_cell(
            "shelf-import-library",
            Icon::GateIn,
            t(cx, keys::user_menu::IMPORT),
            Some("Drifting 0.1".into()),
            t(cx, keys::user_menu::IMPORT),
            |_, window, cx| window.dispatch_action(Box::new(ImportLegacyLibrary), cx),
            window,
            cx,
        ))
        .child(rail_cell(
            "shelf-deleted",
            Icon::Trash,
            t(cx, keys::project_picker::desk::TRASH_ENTRY),
            (trashed > 0).then(|| grouped(trashed as u64, locale).into()),
            t(cx, keys::project_picker::desk::TRASH_ENTRY),
            deleted,
            window,
            cx,
        ))
        .child(rail_foot(shelf, window, cx))
        .into_any_element()
}

/// One of the rail's cells: no wash; under the pointer a ring of glass.
#[allow(clippy::too_many_arguments)]
fn rail_cell(
    id: &'static str,
    icon: Icon,
    label: SharedString,
    meta: Option<SharedString>,
    name: SharedString,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let group = SharedString::from(id);
    glass::glass_box(
        id,
        GlassKind::Hidden,
        Mode::default(),
        false,
        Spec::new(Tone::Clear, 10.0),
        window,
        cx,
    )
    .group(group.clone())
    .w_full()
    .min_h(px(32.0))
    .px(px(10.0))
    .py(px(6.0))
    .flex()
    .flex_row()
    .items_center()
    .gap(px(10.0))
    .cursor_pointer()
    .role(gpui::Role::Button)
    .aria_label(name)
    .text_color(p.ink(2).solid())
    .group_hover(group, move |st| st.text_color(p.ink(1).solid()))
    .on_click(on_click)
    .child(dr_ui::sand::icon(icon, 16.0, p.muted().solid()))
    .child(
        div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_baseline()
            .gap_x(px(10.0))
            .gap_y(px(2.0))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .font_role(Role::Ui)
                    .type_px(s.body, 20.0)
                    .child(label),
            )
            .when_some(meta, |el, meta| {
                el.child(
                    div()
                        .flex_none()
                        .font_role(Role::Index)
                        .type_px(s.caption, s.caption)
                        .text_color(p.muted().solid())
                        .child(meta),
                )
            }),
    )
    .into_any_element()
}

/// The account cell (avatar and name, the menu opens upward) beside the
/// notification bell.
fn rail_foot(shelf: &mut Shelf, window: &mut Window, cx: &mut Context<Shelf>) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let name = t(cx, keys::common::LOCAL);
    let open = shelf.menu_open;
    let entity = cx.entity();
    let avatar = dr_shell::account::avatar(24.0, window, cx);
    let account = glass::glass_box(
        "shelf-account",
        GlassKind::Hidden,
        Mode::default(),
        open,
        Spec::new(Tone::Clear, 12.0),
        window,
        cx,
    )
    .flex_1()
    .min_w_0()
    .px(px(10.0))
    .py(px(8.0))
    .flex()
    .flex_row()
    .items_center()
    .gap(px(10.0))
    .cursor_pointer()
    .role(gpui::Role::Button)
    .aria_label(t(cx, keys::user_menu::LOCAL_MENU))
    .on_click(move |_, window, cx| entity.update(cx, |shelf, cx| shelf.toggle_menu(window, cx)))
    .child(overlay::probe(shelf.account.clone()))
    .child(avatar)
    .child(
        div()
            .min_w_0()
            .overflow_hidden()
            .font_role(Role::Ui)
            .type_px(s.body, s.body * 1.3)
            .text_color(p.ink(1).solid())
            .truncate()
            .child(name),
    );
    let notifications_open = shelf
        .ws
        .upgrade()
        .is_some_and(|ws| ws.read(cx).notifications_open);
    div()
        .mt(px(6.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(4.0))
        .child(account)
        .child(
            div()
                .relative()
                .child(overlay::probe(shelf.bell.clone()))
                .child(
                    IconButton::new("shelf-notifications", Icon::Furin)
                        .label(t(cx, keys::notifications::TITLE))
                        .selected(notifications_open)
                        .on_click(|_, window, cx| {
                            window.dispatch_action(Box::new(ToggleNotifications), cx)
                        }),
                ),
        )
        .into_any_element()
}

/// The account menu, upward from the account cell: the shell's shared one
/// (`dr_shell::account`).
fn account_menu(shelf: &mut Shelf, window: &mut Window, cx: &mut Context<Shelf>) -> AnyElement {
    let entity = cx.entity();
    let close: dr_shell::account::Close = std::rc::Rc::new(move |_, cx| {
        entity.update(cx, |shelf, cx| {
            shelf.menu_open = false;
            cx.notify();
        })
    });
    let anchor = *shelf.account.read(cx);
    dr_shell::account::menu("shelf-account", anchor, close, window, cx)
}

// The books.

fn books(
    shelf: &mut Shelf,
    wide: bool,
    window: &mut Window,
    cx: &mut Context<Shelf>,
) -> AnyElement {
    let now = format::now_ms();
    let cards: Vec<AnyElement> = match &shelf.data {
        Some(data) => data
            .books
            .clone()
            .into_iter()
            .map(|book| card(book, now, window, cx))
            .collect(),
        None => Vec::new(),
    };
    let ready = shelf.data.is_some();
    let entity = cx.entity();
    div()
        .id("shelf-books")
        .flex_1()
        .min_w_0()
        .h_full()
        .overflow_y_scroll()
        // A double click on the empty desk starts a new book.
        .on_click(move |e, window, cx| {
            if e.click_count() == 2 {
                entity.update(cx, |shelf, cx| shelf.start_create(window, cx));
            }
        })
        .child(
            div()
                .w_full()
                .max_w(px(BOOKS_MAX_W))
                .pt(px(44.0))
                .pr(px(40.0))
                .pb(px(32.0))
                .pl(px(16.0))
                .when(ready, |el| {
                    el.child(
                        div()
                            .grid()
                            .grid_cols(if wide { 2 } else { 1 })
                            .gap(px(14.0))
                            .children(cards)
                            .child(new_card(window, cx)),
                    )
                }),
        )
        .into_any_element()
}

/// One book: a card with only a resting line of glass. The whole card opens
/// the book; edit and Recently Deleted show under the pointer.
fn card(book: ShelfBook, now: i64, window: &mut Window, cx: &mut Context<Shelf>) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let locale = Settings::locale(cx);
    let title: SharedString = if book.name.trim().is_empty() {
        t(cx, keys::project_picker::desk::UNTITLED)
    } else {
        book.name.clone().into()
    };
    let id = ElementId::Name(format!("shelf-card-{}", book.id).into());
    let group = SharedString::from(format!("shelf-card-{}", book.id));
    let entity = cx.entity();
    let open_id = book.id.clone();
    let open = {
        let entity = entity.clone();
        move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
            cx.stop_propagation();
            entity.update(cx, |shelf, cx| shelf.open(&open_id, window, cx));
        }
    };
    let edit_book = book.clone();
    let edit = {
        let entity = entity.clone();
        move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
            cx.stop_propagation();
            entity.update(cx, |shelf, cx| {
                shelf.start_edit(edit_book.clone(), window, cx)
            });
        }
    };
    let trash_book = book.clone();
    let trash = {
        let entity = entity.clone();
        move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
            cx.stop_propagation();
            entity.update(cx, |shelf, cx| {
                shelf.ask_trash(trash_book.clone(), window, cx)
            });
        }
    };
    let number = |n: u64| {
        div()
            .mr(px(3.0))
            .text_color(p.ink(2).solid())
            .child(grouped(n, locale))
    };
    let unit = |text: SharedString| div().child(text);
    let meta = div()
        .mt(px(12.0))
        .flex()
        .flex_row()
        .flex_wrap()
        .gap_x(px(14.0))
        .gap_y(px(4.0))
        .font_role(Role::Index)
        .type_px(s.caption, s.caption * 1.4)
        .text_color(p.ink(4).solid())
        .child(
            div()
                .flex()
                .child(
                    div()
                        .mr(px(3.0))
                        .text_color(p.ink(2).solid())
                        .child(compact(book.words, locale)),
                )
                .child(unit(t(cx, keys::project_picker::desk::WORDS_UNIT))),
        )
        .child(
            div()
                .flex()
                .child(number(book.chapters as u64))
                .child(unit(tp(
                    cx,
                    keys::project_picker::desk::CHAPTERS_UNIT,
                    book.chapters as u64,
                    &[],
                ))),
        )
        .child(
            div()
                .flex()
                .child(number(book.storylines as u64))
                .child(unit(tp(
                    cx,
                    keys::project_picker::desk::STORYLINES_UNIT,
                    book.storylines as u64,
                    &[],
                ))),
        )
        .child(
            div()
                .flex()
                .child(number(book.elements as u64))
                .child(unit(tp(
                    cx,
                    keys::project_picker::desk::ELEMENTS_UNIT,
                    book.elements as u64,
                    &[],
                ))),
        );
    let progress_row = progress(book.words, book.word_target).map(|value| {
        let target = book.word_target.unwrap_or(0).max(0) as u64;
        div()
            .mt_auto()
            .pt(px(14.0))
            .flex()
            .flex_col()
            .gap(px(5.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .font_role(Role::Index)
                    .type_px(11.0, 11.0)
                    .text_color(p.ink(4).solid())
                    .child(t(cx, keys::project_picker::desk::PROGRESS))
                    .child(tf(
                        cx,
                        keys::project_picker::desk::GOAL,
                        &[
                            ("pct", &((value * 100.0).round() as u32)),
                            ("target", &compact(target, locale)),
                        ],
                    )),
            )
            .child(
                Readout::new(
                    ElementId::Name(format!("shelf-progress-{}", book.id).into()),
                    value,
                )
                .color(p.ink(2)),
            )
    });
    let has_progress = progress_row.is_some();
    let status = Status::of(book.edited_ms, now);
    let (status_key, status_ink) = match status {
        Status::Writing => (keys::project_picker::status::WRITING, p.ink(2)),
        Status::Draft => (keys::project_picker::status::DRAFT, p.ink(3)),
        Status::Paused => (keys::project_picker::status::PAUSED, p.ink(4)),
    };
    let foot = div()
        .when(has_progress, |el| el.mt(px(10.0)))
        .when(!has_progress, |el| el.mt_auto())
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .font_role(Role::Index)
        .type_px(s.caption, s.caption)
        .text_color(p.ink(4).solid())
        .child(
            div()
                .text_color(status_ink.solid())
                .child(t(cx, status_key)),
        )
        .children(book.edited_ms.map(|at| format::ago(at, now, cx)));
    let acts = div()
        .flex()
        .flex_row()
        .flex_none()
        .mt(px(-4.0))
        .mr(px(-4.0))
        .invisible()
        .group_hover(group.clone(), |st| st.visible())
        .child(
            PanelIconButton::new(
                ElementId::Name(format!("shelf-edit-{}", book.id).into()),
                Icon::Edit,
            )
            .label(t(cx, keys::common::EDIT))
            .on_click(edit),
        )
        .child(
            PanelIconButton::new(
                ElementId::Name(format!("shelf-trash-{}", book.id).into()),
                Icon::Trash,
            )
            .label(t(cx, keys::project_picker::desk::MOVE_TO_TRASH))
            .on_click(trash),
        );
    let head = div()
        .flex()
        .flex_row()
        .items_start()
        .justify_between()
        .gap(px(8.0))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .font_role(Role::Prose)
                        .type_px(19.0, 19.0 * 1.35)
                        .text_color(p.ink(1).solid())
                        .truncate()
                        .child(title.clone()),
                )
                .when_some(book.subtitle.clone(), |el, sub| {
                    el.child(
                        div()
                            .mt(px(2.0))
                            .font_role(Role::Ui)
                            .type_px(s.caption, s.caption * 1.4)
                            .text_color(p.ink(3).solid())
                            .child(sub),
                    )
                }),
        )
        .child(acts);
    let summary = (!book.summary.trim().is_empty()).then(|| {
        div()
            .mt(px(10.0))
            .font_role(Role::Ui)
            .type_px(s.secondary, s.secondary * 1.6)
            .text_color(p.muted().solid())
            .line_clamp(2)
            .child(book.summary.clone())
    });
    glass::glass_box(
        id,
        GlassKind::Rest,
        Mode::default(),
        false,
        Spec::new(Tone::Clear, radius::SM),
        window,
        cx,
    )
    .group(group)
    .min_h(px(CARD_MIN_H))
    .p(px(12.0))
    .flex()
    .flex_col()
    .cursor_pointer()
    .role(gpui::Role::Button)
    .aria_label(tf(
        cx,
        keys::project_picker::desk::OPEN,
        &[("name", &title)],
    ))
    .on_click(open)
    .child(
        div()
            .flex_1()
            .min_w_0()
            .pt(px(4.0))
            .px(px(2.0))
            .pb(px(2.0))
            .flex()
            .flex_col()
            .child(head)
            .children(summary)
            .child(meta)
            .children(progress_row)
            .child(foot),
    )
    .into_any_element()
}

/// The last place in the grid: a cross and a line; only the pointer brings
/// its ring of glass.
fn new_card(window: &mut Window, cx: &mut Context<Shelf>) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let entity = cx.entity();
    glass::glass_box(
        "shelf-new",
        GlassKind::Hidden,
        Mode::default(),
        false,
        Spec::new(Tone::Clear, radius::SM),
        window,
        cx,
    )
    .group("shelf-new")
    .min_h(px(CARD_MIN_H))
    .p(px(12.0))
    .flex()
    .flex_col()
    .items_center()
    .justify_center()
    .gap(px(10.0))
    .cursor_pointer()
    .role(gpui::Role::Button)
    .aria_label(t(cx, keys::project_picker::desk::NEW_CARD))
    .text_color(p.ink(3).solid())
    .group_hover("shelf-new", move |st| st.text_color(p.ink(1).solid()))
    .on_click(move |_, window, cx| {
        cx.stop_propagation();
        entity.update(cx, |shelf, cx| shelf.start_create(window, cx));
    })
    .child(dr_ui::sand::icon(Icon::Plus, 22.0, p.ink(3).solid()))
    .child(
        div()
            .font_role(Role::Ui)
            .type_px(s.body, s.line_body)
            .child(t(cx, keys::project_picker::desk::NEW_CARD)),
    )
    .child(
        div()
            .font_role(Role::Index)
            .type_px(s.caption, s.caption)
            .text_color(p.ink(4).solid())
            .child(t(cx, keys::project_picker::desk::NEW_CARD_SUB)),
    )
    .into_any_element()
}

// The dialogs.

fn dialog(shelf: &mut Shelf, window: &mut Window, cx: &mut Context<Shelf>) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let entity = cx.entity();
    let close = {
        let entity = entity.clone();
        move |window: &mut Window, cx: &mut App| {
            entity.update(cx, |shelf, cx| shelf.close_dialog(window, cx))
        }
    };
    let cancel = {
        let close = close.clone();
        move |_: &ClickEvent, window: &mut Window, cx: &mut App| close(window, cx)
    };
    let busy = shelf.busy;
    let error = shelf.error.map(|key| {
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .text_color(p.danger.solid())
            .child(dr_ui::sand::icon(
                Icon::StatusWarning,
                13.0,
                p.danger.solid(),
            ))
            .child(t(cx, key))
    });
    let locale = Settings::locale(cx);
    let section = |label: SharedString, field: AnyElement| {
        div()
            .flex()
            .flex_col()
            .gap(px(6.0))
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.ink(3).solid())
                    .child(label),
            )
            .child(field)
    };
    match shelf.dialog.as_ref().expect("a dialog is open") {
        DialogState::Form {
            editing,
            name,
            summary,
        } => {
            let title = match editing {
                None => t(cx, keys::project_picker::desk::form::CREATE_TITLE),
                Some(b) => tf(
                    cx,
                    keys::project_picker::desk::form::EDIT_TITLE,
                    &[("name", &b.name)],
                ),
            };
            let submit_label = match (editing.is_some(), busy) {
                (false, false) => t(cx, keys::project_picker::form::CREATE_SUBMIT),
                (false, true) => t(cx, keys::common::CREATING),
                (true, false) => t(cx, keys::common::SAVE),
                (true, true) => t(cx, keys::common::SAVING),
            };
            let submit = entity.clone();
            Dialog::new("shelf-form", title)
                .body(section(
                    t(cx, keys::project_picker::desk::form::NAME_LABEL),
                    name.clone().into_any_element(),
                ))
                .body(section(
                    t(cx, keys::project_picker::desk::form::SUMMARY_LABEL),
                    summary.clone().into_any_element(),
                ))
                .when_some(error, |d, e| d.status(e))
                .action(
                    Button::new("shelf-form-cancel", t(cx, keys::common::CANCEL))
                        .text()
                        .disabled(busy)
                        .on_click(cancel),
                )
                .action(
                    Button::new("shelf-form-submit", submit_label)
                        .primary()
                        .disabled(busy)
                        .on_click(move |_, window, cx| {
                            submit.update(cx, |shelf, cx| shelf.submit_form(window, cx))
                        }),
                )
                .on_close(close)
                .into_any_element()
        }
        DialogState::Trash { book } => {
            let confirm = entity.clone();
            Dialog::new(
                "shelf-trash",
                tf(
                    cx,
                    keys::project_picker::desk::TRASH_TITLE,
                    &[("name", &book.name)],
                ),
            )
            .body(div().child(tf(
                cx,
                keys::project_picker::trash::BODY,
                &[
                    ("words", &grouped(book.words, locale)),
                    ("nodes", &book.chapters),
                    ("elements", &book.elements),
                ],
            )))
            .body(
                div()
                    .text_color(p.muted().solid())
                    .child(t(cx, keys::project_picker::trash::LOCAL_NOTE)),
            )
            .when_some(error, |d, e| d.status(e))
            .action(
                Button::new("shelf-trash-cancel", t(cx, keys::common::CANCEL))
                    .disabled(busy)
                    .on_click(cancel),
            )
            .action(
                Button::new(
                    "shelf-trash-confirm",
                    if busy {
                        t(cx, keys::project_picker::trash::MOVING)
                    } else {
                        t(cx, keys::project_picker::trash::CONFIRM)
                    },
                )
                .danger()
                .icon(Icon::Trash)
                .busy(busy)
                .disabled(busy)
                .on_click(move |_, window, cx| {
                    confirm.update(cx, |shelf, cx| shelf.confirm_trash(window, cx))
                }),
            )
            .on_close(close)
            .into_any_element()
        }
        DialogState::Deleted => {
            let trashed = shelf
                .data
                .as_ref()
                .map(|d| d.trashed.clone())
                .unwrap_or_default();
            let mut list = div().flex().flex_col().gap(px(2.0));
            if trashed.is_empty() {
                list = list.child(
                    div()
                        .py(px(12.0))
                        .text_color(p.muted().solid())
                        .child(t(cx, keys::project_picker::desk::trash_list::EMPTY)),
                );
            }
            for book in trashed {
                let restore = entity.clone();
                let id = book.id.clone();
                list = list.child(
                    div()
                        .min_h(px(s.row_height))
                        .px(px(10.0))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(10.0))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_color(p.ink(1).solid())
                                .child(book.name.clone()),
                        )
                        .child(
                            Button::new(
                                ElementId::Name(format!("shelf-restore-{}", book.id).into()),
                                if busy {
                                    t(cx, keys::project_picker::trash::RESTORING)
                                } else {
                                    t(cx, keys::project_picker::trash::RESTORE)
                                },
                            )
                            .small()
                            .disabled(busy)
                            .on_click(move |_, window, cx| {
                                restore.update(cx, |shelf, cx| shelf.restore(&id, window, cx))
                            }),
                        ),
                );
            }
            Dialog::new(
                "shelf-deleted",
                t(cx, keys::project_picker::desk::trash_list::TITLE),
            )
            .body(list)
            .when_some(error, |d, e| d.status(e))
            .action(
                Button::new("shelf-deleted-close", t(cx, keys::common::CLOSE))
                    .disabled(busy)
                    .on_click(cancel),
            )
            .on_close(close)
            .into_any_element()
        }
    }
}
