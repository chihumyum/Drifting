//! 「字段」 under an element's text: the 0.1 client's `KvEditor`.
//!
//! - One slip of resting glass per field (no fill, no line between the key
//!   and the value); while the caret is in it, the whole slip is the still
//!   selected glass. The key is index type, the value the text's face; the
//!   value wraps. A × at the row's end shows under the pointer or while the
//!   caret is in the row.
//! - Leaving the key or the value saves that field (F3 `element.update`
//!   `put_fields`); a row whose key and value are both blank goes (a stored
//!   one is removed). × removes at once. Fields keep their order.
//! - 「新增字段」 at the section head's right opens a blank row at the end and
//!   puts the caret in its key (only the caret, when the last row is already
//!   blank).
//! - No key is checked against the others (the 0.1 editor did not either).

use std::rc::Rc;

use dr_i18n::keys;
use dr_shell::book::Book;
use dr_shell::{Services, Workspace, t};
use dr_ui::{
    Theme,
    fonts::Role,
    glass::{self, Kind as GlassKind, Mode, Spec, Tone},
    input::{
        area::TextArea,
        field::{FieldEvent, TextField},
    },
    sand::{self, Icon},
    style::DrStyled,
};
use dr_workspace::{Workspace as Library, commands::element::FieldIn, dto::FieldInfo};
use gpui::{
    AppContext as _, Context, ElementId, Entity, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, WeakEntity, Window, div, prelude::FluentBuilder as _, px,
};

use crate::data;
use crate::page;

struct Row {
    /// Made `n`-th: its element ids carry it.
    n: usize,
    /// The stored field's id; `None` until a new row is stored and comes back.
    id: Option<String>,
    key: Entity<TextField>,
    value: Entity<TextArea>,
    /// What is stored for this row (or was last sent).
    stored: (String, String),
    /// Sent as a new field, not back yet: no further writes until it is.
    pending: bool,
    _subs: [Subscription; 2],
}

/// Whose fields: an element's or a storyline's (the same `KvEditor` in the
/// 0.1 client).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Owner {
    Element(String),
    Storyline(String),
}

/// An element's or a storyline's fields.
pub struct Fields {
    ws: WeakEntity<Workspace>,
    lib: Option<Library>,
    pub owner: Owner,
    /// Space under the section (it ends the page); off when more sections
    /// follow it.
    last: bool,
    book: Rc<Book>,
    rows: Vec<Row>,
    /// Makes each new row's element ids unique.
    made: usize,
    _ws: Option<Subscription>,
}

impl Fields {
    pub fn new(
        owner: Owner,
        last: bool,
        ws: WeakEntity<Workspace>,
        cx: &mut Context<Self>,
    ) -> Fields {
        let lib = cx.try_global::<Services>().and_then(|s| s.library.clone());
        cx.spawn(async move |this, cx| this.update(cx, |f, cx| f.follow(cx)).ok())
            .detach();
        Fields {
            ws,
            lib,
            owner,
            last,
            book: Rc::default(),
            rows: Vec::new(),
            made: 0,
            _ws: None,
        }
    }

    fn follow(&mut self, cx: &mut Context<Self>) {
        let Some(ws) = self.ws.upgrade() else {
            return;
        };
        self.book = ws.read(cx).book.clone();
        self._ws = Some(cx.observe(&ws, |f, ws, cx| {
            let book = ws.read(cx).book.clone();
            if !Rc::ptr_eq(&book, &f.book) {
                f.book = book;
                cx.notify();
            }
        }));
        cx.notify();
    }

    /// The rows' key and value fields, in order (tests).
    pub fn rows(&self) -> Vec<(Option<String>, Entity<TextField>, Entity<TextArea>)> {
        self.rows
            .iter()
            .map(|r| (r.id.clone(), r.key.clone(), r.value.clone()))
            .collect()
    }

    fn stored(&self) -> Vec<FieldInfo> {
        match &self.owner {
            Owner::Element(id) => data::element(&self.book, id).map(|e| e.fields.clone()),
            Owner::Storyline(id) => data::storyline(&self.book, id).map(|l| l.fields.clone()),
        }
        .unwrap_or_default()
    }

    fn row_focused(row: &Row, window: &Window, cx: &gpui::App) -> bool {
        row.key.focus_handle(cx).is_focused(window) || row.value.focus_handle(cx).is_focused(window)
    }

