//! A custom module on its entry's page (CM2, `custom-modules.md` §4, §16
//! items 5 and 6): the book's copy of the module drawn by
//! `dr-view-module-look` with the entry's values, at 一块, or at 铺满 while
//! it fills the middle column (its button at the right of its title row).
//!
//! Filling in is done in place, with the controls the 「字段」 module has
//! (`dr-view-elements`' `fields/v3.rs`): words (一行字、一段字、数字、日期)
//! are typed into a borderless field in the value's own type, stored when
//! it is left (Enter for one line, Esc puts the stored words back); a
//! single choice, several choices, entries and an image are picked from the
//! list a select opens, opened on the value itself; a toggle turns when
//! pressed; a number shown as dots is typed into while it is pressed. A
//! list's items have a grip to drag them into another place and a button to
//! take one away, and the list a row to add one. Every change is one
//! command (`module.set_custom_value`, `add_custom_item`,
//! `remove_custom_item`, `move_custom_item`), one step of undo; nothing is
//! written by replacing what was read.
//!
//! A copy this build cannot read, or a module the book has no copy of, is
//! an empty block with only the module's name; its values stay as they are.
//! Comments land on the whole module, by the title row's margin button the
//! page gives every module.

use std::collections::{BTreeMap, VecDeque};

use dr_i18n::keys;
use dr_model::custom_module::values::{InputValue, ItemStep};
use dr_model::custom_module::{BlockKind, LookSize, Show};
use dr_shell::{
    book::Book,
    strings::tf,
    t,
    v3::{ModuleHost, Rendered},
    workspace::{FilledModule, Workspace as ShellWorkspace},
};
use dr_ui::{
    Theme,
    components::{Button, Menu, MenuItem, PanelIconButton, overlay},
    fonts::Role,
    input::{FieldEvent, TextArea},
    sand::{self, Icon},
    style::DrStyled,
    tokens::radius,
};
use dr_view_module_look::{
    self as look, Blanks, Content, Edit, Names, PEach, PItem, PValue, Picture, Scope, Shown,
    paint::{is_wordy, typed},
};
use dr_workspace::{
    Actor, WsError,
    commands::v3::custom_module::{
        AddItemIn, CustomAddItem, CustomData, CustomIn, CustomMoveItem, CustomRead,
        CustomRemoveItem, CustomSetValue, ItemIn, ListAt, MoveItemIn, SetValueIn,
    },
    events::WsEvent,
};
use gpui::{prelude::*, *};
use std::rc::Rc;

use crate::settlement::{self, Drafts, Drain};

/// Registers the custom module's view with the shell, and the words a look
/// writes itself (an automatic 一行's 「3 个伏笔」) in the App's language.
pub fn register(cx: &mut App) {
    look::set_words(cx, |count, list, cx| {
        tf(
            cx,
            keys::custom_module::COUNT_OF,
            &[("count", &count), ("name", &list)],
        )
        .to_string()
    });
    dr_shell::v3::add_module_view(cx, "custom", |host, window, cx| {
        let (ws, entry, module) = (
            host.page.workspace.clone(),
            host.entry.clone(),
            host.module.id.clone(),
        );
        let view = cx.new(|cx| CustomModule::new(host, window, cx));
        let weak = view.downgrade();
        Rendered::new(view)
            .on_refresh(move |book, cx| {
                weak.update(cx, |v, cx| v.refresh(book, cx)).ok();
            })
            .with_head_action(move |_, cx| fill_button(&ws, &entry, &module, cx))
    });
}

/// The module's 铺满 button at the right of its title row: shown while the
/// pointer is on the row, or while the module fills the column.
fn fill_button(ws: &WeakEntity<ShellWorkspace>, entry: &str, module: &str, cx: &App) -> AnyElement {
    let filled = FilledModule::is(cx, entry, module);
    let (ws, entry_id, module_id) = (ws.clone(), entry.to_owned(), module.to_owned());
    let button = PanelIconButton::new(
        SharedString::from(format!("custom-fill-{module}")),
        if filled {
            Icon::WindowRestore
        } else {
            Icon::Fullscreen
        },
    )
    .label(t(
        cx,
        if filled {
            keys::v5_fill::EXIT_FILL
        } else {
            keys::v5_fill::FILL
        },
    ))
    .on_click(move |_, window, cx| {
        cx.stop_propagation();
        if let Some(ws) = ws.upgrade() {
            ws.update(cx, |ws, cx| {
                ws.toggle_module_fill(&entry_id, &module_id, window, cx)
            });
        }
    });
    let group = SharedString::from(format!("v3-mod-head-{module}"));
    div()
        .debug_selector(|| "custom-module-fill".into())
        .when(!filled, |el| {
            el.invisible().group_hover(group, |st| st.visible())
        })
        .child(button)
        .into_any_element()
}

/// What the book holds for the module, as last read.
#[derive(Clone)]
struct Loaded {
    data: CustomData,
    /// The book's images, for an image value's list.
    images: Vec<(String, String)>,
    /// The pictures the values point to.
    pictures: BTreeMap<String, Picture>,
}

