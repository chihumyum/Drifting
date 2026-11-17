//! 「另存为项目模板」 dialog (`docs/rust-rewrite/project-templates.md` §7,
//! `docs/rust-rewrite/handoff/v5-tracks.md` PT3).
//!
//! Registered into Project Home's `set_save_project_template` slot by
//! [`crate::init`]. Holds only weak handles ([`crate::SaveProjectTemplateHost`])
//! at rest and drains any background read/write through a [`Jobs`] barrier on
//! `dr_shell::release::before_release`, so swapping or closing the library is
//! never held back by an open dialog (`v3_home_release`). One hook serves
//! every dialog: it settles and closes the ones open when the release begins.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use dr_i18n::{
    keys,
    number::{compact, grouped},
};
use dr_shell::{
    Settings,
    actions::Dismiss,
    book::Book,
    nav::Target,
    strings::{t, tf},
    v3::tabs,
};
use dr_ui::{
    Theme,
    components::{
        Button, Dialog, Menu, MenuItem,
        overlay::{self, Align, Place},
    },
    fonts::Role,
    glass::{self, Kind as GlassKind, Mode, Spec, Tone},
    input::{FieldEvent, TextArea, TextField},
    sand::{self, Icon, KindMark},
    style::DrStyled,
    tokens::{Palette, Rgb, radius},
};
use dr_workspace::{
    Actor, Workspace as Library, WsError,
    commands::{
        BookIn,
        book::BookGet,
        v3::{
            project_template::{
                ProjectTemplateList, ProjectTemplateListIn, ProjectTemplateSave,
                ProjectTemplateSaveIn, ProjectTemplateSummary,
            },
            types::{TabMount, TemplateAgentConfig},
        },
    },
};
use futures::{FutureExt, channel::oneshot, future::BoxFuture};
use gpui::{
    AnyElement, App, AppContext as _, Bounds, ClickEvent, Context, ElementId, Entity, FocusHandle,
    Focusable, Global, InteractiveElement, IntoElement, MouseButton, ParentElement, Pixels, Render,
    SharedString, StatefulInteractiveElement, Styled, Subscription, Task, WeakEntity, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::SaveProjectTemplateHost;

pub const DIALOG_WIDTH: f32 = 860.0;
const LEFT_COL_WIDTH: f32 = 400.0;
const TREE_HEIGHT: f32 = 600.0;
const OVERWRITE_MENU_WIDTH: f32 = 220.0;
const OVERWRITE_MENU_GAP: f32 = 6.0;

#[derive(Clone, Default)]
struct Jobs(Arc<Mutex<JobState>>);

#[derive(Default)]
struct JobState {
    active: usize,
    waiters: Vec<oneshot::Sender<()>>,
}

struct Lease {
    library: Option<Library>,
    jobs: Jobs,
}

impl std::ops::Deref for Lease {
    type Target = Library;

    fn deref(&self) -> &Library {
        self.library.as_ref().expect("active save-template lease")
    }
}

impl Jobs {
    fn enter(&self, library: Library) -> Lease {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).active += 1;
        Lease {
            library: Some(library),
            jobs: self.clone(),
        }
    }

    fn drained(&self) -> BoxFuture<'static, Result<(), String>> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.active == 0 {
            return async { Ok(()) }.boxed();
        }
        let (tx, rx) = oneshot::channel();
        state.waiters.push(tx);
        async {
            rx.await
                .map_err(|_| "save-template worker barrier disappeared".into())
        }
        .boxed()
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.library.take();
        let mut state = self.jobs.0.lock().unwrap_or_else(|e| e.into_inner());
        state.active = state.active.saturating_sub(1);
        if state.active == 0 {
            for tx in std::mem::take(&mut state.waiters) {
                let _ = tx.send(());
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct SaveTreeEntry {
    pub id: String,
    pub parent: Option<String>,
    pub title: String,
    pub is_skeleton: bool,
    pub is_level: bool,
    pub mark: sand::Kind,
    pub color: Option<Rgb>,
    pub tab_locked: bool,
    pub tpl_home_locked: bool,
    pub override_home: Option<String>,
    pub children: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct SaveViewItem {
    pub id: String,
    pub name: String,
}

#[derive(Clone)]
struct SaveSnapshot {
    book: Book,
    summary: String,
    roots: Vec<String>,
    entries: BTreeMap<String, SaveTreeEntry>,
    views: Vec<SaveViewItem>,
    my_templates: Vec<ProjectTemplateSummary>,
}

impl SaveSnapshot {
    fn load(lib: &Library, book_id: &str) -> Result<Self, WsError> {
        let book = Book::load(lib, book_id)?;
        let summary = lib
            .run::<BookGet>(
                &Actor::User,
                BookIn {
                    book: book_id.to_owned(),
                },
            )?
            .output
            .summary;
        let my_templates = lib
            .run::<ProjectTemplateList>(&Actor::User, ProjectTemplateListIn {})?
            .output;

        let Some(v3) = book.v3() else {
            return Err(WsError::Invalid("book is not canonical format".into()));
        };

        let mut tab_locked_ids = BTreeSet::new();
        for tab in &v3.project.tabs {
            if !tabs::is_gone(v3, &tab.mount)
                && let TabMount::Entry { entry } = &tab.mount
            {
                tab_locked_ids.insert(entry.clone());
            }
        }

        // Only live templates point anywhere: a template in the trash does not
        // hold its 「新条目住在」 level (as the data layer's
        // `forced_skeleton_entries` reads it).
        let mut tpl_home_ids = BTreeSet::new();
        for tpl in v3.templates.iter().filter(|t| t.deleted_at.is_none()) {
            if let Some(Some(home_id)) = &tpl.settings.home
                && v3.entry(home_id).is_some_and(|e| e.level)
            {
                tpl_home_ids.insert(home_id.clone());
            }
        }

        let mut entries = BTreeMap::new();
        for e in &v3.entries {
            let Ok(eid) = e.id.parse::<dr_model::id::EntryId>() else {
                continue;
            };
            let (mark, color) = book.mark(&Target::Entry {
                id: eid,
                module: None,
            });
            let children = v3
                .levels
                .get(&e.id)
                .map(|l| l.children.clone())
                .unwrap_or_default();
            let override_home = e
                .overrides
                .as_ref()
                .and_then(|ov| ov.home.as_ref())
                .and_then(|h| h.as_ref())
                .filter(|hid| v3.entry(hid).is_some_and(|target| target.level))
                .cloned();
            entries.insert(
                e.id.clone(),
                SaveTreeEntry {
                    id: e.id.clone(),
                    parent: e.parent.clone(),
                    title: e.title.clone(),
                    is_skeleton: v3.has_below(&e.id),
                    is_level: e.level,
                    mark,
                    color,
                    tab_locked: tab_locked_ids.contains(&e.id),
                    tpl_home_locked: tpl_home_ids.contains(&e.id),
                    override_home,
                    children,
                },
            );
        }

        let views = v3
            .timeline_views
            .iter()
            .filter(|v| v.deleted_at.is_none())
            .map(|v| SaveViewItem {
                id: v.id.clone(),
                name: v.name.clone(),
            })
            .collect();

        Ok(SaveSnapshot {
            roots: v3.roots.clone(),
            book,
            summary,
            entries,
            views,
            my_templates,
        })
    }
}

/// The dialogs open now, weakly, and whether their one release hook is
/// registered: a library swap settles and closes the dialogs that are open,
/// not one hook per dialog ever opened.
#[derive(Default)]
struct OpenDialogs {
    hooked: bool,
    dialogs: Vec<WeakEntity<SaveTemplateDialog>>,
}

impl Global for OpenDialogs {}

fn track(dialog: WeakEntity<SaveTemplateDialog>, cx: &mut App) {
    let open = cx.default_global::<OpenDialogs>();
    open.dialogs.retain(|d| d.upgrade().is_some());
    open.dialogs.push(dialog);
    if std::mem::replace(&mut open.hooked, true) {
        return;
    }
    dr_shell::release::before_release(cx, |cx| {
        let open = std::mem::take(&mut cx.default_global::<OpenDialogs>().dialogs);
        let mut drained = Vec::new();
        for dialog in open.iter().filter_map(WeakEntity::upgrade) {
            drained.push(dialog.update(cx, |d, _| {
                d.releasing = true;
                d.task = None;
                d.overwrite_open = false;
                d.jobs.drained()
            }));
            dr_shell::dialogs::hide(cx, dialog.entity_id());
        }
        async move {
            futures::future::join_all(drained)
                .await
                .into_iter()
                .collect::<Result<Vec<_>, _>>()
                .map(|_| ())
        }
        .boxed_local()
    });
}

/// Opens the 「另存为项目模板」 modal over the active window.
pub fn open(host: SaveProjectTemplateHost, window: &mut Window, cx: &mut App) {
    if dr_shell::release::is_releasing(cx)
        || host.book_id.is_empty()
        || host.library.upgrade().is_none()
    {
        return;
    }
    let handle = window.window_handle();
    let view = cx.new(|cx| SaveTemplateDialog::new(host, window, cx));
    dr_shell::dialogs::show_in(handle, cx, view.into());
}

pub struct SaveTemplateDialog {
    host: SaveProjectTemplateHost,
    jobs: Jobs,
    releasing: bool,
    focus: FocusHandle,
    snapshot: Option<SaveSnapshot>,
    checked: BTreeSet<String>,
    locked: BTreeSet<String>,
    direct_home_locked: BTreeSet<String>,
    collapsed: BTreeSet<String>,
    view_pins: BTreeSet<String>,
    name: Entity<TextField>,
    description: Entity<TextArea>,
    agent_name: Entity<TextField>,
    agent_description: Entity<TextField>,
    agent_instructions: Entity<TextArea>,
    overwrite_open: bool,
    overwrite_bounds: Entity<Option<Bounds<Pixels>>>,
    busy: bool,
    error: Option<dr_i18n::Key>,
    task: Option<Task<()>>,
    _subs: Vec<Subscription>,
}

impl Focusable for SaveTemplateDialog {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl SaveTemplateDialog {
    pub fn new(host: SaveProjectTemplateHost, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        let name = cx.new(|cx| TextField::new("v3-save-tpl-name-field", window, cx).small());
        let description =
            cx.new(|cx| TextArea::new("v3-save-tpl-desc-field", window, cx).framed(2.0));
        let agent_name =
            cx.new(|cx| TextField::new("v3-save-tpl-agent-name-field", window, cx).small());
        let agent_description =
            cx.new(|cx| TextField::new("v3-save-tpl-agent-desc-field", window, cx).small());
        let agent_instructions =
            cx.new(|cx| TextArea::new("v3-save-tpl-agent-inst-field", window, cx).framed(3.0));

        let mut subs = Vec::new();
        for field in [&name, &agent_name, &agent_description] {
            subs.push(cx.subscribe_in(
                field,
                window,
                |this, _, ev: &FieldEvent, window, cx| match ev {
                    FieldEvent::Cancelled => this.cancel_or_close_menu(window, cx),
                    FieldEvent::Changed(_) => cx.notify(),
                    _ => {}
                },
            ));
        }
        for area in [&description, &agent_instructions] {
            subs.push(cx.subscribe_in(
                area,
                window,
                |this, _, ev: &FieldEvent, window, cx| match ev {
                    FieldEvent::Cancelled => this.cancel_or_close_menu(window, cx),
                    FieldEvent::Changed(_) => cx.notify(),
                    _ => {}
                },
            ));
        }
        subs.push(cx.observe_global::<dr_shell::Strings>(|_, cx| cx.notify()));
        subs.push(cx.observe_global::<dr_shell::Settings>(|_, cx| cx.notify()));

        let mut dialog = Self {
            host,
            jobs: Jobs::default(),
            releasing: false,
            focus: focus.clone(),
            snapshot: None,
            checked: BTreeSet::new(),
            locked: BTreeSet::new(),
            direct_home_locked: BTreeSet::new(),
            collapsed: BTreeSet::new(),
            view_pins: BTreeSet::new(),
            name,
            description,
            agent_name,
            agent_description,
            agent_instructions,
            overwrite_open: false,
            overwrite_bounds: cx.new(|_| None),
            busy: false,
            error: None,
            task: None,
            _subs: subs,
        };
        focus.focus(window, cx);
        dialog.load(cx);
        track(cx.entity().downgrade(), cx);
        dialog
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        if self.releasing || dr_shell::release::is_releasing(cx) {
            return;
        }
        let Some(lib) = self.host.library.upgrade() else {
            self.error = Some(keys::k4_pages::SAVE_FAILED);
            return;
        };
        let lease = self.jobs.enter(lib);
        let book_id = self.host.book_id.clone();
        self.task = Some(cx.spawn(async move |this, cx| {
            let loaded = cx
                .background_executor()
                .spawn(async move { SaveSnapshot::load(&lease, &book_id) })
                .await;
            let _ = this.update(cx, |d, cx| {
                d.task = None;
                match loaded {
                    Ok(snap) => d.apply_snapshot(snap, cx),
                    Err(err) => {
                        log::warn!("save project template: failed to load book snapshot: {err}");
                        d.error = Some(keys::k4_pages::SAVE_FAILED);
                    }
                }
                cx.notify();
            });
        }));
    }

    fn apply_snapshot(&mut self, snap: SaveSnapshot, cx: &mut Context<Self>) {
        let book_name = snap.book.name.clone();
        let summary = snap.summary.clone();
        let (a_name, a_desc, a_inst) = snap
            .book
            .v3()
            .and_then(|v| v.project.agent.as_ref())
            .map(|a| {
                (
                    a.name.clone(),
                    a.description.clone(),
                    a.instructions.clone(),
                )
            })
            .unwrap_or_default();

        self.name.update(cx, |f, cx| f.set_text(book_name, cx));
        self.description.update(cx, |f, cx| f.set_text(summary, cx));
        self.agent_name.update(cx, |f, cx| f.set_text(a_name, cx));
        self.agent_description
            .update(cx, |f, cx| f.set_text(a_desc, cx));
        self.agent_instructions
            .update(cx, |f, cx| f.set_text(a_inst, cx));

        self.checked.clear();
        for entry in snap.entries.values() {
            if entry.is_skeleton {
                self.checked.insert(entry.id.clone());
            }
        }
        self.collapsed.clear();
        // The prototype's defaults (`saveDefaults`): the first view's time
        // pins are ticked, the others not.
        self.view_pins.clear();
        if let Some(first) = snap.views.first() {
            self.view_pins.insert(first.id.clone());
        }
        self.snapshot = Some(snap);
        self.recompute_locks();
    }

    /// Recomputes `locked` and `direct_home_locked` and ensures every locked
    /// entry and all of its residence ancestors are in `checked` and `locked`.
    fn recompute_locks(&mut self) {
        let Some(snap) = &self.snapshot else {
            self.locked.clear();
            self.direct_home_locked.clear();
            return;
        };

        let mut locked = BTreeSet::new();
        let mut direct_home = BTreeSet::new();

        let lock_with_ancestors =
            |start: &str, locked: &mut BTreeSet<String>, checked: &mut BTreeSet<String>| {
                let mut cur = Some(start.to_owned());
                let mut seen = BTreeSet::new();
                while let Some(id) = cur {
                    if !seen.insert(id.clone()) {
                        break;
                    }
                    locked.insert(id.clone());
                    checked.insert(id.clone());
                    cur = snap.entries.get(&id).and_then(|e| e.parent.clone());
                }
            };

        for entry in snap.entries.values() {
            if entry.tpl_home_locked {
                direct_home.insert(entry.id.clone());
            }
            if entry.tab_locked || entry.tpl_home_locked {
                lock_with_ancestors(&entry.id, &mut locked, &mut self.checked);
            }
        }

        // Fixed-point propagation for `overrides.home` on checked entries:
        // the data layer refuses to save a template that takes an entry and
        // leaves out the level its own 「新条目住在」 points at
        // (`extract_project_template`: "cannot exclude entry … because
        // included entry … sets overrides.home to it"), so that level is
        // held as the template's own pointers are.
        loop {
            let before_locked = locked.len();
            let before_checked = self.checked.len();
            let current_checked: Vec<String> = self.checked.iter().cloned().collect();
            for eid in current_checked {
                if let Some(home_id) = snap.entries.get(&eid).and_then(|e| e.override_home.clone())
                    && snap.entries.get(&home_id).is_some_and(|h| h.is_level)
                {
                    direct_home.insert(home_id.clone());
                    lock_with_ancestors(&home_id, &mut locked, &mut self.checked);
                }
            }
            if locked.len() == before_locked && self.checked.len() == before_checked {
                break;
            }
        }

        self.locked = locked;
        self.direct_home_locked = direct_home;
    }

    pub fn is_loaded(&self) -> bool {
        self.snapshot.is_some()
    }

    pub fn is_busy(&self) -> bool {
        self.busy
    }

    pub fn is_checked(&self, entry_id: &str) -> bool {
        self.checked.contains(entry_id)
    }

    pub fn is_locked(&self, entry_id: &str) -> bool {
        self.locked.contains(entry_id)
    }

    /// Direct lock-reason labels displayed on `entry_id` (empty if unlocked or
    /// locked only because a descendant is referenced).
    pub fn lock_reasons(&self, entry_id: &str, cx: &App) -> Vec<String> {
        let Some(snap) = &self.snapshot else {
            return Vec::new();
        };
        let Some(entry) = snap.entries.get(entry_id) else {
            return Vec::new();
        };
        if !self.locked.contains(entry_id) {
            return Vec::new();
        }
        let mut out = Vec::new();
        if entry.tab_locked {
            out.push(t(cx, keys::project_templates::LEFT_RAIL).to_string());
        }
        if self.direct_home_locked.contains(entry_id) {
            out.push(t(cx, keys::template_editor::HOME).to_string());
        }
        out
    }

    pub fn toggle_entry(&mut self, entry_id: &str, cx: &mut Context<Self>) {
        if self.busy || self.locked.contains(entry_id) {
            return;
        }
        let Some(snap) = &self.snapshot else {
            return;
        };
        if !snap.entries.contains_key(entry_id) {
            return;
        }
        if self.checked.contains(entry_id) {
            let mut stack = vec![entry_id.to_owned()];
            let mut seen = BTreeSet::new();
            let mut subtree = Vec::new();
            while let Some(cur) = stack.pop() {
                if !seen.insert(cur.clone()) {
                    continue;
                }
                subtree.push(cur.clone());
                if let Some(node) = snap.entries.get(&cur) {
                    for child in &node.children {
                        stack.push(child.clone());
                    }
                }
            }
            for id in subtree {
                if !self.locked.contains(&id) {
                    self.checked.remove(&id);
                }
            }
        } else {
            let mut cur = Some(entry_id.to_owned());
            let mut seen = BTreeSet::new();
            while let Some(id) = cur {
                if !seen.insert(id.clone()) {
                    break;
                }
                self.checked.insert(id.clone());
                cur = snap.entries.get(&id).and_then(|e| e.parent.clone());
            }
        }
        self.recompute_locks();
        cx.notify();
    }

    pub fn toggle_collapsed(&mut self, entry_id: &str, cx: &mut Context<Self>) {
        if !self.collapsed.remove(entry_id) {
            self.collapsed.insert(entry_id.to_owned());
        }
        cx.notify();
    }

    /// The project's views, in the order the 「时间钉」 rows show them.
    pub fn view_items(&self) -> &[SaveViewItem] {
        self.snapshot.as_ref().map_or(&[], |s| s.views.as_slice())
    }

    pub fn is_view_pin_checked(&self, view_id: &str) -> bool {
        self.view_pins.contains(view_id)
    }

    pub fn toggle_view_pin(&mut self, view_id: &str, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        if !self.view_pins.remove(view_id) {
            self.view_pins.insert(view_id.to_owned());
        }
        cx.notify();
    }

    pub fn name_input(&self) -> &Entity<TextField> {
        &self.name
    }

    pub fn description_input(&self) -> &Entity<TextArea> {
        &self.description
    }

    pub fn agent_inputs(&self) -> (&Entity<TextField>, &Entity<TextField>, &Entity<TextArea>) {
        (
            &self.agent_name,
            &self.agent_description,
            &self.agent_instructions,
        )
    }

    pub fn overwrite_templates(&self) -> &[ProjectTemplateSummary] {
        self.snapshot
            .as_ref()
            .map_or(&[], |s| s.my_templates.as_slice())
    }

    fn cancel_or_close_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.overwrite_open {
            self.overwrite_open = false;
            cx.notify();
        } else if !self.busy {
            let _ = window;
            let id = cx.entity_id();
            dr_shell::dialogs::hide(cx, id);
        }
    }

    pub fn close(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.overwrite_open = false;
        let id = cx.entity_id();
        dr_shell::dialogs::hide(cx, id);
    }

    pub fn submit_new(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.submit(None, window, cx);
    }

    pub fn submit_overwrite(
        &mut self,
        template_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.submit(Some(template_id.to_owned()), window, cx);
    }

    fn submit(&mut self, replace: Option<String>, _window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.releasing || dr_shell::release::is_releasing(cx) {
            return;
        }
        let Some(snap) = &self.snapshot else {
            return;
        };
        let Some(lib) = self.host.library.upgrade() else {
            self.error = Some(keys::k4_pages::SAVE_FAILED);
            cx.notify();
            return;
        };

        let (name, description) = if replace.is_some() {
            // Overwriting keeps the target template's original name and description.
            (None, None)
        } else {
            let raw_name = self.name.read(cx).text();
            if raw_name.trim().is_empty() {
                return;
            }
            (Some(raw_name), Some(self.description.read(cx).text()))
        };

        let a_name = self.agent_name.read(cx).text();
        let a_desc = self.agent_description.read(cx).text();
        let a_inst = self.agent_instructions.read(cx).text();
        let agent_cfg =
            if a_name.trim().is_empty() && a_desc.trim().is_empty() && a_inst.trim().is_empty() {
                None
            } else {
                Some(TemplateAgentConfig {
                    name: a_name,
                    description: a_desc,
                    instructions: a_inst,
                })
            };

        let mut exclude_skeleton = Vec::new();
        let mut sample_entries = Vec::new();
        for entry in snap.entries.values() {
            let on = self.checked.contains(&entry.id);
            if entry.is_skeleton {
                if !on {
                    exclude_skeleton.push(entry.id.clone());
                }
            } else if on {
                sample_entries.push(entry.id.clone());
            }
        }
        let view_pins: Vec<String> = self.view_pins.iter().cloned().collect();
        let locale = Some(Settings::locale(cx).code().to_owned());

        let input = ProjectTemplateSaveIn {
            book: self.host.book_id.clone(),
            name,
            description,
            locale,
            credit: None,
            agent: Some(agent_cfg),
            exclude_skeleton,
            sample_entries,
            view_pins,
            replace,
        };

        self.busy = true;
        self.overwrite_open = false;
        self.error = None;
        cx.notify();

        let lease = self.jobs.enter(lib);
        let entity_id = cx.entity_id();
        self.task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move { lease.run::<ProjectTemplateSave>(&Actor::User, input) })
                .await;
            let _ = this.update(cx, |d, cx| {
                d.busy = false;
                d.task = None;
                match res {
                    Ok(_) => {
                        dr_shell::dialogs::hide(cx, entity_id);
                    }
                    Err(err) => {
                        log::warn!("project_template.save failed: {err}");
                        d.error = Some(keys::k4_pages::SAVE_FAILED);
                        cx.notify();
                    }
                }
            });
        }));
    }

    pub fn book_summary_text(&self, cx: &App) -> String {
        let Some(snap) = &self.snapshot else {
            return String::new();
        };
        let Some(pb) = snap.book.v3().and_then(|v| v.project.book.as_ref()) else {
            return t(cx, keys::project_templates::BOOK_OFF).to_string();
        };
        let locale = Settings::locale(cx);
        let mut parts = vec![t(cx, keys::project_templates::BOOK_ON).to_string()];
        if let Some(wt) = pb.word_target.filter(|&w| w > 0) {
            parts.push(
                tf(
                    cx,
                    keys::project_templates::BOOK_WORD_TARGET,
                    &[("words", &compact(wt as u64, locale))],
                )
                .to_string(),
            );
        }
        if let Some(dt) = pb.daily_word_target.filter(|&d| d > 0) {
            parts.push(
                tf(
                    cx,
                    keys::project_templates::BOOK_DAILY_TARGET,
                    &[("words", &grouped(dt as u64, locale))],
                )
                .to_string(),
            );
        }
        parts.join(" · ")
    }

    pub fn rail_summary_text(&self, cx: &App) -> String {
        let Some(v3) = self.snapshot.as_ref().and_then(|s| s.book.v3()) else {
            return String::new();
        };
        v3.project
            .tabs
            .iter()
            .filter(|tab| !tabs::is_gone(v3, &tab.mount))
            .map(|tab| tabs::mount_name(v3, &tab.mount, cx).to_string())
            .collect::<Vec<_>>()
            .join(" · ")
    }

    fn render_tree_rows(
        &self,
        ids: &[String],
        depth: usize,
        out: &mut Vec<AnyElement>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(snap) = &self.snapshot else {
            return;
        };
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let entity = cx.entity();

        for id in ids {
            let Some(node) = snap.entries.get(id) else {
                continue;
            };
            let has_kids = !node.children.is_empty();
            let is_collapsed = self.collapsed.contains(id);
            let checked = self.checked.contains(id);
            let locked = self.locked.contains(id);
            let reasons = self.lock_reasons(id, cx);
            let title: SharedString = if node.title.trim().is_empty() {
                t(cx, keys::k4_book::UNTITLED_ENTRY)
            } else {
                node.title.clone().into()
            };

            let disc: AnyElement = if has_kids {
                let toggle_id = id.clone();
                let entity = entity.clone();
                let disc_sel = format!("v3-save-tpl-disc-{id}");
                div()
                    .id(ElementId::Name(disc_sel.clone().into()))
                    .debug_selector(move || disc_sel.clone())
                    .w(px(16.0))
                    .h(px(16.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(4.0))
                    .cursor_pointer()
                    .on_click(move |_: &ClickEvent, _, cx| {
                        cx.stop_propagation();
                        entity.update(cx, |d, cx| d.toggle_collapsed(&toggle_id, cx));
                    })
                    .child(sand::icon(
                        if is_collapsed {
                            Icon::ChevronRight
                        } else {
                            Icon::ChevronDown
                        },
                        12.0,
                        p.ink(3).solid(),
                    ))
                    .into_any_element()
            } else {
                div().w(px(16.0)).h(px(16.0)).flex_none().into_any_element()
            };

            let mark_el = {
                let km = KindMark::new(
                    ElementId::Name(format!("v3-save-tpl-mark-{id}").into()),
                    node.mark,
                );
                match node.color {
                    Some(c) => km.color(c),
                    None => km,
                }
            };

            let right_icon: AnyElement = if locked {
                div()
                    .w(px(16.0))
                    .h(px(16.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(sand::icon(Icon::LockShut, 14.0, p.ink(4).solid()))
                    .into_any_element()
            } else if checked {
                div()
                    .w(px(16.0))
                    .h(px(16.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(sand::icon(Icon::Check, 16.0, p.ink(2).solid()))
                    .into_any_element()
            } else {
                div().w(px(16.0)).h(px(16.0)).flex_none().into_any_element()
            };

            let row_id = format!("v3-save-tpl-entry-{id}");
            let row_sel = row_id.clone();
            let click_id = id.clone();
            let click_entity = entity.clone();

            let row = glass::glass_box(
                ElementId::Name(row_id.into()),
                GlassKind::Hidden,
                Mode {
                    disabled: locked || self.busy,
                    ..Mode::default()
                },
                false,
                Spec::new(Tone::Clear, radius::MENU_ROW),
                window,
                cx,
            )
            .debug_selector(move || row_sel.clone())
            .min_h(px(30.0))
            .pl(px(4.0 + depth as f32 * 16.0))
            .pr(px(8.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .rounded(px(radius::MENU_ROW))
            .font_role(Role::Ui)
            .type_px(15.0, 20.0)
            .text_color(if checked {
                p.ink(1).solid()
            } else {
                p.ink(2).solid()
            })
            .role(gpui::Role::CheckBox)
            .aria_label(title.clone())
            .aria_selected(checked)
            .when(!locked && !self.busy, |el| {
                el.cursor_pointer().on_click(move |_: &ClickEvent, _, cx| {
                    click_entity.update(cx, |d, cx| d.toggle_entry(&click_id, cx));
                })
            })
            .child(disc)
            .child(div().flex_none().child(mark_el))
            .child(div().flex_1().min_w_0().truncate().child(title))
            .when(!reasons.is_empty(), |el| {
                el.child(
                    div()
                        .flex_none()
                        .font_role(Role::Index)
                        .type_px(13.0, 18.0)
                        .text_color(p.ink(4).solid())
                        .child(reasons.join(" · ")),
                )
            })
            .child(right_icon)
            .into_any_element();

            out.push(row);

            if has_kids && !is_collapsed {
                self.render_tree_rows(&node.children, depth + 1, out, window, cx);
            }
        }
    }

    fn render_overwrite_menu(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !self.overwrite_open {
            return None;
        }
        let templates = self.overwrite_templates();
        if templates.is_empty() {
            return None;
        }
        let _ = window;
        let anchor = *self.overwrite_bounds.read(cx);
        let entity = cx.entity();
        // The prototype's list: the names alone, 220 wide, its right edge on
        // the button's and opening upward, 6px off it, so 「新建模板」 stays
        // in sight.
        let mut menu = Menu::new("v3-save-tpl-overwrite-menu").exactly(OVERWRITE_MENU_WIDTH);
        for tpl in templates {
            let tid = tpl.id.clone();
            let entity = entity.clone();
            let item_id = format!("v3-save-tpl-overwrite-item-{tid}");
            menu = menu.item(
                MenuItem::plain(ElementId::Name(item_id.into()), tpl.name.clone()).on_click(
                    move |_, window, cx| {
                        entity.update(cx, |d, cx| d.submit_overwrite(&tid, window, cx));
                    },
                ),
            );
        }
        let place = match anchor {
            Some(rect) => Place::Above {
                rect,
                align: Align::End,
                gap: OVERWRITE_MENU_GAP,
            },
            None => Place::Center,
        };
        Some(overlay::float_in_dialog(place, menu).into_any_element())
    }
}

fn label_above(label: SharedString, body: AnyElement, p: &Palette) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .gap(px(5.0))
        .child(
            div()
                .font_role(Role::Index)
                .type_px(14.0, 18.0)
                .text_color(p.ink(3).solid())
                .child(label),
        )
        .child(body)
}

fn agent_subrow(label: SharedString, field: AnyElement, top: bool, p: &Palette) -> gpui::Div {
    div()
        .flex()
        .flex_row()
        .when(top, |d| d.items_start())
        .when(!top, |d| d.items_center())
        .gap(px(10.0))
        .child(
            div()
                .w(px(98.0))
                .flex_none()
                .when(top, |d| d.pt(px(5.0)))
                .font_role(Role::Index)
                .type_px(14.0, 20.0)
                .text_color(p.ink(3).solid())
                .child(label),
        )
        .child(div().flex_1().min_w_0().child(field))
}

impl Render for SaveTemplateDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let entity = cx.entity();
        // Keep the header and actions visible on shorter windows and when
        // the project's instructions take many lines. Both panes can scroll.
        let pane_height = (window.viewport_size().height - px(150.0)).max(px(0.0));
        let tree_height = (pane_height - px(26.0)).clamp(px(0.0), px(TREE_HEIGHT));

        let mut tree_rows = Vec::new();
        if let Some(roots) = self.snapshot.as_ref().map(|s| s.roots.clone()) {
            self.render_tree_rows(&roots, 0, &mut tree_rows, window, cx);
        }

        let tree_box = div()
            .id("v3-save-tpl-tree")
            .debug_selector(|| "v3-save-tpl-tree".into())
            .w_full()
            .h(tree_height)
            .p(px(4.0))
            .bg(p.page.solid())
            .border(px(0.5))
            .border_color(p.hairline())
            .rounded(px(10.0))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .children(tree_rows);

        let left_col = div()
            .w(px(LEFT_COL_WIDTH))
            .flex_none()
            .flex()
            .flex_col()
            .child(label_above(
                t(cx, keys::k4_pages::ENTRIES),
                tree_box.into_any_element(),
                p,
            ));

        let book_summary = self.book_summary_text(cx);
        let rail_summary = self.rail_summary_text(cx);
        let views = self
            .snapshot
            .as_ref()
            .map(|s| s.views.clone())
            .unwrap_or_default();

        let mut pin_rows = Vec::with_capacity(views.len());
        for view in &views {
            let vid = view.id.clone();
            let checked = self.view_pins.contains(&vid);
            let entity = entity.clone();
            let pin_id = format!("v3-save-tpl-pin-{vid}");
            let pin_sel = pin_id.clone();
            let vname: SharedString = view.name.clone().into();
            pin_rows.push(
                glass::glass_box(
                    ElementId::Name(pin_id.into()),
                    GlassKind::Hidden,
                    Mode {
                        disabled: self.busy,
                        ..Mode::default()
                    },
                    false,
                    Spec::new(Tone::Clear, radius::MENU_ROW),
                    window,
                    cx,
                )
                .debug_selector(move || pin_sel.clone())
                .min_h(px(30.0))
                .px(px(8.0))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .rounded(px(radius::MENU_ROW))
                .font_role(Role::Ui)
                .type_px(15.0, 20.0)
                .text_color(p.ink(1).solid())
                .role(gpui::Role::CheckBox)
                .aria_label(vname.clone())
                .aria_selected(checked)
                .when(!self.busy, |el| {
                    el.cursor_pointer().on_click(move |_, _, cx| {
                        entity.update(cx, |d, cx| d.toggle_view_pin(&vid, cx));
                    })
                })
                .child(div().flex_1().min_w_0().truncate().child(vname))
                .child(if checked {
                    div()
                        .w(px(16.0))
                        .h(px(16.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(sand::icon(Icon::Check, 16.0, p.ink(2).solid()))
                        .into_any_element()
                } else {
                    div().w(px(16.0)).h(px(16.0)).flex_none().into_any_element()
                })
                .into_any_element(),
            );
        }

        let agent_box = div()
            .flex()
            .flex_col()
            .gap(px(6.0))
            .child(agent_subrow(
                t(cx, keys::template_editor::NAME),
                div()
                    .id("v3-save-tpl-agent-name")
                    .debug_selector(|| "v3-save-tpl-agent-name".into())
                    .child(self.agent_name.clone())
                    .into_any_element(),
                false,
                p,
            ))
            .child(agent_subrow(
                t(cx, keys::template_editor::DESCRIPTION),
                div()
                    .id("v3-save-tpl-agent-description")
                    .debug_selector(|| "v3-save-tpl-agent-description".into())
                    .child(self.agent_description.clone())
                    .into_any_element(),
                false,
                p,
            ))
            .child(agent_subrow(
                t(cx, keys::template_editor::INSTRUCTIONS),
                div()
                    .id("v3-save-tpl-agent-instructions")
                    .debug_selector(|| "v3-save-tpl-agent-instructions".into())
                    .child(self.agent_instructions.clone())
                    .into_any_element(),
                true,
                p,
            ));

        let right_form = div()
            .w_full()
            .flex()
            .flex_col()
            .gap(px(10.0))
            .child(label_above(
                t(cx, keys::template_editor::NAME),
                div()
                    .id("v3-save-tpl-name")
                    .debug_selector(|| "v3-save-tpl-name".into())
                    .child(self.name.clone())
                    .into_any_element(),
                p,
            ))
            .child(label_above(
                t(cx, keys::project_templates::DESCRIPTION),
                div()
                    .id("v3-save-tpl-description")
                    .debug_selector(|| "v3-save-tpl-description".into())
                    .child(self.description.clone())
                    .into_any_element(),
                p,
            ))
            .child(div().my(px(4.0)).h(px(0.5)).w_full().bg(p.hairline()))
            .child(label_above(
                t(cx, keys::template_editor::FOR_AGENT),
                agent_box.into_any_element(),
                p,
            ))
            .child(label_above(
                t(cx, keys::project_home::project_template::BOOK),
                div()
                    .id("v3-save-tpl-book-summary")
                    .debug_selector(|| "v3-save-tpl-book-summary".into())
                    .font_role(Role::Ui)
                    .type_px(15.0, 22.0)
                    .text_color(p.ink(2).solid())
                    .child(book_summary)
                    .into_any_element(),
                p,
            ))
            .child(label_above(
                t(cx, keys::project_templates::LEFT_RAIL),
                div()
                    .id("v3-save-tpl-rail-summary")
                    .debug_selector(|| "v3-save-tpl-rail-summary".into())
                    .font_role(Role::Ui)
                    .type_px(15.0, 22.0)
                    .text_color(p.ink(2).solid())
                    .child(rail_summary)
                    .into_any_element(),
                p,
            ))
            .when(!pin_rows.is_empty(), |col| {
                col.child(label_above(
                    t(cx, keys::project_templates::TIME_PINS),
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(2.0))
                        .children(pin_rows)
                        .into_any_element(),
                    p,
                ))
            });

        let grid = div()
            .w_full()
            .flex()
            .flex_row()
            .items_start()
            .gap(px(20.0))
            .on_mouse_down(MouseButton::Left, {
                let entity = entity.clone();
                move |_, _, cx| {
                    entity.update(cx, |d, cx| {
                        if d.overwrite_open {
                            d.overwrite_open = false;
                            cx.notify();
                        }
                    });
                }
            })
            .child(left_col)
            .child(
                div()
                    .id("v3-save-tpl-form-scroll")
                    .flex_1()
                    .min_w_0()
                    .max_h(pane_height)
                    .overflow_y_scroll()
                    .child(right_form),
            );

        let can_submit_new =
            !self.busy && self.snapshot.is_some() && !self.name.read(cx).text().trim().is_empty();
        let can_overwrite = !self.busy
            && self
                .snapshot
                .as_ref()
                .is_some_and(|s| !s.my_templates.is_empty());

        let error_el = self.error.map(|key| {
            div()
                .id("v3-save-tpl-error")
                .debug_selector(|| "v3-save-tpl-error".into())
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .text_color(p.danger.solid())
                .child(sand::icon(Icon::StatusWarning, 13.0, p.danger.solid()))
                .child(t(cx, key))
        });

        let close_entity = entity.clone();
        let cancel_entity = entity.clone();
        let overwrite_entity = entity.clone();
        let submit_entity = entity.clone();

        let overwrite_btn = div()
            .relative()
            .debug_selector(|| "v3-save-tpl-overwrite".into())
            .child(overlay::probe(self.overwrite_bounds.clone()))
            .child(
                Button::new(
                    "v3-save-tpl-overwrite",
                    t(cx, keys::project_templates::OVERWRITE),
                )
                .disabled(!can_overwrite)
                .on_click(move |_, _, cx| {
                    cx.stop_propagation();
                    overwrite_entity.update(cx, |d, cx| {
                        d.overwrite_open = !d.overwrite_open;
                        cx.notify();
                    });
                }),
            );

        let submit_label = if self.busy {
            t(cx, keys::common::SAVING)
        } else {
            t(cx, keys::template_editor::NEW_TEMPLATE)
        };

        let dialog = Dialog::new(
            "v3-save-template-dialog",
            t(cx, keys::project_home::project_template::SAVE_AS),
        )
        .width(DIALOG_WIDTH)
        .close_label(t(cx, keys::common::CLOSE))
        .on_close(move |_, cx| {
            close_entity.update(cx, |d, cx| d.close(cx));
        })
        .body(grid)
        .when_some(error_el, |d, e| d.status(e))
        .action(
            Button::new("v3-save-tpl-cancel", t(cx, keys::common::CANCEL))
                .text()
                .disabled(self.busy)
                .on_click(move |_, _, cx| {
                    cancel_entity.update(cx, |d, cx| d.close(cx));
                }),
        )
        .action(overwrite_btn)
        .action(
            div().debug_selector(|| "v3-save-tpl-submit".into()).child(
                Button::new("v3-save-tpl-submit", submit_label)
                    .primary()
                    .disabled(!can_submit_new)
                    .on_click(move |_, window, cx| {
                        submit_entity.update(cx, |d, cx| d.submit_new(window, cx));
                    }),
            ),
        );

        let overwrite_menu = self.render_overwrite_menu(window, cx);

        div()
            .id("v3-save-template-root")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &Dismiss, window, cx| {
                this.cancel_or_close_menu(window, cx);
            }))
            .child(dialog)
            .children(overwrite_menu)
    }
}