    fn make_row(
        &mut self,
        id: Option<String>,
        key: String,
        value: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Row {
        self.made += 1;
        let n = self.made;
        let key_hint = t(cx, keys::kv_editor::KEY_PLACEHOLDER);
        let value_hint = t(cx, keys::kv_editor::VALUE_PLACEHOLDER);
        let k = key.clone();
        let key_field = cx.new(|cx| {
            TextField::new(ElementId::Name(format!("field-key-{n}").into()), window, cx)
                .bare()
                .placeholder(key_hint)
                .with_text(k)
        });
        let v = value.clone();
        let value_field = cx.new(|cx| {
            TextArea::new(
                ElementId::Name(format!("field-value-{n}").into()),
                window,
                cx,
            )
            .placeholder(value_hint)
            .with_text(v)
        });
        let on_key = cx.subscribe_in(&key_field, window, move |f, _, e, window, cx| {
            if matches!(e, FieldEvent::Blurred) {
                f.commit(n, window, cx);
            }
        });
        let on_value = cx.subscribe_in(&value_field, window, move |f, _, e, window, cx| {
            if matches!(e, FieldEvent::Blurred) {
                f.commit(n, window, cx);
            }
        });
        Row {
            n,
            id,
            key: key_field,
            value: value_field,
            stored: (key, value),
            pending: false,
            _subs: [on_key, on_value],
        }
    }

    /// The row made `n`-th.
    fn row_ix(&self, n: usize) -> Option<usize> {
        self.rows.iter().position(|r| r.n == n)
    }

    /// Saves a row the caret left.
    fn commit(&mut self, n: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ix) = self.row_ix(n) else {
            return;
        };
        let row = &self.rows[ix];
        let now = (row.key.read(cx).text(), row.value.read(cx).text());
        let blank = now.0.trim().is_empty() && now.1.trim().is_empty();
        let still_in = Self::row_focused(row, window, cx);
        match (&row.id, blank) {
            (_, _) if row.pending => {}
            (Some(id), true) => {
                if !still_in {
                    let id = id.clone();
                    self.rows.remove(ix);
                    self.write(Vec::new(), vec![id], cx);
                }
            }
            (None, true) => {
                if !still_in {
                    self.rows.remove(ix);
                }
            }
            (id, false) => {
                if now == row.stored {
                    return;
                }
                let put = FieldIn {
                    id: id.clone(),
                    key: now.0.clone(),
                    value: now.1.clone(),
                    place: None,
                    pos: None,
                };
                let row = &mut self.rows[ix];
                row.pending = row.id.is_none();
                row.stored = now;
                self.write(vec![put], Vec::new(), cx);
            }
        }
        cx.notify();
    }

    /// Removes a row (its ×).
    pub fn remove(&mut self, ix: usize, cx: &mut Context<Self>) {
        if ix >= self.rows.len() {
            return;
        }
        let row = self.rows.remove(ix);
        if let Some(id) = row.id {
            self.write(Vec::new(), vec![id], cx);
        }
        cx.notify();
    }

    /// 「新增字段」: a blank row at the end (or the last one, if blank), the
    /// caret in its key.
    pub fn add_row(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let last_blank = self.rows.last().is_some_and(|r| {
            r.id.is_none()
                && r.key.read(cx).text().trim().is_empty()
                && r.value.read(cx).text().trim().is_empty()
        });
        if !last_blank {
            let row = self.make_row(None, String::new(), String::new(), window, cx);
            self.rows.push(row);
        }
        if let Some(row) = self.rows.last() {
            row.key.focus_handle(cx).focus(window, cx);
        }
        cx.notify();
    }

    fn write(&mut self, put: Vec<FieldIn>, remove: Vec<String>, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let book = self.book.id.clone();
        let owner = self.owner.clone();
        cx.background_executor()
            .spawn(async move {
                let written = match owner {
                    Owner::Element(id) => {
                        let mut edit = data::element_edit(&book, &id);
                        edit.put_fields = put;
                        edit.remove_fields = remove;
                        data::update_element(&lib, edit)
                    }
                    Owner::Storyline(id) => {
                        let mut edit = data::storyline_edit(&book, &id);
                        edit.put_fields = put;
                        edit.remove_fields = remove;
                        data::update_storyline(&lib, edit)
                    }
                };
                if let Err(error) = written {
                    log::warn!("the fields could not be saved: {error}");
                }
            })
            .detach();
    }

