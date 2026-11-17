//! The right sidebar's 「关系」 (RL; `kernel-v5.md` §19 「右栏的『关系』」,
//! the prototype's third version): one card a relation, one row a group of
//! entries on each side.
//!
//! - The head: how many relations are shown, 「当前」, ＋ (a new card, the
//!   caret in its name). A card: its name (pressed: renamed in place; a name
//!   another relation has is refused like an entry title that did not save,
//!   the draft kept, 「未能保存」 and 「重试」), the direction (→ or ↔, the
//!   whole card's), how many pairs (the same pair once), and ＋ while the
//!   pointer is on the card (a row). Under the name the description with its
//!   links, edited in place; with none, a pen while the pointer is on the
//!   card.
//! - A row: the left names, the direction, the right names, each name with
//!   its entry's mark, a press opening it. With the pointer on the row: ×
//!   after each name (out of this row), ＋ at each side's end (an `@` field
//!   over the book's live entries, the ones on that side left out), a bin at
//!   the end (the row). The prose draws the row's pairs meanwhile
//!   ([`dr_shell::relations::set_rail_hover`]).
//! - A new row is a draft here until both sides have an entry; it is written
//!   then (`relation_row.create_pair`, its first pair, then the rest). The
//!   last row of a card going (a draft included, no hidden rows left) takes
//!   the relation with it; a relation left without rows when its entries were
//!   purged keeps its card.
//! - Cards come newest first. Each write is one step of the book's undo
//!   (the commands' own receipts). The Agent's and other devices' writes
//!   come in through the book's events.
//! - 「当前」 keeps the rows with the page in front's entry, or an entry its
//!   prose links to (a whole-book page: the entries it shows).
//! - [`dr_shell::actions::RevealRelationRow`]: once drawn, the row scrolls
//!   into view and flashes ([`dr_shell::relations::pending_reveal`]).

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::rc::Rc;
use std::time::Instant;

use dr_i18n::keys;
use dr_model::v3::{EntryTextLink, LinkedText, RelationDirection, RelationSide};
use dr_shell::book::Book;
use dr_shell::nav::{Open, Target};
use dr_shell::relations::{self as shell_rel, RailRow};
use dr_shell::strings::t;
use dr_shell::{Workspace, pages::LeftPanel};
use dr_ui::input::{FieldEvent, TextField};
use dr_ui::linked::{AtItem, Candidates, Draft, LinkedArea, LinkedEvent, Link};
use dr_ui::sand;
use dr_workspace::commands::EntityIn;
use dr_workspace::commands::v3::relations::{
    AddEntry, AddEntryIn, Create, CreatePair, CreateTypeIn, Delete, DeleteRow, DescriptionIn,
    DirectionIn, List, ListIn, PairIn, RelationInfo, RemoveEntry, RemoveEntryIn, Rename as RenameOp, RenameIn,
    SetDescription, SetDirection,
};
use dr_workspace::dto::LinkedTextIn;
use dr_workspace::events::is_text_index;
use dr_workspace::{Actor, Workspace as Library, WsEvent};
use gpui::{
    App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable, Pixels, ScrollHandle,
    SharedString, Subscription, Task, WeakEntity, Window,
};

/// Which row: one in the book, or a draft only the rail has.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum RowKey {
    Stored(String),
    Draft(u64),
}

/// A row being made here: written once both sides have an entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftRow {
    pub key: u64,
    /// `None` while its card is still being named (a new card).
    pub relation: Option<String>,
    pub left: Vec<String>,
    pub right: Vec<String>,
}

/// A name being edited: `relation` is `None` for a new card.
pub struct Rename {
    pub relation: Option<String>,
    pub field: Entity<TextField>,
    pub failed: bool,
    _sub: Subscription,
}

/// A description being edited.
pub struct Describe {
    pub relation: String,
    pub area: Entity<LinkedArea>,
    pub start: Draft,
    pub failed: bool,
    _sub: Subscription,
}

/// The ＋ of a side, open: an `@` field and the entries it finds.
pub struct Picker {
    pub row: RowKey,
    pub relation: String,
    pub side: RelationSide,
    pub field: Entity<TextField>,
    pub query: String,
    /// Where the ＋ is (window coordinates), for the list to open under.
    pub anchor: Bounds<Pixels>,
    _sub: Subscription,
}

/// What opens an entry (the shell's tab, by default).
pub type OpenEntry = Rc<dyn Fn(&str, &mut Window, &mut App)>;

/// One entry as the rail names it.
#[derive(Clone, Debug, PartialEq)]
pub struct EntryLook {
    pub title: SharedString,
    pub mark: sand::Kind,
    pub template: Option<SharedString>,
}

