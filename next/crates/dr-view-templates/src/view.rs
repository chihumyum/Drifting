use std::{collections::BTreeMap, rc::Rc};

use dr_i18n::keys::common;
use dr_i18n::keys::template_editor as k;
use dr_shell::{
    book::Book,
    nav::{Open, Target},
    pages::PageViewHost,
    t,
};
use dr_ui::{
    Theme,
    components::overlay::{self, Layer, Place},
    components::{Button, Choice, Dialog, Menu, MenuItem, Select},
    fonts::Role,
    input::{FieldEvent, TextArea, TextField},
    sand::{self, Icon},
    style::DrStyled as _,
};
use dr_workspace::commands::v3::types::*;
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EntityId, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div, px,
};

use crate::model;
mod guidance;
mod levels;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Binding {
    Name,
    Color,
    ModuleName(String),
    FieldName(String, String),
    Options(String, String),
    AgentName,
    AgentDescription,
    AgentInstructions,
    ModuleInstructions(String),
    ActionName(String),
}
impl Binding {
    fn value(&self, t: &EntryTemplate) -> String {
        match self {
            Self::Name => t.name.clone(),
            Self::Color => t.color.clone().unwrap_or_default(),
            Self::AgentName => t.agent.as_ref().map(|a| a.name.clone()).unwrap_or_default(),
            Self::AgentDescription => t
                .agent
                .as_ref()
                .map(|a| a.description.clone())
                .unwrap_or_default(),
            Self::AgentInstructions => t
                .agent
                .as_ref()
                .map(|a| a.instructions.clone())
                .unwrap_or_default(),
            Self::ModuleInstructions(id) => t
                .modules
                .iter()
                .find(|m| &m.id == id)
                .and_then(|m| m.agent.as_ref())
                .map(|a| a.instructions.clone())
                .unwrap_or_default(),
            Self::ActionName(id) => t
                .verbs
                .iter()
                .find(|v| &v.id == id)
                .map(|v| v.name.clone())
                .unwrap_or_default(),
            Self::ModuleName(id) => t
                .modules
                .iter()
                .find(|m| &m.id == id)
                .map(|m| m.name.clone())
                .unwrap_or_default(),
            Self::FieldName(m, f) | Self::Options(m, f) => t
                .modules
                .iter()
                .find(|x| &x.id == m)
                .and_then(|m| m.config.defs.iter().find(|x| &x.id == f))
                .map(|f| {
                    if matches!(self, Self::Options(..)) {
                        f.options.join("\n")
                    } else {
                        f.name.clone()
                    }
                })
                .unwrap_or_default(),
        }
    }
    fn set(&self, t: &mut EntryTemplate, value: String) {
        match self {
            Self::Name => t.name = value,
            Self::Color => t.color = (!value.trim().is_empty()).then_some(value),
            Self::AgentName | Self::AgentDescription | Self::AgentInstructions => {
                let agent = t.agent.get_or_insert_with(TemplateAgentConfig::default);
                match self {
                    Self::AgentName => agent.name = value,
                    Self::AgentDescription => agent.description = value,
                    _ => agent.instructions = value,
                };
            }
            Self::ModuleInstructions(id) => {
                if let Some(module) = t.modules.iter_mut().find(|m| &m.id == id) {
                    let agent = module.agent.get_or_insert_with(|| ModuleAgentConfig {
                        writable: true,
                        ..ModuleAgentConfig::default()
                    });
                    agent.instructions = value;
                }
            }
            Self::ActionName(id) => {
                if let Some(verb) = t.verbs.iter_mut().find(|v| &v.id == id) {
                    verb.name = value;
                }
            }
            Self::ModuleName(id) => {
                if let Some(m) = t.modules.iter_mut().find(|m| &m.id == id) {
                    m.name = value.clone();
                    if m.kind == "fields" && m.config.defs.len() == 1 {
                        m.config.defs[0].name = value;
                    }
                }
            }
            Self::FieldName(m, f) | Self::Options(m, f) => {
                if let Some(f) = t
                    .modules
                    .iter_mut()
                    .find(|x| &x.id == m)
                    .and_then(|m| m.config.defs.iter_mut().find(|x| &x.id == f))
                {
                    if matches!(self, Self::Options(..)) {
                        f.options = value
                            .lines()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                            .collect();
                    } else {
                        f.name = value;
                    }
                }
            }
        }
    }
}
enum Input {
    Line(Entity<TextField>, Subscription),
    Area(Entity<TextArea>, Subscription),
}
#[derive(Clone)]
enum Picker {
    Add,
    Mark,
}
#[derive(Clone)]
struct ModuleDrag {
    owner: EntityId,
    module: String,
}
struct Ghost(SharedString);
impl Render for Ghost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().p(px(8.)).child(self.0.clone())
    }
}

