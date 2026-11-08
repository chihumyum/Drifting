//! The book's relation types: the 0.1 client's `RelationKindMenu` type
//! management and `RelationTypeEditor`, as a settings-wide menu surface.

use dr_i18n::keys;
use dr_i18n::keys::edge_kind_manager as ekm;
use dr_i18n::keys::relation_types as rt;
use dr_shell::strings::{t, tf};
use dr_ui::Theme;
use dr_ui::components::{Button, Chip, Dialog, Menu, MenuWidth, Segmented};
use dr_ui::fonts::{Role, weight};
use dr_ui::glass::{self, Kind as GlassKind, Mode, Spec, Tone};
use dr_ui::input::{FieldEvent, TextField};
use dr_ui::sand::{self, Icon};
use dr_ui::style::DrStyled as _;
use dr_workspace::dto::{RelationInfo, RelationTypeInfo};
use dr_workspace::{Workspace as Library, WsEvent};
use gpui::{
    AnyElement, AnyWindowHandle, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle,
    Focusable, InteractiveElement as _, IntoElement, ParentElement as _, Render, ScrollHandle,
    SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Task, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::data;
use crate::look;
use crate::model::{self, Draft, PALETTE, Paint, SOURCE_KINDS, TARGET_KINDS, Words};

/// What the manager tells the section that opened it.
#[derive(Clone, Debug)]
pub enum TypeEvent {
    /// A new type was saved.
    Created(String),
    /// Esc.
    Close,
}

struct Editing {
    /// The type being changed; `None` for a new one.
    id: Option<String>,
    draft: Draft,
    name: Entity<TextField>,
    source_role: Entity<TextField>,
    target_role: Entity<TextField>,
    description: Entity<TextField>,
    error: Option<String>,
    saving: bool,
    _subs: Vec<Subscription>,
}

/// The book's relation types: each with its colour, name, roles and how
/// many relations it has; new, changed and deleted here.
pub struct TypeManager {
    lib: Library,
    book: String,
    types: Vec<RelationTypeInfo>,
    relations: Vec<RelationInfo>,
    loaded: bool,
    reading: Option<Task<()>>,
    stale: bool,
    writing: usize,
    editing: Option<Editing>,
    /// The type whose colour row is open.
    coloring: Option<String>,
    /// The type list's scroll, and the row to bring into view on the next
    /// frame (a type's id; empty for the new type's editor at the top): a
    /// colour row or an editor opened at the end of a long list is not left
    /// out of sight.
    list: ScrollHandle,
    reveal: Option<String>,
    focus: FocusHandle,
    window: AnyWindowHandle,
    _events: Option<dr_workspace::events::Subscription>,
    _receiver: Option<Task<()>>,
}

impl EventEmitter<TypeEvent> for TypeManager {}

impl Focusable for TypeManager {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// The word for an entity kind the editor allows.
fn kind_label(kind: &str, cx: &App) -> SharedString {
    t(
        cx,
        match kind {
            "node" => rt::entity_kinds::NODE,
            "element" => rt::entity_kinds::ELEMENT,
            "patch" => rt::entity_kinds::PATCH,
            "category" => rt::entity_kinds::CATEGORY,
            "storyline" => rt::entity_kinds::STORYLINE,
            "comment" => rt::entity_kinds::COMMENT,
            _ => rt::entity_kinds::LIBRARY_ITEM,
        },
    )
}

impl TypeManager {
    pub fn new(
        lib: Library,
        book: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> TypeManager {
        let mut m = TypeManager {
            lib,
            book,
            types: Vec::new(),
            relations: Vec::new(),
            loaded: false,
            reading: None,
            stale: false,
            writing: 0,
            editing: None,
            coloring: None,
            list: ScrollHandle::new(),
            reveal: None,
            focus: cx.focus_handle(),
            window: window.window_handle(),
            _events: None,
            _receiver: None,
        };
        m.listen(cx);
        m.reload(cx);
        m
    }

    fn listen(&mut self, cx: &mut Context<Self>) {
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<()>();
        let book = self.book.clone();
        self._events = Some(self.lib.subscribe(move |event| {
            if let WsEvent::Book(b) = event
                && b.book.as_str() == book
                && b.changes.iter().any(|c| {
                    matches!(
                        c.collection,
                        dr_doc::book::Collection::Relations
                            | dr_doc::book::Collection::RelationTypes
                    )
                })
            {
                let _ = tx.unbounded_send(());
            }
        }));
        self._receiver = Some(cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                while rx.try_recv().is_ok() {}
                if this.update(cx, |m, cx| m.reload(cx)).is_err() {
                    break;
                }
            }
        }));
    }

    /// Reads the types and every relation of the book (for the counts).
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        if self.reading.is_some() {
            self.stale = true;
            return;
        }
        self.stale = false;
        let (lib, book) = (self.lib.clone(), self.book.clone());
        let read = cx.background_spawn(async move { data::load(&lib, &book, None) });
        self.reading = Some(cx.spawn(async move |this, cx| {
            let lists = read.await;
            this.update(cx, |m, cx| {
                m.reading = None;
                match lists {
                    Ok((types, relations)) => {
                        m.types = types;
                        m.relations = relations;
                        m.loaded = true;
                    }
                    Err(error) => log::warn!("the relation types could not be read: {error}"),
                }
                if m.stale {
                    m.reload(cx);
                }
                cx.notify();
            })
            .ok();
        }));
    }

    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
    }

    // ── for the section and tests ───────────────────────────────────────

    pub fn types(&self) -> &[RelationTypeInfo] {
        &self.types
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded
    }

    pub fn is_settled(&self) -> bool {
        self.reading.is_none() && self.writing == 0 && !self.stale
    }

    /// How many relations type `id` has in the book.
    pub fn usage(&self, id: &str) -> usize {
        model::usage(&self.relations, id)
    }

    /// The editor's type (`Some(None)`: a new one), while it is open.
    pub fn editing(&self) -> Option<Option<&str>> {
        self.editing.as_ref().map(|e| e.id.as_deref())
    }

    pub fn draft(&self) -> Option<&Draft> {
        self.editing.as_ref().map(|e| &e.draft)
    }

    pub fn error(&self) -> Option<&str> {
        self.editing.as_ref().and_then(|e| e.error.as_deref())
    }

    /// The editor's fields: name, source role, target role, description.
    pub fn fields(&self) -> Option<[Entity<TextField>; 4]> {
        self.editing.as_ref().map(|e| {
            [
                e.name.clone(),
                e.source_role.clone(),
                e.target_role.clone(),
                e.description.clone(),
            ]
        })
    }

    pub fn coloring(&self) -> Option<&str> {
        self.coloring.as_deref()
    }

    // ── the author's steps ──────────────────────────────────────────────

    fn field(
        &self,
        id: &'static str,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TextField> {
        let text = text.to_owned();
        cx.new(|cx| {
            let mut f = TextField::new(id, window, cx);
            f.set_text(text, cx);
            f
        })
    }

    fn open_editor(
        &mut self,
        id: Option<String>,
        draft: Draft,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let name = self.field("relation-type-name", &draft.name, window, cx);
        let source_role = self.field("relation-type-source-role", &draft.source_role, window, cx);
        let target_role = self.field("relation-type-target-role", &draft.target_role, window, cx);
        let description = self.field("relation-type-description", &draft.description, window, cx);
        let follow = |which: u8| {
            move |m: &mut TypeManager,
                  _: Entity<TextField>,
                  e: &FieldEvent,
                  cx: &mut Context<TypeManager>| match e {
                FieldEvent::Changed(text) => {
                    if let Some(ed) = &mut m.editing {
                        let slot = match which {
                            0 => &mut ed.draft.name,
                            1 => &mut ed.draft.source_role,
                            2 => &mut ed.draft.target_role,
                            _ => &mut ed.draft.description,
                        };
                        *slot = text.clone();
                    }
                }
                FieldEvent::Submitted(_) => m.save(cx),
                FieldEvent::Cancelled => m.cancel(cx),
                FieldEvent::Blurred => {}
            }
        };
        let subs = vec![
            cx.subscribe(&name, follow(0)),
            cx.subscribe(&source_role, follow(1)),
            cx.subscribe(&target_role, follow(2)),
            cx.subscribe(&description, follow(3)),
        ];
        let handle = name.focus_handle(cx);
        window.focus(&handle, cx);
        self.coloring = None;
        self.editing = Some(Editing {
            id,
            draft,
            name,
            source_role,
            target_role,
            description,
            error: None,
            saving: false,
            _subs: subs,
        });
        cx.notify();
    }

    /// 「＋ 新建」: a new type's editor (with `seed`, the kinds of the pair
    /// being related).
    pub fn start_new(
        &mut self,
        seed: Option<(Vec<String>, Vec<String>)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let source = t(cx, rt::DEFAULT_SOURCE_ROLE).to_string();
        let target = t(cx, rt::DEFAULT_TARGET_ROLE).to_string();
        let mut draft = Draft::new(&source, &target, None, None);
        if let Some((sources, targets)) = seed {
            draft.source_kinds = sources;
            draft.target_kinds = targets;
        }
        self.open_editor(None, draft, window, cx);
        self.reveal = Some(String::new());
    }

    /// A type's name: its editor (not the built-in type's).
    pub fn start_edit(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ty) = self.types.iter().find(|t| t.id == id && !t.locked).cloned() else {
            return;
        };
        self.open_editor(Some(ty.id.clone()), Draft::of(&ty), window, cx);
        self.reveal = Some(ty.id);
    }

    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        self.close_editor(cx);
        cx.notify();
    }

    /// The editor goes; the keyboard stays with the types (its field going
    /// away would otherwise hand it to the page, which scrolls to its caret).
    fn close_editor(&mut self, cx: &mut Context<Self>) {
        self.editing = None;
        let (handle, focus) = (self.window, self.focus.clone());
        cx.defer(move |cx| {
            handle
                .update(cx, |_, window, cx| window.focus(&focus, cx))
                .ok();
        });
    }

    /// 有向 / 对称 (a new type only: F3 keeps a type's direction).
    pub fn set_symmetric(&mut self, symmetric: bool, cx: &mut Context<Self>) {
        if let Some(e) = &mut self.editing
            && e.id.is_none()
        {
            e.draft.set_symmetric(symmetric);
        }
        cx.notify();
    }

    /// A kind chip (a new type only: F3 keeps a type's kinds).
    pub fn toggle_kind(&mut self, source: bool, kind: &str, cx: &mut Context<Self>) {
        if let Some(e) = &mut self.editing
            && e.id.is_none()
        {
            if source {
                e.draft.toggle_source(kind);
            } else {
                e.draft.toggle_target(kind);
            }
        }
        cx.notify();
    }

    /// 「保存」: the editor's type, made or changed; F3's refusal (an empty
    /// name, a name another type has, no kinds) shows under it.
    pub fn save(&mut self, cx: &mut Context<Self>) {
        let Some(e) = &mut self.editing else {
            return;
        };
        if e.saving {
            return;
        }
        e.saving = true;
        e.error = None;
        let draft = e.draft.clone();
        let old =
            e.id.as_ref()
                .and_then(|id| self.types.iter().find(|t| &t.id == id))
                .cloned();
        let (lib, book) = (self.lib.clone(), self.book.clone());
        self.writing += 1;
        let task = cx.background_spawn(async move {
            match &old {
                Some(old) => data::update_type(&lib, &book, old, &draft).map(|_| None),
                None => data::create_type(&lib, &book, &draft).map(Some),
            }
        });
        cx.spawn(async move |this, cx| {
            let done = task.await;
            this.update(cx, |m, cx| {
                m.writing -= 1;
                match done {
                    Ok(made) => {
                        m.close_editor(cx);
                        if let Some(id) = made {
                            // The new type is the last row: show it.
                            m.reveal = Some(id.clone());
                            cx.emit(TypeEvent::Created(id));
                        }
                        m.reload(cx);
                    }
                    Err(error) => {
                        if let Some(e) = &mut m.editing {
                            e.saving = false;
                            e.error = Some(error.to_string());
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn write(
        &mut self,
        what: &'static str,
        f: impl FnOnce(&Library, &str) -> Result<(), dr_workspace::WsError> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        let (lib, book) = (self.lib.clone(), self.book.clone());
        self.writing += 1;
        let task = cx.background_spawn(async move { f(&lib, &book) });
        cx.spawn(async move |this, cx| {
            let done = task.await;
            this.update(cx, |m, cx| {
                m.writing -= 1;
                if let Err(error) = done {
                    log::warn!("{what} failed: {error}");
                }
                m.reload(cx);
            })
            .ok();
        })
        .detach();
    }

    /// A type's dash: its colour row opens (not the built-in type's: F3
    /// keeps it as it is).
    pub fn toggle_colors(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.types.iter().any(|t| t.id == id && t.locked) {
            return;
        }
        self.coloring = if self.coloring.as_deref() == Some(id) {
            None
        } else {
            self.reveal = Some(id.to_owned());
            Some(id.to_owned())
        };
        cx.notify();
    }

    /// A colour from the row (`None`: 恢复默认色).
    pub fn set_color(&mut self, id: &str, paint: Option<Paint>, cx: &mut Context<Self>) {
        self.coloring = None;
        let id = id.to_owned();
        let stored = paint.map(Paint::stored);
        if let Some(t) = self.types.iter_mut().find(|t| t.id == id) {
            t.color = stored.clone();
        }
        self.write(
            "colouring a relation type",
            move |lib, book| data::set_color(lib, book, &id, stored),
            cx,
        );
        cx.notify();
    }

    /// The trash: the question first (only a type no relation uses, as 0.1).
    pub fn ask_delete(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ty) = self.types.iter().find(|t| t.id == id && !t.locked).cloned() else {
            return;
        };
        if self.usage(id) > 0 {
            return;
        }
        let handle = self.window;
        let (lib, book) = (self.lib.clone(), self.book.clone());
        let name = ty.name.clone();
        let id = ty.id.clone();
        let _ = window;
        // The question is the window's dialog; the types close under it (0.1
        // kept its popover open, but then two buttons would read 删除关系类型).
        cx.emit(TypeEvent::Close);
        cx.defer(move |cx| {
            let dialog = cx.new(|cx| DeleteTypeDialog::new(lib, book, id, name, cx));
            dr_shell::dialogs::show_in(handle, cx, dialog.into());
        });
    }

    /// Deletes type `id` (asked already).
    pub fn delete(&mut self, id: &str, cx: &mut Context<Self>) {
        let id = id.to_owned();
        self.types.retain(|t| t.id != id);
        self.write(
            "deleting a relation type",
            move |lib, book| data::delete_type(lib, book, &id),
            cx,
        );
        cx.notify();
    }

    // ── drawing ─────────────────────────────────────────────────────────

    fn words(&self, cx: &App) -> Words {
        Words {
            name: t(cx, rt::generic_association::NAME).to_string(),
            source_role: t(cx, rt::generic_association::SOURCE_ROLE).to_string(),
            target_role: t(cx, rt::generic_association::TARGET_ROLE).to_string(),
        }
    }

    fn row(
        &self,
        ty: &RelationTypeInfo,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let w = model::words(ty, &self.words(cx));
        let mut summary = model::summary(ty, &w, |role| {
            tf(cx, rt::SYMMETRIC_SUMMARY, &[("role", &role)]).to_string()
        });
        if ty.locked {
            summary = format!("{summary} · {}", t(cx, rt::BUILT_IN));
        }
        let color = look::rgb(model::paint_of(ty), window, cx);
        let count = self.usage(&ty.id);
        let id = ty.id.clone();
        let key = |part: &str| SharedString::from(format!("relation-type-{part}-{id}"));
        let (c_id, e_id, d_id) = (id.clone(), id.clone(), id.clone());
        let locked = ty.locked;
        let deletable = !locked && count == 0;
        let row = div()
            .id(key("row"))
            .role(gpui::Role::Group)
            .aria_label(w.name.clone())
            .mx(px(6.0))
            .min_h(px(40.0))
            .px(px(8.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .child(
                div()
                    .id(key("dash"))
                    .flex_none()
                    .size(px(24.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .when(!locked, |el| {
                        el.cursor_pointer()
                            .role(gpui::Role::Button)
                            .aria_label(tf(cx, ekm::CHANGE_COLOR_LABEL, &[("label", &w.name)]))
                            .on_click(cx.listener(move |m, _: &gpui::ClickEvent, _, cx| {
                                m.toggle_colors(&c_id, cx)
                            }))
                    })
                    .child(look::dash(key("dash-mark"), color)),
            )
            .child(
                div()
                    .id(key("name"))
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .when(!locked, |el| {
                        el.cursor_pointer()
                            .role(gpui::Role::Button)
                            .aria_label(w.name.clone())
                            .on_click(cx.listener(move |m, _: &gpui::ClickEvent, window, cx| {
                                m.start_edit(&e_id, window, cx)
                            }))
                    })
                    .child(
                        div()
                            .truncate()
                            .font_role(Role::Ui)
                            .type_px(13.0, 18.0)
                            .weight(weight::MEDIUM)
                            .text_color(p.ink(1).solid())
                            .child(w.name.clone()),
                    )
                    .child(
                        div()
                            .truncate()
                            .font_role(Role::Ui)
                            .type_px(11.0, 15.0)
                            .text_color(p.ink(4).solid())
                            .child(summary),
                    ),
            )
            .child(
                div()
                    .flex_none()
                    .font_role(Role::Index)
                    .type_px(10.0, 14.0)
                    .text_color(p.ink(4).solid())
                    .child(count.to_string()),
            )
            .child(
                div()
                    .id(key("delete"))
                    .flex_none()
                    .size(px(24.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .role(gpui::Role::Button)
                    .aria_label(t(cx, rt::DELETE))
                    .when(deletable, |el| {
                        el.cursor_pointer().on_click(cx.listener(
                            move |m, _: &gpui::ClickEvent, window, cx| {
                                m.ask_delete(&d_id, window, cx)
                            },
                        ))
                    })
                    .child(sand::icon(
                        Icon::Trash,
                        13.0,
                        if deletable { p.ink(3) } else { p.ink(5) }.solid(),
                    )),
            );
        let mut col = div().flex().flex_col().child(row);
        if self.coloring.as_deref() == Some(ty.id.as_str()) {
            col = col.child(self.colors(ty, window, cx));
        }
        col.into_any_element()
    }

    fn colors(
        &self,
        ty: &RelationTypeInfo,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let current = model::paint_of(ty);
        let mut row = div()
            .mx(px(14.0))
            .mb(px(6.0))
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(6.0));
        for (i, paint) in PALETTE.into_iter().enumerate() {
            let color = look::rgb(paint, window, cx);
            let id = ty.id.clone();
            row = row.child(
                glass::glass_box(
                    SharedString::from(format!("relation-type-color-{i}-{}", ty.id)),
                    GlassKind::Rest,
                    Mode::default(),
                    paint == current,
                    Spec::new(Tone::Color(color), 12.0),
                    window,
                    cx,
                )
                .size(px(24.0))
                .rounded(px(12.0))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .role(gpui::Role::Button)
                .aria_label(format!("{} {}", t(cx, ekm::CHANGE_COLOR), i + 1))
                .on_click(cx.listener(move |m, _: &gpui::ClickEvent, _, cx| {
                    m.set_color(&id, Some(paint), cx)
                }))
                .child(
                    sand::KindMark::new(
                        SharedString::from(format!("relation-type-seal-{i}-{}", ty.id)),
                        sand::Kind::Chapter(i as u8 % 6),
                    )
                    .color(color),
                ),
            );
        }
        let id = ty.id.clone();
        row.child(
            Button::new(
                SharedString::from(format!("relation-type-reset-{}", ty.id)),
                t(cx, ekm::RESET_COLOR),
            )
            .text()
            .small()
            .on_click(cx.listener(move |m, _, _, cx| m.set_color(&id, None, cx))),
        )
        .into_any_element()
    }

    fn labelled(
        &self,
        label: SharedString,
        field: AnyElement,
        window: &Window,
        cx: &App,
    ) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .min_w_0()
            .flex_1()
            .child(
                div()
                    .font_role(Role::Ui)
                    .type_px(11.0, 14.0)
                    .weight(weight::MEDIUM)
                    .text_color(p.ink(3).solid())
                    .child(label),
            )
            .child(field)
            .into_any_element()
    }

    fn editor(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let e = self.editing.as_ref()?;
        let p = Theme::of(window, cx).palette;
        let existing = e.id.is_some();
        let d = &e.draft;
        let this = cx.entity().downgrade();
        let direction = Segmented::new(
            "relation-type-direction",
            [t(cx, rt::DIRECTED), t(cx, rt::SYMMETRIC)],
            usize::from(d.symmetric),
        )
        .text_size(12.0)
        .disabled(existing)
        .on_change(move |i, _, cx| {
            this.update(cx, |m, cx| m.set_symmetric(i == 1, cx)).ok();
        });
        let role_label = if d.symmetric {
            t(cx, rt::ENDPOINT_ROLE)
        } else {
            t(cx, rt::SOURCE_ROLE)
        };
        let mut grid = div().flex().flex_col().gap(px(10.0)).child(
            div()
                .flex()
                .flex_row()
                .gap(px(10.0))
                .child(self.labelled(
                    t(cx, rt::NAME),
                    e.name.clone().into_any_element(),
                    window,
                    cx,
                ))
                .child(self.labelled(
                    t(cx, rt::DIRECTION),
                    div().flex().child(direction).into_any_element(),
                    window,
                    cx,
                )),
        );
        let mut roles = div().flex().flex_row().gap(px(10.0)).child(self.labelled(
            role_label,
            e.source_role.clone().into_any_element(),
            window,
            cx,
        ));
        if !d.symmetric {
            roles = roles.child(self.labelled(
                t(cx, rt::TARGET_ROLE),
                e.target_role.clone().into_any_element(),
                window,
                cx,
            ));
        }
        grid = grid.child(roles).child(self.labelled(
            t(cx, rt::DESCRIPTION),
            e.description.clone().into_any_element(),
            window,
            cx,
        ));
        let chips = |source: bool, kinds: &[&str], on: &[String], cx: &mut Context<Self>| {
            let mut row = div().flex().flex_row().flex_wrap().gap(px(4.0));
            for kind in kinds {
                let k = kind.to_string();
                let this = cx.entity().downgrade();
                let structural = TARGET_KINDS.contains(kind);
                row = row.child(
                    Chip::new(
                        SharedString::from(format!(
                            "relation-type-{}-{kind}",
                            if source { "source" } else { "target" }
                        )),
                        kind_label(kind, cx),
                        on.iter().any(|x| x == kind),
                    )
                    .disabled(existing || (d.symmetric && source && !structural))
                    .on_change(move |_, _, cx| {
                        this.update(cx, |m, cx| m.toggle_kind(source, &k, cx)).ok();
                    }),
                );
            }
            row.into_any_element()
        };
        let sources = chips(true, &SOURCE_KINDS, &d.source_kinds, cx);
        grid = grid.child(self.labelled(
            if d.symmetric {
                t(cx, rt::ALLOWED_ENTITIES)
            } else {
                t(cx, rt::ALLOWED_SOURCES)
            },
            sources,
            window,
            cx,
        ));
        if !d.symmetric {
            let targets = chips(false, &TARGET_KINDS, &d.target_kinds, cx);
            grid = grid.child(self.labelled(t(cx, rt::ALLOWED_TARGETS), targets, window, cx));
        }
        if let Some(error) = &e.error {
            grid = grid.child(
                div()
                    .font_role(Role::Ui)
                    .type_px(12.0, 16.0)
                    .text_color(p.danger.solid())
                    .child(error.clone()),
            );
        }
        let saving = e.saving;
        grid = grid.child(
            div()
                .flex()
                .flex_row()
                .justify_end()
                .gap(px(8.0))
                .child(
                    Button::new("relation-type-cancel", t(cx, rt::CANCEL))
                        .text()
                        .small()
                        .on_click(cx.listener(|m, _, _, cx| m.cancel(cx))),
                )
                .child(
                    Button::new("relation-type-save", t(cx, rt::SAVE))
                        .primary()
                        .small()
                        .disabled(saving)
                        .on_click(cx.listener(|m, _, _, cx| m.save(cx))),
                ),
        );
        Some(
            div()
                .mx(px(14.0))
                .my(px(6.0))
                .child(grid)
                .into_any_element(),
        )
    }
}

impl Render for TypeManager {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let total: usize = self.relations.len();
        let head = div()
            .px(px(14.0))
            .pt(px(4.0))
            .pb(px(8.0))
            .flex()
            .flex_col()
            .child(
                div()
                    .font_role(Role::Ui)
                    .type_px(14.0, 20.0)
                    .weight(weight::MEDIUM)
                    .text_color(p.ink(1).solid())
                    .child(t(cx, ekm::TITLE)),
            )
            .child(
                div()
                    .font_role(Role::Ui)
                    .type_px(11.5, 16.0)
                    .text_color(p.ink(4).solid())
                    .child(tf(
                        cx,
                        ekm::SUMMARY,
                        &[("kinds", &self.types.len()), ("relations", &total)],
                    )),
            );
        let label = div()
            .px(px(14.0))
            .pt(px(4.0))
            .flex()
            .flex_row()
            .items_center()
            .child(
                div()
                    .flex_1()
                    .font_role(Role::Ui)
                    .type_px(12.0, 16.0)
                    .weight(weight::MEDIUM)
                    .text_color(p.ink(3).solid())
                    .child(t(cx, rt::TITLE)),
            )
            .child(
                Button::new("relation-type-new", t(cx, rt::CREATE))
                    .text()
                    .small()
                    .icon(Icon::Plus)
                    .on_click(cx.listener(|m, _, window, cx| m.start_new(None, window, cx))),
            );
        let editing_new = matches!(self.editing.as_ref(), Some(e) if e.id.is_none());
        let editing_id = self.editing.as_ref().and_then(|e| e.id.clone());
        if let Some(key) = self.reveal.clone() {
            let at = if key.is_empty() {
                Some(0)
            } else {
                self.types
                    .iter()
                    .position(|t| t.id == key)
                    .map(|i| i + usize::from(editing_new))
            };
            match at {
                Some(ix) => {
                    self.list.scroll_to_item(ix);
                    self.reveal = None;
                }
                // A type just made shows once the list is read again.
                None if self.reading.is_none() && !self.stale => self.reveal = None,
                None => {}
            }
        }
        let mut list = div()
            .id("relation-types-list")
            .flex()
            .flex_col()
            .max_h(px(380.0))
            .overflow_y_scroll()
            .track_scroll(&self.list);
        if editing_new && let Some(editor) = self.editor(window, cx) {
            list = list.child(editor);
        }
        let types = self.types.clone();
        for ty in &types {
            if editing_id.as_deref() == Some(ty.id.as_str()) {
                if let Some(editor) = self.editor(window, cx) {
                    list = list.child(editor);
                }
            } else {
                list = list.child(self.row(ty, window, cx));
            }
        }
        div()
            .track_focus(&self.focus)
            .key_context("RelationTypes")
            .on_action(cx.listener(|m, _: &dr_shell::actions::Dismiss, _, cx| {
                if m.editing.is_some() {
                    m.cancel(cx);
                } else {
                    cx.emit(TypeEvent::Close);
                }
            }))
            .child(
                Menu::new("relation-types")
                    .width(MenuWidth::Settings)
                    .child(head)
                    .child(dr_ui::components::menu::separator(p))
                    .child(label)
                    .child(list),
            )
    }
}

/// 「删除关系类型「{{name}}」？」: it deletes the type itself (the types it
/// was asked from have closed).
pub struct DeleteTypeDialog {
    lib: Library,
    book: String,
    id: String,
    name: String,
    focus: FocusHandle,
}

impl DeleteTypeDialog {
    pub fn new(
        lib: Library,
        book: String,
        id: String,
        name: String,
        cx: &mut Context<Self>,
    ) -> DeleteTypeDialog {
        DeleteTypeDialog {
            lib,
            book,
            id,
            name,
            focus: cx.focus_handle(),
        }
    }

    /// The type it asks about.
    pub fn type_id(&self) -> &str {
        &self.id
    }

    /// 删除关系类型: the type goes, off the main thread (F3's event reads
    /// the lists again).
    pub fn confirm(&self, cx: &mut App) {
        let (lib, book, id) = (self.lib.clone(), self.book.clone(), self.id.clone());
        cx.background_spawn(async move {
            if let Err(error) = data::delete_type(&lib, &book, &id) {
                log::warn!("deleting a relation type failed: {error}");
            }
        })
        .detach();
    }
}

impl Focusable for DeleteTypeDialog {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for DeleteTypeDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity().entity_id();
        let close = move |_: &mut Window, cx: &mut App| {
            cx.defer(move |cx| dr_shell::dialogs::hide(cx, me));
        };
        let me_view = cx.entity().downgrade();
        let _ = window;
        div()
            .track_focus(&self.focus)
            .key_context("RelationTypeDeleteDialog")
            .on_action(move |_: &dr_shell::actions::Dismiss, window, cx| close(window, cx))
            .child(
                Dialog::new(
                    "relation-type-delete-dialog",
                    tf(cx, rt::CONFIRM_DELETE, &[("name", &self.name)]),
                )
                .on_close(close)
                .action(
                    Button::new("relation-type-delete-cancel", t(cx, keys::common::CANCEL))
                        .on_click(move |_, window, cx| close(window, cx)),
                )
                .action(
                    Button::new("relation-type-delete-confirm", t(cx, rt::DELETE))
                        .danger()
                        .on_click(move |_, window, cx| {
                            me_view.update(cx, |d, cx| d.confirm(cx)).ok();
                            close(window, cx);
                        }),
                ),
            )
    }
}