/// Where a value is kept: the items down to its scope, and its block.
#[derive(Clone, Debug, PartialEq)]
struct Slot {
    path: Vec<ItemStep>,
    block: String,
    kind: BlockKind,
}

/// The key a value's field and menu are kept by.
fn slot_key(path: &[ItemStep], block: &str) -> String {
    let mut key = String::new();
    for step in path {
        key.push_str(&step.list);
        key.push(':');
        key.push_str(&step.item);
        key.push('/');
    }
    key.push_str(block);
    key
}

struct Input {
    area: Entity<TextArea>,
    slot: Slot,
    dirty: bool,
    draft: String,
    /// The words the draft was made from.
    base: String,
    _event: Subscription,
}

/// A choice list open on a value.
struct OpenMenu {
    slot: Slot,
    at: Point<Pixels>,
    /// The value it was opened on.
    current: Option<Shown>,
    options: Vec<String>,
}

/// What a field sent: its key, the words, and the words they replace.
#[derive(Clone, Debug)]
struct Sent {
    key: String,
    draft: String,
    base: String,
}

/// One command, run in order.
#[derive(Clone, Debug)]
enum Op {
    Set {
        path: Vec<ItemStep>,
        block: String,
        value: InputValue,
        /// The field it came from (`None`: a choice, a toggle).
        from: Option<Sent>,
    },
    Add {
        path: Vec<ItemStep>,
        list: String,
    },
    Remove {
        path: Vec<ItemStep>,
        list: String,
        item: String,
    },
    Move {
        path: Vec<ItemStep>,
        list: String,
        item: String,
        to: usize,
    },
}

/// An item being dragged into another place in its list.
#[derive(Clone)]
pub struct ItemDrag {
    /// `<entry>/<module>/<the list's path and id>`: drops land in this list.
    list_key: String,
    item: String,
    label: SharedString,
}

struct ItemGhost {
    label: SharedString,
}