pub struct TemplateEditor {
    host: PageViewHost,
    base: Option<EntryTemplate>,
    draft: EntryTemplate,
    creating: bool,
    inputs: BTreeMap<Binding, Input>,
    focus: FocusHandle,
    scroll: ScrollHandle,
    picker: Option<(Picker, gpui::Point<gpui::Pixels>)>,
    saving: bool,
    error: Option<bool>, // true: concurrent edit; false: command refused or storage failure
    preview_open: bool,
    preview_cache: crate::preview::Cache,
    preview_task: Option<gpui::Task<()>>,
    _book: Option<Subscription>,
}
impl Focusable for TemplateEditor {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

pub fn type_label(kind: &str, cx: &App) -> SharedString {
    let key = match kind {
        "prose" => k::PROSE,
        "fields" => k::FIELDS,
        "kv" => k::KV,
        "patches" => k::PATCHES,
        "plot_grid" => k::PLOT_GRID,
        "relations" => k::RELATIONS,
        "text" => k::TEXT,
        "long_text" => k::LONG_TEXT,
        "number" => k::NUMBER,
        "date" => k::DATE,
        "select" => k::SELECT,
        "multi_select" => k::MULTI_SELECT,
        "image" => k::IMAGE,
        "entity_ref" => k::ENTITY_REF,
        "aliases" => k::ALIASES,
        "level" => k::LEVEL,
        "leaf" => k::LEAF,
        _ => return kind.to_owned().into(),
    };
    t(cx, key)
}

fn mark_label(mark: &str, cx: &App) -> SharedString {
    t(
        cx,
        match mark {
            "book" => k::MARK_BOOK,
            "file-text" => k::MARK_SEAL,
            "lightbulb" => k::MARK_SPIRAL,
            "folder" => k::MARK_CORNER,
            "compass" => k::MARK_DASH,
            "git-branch" => k::MARK_WAVE,
            _ => k::MARK_SQUARE,
        },
    )
}

impl TemplateEditor {
    pub fn new(
        host: PageViewHost,
        template: Option<EntryTemplate>,
        kind: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let creating = template.is_none();
        let draft = template.clone().unwrap_or_else(|| {
            let mut draft = model::blank(kind, t(cx, common::UNTITLED).to_string());
            if kind == "leaf" {
                model::add_module(
                    &mut draft,
                    model::module("prose", type_label("prose", cx).to_string()),
                );
            }
            draft
        });
        let mut this = Self {
            host,
            base: template,
            draft,
            creating,
            inputs: BTreeMap::new(),
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            picker: None,
            saving: false,
            error: None,
            preview_open: false,
            preview_cache: crate::preview::Cache::default(),
            preview_task: None,
            _book: None,
        };
        if let Some(workspace) = this.host.workspace.upgrade() {
            this._book = Some(
                cx.observe_in(&workspace, window, |this, workspace, window, cx| {
                    let book = workspace.read(cx).book.clone();
                    if Rc::ptr_eq(&book, &this.host.book) {
                        return;
                    }
                    this.follow(book, window, cx);
                }),
            );
        }
        this
    }
    pub fn draft(&self) -> &EntryTemplate {
        &self.draft
    }
    pub fn is_saving(&self) -> bool {
        self.saving
    }
    pub fn dirty(&self) -> bool {
        self.base.as_ref() != Some(&self.draft)
    }

