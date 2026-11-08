//! The right sidebar's 素材库 tab (the 0.1 client's `LibraryPanel` and
//! `MaterialFolderTree`, desktop): the book's materials in the author's
//! folders.
//!
//! - **Head**: 「当前」 (only the materials related to the page in front),
//!   the count, 审阅与素材 (the Super View), 新建素材夹, and + with 笔记 (a
//!   new note, opened to write in) and 从文件导入图片或 PDF….
//! - **Rows**: folders as thin rows in the structure face (a disclosure,
//!   the folder, the name, the count of materials below it); materials as
//!   taller cells (the slip mark, a thumbnail, the title, a note's first
//!   words or the file's kind). The material open in front has the brush
//!   round it.
//! - **Clicks**: a click opens a material (a double click keeps its tab) or
//!   folds a folder; ⌘-click and ⇧-click select several (a wash under
//!   them); ⌥-click folds everything inside a folder; ⌘A selects every row,
//!   Esc lets go. New folders, notes and imports go into the folder last
//!   clicked.
//! - **Hover card** on each row, as everywhere (no right-click menu): open,
//!   open in the system's app, rename, move (every folder by its path,
//!   right in the card), new sub-folder, expand or collapse all, delete —
//!   for the whole selection when the row is part of one. Deleting asks
//!   first.
//! - **Dragging**: a row (or the selection it is part of) onto a folder
//!   moves it there; onto a material, into that material's folder; onto
//!   the empty part of the list, to the root.
//! - **Importing**: files dragged in from the system, ⌘V of a copied image
//!   or files, and the + menu's picker become materials (images and PDFs;
//!   anything else is skipped and said so), filed where they were dropped.
//!
//! The panel is two views, [`LibraryPanel`] (the rows) and [`LibraryHead`]
//! (the head row), registered with the shell by [`crate::init`]
//! (`dr_shell::pages::set_library`).

use std::collections::HashSet;
use std::path::PathBuf;
use std::rc::Rc;

use dr_i18n::keys;
use dr_shell::book::Book;
use dr_shell::nav::{Open, Target};
use dr_shell::strings::tf;
use dr_shell::workspace::SuperView;
use dr_shell::{Workspace, t};
use dr_ui::Theme;
use dr_ui::components::{
    Button, CardAction, CardBody, EmptyState, HoverCard, IconButton, Layer, Menu, MenuItem,
    SandCell, ScopeToggle,
    overlay::{self, Dialog, Place},
};
use dr_ui::fonts::Role;
use dr_ui::input::field::{FieldEvent, TextField};
use dr_ui::sand::{self, Icon, KindMark};
use dr_ui::style::DrStyled;
use dr_ui::tokens::radius;
use dr_workspace::commands::material::{MaterialCreate, MaterialCreateIn};
use dr_workspace::commands::relation::{RelationList, RelationListIn};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{
    AnyElement, App, AppContext as _, ClickEvent, ClipboardEntry, Context, ElementId, Entity,
    ExternalPaths, FocusHandle, Focusable, InteractiveElement, IntoElement, KeyBinding,
    ParentElement, PathPromptOptions, Pixels, Point, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Task, WeakEntity, Window, actions, div,
    prelude::FluentBuilder, px,
};

use crate::card;
use crate::folders::{self, Entry, Picker, Selection, Tree};
use crate::import;

actions!(
    material_library,
    [
        /// Every row of the library.
        SelectAll,
        /// Lets go of the selection.
        ClearSelection,
        /// Imports the images or files on the clipboard.
        PasteFiles,
    ]
);

/// The key context of the library's rows.
pub const KEY_CONTEXT: &str = "MaterialLibrary";

/// The library's shortcuts: ⌘A, Esc, ⌘V (Ctrl off macOS).
pub fn bindings() -> Vec<KeyBinding> {
    let (all, paste) = if cfg!(target_os = "macos") {
        ("cmd-a", "cmd-v")
    } else {
        ("ctrl-a", "ctrl-v")
    };
    vec![
        KeyBinding::new(all, SelectAll, Some(KEY_CONTEXT)),
        KeyBinding::new("escape", ClearSelection, Some(KEY_CONTEXT)),
        KeyBinding::new(paste, PasteFiles, Some(KEY_CONTEXT)),
    ]
}

/// Rows being dragged: a selection of materials and folders. Public for
/// M23, whose cards drag materials into the same folders.
#[derive(Clone, Debug)]
pub struct MaterialDrag {
    pub selection: Selection,
    pub label: SharedString,
}

/// What follows the pointer while rows are dragged.
struct DragGhost {
    label: SharedString,
}

impl Render for DragGhost {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        div()
            .px(px(10.0))
            .py(px(4.0))
            .rounded(px(radius::SM))
            .bg(p.page.solid())
            .border_1()
            .border_color(p.hairline())
            .shadow_md()
            .font_role(Role::Ui)
            .type_px(s.secondary, s.line_body)
            .text_color(p.ink(1).solid())
            .child(self.label.clone())
    }
}

/// What a hover card's row does to the panel.
type RowAction = Rc<dyn Fn(&mut LibraryPanel, &mut Window, &mut Context<LibraryPanel>)>;

struct Renaming {
    key: String,
    field: Entity<TextField>,
    _sub: Subscription,
}