impl Render for ItemGhost {
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

pub struct CustomModule {
    host: ModuleHost,
    loaded: Option<Loaded>,
    reading: bool,
    stale: bool,
    inputs: BTreeMap<String, Input>,
    menu: Option<OpenMenu>,
    /// The number shown as dots being typed into.
    dots: Option<String>,
    /// The field that takes the keyboard once it is made.
    focus_next: Option<String>,
    queue: VecDeque<Op>,
    writing: bool,
    /// What went wrong with the last write, shown under the module.
    error: Option<dr_i18n::Key>,
    _bus: Option<dr_workspace::events::Subscription>,
    _bus_task: Option<Task<()>>,
    _fill: Subscription,
}

impl CustomModule {
    pub fn new(host: ModuleHost, window: &mut Window, cx: &mut Context<Self>) -> Self {
        settlement::register(&host.page.library, window.window_handle(), cx);
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<()>();
        let watched = host.page.book_id.clone();
        let bus = host.page.library.subscribe(move |ev| {
            if let WsEvent::Book(b) = ev
                && b.book.as_str() == watched
            {
                let _ = tx.unbounded_send(());
            }
        });
        let bus_task = cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                while rx.try_recv().is_ok() {}
                if this.update(cx, |v, cx| v.reload(cx)).is_err() {
                    break;
                }
            }
        });
        if !cx.has_global::<FilledModule>() {
            cx.set_global(FilledModule::default());
        }
        let fill = cx.observe_global::<FilledModule>(|_, cx| cx.notify());
        let mut this = Self {
            host,
            loaded: None,
            reading: false,
            stale: false,
            inputs: BTreeMap::new(),
            menu: None,
            dots: None,
            focus_next: None,
            queue: VecDeque::new(),
            writing: false,
            error: None,
            _bus: Some(bus),
            _bus_task: Some(bus_task),
            _fill: fill,
        };
        this.reload(cx);
        this
    }

    pub fn refresh(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
        if let Some(module) = book
            .v3()
            .and_then(|b| b.template_of(&self.host.entry))
            .and_then(|t| t.modules.iter().find(|m| m.id == self.host.module.id))
        {
            self.host.module = module.clone();
        }
        self.host.page.book = book;
        self.reload(cx);
        cx.notify();
    }

    /// Nothing typed but not stored, nothing being written or read.
    pub fn is_settled(&self) -> bool {
        !self.reading
            && !self.writing
            && self.queue.is_empty()
            && self.error.is_none()
            && self.inputs.values().all(|i| !i.dirty)
    }

    /// Whether the book's copy could be read (`None` before the first read).
    pub fn is_broken(&self) -> Option<bool> {
        self.loaded.as_ref().map(|l| l.data.value.is_none())
    }

    /// The field a value is typed into (`path` from the entry down to its
    /// item, each step a list and an item id), for tests and the bridge.
    pub fn input(&self, path: &[(&str, &str)], block: &str) -> Option<Entity<TextArea>> {
        let steps: Vec<ItemStep> = path
            .iter()
            .map(|(list, item)| ItemStep {
                list: (*list).to_owned(),
                item: (*item).to_owned(),
            })
            .collect();
        self.inputs
            .get(&slot_key(&steps, block))
            .map(|i| i.area.clone())
    }

    /// What the page reads of the module (for tests and the bridge).
    pub fn data(&self) -> Option<&CustomData> {
        self.loaded.as_ref().map(|l| &l.data)
    }

    fn target(&self) -> CustomIn {
        CustomIn {
            book: self.host.page.book_id.clone(),
            entry: self.host.entry.clone(),
            module: self.host.module.id.clone(),
        }
    }

    /// Reads the module again (after the book changed).
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        if self.reading {
            self.stale = true;
            return;
        }
        self.reading = true;
        let lib = self.host.page.library.clone();
        let target = self.target();
        let read = cx.background_spawn(async move { read(&lib, target) });
        cx.spawn(async move |this, cx| {
            let result = read.await;
            this.update(cx, |v, cx| {
                v.reading = false;
                match result {
                    Ok(loaded) => v.loaded = Some(loaded),
                    Err(e) => log::warn!("custom module: {e}"),
                }
                if std::mem::take(&mut v.stale) {
                    v.reload(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The value kept at `slot`, as last read.
    fn shown_at(&self, slot: &Slot) -> Option<Shown> {
        let loaded = self.loaded.as_ref()?;
        let names = BookNames {
            book: &self.host.page.book,
            pictures: &loaded.pictures,
        };
        let mut scope = Scope::read(&loaded.data.values, &names);
        for step in &slot.path {
            scope = scope
                .lists
                .remove(&step.list)?
                .into_iter()
                .find(|i| i.id.as_deref() == Some(step.item.as_str()))?
                .scope;
        }
        scope.plain.remove(&slot.block)
    }

    /// Fields for the values typed into, kept by where the value is, so
    /// what is being typed survives the module being read again.
    fn sync_inputs(&mut self, values: &[&PValue], window: &mut Window, cx: &mut Context<Self>) {
        // While a write or the read after it is under way, what was read is
        // older than what the fields hold.
        let busy = self.writing || !self.queue.is_empty() || self.reading;
        for v in values {
            let key = slot_key(&v.path, &v.block);
            let typed_in = is_wordy(v.kind)
                && (v.show != Show::Dots || self.dots.as_deref() == Some(key.as_str()));
            if !typed_in || v.path.iter().any(|s| s.item.is_empty()) {
                continue;
            }
            let base = match &v.content {
                Content::Words(s) => s.clone(),
                Content::Dots { .. } => match self.shown_at(&Slot {
                    path: v.path.clone(),
                    block: v.block.clone(),
                    kind: v.kind,
                }) {
                    Some(Shown::Number(n)) => look::plan::number_words(n),
                    _ => String::new(),
                },
                _ => String::new(),
            };
            if let Some(input) = self.inputs.get_mut(&key) {
                if busy || input.dirty {
                    continue;
                }
                let focused = input.area.focus_handle(cx).is_focused(window);
                if !focused && input.area.read(cx).text() != base {
                    input.area.update(cx, |a, cx| a.set_text(base.clone(), cx));
                    input.draft = base.clone();
                }
                if !focused {
                    input.base = base;
                }
                continue;
            }
            let id = SharedString::from(format!(
                "custom-field-{}-{}-{key}",
                self.host.entry, self.host.module.id
            ));
            let one_line = v.kind != BlockKind::LongText;
            let area = cx.new(|cx| {
                let a = TextArea::new(id, window, cx)
                    .placeholder(v.name.clone())
                    .with_text(base.clone());
                if one_line { a.submit_on_enter() } else { a }
            });
            let event_key = key.clone();
            let event = cx.subscribe_in(&area, window, move |v, area, event, window, cx| {
                v.field_event(&event_key, area, event, window, cx)
            });
            self.inputs.insert(
                key,
                Input {
                    area,
                    slot: Slot {
                        path: v.path.clone(),
                        block: v.block.clone(),
                        kind: v.kind,
                    },
                    dirty: false,
                    draft: base.clone(),
                    base,
                    _event: event,
                },
            );
        }
    }

    fn field_event(
        &mut self,
        key: &str,
        area: &Entity<TextArea>,
        event: &FieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            FieldEvent::Changed(text) => {
                if let Some(input) = self.inputs.get_mut(key) {
                    if settlement::accepts(cx) {
                        input.draft = text.clone();
                        input.dirty = true;
                    } else {
                        area.update(cx, |a, cx| a.set_text(input.draft.clone(), cx));
                    }
                }
            }
            FieldEvent::Blurred | FieldEvent::Submitted(_) => {
                // A number shown as dots goes back to its dots once what was
                // typed is a number (or nothing); otherwise the field stays,
                // with what is wrong under the module.
                let stored = self.flush(key, cx);
                if stored && self.dots.as_deref() == Some(key) {
                    self.dots = None;
                    cx.notify();
                }
                if stored && matches!(event, FieldEvent::Submitted(_)) {
                    window.blur(cx);
                }
            }
            FieldEvent::Cancelled => {
                if let Some(input) = self.inputs.get_mut(key) {
                    let base = input.base.clone();
                    area.update(cx, |a, cx| a.set_text(base.clone(), cx));
                    input.draft = base;
                    input.dirty = false;
                }
                self.error = None;
                if self.dots.as_deref() == Some(key) {
                    self.dots = None;
                }
                cx.notify();
            }
        }
    }

    /// Stores what was typed into `key`, if it changed. Whether the words
    /// fit the value (nothing to store counts).
    fn flush(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        if !settlement::accepts(cx) {
            return true;
        }
        let Some(input) = self.inputs.get(key).filter(|i| i.dirty) else {
            return true;
        };
        if input.draft == input.base {
            if let Some(input) = self.inputs.get_mut(key) {
                input.dirty = false;
            }
            return true;
        }
        let Some(value) = typed_value(input.slot.kind, &input.draft) else {
            self.error = Some(keys::k4_pages::INVALID_VALUE);
            cx.notify();
            return false;
        };
        let op = Op::Set {
            path: input.slot.path.clone(),
            block: input.slot.block.clone(),
            value,
            from: Some(Sent {
                key: key.to_owned(),
                draft: input.draft.clone(),
                base: input.base.clone(),
            }),
        };
        // Sent: leaving the field again (Enter, then the blur it brings)
        // sends nothing more.
        if let Some(input) = self.inputs.get_mut(key) {
            input.base = input.draft.clone();
            input.dirty = false;
        }
        self.error = None;
        self.push(op, cx);
        true
    }

    fn push(&mut self, op: Op, cx: &mut Context<Self>) {
        if !settlement::accepts(cx) {
            return;
        }
        self.queue.push_back(op);
        self.pump(cx);
    }

    fn pump(&mut self, cx: &mut Context<Self>) {
        if self.writing {
            return;
        }
        let Some(op) = self.queue.pop_front() else {
            return;
        };
        self.writing = true;
        let lib = self.host.page.library.clone();
        let worker = lib.clone();
        let target = self.target();
        let sent = op.clone();
        let (job, ticket) = settlement::write(&lib, cx, async move { run(&worker, target, op) });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            if this
                .update(cx, |v, cx| {
                    v.writing = false;
                    match result {
                        Ok(()) => {}
                        Err(e) => {
                            log::warn!("custom module write: {e}");
                            v.queue.clear();
                            v.error = Some(keys::k4_pages::SAVE_FAILED);
                            // What was sent is typed but not stored again.
                            if let Op::Set {
                                from: Some(sent), ..
                            } = &sent
                                && let Some(input) = v.inputs.get_mut(&sent.key)
                                && input.draft == sent.draft
                            {
                                input.base = sent.base.clone();
                                input.dirty = true;
                            }
                        }
                    }
                    v.reload(cx);
                    v.pump(cx);
                    cx.notify();
                })
                .is_ok()
            {
                ticket.acknowledge();
            }
        })
        .detach();
    }

    /// Moves `item` of the list `list` (in the scope `path` leads to) to
    /// place `to` (what dropping it on another item does).
    pub fn move_item(
        &mut self,
        path: Vec<ItemStep>,
        list: &str,
        item: &str,
        to: usize,
        cx: &mut Context<Self>,
    ) {
        self.push(
            Op::Move {
                path,
                list: list.to_owned(),
                item: item.to_owned(),
                to,
            },
            cx,
        );
    }

    /// Writes again what is typed but not stored (「重试」).
    fn retry(&mut self, cx: &mut Context<Self>) {
        self.error = None;
        let keys: Vec<String> = self.inputs.keys().cloned().collect();
        for key in keys {
            self.flush(&key, cx);
        }
        cx.notify();
    }

    fn toggle(&mut self, slot: Slot, cx: &mut Context<Self>) {
        let on = matches!(self.shown_at(&slot), Some(Shown::Toggle(true)));
        self.push(
            Op::Set {
                path: slot.path,
                block: slot.block,
                value: InputValue::Bool(!on),
                from: None,
            },
            cx,
        );
    }

    fn open_menu(
        &mut self,
        slot: Slot,
        options: Vec<String>,
        at: Point<Pixels>,
        cx: &mut Context<Self>,
    ) {
        let current = self.shown_at(&slot);
        self.menu = Some(OpenMenu {
            slot,
            at,
            current,
            options,
        });
        cx.notify();
    }

    fn edit_dots(&mut self, key: String, cx: &mut Context<Self>) {
        self.dots = Some(key.clone());
        // The field is made at the next render; it takes the keyboard then.
        self.focus_next = Some(key);
        cx.notify();
    }

    /// A row of the open choice list was picked: `choice` is an option, an
    /// entry id or an image id (`None`: 「未设置」).
    fn pick(&mut self, choice: Option<String>, cx: &mut Context<Self>) {
        let Some(menu) = self.menu.take() else {
            return;
        };
        let value = match (menu.slot.kind, choice) {
            (_, None) => InputValue::Null,
            (BlockKind::Select | BlockKind::Image, Some(c)) => InputValue::Text(c),
            (BlockKind::MultiSelect, Some(c)) => {
                let mut xs = match menu.current {
                    Some(Shown::Choices(xs)) => xs,
                    _ => Vec::new(),
                };
                if let Some(i) = xs.iter().position(|x| *x == c) {
                    xs.remove(i);
                } else {
                    xs.push(c);
                }
                InputValue::Texts(xs)
            }
            (BlockKind::Entry, Some(c)) => {
                let mut ids: Vec<String> = match menu.current {
                    Some(Shown::Entries(xs)) => xs.into_iter().filter_map(|e| e.id).collect(),
                    _ => Vec::new(),
                };
                if let Some(i) = ids.iter().position(|x| *x == c) {
                    ids.remove(i);
                } else {
                    ids.push(c);
                }
                if ids.is_empty() {
                    InputValue::Null
                } else {
                    InputValue::Texts(ids)
                }
            }
            _ => return,
        };
        self.push(
            Op::Set {
                path: menu.slot.path,
                block: menu.slot.block,
                value,
                from: None,
            },
            cx,
        );
        cx.notify();
    }

    fn render_menu(
        &self,
        menu: &OpenMenu,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let unset = t(cx, keys::k4_pages::UNSET);
        let current = menu.current.clone();
        // (label, checked, what it picks)
        let mut rows: Vec<(SharedString, bool, Option<String>)> = Vec::new();
        match menu.slot.kind {
            BlockKind::Select => {
                let picked = match &current {
                    Some(Shown::Text(s)) => Some(s.clone()),
                    _ => None,
                };
                rows.push((unset, picked.is_none(), None));
                rows.extend(menu.options.iter().map(|o| {
                    (
                        SharedString::from(o.clone()),
                        picked.as_deref() == Some(o.as_str()),
                        Some(o.clone()),
                    )
                }));
            }
            BlockKind::MultiSelect => {
                let picked = match &current {
                    Some(Shown::Choices(xs)) => xs.clone(),
                    _ => Vec::new(),
                };
                rows.extend(menu.options.iter().map(|o| {
                    (
                        SharedString::from(o.clone()),
                        picked.contains(o),
                        Some(o.clone()),
                    )
                }));
            }
            BlockKind::Entry => {
                let picked: Vec<String> = match &current {
                    Some(Shown::Entries(xs)) => xs.iter().filter_map(|e| e.id.clone()).collect(),
                    _ => Vec::new(),
                };
                rows.push((unset, picked.is_empty(), None));
                if let Some(v3) = self.host.page.book.v3() {
                    rows.extend(
                        v3.entries
                            .iter()
                            .filter(|e| e.deleted_at.is_none())
                            .map(|e| {
                                (
                                    SharedString::from(e.title.clone()),
                                    picked.contains(&e.id),
                                    Some(e.id.clone()),
                                )
                            }),
                    );
                }
            }
            BlockKind::Image => {
                let picked = match &current {
                    Some(Shown::Image(p)) => p.id.clone(),
                    _ => None,
                };
                rows.push((unset, picked.is_none(), None));
                if let Some(loaded) = &self.loaded {
                    rows.extend(loaded.images.iter().map(|(id, name)| {
                        (
                            SharedString::from(name.clone()),
                            picked.as_deref() == Some(id.as_str()),
                            Some(id.clone()),
                        )
                    }));
                }
            }
            _ => {}
        }
        let base = format!("custom-menu-{}", self.host.module.id);
        let weak = cx.weak_entity();
        let items: Vec<AnyElement> = rows
            .into_iter()
            .enumerate()
            .map(|(i, (label, checked, choice))| {
                let weak = weak.clone();
                div()
                    .w_full()
                    .debug_selector(move || format!("custom-menu-row-{i}"))
                    .child(
                        MenuItem::plain(SharedString::from(format!("{base}-{i}")), label)
                            .checked(checked)
                            .on_click(move |_, _, cx| {
                                weak.update(cx, |v, cx| v.pick(choice.clone(), cx)).ok();
                            }),
                    )
                    .into_any_element()
            })
            .collect();
        let close = weak.clone();
        let list = Menu::new(SharedString::from(base.clone())).child(
            div()
                .id(SharedString::from(format!("{base}-scroll")))
                .debug_selector(|| "custom-menu-scroll".into())
                .max_h(px(280.0))
                .overflow_y_scroll()
                .children(items),
        );
        let _ = theme;
        overlay::float(
            overlay::Place::Point(menu.at),
            overlay::Layer::Popover,
            div()
                .debug_selector(|| "custom-module-menu".into())
                .on_mouse_down_out(move |_, _, cx| {
                    close
                        .update(cx, |v, cx| {
                            v.menu = None;
                            cx.notify();
                        })
                        .ok();
                })
                .child(list),
        )
        .into_any_element()
    }
}

/// What `typed` words store for a value of `kind` (`None`: they do not
/// fit it). Empty words clear the value.
fn typed_value(kind: BlockKind, text: &str) -> Option<InputValue> {
    if text.trim().is_empty() {
        return Some(InputValue::Null);
    }
    Some(match kind {
        BlockKind::Text => InputValue::Text(text.replace(['\n', '\r'], " ")),
        BlockKind::LongText => InputValue::Text(text.to_owned()),
        BlockKind::Number => {
            InputValue::Number(text.trim().parse::<f64>().ok().filter(|n| n.is_finite())?)
        }
        BlockKind::Date => {
            dr_model::Day::parse(text.trim())?;
            InputValue::Text(text.trim().to_owned())
        }
        _ => return None,
    })
}

/// The module and what it points to, read off the book (a background task).
fn read(lib: &dr_workspace::Workspace, target: CustomIn) -> Result<Loaded, WsError> {
    let book = target.book.clone();
    let data = lib.run::<CustomRead>(&Actor::User, target)?.output;
    let assets = dr_editor::v3::read(lib, &book, |v| {
        v.assets()
            .into_iter()
            .filter(|a| a.kind == dr_model::kind::AssetKind::Image)
            .map(|a| (a.id.to_string(), a.name))
            .collect::<Vec<_>>()
    })?;
    let mut wanted = Vec::new();
    collect_images(&data.values, &mut wanted);
    let mut pictures = BTreeMap::new();
    for id in wanted {
        let Some((_, name)) = assets.iter().find(|(a, _)| *a == id) else {
            continue;
        };
        let path = [
            dr_store::asset::Variant::Display,
            dr_store::asset::Variant::Thumbnail,
            dr_store::asset::Variant::Source,
        ]
        .into_iter()
        .find_map(|variant| {
            let rec = lib.library().asset(&id, variant).ok()??;
            rec.path.exists().then_some(rec.path)
        });
        pictures.insert(
            id.clone(),
            Picture {
                id: Some(id.clone()),
                name: name.clone(),
                path,
            },
        );
    }
    Ok(Loaded {
        data,
        images: assets,
        pictures,
    })
}

fn collect_images(
    values: &BTreeMap<String, dr_model::custom_module::values::BlockValue>,
    out: &mut Vec<String>,
) {
    use dr_model::custom_module::values::BlockValue;
    for value in values.values() {
        match value {
            BlockValue::Image(id) => out.push(id.clone()),
            BlockValue::List(items) => {
                for item in items {
                    collect_images(&item.values, out);
                }
            }
            _ => {}
        }
    }
}

fn run(lib: &dr_workspace::Workspace, target: CustomIn, op: Op) -> Result<(), WsError> {
    let actor = Actor::User;
    match op {
        Op::Set {
            path, block, value, ..
        } => lib
            .run::<CustomSetValue>(
                &actor,
                SetValueIn {
                    target,
                    path,
                    block,
                    value,
                },
            )
            .map(|_| ()),
        Op::Add { path, list } => lib
            .run::<CustomAddItem>(
                &actor,
                AddItemIn {
                    at: ListAt { target, path, list },
                    index: None,
                },
            )
            .map(|_| ()),
        Op::Remove { path, list, item } => lib
            .run::<CustomRemoveItem>(
                &actor,
                ItemIn {
                    at: ListAt { target, path, list },
                    item,
                },
            )
            .map(|_| ()),
        Op::Move {
            path,
            list,
            item,
            to,
        } => lib
            .run::<CustomMoveItem>(
                &actor,
                MoveItemIn {
                    at: ListAt { target, path, list },
                    item,
                    to,
                },
            )
            .map(|_| ()),
    }
}

/// Entry and image ids as the page draws them.
struct BookNames<'a> {
    book: &'a Book,
    pictures: &'a BTreeMap<String, Picture>,
}

impl Names for BookNames<'_> {
    fn entry(&self, id: &str) -> Option<String> {
        self.book
            .v3()?
            .entry(id)
            .filter(|e| e.deleted_at.is_none())
            .map(|e| e.title.clone())
    }

    fn image(&self, id: &str) -> Option<Picture> {
        self.pictures.get(id).cloned()
    }
}

