//! One module's workbench: the module as my modules keep it, the changes
//! made here on their way there, and what the workbench shows (what is
//! picked, how the preview is set). The paper and the two side columns
//! draw it; it is kept while the module's pill stays open.
//!
//! Every change is the whole module, written with `custom_module.update`
//! as soon as it is made (no save button, §7 「随改随存」), one write at a
//! time and the latest change only. Before each write the module is read
//! again: if it is no longer what this workbench last stored (the Agent
//! changed it, or another device), the write is refused, the workbench
//! shows what is stored now and says it could not save (a whole module is
//! never written over a change it has not seen). ⌘Z and ⇧⌘Z go back and
//! forth through the changes made here, each written the same way.
//!
//! The Agent's changes are steps of ⌘Z too (CW, §7 「Agent 改的也是一步」):
//! one made while the pill is open goes on top of the steps made here; one
//! made before the workbench opened is its first step back, while nothing
//! came after it. What the module was before each comes from the Agent's
//! settlement receipts on this device
//! (`dr_workspace::commands::v3::custom_module::agent_changes`). A change
//! from anywhere else (another device) still clears the steps.

use std::collections::BTreeMap;
use std::rc::Rc;

use dr_i18n::keys;
use dr_model::custom_module::values::BlockValue;
use dr_model::custom_module::{BlockKind, LookSize, ModuleValue};
use dr_model::id::CustomModuleId;
use dr_shell::{
    Workspace,
    book::Book,
    nav::{Open, Target},
    strings::t,
};
use dr_workspace::{
    Actor, Workspace as Library, WsError,
    commands::v3::custom_module::{
        AgentChanges, CustomIn, CustomModuleSaveAs, CustomModuleUpdate, CustomModuleUses,
        CustomRead, IdIn, SaveAsIn, UpdateIn, agent_changes,
    },
};
use gpui::{
    App, AppContext as _, Context, Entity, FocusHandle, Subscription, Task, WeakEntity, Window,
};

use crate::edit::{self, NodePath};

/// What the preview shows (§8 「内容」).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Content {
    /// The module's sample.
    Sample,
    /// Nothing kept: every list one item, every value its block's name.
    Blank,
    /// An entry of this project that uses the module.
    Real,
}

/// How wide the preview is (§8 「宽窄」): the prototype's 340, 520, all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Breadth {
    Narrow,
    Medium,
    Wide,
}

impl Breadth {
    pub fn px(self) -> Option<f32> {
        match self {
            Breadth::Narrow => Some(340.0),
            Breadth::Medium => Some(520.0),
            Breadth::Wide => None,
        }
    }
}

/// The entry of this project the preview borrows (「借一个真实条目」).
#[derive(Clone, Debug, PartialEq)]
pub struct Real {
    pub entry: String,
    pub title: String,
    /// Its template's module of kind `custom` that draws this module.
    pub module: String,
    pub values: BTreeMap<String, BlockValue>,
}

/// The right-column tab of the look (「长什么样」).
pub const LOOK_TAB: &str = "look";
/// The right-column tab of the words for the Agent (「写给 Agent」).
pub const GUIDE_TAB: &str = "guide";

/// Changes kept for ⌘Z.
const UNDO_LIMIT: usize = 100;

pub struct Bench {
    pub id: CustomModuleId,
    pub ws: WeakEntity<Workspace>,
    lib: Library,
    /// The keyboard of the workbench: its paper takes it, the side columns
    /// give it back after a press (⌘Z is the workbench's while it has it).
    pub focus: FocusHandle,
    /// What my modules hold, as last read or written here.
    stored: Option<ModuleValue>,
    /// What the workbench shows: what is stored and the changes on their
    /// way.
    pub value: Option<ModuleValue>,
    /// How many projects use it (`custom_module.uses`).
    pub uses: Option<usize>,
    /// My modules no longer have it.
    pub gone: bool,
    undo: Vec<ModuleValue>,
    redo: Vec<ModuleValue>,
    queue: Option<ModuleValue>,
    writing: bool,
    reading: bool,
    stale: bool,
    pub sel_block: Option<String>,
    pub sel_node: Option<NodePath>,
    pub size: LookSize,
    pub content: Content,
    pub breadth: Breadth,
    /// `None`: as the window is.
    pub dark: Option<bool>,
    pub real: Option<Real>,
    book: Option<Rc<Book>>,
    real_task: Option<Task<()>>,
    _store: Option<dr_store::LibrarySubscription>,
    _ws: Option<Subscription>,
}