    pub fn follow(&mut self, book: Rc<Book>, window: &Window, cx: &mut Context<Self>) {
        if book.id != self.host.book_id {
            // Built-in template ids repeat between books. Never merge another
            // book's template into this host's draft, even during navigation.
            self.preview_task = None;
            self.preview_cache = crate::preview::Cache::default();
            self.host.book = book;
            cx.notify();
            return;
        }
        if !self.creating
            && !self.saving
            && let Some(remote) = book.v3().and_then(|v| v.template(&self.draft.id))
            && let Some(base) = &self.base
        {
            let held = self.inputs.iter().any(|(binding, input)| {
                let active = match input {
                    Input::Line(field, _) => {
                        field.read(cx).is_composing() || field.focus_handle(cx).is_focused(window)
                    }
                    Input::Area(field, _) => {
                        field.read(cx).is_composing() || field.focus_handle(cx).is_focused(window)
                    }
                };
                active && binding.value(remote) != binding.value(base)
            });
            if held {
                self.error = Some(true);
            } else {
                match model::reconcile(base, &self.draft, remote) {
                    Ok(draft) => {
                        self.base = Some(remote.clone());
                        self.draft = draft;
                    }
                    Err(_) => self.error = Some(true),
                }
            }
        }
        self.host.book = book;
        self.finish_create(cx);
        cx.notify();
    }

    fn finish_create(&mut self, cx: &mut Context<Self>) {
        if self.creating
            && self.base.is_some()
            && !self.dirty()
            && self
                .host
                .book
                .v3()
                .is_some_and(|book| book.template(&self.draft.id).is_some())
        {
            self.creating = false;
            let workspace = self.host.workspace.clone();
            let id = self
                .draft
                .id
                .parse()
                .expect("command validated template id");
            let editor = cx.entity_id();
            dr_shell::dialogs::hide(cx, editor);
            cx.defer(move |cx| {
                let _ =
                    workspace.update(cx, |ws, cx| ws.open(Target::Template(id), Open::KEEP, cx));
            });
        }
    }

    fn restore(&mut self, cx: &mut Context<Self>) {
        if let Some(remote) = self
            .host
            .book
            .v3()
            .and_then(|book| book.template(&self.draft.id))
        {
            self.base = Some(remote.clone());
            self.draft = remote.clone();
            self.inputs.clear();
            self.error = None;
            cx.notify();
        }
    }

    fn field(
        &mut self,
        binding: Binding,
        label: SharedString,
        multiline: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let value = binding.value(&self.draft);
        if !self.inputs.contains_key(&binding) {
            let id: SharedString = format!("k5-{:?}", binding).into();
            let which = binding.clone();
            let input = if multiline {
                let field = cx.new(|cx| {
                    TextArea::new(id, window, cx)
                        .with_text(value.clone())
                        .framed(2.)
                });
                let sub = cx.subscribe(&field, move |this, _, event: &FieldEvent, cx| {
                    if let FieldEvent::Changed(value) = event {
                        which.set(&mut this.draft, value.clone());
                        cx.notify();
                    }
                });
                Input::Area(field, sub)
            } else {
                let field = cx.new(|cx| {
                    TextField::new(id, window, cx)
                        .bare()
                        .with_text(value.clone())
                });
                let sub = cx.subscribe(&field, move |this, _, event: &FieldEvent, cx| {
                    if let FieldEvent::Changed(value) = event {
                        which.set(&mut this.draft, value.clone());
                        cx.notify();
                    }
                });
                Input::Line(field, sub)
            };
            self.inputs.insert(binding.clone(), input);
        }
        let view = match &self.inputs[&binding] {
            Input::Line(field, _subscription) => {
                let input = field.read(cx);
                if input.text() != value
                    && !input.is_composing()
                    && !input.focus_handle(cx).is_focused(window)
                {
                    field.update(cx, |f, cx| f.set_text(value, cx));
                }
                field.clone().into_any_element()
            }
            Input::Area(field, _subscription) => {
                let input = field.read(cx);
                if input.text() != value
                    && !input.is_composing()
                    && !input.focus_handle(cx).is_focused(window)
                {
                    field.update(cx, |f, cx| f.set_text(value, cx));
                }
                field.clone().into_any_element()
            }
        };
        // Inputs retain dr-ui's IME and caret handling. The named wrapper also
        // makes this real input reachable through the shared debug bridge.
        div()
            .id(SharedString::from(format!("k5-input-{binding:?}")))
            .role(gpui::Role::TextInput)
            .aria_label(label)
            .min_w(px(80.))
            .flex_1()
            .child(view)
            .into_any_element()
    }

