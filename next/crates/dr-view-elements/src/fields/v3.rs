//! Typed fields shared by leaf and level modules. Drafts survive refreshes.
use dr_shell::{
    book::Book,
    t,
    v3::{ModuleHost, Rendered},
};
use dr_ui::{
    Theme,
    components::{Select, select::Choice},
    fonts::Role,
    input::{FieldEvent, TextArea},
    sand::Icon,
    style::DrStyled,
};
use dr_view_page::settlement::{self, Drafts, Drain};
use dr_workspace::commands::v3::{
    module::In,
    types::{FieldDef, FieldValue},
};
use gpui::{prelude::*, *};
use std::{
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

pub fn register(cx: &mut App) {
    dr_shell::v3::add_module_view(cx, "fields", |host, window, cx| {
        let view = cx.new(|cx| TypedFields::new(host, window, cx));
        let weak = view.downgrade();
        Rendered::new(view).on_refresh(move |book, cx| {
            weak.update(cx, |v, cx| v.refresh(book, cx)).ok();
        })
    });
    dr_shell::v3::add_module_view(cx, "kv", |host, _, cx| {
        let view = cx.new(|cx| super::Fields::for_module(host, cx));
        let weak = view.downgrade();
        Rendered::new(view).on_refresh(move |book, cx| {
            weak.update(cx, |v, cx| v.refresh_module(book, cx)).ok();
        })
    });
}

/// Typed input conversion, shared with acceptance tests. Empty clears a field;
/// aliases are one per line, keeping punctuation inside a name intact.
pub fn parse(def: &FieldDef, text: &str) -> Option<FieldValue> {
    if text.is_empty() {
        return Some(FieldValue::Null);
    }
    Some(match def.field_type.as_str() {
        "number" => FieldValue::Number(text.trim().parse::<f64>().ok().filter(|n| n.is_finite())?),
        "date" => {
            dr_model::Day::parse(text)?;
            FieldValue::Text(text.into())
        }
        "aliases" => FieldValue::List(
            text.lines()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
        ),
        "text" | "long_text" => FieldValue::Text(text.into()),
        _ => return None,
    })
}
fn text(value: &FieldValue) -> String {
    match value {
        FieldValue::Text(s) => s.clone(),
        FieldValue::Number(n) => n.to_string(),
        FieldValue::List(xs) => xs.join("\n"),
        FieldValue::Bool(b) => b.to_string(),
        FieldValue::Null => String::new(),
    }
}
struct Input {
    area: Entity<TextArea>,
    dirty: bool,
    draft: String,
    base: FieldValue,
    _event: Subscription,
}

pub struct TypedFields {
    host: ModuleHost,
    inputs: BTreeMap<String, Input>,
    desired: BTreeMap<String, FieldValue>,
    writing: BTreeSet<String>,
    bases: BTreeMap<String, FieldValue>,
    stale_revisions: BTreeSet<String>,
    errors: BTreeMap<String, dr_i18n::Key>,
    images: Vec<(String, String)>,
    images_reading: bool,
    images_stale: bool,
}
impl TypedFields {
    pub fn new(host: ModuleHost, window: &mut Window, cx: &mut Context<Self>) -> Self {
        settlement::register(&host.page.library, window.window_handle(), cx);
        let mut this = Self {
            host,
            inputs: BTreeMap::new(),
            desired: BTreeMap::new(),
            writing: BTreeSet::new(),
            bases: BTreeMap::new(),
            stale_revisions: BTreeSet::new(),
            errors: BTreeMap::new(),
            images: Vec::new(),
            images_reading: false,
            images_stale: false,
        };
        this.sync(window, cx);
        this.reload_images(cx);
        this
    }
    fn reload_images(&mut self, cx: &mut Context<Self>) {
        if !settlement::accepts(cx) {
            return;
        }
        if self.images_reading {
            self.images_stale = true;
            return;
        }
        self.images_reading = true;
        let (lib, book) = (
            self.host.page.library.clone(),
            self.host.page.book_id.clone(),
        );
        let read = cx.background_spawn(async move {
            dr_editor::v3::read(&lib, &book, |v| {
                v.materials()
                    .into_iter()
                    .filter(|m| m.kind == dr_model::kind::MaterialKind::Image)
                    .filter_map(|m| m.asset.map(|id| (id.to_string(), m.title)))
                    .collect::<Vec<_>>()
            })
        });
        cx.spawn(async move |this, cx| {
            let result = read.await;
            this.update(cx, |v, cx| {
                v.images_reading = false;
                if let Ok(images) = result {
                    v.images = images;
                }
                if std::mem::take(&mut v.images_stale) {
                    v.reload_images(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
    pub fn refresh(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
        if let Some(incoming) = book.v3() {
            if self.stale_revisions.contains(&incoming.revision)
                && self
                    .host
                    .page
                    .book
                    .v3()
                    .is_some_and(|b| b.revision != incoming.revision)
            {
                return;
            }
            if !self.writing.is_empty() {
                self.stale_revisions.insert(incoming.revision.clone());
            }
        }
        if let Some(module) = book
            .v3()
            .and_then(|b| b.template_of(&self.host.entry))
            .and_then(|t| t.modules.iter().find(|m| m.id == self.host.module.id))
        {
            self.host.module = module.clone();
        }
        self.host.page.book = book;
        self.reload_images(cx);
        cx.notify();
    }
    pub fn input(&self, id: &str) -> Option<Entity<TextArea>> {
        self.inputs.get(id).map(|i| i.area.clone())
    }
    pub fn is_settled(&self) -> bool {
        self.writing.is_empty()
            && self.desired.is_empty()
            && self.errors.is_empty()
            && self.inputs.values().all(|i| !i.dirty)
    }
    fn stored(&self, id: &str) -> FieldValue {
        self.host
            .page
            .book
            .v3()
            .and_then(|b| b.entry(&self.host.entry))
            .and_then(|e| e.fields.get(&self.host.module.id))
            .and_then(|f| f.get(id))
            .cloned()
            .unwrap_or(FieldValue::Null)
    }
    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for def in self.host.module.config.defs.clone() {
            if !matches!(
                def.field_type.as_str(),
                "text" | "long_text" | "number" | "date" | "aliases"
            ) {
                continue;
            }
            let base = self.stored(&def.id);
            let value = text(&base);
            if let Some(input) = self.inputs.get_mut(&def.id) {
                if !input.dirty
                    && !self.desired.contains_key(&def.id)
                    && !self.writing.contains(&def.id)
                    && !input.area.focus_handle(cx).is_focused(window)
                    && input.area.read(cx).text() != value
                {
                    input.draft = value.clone();
                    input.base = base;
                    input.area.update(cx, |a, cx| a.set_text(value, cx));
                }
            } else {
                let area = cx.new(|cx| {
                    TextArea::new(
                        SharedString::from(format!("v3-field-{}-{}", self.host.module.id, def.id)),
                        window,
                        cx,
                    )
                    .with_text(value.clone())
                });
                let id = def.id.clone();
                let event =
                    cx.subscribe_in(&area, window, move |v, area, event, _, cx| match event {
                        FieldEvent::Changed(value) => {
                            if let Some(input) = v.inputs.get_mut(&id) {
                                if settlement::accepts(cx) {
                                    input.draft = value.clone();
                                    input.dirty = true;
                                } else {
                                    area.update(cx, |a, cx| a.set_text(input.draft.clone(), cx));
                                }
                            }
                        }
                        FieldEvent::Blurred | FieldEvent::Submitted(_) => v.flush(&id, cx),
                        FieldEvent::Cancelled => {
                            if v.writing.contains(&id)
                                || v.desired.contains_key(&id)
                                || v.errors.get(&id) == Some(&dr_i18n::keys::k4_pages::SAVE_FAILED)
                            {
                                return;
                            }
                            if !settlement::accepts(cx) {
                                return;
                            }
                            let base = v.stored(&id);
                            let value = text(&base);
                            area.update(cx, |a, cx| a.set_text(value.clone(), cx));
                            if let Some(input) = v.inputs.get_mut(&id) {
                                input.dirty = false;
                                input.draft = value;
                                input.base = base;
                            }
                            v.errors.remove(&id);
                            cx.notify();
                        }
                    });
                self.inputs.insert(
                    def.id,
                    Input {
                        area,
                        dirty: false,
                        draft: value,
                        base,
                        _event: event,
                    },
                );
            }
        }
    }
    fn flush(&mut self, id: &str, cx: &mut Context<Self>) {
        if !settlement::accepts(cx)
            || self.errors.get(id) == Some(&dr_i18n::keys::k4_pages::SAVE_FAILED)
        {
            return;
        }
        let Some(input) = self.inputs.get(id).filter(|i| i.dirty) else {
            return;
        };
        let Some(def) = self.host.module.config.defs.iter().find(|d| d.id == id) else {
            return;
        };
        if let Some(value) = parse(def, &input.draft) {
            self.set_from(id, value, input.base.clone(), false, cx);
        } else {
            self.errors
                .insert(id.into(), dr_i18n::keys::k4_pages::INVALID_VALUE);
            cx.notify();
        }
    }
    pub fn set(&mut self, id: &str, value: FieldValue, cx: &mut Context<Self>) {
        let base = self
            .inputs
            .get(id)
            .map(|i| i.base.clone())
            .unwrap_or_else(|| self.stored(id));
        self.set_from(id, value, base, false, cx);
    }
    fn set_from(
        &mut self,
        id: &str,
        value: FieldValue,
        base: FieldValue,
        retry: bool,
        cx: &mut Context<Self>,
    ) {
        if !settlement::accepts(cx) {
            return;
        }
        self.bases.entry(id.into()).or_insert(base.clone());
        self.desired.insert(id.into(), value.clone());
        if self.errors.get(id) == Some(&dr_i18n::keys::k4_pages::SAVE_FAILED) && !retry {
            cx.notify();
            return;
        }
        self.errors.remove(id);
        if value == base && !self.writing.contains(id) && !retry {
            self.desired.remove(id);
            self.bases.remove(id);
            if let Some(input) = self.inputs.get_mut(id) {
                input.dirty = false;
            }
        } else {
            self.pump(id, retry, cx);
        }
        cx.notify();
    }
    fn retry(&mut self, id: &str, cx: &mut Context<Self>) {
        if !settlement::accepts(cx) {
            return;
        }
        if let Some(input) = self.inputs.get(id) {
            let Some(value) = self
                .host
                .module
                .config
                .defs
                .iter()
                .find(|d| d.id == id)
                .and_then(|d| parse(d, &input.draft))
            else {
                return;
            };
            self.desired.insert(id.into(), value);
        }
        self.errors.remove(id);
        self.pump(id, true, cx);
    }
    fn pump(&mut self, id: &str, retry: bool, cx: &mut Context<Self>) {
        if self.writing.contains(id) {
            return;
        }
        let Some(value) = self.desired.get(id).cloned() else {
            return;
        };
        let base = self
            .bases
            .get(id)
            .cloned()
            .unwrap_or_else(|| self.stored(id));
        if let Some(book) = self.host.page.book.v3() {
            self.stale_revisions.insert(book.revision.clone());
        }
        self.writing.insert(id.into());
        let (field, sent) = (id.to_owned(), value.clone());
        let target = In {
            book: self.host.page.book_id.clone(),
            entry: self.host.entry.clone(),
            module: self.host.module.id.clone(),
        };
        let lib = self.host.page.library.clone();
        let worker = lib.clone();
        let field_id = field.clone();
        let (job, ticket) = settlement::write(&lib, cx, async move {
            let book = target.book.clone();
            settlement::field(&worker, target, field_id, base, value, retry)?;
            Book::load(&worker, &book)
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            if this
                .update(cx, |v, cx| {
                    v.writing.remove(&field);
                    match result {
                        Ok(book) => {
                            v.host.page.book = Rc::new(book);
                            v.bases.insert(field.clone(), sent.clone());
                            if let Some(input) = v.inputs.get_mut(&field) {
                                input.base = sent.clone();
                                input.dirty = v
                                    .host
                                    .module
                                    .config
                                    .defs
                                    .iter()
                                    .find(|d| d.id == field)
                                    .and_then(|d| parse(d, &input.draft))
                                    != Some(sent.clone());
                            }
                            if v.desired.get(&field) == Some(&sent) {
                                v.desired.remove(&field);
                                v.bases.remove(&field);
                            } else {
                                v.pump(&field, false, cx);
                            }
                        }
                        Err(error) => {
                            log::warn!("v3 field: {error}");
                            v.errors.insert(field, dr_i18n::keys::k4_pages::SAVE_FAILED);
                        }
                    }
                    cx.notify();
                })
                .is_ok()
            {
                ticket.acknowledge();
            }
        })
        .detach();
    }
    fn choices(&self, def: &FieldDef, cx: &App) -> Vec<(String, SharedString)> {
        let mut choices = vec![(String::new(), t(cx, dr_i18n::keys::k4_pages::UNSET))];
        match def.field_type.as_str() {
            "entity_ref" => choices.extend(
                self.host
                    .page
                    .book
                    .v3()
                    .into_iter()
                    .flat_map(|b| &b.entries)
                    .filter(|e| {
                        e.deleted_at.is_none()
                            && def
                                .target_template
                                .as_ref()
                                .is_none_or(|t| e.template.as_ref() == Some(t))
                    })
                    .map(|e| (e.id.clone(), e.title.clone().into())),
            ),
            "image" => choices.extend(
                self.images
                    .iter()
                    .map(|(id, title)| (id.clone(), title.clone().into())),
            ),
            _ => choices.extend(def.options.iter().map(|s| (s.clone(), s.clone().into()))),
        }
        choices
    }
}
impl Render for TypedFields {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync(window, cx);
        let p = Theme::of(window, cx).palette;
        let mut list = div().flex().flex_col().gap_3();
        for def in self.host.module.config.defs.clone() {
            let value = self
                .desired
                .get(&def.id)
                .cloned()
                .unwrap_or_else(|| self.stored(&def.id));
            let weak = cx.weak_entity();
            let id = def.id.clone();
            let field = if let Some(input) = self.inputs.get(&id) {
                input.area.clone().into_any_element()
            } else if matches!(def.field_type.as_str(), "multi_select" | "toggle") {
                let options = if def.field_type == "toggle" {
                    vec![def.name.clone()]
                } else {
                    def.options.clone()
                };
                let mut row = div().flex().flex_row().flex_wrap().gap_2();
                for option in options {
                    let selected = match &value {
                        FieldValue::Bool(b) => *b,
                        FieldValue::List(xs) => xs.contains(&option),
                        _ => false,
                    };
                    let (id, weak, old, kind) = (
                        id.clone(),
                        weak.clone(),
                        value.clone(),
                        def.field_type.clone(),
                    );
                    row = row.child(
                        div()
                            .id(SharedString::from(format!("{}-{option}", id)))
                            .role(gpui::Role::CheckBox)
                            .aria_label(option.clone())
                            .cursor_pointer()
                            .px_2()
                            .py_1()
                            .when(selected, |d| d.bg(p.accent.alpha(0.15)))
                            .child(format!("{} {}", if selected { "✓" } else { "□" }, option))
                            .on_click(move |_, _, cx| {
                                let next = if kind == "toggle" {
                                    FieldValue::Bool(!selected)
                                } else {
                                    let mut xs = match &old {
                                        FieldValue::List(xs) => xs.clone(),
                                        _ => Vec::new(),
                                    };
                                    if selected {
                                        xs.retain(|x| x != &option);
                                    } else {
                                        xs.push(option.clone());
                                    }
                                    FieldValue::List(xs)
                                };
                                weak.update(cx, |v, cx| {
                                    v.set_from(&id, next, old.clone(), false, cx)
                                })
                                .ok();
                            }),
                    );
                }
                row.into_any_element()
            } else {
                let mut choices = self.choices(&def, cx);
                let retained = text(&value);
                if !retained.is_empty() && !choices.iter().any(|(id, _)| id == &retained) {
                    choices.push((retained, t(cx, dr_i18n::keys::k4_pages::RETAINED)));
                }
                let selected = choices
                    .iter()
                    .position(|(id, _)| *id == text(&value))
                    .unwrap_or(0);
                let value_before = value.clone();
                Select::new(
                    SharedString::from(format!("v3-select-{}-{id}", self.host.module.id)),
                    choices
                        .iter()
                        .map(|(_, title)| Choice::new(Icon::ChevronRight, title.clone()))
                        .collect(),
                    selected,
                )
                .max_menu_height(280.0)
                .on_change(move |index, _, cx| {
                    if let Some((choice, _)) = choices.get(index) {
                        let value = if choice.is_empty() {
                            FieldValue::Null
                        } else {
                            FieldValue::Text(choice.clone())
                        };
                        weak.update(cx, |v, cx| {
                            v.set_from(&id, value, value_before.clone(), false, cx)
                        })
                        .ok();
                    }
                })
                .into_any_element()
            };
            list = list.child(
                div()
                    .id(SharedString::from(format!(
                        "v3-field-row-{}-{}",
                        self.host.module.id, def.id
                    )))
                    .role(gpui::Role::Group)
                    .aria_label(def.name.clone())
                    .flex()
                    .flex_row()
                    .gap_4()
                    .items_start()
                    .child(
                        div()
                            .w(px(140.))
                            .font_role(Role::Index)
                            .text_color(p.ink(3).solid())
                            .child(def.name),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(field)
                            .children(self.errors.get(&def.id).map(|k| div().child(t(cx, *k))))
                            .children(
                                (self.errors.get(&def.id)
                                    == Some(&dr_i18n::keys::k4_pages::SAVE_FAILED))
                                .then(|| {
                                    let id = def.id.clone();
                                    dr_ui::components::Button::new(
                                        SharedString::from(format!("retry-field-{id}")),
                                        t(cx, dr_i18n::keys::markdown_share::RETRY),
                                    )
                                    .on_click(cx.listener(move |v, _, _, cx| v.retry(&id, cx)))
                                }),
                            ),
                    ),
            );
        }
        list.font_role(Role::Prose).text_color(p.ink(1).solid())
    }
}

impl Drafts for TypedFields {
    fn drain(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Drain {
        for id in self.inputs.keys().cloned().collect::<Vec<_>>() {
            self.flush(&id, cx);
        }
        if !self.writing.is_empty() || self.images_reading {
            return Drain::Pending;
        }
        if let Some(error) = self.errors.values().next() {
            return Drain::Failed(t(cx, *error).to_string());
        }
        if self.is_settled() {
            Drain::Ready
        } else {
            Drain::Failed(t(cx, dr_i18n::keys::k4_pages::SAVE_FAILED).to_string())
        }
    }
}

#[cfg(test)]
impl TypedFields {
    pub(crate) fn release_test_retry(&mut self, cx: &mut Context<Self>) {
        self.retry("text", cx);
    }
}