/// The rows of the 素材库 tab.
pub struct LibraryPanel {
    shell: WeakEntity<Workspace>,
    lib: Option<Library>,
    book: Rc<Book>,
    focus: FocusHandle,
    expanded: HashSet<String>,
    picker: Picker,
    /// Where new folders, notes and imports go.
    current_folder: Option<String>,
    renaming: Option<Renaming>,
    related_only: bool,
    /// The page the related materials were read for, and them.
    related: Option<(String, HashSet<String>)>,
    importing: usize,
    menu: Option<Point<Pixels>>,
    /// A row to rename as soon as it is drawn (a folder just made).
    rename_when_shown: Option<String>,
    /// A row whose hover card is held open (captures, tests).
    card_open: Option<String>,
    pending: Vec<Task<()>>,
    _subs: Vec<Subscription>,
}

impl Focusable for LibraryPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// Runs `work` on the library off the main thread, then `done` on the
/// panel.
fn spawn_lib<R: Send + 'static>(
    lib: Option<Library>,
    cx: &mut Context<LibraryPanel>,
    work: impl FnOnce(&Library) -> R + Send + 'static,
    done: impl FnOnce(&mut LibraryPanel, R, &mut Context<LibraryPanel>) + 'static,
) {
    let Some(lib) = lib else {
        return;
    };
    let task = cx.background_executor().spawn(async move { work(&lib) });
    cx.spawn(async move |this, cx| {
        let out = task.await;
        this.update(cx, |p, cx| done(p, out, cx)).ok();
    })
    .detach();
}

impl LibraryPanel {
    pub fn new(
        shell: WeakEntity<Workspace>,
        lib: Option<Library>,
        book: Rc<Book>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> LibraryPanel {
        let mut subs = Vec::new();
        if shell.upgrade().is_some() {
            // Made while the workspace draws: its book is read once that
            // drawing is done.
            cx.spawn(async move |this, cx| {
                this.update(cx, |p, cx| {
                    if let Some(ws) = p.shell.upgrade() {
                        let book = ws.read(cx).book.clone();
                        p.set_book(book, cx);
                    }
                })
                .ok()
            })
            .detach();
        }
        if let Some(ws) = shell.upgrade() {
            // The shell reads the book again after every change, and the
            // page in front changes with the tabs.
            subs.push(cx.observe(&ws, |panel, ws, cx| {
                let book = ws.read(cx).book.clone();
                if !Rc::ptr_eq(&book, &panel.book) {
                    panel.book = book;
                    panel.related = None;
                    let order = panel.order();
                    panel.picker.keep(&order);
                    cx.notify();
                }
                panel.keep_related(cx);
            }));
        }
        LibraryPanel {
            shell,
            lib,
            book,
            focus: cx.focus_handle(),
            expanded: HashSet::new(),
            picker: Picker::default(),
            current_folder: None,
            renaming: None,
            related_only: false,
            related: None,
            importing: 0,
            menu: None,
            rename_when_shown: None,
            card_open: None,
            pending: Vec::new(),
            _subs: subs,
        }
    }

    fn book_id(&self) -> String {
        self.book.id.clone()
    }

    pub fn book(&self) -> &Rc<Book> {
        &self.book
    }

    /// Shows another book's lists (the shell's, or a test's).
    pub fn set_book(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
        self.book = book;
        self.related = None;
        let order = self.order();
        self.picker.keep(&order);
        cx.notify();
    }

    /// The page in front, as a target the library's relations use.
    fn front(&self, cx: &App) -> Option<Target> {
        let ws = self.shell.upgrade()?;
        ws.read(cx).nav.current().cloned()
    }

    /// The material open in front, if one is.
    fn active(&self, cx: &App) -> Option<String> {
        match self.front(cx)? {
            Target::Material(id) => Some(id.to_string()),
            _ => None,
        }
    }

    pub fn related_only(&self) -> bool {
        self.related_only
    }

    pub fn set_related_only(&mut self, on: bool, cx: &mut Context<Self>) {
        self.related_only = on;
        self.keep_related(cx);
        cx.notify();
    }

    /// Reads which materials relate to the page in front, when the filter
    /// is on and the page changed.
    fn keep_related(&mut self, cx: &mut Context<Self>) {
        if !self.related_only {
            return;
        }
        let Some(front) = self.front(cx) else {
            self.related = None;
            return;
        };
        let key = front.key();
        if self.related.as_ref().is_some_and(|(k, _)| *k == key) {
            return;
        }
        let Some(target) = dr_view_review::target_of(&dr_shell::book::nav_target(&front)) else {
            return;
        };
        let (lib, book) = (self.lib.clone(), self.book_id());
        let Some(lib) = lib else {
            return;
        };
        let task = cx.background_executor().spawn(async move {
            let input = RelationListIn {
                book,
                entity: Some(target.clone()),
                relation_type: None,
            };
            lib.run::<RelationList>(&Actor::User, input)
                .map(|o| {
                    o.output
                        .into_iter()
                        .flat_map(|r| [r.from, r.to])
                        .filter(|t| t.kind == "material" && *t != target)
                        .map(|t| t.id)
                        .collect::<HashSet<String>>()
                })
                .unwrap_or_default()
        });
        self.pending.push(cx.spawn(async move |this, cx| {
            let related = task.await;
            this.update(cx, |p, cx| {
                p.related = Some((key, related));
                cx.notify();
            })
            .ok();
        }));
    }

    /// The materials the filter shows (`None`: all).
    fn shown(&self) -> Option<&HashSet<String>> {
        if !self.related_only {
            return None;
        }
        self.related.as_ref().map(|(_, ids)| ids)
    }

    /// The rows as shown.
    pub fn entries(&self) -> Vec<Entry> {
        let shown = self.shown();
        Tree::new(&self.book.folders, &self.book.materials, shown)
            .entries(&self.expanded, shown.is_some())
    }

    fn order(&self) -> Vec<String> {
        self.entries().iter().map(Entry::key).collect()
    }

    pub fn picker(&self) -> &Picker {
        &self.picker
    }

    pub fn current_folder(&self) -> Option<&str> {
        self.current_folder.as_deref()
    }

    pub fn importing(&self) -> bool {
        self.importing > 0
    }

    pub fn is_open(&self, folder: &str) -> bool {
        self.expanded.contains(folder)
    }

    pub fn set_open(&mut self, folder: &str, open: bool, cx: &mut Context<Self>) {
        if open {
            self.expanded.insert(folder.to_owned());
        } else {
            self.expanded.remove(folder);
        }
        cx.notify();
    }

    /// Everything inside `folder` open or closed.
    pub fn set_open_all(&mut self, folder: &str, open: bool, cx: &mut Context<Self>) {
        let ids = Tree::new(&self.book.folders, &self.book.materials, None).subtree(folder);
        for id in ids {
            if open {
                self.expanded.insert(id);
            } else {
                self.expanded.remove(&id);
            }
        }
        cx.notify();
    }

    /// A click on row `key` (⌘ / ⇧ / ⌥ as the event says).
    pub fn click(
        &mut self,
        key: &str,
        e: &ClickEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus, cx);
        let m = e.modifiers();
        let command = m.platform || m.control;
        if let Some(id) = key.strip_prefix("f:")
            && m.alt
        {
            let open = !self.is_open(id);
            self.set_open_all(id, open, cx);
            return;
        }
        let order = self.order();
        if !self.picker.click(key, command, m.shift, &order) {
            cx.notify();
            return;
        }
        if let Some(id) = key.strip_prefix("f:") {
            self.current_folder = Some(id.to_owned());
            let open = !self.is_open(id);
            self.set_open(id, open, cx);
        } else if let Some(id) = key.strip_prefix("i:") {
            self.current_folder = self
                .book
                .materials
                .iter()
                .find(|m| m.id == id)
                .and_then(|m| m.folder.clone())
                .filter(|f| self.book.folders.iter().any(|x| &x.id == f));
            let how = if e.click_count() > 1 {
                Open::KEEP
            } else {
                Open::PREVIEW
            };
            self.open(id, how, cx);
        }
        cx.notify();
    }