/// The page's controls in the look's value nodes and list items.
struct Editor {
    view: WeakEntity<CustomModule>,
    inputs: BTreeMap<String, Entity<TextArea>>,
    /// `<entry>/<module>/`, the start of every list key.
    lists: String,
    /// The fields drawn so far: a look that shows one value twice has its
    /// field once (one view is never drawn in two places), the words
    /// elsewhere.
    drawn: std::cell::RefCell<std::collections::BTreeSet<String>>,
}

impl Editor {
    fn slot(v: &PValue) -> Slot {
        Slot {
            path: v.path.clone(),
            block: v.block.clone(),
            kind: v.kind,
        }
    }
}

impl Edit for Editor {
    fn value(
        &self,
        v: &PValue,
        id: ElementId,
        display: AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        // A sample's values are not the entry's.
        if v.path.iter().any(|s| s.item.is_empty()) {
            return display;
        }
        let key = slot_key(&v.path, &v.block);
        let theme = Theme::of(window, cx);
        if let Some(area) = self.inputs.get(&key) {
            if !self.drawn.borrow_mut().insert(key.clone()) {
                return display;
            }
            let selector = format!("custom-field-{key}");
            // Named by its block, as a field's row is (fields/v3.rs).
            return typed(div().id(id).min_w_0(), v.style, &theme)
                .debug_selector(move || selector.clone())
                .role(gpui::Role::Group)
                .aria_label(SharedString::from(v.name.clone()))
                .child(area.clone())
                .into_any_element();
        }
        let view = self.view.clone();
        let slot = Self::slot(v);
        let selector = format!("custom-value-{key}");
        let press = div()
            .id(id)
            .debug_selector(move || selector.clone())
            .min_w_0()
            .cursor_pointer()
            .role(gpui::Role::Button)
            .aria_label(SharedString::from(v.name.clone()))
            .child(display);
        match (v.kind, v.show) {
            (BlockKind::List, _) => press.into_any_element(),
            (BlockKind::Number, Show::Dots) => press
                .on_click(move |_, _, cx| {
                    let key = key.clone();
                    view.update(cx, |v, cx| v.edit_dots(key, cx)).ok();
                })
                .into_any_element(),
            (BlockKind::Toggle, _) => press
                .on_click(move |_, _, cx| {
                    let slot = slot.clone();
                    view.update(cx, |v, cx| v.toggle(slot, cx)).ok();
                })
                .into_any_element(),
            (
                BlockKind::Select | BlockKind::MultiSelect | BlockKind::Entry | BlockKind::Image,
                _,
            ) => {
                let options = v.options.clone();
                press
                    .on_click(move |e, _, cx| {
                        let (slot, options) = (slot.clone(), options.clone());
                        let at = e.position() + point(px(0.0), px(6.0));
                        view.update(cx, |v, cx| v.open_menu(slot, options, at, cx))
                            .ok();
                    })
                    .into_any_element()
            }
            _ => press.into_any_element(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn item(
        &self,
        each: &PEach,
        index: usize,
        item: &PItem,
        id: ElementId,
        body: AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let Some(item_id) = item.id.clone() else {
            return body;
        };
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let group = SharedString::from(format!("{}-{item_id}", self.lists));
        let list_key = format!("{}{}", self.lists, slot_key(&each.path, &each.list));
        let drag = ItemDrag {
            list_key: list_key.clone(),
            item: item_id.clone(),
            label: SharedString::from(each.name.clone()),
        };
        let (remove_view, path, list, remove_item) = (
            self.view.clone(),
            each.path.clone(),
            each.list.clone(),
            item_id.clone(),
        );
        let (drop_view, drop_path, drop_list) =
            (self.view.clone(), each.path.clone(), each.list.clone());
        let wash = p.ink(1).alpha(look::paint::WASH);
        let tools = div()
            .absolute()
            .top(px(-2.0))
            .right(px(-2.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(2.0))
            .px(px(2.0))
            .rounded(px(radius::SM))
            .bg(p.page.alpha(0.9))
            .invisible()
            .group_hover(group.clone(), |st| st.visible())
            .child(
                div()
                    .id(SharedString::from(format!("{group}-grip")))
                    .debug_selector({
                        let s = format!("custom-item-grip-{item_id}");
                        move || s.clone()
                    })
                    .size(px(18.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_grab()
                    .role(gpui::Role::Button)
                    .aria_label(t(cx, keys::template_editor::REORDER))
                    .on_drag(drag, |d, _, _, cx| {
                        cx.new(|_| ItemGhost {
                            label: d.label.clone(),
                        })
                    })
                    .child(sand::icon(Icon::Grip, 12.0, p.ink(3).solid())),
            )
            .child(
                div()
                    .id(SharedString::from(format!("{group}-remove")))
                    .debug_selector({
                        let s = format!("custom-item-remove-{item_id}");
                        move || s.clone()
                    })
                    .size(px(18.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .role(gpui::Role::Button)
                    .aria_label(t(cx, keys::common::DELETE))
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        let op = Op::Remove {
                            path: path.clone(),
                            list: list.clone(),
                            item: remove_item.clone(),
                        };
                        remove_view.update(cx, |v, cx| v.push(op, cx)).ok();
                    })
                    .child(sand::icon(Icon::Close, 12.0, p.ink(3).solid())),
            );
        div()
            .id(id)
            .debug_selector({
                let s = format!("custom-item-{item_id}");
                move || s.clone()
            })
            .group(group)
            .relative()
            .flex()
            .flex_col()
            .min_w_0()
            .child(body)
            .child(tools)
            .drag_over::<ItemDrag>(move |st, _, _, _| st.bg(wash))
            .on_drop(move |d: &ItemDrag, _, cx| {
                if d.list_key != list_key || d.item.is_empty() {
                    return;
                }
                let op = Op::Move {
                    path: drop_path.clone(),
                    list: drop_list.clone(),
                    item: d.item.clone(),
                    to: index,
                };
                drop_view.update(cx, |v, cx| v.push(op, cx)).ok();
            })
            .into_any_element()
    }

    fn after_items(
        &self,
        each: &PEach,
        id: ElementId,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement> {
        if each.path.iter().any(|s| s.item.is_empty()) {
            return None;
        }
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let view = self.view.clone();
        let (path, list) = (each.path.clone(), each.list.clone());
        let selector = format!("custom-add-{}", slot_key(&each.path, &each.list));
        Some(
            div()
                .id(id)
                .debug_selector(move || selector.clone())
                .flex()
                .flex_row()
                .flex_none()
                .items_center()
                .gap(px(4.0))
                .py(px(2.0))
                .cursor_pointer()
                .role(gpui::Role::Button)
                .aria_label(SharedString::from(each.name.clone()))
                .text_color(p.ink(4).solid())
                .hover(|st| st.text_color(p.ink(2).solid()))
                .font_role(Role::Ui)
                .type_px(s.caption, s.line_caption)
                .child(sand::icon(Icon::Plus, 12.0, p.ink(4).solid()))
                .child(each.name.clone())
                .on_click(move |_, _, cx| {
                    let op = Op::Add {
                        path: path.clone(),
                        list: list.clone(),
                    };
                    view.update(cx, |v, cx| v.push(op, cx)).ok();
                })
                .into_any_element(),
        )
    }
}

impl Render for CustomModule {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let id = SharedString::from(format!(
            "custom-{}-{}",
            self.host.entry, self.host.module.id
        ));
        let root = div()
            .id(id.clone())
            .debug_selector(|| "custom-module".into())
            .relative()
            .flex()
            .flex_col()
            .gap_2()
            .min_w_0();
        let Some(loaded) = self.loaded.clone() else {
            return root.into_any_element();
        };
        let Some(module) = loaded.data.value.clone() else {
            // A copy this build cannot read, or none: its name alone.
            let name = loaded
                .data
                .copy
                .as_ref()
                .and_then(|c| c.name.clone())
                .unwrap_or_else(|| loaded.data.name.clone());
            return root
                .child(look::placeholder(
                    SharedString::from(format!("{id}-placeholder")),
                    &name,
                    window,
                    cx,
                ))
                .into_any_element();
        };
        let size = if FilledModule::is(cx, &self.host.entry, &self.host.module.id) {
            LookSize::Full
        } else {
            LookSize::Block
        };
        let names = BookNames {
            book: &self.host.page.book,
            pictures: &loaded.pictures,
        };
        let scope = Scope::read(&loaded.data.values, &names);
        let plan = look::plan::plan(&module, &scope, size, &look::AppWords(cx));
        let values = plan.root.values();
        self.sync_inputs(&values, window, cx);
        if let Some(key) = self.focus_next.take()
            && let Some(input) = self.inputs.get(&key)
        {
            let handle = input.area.focus_handle(cx);
            cx.defer_in(window, move |_, window, cx| window.focus(&handle, cx));
        }
        let editor = Editor {
            view: cx.weak_entity(),
            inputs: self
                .inputs
                .iter()
                .filter(|(key, _)| {
                    // A number shown as dots is a field only while typed into.
                    values.iter().any(|v| {
                        slot_key(&v.path, &v.block) == **key
                            && (v.show != Show::Dots || self.dots.as_deref() == Some(key.as_str()))
                    })
                })
                .map(|(k, i)| (k.clone(), i.area.clone()))
                .collect(),
            lists: format!("{}/{}/", self.host.entry, self.host.module.id),
            drawn: Default::default(),
        };
        let body = look::paint::paint(id.clone(), &plan, Blanks::Dash, Some(&editor), window, cx);
        let error = self.error.map(|key| {
            let theme = Theme::of(window, cx);
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .font_role(Role::Ui)
                .text_color(theme.palette.ink(3).solid())
                .child(t(cx, key))
                .when(key == keys::k4_pages::SAVE_FAILED, |el| {
                    el.child(
                        Button::new(
                            SharedString::from(format!("{id}-retry")),
                            t(cx, keys::markdown_share::RETRY),
                        )
                        .small()
                        .on_click(cx.listener(|v, _, _, cx| v.retry(cx))),
                    )
                })
        });
        let menu = self
            .menu
            .as_ref()
            .map(|m| (m.slot.clone(), m.at, m.current.clone(), m.options.clone()))
            .map(|(slot, at, current, options)| {
                let m = OpenMenu {
                    slot,
                    at,
                    current,
                    options,
                };
                self.render_menu(&m, window, cx)
            });
        root.child(body)
            .children(error)
            .children(menu)
            .into_any_element()
    }
}

impl Drafts for CustomModule {
    fn drain(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Drain {
        let keys: Vec<String> = self.inputs.keys().cloned().collect();
        for key in keys {
            self.flush(&key, cx);
        }
        if self.writing || !self.queue.is_empty() {
            return Drain::Pending;
        }
        if let Some(error) = self.error {
            return Drain::Failed(t(cx, error).to_string());
        }
        Drain::Ready
    }
}