pub struct RelationsRail {
    pub(crate) shell: WeakEntity<Workspace>,
    pub(crate) lib: Option<Library>,
    pub(crate) book: Rc<Book>,
    epoch: u64,
    pub(crate) relations: Vec<RelationInfo>,
    pub(crate) loaded: bool,
    load_gen: u64,
    load_task: Option<Task<()>>,
    /// The page in front ([`Target::key`]) and its entries for 「当前」.
    pub(crate) front: Option<Target>,
    /// The page in front's key and the entries 「当前」 keeps rows of.
    pub page: Option<(String, HashSet<String>)>,
    page_task: Option<Task<()>>,
    pub(crate) current: bool,
    /// The name being edited.
    pub rename: Option<Rename>,
    /// The description being edited.
    pub describe: Option<Describe>,
    pub(crate) drafts: Vec<DraftRow>,
    next_draft: u64,
    pub(crate) picker: Option<Picker>,
    pub(crate) hover_card: Option<String>,
    pub(crate) hover: Option<RowKey>,
    /// The row last revealed, and when its flash began.
    pub(crate) flash: Option<(String, Instant)>,
    pub(crate) scroll: ScrollHandle,
    /// Each drawn row's bounds, for a reveal to scroll to.
    pub(crate) row_bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    /// A write that has not come back.
    pub(crate) writing: usize,
    pub(crate) open: OpenEntry,
    pub(crate) focus: FocusHandle,
    bus: Option<dr_workspace::events::Subscription>,
    bus_task: Option<Task<()>>,
    _subs: Vec<Subscription>,
}

impl Focusable for RelationsRail {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// The rails the shell has made, for tests and the debug bridge.
#[derive(Default)]
struct Rails(Vec<WeakEntity<RelationsRail>>);

impl gpui::Global for Rails {}

/// The rails the shell has made that are still open.
pub fn open_rails(cx: &App) -> Vec<Entity<RelationsRail>> {
    cx.try_global::<Rails>()
        .map(|r| r.0.iter().filter_map(WeakEntity::upgrade).collect())
        .unwrap_or_default()
}

/// The panel and its head for the shell (`dr_shell::pages::set_relations`).
pub fn make(shell: WeakEntity<Workspace>, window: &mut Window, cx: &mut App) -> LeftPanel {
    let lib = cx
        .try_global::<dr_shell::Services>()
        .and_then(|s| s.library.clone());
    let rail = cx.new(|cx| RelationsRail::new(shell, lib, Rc::default(), window, cx));
    let made = cx.default_global::<Rails>();
    made.0.retain(|r| r.upgrade().is_some());
    made.0.push(rail.downgrade());
    let head = cx.new(|cx| crate::rail_view::RailHead::new(rail.clone(), cx));
    LeftPanel {
        head: head.into(),
        body: rail.into(),
    }
}

impl RelationsRail {
    pub fn new(
        shell: WeakEntity<Workspace>,
        lib: Option<Library>,
        book: Rc<Book>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> RelationsRail {
        let mut subs = Vec::new();
        if let Some(ws) = shell.upgrade() {
            subs.push(cx.observe(&ws, |rail, ws, cx| {
                let (book, front) = {
                    let w = ws.read(cx);
                    (w.book.clone(), w.nav.current().cloned())
                };
                if !Rc::ptr_eq(&book, &rail.book) {
                    rail.set_book(book, cx);
                }
                rail.set_front(front, cx);
                cx.notify();
            }));
            cx.spawn(async move |this, cx| {
                this.update(cx, |rail, cx| {
                    if let Some(ws) = rail.shell.upgrade() {
                        let (book, front) = {
                            let w = ws.read(cx);
                            (w.book.clone(), w.nav.current().cloned())
                        };
                        rail.set_book(book, cx);
                        rail.set_front(front, cx);
                    }
                })
                .ok()
            })
            .detach();
        }
        subs.push(cx.observe_global::<shell_rel::PendingReveal>(|_, cx| cx.notify()));
        let open: OpenEntry = {
            let shell = shell.clone();
            Rc::new(move |id, _, cx| {
                let Ok(id) = id.parse() else {
                    return;
                };
                shell
                    .update(cx, |ws, cx| {
                        let target = Target::Entry { id, module: None };
                        if ws.book.exists(&target) {
                            ws.open(target, Open::KEEP, cx);
                        }
                    })
                    .ok();
            })
        };
        let mut rail = RelationsRail {
            shell,
            lib,
            book: Rc::default(),
            epoch: 0,
            relations: Vec::new(),
            loaded: false,
            load_gen: 0,
            load_task: None,
            front: None,
            page: None,
            page_task: None,
            current: false,
            rename: None,
            describe: None,
            drafts: Vec::new(),
            next_draft: 0,
            picker: None,
            hover_card: None,
            hover: None,
            flash: None,
            scroll: ScrollHandle::new(),
            row_bounds: Rc::default(),
            writing: 0,
            open,
            focus: cx.focus_handle(),
            bus: None,
            bus_task: None,
            _subs: subs,
        };
        if !book.id.is_empty() {
            rail.set_book(book, cx);
        }
        rail
    }

    /// What a press on a name opens instead of the shell's tab (tests).
    pub fn set_open(&mut self, open: OpenEntry) {
        self.open = open;
    }

    pub fn book(&self) -> &Rc<Book> {
        &self.book
    }

    /// The relations as last read.
    pub fn relations(&self) -> &[RelationInfo] {
        &self.relations
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded && self.writing == 0
    }

    pub fn drafts(&self) -> &[DraftRow] {
        &self.drafts
    }

    pub fn current_only(&self) -> bool {
        self.current
    }

    /// Shows another book (the shell's, or a test's).
    pub fn set_book(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
        if self.book.id != book.id {
            self.epoch += 1;
            self.relations.clear();
            self.loaded = false;
            self.rename = None;
            self.describe = None;
            self.drafts.clear();
            self.picker = None;
            self.hover = None;
            self.hover_card = None;
            self.flash = None;
            self.page = None;
            self.book = book;
            self.watch(cx);
            self.reload(cx);
            self.reload_page(cx);
        } else {
            self.book = book;
        }
        cx.notify();
    }

    /// The page in front changed (the shell's navigation, or a test's).
    pub fn set_front(&mut self, front: Option<Target>, cx: &mut Context<Self>) {
        if self.front != front {
            self.front = front;
            self.reload_page(cx);
        }
    }

    fn watch(&mut self, cx: &mut Context<Self>) {
        self.bus = None;
        self.bus_task = None;
        let (Some(lib), false) = (self.lib.clone(), self.book.id.is_empty()) else {
            return;
        };
        let book = self.book.id.clone();
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<bool>();
        self.bus = Some(lib.subscribe(move |e| match e {
            WsEvent::Book(b) if b.book.to_string() == book => {
                let _ = tx.unbounded_send(true);
            }
            WsEvent::Local(change) if is_text_index(change) && change.key.starts_with("body:") => {
                let _ = tx.unbounded_send(false);
            }
            _ => {}
        }));
        let epoch = self.epoch;
        self.bus_task = Some(cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while let Some(first) = rx.next().await {
                let mut book_changed = first;
                while let Ok(more) = rx.try_recv() {
                    book_changed |= more;
                }
                let alive = this
                    .update(cx, |rail, cx| {
                        if rail.epoch != epoch {
                            return;
                        }
                        if book_changed {
                            rail.reload(cx);
                        }
                        rail.reload_page(cx);
                    })
                    .is_ok();
                if !alive {
                    break;
                }
            }
        }));
    }