    fn open(&mut self, material: &str, how: Open, cx: &mut Context<Self>) {
        let Ok(id) = material.parse() else {
            return;
        };
        if let Some(ws) = self.shell.upgrade() {
            ws.update(cx, |ws, cx| {
                ws.super_view = None;
                ws.open(Target::Material(id), how, cx)
            });
        }
    }

    /// Holds row `key`'s hover card open (`None`: back to the pointer).
    pub fn show_card(&mut self, key: Option<String>, cx: &mut Context<Self>) {
        self.card_open = key;
        cx.notify();
    }

    /// Selects rows `keys` (`f:` folders, `i:` materials).
    pub fn select(&mut self, keys: Vec<String>, cx: &mut Context<Self>) {
        self.picker.anchor = keys.last().cloned();
        self.picker.selected = keys;
        cx.notify();
    }

    pub fn select_all(&mut self, cx: &mut Context<Self>) {
        let order = self.order();
        self.picker.all(&order);
        cx.notify();
    }

    pub fn clear_selection(&mut self, cx: &mut Context<Self>) {
        self.picker.clear();
        cx.notify();
    }

    /// Moves `sel` into `folder` (`None`: the root) and opens the folder.
    pub fn move_to(&mut self, sel: Selection, folder: Option<String>, cx: &mut Context<Self>) {
        if sel.is_empty() {
            return;
        }
        if let Some(f) = &folder {
            self.expanded.insert(f.clone());
        }
        let book = self.book_id();
        spawn_lib(
            self.lib.clone(),
            cx,
            move |lib| folders::move_to(lib, &book, &sel, folder.as_deref()),
            |p, done, cx| {
                if let Err(e) = done {
                    log::warn!("material: move: {e}");
                }
                p.picker.clear();
                cx.notify();
            },
        );
    }

    /// A new folder in `parent`, then its name to type.
    pub fn new_folder(&mut self, parent: Option<String>, cx: &mut Context<Self>) {
        let name = t(cx, keys::material_folders::UNTITLED).to_string();
        let book = self.book_id();
        if let Some(p) = &parent {
            self.expanded.insert(p.clone());
        }
        spawn_lib(
            self.lib.clone(),
            cx,
            move |lib| folders::create_folder(lib, &book, &name, parent.as_deref()),
            |p, made, cx| match made {
                Ok(id) => {
                    p.current_folder = Some(id.clone());
                    // Named once its row is there (the book is read again
                    // after the write).
                    p.rename_when_shown = Some(folders::folder_key(&id));
                    cx.notify();
                }
                Err(e) => log::warn!("material: new folder: {e}"),
            },
        );
    }

    /// A new note in the current folder, opened to write in.
    pub fn new_note(&mut self, cx: &mut Context<Self>) {
        let (book, folder) = (self.book_id(), self.current_folder.clone());
        spawn_lib(
            self.lib.clone(),
            cx,
            move |lib| {
                lib.run::<MaterialCreate>(
                    &Actor::User,
                    MaterialCreateIn {
                        book,
                        kind: "text".into(),
                        title: String::new(),
                        asset: None,
                        folder,
                        place: None,
                        description: String::new(),
                        text: None,
                    },
                )
                .map(|o| o.output.id)
                .map_err(|e| e.to_string())
            },
            |p, made, cx| match made {
                Ok(id) => p.open(&id, Open::KEEP, cx),
                Err(e) => log::warn!("material: new note: {e}"),
            },
        );
    }

