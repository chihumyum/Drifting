//! The right sidebar's 素材库 tab (`LibraryPanel` and `LibraryHead`, desktop):
//! format-5 file library with list & two-column masonry views, automatic
//! `当前` pinning and `其他` deduplication, nested asset folders (`素材夹`),
//! hover cards with `用在` usage jumps, and `最近删除`.

#[cfg(test)]
#[path = "library_v3_tests.rs"]
mod v3_tests;

use std::collections::HashSet;
use std::path::PathBuf;
use std::rc::Rc;

use dr_i18n::keys;
use dr_shell::book::{Book, MaterialInfo};
use dr_shell::nav::{Open, Target};
use dr_shell::strings::tf;
use dr_shell::{Settings, Workspace, t};
use dr_ui::Theme;
use dr_ui::fonts::Role;
use dr_ui::input::field::{FieldEvent, TextField};
use dr_ui::style::DrStyled;
use dr_ui::tokens::radius;
use dr_workspace::commands::asset::{AssetFolderInfo, AssetInfo};
use dr_workspace::dto::GroupInfo;
use dr_workspace::{Workspace as Library, WsEvent};
use gpui::{
    App, AppContext as _, ClickEvent, ClipboardEntry, Context, ElementId, Entity, FocusHandle,
    Focusable, IntoElement, KeyBinding, ParentElement, PathPromptOptions, Render, ScrollHandle,
    SharedString, Styled, Subscription, Task, WeakEntity, Window, actions, div, px,
};
use serde_json::json;

use crate::folders::{self, Entry, Picker, Selection, Tree};
use crate::import;
use crate::library_data::{self, CurrentItem, LibrarySnapshot, ResolvedUsage};

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

/// Device-memory key persisting list vs. masonry across restarts.
pub const VIEW_MEMORY_KEY: &str = "material-library-view";

/// List or two-column masonry (`v5-tracks.md` line 393).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ViewMode {
    #[default]
    List,
    Masonry,
}

impl ViewMode {
    pub fn from_stored(raw: Option<&str>) -> Self {
        match raw {
            Some("masonry") => Self::Masonry,
            _ => Self::List,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Masonry => "masonry",
        }
    }
}

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

/// Rows being dragged: a selection of materials and folders. Shared across the
/// library, `MediaModule`, and `dr-editor` prose drop targets.
pub type MaterialDrag = dr_ui::AssetDrag;

pub(crate) fn make_drag(book: String, sel: Selection, label: SharedString) -> MaterialDrag {
    MaterialDrag {
        book,
        assets: sel.materials,
        folders: sel.folders,
        label,
    }
}

pub(crate) fn drag_selection(drag: &MaterialDrag) -> Selection {
    Selection {
        folders: drag.folders.clone(),
        materials: drag.assets.clone(),
    }
}

