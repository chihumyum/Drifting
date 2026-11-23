//! The bookshelf view: the rail, the books, the dialogs.

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

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
    input::{
        area::TextArea,
        field::{FieldEvent, TextField},
    },
    sand::{Icon, Readout},
    style::DrStyled,
    tokens::radius,
};
use dr_workspace::{
    Actor, Workspace as Library, WsEvent,
    commands::{
        BookIn, NoInput,
        book::{BookPurge, BookPurgeExpired, BookRestore, BookTrash},
        v3::project_template::{
            ProjectTemplateEdit, ProjectTemplateEditIn, ProjectTemplateIdIn, ProjectTemplateRemove,
            ProjectTemplateSummary,
        },
    },
};
use gpui::{
    AnyElement, App, AppContext as _, Bounds, ClickEvent, Context, ElementId, Entity, FocusHandle,
    Focusable, InteractiveElement, IntoElement, ParentElement, Pixels, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Task, WeakEntity, Window, actions, canvas,
    div, prelude::FluentBuilder as _, px,
};

use dr_view_sea::{Sea, SeaGlass, first_run, on_sea};
use dr_view_shelf_art::{
    CoverStyle, CoverTurn, HeatmapBook, SandStrip, ShelfCover, WritingHeatmap, cover_seed,
};

use crate::art::{self, ShelfArt};
use crate::data::{ShelfBook, ShelfData, Status, TrashedBook, is_template_store_event, progress};
use crate::format;
use crate::templates::{NewProjectModal, render_delete_template_dialog, render_rail_templates};
use dr_i18n::number::{compact, grouped};

actions!(
    shelf,
    [
        /// Imports a `.driftingproject` (M41 handles it; the bookshelf only has
        /// the entry).
        ImportBook,
        /// Imports a `.driftingtemplate` into the library's saved templates
        /// (M41, `dr-view-transfer`, handles it; All Projects only has the entry).
        ImportTemplate,
        /// Imports a `.driftingmodule` into my modules (CM3,
        /// `dr-view-transfer` handles it; All Projects only has the entry).
        ImportModule,
        /// Imports a Drifting 0.1 library (M10, `dr-view-import`, handles it
        /// with `cx.on_action`; the bookshelf only has the entry).
        ImportLegacyLibrary,
        /// Creates or saves the book in the open form (⌘↵ / Ctrl+↵, as in
        /// the 0.1 client; Enter in a field does it too).
        SubmitDialog,
    ]
);

/// Exports book `book` as a `.driftingproject` (M41, `dr-view-transfer`,
/// handles it with `cx.on_action`; the book card only has the entry).
#[derive(Clone, Debug, PartialEq, Eq, gpui::Action)]
#[action(namespace = shelf, no_json)]
pub struct ExportBook {
    pub book: String,
}

/// Exports saved template `template` as a `.driftingtemplate` (M41,
/// `dr-view-transfer`, handles it with `cx.on_action`; All Projects' template
/// hover card only has the entry).
#[derive(Clone, Debug, PartialEq, Eq, gpui::Action)]
#[action(namespace = shelf, no_json)]
pub struct ExportTemplate {
    pub template: String,
}

/// Exports module `module` of mine as a `.driftingmodule` (CM3,
/// `dr-view-transfer` handles it with `cx.on_action`; the module's hover
/// card on All Projects only has the entry).
#[derive(Clone, Debug, PartialEq, Eq, gpui::Action)]
#[action(namespace = shelf, no_json)]
pub struct ExportModule {
    pub module: String,
}

/// The rail's width (`.pp__frame`'s first column).
const RAIL_W: f32 = 232.0;
/// The books' column: at most this wide (`.pp__frame > .pp__inner`).
const BOOKS_MAX_W: f32 = 1180.0;
/// Below this window width the books stand in one column.
const ONE_COLUMN_BELOW: f32 = 1080.0;
/// A card's least height (`.pp-card`: its cover, 226, and 12 around).
const CARD_MIN_H: f32 = 250.0;
/// How long the bookshelf shows before the books whose 30 days in Recently
/// Deleted are over go for good (the 0.1 shelf's
/// `EXPIRED_TRASH_PURGE_DELAY_MS`: a restore made on another device can
/// arrive first).
pub const PURGE_EXPIRED_AFTER: Duration = Duration::from_secs(2 * 60);

/// Which dialog is open, for tests and the debug bridge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShelfDialog {
    Create,
    Edit(String),
    Trash(String),
    RecentlyDeleted,
    /// Deleting a book in Recently Deleted for good, now.
    Purge(String),
    /// Deleting a saved project template for good.
    DeleteTemplate(String),
    /// Deleting a module of mine for good (CM3).
    DeleteModule(String),
}

enum DialogState {
    Create(Entity<NewProjectModal>),
    Edit {
        book: ShelfBook,
        name: Entity<TextField>,
        summary: Entity<TextArea>,
    },
    Trash {
        book: ShelfBook,
    },
    Deleted,
    /// The confirmation over Recently Deleted.
    Purge {
        book: TrashedBook,
    },
    DeleteTemplate {
        template: ProjectTemplateSummary,
    },
    DeleteModule {
        module: dr_workspace::commands::v3::custom_module::ModuleSummary,
    },
}

pub struct Shelf {
    jobs: crate::jobs::Jobs,
    releasing: bool,
    ws: WeakEntity<Workspace>,
    lib: Option<Library>,
    focus: FocusHandle,
    /// The shelf as last read; `None` until the first read lands.
    pub data: Option<Rc<ShelfData>>,
    task: Option<Task<()>>,
    /// What the covers, the heat map and the strips are drawn from (M25),
    /// read after each read of the shelf; `None` until the first lands.
    pub art: Option<Rc<ShelfArt>>,
    art_task: Option<Task<()>>,
    /// The book whose card the pointer is on: the heat map shows it alone.
    pub pointed: Option<String>,
    /// A press this frame landed on something of the desk's (a card, the
    /// map, a button), not the bare desk: no ring of its own (M24).
    press_taken: Rc<Cell<bool>>,
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
    /// Counts [`PURGE_EXPIRED_AFTER`] while the bookshelf shows.
    purge_timer: Option<Task<()>>,
    /// The bookshelf showed when the workspace last changed.
    was_shown: bool,
    /// How many times the expired books were purged (for tests).
    pub expired_runs: usize,
    _events: Option<dr_workspace::Subscription>,
    _store_events: Option<dr_store::LibrarySubscription>,
    _globals: Vec<Subscription>,
    _fields: Vec<Subscription>,
    _ws: Option<Subscription>,
}