    fn name_of(&self, key: &str) -> String {
        if let Some(id) = key.strip_prefix("f:") {
            return self
                .book
                .folders
                .iter()
                .find(|f| f.id == id)
                .map(|f| f.name.clone())
                .unwrap_or_default();
        }
        let id = key.strip_prefix("i:").unwrap_or(key);
        self.book
            .materials
            .iter()
            .find(|m| m.id == id)
            .map(|m| m.title.clone())
            .unwrap_or_default()
    }

    /// Row `key`'s name in a field, the caret in it.
    pub fn start_rename(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.name_of(key);
        let field = cx.new(|cx| {
            TextField::new(
                ElementId::Name(format!("library-rename-{key}").into()),
                window,
                cx,
            )
            .small()
            .with_text(name)
        });
        let k = key.to_owned();
        let sub = cx.subscribe_in(
            &field,
            window,
            move |p, field, e: &FieldEvent, window, cx| match e {
                FieldEvent::Submitted(_) | FieldEvent::Blurred => {
                    let text = field.read(cx).text();
                    p.finish_rename(&k, Some(text), window, cx);
                }
                FieldEvent::Cancelled => p.finish_rename(&k, None, window, cx),
                FieldEvent::Changed(_) => {}
            },
        );
        let handle = field.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
        self.renaming = Some(Renaming {
            key: key.to_owned(),
            field,
            _sub: sub,
        });
        cx.notify();
    }