/// What follows the pointer while rows are dragged.
pub(crate) struct DragGhost {
    pub(crate) label: SharedString,
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

pub(crate) struct Renaming {
    pub(crate) key: String,
    pub(crate) busy: bool,
    pub(crate) error: bool,
    pub(crate) field: Entity<TextField>,
    pub(crate) _sub: Subscription,
}

/// The rows of the 素材库 tab.
pub struct LibraryPanel {
    pub(crate) shell: WeakEntity<Workspace>,
    pub(crate) lib: Option<Library>,
    pub(crate) book: Rc<Book>,
    pub(crate) book_epoch: u64,
    pub(crate) focus: FocusHandle,
    pub(crate) scroll: ScrollHandle,
    pub(crate) list_width: f32,
    pub(crate) view_mode: ViewMode,
    /// Folder drilled into while in `ViewMode::Masonry`.
    pub(crate) masonry_folder: Option<String>,
    pub(crate) expanded: HashSet<String>,
    pub(crate) current_collapsed: bool,
    pub(crate) other_collapsed: bool,
    pub(crate) trash_collapsed: bool,
    pub(crate) picker: Picker,
    /// Where new folders and imports go by default.
    pub(crate) current_folder: Option<String>,
    pub(crate) renaming: Option<Renaming>,
    /// `(key, select_all)` to open inline rename as soon as its row is drawn.
    pub(crate) rename_when_shown: Option<(String, bool)>,
    /// Asset id to expand, scroll to, and sand-flash once drawn.
    pub(crate) pending_reveal: Option<String>,
    /// Key whose hover card has `移到素材夹` unfolded.
    pub(crate) move_open_for: Option<String>,
    /// A row whose hover card is held open (captures, tests).
    pub(crate) card_open: Option<String>,
    pub(crate) importing: usize,
    pub(crate) snapshot: Option<LibrarySnapshot>,
    pub(crate) snapshot_stale: bool,
    pub(crate) snapshot_gen: u64,
    pub(crate) snapshot_task: Option<Task<()>>,
    pub(crate) bus_sub: Option<dr_workspace::events::Subscription>,
    pub(crate) pending: Vec<Task<()>>,
    pub(crate) _subs: Vec<Subscription>,
}

impl Focusable for LibraryPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// Runs `work` on the library off the main thread, then `done` on the panel.
pub(crate) fn spawn_lib<R: Send + 'static>(
    lib: Option<Library>,
    scope: (String, u64),
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
        this.update(cx, |p, cx| {
            if p.book.id == scope.0 && p.book_epoch == scope.1 {
                done(p, out, cx);
            }
        })
        .ok();
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
        let stored_view = Settings::device_memory(cx, VIEW_MEMORY_KEY);
        let view_mode = ViewMode::from_stored(stored_view.as_ref().and_then(|v| v.as_str()));
        let pending_locate = take_queued_locate(cx);
        let mut subs = Vec::new();
        subs.push(cx.observe_global::<dr_shell::ReviewFocus>(|_, cx| cx.notify()));
        if shell.upgrade().is_some() {
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
            subs.push(cx.observe(&ws, |panel, ws, cx| {
                let book = ws.read(cx).book.clone();
                if !Rc::ptr_eq(&book, &panel.book) {
                    panel.set_book(book, cx);
                } else {
                    cx.notify();
                }
            }));
        }
        let mut panel = LibraryPanel {
            shell,
            lib,
            book: Rc::default(),
            book_epoch: 0,
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            list_width: 276.0,
            view_mode,
            masonry_folder: None,
            expanded: HashSet::new(),
            current_collapsed: false,
            other_collapsed: false,
            trash_collapsed: false,
            picker: Picker::default(),
            current_folder: None,
            renaming: None,
            rename_when_shown: None,
            pending_reveal: pending_locate,
            move_open_for: None,
            card_open: None,
            importing: 0,
            snapshot: None,
            snapshot_stale: true,
            snapshot_gen: 0,
            snapshot_task: None,
            bus_sub: None,
            pending: Vec::new(),
            _subs: subs,
        };
        if !book.id.is_empty() {
            panel.set_book(book, cx);
            // Reset epoch to 0 on initial construction so unit tests start cleanly.
            panel.book_epoch = 0;
            panel.reload_snapshot(cx);
        }
        panel
    }

    pub(crate) fn book_id(&self) -> String {
        self.book.id.clone()
    }

    pub fn book(&self) -> &Rc<Book> {
        &self.book
    }

    pub fn view_mode(&self) -> ViewMode {
        self.view_mode
    }

    pub fn set_view_mode(&mut self, mode: ViewMode, cx: &mut Context<Self>) {
        if self.view_mode == mode {
            return;
        }
        self.view_mode = mode;
        if mode == ViewMode::List {
            self.masonry_folder = None;
        }
        Settings::set_device_memory(cx, VIEW_MEMORY_KEY, Some(json!(mode.as_str())));
        cx.notify();
    }

    pub fn masonry_folder(&self) -> Option<&str> {
        self.masonry_folder.as_deref()
    }

    pub fn set_masonry_folder(&mut self, folder: Option<String>, cx: &mut Context<Self>) {
        self.current_folder = folder.clone();
        self.masonry_folder = folder;
        cx.notify();
    }

    /// Shows another book's lists (the shell's, or a test's).
    pub fn set_book(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
        let changed_book = self.book.id != book.id;
        if changed_book {
            self.book_epoch += 1;
            self.renaming = None;
            self.rename_when_shown = None;
            self.current_folder = None;
            self.masonry_folder = None;
            self.move_open_for = None;
            self.importing = 0;
            self.picker.clear();
            self.snapshot = None;
            self.watch_book(&book.id, cx);
        }
        self.book = book;
        self.snapshot_stale = true;
        if let Some(mf) = &self.masonry_folder
            && !self.live_folders().iter().any(|f| &f.id == mf)
        {
            self.masonry_folder = None;
        }
        let order = self.order();
        self.picker.keep(&order);
        self.reload_snapshot(cx);
        cx.notify();
    }

    fn watch_book(&mut self, book_id: &str, cx: &mut Context<Self>) {
        self.bus_sub = None;
        let Some(lib) = &self.lib else {
            return;
        };
        if book_id.is_empty() {
            return;
        }
        let target_book = book_id.to_owned();
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<()>();
        let sub = lib.subscribe(move |e| match e {
            WsEvent::Book(b) if b.book.to_string() == target_book => {
                let _ = tx.unbounded_send(());
            }
            WsEvent::Prose(_) => {
                let _ = tx.unbounded_send(());
            }
            _ => {}
        });
        let epoch = self.book_epoch;
        let watched_book = book_id.to_owned();
        self.pending.push(cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                while rx.try_recv().is_ok() {}
                let ok = this
                    .update(cx, |p, cx| {
                        if p.book.id == watched_book && p.book_epoch == epoch {
                            p.reload_snapshot(cx);
                        }
                    })
                    .is_ok();
                if !ok {
                    break;
                }
            }
        }));
        self.bus_sub = Some(sub);
    }

    pub(crate) fn reload_snapshot(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            self.snapshot_task = None;
            return;
        };
        let book = self.book_id();
        if book.is_empty() {
            self.snapshot_task = None;
            return;
        }
        self.snapshot_gen += 1;
        let generation = self.snapshot_gen;
        let epoch = self.book_epoch;
        let relations_label = t(cx, keys::references_panel::sections::RELATIONS).to_string();
        let untitled_label = t(cx, keys::common::UNTITLED).to_string();
        let requested_book = book.clone();
        let task = cx.background_executor().spawn(async move {
            library_data::load_snapshot(&lib, &requested_book, &relations_label, &untitled_label)
        });
        self.snapshot_task = Some(cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |p, cx| {
                if p.book.id != book || p.book_epoch != epoch || p.snapshot_gen != generation {
                    return;
                }
                match result {
                    Ok(snap) => {
                        p.snapshot = Some(snap);
                        p.snapshot_stale = false;
                        if let Some(mf) = &p.masonry_folder
                            && !p.live_folders().iter().any(|f| &f.id == mf)
                        {
                            p.masonry_folder = None;
                        }
                        let order = p.order();
                        p.picker.keep(&order);
                    }
                    Err(e) => log::warn!("material library: snapshot: {e}"),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    pub fn live_folders(&self) -> &[GroupInfo] {
        if !self.snapshot_stale
            && let Some(snap) = &self.snapshot
        {
            return &snap.live_folders;
        }
        self.book.material_folders()
    }

    pub fn live_materials(&self) -> &[MaterialInfo] {
        if !self.snapshot_stale
            && let Some(snap) = &self.snapshot
        {
            return &snap.live_materials;
        }
        self.book.material_items()
    }

    pub fn trashed_assets(&self) -> &[AssetInfo] {
        self.snapshot
            .as_ref()
            .map_or(&[], |s| s.trashed_assets.as_slice())
    }

    pub fn trashed_folders(&self) -> &[AssetFolderInfo] {
        self.snapshot
            .as_ref()
            .map_or(&[], |s| s.trashed_folders.as_slice())
    }

    pub fn asset_info(&self, id: &str) -> Option<&AssetInfo> {
        self.snapshot.as_ref()?.by_id.get(id)
    }

    pub fn usages_of(&self, id: &str) -> &[ResolvedUsage] {
        self.snapshot
            .as_ref()
            .and_then(|s| s.usages.get(id))
            .map_or(&[], Vec::as_slice)
    }

    pub(crate) fn usage_count(&self, id: &str) -> usize {
        self.usages_of(id).len()
    }

    pub(crate) fn live_count(&self) -> usize {
        self.live_materials().len()
    }

    /// The page in front on the paper.
    pub(crate) fn front(&self, cx: &App) -> Option<Target> {
        let ws = self.shell.upgrade()?;
        ws.read(cx).nav.current().cloned()
    }

    /// The material open in front, if one is.
    pub(crate) fn active(&self, cx: &App) -> Option<String> {
        match self.front(cx)? {
            Target::Material(id) => {
                let raw = id.to_string();
                Some(
                    self.book
                        .material_info(&raw)
                        .and_then(|m| m.asset.clone())
                        .unwrap_or(raw),
                )
            }
            _ => None,
        }
    }

    /// `当前` items for the entry currently open on the paper (`Empty` when a
    /// file or nothing is open, or when drilled into a masonry folder).
    pub fn current_section(&self, cx: &App) -> Vec<CurrentItem> {
        if self.view_mode == ViewMode::Masonry && self.masonry_folder.is_some() {
            return Vec::new();
        }
        let Some(Target::Entry { id, .. }) = self.front(cx) else {
            return Vec::new();
        };
        self.current_for_entry(id.as_str(), cx)
    }

    /// Computes `当前` items for an explicit `entry_id`.
    pub fn current_for_entry(&self, entry_id: &str, cx: &App) -> Vec<CurrentItem> {
        let Some(snap) = &self.snapshot else {
            return Vec::new();
        };
        let relations = t(cx, keys::references_panel::sections::RELATIONS);
        let live: HashSet<&str> = self
            .live_materials()
            .iter()
            .map(|m| m.id.as_str())
            .collect();
        snap.current_for_entry(entry_id, &relations)
            .into_iter()
            .filter(|c| live.contains(c.asset_id.as_str()))
            .collect()
    }

    /// Rows in `其他` after deduplicating `current` (`0`-count folders kept).
    pub fn other_entries_for(&self, current: &[CurrentItem]) -> Vec<Entry> {
        if current.is_empty() {
            return self.entries();
        }
        let pinned: HashSet<&str> = current.iter().map(|c| c.asset_id.as_str()).collect();
        let rest: HashSet<String> = self
            .live_materials()
            .iter()
            .filter(|m| !pinned.contains(m.id.as_str()))
            .map(|m| m.id.clone())
            .collect();
        Tree::new_ordered(self.live_folders(), self.live_materials(), Some(&rest))
            .entries(&self.expanded, false)
    }

    /// All live rows without `当前` suppression.
    pub fn entries(&self) -> Vec<Entry> {
        Tree::new_ordered(self.live_folders(), self.live_materials(), None)
            .entries(&self.expanded, false)
    }

    pub(crate) fn order(&self) -> Vec<String> {
        self.entries().iter().map(Entry::key).collect()
    }

    pub fn picker(&self) -> &Picker {
        &self.picker
    }

    pub fn current_folder(&self) -> Option<&str> {
        self.current_folder.as_deref()
    }

    pub(crate) fn target_folder(&self) -> Option<String> {
        self.masonry_folder
            .clone()
            .or_else(|| self.current_folder.clone())
            .filter(|fid| self.live_folders().iter().any(|f| &f.id == fid))
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
        let ids =
            Tree::new_ordered(self.live_folders(), self.live_materials(), None).subtree(folder);
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
            if self.view_mode == ViewMode::Masonry {
                self.masonry_folder = Some(id.to_owned());
            } else {
                let open = !self.is_open(id);
                self.set_open(id, open, cx);
            }
        } else if let Some(id) = key.strip_prefix("i:") {
            self.current_folder = self
                .live_materials()
                .iter()
                .find(|m| m.id == id)
                .and_then(|m| m.folder.clone())
                .filter(|f| self.live_folders().iter().any(|x| &x.id == f));
            let how = if e.click_count() > 1 {
                Open::KEEP
            } else {
                Open::PREVIEW
            };
            self.open(id, how, cx);
        }
        cx.notify();
    }

    pub(crate) fn open(&mut self, material: &str, how: Open, cx: &mut Context<Self>) {
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

    pub(crate) fn jump_to_usage(&mut self, usage: &ResolvedUsage, cx: &mut Context<Self>) {
        let Ok(entry_id) = usage.entry_id.parse() else {
            return;
        };
        let module = usage.module_id.as_deref().and_then(|m| m.parse().ok());
        dr_shell::pages::UsageFlash::trigger(usage.flash_keys.clone(), cx);
        if let Some(ws) = self.shell.upgrade() {
            ws.update(cx, |ws, cx| {
                ws.super_view = None;
                ws.open(
                    Target::Entry {
                        id: entry_id,
                        module,
                    },
                    Open::KEEP,
                    cx,
                );
            });
        }
    }

    /// Expands ancestor folders, clears conflicting masonry drill-down, and
    /// triggers a sand-frame flash on `asset_id`.
    pub fn reveal_and_flash_asset(&mut self, asset_id: &str, cx: &mut Context<Self>) {
        let folders = self.live_folders().to_vec();
        let folder_of = self
            .live_materials()
            .iter()
            .find(|m| m.id == asset_id)
            .and_then(|m| m.folder.clone());
        if let Some(mf) = &self.masonry_folder
            && folder_of.as_deref() != Some(mf.as_str())
        {
            self.masonry_folder = None;
        }
        let mut at = folder_of;
        let mut seen = HashSet::new();
        while let Some(fid) = at {
            if !seen.insert(fid.clone()) {
                break;
            }
            self.expanded.insert(fid.clone());
            at = folders
                .iter()
                .find(|f| f.id == fid)
                .and_then(|f| f.parent.clone());
        }
        self.current_collapsed = false;
        self.other_collapsed = false;
        let key = folders::material_key(asset_id);
        self.picker.selected = vec![key.clone()];
        self.picker.anchor = Some(key);
        dr_shell::pages::UsageFlash::trigger([format!("library-asset:{asset_id}")], cx);
        self.pending_reveal = None;
        cx.notify();
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
        self.move_open_for = None;
        let book = self.book_id();
        spawn_lib(
            self.lib.clone(),
            (self.book_id(), self.book_epoch),
            cx,
            move |lib| folders::move_to(lib, &book, &sel, folder.as_deref()),
            |p, done, cx| {
                if let Err(e) = done {
                    log::warn!("material: move: {e}");
                }
                p.picker.clear();
                p.reload_snapshot(cx);
                cx.notify();
            },
        );
    }

    /// Reorders a single dragged file onto sibling `before_material_id`.
    pub fn reorder_material_before(
        &mut self,
        dragged_id: &str,
        before_material_id: &str,
        cx: &mut Context<Self>,
    ) {
        if dragged_id == before_material_id {
            return;
        }
        let Some(target) = self
            .live_materials()
            .iter()
            .find(|m| m.id == before_material_id)
        else {
            return;
        };
        let folder = target
            .folder
            .clone()
            .filter(|fid| self.live_folders().iter().any(|f| &f.id == fid));
        let siblings: Vec<&str> = self
            .live_materials()
            .iter()
            .filter(|m| {
                let mf = m
                    .folder
                    .as_deref()
                    .filter(|fid| self.live_folders().iter().any(|f| f.id == *fid));
                mf == folder.as_deref() && m.id != dragged_id
            })
            .map(|m| m.id.as_str())
            .collect();
        let idx = siblings
            .iter()
            .position(|id| *id == before_material_id)
            .unwrap_or(siblings.len());
        let book = self.book_id();
        let id = dragged_id.to_owned();
        spawn_lib(
            self.lib.clone(),
            (self.book_id(), self.book_epoch),
            cx,
            move |lib| folders::move_asset_at(lib, &book, &id, folder.as_deref(), Some(idx)),
            |p, done, cx| {
                if let Err(e) = done {
                    log::warn!("material: reorder: {e}");
                }
                p.picker.clear();
                p.reload_snapshot(cx);
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
            (self.book_id(), self.book_epoch),
            cx,
            move |lib| folders::create_folder(lib, &book, &name, parent.as_deref()),
            |p, made, cx| match made {
                Ok(id) => {
                    p.current_folder = Some(id.clone());
                    p.rename_when_shown = Some((folders::folder_key(&id), true));
                    p.reload_snapshot(cx);
                    cx.notify();
                }
                Err(e) => log::warn!("material: new folder: {e}"),
            },
        );
    }

    pub(crate) fn name_of(&self, key: &str) -> String {
        if let Some(id) = key.strip_prefix("f:") {
            return self
                .live_folders()
                .iter()
                .find(|f| f.id == id)
                .map(|f| f.name.clone())
                .unwrap_or_default();
        }
        if let Some(id) = key.strip_prefix("tf:") {
            return self
                .trashed_folders()
                .iter()
                .find(|f| f.id == id)
                .map(|f| f.name.clone())
                .unwrap_or_default();
        }
        if let Some(id) = key.strip_prefix("ti:") {
            return self
                .trashed_assets()
                .iter()
                .find(|a| a.id == id)
                .map(|a| a.name.clone())
                .unwrap_or_default();
        }
        let id = key.strip_prefix("i:").unwrap_or(key);
        self.live_materials()
            .iter()
            .find(|m| m.id == id)
            .map(|m| m.title.clone())
            .unwrap_or_default()
    }

    /// Row `key`'s name in a field, the caret in it.
    pub fn start_rename(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.start_rename_mode(key, false, window, cx);
    }

    pub(crate) fn start_rename_mode(
        &mut self,
        key: &str,
        select_all: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.renaming.is_some() {
            return;
        }
        let name = self.name_of(key);
        let field = cx.new(|cx| {
            let mut f = TextField::new(
                ElementId::Name(format!("library-rename-{key}").into()),
                window,
                cx,
            )
            .small()
            .with_text(name);
            if select_all {
                f.select_all_text(cx);
            }
            f
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
            busy: false,
            error: false,
            field,
            _sub: sub,
        });
        cx.notify();
    }

    pub(crate) fn finish_rename(
        &mut self,
        key: &str,
        text: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.renaming.as_ref().is_none_or(|r| r.key != key) {
            return;
        }
        if self.renaming.as_ref().is_some_and(|r| r.busy) {
            return;
        }
        if let Some(name) = text
            .as_ref()
            .map(|t| t.trim().to_owned())
            .filter(|t| !t.is_empty())
            && name != self.name_of(key)
        {
            let rename = self.renaming.as_mut().expect("matched rename");
            rename.busy = true;
            rename.error = false;
            rename.field.update(cx, |f, cx| f.set_disabled(true, cx));
            window.focus(&self.focus, cx);
            let book = self.book_id();
            let key = key.to_owned();
            let writing = key.clone();
            spawn_lib(
                self.lib.clone(),
                (book.clone(), self.book_epoch),
                cx,
                move |lib| match writing.strip_prefix("f:") {
                    Some(id) => folders::rename_folder(lib, &book, id, &name),
                    None => folders::rename_material(
                        lib,
                        &book,
                        writing.trim_start_matches("i:"),
                        &name,
                    ),
                },
                move |p, done, cx| {
                    if let Some(r) = p.renaming.as_mut().filter(|r| r.key == key) {
                        r.busy = false;
                        r.field.update(cx, |f, cx| f.set_disabled(false, cx));
                        if done.is_ok() {
                            p.renaming = None;
                            p.reload_snapshot(cx);
                        } else {
                            r.error = true;
                        }
                        cx.notify();
                    }
                },
            );
            cx.notify();
            return;
        }
        self.renaming = None;
        window.focus(&self.focus, cx);
        cx.notify();
    }

    pub fn renaming(&self) -> Option<&str> {
        self.renaming.as_ref().map(|r| r.key.as_str())
    }

    /// The field a row's name is being typed in.
    pub fn renaming_field(&self) -> Option<&Entity<TextField>> {
        self.renaming.as_ref().map(|r| &r.field)
    }

    /// Moves `sel` to Recently Deleted immediately without a confirmation
    /// dialog (`v5-tracks.md` line 399).
    pub fn delete(&mut self, sel: Selection, cx: &mut Context<Self>) {
        if sel.is_empty() {
            return;
        }
        let book = self.book_id();
        if sel
            .folders
            .iter()
            .any(|f| self.current_folder.as_deref() == Some(f.as_str()))
        {
            self.current_folder = None;
        }
        if sel
            .folders
            .iter()
            .any(|f| self.masonry_folder.as_deref() == Some(f.as_str()))
        {
            self.masonry_folder = None;
        }
        spawn_lib(
            self.lib.clone(),
            (self.book_id(), self.book_epoch),
            cx,
            move |lib| folders::delete(lib, &book, &sel),
            |p, done, cx| {
                if let Err(e) = done {
                    log::warn!("material: delete: {e}");
                }
                p.picker.clear();
                p.reload_snapshot(cx);
                cx.notify();
            },
        );
    }

    pub fn restore_trashed_asset(&mut self, id: String, cx: &mut Context<Self>) {
        let book = self.book_id();
        spawn_lib(
            self.lib.clone(),
            (self.book_id(), self.book_epoch),
            cx,
            move |lib| folders::restore_asset(lib, &book, &id),
            |p, done, cx| {
                if let Err(e) = done {
                    log::warn!("material: restore asset: {e}");
                }
                p.reload_snapshot(cx);
                cx.notify();
            },
        );
    }

    pub fn purge_trashed_asset(&mut self, id: String, cx: &mut Context<Self>) {
        let book = self.book_id();
        spawn_lib(
            self.lib.clone(),
            (self.book_id(), self.book_epoch),
            cx,
            move |lib| folders::purge_asset(lib, &book, &id),
            |p, done, cx| {
                if let Err(e) = done {
                    log::warn!("material: purge asset: {e}");
                }
                p.reload_snapshot(cx);
                cx.notify();
            },
        );
    }

    pub fn restore_trashed_folder(&mut self, id: String, cx: &mut Context<Self>) {
        let book = self.book_id();
        spawn_lib(
            self.lib.clone(),
            (self.book_id(), self.book_epoch),
            cx,
            move |lib| folders::restore_folder(lib, &book, &id),
            |p, done, cx| {
                if let Err(e) = done {
                    log::warn!("material: restore folder: {e}");
                }
                p.reload_snapshot(cx);
                cx.notify();
            },
        );
    }

    pub fn purge_trashed_folder(&mut self, id: String, cx: &mut Context<Self>) {
        let book = self.book_id();
        spawn_lib(
            self.lib.clone(),
            (self.book_id(), self.book_epoch),
            cx,
            move |lib| folders::purge_folder(lib, &book, &id),
            |p, done, cx| {
                if let Err(e) = done {
                    log::warn!("material: purge folder: {e}");
                }
                p.reload_snapshot(cx);
                cx.notify();
            },
        );
    }

    /// Imports `paths` into `folder`; says what was skipped, and reveals +
    /// sand-flashes duplicate-byte hits (`v5-tracks.md` lines 398, 416).
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
            (self.book_id(), self.book_epoch),
            cx,
            move |lib| import::import_paths(lib, &book, folder.as_deref(), &paths),
            |p, report, cx| {
                p.importing -= 1;
                p.report(&report.skipped, cx);
                if let Some(reused) = report.imported.iter().find(|i| i.reused) {
                    p.pending_reveal = Some(reused.material.clone());
                }
                p.reload_snapshot(cx);
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

    /// ⌘V: a copied image placed at the very top with its default timestamped
    /// name selected for inline rename and a sand-frame flash (`v5-tracks.md`
    /// line 398), or copied files imported into the current folder.
    pub fn paste(&mut self, cx: &mut Context<Self>) {
        let Some(item) = cx.read_from_clipboard() else {
            return;
        };
        let folder = self.target_folder();
        for entry in item.entries() {
            match entry {
                ClipboardEntry::ExternalPaths(paths) => {
                    self.import_paths(paths.paths().to_vec(), folder.clone(), cx)
                }
                ClipboardEntry::Image(image) => {
                    let bytes = image.bytes().to_vec();
                    let prefix = t(cx, keys::v5_files::PASTED_IMAGE).to_string();
                    let title = import::pasted_image_title(&prefix);
                    self.importing += 1;
                    let (book, folder) = (self.book_id(), folder.clone());
                    spawn_lib(
                        self.lib.clone(),
                        (self.book_id(), self.book_epoch),
                        cx,
                        move |lib| {
                            let out =
                                import::import_bytes(lib, &book, folder.as_deref(), bytes, &title)?;
                            if !out.reused {
                                let _ = folders::move_asset_at(
                                    lib,
                                    &book,
                                    &out.material,
                                    folder.as_deref(),
                                    Some(0),
                                );
                            }
                            Ok::<_, String>(out)
                        },
                        |p, done, cx| {
                            p.importing -= 1;
                            match done {
                                Ok(imported) => {
                                    let id = imported.material;
                                    p.pending_reveal = Some(id.clone());
                                    if !imported.reused {
                                        p.rename_when_shown =
                                            Some((folders::material_key(&id), true));
                                    }
                                    p.reload_snapshot(cx);
                                }
                                Err(e) => {
                                    log::warn!("material: paste: {e}");
                                    p.report(&[(PathBuf::from(e), String::new())], cx);
                                }
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

    /// The header `+` button: picks images and PDFs directly (`v5-tracks.md`
    /// line 393 — no intermediate menu).
    pub fn pick_files(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: None,
        });
        let folder = self.target_folder();
        self.pending.push(cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            this.update(cx, |p, cx| p.import_paths(paths, folder, cx))
                .ok();
        }));
    }

    pub(crate) fn open_in_system(&self, material: &str, cx: &mut App) {
        let Some(lib) = &self.lib else {
            return;
        };
        let asset = self
            .live_materials()
            .iter()
            .find(|m| m.id == material)
            .and_then(|m| m.asset.clone())
            .unwrap_or_else(|| material.to_owned());
        if let Ok(Some(record)) = lib
            .library()
            .asset(&asset, dr_store::asset::Variant::Source)
        {
            cx.open_with_system(&record.path);
        }
    }
}

/// The 素材库 panels the shell has made (one per pane showing the tab).
#[derive(Default)]
struct Panels {
    open: Vec<WeakEntity<LibraryPanel>>,
    pending_locate: Option<String>,
}

impl gpui::Global for Panels {}

fn take_queued_locate(cx: &mut App) -> Option<String> {
    let from_panels = cx
        .try_global::<Panels>()
        .and_then(|p| p.pending_locate.clone());
    if from_panels.is_some() {
        cx.default_global::<Panels>().pending_locate = None;
        return from_panels;
    }
    dr_shell::pages::take_pending_locate_asset(cx)
}

/// The 素材库 panels open now.
pub fn panels(cx: &App) -> Vec<Entity<LibraryPanel>> {
    cx.try_global::<Panels>()
        .map(|p| p.open.iter().filter_map(WeakEntity::upgrade).collect())
        .unwrap_or_default()
}

/// Reveals the right sidebar's 素材库 tab and flashes `asset_id` (`在素材库里找到`).
pub fn locate_asset(
    _ws: &WeakEntity<Workspace>,
    asset_id: &str,
    _window: &mut Window,
    cx: &mut App,
) {
    let mounted = panels(cx);
    if mounted.is_empty() {
        cx.default_global::<Panels>().pending_locate = Some(asset_id.to_owned());
    } else {
        for panel in mounted {
            panel.update(cx, |p, cx| p.reveal_and_flash_asset(asset_id, cx));
        }
    }
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
    let panel = cx.new(|cx| LibraryPanel::new(shell, lib, Rc::default(), window, cx));
    let made = cx.default_global::<Panels>();
    made.open.retain(|p| p.upgrade().is_some());
    made.open.push(panel.downgrade());
    let head = cx.new(|cx| crate::library_render::LibraryHead::new(panel.clone(), cx));
    dr_shell::pages::LeftPanel {
        head: head.into(),
        body: panel.into(),
    }
}