impl Shelf {
    pub fn new(ws: WeakEntity<Workspace>, _: &mut Window, cx: &mut Context<Self>) -> Shelf {
        let lib = cx.try_global::<Services>().and_then(|s| s.library.clone());
        let mut shelf = Shelf {
            jobs: Default::default(),
            releasing: false,
            ws,
            lib,
            focus: cx.focus_handle(),
            data: None,
            task: None,
            art: None,
            art_task: None,
            pointed: None,
            press_taken: Rc::default(),
            stale: true,
            dialog: None,
            busy: false,
            error: None,
            menu_open: false,
            bell: cx.new(|_| None),
            account: cx.new(|_| None),
            made: Instant::now(),
            cards_ms: None,
            purge_timer: None,
            was_shown: false,
            expired_runs: 0,
            _events: None,
            _store_events: None,
            _globals: Vec::new(),
            _fields: Vec::new(),
            _ws: None,
        };
        shelf
            ._globals
            .push(cx.observe_global::<dr_shell::Strings>(|_, cx| cx.notify()));
        shelf
            ._globals
            .push(cx.observe_global::<dr_shell::Settings>(|_, cx| cx.notify()));
        shelf.listen(cx);
        shelf.reload(cx);
        // The workspace is still being made: follow it once it is there.
        cx.spawn(async move |this, cx| this.update(cx, |shelf, cx| shelf.follow(cx)).ok())
            .detach();
        let weak = cx.entity().downgrade();
        dr_shell::release::before_release(cx, move |cx| {
            weak.update(cx, |shelf, _| {
                shelf.releasing = true;
                shelf.purge_timer = None;
                shelf.task = None;
                shelf.art_task = None;
                shelf._events = None;
                shelf._store_events = None;
                shelf.lib = None;
                shelf.jobs.drained()
            })
            .unwrap_or_else(|_| Box::pin(async { Ok(()) }))
        });
        let weak = cx.entity().downgrade();
        dr_shell::release::after_release(cx, move |cx| {
            let lib = cx
                .try_global::<dr_shell::Services>()
                .and_then(|services| services.library.clone());
            let _ = weak.update(cx, |shelf, cx| {
                shelf.releasing = false;
                if shelf.ws.upgrade().is_some_and(|ws| {
                    ws.read(cx)
                        .shelf
                        .as_ref()
                        .is_some_and(|page| page.view.entity_id() == cx.entity_id())
                }) {
                    shelf.lib = lib;
                    shelf.stale = true;
                    shelf.listen(cx);
                    cx.notify();
                }
            });
        });
        shelf
    }

    /// Each time the bookshelf comes up, the books due in Recently Deleted
    /// go [`PURGE_EXPIRED_AFTER`] later, if it still shows (the 0.1 shelf
    /// ran it that long after it mounted).
    fn follow(&mut self, cx: &mut Context<Self>) {
        let Some(ws) = self.ws.upgrade() else {
            return;
        };
        self._ws = Some(cx.observe(&ws, |shelf, ws, cx| {
            let shown = ws.read(cx).shelf_open;
            if shown != shelf.was_shown {
                shelf.shown_changed(shown, cx);
            }
        }));
        let shown = ws.read(cx).shelf_open;
        self.shown_changed(shown, cx);
    }