    fn finish_rename(
        &mut self,
        key: &str,
        text: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.renaming.as_ref().is_none_or(|r| r.key != key) {
            return;
        }
        self.renaming = None;
        window.focus(&self.focus, cx);
        cx.notify();
        let Some(name) = text.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) else {
            return;
        };
        if name == self.name_of(key) {
            return;
        }
        let (book, key) = (self.book_id(), key.to_owned());
        spawn_lib(
            self.lib.clone(),
            cx,
            move |lib| match key.strip_prefix("f:") {
                Some(id) => folders::rename_folder(lib, &book, id, &name),
                None => folders::rename_material(lib, &book, key.trim_start_matches("i:"), &name),
            },
            |_, done, _| {
                if let Err(e) = done {
                    log::warn!("material: rename: {e}");
                }
            },
        );
    }

    pub fn renaming(&self) -> Option<&str> {
        self.renaming.as_ref().map(|r| r.key.as_str())
    }

    /// The field a row's name is being typed in.
    pub fn renaming_field(&self) -> Option<&Entity<TextField>> {
        self.renaming.as_ref().map(|r| &r.field)
    }

    /// Asks before deleting `sel` (deleted materials can be brought back
    /// with undo or history; folders give what is in them to their parent).
    pub fn ask_delete(&mut self, sel: Selection, cx: &mut Context<Self>) {
        if sel.is_empty() {
            return;
        }
        let question = if sel.len() > 1 {
            tf(
                cx,
                keys::material_folders::DELETE_SELECTION_CONFIRM,
                &[("count", &sel.len())],
            )
        } else if let Some(f) = sel.folders.first() {
            let name = self.name_of(&folders::folder_key(f));
            tf(
                cx,
                keys::material_folders::DELETE_CONFIRM,
                &[("name", &name)],
            )
        } else {
            let id = &sel.materials[0];
            let mut title = self.name_of(&folders::material_key(id));
            if title.trim().is_empty() {
                title = t(cx, keys::top_timeline::untitled::LIBRARY_ITEM).to_string();
            }
            tf(
                cx,
                keys::material_editor::DELETE_CONFIRM,
                &[("title", &title)],
            )
        };
        let panel = cx.entity().downgrade();
        let ask = cx.new(|_| AskDelete {
            question,
            selection: sel,
            panel,
        });
        dr_shell::dialogs::show(cx, ask.into());
    }

    /// Deletes `sel` now (after the question).
    pub fn delete(&mut self, sel: Selection, cx: &mut Context<Self>) {
        let book = self.book_id();
        if sel
            .folders
            .iter()
            .any(|f| self.current_folder.as_deref() == Some(f.as_str()))
        {
            self.current_folder = None;
        }
        spawn_lib(
            self.lib.clone(),
            cx,
            move |lib| folders::delete(lib, &book, &sel),
            |p, done, cx| {
                if let Err(e) = done {
                    log::warn!("material: delete: {e}");
                }
                p.picker.clear();
                cx.notify();
            },
        );
    }

    /// Imports `paths` into `folder`; says what was skipped.
    pub fn import_paths(
        &mut self,
        paths: Vec<PathBuf>,
        folder: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if paths.is_empty() {
            return;
        }
        self.importing += 1;
        if let Some(f) = &folder {
            self.expanded.insert(f.clone());
        }
        cx.notify();
        let book = self.book_id();
        spawn_lib(
            self.lib.clone(),
            cx,
            move |lib| import::import_paths(lib, &book, folder.as_deref(), &paths),
            |p, report, cx| {
                p.importing -= 1;
                p.report(&report.skipped, cx);
                cx.notify();
            },
        );
    }

    fn report(&mut self, skipped: &[(PathBuf, String)], cx: &mut Context<Self>) {
        if skipped.is_empty() {
            return;
        }
        let names: Vec<String> = skipped
            .iter()
            .map(|(p, _)| {
                p.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            })
            .collect();
        let text = tf(
            cx,
            keys::memo_material::error::PICK_FAILED,
            &[("error", &names.join("、"))],
        );
        if let Some(ws) = self.shell.upgrade() {
            ws.update(cx, |ws, cx| ws.toast(text, cx));
        }
    }

    /// ⌘V: a copied image, or copied files, into the current folder.
    pub fn paste(&mut self, cx: &mut Context<Self>) {
        let Some(item) = cx.read_from_clipboard() else {
            return;
        };
        let folder = self.current_folder.clone();
        for entry in item.entries() {
            match entry {
                ClipboardEntry::ExternalPaths(paths) => {
                    self.import_paths(paths.paths().to_vec(), folder.clone(), cx)
                }
                ClipboardEntry::Image(image) => {
                    let bytes = image.bytes().to_vec();
                    let title = t(cx, keys::material_editor::embed::PASTED_IMAGE).to_string();
                    self.importing += 1;
                    let (book, folder) = (self.book_id(), folder.clone());
                    spawn_lib(
                        self.lib.clone(),
                        cx,
                        move |lib| {
                            import::import_bytes(lib, &book, folder.as_deref(), bytes, &title)
                        },
                        |p, done, cx| {
                            p.importing -= 1;
                            if let Err(e) = done {
                                log::warn!("material: paste: {e}");
                                p.report(&[(PathBuf::from(e), String::new())], cx);
                            }
                            cx.notify();
                        },
                    );
                }
                _ => {}
            }
        }
        cx.notify();
    }

    /// The + menu's picker: images and PDFs from anywhere.
    pub fn pick_files(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: None,
        });
        let folder = self.current_folder.clone();
        self.pending.push(cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            this.update(cx, |p, cx| p.import_paths(paths, folder, cx))
                .ok();
        }));
    }

    fn open_in_system(&self, material: &str, cx: &mut App) {
        let Some(lib) = &self.lib else {
            return;
        };
        let Some(asset) = self
            .book
            .materials
            .iter()
            .find(|m| m.id == material)
            .and_then(|m| m.asset.clone())
        else {
            return;
        };
        if let Ok(Some(record)) = lib
            .library()
            .asset(&asset, dr_store::asset::Variant::Source)
        {
            cx.open_with_system(&record.path);
        }
    }

    fn open_menu(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        self.menu = Some(at);
        cx.notify();
    }

    fn close_menu(&mut self, cx: &mut Context<Self>) {
        self.menu = None;
        cx.notify();
    }

    // Drawing.

    /// The folder a drop on row `entry` goes into.
    fn drop_folder(&self, entry: &Entry) -> Option<String> {
        match entry {
            Entry::Folder { id, .. } => Some(id.clone()),
            Entry::Material { id, .. } => self
                .book
                .materials
                .iter()
                .find(|m| &m.id == id)
                .and_then(|m| m.folder.clone())
                .filter(|f| self.book.folders.iter().any(|x| &x.id == f)),
        }
    }

    fn row(
        &self,
        entry: &Entry,
        active: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let key = entry.key();
        let this = cx.entity();
        let selected = self.picker.is_selected(&key);
        let is_active = matches!(entry, Entry::Material { id, .. } if Some(id.as_str()) == active);
        let rid = |part: &str| ElementId::Name(format!("library-{part}-{key}").into());

        let cell: AnyElement = if let Some(r) = self.renaming.as_ref().filter(|r| r.key == key) {
            div()
                .h(px(theme.scale.row_height))
                .px(px(10.0))
                .flex()
                .items_center()
                .child(div().flex_1().child(r.field.clone()))
                .into_any_element()
        } else {
            let (k, click) = (key.clone(), this.clone());
            let on_click = move |e: &ClickEvent, window: &mut Window, cx: &mut App| {
                click.update(cx, |p, cx| p.click(&k, e, window, cx))
            };
            match entry {
                Entry::Folder {
                    id: _,
                    name,
                    open,
                    count,
                    ..
                } => {
                    let lead = div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(4.0))
                        .child(sand::icon(
                            if *open {
                                Icon::ChevronDown
                            } else {
                                Icon::ChevronRight
                            },
                            11.0,
                            p.ink(4).solid(),
                        ))
                        .child(sand::icon(
                            if *open {
                                Icon::FolderOpen
                            } else {
                                Icon::Folder
                            },
                            14.0,
                            p.ink(3).solid(),
                        ));
                    SandCell::new(rid("cell"), name.clone())
                        .font(Role::Structure)
                        .lead(lead)
                        .child(
                            div()
                                .flex_none()
                                .font_role(Role::Index)
                                .type_px(theme.scale.caption, theme.scale.line_caption)
                                .text_color(p.muted().solid())
                                .child(count.to_string()),
                        )
                        .on_click(on_click)
                        .into_any_element()
                }
                Entry::Material { id, .. } => {
                    let Some(m) = self.book.materials.iter().find(|m| &m.id == id) else {
                        return div().into_any_element();
                    };
                    let title: SharedString = if m.title.trim().is_empty() {
                        t(cx, keys::top_timeline::untitled::LIBRARY_ITEM)
                    } else {
                        m.title.clone().into()
                    };
                    let sub = card::subline(m, cx);
                    let lead = div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .child(KindMark::new(rid("mark"), sand::Kind::Material))
                        .child(card::thumb(m, 32.0, window, cx));
                    SandCell::new(rid("cell"), title)
                        .lead(lead)
                        .subline(sub)
                        .selected(is_active)
                        .on_click(on_click)
                        .into_any_element()
                }
            }
        };

        let target = self.picker.target(&key);
        let label: SharedString = if target.len() > 1 {
            tf(
                cx,
                keys::memo_material::toolbar::COUNT,
                &[("count", &target.len())],
            )
        } else {
            self.name_of(&key).into()
        };
        let drag = MaterialDrag {
            selection: target,
            label,
        };
        let into = self.drop_folder(entry);
        let (into_a, into_b) = (into.clone(), into);
        let wash = p.accent.alpha(0.12);
        let card_id = ElementId::Name(format!("library-card-{key}").into());
        let (card_entity, card_key) = (this.clone(), key.clone());
        let card = move |window: &mut Window, cx: &mut App| {
            card_entity.update(cx, |p, cx| p.card(&card_key, window, cx))
        };
        let with_card = if self.renaming.is_some() {
            cell
        } else {
            HoverCard::new(card_id, cell, card)
                .force_open(self.card_open.as_deref() == Some(key.as_str()))
                .into_any_element()
        };
        div()
            .id(rid("row"))
            .pl(px(entry.depth() as f32 * 14.0))
            .rounded(px(radius::SM))
            .when(selected && !is_active, |d| d.bg(p.accent.alpha(0.08)))
            .on_drag(drag, |drag, _, _, cx| {
                cx.new(|_| DragGhost {
                    label: drag.label.clone(),
                })
            })
            .drag_over::<MaterialDrag>(move |st, _, _, _| st.bg(wash))
            .on_drop(cx.listener(move |p, drag: &MaterialDrag, _, cx| {
                p.move_to(drag.selection.clone(), into_a.clone(), cx)
            }))
            .drag_over::<ExternalPaths>(move |st, _, _, _| st.bg(wash))
            .on_drop(cx.listener(move |p, paths: &ExternalPaths, _, cx| {
                p.import_paths(paths.paths().to_vec(), into_b.clone(), cx)
            }))
            .child(with_card)
            .into_any_element()
    }

    /// A row's hover card: what it is, then what can be done to it (or to
    /// the selection it is part of).
    fn card(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let this = cx.entity();
        let sel = self.picker.target(key);
        let tree = Tree::new(&self.book.folders, &self.book.materials, None);
        let id = |part: &str| ElementId::Name(format!("library-card-{part}-{key}").into());
        let title: SharedString = {
            let name = self.name_of(key);
            if name.trim().is_empty() {
                t(cx, keys::top_timeline::untitled::LIBRARY_ITEM)
            } else {
                name.into()
            }
        };
        let action = |part: &str, icon: Icon, label: SharedString, run: RowAction| {
            let entity = this.clone();
            CardAction::new(id(part), icon, label)
                .on_click(move |_, window, cx| {
                    let run = run.clone();
                    entity.update(cx, |p, cx| run(p, window, cx))
                })
                .into_any_element()
        };
        // Where it can move: the root and every folder, here in the card.
        let current = if sel.len() > 1 {
            None
        } else if let Some(f) = sel.folders.first() {
            self.book
                .folders
                .iter()
                .find(|x| &x.id == f)
                .and_then(|x| x.parent.clone())
        } else {
            sel.materials.first().and_then(|m| {
                self.book
                    .materials
                    .iter()
                    .find(|x| &x.id == m)
                    .and_then(|x| x.folder.clone())
            })
        };
        let root = t(cx, keys::material_folders::ROOT).to_string();
        let mut moves: Vec<AnyElement> = vec![
            div()
                .px(px(dr_ui::tokens::menu::HOVER_CARD_PAD))
                .font_role(Role::Index)
                .type_px(theme.scale.caption, theme.scale.line_caption)
                .text_color(theme.palette.muted().solid())
                .child(if sel.len() > 1 {
                    tf(
                        cx,
                        keys::material_folders::menu::MOVE_SELECTION,
                        &[("count", &sel.len())],
                    )
                } else {
                    t(cx, keys::material_folders::menu::MOVE)
                })
                .into_any_element(),
        ];
        let single = sel.len() <= 1;
        for (i, choice) in tree
            .choices(&sel, current.as_deref(), &root)
            .into_iter()
            .enumerate()
        {
            let (entity, s, to) = (this.clone(), sel.clone(), choice.folder.clone());
            let icon = if choice.folder.is_some() {
                Icon::Folder
            } else {
                Icon::FolderNone
            };
            let here = single && choice.current;
            let row =
                CardAction::new(id(&format!("move-{i}")), icon, choice.path.clone()).current(here);
            moves.push(if here {
                row.into_any_element()
            } else {
                row.on_click(move |_, _, cx| {
                    entity.update(cx, |p, cx| p.move_to(s.clone(), to.clone(), cx))
                })
                .into_any_element()
            });
        }
        let delete = {
            let s = sel.clone();
            let label = if sel.len() > 1 {
                tf(
                    cx,
                    keys::material_folders::menu::DELETE_SELECTION,
                    &[("count", &sel.len())],
                )
            } else if sel.folders.is_empty() {
                t(cx, keys::memo_material::menu::DELETE_MATERIAL)
            } else {
                t(cx, keys::material_folders::menu::DELETE)
            };
            let entity = this.clone();
            CardAction::new(id("delete"), Icon::Trash, label)
                .danger()
                .on_click(move |_, _, cx| entity.update(cx, |p, cx| p.ask_delete(s.clone(), cx)))
                .into_any_element()
        };
        let mut body = CardBody::new(id("body"), title);
        if sel.len() > 1 {
            return body
                .count(tf(
                    cx,
                    keys::memo_material::toolbar::COUNT,
                    &[("count", &sel.len())],
                ))
                .section(moves)
                .section(vec![delete])
                .into_any_element();
        }
        let rename = {
            let k = key.to_owned();
            action(
                "rename",
                Icon::Edit,
                t(cx, keys::material_folders::menu::RENAME),
                Rc::new(move |p, window, cx| p.start_rename(&k, window, cx)),
            )
        };
        if let Some(folder) = key.strip_prefix("f:") {
            let f = folder.to_owned();
            let mut contents = vec![{
                let f = f.clone();
                action(
                    "new-sub",
                    Icon::FolderPlus,
                    t(cx, keys::material_folders::menu::NEW_SUBFOLDER),
                    Rc::new(move |p, _, cx| p.new_folder(Some(f.clone()), cx)),
                )
            }];
            if tree.subtree(folder).len() > 1 {
                let (a, b) = (f.clone(), f.clone());
                contents.push(action(
                    "expand-all",
                    Icon::FoldingFan,
                    t(cx, keys::material_folders::menu::EXPAND_ALL),
                    Rc::new(move |p, _, cx| p.set_open_all(&a, true, cx)),
                ));
                contents.push(action(
                    "collapse-all",
                    Icon::FoldingFanClosed,
                    t(cx, keys::material_folders::menu::COLLAPSE_ALL),
                    Rc::new(move |p, _, cx| p.set_open_all(&b, false, cx)),
                ));
            }
            body = body
                .count(tf(
                    cx,
                    keys::memo_material::toolbar::COUNT,
                    &[("count", &tree.total(folder))],
                ))
                .section(contents)
                .section(vec![rename])
                .section(moves)
                .section(vec![delete]);
            return body.into_any_element();
        }
        let material = key.trim_start_matches("i:").to_owned();
        let kind = self
            .book
            .materials
            .iter()
            .find(|m| m.id == material)
            .map(|m| m.kind.clone())
            .unwrap_or_default();
        let mut view = vec![{
            let m = material.clone();
            action(
                "open",
                Icon::OpenBook,
                t(cx, keys::material_folders::menu::OPEN),
                Rc::new(move |p, _, cx| p.open(&m, Open::KEEP, cx)),
            )
        }];
        if kind != "text" {
            let m = material.clone();
            view.push(action(
                "open-system",
                Icon::ArrowOut,
                t(cx, keys::memo_material::menu::OPEN_IN_SYSTEM),
                Rc::new(move |p, _, cx| p.open_in_system(&m, cx)),
            ));
        }
        body = body
            .mark(sand::Kind::Material, None)
            .count(card::kind_label(&kind, cx))
            .section(view)
            .section(vec![rename])
            .section(moves)
            .section(vec![delete]);
        body.into_any_element()
    }
}