impl Bench {
    /// Made while the workspace draws (its page or its columns are asked
    /// for): it does not read the workspace here, `book` is the one it
    /// draws.
    pub fn new(
        id: CustomModuleId,
        ws: WeakEntity<Workspace>,
        lib: Library,
        book: Rc<Book>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Bench {
        let mut bench = Bench {
            id,
            ws,
            lib,
            focus: cx.focus_handle(),
            stored: None,
            value: None,
            uses: None,
            gone: false,
            undo: Vec::new(),
            redo: Vec::new(),
            queue: None,
            writing: false,
            reading: false,
            stale: false,
            sel_block: None,
            sel_node: None,
            size: LookSize::Block,
            content: Content::Sample,
            breadth: Breadth::Medium,
            dark: None,
            real: None,
            book: Some(book),
            real_task: None,
            _store: None,
            _ws: None,
        };
        bench.listen(window, cx);
        bench.load(cx);
        bench.load_uses(cx);
        bench.borrow_entry(cx);
        bench
    }

    pub fn target(&self) -> Target {
        Target::Module(self.id.clone())
    }

    pub fn name(&self) -> Option<&str> {
        self.value.as_ref().map(|v| v.name.as_str())
    }

    /// Whether every change made here is stored.
    pub fn is_settled(&self) -> bool {
        !self.writing && self.queue.is_none() && !self.reading && self.value == self.stored
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// My modules changed (here, by the Agent, from another device): read
    /// again. The book in front changed: borrow its entry again.
    fn listen(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let doc = format!("module:{}", self.id);
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<()>();
        self._store = Some(self.lib.library().subscribe(move |event| {
            let mine = match event {
                dr_store::StoreEvent::Doc(ev) => *ev.doc_id == *doc,
                dr_store::StoreEvent::Local(c) => {
                    matches!(c.table.as_str(), "doc" | "purged_doc") && c.key == doc
                }
            };
            if mine {
                let _ = tx.unbounded_send(());
            }
        }));
        cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                while rx.try_recv().is_ok() {}
                if this.update(cx, |b, cx| b.load(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        if let Some(ws) = self.ws.upgrade() {
            self._ws = Some(cx.observe_in(&ws, window, |b, ws, _, cx| {
                let book = ws.read(cx).book.clone();
                if b.book.as_ref().is_none_or(|old| !Rc::ptr_eq(old, &book)) {
                    b.book = Some(book);
                    b.borrow_entry(cx);
                }
            }));
        }
    }

    /// Reads the module (again).
    pub fn load(&mut self, cx: &mut Context<Self>) {
        if self.reading || self.writing || self.queue.is_some() {
            self.stale = true;
            return;
        }
        self.reading = true;
        let lib = self.lib.clone();
        let id = self.id.clone();
        let stored = self.stored.clone();
        let job = cx.background_spawn(async move {
            // The first read takes the Agent's last change, if nothing came
            // after it; a read after a change elsewhere takes every change
            // of the Agent's back to what was stored here.
            let limit = if stored.is_some() { UNDO_LIMIT } else { 1 };
            agent_changes(&lib, &id, stored.as_ref(), limit)?.ok_or_else(|| gone(&id))
        });
        cx.spawn(async move |this, cx| {
            let read = job.await;
            this.update(cx, |b, cx| {
                b.reading = false;
                match read {
                    Ok(changes) => {
                        if b.stored.as_ref() != Some(&changes.now) {
                            match b.stored.take() {
                                // Opened after the Agent changed the module
                                // (and nothing since): its change is the
                                // first step back.
                                None => {
                                    if let Some(was) = changes.before.first() {
                                        b.push_undo(was.clone());
                                    }
                                }
                                Some(old) => b.changed_elsewhere(&old, &changes.before),
                            }
                            let value = changes.now;
                            b.stored = Some(value.clone());
                            b.value = Some(value);
                            b.keep_selection();
                            b.borrow_entry(cx);
                            b.retitle(cx);
                        }
                    }
                    Err(WsError::NotFound { .. }) => b.went(cx),
                    Err(error) => log::warn!("module workbench: {error}"),
                }
                if std::mem::take(&mut b.stale) {
                    b.load(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// A step back for ⌘Z, the oldest dropped past the limit; the same
    /// module twice in a row is one step.
    fn push_undo(&mut self, was: ModuleValue) {
        if self.undo.last() == Some(&was) {
            return;
        }
        self.undo.push(was);
        if self.undo.len() > UNDO_LIMIT {
            self.undo.remove(0);
        }
    }

    /// My module went from `old` (last stored here) to what is stored now
    /// without this workbench. `before` is what it was before each of the
    /// Agent's changes leading to now, newest first: when they lead back
    /// to `old`, each is a step on top of ⌘Z's (`custom-modules.md` §7
    /// 「Agent 改的也是一步」), the newest on top. Otherwise (another device,
    /// or a change of the Agent's on top of one) what was undone here is no
    /// longer what it was undone from.
    fn changed_elsewhere(&mut self, old: &ModuleValue, before: &[ModuleValue]) {
        self.redo.clear();
        match before.iter().position(|was| was == old) {
            Some(last) => {
                for was in before[..=last].iter().rev() {
                    self.push_undo(was.clone());
                }
            }
            None => self.undo.clear(),
        }
    }

    /// What ⌘Z goes back to next, if anything (tests, the bridge).
    pub fn undo_top(&self) -> Option<&ModuleValue> {
        self.undo.last()
    }

    /// How many projects use it.
    pub fn load_uses(&mut self, cx: &mut Context<Self>) {
        let lib = self.lib.clone();
        let id = self.id.to_string();
        let job = cx.background_spawn(async move {
            lib.run::<CustomModuleUses>(&Actor::User, IdIn { id })
                .map(|o| o.output.len())
        });
        cx.spawn(async move |this, cx| {
            let uses = job.await;
            this.update(cx, |b, cx| {
                if let Ok(n) = uses {
                    b.uses = Some(n);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// My modules no longer have it: its pill closes.
    fn went(&mut self, cx: &mut Context<Self>) {
        self.gone = true;
        let target = self.target();
        let ws = self.ws.clone();
        cx.defer(move |cx| {
            ws.update(cx, |ws, cx| {
                ws.nav.forget(&target);
                cx.notify();
            })
            .ok();
        });
    }

    /// The pill's name follows the module's.
    fn retitle(&self, cx: &mut Context<Self>) {
        let ws = self.ws.clone();
        cx.defer(move |cx| {
            ws.update(cx, |_, cx| cx.notify()).ok();
        });
    }

    /// Makes `next` the module, and writes it. A module the validator
    /// refuses is not taken (the workbench offers only what passes, so
    /// this is a slip of its own): the author hears it was not saved.
    pub fn apply(&mut self, next: ModuleValue, cx: &mut Context<Self>) {
        let Some(current) = self.value.clone() else {
            return;
        };
        if next == current {
            return;
        }
        if !edit::valid(&next) {
            log::warn!("module workbench: a change the validator refuses was not made");
            self.say_not_saved(cx);
            return;
        }
        self.undo.push(current);
        if self.undo.len() > UNDO_LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.take(next, cx);
    }

    /// `f` of the module, if it gives a change.
    pub fn change(
        &mut self,
        f: impl FnOnce(&ModuleValue) -> Option<ModuleValue>,
        cx: &mut Context<Self>,
    ) {
        let Some(next) = self.value.as_ref().and_then(f) else {
            return;
        };
        self.apply(next, cx);
    }

    fn take(&mut self, next: ModuleValue, cx: &mut Context<Self>) {
        let renamed = self.value.as_ref().map(|v| &v.name) != Some(&next.name);
        self.value = Some(next.clone());
        self.queue = Some(next);
        self.keep_selection();
        if renamed {
            self.retitle(cx);
        }
        self.pump(cx);
        cx.notify();
    }

    /// ⌘Z: the change made here before the last one.
    pub fn undo(&mut self, cx: &mut Context<Self>) {
        let (Some(prev), Some(current)) = (self.undo.pop(), self.value.clone()) else {
            return;
        };
        self.redo.push(current);
        self.take(prev, cx);
    }

    /// ⇧⌘Z.
    pub fn redo(&mut self, cx: &mut Context<Self>) {
        let (Some(next), Some(current)) = (self.redo.pop(), self.value.clone()) else {
            return;
        };
        self.undo.push(current);
        self.take(next, cx);
    }

    /// Writes the latest change, one write at a time, each held to what was
    /// last stored here.
    fn pump(&mut self, cx: &mut Context<Self>) {
        if self.writing {
            return;
        }
        let Some(want) = self.queue.take() else {
            return;
        };
        let Some(base) = self.stored.clone() else {
            return;
        };
        self.writing = true;
        let lib = self.lib.clone();
        let id = self.id.clone();
        let written = want.clone();
        let held = base.clone();
        let job = cx.background_spawn(async move {
            let changes =
                agent_changes(&lib, &id, Some(&base), UNDO_LIMIT)?.ok_or_else(|| gone(&id))?;
            if changes.now != base {
                return Err(Write::Changed(Box::new(changes)));
            }
            let value =
                serde_json::to_value(&want).map_err(|e| WsError::Internal(e.to_string()))?;
            lib.run::<CustomModuleUpdate>(
                &Actor::User,
                UpdateIn {
                    id: id.to_string(),
                    value,
                },
            )?;
            Ok(())
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            this.update(cx, |b, cx| {
                b.writing = false;
                match result {
                    Ok(()) => b.stored = Some(written),
                    Err(Write::Changed(changes)) => {
                        // The changes made here that were not written are
                        // gone, and the steps back to them; what changed
                        // it elsewhere is the Agent's to take back, if it
                        // was the Agent's alone.
                        let AgentChanges { now, before } = *changes;
                        b.queue = None;
                        b.undo.clear();
                        b.changed_elsewhere(&held, &before);
                        b.stored = Some(now.clone());
                        b.value = Some(now);
                        b.keep_selection();
                        b.say_not_saved(cx);
                    }
                    Err(Write::Failed(WsError::NotFound { .. })) => {
                        b.queue = None;
                        b.went(cx);
                    }
                    Err(Write::Failed(error)) => {
                        log::warn!("module workbench: {error}");
                        b.queue = None;
                        b.value = b.stored.clone();
                        b.keep_selection();
                        b.say_not_saved(cx);
                    }
                }
                b.pump(cx);
                if !b.writing && std::mem::take(&mut b.stale) {
                    b.load(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn say_not_saved(&self, cx: &mut Context<Self>) {
        let ws = self.ws.clone();
        cx.defer(move |cx| {
            ws.update(cx, |ws, cx| {
                let text = t(cx, keys::common::SAVE_FAILED);
                ws.toast_error(text, cx);
            })
            .ok();
        });
    }

    /// A picked block or node that is no longer there is no longer picked.
    fn keep_selection(&mut self) {
        let Some(value) = &self.value else {
            return;
        };
        if self
            .sel_block
            .as_ref()
            .is_some_and(|id| value.block(id).is_none())
        {
            self.sel_block = None;
        }
        if let Some(path) = &self.sel_node
            && edit::tree(value, self.size).is_none_or(|root| edit::spot(root, path).is_none())
        {
            self.sel_node = None;
        }
    }

    // What the workbench shows.

    /// Picks block `id` in 「装什么」 (again: unpicks it).
    pub fn pick_block(&mut self, id: &str, cx: &mut Context<Self>) {
        self.sel_block = if self.sel_block.as_deref() == Some(id) {
            None
        } else {
            Some(id.to_owned())
        };
        cx.notify();
    }

    /// Picks the node at `path` of the size shown; the right column shows
    /// 「长什么样」 with it (§8 「预览里点哪一处……右栏跟着跳过去」).
    pub fn pick_node(&mut self, path: NodePath, cx: &mut Context<Self>) {
        self.sel_node = Some(path);
        let target = self.target();
        let ws = self.ws.clone();
        cx.defer(move |cx| {
            ws.update(cx, |ws, cx| ws.show_page_tab(&target, LOOK_TAB, cx))
                .ok();
        });
        cx.notify();
    }

    /// Picks a node from the right column's tree.
    pub fn pick_row(&mut self, path: NodePath, cx: &mut Context<Self>) {
        self.sel_node = Some(path);
        cx.notify();
    }

    pub fn set_size(&mut self, size: LookSize, cx: &mut Context<Self>) {
        if self.size != size {
            self.size = size;
            self.sel_node = None;
            cx.notify();
        }
    }

    pub fn set_content(&mut self, content: Content, cx: &mut Context<Self>) {
        self.content = content;
        cx.notify();
    }

    pub fn set_breadth(&mut self, breadth: Breadth, cx: &mut Context<Self>) {
        self.breadth = breadth;
        cx.notify();
    }

    pub fn set_dark(&mut self, dark: bool, cx: &mut Context<Self>) {
        self.dark = Some(dark);
        cx.notify();
    }

    // Changes.

    /// A new block of `kind`, named after its kind, into the picked group
    /// or list (or the module); a new group or list is picked, so what is
    /// added next goes into it.
    pub fn add_block(&mut self, kind: BlockKind, cx: &mut Context<Self>) {
        let Some(value) = self.value.clone() else {
            return;
        };
        let name = kind_name(kind, cx).to_string();
        let options: Vec<String> = t(cx, keys::module_bench::DEFAULT_OPTIONS)
            .split('|')
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .collect();
        let into = self
            .sel_block
            .clone()
            .filter(|id| value.block(id).is_some_and(|b| b.kind.holds_blocks()));
        let Some((next, id)) = edit::add_block(&value, kind, &name, &options, into.as_deref())
        else {
            return;
        };
        if kind.holds_blocks() && (self.sel_block.is_none() || into.is_none()) {
            self.sel_block = Some(id);
        }
        self.apply(next, cx);
    }

    /// 「另存一份」 (§7): a new module of mine with what is here, and this
    /// project's entry templates use it; its workbench takes this pill's
    /// place.
    pub fn save_as(&mut self, cx: &mut Context<Self>) {
        let (Some(value), Some(ws)) = (self.value.clone(), self.ws.upgrade()) else {
            return;
        };
        let book = ws.read(cx).book_id.clone();
        if book.is_empty() {
            return;
        }
        let lib = self.lib.clone();
        let module = self.id.to_string();
        let job = cx.background_spawn(async move {
            let value =
                serde_json::to_value(&value).map_err(|e| WsError::Internal(e.to_string()))?;
            lib.run::<CustomModuleSaveAs>(
                &Actor::User,
                SaveAsIn {
                    book,
                    module,
                    value: Some(value),
                },
            )
            .map(|o| o.output.module.id)
        });
        let old = self.target();
        cx.spawn(async move |this, cx| {
            let made = job.await;
            this.update(cx, |b, cx| match made {
                Ok(id) => {
                    let Ok(id) = id.parse::<CustomModuleId>() else {
                        return;
                    };
                    let ws = b.ws.clone();
                    cx.defer(move |cx| {
                        ws.update(cx, |ws, cx| {
                            ws.open(Target::Module(id), Open::KEEP, cx);
                            ws.nav.forget(&old);
                            cx.notify();
                        })
                        .ok();
                    });
                }
                Err(error) => {
                    log::warn!("module workbench: save as: {error}");
                    b.say_not_saved(cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// The first entry of the book in front whose template draws this
    /// module, and what it keeps for it.
    fn borrow_entry(&mut self, cx: &mut Context<Self>) {
        let Some(book) = self.book.clone() else {
            return;
        };
        let Some(v3) = book.v3() else {
            self.real = None;
            return;
        };
        let id = self.id.to_string();
        let drawn: BTreeMap<&str, &str> = v3
            .templates
            .iter()
            .filter(|t| t.deleted_at.is_none())
            .filter_map(|t| {
                t.modules
                    .iter()
                    .find(|m| m.kind == "custom" && m.config.module.as_deref() == Some(id.as_str()))
                    .map(|m| (t.id.as_str(), m.id.as_str()))
            })
            .collect();
        let found = v3.entries.iter().find_map(|e| {
            let module = drawn.get(e.template.as_deref()?)?;
            Some((e.id.clone(), e.title.clone(), (*module).to_owned()))
        });
        let Some((entry, title, module)) = found else {
            self.real = None;
            self.real_task = None;
            cx.notify();
            return;
        };
        let lib = self.lib.clone();
        let input = CustomIn {
            book: book.id.clone(),
            entry: entry.clone(),
            module: module.clone(),
        };
        let job = cx.background_spawn(async move {
            lib.run::<CustomRead>(&Actor::User, input)
                .map(|o| o.output.values)
        });
        self.real_task = Some(cx.spawn(async move |this, cx| {
            let values = job.await;
            this.update(cx, |b, cx| {
                b.real = values.ok().map(|values| Real {
                    entry,
                    title,
                    module,
                    values,
                });
                cx.notify();
            })
            .ok();
        }));
    }

    pub fn book(&self) -> Option<&Rc<Book>> {
        self.book.as_ref()
    }
}

/// A write that did not go: the module changed since it was last stored
/// here, or the command refused.
enum Write {
    Changed(Box<AgentChanges>),
    Failed(WsError),
}

/// My modules do not have `id` (any more).
fn gone(id: &CustomModuleId) -> WsError {
    WsError::NotFound {
        what: "module",
        id: id.to_string(),
    }
}

impl From<WsError> for Write {
    fn from(e: WsError) -> Self {
        Write::Failed(e)
    }
}

/// A block kind's name (「一行字」…), also a new block's name.
pub fn kind_name(kind: BlockKind, cx: &App) -> gpui::SharedString {
    use keys::module_bench::kind as k;
    t(
        cx,
        match kind {
            BlockKind::Text => k::TEXT,
            BlockKind::LongText => k::LONG_TEXT,
            BlockKind::Number => k::NUMBER,
            BlockKind::Date => k::DATE,
            BlockKind::Select => k::SELECT,
            BlockKind::MultiSelect => k::MULTI_SELECT,
            BlockKind::Toggle => k::TOGGLE,
            BlockKind::Entry => k::ENTRY,
            BlockKind::Image => k::IMAGE,
            BlockKind::Group => k::GROUP,
            BlockKind::List => k::LIST,
        },
    )
}

/// The workbench of `id` in the window of `host`, made now if it is not
/// there.
pub fn bench_for(
    id: &CustomModuleId,
    host: &dr_shell::pages::PageViewHost,
    window: &mut Window,
    cx: &mut App,
) -> Entity<Bench> {
    let ws = &host.workspace;
    let lib = &host.library;
    let key = (ws.entity_id(), id.clone());
    if let Some(bench) = cx
        .try_global::<crate::Benches>()
        .and_then(|b| b.0.get(&key))
        .and_then(WeakEntity::upgrade)
    {
        return bench;
    }
    let book = host.book.clone();
    let bench = cx.new(|cx| Bench::new(id.clone(), ws.clone(), lib.clone(), book, window, cx));
    cx.default_global::<crate::Benches>()
        .0
        .insert(key, bench.downgrade());
    bench
}