    pub fn save(&mut self, cx: &mut Context<Self>) {
        if self.saving || !self.dirty() {
            return;
        }
        if self
            .host
            .workspace
            .upgrade()
            .is_none_or(|workspace| workspace.read(cx).book_id != self.host.book_id)
        {
            self.error = Some(true);
            cx.notify();
            return;
        }
        self.saving = true;
        self.error = None;
        let (lib, book, base, draft) = (
            self.host.library.clone(),
            self.host.book_id.clone(),
            self.base.clone(),
            self.draft.clone(),
        );
        let submitted = draft.clone();
        let task =
            cx.background_spawn(async move { model::save(&lib, &book, base.as_ref(), &draft) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.saving = false;
                match result {
                    Ok(saved) => {
                        match model::reconcile(&submitted, &this.draft, &saved) {
                            Ok(draft) => this.draft = draft,
                            Err(_) => this.error = Some(true),
                        }
                        this.base = Some(saved.clone());
                        this.finish_create(cx);
                    }
                    Err(error) => {
                        this.error = Some(matches!(error, dr_workspace::WsError::Conflict(_)))
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn show_picker(&mut self, picker: Picker, window: &Window, cx: &mut Context<Self>) {
        self.picker = Some((picker, window.mouse_position()));
        cx.notify();
    }
    fn picker(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (which, at) = self.picker.clone()?;
        let values = match which {
            Picker::Mark => model::MARKS.to_vec(),
            // Any template takes any module.
            Picker::Add => model::MODULES
                .iter()
                .chain(model::FIELDS)
                .copied()
                .collect(),
        };
        let mut menu = Menu::new("k5-picker");
        for value in values {
            let label = match which {
                Picker::Add => type_label(value, cx),
                Picker::Mark => mark_label(value, cx),
            };
            let value = value.to_owned();
            let mark = matches!(which, Picker::Mark);
            let icon = if mark {
                dr_ui::components::RowIcon::Mark(
                    dr_shell::book::v3::mark(Some(&value), &self.draft.id),
                    None,
                )
            } else {
                Icon::Plus.into()
            };
            menu = menu.item(
                MenuItem::new(SharedString::from(format!("k5-pick-{value}")), icon, label)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if mark {
                            this.draft.mark = Some(value.clone());
                        } else {
                            model::add_module(
                                &mut this.draft,
                                model::module(&value, type_label(&value, cx).to_string()),
                            );
                        }
                        this.picker = None;
                        cx.notify();
                    })),
            );
        }
        Some(
            overlay::float(
                Place::Point(at),
                Layer::Popover,
                div()
                    .id("k5-menu-scroll")
                    .max_h(px(560.))
                    .overflow_y_scroll()
                    .occlude()
                    .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                        this.picker = None;
                        cx.notify();
                    }))
                    .child(menu),
            )
            .into_any_element(),
        )
    }