impl Render for LibraryPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let active = self.active(cx);
        let entries = self.entries();
        if let Some(key) = self.rename_when_shown.clone()
            && entries.iter().any(|e| e.key() == key)
        {
            self.rename_when_shown = None;
            self.start_rename(&key, window, cx);
        }
        let rows: Vec<AnyElement> = entries
            .iter()
            .map(|e| self.row(e, active.as_deref(), window, cx))
            .collect();
        let wash = p.accent.alpha(0.06);
        let empty = rows.is_empty().then(|| {
            let sentence = if self.related_only {
                t(cx, keys::memo_material::empty::NO_RELATED)
            } else {
                t(cx, keys::material_folders::EMPTY)
            };
            EmptyState::new("library-empty", sentence).icon(Icon::LibCurio)
        });
        let importing = (self.importing > 0).then(|| {
            div()
                .px(px(12.0))
                .py(px(4.0))
                .font_role(Role::Index)
                .type_px(theme.scale.caption, theme.scale.line_caption)
                .text_color(p.muted().solid())
                .child(t(cx, keys::material_editor::embed::IMPORTING))
        });
        div()
            .id("material-library")
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(|p, _: &SelectAll, _, cx| p.select_all(cx)))
            .on_action(cx.listener(|p, _: &ClearSelection, _, cx| p.clear_selection(cx)))
            .on_action(cx.listener(|p, _: &PasteFiles, _, cx| p.paste(cx)))
            .size_full()
            .flex()
            .flex_col()
            .children(importing)
            .child(
                div()
                    .id("material-library-rows")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(px(12.0))
                    .pt(px(6.0))
                    .pb(px(12.0))
                    .flex()
                    .flex_col()
                    .gap(px(1.0))
                    .rounded(px(radius::SM))
                    // The empty part of the list is the root.
                    .drag_over::<MaterialDrag>(move |st, _, _, _| st.bg(wash))
                    .on_drop(cx.listener(|p, drag: &MaterialDrag, _, cx| {
                        p.move_to(drag.selection.clone(), None, cx)
                    }))
                    .drag_over::<ExternalPaths>(move |st, _, _, _| st.bg(wash))
                    .on_drop(cx.listener(|p, paths: &ExternalPaths, _, cx| {
                        let folder = p.current_folder.clone();
                        p.import_paths(paths.paths().to_vec(), folder, cx)
                    }))
                    .children(rows)
                    .children(empty)
                    .child(
                        // Below the rows: a click lets go of the selection
                        // and files new things at the root.
                        div()
                            .id("material-library-rest")
                            .flex_1()
                            .min_h(px(40.0))
                            .on_click(cx.listener(|p, _: &ClickEvent, window, cx| {
                                window.focus(&p.focus, cx);
                                p.current_folder = None;
                                p.clear_selection(cx);
                            })),
                    ),
            )
    }
}