    fn shown_changed(&mut self, shown: bool, cx: &mut Context<Self>) {
        self.was_shown = shown;
        if !shown {
            self.purge_timer = None;
            return;
        }
        self.purge_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(PURGE_EXPIRED_AFTER).await;
            let lib = this
                .update(cx, |shelf, cx| {
                    if shelf.releasing || dr_shell::release::is_releasing(cx) {
                        None
                    } else {
                        shelf.lib.clone().map(|lib| shelf.jobs.enter(lib))
                    }
                })
                .ok()
                .flatten();
            let Some(lib) = lib else {
                return;
            };
            let out = cx
                .background_executor()
                .spawn(async move { lib.run::<BookPurgeExpired>(&Actor::User, NoInput {}) })
                .await;
            this.update(cx, |shelf, cx| {
                shelf.expired_runs += 1;
                match out {
                    Ok(out) => {
                        let out = out.output;
                        if !out.waiting.is_empty() {
                            log::debug!("books due but in use: {:?}", out.waiting);
                        }
                        if !out.purged.is_empty() {
                            shelf.stale = true;
                            cx.notify();
                        }
                    }
                    Err(error) => log::warn!("expired books were not purged: {error}"),
                }
            })
            .ok();
        }));
    }

    /// The bell's bounds cell, for the shell's notification center.
    pub fn bell(&self) -> Entity<Option<Bounds<Pixels>>> {
        self.bell.clone()
    }

    pub fn dialog(&self) -> Option<ShelfDialog> {
        Some(match self.dialog.as_ref()? {
            DialogState::Create(_) => ShelfDialog::Create,
            DialogState::Edit { book, .. } => ShelfDialog::Edit(book.id.clone()),
            DialogState::Trash { book } => ShelfDialog::Trash(book.id.clone()),
            DialogState::Deleted => ShelfDialog::RecentlyDeleted,
            DialogState::Purge { book } => ShelfDialog::Purge(book.id.clone()),
            DialogState::DeleteTemplate { template } => {
                ShelfDialog::DeleteTemplate(template.id.clone())
            }
            DialogState::DeleteModule { module } => ShelfDialog::DeleteModule(module.id.clone()),
        })
    }

    /// The open template-picker creation dialog, for tests.
    pub fn new_project_dialog(&self) -> Option<Entity<NewProjectModal>> {
        match self.dialog.as_ref()? {
            DialogState::Create(modal) => Some(modal.clone()),
            _ => None,
        }
    }

    /// The edit dialog's name and summary fields, for tests.
    pub fn form_fields(&self) -> Option<(Entity<TextField>, Entity<TextArea>)> {
        match self.dialog.as_ref()? {
            DialogState::Edit { name, summary, .. } => Some((name.clone(), summary.clone())),
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
    /// edit), a document's derived index was written (the words; right after
    /// an import or seeding the index is built in the background), or a saved
    /// project template (`project-template:<id>`) changed. The shelf reads
    /// again when it next shows.
    fn listen(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<()>();
        let tx_ws = tx.clone();
        self._events = Some(lib.subscribe(move |event| {
            let counts = match event {
                // A card shows the book's content and its writing days (the
                // heat map, the last thirty); a saved checkpoint is neither.
                WsEvent::Book(_) | WsEvent::Stats(_) => true,
                WsEvent::Checkpoints(_) | WsEvent::Layout(_) => false,
                WsEvent::Removed(_) | WsEvent::Prose(_) => true,
                // The words of a document that has text. (The book document
                // has an index row too, always empty and written after every
                // commit to it.)
                WsEvent::Local(change) => dr_workspace::is_text_index(change),
            };
            if counts {
                let _ = tx_ws.unbounded_send(());
            }
        }));
        self._store_events = Some(lib.library().subscribe(move |event| {
            if is_template_store_event(event)
                || dr_workspace::commands::v3::custom_module::is_my_module_store_event(event)
            {
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
        if self.releasing || dr_shell::release::is_releasing(cx) {
            return;
        }
        let Some(lib) = self.lib.clone() else {
            self.stale = false;
            self.data = Some(Rc::new(ShelfData::default()));
            return;
        };
        if self.task.is_some() {
            return;
        }
        self.stale = false;
        let lib = self.jobs.enter(lib);
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
                        if let Some(DialogState::Create(modal)) = &shelf.dialog {
                            let tpls = data.templates.clone();
                            modal.update(cx, |m, cx| m.set_templates(tpls, cx));
                        }
                        shelf.data = Some(Rc::new(data));
                        shelf.load_art(cx);
                    }
                    Err(error) => log::warn!("the shelf could not be read: {error}"),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Reads the books' covers, genres and writing days off the main thread
    /// (M25). A read still running for older data is dropped.
    fn load_art(&mut self, cx: &mut Context<Self>) {
        if self.releasing || dr_shell::release::is_releasing(cx) {
            return;
        }
        let (Some(lib), Some(data)) = (self.lib.clone(), self.data.clone()) else {
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
            let started = Instant::now();
            let loaded = cx
                .background_executor()
                .spawn(async move { ShelfArt::load(&lib, &books, &today) })
                .await;
            this.update(cx, |shelf, cx| {
                log::debug!(
                    "shelf pictures read in {:.1} ms",
                    started.elapsed().as_secs_f64() * 1e3
                );
                shelf.art_task = None;
                shelf.art = Some(Rc::new(ShelfArt::from_loaded(loaded)));
                cx.notify();
            })
            .ok();
        }));
    }

    /// The pointer came onto `book`'s card (or left it).
    pub fn point_at(&mut self, book: &str, on: bool, cx: &mut Context<Self>) {
        let pointed = match (on, self.pointed.as_deref()) {
            (true, _) => Some(book.to_owned()),
            (false, Some(current)) if current == book => None,
            (false, current) => current.map(str::to_owned),
        };
        if pointed != self.pointed {
            self.pointed = pointed;
            cx.notify();
        }
    }

    /// Turns every cover to `style` (the shelf's round button).
    pub fn turn_covers(&mut self, style: CoverStyle, cx: &mut Context<Self>) {
        art::set_cover_style(style, cx);
        cx.notify();
    }

    // Acting.

    /// Opens `book` in the window: the bookshelf gives way to its tabs.
    pub fn open(&mut self, book: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.menu_open = false;
        // A sample opened: the samples wait no longer (M24).
        first_run::note_book_opened(book, cx);
        let book = book.to_owned();
        self.ws
            .update(cx, |ws, cx| ws.open_book(&book, window, cx))
            .ok();
    }

    pub fn start_create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let my_templates = self
            .data
            .as_ref()
            .map(|d| d.templates.clone())
            .unwrap_or_default();
        let jobs = self.jobs.clone();
        let ws = self.ws.clone();
        let created_shelf = cx.weak_entity();
        let closed_shelf = cx.weak_entity();
        let modal = cx.new(|cx| {
            NewProjectModal::new(
                jobs,
                ws,
                my_templates,
                move |id, window, cx| {
                    let _ = created_shelf.update(cx, |shelf, cx| {
                        shelf.dialog = None;
                        shelf._fields.clear();
                        shelf.stale = true;
                        shelf.open(&id, window, cx);
                        cx.notify();
                    });
                },
                move |window, cx| {
                    let _ = closed_shelf.update(cx, |shelf, cx| shelf.dismiss_dialog(window, cx));
                },
                cx,
            )
        });
        self._fields.clear();
        // The dialog holds the keyboard (as from the row of projects): ↩ and
        // ⌘↵ create, Esc closes it; closing gives the keyboard back here.
        modal.focus_handle(cx).focus(window, cx);
        self.dialog = Some(DialogState::Create(modal));
        self.error = None;
        self.menu_open = false;
        cx.notify();
    }

    pub fn start_edit(&mut self, book: ShelfBook, window: &mut Window, cx: &mut Context<Self>) {
        let name_hint = t(cx, keys::project_picker::form::NAME_PLACEHOLDER);
        let summary_hint = t(cx, keys::all_projects::SUMMARY_PLACEHOLDER);
        let name = cx.new(|cx| {
            TextField::new("shelf-form-name", window, cx)
                .placeholder(name_hint)
                .with_text(book.name.clone())
        });
        let summary = cx.new(|cx| {
            TextArea::new("shelf-form-summary", window, cx)
                .framed(3.0)
                .placeholder(summary_hint)
                .with_text(book.summary.clone())
        });
        // ⌘↵ saves (the summary's own ⌘↵ does it too, and Enter in the name);
        // Esc in a field closes the dialog.
        self._fields = vec![
            cx.subscribe_in(&name, window, |shelf, _, e, window, cx| match e {
                FieldEvent::Submitted(_) => shelf.submit_form(window, cx),
                FieldEvent::Cancelled => shelf.close_dialog(window, cx),
                _ => {}
            }),
            cx.subscribe_in(&summary, window, |shelf, _, e, window, cx| match e {
                FieldEvent::Submitted(_) => shelf.submit_form(window, cx),
                FieldEvent::Cancelled => shelf.close_dialog(window, cx),
                _ => {}
            }),
        ];
        name.focus_handle(cx).focus(window, cx);
        self.dialog = Some(DialogState::Edit {
            book,
            name,
            summary,
        });
        self.error = None;
        self.menu_open = false;
        cx.notify();
    }

    /// Opens saved project template `id` in its working copy (`project_template.edit`).
    pub fn edit_template(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.releasing || dr_shell::release::is_releasing(cx) || self.busy {
            return;
        }
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let template_id = id.to_owned();
        self.busy = true;
        self.menu_open = false;
        cx.notify();
        let lib = self.jobs.enter(lib);
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    lib.run::<ProjectTemplateEdit>(
                        &Actor::User,
                        ProjectTemplateEditIn { id: template_id },
                    )
                })
                .await;
            this.update_in(cx, |shelf, window, cx| {
                shelf.busy = false;
                match result {
                    Ok(out) => {
                        shelf.open(&out.output.book, window, cx);
                    }
                    Err(error) => {
                        log::warn!("the project template could not be opened for editing: {error}");
                        // Said at the window's foot, as the shell says a step
                        // that did not go through (the hover card is gone).
                        let text = t(cx, keys::project_templates::OPEN_FAILED);
                        shelf.ws.update(cx, |ws, cx| ws.toast_error(text, cx)).ok();
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Asks before deleting a saved project template for good.
    pub fn ask_delete_template(
        &mut self,
        template: ProjectTemplateSummary,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dialog = Some(DialogState::DeleteTemplate { template });
        self.error = None;
        self.menu_open = false;
        self.focus.focus(window, cx);
        cx.notify();
    }

    /// Permanently deletes the saved project template of the open confirmation
    /// (`project_template.remove`).
    pub fn confirm_delete_template(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(DialogState::DeleteTemplate { template }) = &self.dialog else {
            return;
        };
        if self.releasing || dr_shell::release::is_releasing(cx) || self.busy {
            return;
        }
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let id = template.id.clone();
        self.busy = true;
        self.error = None;
        cx.notify();
        let lib = self.jobs.enter(lib);
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    lib.run::<ProjectTemplateRemove>(&Actor::User, ProjectTemplateIdIn { id })
                })
                .await;
            this.update_in(cx, |shelf, window, cx| {
                shelf.busy = false;
                match result {
                    Ok(_) => {
                        shelf.stale = true;
                        shelf.close_dialog(window, cx);
                    }
                    Err(error) => {
                        log::warn!("the project template could not be deleted: {error}");
                        shelf.error = Some(keys::mobile_workspace::project_actions::DELETE_FAILED);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The window's workspace.
    pub fn workspace(&self) -> WeakEntity<Workspace> {
        self.ws.clone()
    }

    /// 编辑 a module of mine (CM3): All Projects gives way to the project the
    /// window has open (without one, the most recently changed), and the
    /// module's workbench opens there as a pill.
    pub fn edit_module(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Ok(id) = id.parse::<dr_model::id::CustomModuleId>() else {
            return;
        };
        self.menu_open = false;
        let first = self
            .data
            .as_ref()
            .and_then(|d| d.books.first())
            .map(|b| b.id.clone());
        self.ws
            .update(cx, |ws, cx| {
                let book = if ws.book_id.is_empty() {
                    first
                } else {
                    Some(ws.book_id.clone())
                };
                let Some(book) = book else {
                    log::warn!("a module's workbench needs a project to open in");
                    return;
                };
                ws.open_book(&book, window, cx);
                ws.open(
                    dr_shell::nav::Target::Module(id),
                    dr_shell::nav::Open::KEEP,
                    cx,
                );
            })
            .ok();
    }

    /// Asks before deleting a module of mine for good (as a saved template).
    pub fn ask_delete_module(
        &mut self,
        module: dr_workspace::commands::v3::custom_module::ModuleSummary,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dialog = Some(DialogState::DeleteModule { module });
        self.error = None;
        self.menu_open = false;
        self.focus.focus(window, cx);
        cx.notify();
    }

    /// Deletes the module of the open question for good
    /// (`custom_module.remove`): the projects using it keep their copies and
    /// stop following it (§16 item 4).
    pub fn confirm_delete_module(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(DialogState::DeleteModule { module }) = &self.dialog else {
            return;
        };
        if self.releasing || dr_shell::release::is_releasing(cx) || self.busy {
            return;
        }
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let id = module.id.clone();
        self.busy = true;
        self.error = None;
        cx.notify();
        let lib = self.jobs.enter(lib);
        cx.spawn_in(window, async move |this, cx| {
            use dr_workspace::commands::v3::custom_module::{CustomModuleRemove, IdIn};
            let result = cx
                .background_executor()
                .spawn(async move { lib.run::<CustomModuleRemove>(&Actor::User, IdIn { id }) })
                .await;
            this.update_in(cx, |shelf, window, cx| {
                shelf.busy = false;
                match result {
                    Ok(_) => {
                        shelf.stale = true;
                        shelf.close_dialog(window, cx);
                    }
                    Err(error) => {
                        log::warn!("the module could not be deleted: {error}");
                        shelf.error = Some(keys::mobile_workspace::project_actions::DELETE_FAILED);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
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

    /// Asks before deleting a book in Recently Deleted for good.
    pub fn ask_purge(&mut self, book: TrashedBook, window: &mut Window, cx: &mut Context<Self>) {
        self.dialog = Some(DialogState::Purge { book });
        self.error = None;
        self.focus.focus(window, cx);
        cx.notify();
    }

    /// Esc and the mist step back from the confirmation to Recently
    /// Deleted before they close it (the 0.1 shelf).
    fn step_back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        if matches!(self.dialog, Some(DialogState::Purge { .. })) {
            self.dialog = Some(DialogState::Deleted);
            self.error = None;
            cx.notify();
        } else {
            self.close_dialog(window, cx);
        }
    }

    /// Deletes the book of the open confirmation for good (`book.purge`),
    /// then shows Recently Deleted again.
    pub fn confirm_purge(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(DialogState::Purge { book }) = &self.dialog else {
            return;
        };
        if self.releasing || dr_shell::release::is_releasing(cx) {
            return;
        }
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
        let lib = self.jobs.enter(lib);
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { lib.run::<BookPurge>(&Actor::User, BookIn { book: id }) })
                .await;
            this.update(cx, |shelf, cx| {
                shelf.busy = false;
                match result {
                    Ok(_) => {
                        shelf.stale = true;
                        shelf.dialog = Some(DialogState::Deleted);
                    }
                    Err(error) => {
                        log::warn!("the book could not be deleted: {error}");
                        shelf.error = Some(keys::mobile_workspace::project_actions::DELETE_FAILED);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn close_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        if let Some(DialogState::Create(modal)) = &self.dialog
            && modal.read(cx).is_busy()
        {
            return;
        }
        self.dismiss_dialog(window, cx);
    }

    /// Also called by the picker after it has handled its own busy state.
    fn dismiss_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dialog = None;
        self._fields.clear();
        self.error = None;
        self.focus.focus(window, cx);
        cx.notify();
    }

    /// Creates the book (and opens it) or saves the edit.
    pub fn submit_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(DialogState::Create(modal)) = &self.dialog {
            let modal = modal.clone();
            modal.update(cx, |m, cx| m.submit(window, cx));
            return;
        }
        let Some(DialogState::Edit {
            book,
            name,
            summary,
        }) = &self.dialog
        else {
            return;
        };
        if self.releasing || dr_shell::release::is_releasing(cx) {
            return;
        }
        let Some(lib) = self.lib.clone() else {
            return;
        };
        if self.busy {
            return;
        }
        let typed = name.read(cx).text().trim().to_owned();
        let summary = summary.read(cx).text().trim().to_owned();
        let book = book.clone();
        self.busy = true;
        self.error = None;
        cx.notify();
        let lib = self.jobs.enter(lib);
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    lib.run::<dr_workspace::commands::v3::book::BookUpdate>(
                        &Actor::User,
                        dr_workspace::commands::v3::book::BookUpdateIn {
                            book: book.id.clone(),
                            name: (!typed.is_empty() && typed != book.name).then_some(typed),
                            summary: (summary != book.summary).then_some(summary),
                        },
                    )
                })
                .await;
            this.update(cx, |shelf, cx| {
                shelf.busy = false;
                match result {
                    Ok(_) => {
                        shelf.dialog = None;
                        shelf._fields.clear();
                        shelf.stale = true;
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
        if self.releasing || dr_shell::release::is_releasing(cx) {
            return;
        }
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
        let lib = self.jobs.enter(lib);
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
        if self.releasing || dr_shell::release::is_releasing(cx) {
            return;
        }
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
        let lib = self.jobs.enter(lib);
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
        // On the sea of characters (M24) the shelf leaves its ground clear.
        let on_sea = Sea::of(window, cx).is_on();
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
            .when(!on_sea, |el| el.bg(p.desk.solid()))
            .text_color(p.ink(1).solid())
            .on_action(
                cx.listener(|shelf, _: &SubmitDialog, window, cx| shelf.submit_form(window, cx)),
            )
            .on_action(cx.listener(|shelf, _: &Dismiss, window, cx| {
                if shelf.menu_open {
                    shelf.menu_open = false;
                    cx.notify();
                } else if shelf.dialog.is_some() {
                    shelf.step_back(window, cx);
                } else {
                    cx.propagate();
                }
            }))
            .child(rail)
            .child(books)
            .children(dialog)
            .children(menu);
        if on_sea {
            glass::surface(Ground::Uneven, root)
        } else {
            glass::surface(Ground::flat(p.desk), root)
        }
    }
}

// The rail.

fn rail(shelf: &mut Shelf, window: &mut Window, cx: &mut Context<Shelf>) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let locale = Settings::locale(cx);
    let library = match &shelf.data {
        Some(data) if !data.books.is_empty() && !data.books.iter().any(|b| b.has_book) => tp(
            cx,
            keys::all_projects::LIBRARY_PROJECTS,
            data.books.len() as u64,
            &[("count", &data.books.len())],
        ),
        Some(data) => tp(
            cx,
            keys::all_projects::LIBRARY,
            data.books.len() as u64,
            &[
                ("count", &data.books.len()),
                (
                    "words",
                    &data
                        .words()
                        .map(|n| compact(n, locale))
                        .unwrap_or_else(|| t(cx, keys::workspace_word_tally::COUNTING).to_string()),
                ),
            ],
        ),
        None => SharedString::default(),
    };
    let trashed = shelf.data.as_ref().map_or(0, |d| d.trashed.len());
    let my_templates = shelf
        .data
        .as_ref()
        .and_then(|d| render_rail_templates(&d.templates, shelf.press_taken.clone(), window, cx));
    let my_modules = shelf.data.clone().and_then(|d| {
        crate::modules::render_rail_modules(&d.modules, shelf.press_taken.clone(), window, cx)
    });
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
                .child(t(cx, keys::all_projects::TITLE)),
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
        .children(my_templates)
        .children(my_modules)
        .child(div().flex_1())
        .child(rail_cell(
            "shelf-import-book",
            Icon::ArrowIn,
            t(cx, keys::all_projects::IMPORT),
            RailMeta::Subtitle(".driftingproject"),
            t(cx, keys::all_projects::IMPORT_FILE),
            |_, window, cx| window.dispatch_action(Box::new(ImportBook), cx),
            window,
            cx,
        ))
        .child(
            div()
                .debug_selector(|| "shelf-import-template".into())
                .child(rail_cell(
                    "shelf-import-template",
                    Icon::ArrowIn,
                    t(cx, keys::all_projects::IMPORT_TEMPLATE),
                    RailMeta::Subtitle(".driftingtemplate"),
                    t(cx, keys::all_projects::IMPORT_TEMPLATE_FILE),
                    |_, window, cx| window.dispatch_action(Box::new(ImportTemplate), cx),
                    window,
                    cx,
                )),
        )
        .child(
            div()
                .debug_selector(|| "shelf-import-module".into())
                .child(rail_cell(
                    "shelf-import-module",
                    Icon::ArrowIn,
                    t(cx, keys::module_bench::IMPORT_MODULE),
                    RailMeta::Subtitle(".driftingmodule"),
                    t(cx, keys::module_bench::IMPORT_MODULE_FILE),
                    |_, window, cx| window.dispatch_action(Box::new(ImportModule), cx),
                    window,
                    cx,
                )),
        )
        .child(rail_cell(
            "shelf-import-library",
            Icon::GateIn,
            t(cx, keys::user_menu::IMPORT),
            RailMeta::Subtitle("Drifting 0.1"),
            t(cx, keys::user_menu::IMPORT),
            |_, window, cx| window.dispatch_action(Box::new(ImportLegacyLibrary), cx),
            window,
            cx,
        ))
        .child(rail_cell(
            "shelf-deleted",
            Icon::Trash,
            t(cx, keys::project_picker::desk::TRASH_ENTRY),
            RailMeta::Count((trashed > 0).then(|| grouped(trashed as u64, locale).into())),
            t(cx, keys::project_picker::desk::TRASH_ENTRY),
            deleted,
            window,
            cx,
        ))
        .child(rail_foot(shelf, window, cx))
        .into_any_element()
}

enum RailMeta {
    Subtitle(&'static str),
    Count(Option<SharedString>),
}

/// One of the rail's cells: no wash; under the pointer a ring of glass.
#[allow(clippy::too_many_arguments)]
fn rail_cell(
    id: &'static str,
    icon: Icon,
    label: SharedString,
    meta: RailMeta,
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
    .child({
        let row = div().flex_1().min_w_0();
        let label = div().font_role(Role::Ui).type_px(s.body, 20.0).child(label);
        let detail = div()
            .flex_none()
            .font_role(Role::Index)
            .type_px(s.caption, s.caption)
            .text_color(p.muted().solid());
        match meta {
            RailMeta::Subtitle(suffix) => row
                .flex()
                .flex_col()
                .gap(px(2.0))
                .child(
                    label
                        .truncate()
                        .debug_selector(move || format!("{id}-label")),
                )
                .child(
                    detail
                        .truncate()
                        .debug_selector(move || format!("{id}-suffix"))
                        .child(suffix),
                ),
            RailMeta::Count(count) => row
                .flex()
                .flex_row()
                .flex_wrap()
                .items_baseline()
                .gap_x(px(10.0))
                .gap_y(px(2.0))
                .child(label.flex_grow(1.0).flex_shrink_0())
                .when_some(count, |el, count| el.child(detail.child(count))),
        }
    })
    .into_any_element()
}

/// The account cell (avatar and name, the menu opens upward) beside the
/// notification bell.
fn rail_foot(shelf: &mut Shelf, window: &mut Window, cx: &mut Context<Shelf>) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let name = dr_shell::account::display_name(cx);
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
    .aria_label(dr_shell::account::menu_aria_label(cx))
    .debug_selector(|| "shelf-account".into())
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
    let p = Theme::of(window, cx).palette;
    let art = shelf.art.clone();
    let style = art::cover_style(cx);
    let pointed_id = shelf.pointed.clone();
    let cards: Vec<AnyElement> = match &shelf.data {
        Some(data) => data
            .books
            .clone()
            .into_iter()
            .map(|book| {
                let is_pointed = pointed_id.as_deref() == Some(book.id.as_str());
                card(
                    book,
                    is_pointed,
                    now,
                    art.as_deref(),
                    style,
                    shelf.press_taken.clone(),
                    window,
                    cx,
                )
            })
            .collect(),
        None => Vec::new(),
    };
    let ready = shelf.data.is_some();
    // A year of writing days over the book-enabled projects, every book together;
    // the book under the pointer alone, in its colour. Projects with `成书` off
    // neither contribute cells nor focus the heatmap.
    let heat = match (&art, &shelf.data) {
        (Some(art), Some(data)) => {
            let books: Vec<HeatmapBook> = data
                .books
                .iter()
                .filter(|b| b.has_book)
                .map(|b| HeatmapBook {
                    id: b.id.clone().into(),
                    name: if b.name.trim().is_empty() {
                        t(cx, keys::project_picker::desk::UNTITLED)
                    } else {
                        b.name.clone().into()
                    },
                    color: art::book_color(&b.id, p),
                })
                .collect();
            if !data.books.is_empty() && books.is_empty() {
                None
            } else {
                let focus = shelf
                    .pointed
                    .as_ref()
                    .filter(|id| books.iter().any(|b| b.id.as_ref() == id.as_str()))
                    .map(|id| SharedString::from(id.clone()));
                let taken = shelf.press_taken.clone();
                Some(
                    div()
                        .id("shelf-heat-place")
                        .mb(px(14.0))
                        .on_mouse_down(gpui::MouseButton::Left, move |_, _, _| taken.set(true))
                        // Not the empty desk: a double click starts nothing.
                        .on_click(|_, _, cx| cx.stop_propagation())
                        .child(WritingHeatmap::new(
                            "shelf-heat",
                            art.year.clone(),
                            Rc::new(books),
                            focus,
                        )),
                )
            }
        }
        _ => None,
    };
    let entity = cx.entity();
    let turn = {
        let entity = entity.clone();
        CoverTurn::new(style, move |next, _, cx| {
            entity.update(cx, |shelf, cx| shelf.turn_covers(next, cx))
        })
    };
    let taken = shelf.press_taken.clone();
    div()
        .id("shelf-books")
        .flex_1()
        .min_w_0()
        .h_full()
        .overflow_y_scroll()
        // A press on the bare desk sends a ring through the sea (M24).
        .on_mouse_down(gpui::MouseButton::Left, move |e, window, cx| {
            if !taken.replace(false) {
                Sea::of(window, cx).press(e.position, 1.2, window);
            }
        })
        // A double click on the empty desk starts a new book.
        .on_click(move |e, window, cx| {
            if e.click_count() == 2 {
                entity.update(cx, |shelf, cx| shelf.start_create(window, cx));
            }
        })
        .child(
            div()
                .w_full()
                .min_h_full()
                .max_w(px(BOOKS_MAX_W))
                .pt(px(44.0))
                .pr(px(40.0))
                .pb(px(32.0))
                .pl(px(16.0))
                .flex()
                .flex_col()
                .children(heat)
                .when(ready, |el| {
                    el.child(
                        div()
                            .grid()
                            .grid_cols(if wide { 2 } else { 1 })
                            .gap(px(14.0))
                            .children(cards)
                            .child(new_card(shelf.press_taken.clone(), window, cx)),
                    )
                    // At the foot, below the books however many: the round
                    // button that turns every cover to the next style.
                    .child(
                        div().mt_auto().pt(px(28.0)).flex().justify_center().child(
                            div()
                                .id("shelf-cover-style")
                                .debug_selector(|| "shelf-cover-style".into())
                                .on_mouse_down(gpui::MouseButton::Left, {
                                    let taken = shelf.press_taken.clone();
                                    move |_, _, _| taken.set(true)
                                })
                                .on_click(|_, _, cx| cx.stop_propagation())
                                .child(turn),
                        ),
                    )
                }),
        )
        .into_any_element()
}

/// One book: a card with only a resting line of glass. The whole card opens
/// the book; edit and Recently Deleted show under the pointer.
#[allow(clippy::too_many_arguments)]
fn card(
    book: ShelfBook,
    is_pointed: bool,
    now: i64,
    art: Option<&ShelfArt>,
    style: CoverStyle,
    taken: Rc<Cell<bool>>,
    window: &mut Window,
    cx: &mut Context<Shelf>,
) -> AnyElement {
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
        move |e: &ClickEvent, window: &mut Window, cx: &mut App| {
            cx.stop_propagation();
            // Opening a book sends its ring through the sea (M24).
            Sea::of(window, cx).press(e.position(), 1.3, window);
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
    let meta = if book.has_book {
        div()
            .mt(px(12.0))
            .flex()
            .flex_row()
            .flex_wrap()
            .gap_x(px(14.0))
            .gap_y(px(4.0))
            .font_role(Role::Index)
            .type_px(s.caption, s.caption * 1.4)
            .text_color(p.ink(4).solid())
            .child({
                let book_id = book.id.clone();
                div()
                    .id(ElementId::Name(format!("shelf-words-{}", book.id).into()))
                    .debug_selector(move || format!("shelf-words-{book_id}"))
                    .flex()
                    .child(div().mr(px(3.0)).text_color(p.ink(2).solid()).child(
                        book.words.map(|n| compact(n, locale)).unwrap_or_else(|| {
                            t(cx, keys::workspace_word_tally::COUNTING).to_string()
                        }),
                    ))
                    .child(unit(t(cx, keys::project_picker::desk::WORDS_UNIT)))
            })
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
            )
    } else {
        let book_id = book.id.clone();
        div()
            .mt(px(12.0))
            .flex()
            .flex_row()
            .flex_wrap()
            .gap_x(px(14.0))
            .gap_y(px(4.0))
            .font_role(Role::Index)
            .type_px(s.caption, s.caption * 1.4)
            .text_color(p.ink(2).solid())
            .child(
                div()
                    .id(ElementId::Name(
                        format!("shelf-entry-count-{}", book.id).into(),
                    ))
                    .debug_selector(move || format!("shelf-entry-count-{book_id}"))
                    .child(tp(
                        cx,
                        keys::k4_book::ENTRY_COUNT,
                        book.entry_count as u64,
                        &[("count", &grouped(book.entry_count as u64, locale))],
                    )),
            )
    };
    let progress_row = book
        .has_book
        .then_some(book.words)
        .flatten()
        .and_then(|words| progress(words, book.word_target))
        .map(|value| {
            let target = book.word_target.unwrap_or(0).max(0) as u64;
            let book_id = book.id.clone();
            div()
                .id(ElementId::Name(
                    format!("shelf-progress-wrap-{}", book.id).into(),
                ))
                .debug_selector(move || format!("shelf-progress-wrap-{book_id}"))
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
    // The last 30 days: their words and a strip of sand (book-enabled projects only).
    let strip = book.has_book.then_some(art).flatten().map(|art| {
        let recent = art.recent(&book.id);
        let total: u64 = recent.iter().sum();
        let words = grouped(total, locale);
        let sum: SharedString = if total > 0 {
            format!("+{words} {}", t(cx, keys::project_picker::desk::WORDS_UNIT)).into()
        } else {
            "—".into()
        };
        let book_id = book.id.clone();
        div()
            .id(ElementId::Name(
                format!("shelf-strip-wrap-{}", book.id).into(),
            ))
            .debug_selector(move || format!("shelf-strip-wrap-{book_id}"))
            .mt_auto()
            .pt(px(14.0))
            .flex()
            .flex_col()
            .gap(px(6.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .font_role(Role::Index)
                    .type_px(11.0, 11.0)
                    .text_color(p.ink(4).solid())
                    .child(t(cx, keys::project_picker::desk::RECENT))
                    .child(sum),
            )
            .child(SandStrip::new(
                ElementId::Name(format!("shelf-strip-{}", book.id).into()),
                Rc::new(recent),
                cover_seed(&book.id),
                tf(
                    cx,
                    keys::project_picker::desk::RECENT_LABEL,
                    &[("words", &words)],
                ),
            ))
    });
    let recent_list =
        (!book.has_book && is_pointed && !book.recent_entries.is_empty()).then(|| {
            let book_id = book.id.clone();
            let mut rows = div()
                .id(ElementId::Name(
                    format!("shelf-recent-entries-{}", book.id).into(),
                ))
                .debug_selector(move || format!("shelf-recent-entries-{book_id}"))
                .mt_auto()
                .pt(px(10.0))
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(
                    div()
                        .font_role(Role::Index)
                        .type_px(11.0, 11.0)
                        .text_color(p.ink(4).solid())
                        .child(t(cx, keys::all_projects::RECENT_ENTRIES)),
                );
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
                                    .type_px(11.0, 11.0)
                                    .text_color(p.ink(4).solid())
                                    .child(format::ago(at, now, cx)),
                            )
                        }),
                );
            }
            rows
        });
    let has_strip = strip.is_some();
    let has_recent = recent_list.is_some();
    let progress_row = progress_row.map(|row| {
        if has_strip {
            row.mt_0().pt(px(12.0))
        } else {
            row
        }
    });
    let has_progress = progress_row.is_some();
    let status = Status::of(book.edited_ms, now);
    let (status_key, status_ink) = match status {
        Status::Writing => (keys::project_picker::status::WRITING, p.ink(2)),
        Status::Draft => (keys::project_picker::status::DRAFT, p.ink(3)),
        Status::Paused => (keys::project_picker::status::PAUSED, p.ink(4)),
    };
    let foot = div()
        .when(has_progress || has_strip || has_recent, |el| {
            el.mt(px(10.0))
        })
        .when(!has_progress && !has_strip && !has_recent, |el| {
            el.mt_auto()
        })
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
        .child({
            let id = book.id.clone();
            PanelIconButton::new(
                ElementId::Name(format!("shelf-export-{}", book.id).into()),
                Icon::ArrowOut,
            )
            .label(t(cx, keys::all_projects::EXPORT))
            .on_click(move |_, window, cx| {
                // Not the card's click too (that would open the book), as
                // edit and trash.
                cx.stop_propagation();
                window.dispatch_action(Box::new(ExportBook { book: id.clone() }), cx)
            })
        })
        .child(
            PanelIconButton::new(
                ElementId::Name(format!("shelf-trash-{}", book.id).into()),
                Icon::Trash,
            )
            .label(t(cx, keys::project_picker::desk::MOVE_TO_TRASH))
            .danger()
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
    // The cover: a slip of paper until its picture is drawn (M25).
    let cover = div()
        .flex_none()
        .w(px(dr_view_shelf_art::cover::COVER_W))
        .h(px(dr_view_shelf_art::cover::COVER_H))
        .rounded(px(2.0))
        .overflow_hidden()
        .bg(p.page.solid())
        .when_some(art.and_then(|a| a.books.get(&book.id)), |el, drawn| {
            let mut cover = ShelfCover::new(
                ElementId::Name(format!("shelf-cover-{}", book.id).into()),
                book.id.clone(),
                style,
                drawn.cover.clone(),
            );
            if let Some(genre) = &drawn.genre {
                cover = cover.label(genre.clone());
            }
            el.child(cover)
        });
    let pointed = {
        let entity = entity.clone();
        let id = book.id.clone();
        move |on: &bool, _: &mut Window, cx: &mut App| {
            entity.update(cx, |shelf, cx| shelf.point_at(&id, *on, cx))
        }
    };
    let summary = (!book.summary.trim().is_empty()).then(|| {
        div()
            .mt(px(10.0))
            .font_role(Role::Ui)
            .type_px(s.secondary, s.secondary * 1.6)
            .text_color(p.muted().solid())
            .line_clamp(2)
            // The second row ends in 「…」 when the summary goes on, as the
            // 0.1 client's two-line clamp did; it was cut mid-sentence.
            .text_ellipsis()
            .child(dr_ui::text::wrapped(book.summary.clone()))
    });
    // On the sea the sea draws the card's resting line (M24): the card is
    // bare, wrapped below.
    let sea_on = Sea::of(window, cx).is_on();
    let sample = first_run::sample_on_shelf(&book.id, cx);
    let card = if sea_on {
        div().id(id)
    } else {
        glass::glass_box(
            id,
            GlassKind::Rest,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, radius::SM),
            window,
            cx,
        )
    }
    .group(group)
    .min_h(px(CARD_MIN_H))
    .p(px(12.0))
    .flex()
    .flex_row()
    .gap(px(16.0))
    .cursor_pointer()
    .role(gpui::Role::Button)
    .aria_label(tf(
        cx,
        keys::project_picker::desk::OPEN,
        &[("name", &title)],
    ))
    .on_click(open)
    .on_mouse_down(gpui::MouseButton::Left, move |_, _, _| taken.set(true))
    .child(cover)
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
            .children(strip)
            .children(progress_row)
            .children(recent_list)
            .child(foot),
    )
    .flex_1()
    // A sample written this launch lands on its own ring once its card is
    // first drawn (M24).
    .when(sample.landing, |el| {
        el.child(
            canvas(
                |_, _, _| {},
                |bounds, _, window, cx| first_run::land_sample(bounds.center(), window, cx),
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        )
    });
    let card: AnyElement = if sea_on {
        on_sea(
            ElementId::Name(format!("shelf-card-sea-{}", book.id).into()),
            SeaGlass::resting(2.0)
                .arrive(first_run::arriving(cx))
                .waiting(sample.waiting),
            card,
        )
        .into_any_element()
    } else {
        card.into_any_element()
    };
    // The glass keeps its own hover; the heat map's follows the pointer here.
    div()
        .id(ElementId::Name(
            format!("shelf-card-place-{}", book.id).into(),
        ))
        .debug_selector({
            let id = book.id.clone();
            move || format!("shelf-card-{id}")
        })
        .flex()
        .flex_col()
        .on_hover(pointed)
        .child(card)
        .into_any_element()
}

/// The last place in the grid: a cross and a line; only the pointer brings
/// its ring of glass.
fn new_card(taken: Rc<Cell<bool>>, window: &mut Window, cx: &mut Context<Shelf>) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let entity = cx.entity();
    let sea_on = Sea::of(window, cx).is_on();
    let slot = if sea_on {
        div().id("shelf-new")
    } else {
        glass::glass_box(
            "shelf-new",
            GlassKind::Hidden,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, radius::SM),
            window,
            cx,
        )
    }
    .on_mouse_down(gpui::MouseButton::Left, move |_, _, _| taken.set(true))
    .debug_selector(|| "shelf-new-card".into())
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
    .aria_label(t(cx, keys::all_projects::NEW_PROJECT))
    .text_color(p.ink(3).solid())
    .group_hover("shelf-new", move |st| st.text_color(p.ink(1).solid()))
    .on_click(move |_, window, cx| {
        cx.stop_propagation();
        entity.update(cx, |shelf, cx| shelf.start_create(window, cx));
    })
    .child(
        div()
            .debug_selector(|| "shelf-new-plus".into())
            .child(dr_ui::sand::icon(Icon::Plus, 22.0, p.ink(3).solid())),
    )
    .child(
        div()
            .debug_selector(|| "shelf-new-label".into())
            .font_role(Role::Ui)
            .type_px(s.body, s.line_body)
            .child(t(cx, keys::all_projects::NEW_PROJECT)),
    );
    if sea_on {
        // Only what the water brings: no line at rest.
        on_sea("shelf-new-sea", SeaGlass::bare(2.0), slot).into_any_element()
    } else {
        slot.into_any_element()
    }
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
        DialogState::Create(modal) => modal.clone().into_any_element(),
        DialogState::Edit {
            book,
            name,
            summary,
        } => {
            let title = tf(
                cx,
                keys::project_picker::desk::form::EDIT_TITLE,
                &[("name", &book.name)],
            );
            let submit_label = if busy {
                t(cx, keys::common::SAVING)
            } else {
                t(cx, keys::common::SAVE)
            };
            let submit = entity.clone();
            Dialog::new("shelf-form", title)
                .body(section(
                    t(cx, keys::all_projects::NAME_LABEL),
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
        DialogState::DeleteTemplate { template } => render_delete_template_dialog(
            template,
            busy,
            error.map(IntoElement::into_any_element),
            close,
            cx,
        ),
        DialogState::DeleteModule { module } => crate::modules::render_delete_module_dialog(
            module,
            busy,
            error.map(IntoElement::into_any_element),
            close,
            cx,
        ),
        DialogState::Trash { book } => {
            let confirm = entity.clone();
            let body = if book.has_book {
                tf(
                    cx,
                    keys::project_picker::trash::BODY_WITHOUT_CHAPTERS,
                    &[
                        (
                            "words",
                            &book.words.map(|n| grouped(n, locale)).unwrap_or_else(|| {
                                t(cx, keys::workspace_word_tally::COUNTING).to_string()
                            }),
                        ),
                        ("elements", &book.elements),
                    ],
                )
            } else {
                tf(
                    cx,
                    keys::project_picker::trash::BODY_WITHOUT_BOOK,
                    &[(
                        "entries",
                        &tp(
                            cx,
                            keys::k4_book::ENTRY_COUNT,
                            book.entry_count as u64,
                            &[("count", &grouped(book.entry_count as u64, locale))],
                        ),
                    )],
                )
            };
            Dialog::new(
                "shelf-trash",
                tf(
                    cx,
                    keys::project_picker::desk::TRASH_TITLE,
                    &[("name", &book.name)],
                ),
            )
            .body(div().child(body))
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
                        .child(t(cx, keys::all_projects::TRASH_EMPTY)),
                );
            }
            for book in trashed {
                let restore = entity.clone();
                let purge = entity.clone();
                let id = book.id.clone();
                // The 0.1 shelf: days left rounded up, 「即将永久删除」 at 0.
                let expiry = match book.days_left {
                    Some(days) if days > 0 => tp(
                        cx,
                        keys::project_picker::trash::EXPIRES_IN,
                        days as u64,
                        &[],
                    ),
                    _ => t(cx, keys::project_picker::trash::EXPIRES_SOON),
                };
                list = list.child(
                    div()
                        .min_h(px(s.row_height))
                        .px(px(10.0))
                        .py(px(6.0))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.0))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .child(
                                    div()
                                        .truncate()
                                        .text_color(p.ink(1).solid())
                                        .child(book.name.clone()),
                                )
                                .child(
                                    div()
                                        .font_role(Role::Index)
                                        .type_px(s.caption, s.line_caption)
                                        .text_color(p.ink(3).solid())
                                        .child(expiry),
                                ),
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
                        )
                        .child(
                            Button::new(
                                ElementId::Name(format!("shelf-purge-{}", book.id).into()),
                                t(cx, keys::project_picker::trash::DELETE_NOW),
                            )
                            .small()
                            .danger()
                            .disabled(busy)
                            .on_click(move |_, window, cx| {
                                let book = book.clone();
                                purge.update(cx, |shelf, cx| shelf.ask_purge(book, window, cx))
                            }),
                        ),
                );
            }
            let lead = div()
                .text_color(p.muted().solid())
                .child(t(cx, keys::all_projects::TRASH_SUB));
            Dialog::new(
                "shelf-deleted",
                t(cx, keys::project_picker::desk::trash_list::TITLE),
            )
            .body(lead)
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
        DialogState::Purge { book } => {
            let confirm = entity.clone();
            let back = entity.clone();
            let step_back = move |window: &mut Window, cx: &mut App| {
                back.update(cx, |shelf, cx| shelf.step_back(window, cx))
            };
            let cancel = {
                let step_back = step_back.clone();
                move |_: &ClickEvent, window: &mut Window, cx: &mut App| step_back(window, cx)
            };
            Dialog::new(
                "shelf-purge",
                tf(
                    cx,
                    keys::project_picker::desk::trash_list::CONFIRM_TITLE,
                    &[("name", &book.name)],
                ),
            )
            .body(div().child(t(cx, keys::project_picker::trash::PERMANENT_BODY)))
            .when_some(error, |d, e| d.status(e))
            .action(
                Button::new("shelf-purge-cancel", t(cx, keys::common::CANCEL))
                    .disabled(busy)
                    .on_click(cancel),
            )
            .action(
                Button::new(
                    "shelf-purge-confirm",
                    if busy {
                        t(cx, keys::project_picker::delete::DELETING)
                    } else {
                        t(cx, keys::common::DELETE)
                    },
                )
                .danger()
                .icon(Icon::Trash)
                .busy(busy)
                .disabled(busy)
                .on_click(move |_, window, cx| {
                    confirm.update(cx, |shelf, cx| shelf.confirm_purge(window, cx))
                }),
            )
            .on_close(step_back)
            .into_any_element()
        }
    }
}