    fn module_row(
        &mut self,
        module: &ModuleSpec,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let mid = module.id.clone();
        let owner = cx.entity_id();
        let label: SharedString = module.name.clone().into();
        let drag_label = label.clone();
        let before = mid.clone();
        let remove = mid.clone();
        let mut row = div()
            .id(SharedString::from(format!("k5-module-{mid}")))
            .role(gpui::Role::Group)
            .aria_label(label.clone())
            .flex()
            .flex_col()
            .gap(px(8.))
            .py(px(6.))
            .drag_over::<ModuleDrag>(|s, _, _, _| s.bg(theme.palette.accent.alpha(0.07)))
            .on_drop(cx.listener(move |this, drag: &ModuleDrag, _, cx| {
                if drag.owner == owner {
                    model::move_module(&mut this.draft, &drag.module, Some(&before));
                    cx.notify();
                }
            }));
        let name = self.field(
            Binding::ModuleName(mid.clone()),
            t(cx, k::MODULE_NAME),
            false,
            window,
            cx,
        );
        row = row.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .id(SharedString::from(format!("k5-grip-{mid}")))
                        .role(gpui::Role::Button)
                        .aria_label(format!("{} · {}", t(cx, k::REORDER), module.name))
                        .cursor_grab()
                        .on_drag(
                            ModuleDrag {
                                owner,
                                module: mid.clone(),
                            },
                            move |_, _, _, cx| cx.new(|_| Ghost(drag_label.clone())),
                        )
                        .child(sand::icon(Icon::Grip, 14., theme.palette.ink(4).solid())),
                )
                .child(name)
                .child(type_label(&module.kind, cx))
                .child(
                    Button::new(
                        SharedString::from(format!("k5-remove-{mid}")),
                        t(cx, common::DELETE),
                    )
                    .small()
                    .text()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.draft.modules.retain(|m| m.id != remove);
                        cx.notify();
                    })),
                ),
        );
        for field in &module.config.defs {
            let fid = field.id.clone();
            let mut types = model::FIELDS.to_vec();
            if !types.contains(&field.field_type.as_str()) {
                types.push(&field.field_type);
            }
            let selected = types
                .iter()
                .position(|ty| *ty == field.field_type)
                .unwrap_or(0);
            let options = types
                .iter()
                .map(|ty| Choice::new(Icon::ChevronDown, type_label(ty, cx)))
                .collect();
            let types: Vec<String> = types.into_iter().map(str::to_owned).collect();
            let (m, f) = (mid.clone(), fid.clone());
            let entity = cx.entity();
            let name = self.field(
                Binding::FieldName(mid.clone(), fid.clone()),
                t(cx, k::FIELD_NAME),
                false,
                window,
                cx,
            );
            row = row.child(
                div()
                    .pl(px(22.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(name)
                    .child(
                        Select::new(
                            SharedString::from(format!("k5-field-type-{mid}-{fid}")),
                            options,
                            selected,
                        )
                        .on_change(move |ix, _, cx| {
                            entity.update(cx, |this, cx| {
                                if let Some(module) =
                                    this.draft.modules.iter_mut().find(|x| x.id == m)
                                    && let Some(field) =
                                        module.config.defs.iter_mut().find(|x| x.id == f)
                                {
                                    field.field_type = types[ix].clone();
                                    if field.field_type == "aliases" {
                                        module.config.aliases_field = Some(f.clone());
                                    } else if module.config.aliases_field.as_deref() == Some(&f) {
                                        module.config.aliases_field = None;
                                    }
                                }
                                cx.notify();
                            })
                        }),
                    ),
            );
            if matches!(field.field_type.as_str(), "select" | "multi_select") {
                let input = self.field(
                    Binding::Options(mid.clone(), fid),
                    t(cx, k::OPTIONS),
                    true,
                    window,
                    cx,
                );
                row = row.child(div().pl(px(22.)).child(t(cx, k::OPTIONS)).child(input));
            }
        }
        row.into_any_element()
    }
}