    /// Lines the rows up with the stored fields: a stored field's row takes
    /// a new stored value unless the caret is in it; a new row that came
    /// back takes its id; rows of fields removed elsewhere go.
    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let stored = self.stored();
        let mut rows = std::mem::take(&mut self.rows);
        let mut next = Vec::with_capacity(stored.len());
        for field in &stored {
            let pair = (field.key.clone(), field.value.clone());
            let found = rows
                .iter()
                .position(|r| r.id.as_deref() == Some(field.id.as_str()))
                .or_else(|| {
                    rows.iter()
                        .position(|r| r.id.is_none() && r.pending && r.stored == pair)
                });
            match found {
                Some(i) => {
                    let mut row = rows.remove(i);
                    row.id = Some(field.id.clone());
                    row.pending = false;
                    if row.stored != pair && !Self::row_focused(&row, window, cx) {
                        let (k, v) = pair.clone();
                        row.key.update(cx, |f, cx| f.set_text(k, cx));
                        row.value.update(cx, |f, cx| f.set_text(v, cx));
                        row.stored = pair;
                    }
                    next.push(row);
                }
                None => {
                    let row = self.make_row(
                        Some(field.id.clone()),
                        field.key.clone(),
                        field.value.clone(),
                        window,
                        cx,
                    );
                    next.push(row);
                }
            }
        }
        // Rows not stored: new ones stay; stored ones removed elsewhere go,
        // unless the caret is in them.
        for row in rows {
            if row.id.is_none() || Self::row_focused(&row, window, cx) {
                next.push(row);
            }
        }
        self.rows = next;
    }
}

impl Render for Fields {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync(window, cx);
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let look = page::look(cx);
        let entity = cx.entity();
        let add = {
            let entity = entity.clone();
            page::text_action(
                "fields-add",
                t(cx, keys::kv_editor::ADD_FIELD),
                move |_, window, cx| entity.update(cx, |f, cx| f.add_row(window, cx)),
                window,
                cx,
            )
        };
        let head = page::section(
            t(
                cx,
                match self.owner {
                    Owner::Element(_) => keys::element_editor::sections::FACTS,
                    Owner::Storyline(_) => keys::storyline_editor::sections::FACTS,
                },
            ),
            Some(add),
            false,
            window,
            cx,
        );
        let remove_label = t(cx, keys::kv_editor::REMOVE_ROW);
        let mut list = div().flex().flex_col().gap(px(6.0));
        if self.rows.is_empty() {
            list = list.child(page::empty_line(
                t(
                    cx,
                    match self.owner {
                        Owner::Element(_) => keys::element_editor::empty::NO_FACTS,
                        Owner::Storyline(_) => keys::storyline_editor::empty::NO_FACTS,
                    },
                ),
                look,
                window,
                cx,
            ));
        }
        for (ix, row) in self.rows.iter().enumerate() {
            let focused = Self::row_focused(row, window, cx);
            let group: SharedString = format!("field-row-{}", row.n).into();
            let remove = {
                let entity = entity.clone();
                move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut gpui::App| {
                    entity.update(cx, |f, cx| f.remove(ix, cx))
                }
            };
            let x = div()
                .id(ElementId::Name(format!("{group}-remove").into()))
                .size(px(18.0))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .role(gpui::Role::Button)
                .aria_label(remove_label.clone())
                .map(|el| {
                    if focused {
                        el
                    } else {
                        el.invisible().group_hover(group.clone(), |st| st.visible())
                    }
                })
                .on_click(remove)
                .child(sand::icon(Icon::Close, 10.0, p.ink(4).solid()));
            list = list.child(
                glass::glass_box(
                    ElementId::Name(group.clone()),
                    GlassKind::Rest,
                    Mode::default(),
                    focused,
                    Spec::new(Tone::Clear, 3.0),
                    window,
                    cx,
                )
                .group(group.clone())
                .pl(px(10.0))
                .pr(px(6.0))
                .py(px(5.0))
                .rounded(px(3.0))
                .flex()
                .flex_row()
                .items_start()
                .gap(px(10.0))
                .child(
                    div()
                        .w(px(140.0))
                        .flex_none()
                        .pt(px(2.0))
                        .font_role(Role::Index)
                        .type_px(12.0, 18.0)
                        .text_color(p.ink(3).solid())
                        .child(row.key.clone()),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .font_role(Role::Prose)
                        .type_px(14.0, 14.0 * 1.6)
                        .text_color(p.ink(1).solid())
                        .child(row.value.clone()),
                )
                .child(x),
            );
        }
        page::column(look, div().flex().flex_col().child(head).child(list))
            .when(self.last, |el| el.pb(px(80.0)))
    }
}