/// The 素材库 tab's head row: 当前, the count, the Super View, 新建素材夹, +.
pub struct LibraryHead {
    panel: Entity<LibraryPanel>,
    _sub: Subscription,
}

impl LibraryHead {
    pub fn new(panel: Entity<LibraryPanel>, cx: &mut Context<Self>) -> LibraryHead {
        let sub = cx.observe(&panel, |_, _, cx| cx.notify());
        LibraryHead { panel, _sub: sub }
    }
}

impl Render for LibraryHead {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let panel = self.panel.read(cx);
        let count = panel.book.materials.len();
        let related = panel.related_only;
        let can_relate = panel.front(cx).is_some();
        let menu_at = panel.menu;
        let (toggle, folder, plus, sv) = (
            self.panel.clone(),
            self.panel.clone(),
            self.panel.clone(),
            panel.shell.clone(),
        );
        let menu = menu_at.map(|at| {
            let (note, pick, dismiss) =
                (self.panel.clone(), self.panel.clone(), self.panel.clone());
            overlay::float(
                Place::Point(at),
                Layer::Popover,
                div()
                    .id("library-new-float")
                    .occlude()
                    .on_mouse_down_out(move |_, _, cx| dismiss.update(cx, |p, cx| p.close_menu(cx)))
                    .child(
                        Menu::new("library-new-menu")
                            .section(t(cx, keys::memo_material::toolbar::NEW_MATERIAL), &theme)
                            .item(
                                MenuItem::new(
                                    "library-new-note",
                                    Icon::FileText,
                                    card::kind_label("text", cx),
                                )
                                .on_click(move |_, _, cx| {
                                    note.update(cx, |p, cx| {
                                        p.close_menu(cx);
                                        p.new_note(cx)
                                    })
                                }),
                            )
                            .item(
                                MenuItem::new(
                                    "library-import",
                                    Icon::ImagePlus,
                                    t(cx, keys::material_editor::embed::IMPORT_FILE),
                                )
                                .on_click(move |_, _, cx| {
                                    pick.update(cx, |p, cx| {
                                        p.close_menu(cx);
                                        p.pick_files(cx)
                                    })
                                }),
                            ),
                    ),
            )
        });
        div()
            .size_full()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .child(
                ScopeToggle::new(
                    "library-related",
                    t(cx, keys::review_panel::scopes::CURRENT),
                    related && can_relate,
                )
                .disabled(!can_relate)
                .on_change(move |on, _, cx| toggle.update(cx, |p, cx| p.set_related_only(on, cx))),
            )
            .child(div().flex_1())
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.ink(4).solid())
                    .child(tf(
                        cx,
                        keys::memo_material::toolbar::COUNT,
                        &[("count", &count)],
                    )),
            )
            .child(
                IconButton::new("library-super-view", Icon::LibCurio)
                    .label(t(cx, keys::bottom_status_bar::TODO_LIBRARY))
                    .on_click(move |_, _, cx| {
                        if let Some(ws) = sv.upgrade() {
                            ws.update(cx, |ws, cx| {
                                ws.toggle_super_view(SuperView::ReviewMaterials, cx)
                            });
                        }
                    }),
            )
            .child(
                IconButton::new("library-new-folder", Icon::FolderPlus)
                    .label(t(cx, keys::material_folders::menu::NEW_FOLDER))
                    .on_click(move |_, _, cx| {
                        folder.update(cx, |p, cx| {
                            let parent = p.current_folder.clone();
                            p.new_folder(parent, cx)
                        })
                    }),
            )
            .child(
                IconButton::new("library-new", Icon::Plus)
                    .label(t(cx, keys::memo_material::toolbar::NEW_MATERIAL))
                    .on_click(move |e, _, cx| {
                        let at = e.position();
                        plus.update(cx, |p, cx| p.open_menu(at, cx))
                    }),
            )
            .children(menu)
    }
}