impl Render for TemplateEditor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let name = self.field(Binding::Name, t(cx, k::TEMPLATE_NAME), false, window, cx);
        let color = self.field(Binding::Color, t(cx, k::COLOR), false, window, cx);
        let mark = dr_shell::book::v3::mark(self.draft.mark.as_deref(), &self.draft.id);
        let save = Button::new("k5-save", t(cx, common::SAVE))
            .small()
            .primary()
            .busy(self.saving)
            .disabled(
                self.saving
                    || !self.dirty()
                    || self.draft.name.trim().is_empty()
                    || self.host.book.v3().is_none_or(|book| {
                        model::validate_actions(&self.draft, &book.templates).is_err()
                    }),
            )
            .on_click(cx.listener(|this, _, _, cx| this.save(cx)));
        let head = div()
            .flex()
            .items_center()
            .gap(px(12.))
            .py(px(12.))
            .child(
                div()
                    .id("k5-mark")
                    .role(gpui::Role::Button)
                    .aria_label(t(cx, k::MARK))
                    .cursor_pointer()
                    .on_click(cx.listener(|this, _, w, cx| this.show_picker(Picker::Mark, w, cx)))
                    .child(sand::KindMark::new("k5-mark-symbol", mark).scale(1.5)),
            )
            .child(div().flex_1().min_w_0().type_px(28., 40.).child(name))
            .child(type_label(
                if self.draft.level { "level" } else { "leaf" },
                cx,
            ))
            .child(
                div()
                    .id("k5-status")
                    .role(gpui::Role::Status)
                    .aria_label(t(
                        cx,
                        if self.saving {
                            common::SAVING
                        } else if self.dirty() {
                            k::UNSAVED
                        } else {
                            k::SAVED
                        },
                    ))
                    .text_color(p.ink(4).solid())
                    .child(t(
                        cx,
                        if self.saving {
                            common::SAVING
                        } else if self.dirty() {
                            k::UNSAVED
                        } else {
                            k::SAVED
                        },
                    )),
            )
            .child(
                Button::new("k5-restore", t(cx, k::RESTORE))
                    .small()
                    .text()
                    .disabled(
                        self.saving || self.creating || (!self.dirty() && self.error.is_none()),
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.restore(cx))),
            )
            .child(save);
        let mut content = div().flex().flex_col().gap(px(16.)).child(
            div()
                .flex()
                .gap(px(12.))
                .items_center()
                .child(t(cx, k::COLOR))
                .child(color),
        );
        {
            content = content.child(t(cx, k::MODULES));
            for module in self.draft.modules.clone() {
                content = content.child(self.module_row(&module, window, cx));
            }
            let owner = cx.entity_id();
            content = content.child(
                div()
                    .id("k5-module-end")
                    .min_h(px(36.))
                    .on_drop(cx.listener(move |this, drag: &ModuleDrag, _, cx| {
                        if drag.owner == owner {
                            model::move_module(&mut this.draft, &drag.module, None);
                            cx.notify();
                        }
                    }))
                    .child(
                        Button::new("k5-add-module", t(cx, k::ADD_MODULE))
                            .small()
                            .text()
                            .icon(Icon::Plus)
                            .on_click(
                                cx.listener(|this, _, w, cx| this.show_picker(Picker::Add, w, cx)),
                            ),
                    ),
            );
        }
        // The settings for what lives below show while the default switch
        // is on; their values stay when it is off.
        if self.draft.level {
            content = content
                .child(self.level_settings(cx))
                .child(self.actions(window, cx));
        }
        content = content.child(self.guidance(window, cx));
        if let Some(conflict) = self.error {
            content = content.child(div().text_color(p.danger.solid()).child(t(
                cx,
                if conflict {
                    k::CONFLICT
                } else {
                    common::SAVE_FAILED
                },
            )));
        }
        let body = div()
            .id("k5-body")
            .track_scroll(&self.scroll)
            .overflow_y_scroll()
            .min_h_0()
            .flex_1()
            .child(content.pb(px(80.)));
        let page = div()
            .id("k5-editor")
            .key_context("K5Template")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .px(px(48.))
            .font_role(Role::Ui)
            .type_px(theme.scale.body, theme.scale.line_body)
            .text_color(p.ink(1).solid())
            .child(head)
            .child(body)
            .children(self.picker(cx));
        if self.creating {
            let close = cx.entity_id();
            Dialog::new("k5-create", t(cx, k::NEW_TEMPLATE))
                .width(760.)
                .body(div().h(px(500.)).child(page))
                .on_close(move |_, cx| dr_shell::dialogs::hide(cx, close))
                .into_any_element()
        } else {
            page.into_any_element()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_shell::{Services, SettingsFile, ShellInfo};

    #[gpui::test]
    fn snapshot_refresh_keeps_focused_input_and_refuses_a_concurrent_name(
        cx: &mut gpui::TestAppContext,
    ) {
        cx.executor().allow_parking();
        let dir = tempfile::tempdir().unwrap();
        let store = dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev"))
            .unwrap();
        let seed = dr_testkit::seed::generate_v3(
            dr_testkit::seed::Preset::Tiny,
            dr_testkit::seed::DEFAULT_SEED,
        )
        .unwrap();
        let id = seed.books[0].book_id().to_string();
        seed.write_to(&store).unwrap();
        store.close().unwrap();
        let lib = dr_workspace::Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
        let book = Rc::new(Book::load(&lib, &id).unwrap());
        let original = book.v3().unwrap().template("tpl-chapter").unwrap().clone();
        cx.update(|cx| {
            dr_shell::init(
                ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "0.2.0-dev",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: None,
                },
                Services {
                    library: Some(lib.clone()),
                    book: Some(id.clone()),
                    ..Services::default()
                },
                SettingsFile::in_memory(),
                cx,
            )
        });
        let shell = cx.add_window(dr_shell::Workspace::new).root(cx).unwrap();
        let host = PageViewHost {
            workspace: shell.downgrade(),
            library: lib.clone(),
            book_id: id.clone(),
            book,
        };
        let (editor, cx) = cx.add_window_view(|window, cx| {
            TemplateEditor::new(host, Some(original.clone()), "leaf", window, cx)
        });
        let field = editor.update_in(cx, |editor, window, cx| {
            let _ = editor.field(Binding::Name, "Synthetic name".into(), false, window, cx);
            let Input::Line(field, _) = &editor.inputs[&Binding::Name] else {
                unreachable!()
            };
            let field = field.clone();
            field.update(cx, |field, cx| field.set_text("Synthetic local draft", cx));
            window.focus(&field.focus_handle(cx), cx);
            editor.draft.name = "Synthetic local draft".into();
            field
        });
        let mut remote = original.clone();
        remote.mark = Some("future-mark".into());
        model::save(&lib, &id, Some(&original), &remote).unwrap();
        let changed = Rc::new(Book::load(&lib, &id).unwrap());
        editor.update_in(cx, |editor, window, cx| editor.follow(changed, window, cx));
        assert_eq!(
            field.read_with(cx, |field, _| field.text()),
            "Synthetic local draft"
        );
        editor.read_with(cx, |editor, _| {
            assert_eq!(editor.draft.name, "Synthetic local draft");
            assert_eq!(editor.draft.mark.as_deref(), Some("future-mark"));
            assert!(editor.error.is_none());
        });
        let mut renamed = remote.clone();
        renamed.name = "Synthetic remote name".into();
        model::save(&lib, &id, Some(&remote), &renamed).unwrap();
        let changed = Rc::new(Book::load(&lib, &id).unwrap());
        editor.update_in(cx, |editor, window, cx| editor.follow(changed, window, cx));
        editor.read_with(cx, |editor, _| {
            assert_eq!(editor.draft.name, "Synthetic local draft");
            assert_eq!(editor.error, Some(true));
            assert!(matches!(
                model::save(&lib, &id, editor.base.as_ref(), &editor.draft),
                Err(dr_workspace::WsError::Conflict(_))
            ));
        });
        editor.update(cx, |editor, cx| editor.restore(cx));
        editor.read_with(cx, |editor, _| {
            assert_eq!(editor.draft.name, renamed.name);
            assert!(!editor.dirty());
        });
        let other_id = lib
            .call(
                &dr_workspace::Actor::User,
                "project.create",
                serde_json::json!({
                    "name": "Synthetic other preview book"
                }),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let other = Rc::new(Book::load(&lib, &other_id).unwrap());
        editor.update_in(cx, |editor, window, cx| {
            editor.draft.name = "Synthetic draft before switch".into();
            let request = editor.preview_request().unwrap();
            editor.preview_cache.start(request.clone());
            editor
                .preview_cache
                .publish(&request, Ok("Synthetic original projection".into()));
            editor.follow(other, window, cx);
            assert_eq!(editor.draft.name, "Synthetic draft before switch");
            assert_eq!(editor.base.as_ref().unwrap().name, renamed.name);
            assert!(editor.preview_request().is_none());
            assert!(editor.preview_cache.request.is_none());
            assert!(editor.preview_cache.text.is_none());
        });
        let own = Rc::new(Book::load(&lib, &id).unwrap());
        editor.update_in(cx, |editor, window, cx| {
            editor.follow(own, window, cx);
            assert_eq!(editor.preview_request().unwrap().book, id);
            assert_eq!(editor.draft.name, "Synthetic draft before switch");
        });
        // Guidance edits must not silently grant access or change context tiers.
        editor.update(cx, |editor, cx| {
            editor.draft.modules[0].agent = Some(ModuleAgentConfig {
                writable: false,
                read_tier: Some("on_demand".into()),
                instructions: "Synthetic existing guidance".into(),
            });
            Binding::AgentName.set(&mut editor.draft, "Synthetic \"helper\"".into());
            Binding::AgentDescription.set(&mut editor.draft, "Synthetic description".into());
            Binding::AgentInstructions
                .set(&mut editor.draft, "Synthetic author instructions".into());
            Binding::ModuleInstructions(editor.draft.modules[0].id.clone())
                .set(&mut editor.draft, "Synthetic module guidance".into());
            let module_agent = editor.draft.modules[0].agent.as_ref().unwrap();
            assert!(!module_agent.writable);
            assert_eq!(module_agent.read_tier.as_deref(), Some("on_demand"));
            let preview = crate::preview::project(&lib, &editor.preview_request().unwrap()).unwrap();
            assert_eq!(preview.template.agent.name, "Synthetic \"helper\"");
            assert_eq!(preview.template.agent.description, "Synthetic description");
            assert_eq!(preview.template.agent.instructions, "Synthetic author instructions");
            let projected_module = preview.template.modules.iter()
                .find(|module| module.id == editor.draft.modules[0].id).unwrap();
            assert_eq!(projected_module.agent.instructions, "Synthetic module guidance");
            assert!(!projected_module.agent.writable);
            assert_eq!(projected_module.agent.read_tier.as_deref(), Some("on_demand"));
            assert!(projected_module.capabilities.write_tools.is_empty());
            let encoded = serde_json::to_string(&preview).unwrap();
            assert_eq!(serde_json::from_str::<serde_json::Value>(&encoded).unwrap()
                ["template"]["agent"]["name"], "Synthetic \"helper\"");
            let saved = model::save(&lib, &id, editor.base.as_ref(), &editor.draft).unwrap();
            let book = Book::load(&lib, &id).unwrap();
            assert_eq!(book.v3().unwrap().template(&saved.id), Some(&saved));
            // No permission config existed on this new module: writing a note
            // must retain the model's default permission (true).
            let mut module = model::module("text", "Synthetic new field".into());
            let mid = module.id.clone();
            module.agent = None;
            editor.draft.modules.push(module);
            Binding::ModuleInstructions(mid).set(&mut editor.draft, "Synthetic note".into());
            assert!(
                editor
                    .draft
                    .modules
                    .last()
                    .unwrap()
                    .agent
                    .as_ref()
                    .unwrap()
                    .writable
            );
            let mut level = editor.host.book.v3().unwrap().template("tpl-storyline").unwrap().clone();
            level.settings.accept = Some(false);
            level.settings.lane = Some(true);
            let request = crate::preview::Request { draft: level.clone(), ..editor.preview_request().unwrap() };
            let preview = crate::preview::project(&lib, &request).unwrap();
            assert_eq!(preview.level_defaults.as_ref().unwrap().accept, Some(false));
            assert_eq!(preview.lane, Some(true));
            let levels: Vec<_> = preview.structure.levels.iter()
                .filter(|entry| entry.template.as_deref() == Some(&level.id)).collect();
            assert!(!levels.is_empty());
            assert!(levels.iter().all(|entry| entry.effective_settings.values.accept));
            // A background completion can arrive after an input event but
            // before the next render has scheduled its replacement request.
            let captured = editor.preview_request().unwrap();
            editor.preview_open = true;
            editor.preview_cache.start(captured.clone());
            Binding::AgentInstructions.set(&mut editor.draft, "Synthetic just-typed text".into());
            assert!(!editor.finish_preview(&captured, Ok("stale text".into()), cx));
            assert!(editor.preview_cache.text.is_none());
            let current = editor.preview_request().unwrap();
            editor.preview_cache.start(current.clone());
            assert!(editor.finish_preview(&current, Ok("current text".into()), cx));
            assert_eq!(
                editor.draft.agent.as_ref().unwrap().instructions,
                "Synthetic just-typed text"
            );
            editor.preview_open = false;
            assert!(!editor.finish_preview(&current, Ok("closed preview".into()), cx));
        });
        editor.update_in(cx, |editor, window, cx| {
            let text = "Synthetic focused instructions\nH1 H2 H3";
            Binding::AgentInstructions.set(&mut editor.draft, text.into());
            let _ = editor.field(
                Binding::AgentInstructions,
                "Synthetic instructions".into(),
                true,
                window,
                cx,
            );
            let Input::Area(area, _) = &editor.inputs[&Binding::AgentInstructions] else {
                unreachable!()
            };
            let area = area.clone();
            area.update(cx, |area, cx| area.set_text(text, cx));
            window.focus(&area.focus_handle(cx), cx);
            editor.preview_open = true;
            let request = editor.preview_request().unwrap();
            editor.preview_cache.start(request.clone());
            assert!(editor.finish_preview(
                &request,
                Ok("Synthetic projected structure".into()),
                cx
            ));
            assert!(area.focus_handle(cx).is_focused(window));
            assert_eq!(area.read(cx).text(), text);
            assert_eq!(editor.draft.agent.as_ref().unwrap().instructions, text);
            editor.preview_open = false;
            editor.preview_task = None;
        });
    }
}