    /// Reads the relations again.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        if self.book.id.is_empty() {
            return;
        }
        self.load_gen += 1;
        let (generation, epoch, book) = (self.load_gen, self.epoch, self.book.id.clone());
        let task = cx.background_executor().spawn(async move {
            lib.run::<List>(&Actor::User, ListIn { book, entry: None })
                .map(|o| o.output)
        });
        self.load_task = Some(cx.spawn(async move |this, cx| {
            let out = task.await;
            this.update(cx, |rail, cx| {
                if rail.epoch != epoch || rail.load_gen != generation {
                    return;
                }
                match out {
                    Ok(relations) => {
                        rail.relations = relations;
                        rail.loaded = true;
                        rail.forget_gone();
                    }
                    Err(e) => log::warn!("relations rail: relation_type.list: {e}"),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Drafts, edits and the hovered row of relations no longer there go.
    fn forget_gone(&mut self) {
        let ids: HashSet<&str> = self.relations.iter().map(|r| r.id.as_str()).collect();
        self.drafts
            .retain(|d| d.relation.as_deref().is_none_or(|r| ids.contains(r)));
        if self
            .describe
            .as_ref()
            .is_some_and(|d| !ids.contains(d.relation.as_str()))
        {
            self.describe = None;
        }
        if self
            .rename
            .as_ref()
            .and_then(|r| r.relation.as_deref())
            .is_some_and(|r| !ids.contains(r))
        {
            self.rename = None;
        }
        if self
            .picker
            .as_ref()
            .is_some_and(|p| !ids.contains(p.relation.as_str()))
        {
            self.picker = None;
        }
    }

    /// The entries of the page in front, for 「当前」: its entry (or what a
    /// whole-book page shows) and the entries their prose links to.
    fn reload_page(&mut self, cx: &mut Context<Self>) {
        let Some(front) = self.front.clone() else {
            self.page = None;
            self.page_task = None;
            cx.notify();
            return;
        };
        let roots = self.page_roots(&front);
        let key = front.key();
        let Some(lib) = self.lib.clone() else {
            self.page = Some((key, roots.into_iter().collect()));
            return;
        };
        let epoch = self.epoch;
        let task = cx.background_executor().spawn(async move {
            let mut set: HashSet<String> = roots.iter().cloned().collect();
            for entry in &roots {
                if let Ok(refs) = lib.library().references_from_entry(entry) {
                    set.extend(
                        refs.into_iter()
                            .filter(|r| {
                                r.target_kind == "entry"
                                    && matches!(r.kind, dr_store::index::RefKind::Link)
                            })
                            .map(|r| r.target_id),
                    );
                }
            }
            set
        });
        self.page_task = Some(cx.spawn(async move |this, cx| {
            let set = task.await;
            this.update(cx, |rail, cx| {
                if rail.epoch == epoch && rail.front.as_ref().map(Target::key) == Some(key.clone())
                {
                    rail.page = Some((key, set));
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// The entries a page shows itself.
    fn page_roots(&self, front: &Target) -> Vec<String> {
        let Some(v3) = self.book.v3() else {
            return Vec::new();
        };
        match front {
            Target::Entry { id, .. } => vec![id.to_string()],
            Target::Book(root) => {
                let root = root.to_string();
                let parent: HashMap<&str, Option<&str>> = v3
                    .entries
                    .iter()
                    .map(|e| (e.id.as_str(), e.parent.as_deref()))
                    .collect();
                v3.entries
                    .iter()
                    .filter(|e| {
                        let mut at = Some(e.id.as_str());
                        while let Some(id) = at {
                            if id == root {
                                return true;
                            }
                            at = parent.get(id).copied().flatten();
                        }
                        false
                    })
                    .map(|e| e.id.clone())
                    .collect()
            }
            Target::BookView(view) => v3
                .timeline_view(view.as_str())
                .map(|v| {
                    v.lanes
                        .iter()
                        .flat_map(|l| {
                            std::iter::once(l.entry.clone()).chain(v3.lane_entries(v, &l.entry))
                        })
                        .collect()
                })
                .unwrap_or_default(),
            Target::BookLane { view, entry } => v3
                .timeline_view(view.as_str())
                .map(|v| {
                    std::iter::once(entry.to_string())
                        .chain(v3.lane_entries(v, entry.as_str()))
                        .collect()
                })
                .unwrap_or_default(),
            Target::Template(_) | Target::Material(_) => Vec::new(),
        }
    }

    /// An entry's title, mark and template name, if it is live.
    pub fn entry_look(&self, id: &str) -> Option<EntryLook> {
        let v3 = self.book.v3()?;
        let entry = v3.entry(id)?;
        let target = Target::Entry {
            id: id.parse().ok()?,
            module: None,
        };
        Some(EntryLook {
            title: entry.title.clone().into(),
            mark: self.book.mark(&target).0,
            template: v3.template_of(id).map(|t| t.name.clone().into()),
        })
    }

    /// The book's live entries matching `query` (in the title), the ones in
    /// `except` left out, as the `@` field lists them.
    pub fn find_entries(&self, query: &str, except: &[String]) -> Vec<AtItem> {
        entry_candidates(&self.book, query, except)
    }

    /// The cards shown, newest first, each with the rows shown.
    pub fn cards(&self) -> Vec<Card> {
        let page = self.current.then(|| {
            self.page
                .as_ref()
                .map(|(_, set)| set.clone())
                .unwrap_or_default()
        });
        let mut relations: Vec<&RelationInfo> = self.relations.iter().collect();
        relations.sort_by(|a, b| {
            b.created_at
                .unwrap_or(i64::MIN)
                .cmp(&a.created_at.unwrap_or(i64::MIN))
                .then_with(|| b.id.cmp(&a.id))
        });
        let mut out = Vec::new();
        if let Some(r) = &self.rename
            && r.relation.is_none()
        {
            out.push(Card {
                relation: None,
                rows: Vec::new(),
                drafts: self
                    .drafts
                    .iter()
                    .filter(|d| d.relation.is_none())
                    .cloned()
                    .collect(),
            });
        }
        for relation in relations {
            let rows: Vec<_> = relation
                .rows
                .iter()
                .filter(|row| {
                    page.as_ref().is_none_or(|page| {
                        row.left.iter().chain(&row.right).any(|e| page.contains(e))
                    })
                })
                .cloned()
                .collect();
            let drafts: Vec<DraftRow> = self
                .drafts
                .iter()
                .filter(|d| d.relation.as_deref() == Some(relation.id.as_str()))
                .cloned()
                .collect();
            let editing = self
                .rename
                .as_ref()
                .is_some_and(|r| r.relation.as_deref() == Some(relation.id.as_str()))
                || self
                    .describe
                    .as_ref()
                    .is_some_and(|d| d.relation == relation.id);
            if page.is_some() && rows.is_empty() && drafts.is_empty() && !editing {
                continue;
            }
            out.push(Card {
                relation: Some(relation.clone()),
                rows,
                drafts,
            });
        }
        out
    }

    pub fn set_current_only(&mut self, on: bool, cx: &mut Context<Self>) {
        self.current = on;
        cx.notify();
    }

    // ── Writes ──────────────────────────────────────────────────────

    /// Runs `work` on the library off the main thread; reads the relations
    /// again and calls `done` with the outcome.
    fn write<R: Send + 'static>(
        &mut self,
        cx: &mut Context<Self>,
        work: impl FnOnce(&Library, String) -> dr_workspace::Result<R> + Send + 'static,
        done: impl FnOnce(&mut Self, dr_workspace::Result<R>, &mut Context<Self>) + 'static,
    ) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let book = self.book.id.clone();
        if book.is_empty() {
            return;
        }
        self.writing += 1;
        let epoch = self.epoch;
        let task = cx
            .background_executor()
            .spawn(async move { work(&lib, book) });
        cx.spawn(async move |this, cx| {
            let out = task.await;
            this.update(cx, |rail, cx| {
                rail.writing = rail.writing.saturating_sub(1);
                if rail.epoch != epoch {
                    return;
                }
                if let Err(e) = &out {
                    log::warn!("relations rail: {e}");
                }
                done(rail, out, cx);
                rail.reload(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// ＋ in the head: a new card, the caret in its name.
    pub fn new_card(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.drafts.retain(|d| d.relation.is_some());
        self.describe = None;
        self.next_draft += 1;
        self.drafts.push(DraftRow {
            key: self.next_draft,
            relation: None,
            left: Vec::new(),
            right: Vec::new(),
        });
        self.start_rename(None, window, cx);
        self.scroll.set_offset(gpui::point(gpui::px(0.0), gpui::px(0.0)));
    }

    /// Starts editing a card's name (`None`: the new card's).
    pub fn start_rename(
        &mut self,
        relation: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let name = relation
            .as_deref()
            .and_then(|id| self.relations.iter().find(|r| r.id == id))
            .map(|r| r.name.clone())
            .unwrap_or_default();
        let field = cx.new(|cx| {
            TextField::new(
                SharedString::from(format!(
                    "relations-name-{}",
                    relation.as_deref().unwrap_or("new")
                )),
                window,
                cx,
            )
            .bare()
            .with_text(name)
        });
        let sub = cx.subscribe_in(&field, window, |rail, _, e: &FieldEvent, window, cx| match e {
            FieldEvent::Submitted(_) | FieldEvent::Blurred => rail.commit_rename(window, cx),
            FieldEvent::Cancelled => rail.cancel_rename(cx),
            FieldEvent::Changed(_) => {}
        });
        field.update(cx, |f, cx| f.select_all_text(cx));
        let handle = field.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
        self.rename = Some(Rename {
            relation,
            field,
            failed: false,
            _sub: sub,
        });
        cx.notify();
    }

    fn cancel_rename(&mut self, cx: &mut Context<Self>) {
        if let Some(r) = self.rename.take()
            && r.relation.is_none()
        {
            self.drafts.retain(|d| d.relation.is_some());
        }
        cx.notify();
    }

    /// Saves the name being edited; an empty new card is not made, an empty
    /// or unchanged name puts the old one back.
    pub fn commit_rename(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(r) = &self.rename else {
            return;
        };
        let name = r.field.read(cx).text().trim().to_owned();
        let relation = r.relation.clone();
        let old = relation
            .as_deref()
            .and_then(|id| self.relations.iter().find(|x| x.id == id))
            .map(|x| x.name.clone());
        if name.is_empty() || old.as_deref() == Some(name.as_str()) {
            self.cancel_rename(cx);
            return;
        }
        match relation {
            None => self.write(
                cx,
                move |lib, book| {
                    lib.run::<Create>(
                        &Actor::User,
                        CreateTypeIn {
                            book,
                            name,
                            description: LinkedTextIn::default(),
                            direction: RelationDirection::Directed,
                        },
                    )
                    .map(|o| o.output.id)
                },
                |rail, out, cx| match out {
                    Ok(id) => {
                        for d in rail.drafts.iter_mut().filter(|d| d.relation.is_none()) {
                            d.relation = Some(id.clone());
                        }
                        rail.rename = None;
                    }
                    Err(_) => rail.rename_failed(cx),
                },
            ),
            Some(id) => self.write(
                cx,
                move |lib, book| lib.run::<RenameOp>(&Actor::User, RenameIn { book, id, name }),
                |rail, out, cx| match out {
                    Ok(_) => rail.rename = None,
                    Err(_) => rail.rename_failed(cx),
                },
            ),
        }
    }

    fn rename_failed(&mut self, cx: &mut Context<Self>) {
        if let Some(r) = &mut self.rename {
            r.failed = true;
        }
        cx.notify();
    }

    /// The card's direction button: one-way ↔ two-way, every row with it.
    pub fn toggle_direction(&mut self, relation: &str, cx: &mut Context<Self>) {
        let Some(r) = self.relations.iter().find(|r| r.id == relation) else {
            return;
        };
        let direction = match r.direction {
            RelationDirection::Directed => RelationDirection::Symmetric,
            RelationDirection::Symmetric => RelationDirection::Directed,
        };
        let id = relation.to_owned();
        self.write(
            cx,
            move |lib, book| {
                lib.run::<SetDirection>(&Actor::User, DirectionIn { book, id, direction })
            },
            |_, _, _| {},
        );
    }

    /// Starts editing a card's description.
    pub fn start_describe(&mut self, relation: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(r) = self.relations.iter().find(|r| r.id == relation) else {
            return;
        };
        let start = draft_of(&r.description);
        let book = self.book.clone();
        let candidates: Candidates =
            Rc::new(move |query, _| entry_candidates(&book, query, &[]));
        let id = SharedString::from(format!("relations-desc-{relation}"));
        let draft = start.clone();
        let area = cx.new(|cx| {
            LinkedArea::new(
                id,
                draft,
                candidates,
                |a| a.submit_on_enter(),
                window,
                cx,
            )
        });
        let sub = cx.subscribe_in(&area, window, |rail, _, e: &LinkedEvent, _, cx| match e {
            LinkedEvent::Submitted | LinkedEvent::Blurred => rail.commit_describe(cx),
            LinkedEvent::Cancelled => {
                rail.describe = None;
                cx.notify();
            }
        });
        area.update(cx, |a, cx| a.focus(window, cx));
        self.rename = None;
        self.describe = Some(Describe {
            relation: relation.to_owned(),
            area,
            start,
            failed: false,
            _sub: sub,
        });
        cx.notify();
    }

    /// Saves the description being edited, if it changed: its words and the
    /// links it still has (the book links the names written in it).
    pub fn commit_describe(&mut self, cx: &mut Context<Self>) {
        let Some(d) = &self.describe else {
            return;
        };
        let draft = d.area.read(cx).draft().clone();
        if draft == d.start {
            self.describe = None;
            cx.notify();
            return;
        }
        let id = d.relation.clone();
        let description = LinkedTextIn::Linked(linked_text(&draft));
        self.write(
            cx,
            move |lib, book| {
                lib.run::<SetDescription>(
                    &Actor::User,
                    DescriptionIn {
                        book,
                        id,
                        description,
                    },
                )
            },
            |rail, out, cx| match out {
                Ok(_) => rail.describe = None,
                Err(_) => {
                    if let Some(d) = &mut rail.describe {
                        d.failed = true;
                    }
                    cx.notify();
                }
            },
        );
    }

    /// 重试 under a name or a description that did not save.
    pub fn retry(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.rename.as_ref().is_some_and(|r| r.failed) {
            self.commit_rename(window, cx);
        } else if self.describe.as_ref().is_some_and(|d| d.failed) {
            self.commit_describe(cx);
        }
    }

    /// The card's ＋: a new row, a draft until both sides have an entry.
    pub fn add_row(&mut self, relation: &str, cx: &mut Context<Self>) {
        self.next_draft += 1;
        self.drafts.push(DraftRow {
            key: self.next_draft,
            relation: Some(relation.to_owned()),
            left: Vec::new(),
            right: Vec::new(),
        });
        cx.notify();
    }

    /// Opens a side's ＋ list.
    pub fn open_picker(
        &mut self,
        row: RowKey,
        relation: &str,
        side: RelationSide,
        anchor: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let field = cx.new(|cx| {
            TextField::new(SharedString::from("relations-pick-field"), window, cx).bare()
        });
        let sub = cx.subscribe_in(&field, window, |rail, _, e: &FieldEvent, window, cx| match e {
            FieldEvent::Changed(text) => {
                if let Some(p) = &mut rail.picker {
                    p.query = text.clone();
                }
                cx.notify();
            }
            FieldEvent::Submitted(_) => {
                if let Some(first) = rail.picker_items().first().cloned() {
                    rail.pick(&first.target, window, cx);
                }
            }
            FieldEvent::Cancelled => rail.close_picker(cx),
            FieldEvent::Blurred => {}
        });
        let handle = field.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
        self.picker = Some(Picker {
            row,
            relation: relation.to_owned(),
            side,
            field,
            query: String::new(),
            anchor,
            _sub: sub,
        });
        cx.notify();
    }

    pub fn close_picker(&mut self, cx: &mut Context<Self>) {
        self.picker = None;
        cx.notify();
    }

    /// The entries the open ＋ list shows.
    pub fn picker_items(&self) -> Vec<AtItem> {
        let Some(p) = &self.picker else {
            return Vec::new();
        };
        let side = self.side_members(&p.row, p.side);
        self.find_entries(p.query.trim(), &side)
    }

    fn side_members(&self, row: &RowKey, side: RelationSide) -> Vec<String> {
        match row {
            RowKey::Stored(id) => self
                .relations
                .iter()
                .flat_map(|r| &r.rows)
                .find(|r| &r.id == id)
                .map(|r| match side {
                    RelationSide::Left => r.left.clone(),
                    RelationSide::Right => r.right.clone(),
                })
                .unwrap_or_default(),
            RowKey::Draft(key) => self
                .drafts
                .iter()
                .find(|d| d.key == *key)
                .map(|d| match side {
                    RelationSide::Left => d.left.clone(),
                    RelationSide::Right => d.right.clone(),
                })
                .unwrap_or_default(),
        }
    }

    /// Picks `entry` in the open ＋ list.
    pub fn pick(&mut self, entry: &str, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(p) = self.picker.take() else {
            return;
        };
        self.add_entry(&p.row, p.side, entry, cx);
        cx.notify();
    }

    /// Adds `entry` to a side of a row: written at once to a row in the
    /// book; a draft keeps it until both sides have an entry, then is
    /// written.
    pub fn add_entry(
        &mut self,
        row: &RowKey,
        side: RelationSide,
        entry: &str,
        cx: &mut Context<Self>,
    ) {
        match row {
            RowKey::Stored(id) => {
                let (id, entry) = (id.clone(), entry.to_owned());
                self.write(
                    cx,
                    move |lib, book| {
                        lib.run::<AddEntry>(
                            &Actor::User,
                            AddEntryIn {
                                book,
                                id,
                                side,
                                entry,
                            },
                        )
                    },
                    |_, _, _| {},
                );
            }
            RowKey::Draft(key) => {
                let Some(d) = self.drafts.iter_mut().find(|d| d.key == *key) else {
                    return;
                };
                let (mine, other) = match side {
                    RelationSide::Left => (&mut d.left, &d.right),
                    RelationSide::Right => (&mut d.right, &d.left),
                };
                if mine.iter().any(|e| e == entry) || other.iter().any(|e| e == entry) {
                    return;
                }
                mine.push(entry.to_owned());
                if !d.left.is_empty() && !d.right.is_empty() {
                    let d = d.clone();
                    self.write_draft(d, cx);
                }
            }
        }
    }

    /// Writes a draft whose sides both have an entry: its first pair, then
    /// the others on the row it landed on.
    fn write_draft(&mut self, d: DraftRow, cx: &mut Context<Self>) {
        let Some(relation) = d.relation.clone() else {
            return;
        };
        self.drafts.retain(|x| x.key != d.key);
        self.write(
            cx,
            move |lib, book| {
                let placed = lib
                    .run::<CreatePair>(
                        &Actor::User,
                        PairIn {
                            book: book.clone(),
                            left: d.left[0].clone(),
                            right: d.right[0].clone(),
                            relation_type: Some(relation),
                            new_type: None,
                        },
                    )?
                    .output;
                let rest = d.left[1..]
                    .iter()
                    .map(|e| (RelationSide::Left, e))
                    .chain(d.right[1..].iter().map(|e| (RelationSide::Right, e)));
                for (side, entry) in rest {
                    lib.run::<AddEntry>(
                        &Actor::User,
                        AddEntryIn {
                            book: book.clone(),
                            id: placed.id.clone(),
                            side,
                            entry: entry.clone(),
                        },
                    )?;
                }
                Ok(placed.id)
            },
            |_, _, _| {},
        );
    }

    /// × after a name: out of this row (the row goes when its side empties).
    pub fn remove_entry(&mut self, row: &RowKey, entry: &str, cx: &mut Context<Self>) {
        match row {
            RowKey::Stored(id) => {
                let (id, entry) = (id.clone(), entry.to_owned());
                self.write(
                    cx,
                    move |lib, book| {
                        lib.run::<RemoveEntry>(&Actor::User, RemoveEntryIn { book, id, entry })
                    },
                    |_, _, _| {},
                );
            }
            RowKey::Draft(key) => {
                if let Some(d) = self.drafts.iter_mut().find(|d| d.key == *key) {
                    d.left.retain(|e| e != entry);
                    d.right.retain(|e| e != entry);
                }
                cx.notify();
            }
        }
    }

    /// The row's bin. A draft going that was its card's last row takes the
    /// relation with it (one with no rows in the book, hidden ones neither).
    pub fn delete_row(&mut self, row: &RowKey, cx: &mut Context<Self>) {
        if self.hover.as_ref() == Some(row) {
            self.hover = None;
            shell_rel::set_rail_hover(None, cx);
        }
        match row {
            RowKey::Stored(id) => {
                let id = id.clone();
                self.write(
                    cx,
                    move |lib, book| lib.run::<DeleteRow>(&Actor::User, EntityIn { book, id }),
                    |_, _, _| {},
                );
            }
            RowKey::Draft(key) => {
                let Some(d) = self.drafts.iter().find(|d| d.key == *key).cloned() else {
                    return;
                };
                self.drafts.retain(|x| x.key != *key);
                let Some(relation) = d.relation else {
                    // The new card's only row: the card goes with it.
                    self.rename = None;
                    cx.notify();
                    return;
                };
                let last = self.drafts.iter().all(|x| x.relation.as_ref() != Some(&relation))
                    && self
                        .relations
                        .iter()
                        .find(|r| r.id == relation)
                        .is_some_and(|r| r.rows.is_empty() && r.hidden_rows.is_empty());
                if last {
                    self.write(
                        cx,
                        move |lib, book| {
                            lib.run::<Delete>(&Actor::User, EntityIn { book, id: relation })
                        },
                        |_, _, _| {},
                    );
                }
                cx.notify();
            }
        }
    }

    /// The pointer came onto a row (or left them all): the prose draws it.
    pub fn set_hover(&mut self, row: Option<RowKey>, cx: &mut Context<Self>) {
        if self.hover == row {
            return;
        }
        self.hover = row.clone();
        let rail_row = match &row {
            Some(RowKey::Stored(id)) => self.rail_row(id),
            _ => None,
        };
        shell_rel::set_rail_hover(rail_row, cx);
        cx.notify();
    }

    /// A row as the prose draws it.
    pub fn rail_row(&self, id: &str) -> Option<RailRow> {
        self.relations.iter().find_map(|r| {
            r.rows.iter().find(|row| row.id == id).map(|row| RailRow {
                book: self.book.id.clone(),
                row: row.id.clone(),
                name: r.name.clone(),
                directed: r.direction == RelationDirection::Directed,
                left: row.left.clone(),
                right: row.right.clone(),
            })
        })
    }

    /// Reveals the waiting row once it is drawn: scrolls it into view and
    /// flashes it. Called after a frame recorded the rows' bounds.
    pub(crate) fn reveal_drawn(&mut self, cx: &mut Context<Self>) {
        let Some(reveal) = shell_rel::pending_reveal(&self.book.id, cx) else {
            return;
        };
        if !self.loaded || self.writing > 0 {
            return;
        }
        let Some(row) = self.row_bounds.borrow().get(&reveal.row).copied() else {
            let known = self
                .relations
                .iter()
                .any(|r| r.rows.iter().any(|row| row.id == reveal.row));
            if !known {
                // Not in the book as read: wait for the next read, which
                // the write that made it is about to trigger.
                return;
            }
            if self.current {
                // A row 「当前」 leaves out: show them all.
                self.current = false;
                cx.notify();
            }
            return;
        };
        let list = self.scroll.bounds();
        let offset = self.scroll.offset();
        let max = self.scroll.max_offset();
        let want = offset.y - (row.top() - list.top() - gpui::px(80.0));
        let y = want.max(-max.y).min(gpui::px(0.0));
        self.scroll.set_offset(gpui::point(offset.x, y));
        self.flash = Some((reveal.row.clone(), Instant::now()));
        shell_rel::take_reveal(reveal.serial, cx);
        cx.notify();
    }

    /// The row flashing now and how far through (0 to 1).
    pub(crate) fn flash_of(&self, row: &str) -> Option<f32> {
        let (id, at) = self.flash.as_ref()?;
        (id == row).then(|| (at.elapsed().as_secs_f32() / FLASH_SECS).min(1.0))
    }

    /// The row flashing, for tests.
    pub fn flashing(&self) -> Option<&str> {
        self.flash
            .as_ref()
            .filter(|(_, at)| at.elapsed().as_secs_f32() < FLASH_SECS)
            .map(|(id, _)| id.as_str())
    }
}

/// How long a revealed row flashes (the prototype's 1.6 s).
pub(crate) const FLASH_SECS: f32 = 1.6;

/// One card as shown: its relation (`None`: the new card being named), its
/// rows that are shown, its drafts.
#[derive(Clone, Debug)]
pub struct Card {
    pub relation: Option<RelationInfo>,
    pub rows: Vec<dr_workspace::commands::v3::relations::RowInfo>,
    pub drafts: Vec<DraftRow>,
}

/// The `@` list over the book's live entries: titles containing `query`
/// (any case; all of them for none), the ones in `except` left out, those
/// starting with it first.
pub fn entry_candidates(book: &Book, query: &str, except: &[String]) -> Vec<AtItem> {
    let Some(v3) = book.v3() else {
        return Vec::new();
    };
    let q = query.trim().to_lowercase();
    let mut hits: Vec<(bool, AtItem)> = v3
        .entries
        .iter()
        .filter(|e| !e.title.trim().is_empty() && !except.iter().any(|x| x == &e.id))
        .filter_map(|e| {
            let title = e.title.to_lowercase();
            if !q.is_empty() && !title.contains(&q) {
                return None;
            }
            let target = Target::Entry {
                id: e.id.parse().ok()?,
                module: None,
            };
            Some((
                !q.is_empty() && title.starts_with(&q),
                AtItem {
                    target: e.id.clone().into(),
                    label: e.title.clone().into(),
                    detail: v3.template_of(&e.id).map(|t| t.name.clone().into()),
                    mark: book.mark(&target).0,
                },
            ))
        })
        .collect();
    hits.sort_by_key(|(prefix, _)| !*prefix);
    hits.into_iter().map(|(_, item)| item).collect()
}

/// A stored text with its links as the editor takes it.
pub fn draft_of(text: &LinkedText) -> Draft {
    Draft::from_chars(
        text.text.clone(),
        text.links
            .iter()
            .map(|l| (l.start, l.end, SharedString::from(l.entry.to_string()))),
    )
}

/// An edited text with its links as the book takes it (links whose target
/// is not an entry id are dropped).
pub fn linked_text(draft: &Draft) -> LinkedText {
    LinkedText {
        text: draft.text.clone(),
        links: draft
            .char_links()
            .into_iter()
            .filter_map(|(start, end, target)| {
                Some(EntryTextLink {
                    start,
                    end,
                    entry: target.parse().ok()?,
                })
            })
            .collect(),
    }
}

/// A description's words and links for [`dr_ui::linked::linked`].
pub fn shown_text(text: &LinkedText) -> Draft {
    draft_of(text)
}

/// The links of a draft by target, for tests.
pub fn link_targets(draft: &Draft) -> BTreeSet<String> {
    draft.links.iter().map(|l: &Link| l.target.to_string()).collect()
}

/// The 「关系」 tab's words (the shell's label), for tests.
pub fn tab_label(cx: &App) -> SharedString {
    t(cx, keys::v5_relations::TAB)
}