/// 「确认」 before deleting: the question, 取消 and the danger's 确认.
struct AskDelete {
    question: SharedString,
    selection: Selection,
    panel: WeakEntity<LibraryPanel>,
}

impl Render for AskDelete {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity_id();
        let (cancel, close) = (me, me);
        let (panel, sel) = (self.panel.clone(), self.selection.clone());
        let mut dialog = Dialog::new("library-delete", t(cx, keys::common::CONFIRM));
        for paragraph in self.question.split("\n\n") {
            dialog = dialog.body(div().child(SharedString::from(paragraph.to_owned())));
        }
        dialog
            .action(
                Button::new("library-delete-cancel", t(cx, keys::common::CANCEL))
                    .on_click(move |_, _, cx| dr_shell::dialogs::hide(cx, cancel)),
            )
            .action(
                Button::new("library-delete-confirm", t(cx, keys::common::CONFIRM))
                    .danger()
                    .on_click(move |_, _, cx| {
                        dr_shell::dialogs::hide(cx, me);
                        if let Some(p) = panel.upgrade() {
                            let sel = sel.clone();
                            p.update(cx, |p, cx| p.delete(sel, cx));
                        }
                    }),
            )
            .on_close(move |_, cx| dr_shell::dialogs::hide(cx, close))
    }
}

/// The 素材库 panels the shell has made (one per pane showing the tab).
#[derive(Default)]
struct Panels(Vec<WeakEntity<LibraryPanel>>);

impl gpui::Global for Panels {}

/// The 素材库 panels open now.
pub fn panels(cx: &App) -> Vec<Entity<LibraryPanel>> {
    cx.try_global::<Panels>()
        .map(|p| p.0.iter().filter_map(WeakEntity::upgrade).collect())
        .unwrap_or_default()
}

/// The panel and its head for the shell (`dr_shell::pages::set_library`).
pub fn make(
    shell: WeakEntity<Workspace>,
    window: &mut Window,
    cx: &mut App,
) -> dr_shell::pages::LeftPanel {
    let lib = cx
        .try_global::<dr_shell::Services>()
        .and_then(|s| s.library.clone());
    // Made while the workspace draws: its book is read just after.
    let panel = cx.new(|cx| LibraryPanel::new(shell, lib, Rc::default(), window, cx));
    let made = cx.default_global::<Panels>();
    made.0.retain(|p| p.upgrade().is_some());
    made.0.push(panel.downgrade());
    let head = cx.new(|cx| LibraryHead::new(panel.clone(), cx));
    dr_shell::pages::LeftPanel {
        head: head.into(),
        body: panel.into(),
    }
}
