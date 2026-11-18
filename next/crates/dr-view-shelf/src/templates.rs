//! Project templates on All Projects (`docs/rust-rewrite/project-templates.md`
//! §8, §12; `docs/rust-rewrite/handoff/v5-tracks.md` PT3):
//!
//! - Left-rail 「我的模板」 rows (most-recently-updated first; hidden when empty;
//!   clicking a row itself does nothing) and their hover cards (`编辑`,
//!   `导出（.driftingtemplate）`, `删除` with confirmation).
//! - Template-picker 「新建项目」 dialog (760px, built-in 「写书」 + collapsible
//!   「我的模板」, right-hand structure/Agent/rail/views/book preview; creates
//!   a project named 「未命名」 and focuses Project Home's inline title).

use std::cell::Cell;
use std::collections::BTreeMap;
use std::rc::Rc;

use dr_i18n::keys;
use dr_model::{
    project_template::{
        ProjectTemplateValue, TemplateEntry, TemplateEntryTemplate, TemplateTabMount,
    },
    v3::FieldValue,
};
use dr_shell::{
    Services, Workspace,
    actions::Dismiss,
    strings::{t, tf},
};
use dr_ui::{
    Theme,
    components::{Button, CardAction, CardBody, Dialog, HoverCard, color::parse_hex},
    fonts::{Role, weight},
    glass::{self, Kind as GlassKind, Mode, Spec, Tone},
    sand::{self, Icon, KindMark},
    style::DrStyled,
    tokens::{Palette, Rgb, radius},
};
use dr_workspace::{
    Actor, Workspace as Library,
    commands::{
        book::BookCreateIn,
        v3::{
            project_template::{
                ProjectTemplateDetail, ProjectTemplateGet, ProjectTemplateIdIn,
                ProjectTemplateSummary,
            },
            types::ProjectCreateTemplate,
        },
    },
};
use gpui::{
    AnyElement, App, ClickEvent, Context, ElementId, FocusHandle, Focusable, InteractiveElement,
    IntoElement, MouseButton, ParentElement, Render, SharedString, Stateful,
    StatefulInteractiveElement, Styled, Task, WeakEntity, Window, div, prelude::FluentBuilder as _,
    px,
};

use crate::jobs::Jobs;
use crate::view::{ExportTemplate, Shelf, SubmitDialog};

/// The 「新建项目」 dialog's key context: it holds the keyboard from wherever
/// it opens (全部项目 or the row of projects), so ↩ and ⌘↵ create and Esc
/// closes the dialog alone.
pub(crate) const NEW_PROJECT_CONTEXT: &str = "NewProjectDialog";

pub const NEW_DIALOG_WIDTH: f32 = 760.0;
const PICK_PANE_WIDTH: f32 = 250.0;
const PICK_PANE_HEIGHT: f32 = 520.0;
const STRUCTURE_MAX_HEIGHT: f32 = 220.0;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TemplatePick {
    Builtin,
    Library(String),
}

type CreatedCallback = Rc<dyn Fn(String, &mut Window, &mut App)>;
type CloseCallback = Rc<dyn Fn(&mut Window, &mut App)>;

pub struct NewProjectModal {
    jobs: Jobs,
    ws: WeakEntity<Workspace>,
    focus: FocusHandle,
    builtin: ProjectTemplateValue,
    my_templates: Vec<ProjectTemplateSummary>,
    my_open: bool,
    selected: TemplatePick,
    cached: BTreeMap<String, ProjectTemplateValue>,
    loading_id: Option<String>,
    load_task: Option<Task<()>>,
    busy: bool,
    error: Option<dr_i18n::Key>,
    create_task: Option<Task<()>>,
    on_created: CreatedCallback,
    on_close: CloseCallback,
}

impl NewProjectModal {
    pub(crate) fn new(
        jobs: Jobs,
        ws: WeakEntity<Workspace>,
        my_templates: Vec<ProjectTemplateSummary>,
        on_created: impl Fn(String, &mut Window, &mut App) + 'static,
        on_close: impl Fn(&mut Window, &mut App) + 'static,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            jobs,
            ws,
            focus: cx.focus_handle(),
            builtin: dr_doc::v3::novel_project_template_value(),
            my_templates,
            my_open: true,
            selected: TemplatePick::Builtin,
            cached: BTreeMap::new(),
            loading_id: None,
            load_task: None,
            busy: false,
            error: None,
            create_task: None,
            on_created: Rc::new(on_created),
            on_close: Rc::new(on_close),
        }
    }

    fn library(&self, cx: &App) -> Option<Library> {
        if dr_shell::release::is_releasing(cx) {
            return None;
        }
        self.ws
            .upgrade()
            .and_then(|ws| ws.read(cx).library.clone())
            .or_else(|| cx.try_global::<Services>().and_then(|s| s.library.clone()))
    }

    pub fn set_templates(
        &mut self,
        templates: Vec<ProjectTemplateSummary>,
        cx: &mut Context<Self>,
    ) {
        let previous: BTreeMap<_, _> = self.my_templates.iter().map(|t| (&t.id, t)).collect();
        let updated: BTreeMap<_, _> = templates.iter().map(|t| (&t.id, t)).collect();
        let unchanged = |id: &String| {
            updated
                .get(id)
                .is_some_and(|next| previous.get(id) == Some(next))
        };
        self.cached.retain(|id, _| unchanged(id));
        // A read on its way for a template that changed reads the old
        // version: let it go, so picking that template reads again.
        if self.loading_id.as_ref().is_some_and(|id| !unchanged(id)) {
            self.load_task = None;
            self.loading_id = None;
        }
        let reload = match &self.selected {
            TemplatePick::Library(id) if !unchanged(id) => {
                self.load_task = None;
                self.loading_id = None;
                if updated.contains_key(id) {
                    Some(id.clone())
                } else {
                    self.selected = TemplatePick::Builtin;
                    None
                }
            }
            _ => None,
        };
        self.my_templates = templates;
        if let Some(id) = reload {
            self.ensure_loaded(&id, cx);
        }
        cx.notify();
    }

    pub fn selected(&self) -> &TemplatePick {
        &self.selected
    }

    pub fn my_templates(&self) -> &[ProjectTemplateSummary] {
        &self.my_templates
    }

    pub fn is_my_templates_open(&self) -> bool {
        self.my_open
    }

    pub fn is_busy(&self) -> bool {
        self.busy
    }

    /// The preview read for saved template `id`, if one is kept.
    pub fn preview_of(&self, id: &str) -> Option<&ProjectTemplateValue> {
        self.cached.get(id)
    }

    pub fn selected_value(&self) -> Option<&ProjectTemplateValue> {
        match &self.selected {
            TemplatePick::Builtin => Some(&self.builtin),
            TemplatePick::Library(id) => self.cached.get(id),
        }
    }

    pub fn select(&mut self, pick: TemplatePick, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.selected = pick.clone();
        self.error = None;
        if let TemplatePick::Library(id) = pick {
            self.ensure_loaded(&id, cx);
        }
        cx.notify();
    }

    pub fn toggle_my_templates(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.my_open = !self.my_open;
        cx.notify();
    }

    fn ensure_loaded(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.cached.contains_key(id) || self.loading_id.as_deref() == Some(id) {
            return;
        }
        let Some(lib) = self.library(cx) else {
            return;
        };
        let target_id = id.to_owned();
        let req_id = target_id.clone();
        self.loading_id = Some(target_id.clone());
        let lease = self.jobs.enter(lib);
        self.load_task = Some(cx.spawn(async move |this, cx| {
            let loaded = cx
                .background_executor()
                .spawn(async move {
                    lease
                        .run::<ProjectTemplateGet>(&Actor::User, ProjectTemplateIdIn { id: req_id })
                        .map(|out| out.output)
                        .map_err(|e| e.to_string())
                })
                .await;
            let _ = this.update(cx, |m, cx| m.finish_load(&target_id, loaded, cx));
        }));
    }

    /// A `project_template.get` for template `id` came back. It is kept only
    /// while it is the version the dialog lists: a read that the template
    /// changed under is dropped (the new version's summary reloads it when it
    /// is the one picked). A read that failed says so under the dialog while
    /// that template is picked.
    #[doc(hidden)]
    pub fn finish_load(
        &mut self,
        id: &str,
        loaded: Result<ProjectTemplateDetail, String>,
        cx: &mut Context<Self>,
    ) {
        if self.loading_id.as_deref() == Some(id) {
            self.loading_id = None;
            self.load_task = None;
        }
        let picked = self.selected == TemplatePick::Library(id.to_owned());
        match loaded {
            Ok(detail) => {
                let listed = self.my_templates.iter().find(|t| t.id == id);
                if listed.is_some_and(|t| {
                    t.revision == detail.summary.revision
                        && t.updated_at == detail.summary.updated_at
                }) {
                    self.cached.insert(id.to_owned(), detail.value);
                    if picked && self.error == Some(keys::template_editor::PREVIEW_FAILED) {
                        self.error = None;
                    }
                }
            }
            Err(error) => {
                log::warn!("the project template {id} could not be read for its preview: {error}");
                if picked {
                    self.error = Some(keys::template_editor::PREVIEW_FAILED);
                }
            }
        }
        cx.notify();
    }

    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let on_close = self.on_close.clone();
        on_close(window, cx);
    }

    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.selected_value().is_none() || dr_shell::release::is_releasing(cx) {
            return;
        }
        let Some(lib) = self.library(cx) else {
            return;
        };
        let name = t(cx, keys::project_picker::desk::UNTITLED).to_string();
        let template = match &self.selected {
            TemplatePick::Builtin => None,
            TemplatePick::Library(id) => Some(ProjectCreateTemplate::Library {
                template_id: id.clone(),
            }),
        };

        self.busy = true;
        self.error = None;
        cx.notify();

        let lease = self.jobs.enter(lib);
        self.create_task = Some(cx.spawn_in(window, async move |this, cx| {
            let created = cx
                .background_executor()
                .spawn(async move {
                    lease
                        .run::<dr_workspace::commands::v3::entry::ProjectCreate>(
                            &Actor::User,
                            BookCreateIn {
                                name,
                                summary: String::new(),
                                template,
                            },
                        )
                        .map(|o| o.output.id)
                })
                .await;
            let _ = this.update_in(cx, |m, window, cx| {
                m.busy = false;
                m.create_task = None;
                match created {
                    Ok(id) => {
                        crate::notify_project_created(&id, cx);
                        let on_created = m.on_created.clone();
                        on_created(id, window, cx);
                    }
                    Err(err) => {
                        log::warn!("project.create from template dialog failed: {err}");
                        m.error = Some(keys::project_templates::CREATE_PROJECT_FAILED);
                        cx.notify();
                    }
                }
            });
        }));
    }

    fn render_left_pane(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let entity = cx.entity();

        let builtin_selected = self.selected == TemplatePick::Builtin;
        let builtin_name: SharedString = self.builtin.name.clone().into();
        let builtin_row = {
            let entity = entity.clone();
            glass::glass_box(
                "shelf-new-pick-builtin",
                GlassKind::Hidden,
                Mode {
                    disabled: self.busy,
                    ..Mode::default()
                },
                builtin_selected,
                Spec::new(Tone::Clear, radius::MENU_ROW),
                window,
                cx,
            )
            .debug_selector(|| "shelf-new-pick-builtin".into())
            .min_h(px(32.0))
            .px(px(10.0))
            .py(px(6.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .rounded(px(radius::MENU_ROW))
            .font_role(Role::Ui)
            .type_px(15.0, 20.0)
            .when(builtin_selected, |el| el.weight(weight::MEDIUM))
            .text_color(if builtin_selected {
                p.ink(1).solid()
            } else {
                p.ink(2).solid()
            })
            .role(gpui::Role::Button)
            .aria_label(builtin_name.clone())
            .when(!self.busy, |el| {
                el.cursor_pointer().on_click(move |_, _, cx| {
                    entity.update(cx, |m, cx| m.select(TemplatePick::Builtin, cx));
                })
            })
            .child(div().flex_1().min_w_0().truncate().child(builtin_name))
        };

        let mut pane = div()
            .id("shelf-new-left-pane")
            .debug_selector(|| "shelf-new-left-pane".into())
            .w(px(PICK_PANE_WIDTH))
            .h(px(PICK_PANE_HEIGHT))
            .flex_none()
            .p(px(6.0))
            .bg(p.page.solid())
            .border(px(0.5))
            .border_color(p.hairline())
            .rounded(px(10.0))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .child(
                div()
                    .px(px(10.0))
                    .pt(px(6.0))
                    .pb(px(2.0))
                    .font_role(Role::Index)
                    .type_px(13.0, 18.0)
                    .text_color(p.ink(4).solid())
                    .child(t(cx, keys::project_templates::BUILTIN)),
            )
            .child(builtin_row);

        if !self.my_templates.is_empty() {
            let toggle_entity = entity.clone();
            let toggle_header = div()
                .id("shelf-new-my-templates-toggle")
                .debug_selector(|| "shelf-new-my-templates-toggle".into())
                .px(px(10.0))
                .pt(px(4.0))
                .pb(px(2.0))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(5.0))
                .role(gpui::Role::Button)
                .aria_label(t(cx, keys::project_templates::MY_TEMPLATES))
                .when(!self.busy, |el| {
                    el.cursor_pointer().on_click(move |_, _, cx| {
                        toggle_entity.update(cx, |m, cx| m.toggle_my_templates(cx));
                    })
                })
                .child(
                    div()
                        .debug_selector(|| "shelf-new-my-templates-label".into())
                        .font_role(Role::Index)
                        .type_px(13.0, 18.0)
                        .text_color(p.ink(4).solid())
                        .child(t(cx, keys::project_templates::MY_TEMPLATES)),
                )
                // The prototype's fold: the arrow after the words, at the
                // row's end.
                .child(
                    div()
                        .debug_selector(|| "shelf-new-my-templates-arrow".into())
                        .ml_auto()
                        .flex_none()
                        .child(sand::icon(
                            if self.my_open {
                                Icon::ChevronDown
                            } else {
                                Icon::ChevronRight
                            },
                            13.0,
                            p.ink(4).solid(),
                        )),
                );

            pane = pane
                .child(div().mx(px(8.0)).my(px(6.0)).h(px(0.5)).bg(p.hairline()))
                .child(toggle_header);

            if self.my_open {
                for tpl in &self.my_templates {
                    let tid = tpl.id.clone();
                    let is_sel = self.selected == TemplatePick::Library(tid.clone());
                    let row_id = format!("shelf-new-pick-{tid}");
                    let row_sel = row_id.clone();
                    let author = tpl
                        .credit
                        .as_ref()
                        .map(|c| c.author.trim())
                        .filter(|a| !a.is_empty())
                        .map(str::to_owned);
                    let row_entity = entity.clone();
                    let tname: SharedString = tpl.name.clone().into();
                    let row = glass::glass_box(
                        ElementId::Name(row_id.into()),
                        GlassKind::Hidden,
                        Mode {
                            disabled: self.busy,
                            ..Mode::default()
                        },
                        is_sel,
                        Spec::new(Tone::Clear, radius::MENU_ROW),
                        window,
                        cx,
                    )
                    .debug_selector(move || row_sel.clone())
                    .min_h(px(32.0))
                    .px(px(10.0))
                    .py(px(6.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .rounded(px(radius::MENU_ROW))
                    .font_role(Role::Ui)
                    .type_px(15.0, 20.0)
                    .when(is_sel, |el| el.weight(weight::MEDIUM))
                    .text_color(if is_sel {
                        p.ink(1).solid()
                    } else {
                        p.ink(2).solid()
                    })
                    .role(gpui::Role::Button)
                    .aria_label(tname.clone())
                    .when(!self.busy, |el| {
                        el.cursor_pointer().on_click(move |_, _, cx| {
                            row_entity.update(cx, |m, cx| {
                                m.select(TemplatePick::Library(tid.clone()), cx)
                            });
                        })
                    })
                    .child(div().flex_1().min_w_0().truncate().child(tname))
                    .when_some(author, |el, a| {
                        el.child(
                            div()
                                .flex_none()
                                .font_role(Role::Index)
                                .type_px(13.0, 18.0)
                                .text_color(p.ink(4).solid())
                                .child(a),
                        )
                    });
                    pane = pane.child(row);
                }
            }
        }

        pane.into_any_element()
    }

    fn render_right_pane(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;

        let Some(val) = self.selected_value() else {
            // Summary fallback while `project_template.get` finishes on background executor.
            let fallback_name = match &self.selected {
                TemplatePick::Builtin => self.builtin.name.clone(),
                TemplatePick::Library(id) => self
                    .my_templates
                    .iter()
                    .find(|t| &t.id == id)
                    .map(|t| t.name.clone())
                    .unwrap_or_default(),
            };
            return div()
                .id("shelf-new-right-pane")
                .debug_selector(|| "shelf-new-right-pane".into())
                .flex_1()
                .min_w_0()
                .max_h(px(PICK_PANE_HEIGHT))
                .child(
                    div()
                        .font_role(Role::Ui)
                        .type_px(16.0, 22.0)
                        .weight(weight::SEMIBOLD)
                        .text_color(p.ink(1).solid())
                        .child(fallback_name),
                )
                .into_any_element();
        };

        let author = val
            .credit
            .as_ref()
            .map(|c| c.author.trim())
            .filter(|a| !a.is_empty())
            .map(str::to_owned);
        let desc = (!val.description.trim().is_empty()).then(|| val.description.clone());

        let tree_rows = build_preview_tree_rows(val, p);
        let tree_box = div()
            .id("shelf-new-preview-tree")
            .debug_selector(|| "shelf-new-preview-tree".into())
            .w_full()
            .max_h(px(STRUCTURE_MAX_HEIGHT))
            .px(px(10.0))
            .py(px(8.0))
            .bg(p.page.solid())
            .border(px(0.5))
            .border_color(p.hairline())
            .rounded(px(10.0))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .children(tree_rows);

        // As the prototype shows it: the Agent's name and one paragraph, its
        // 注意事项 (instructions).
        let agent_section = val
            .project
            .agent
            .as_ref()
            .filter(|a| !a.name.trim().is_empty() || !a.instructions.trim().is_empty())
            .map(|a| {
                let mut content = div()
                    .id("shelf-new-preview-agent")
                    .debug_selector(|| "shelf-new-preview-agent".into())
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .font_role(Role::Ui)
                    .type_px(15.0, 23.0);
                if !a.name.trim().is_empty() {
                    content = content.child(
                        div()
                            .debug_selector(|| "shelf-new-preview-agent-name".into())
                            .text_color(p.ink(1).solid())
                            .child(a.name.clone()),
                    );
                }
                if !a.instructions.trim().is_empty() {
                    content = content.child(
                        div()
                            .debug_selector(|| "shelf-new-preview-agent-notes".into())
                            .text_color(p.muted().solid())
                            .child(dr_ui::text::wrapped(a.instructions.clone())),
                    );
                }
                preview_section(
                    t(cx, keys::template_editor::FOR_AGENT),
                    content.into_any_element(),
                    p,
                )
            });

        let entry_titles: BTreeMap<&str, &str> = val
            .entries
            .iter()
            .map(|e| (e.sym_ref.as_str(), e.title.as_str()))
            .collect();
        let tabs_text: Vec<String> = val
            .project
            .tabs
            .iter()
            .map(|tab| match &tab.mount {
                TemplateTabMount::Root => t(cx, keys::v3_shell::OUTERMOST).to_string(),
                TemplateTabMount::Book => t(cx, keys::v3_tabs::BOOK).to_string(),
                TemplateTabMount::Entry { entry } => entry_titles
                    .get(entry.as_str())
                    .copied()
                    .unwrap_or_default()
                    .to_owned(),
            })
            .filter(|s| !s.is_empty())
            .collect();
        let views_text: Vec<&str> = val.views.iter().map(|v| v.name.as_str()).collect();
        let book_state = if val.project.book.is_some() {
            t(cx, keys::project_templates::BOOK_ON)
        } else {
            t(cx, keys::project_templates::BOOK_OFF)
        };

        div()
            .id("shelf-new-right-pane")
            .debug_selector(|| "shelf-new-right-pane".into())
            .flex_1()
            .min_w_0()
            .max_h(px(PICK_PANE_HEIGHT))
            .pr(px(4.0))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .child(
                div()
                    .id("shelf-new-preview-name")
                    .debug_selector(|| "shelf-new-preview-name".into())
                    .font_role(Role::Ui)
                    .type_px(16.0, 22.0)
                    .weight(weight::SEMIBOLD)
                    .text_color(p.ink(1).solid())
                    .child(val.name.clone()),
            )
            .when_some(author, |el, a| {
                el.child(
                    div()
                        .id("shelf-new-preview-author")
                        .debug_selector(|| "shelf-new-preview-author".into())
                        .mt(px(4.0))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .font_role(Role::Ui)
                        .type_px(14.0, 20.0)
                        .text_color(p.ink(3).solid())
                        .child(sand::icon(Icon::NameSeal, 14.0, p.ink(3).solid()))
                        .child(a),
                )
            })
            .when_some(desc, |el, d| {
                el.child(
                    div()
                        .id("shelf-new-preview-desc")
                        .debug_selector(|| "shelf-new-preview-desc".into())
                        .mt(px(6.0))
                        .font_role(Role::Ui)
                        .type_px(15.0, 24.0)
                        .text_color(p.muted().solid())
                        .child(dr_ui::text::wrapped(d)),
                )
            })
            .child(preview_section(
                t(cx, keys::project_templates::STRUCTURE),
                tree_box.into_any_element(),
                p,
            ))
            .when_some(agent_section, |el, sec| el.child(sec))
            .when(!tabs_text.is_empty(), |el| {
                el.child(preview_kv_row(
                    "shelf-new-preview-rail",
                    t(cx, keys::project_templates::LEFT_RAIL),
                    tabs_text.join(" · ").into(),
                    14.0,
                    p,
                ))
            })
            .when(!views_text.is_empty(), |el| {
                el.child(preview_kv_row(
                    "shelf-new-preview-views",
                    t(cx, keys::v3_tabs::VIEWS),
                    views_text.join(" · ").into(),
                    4.0,
                    p,
                ))
            })
            .child(preview_kv_row(
                "shelf-new-preview-book",
                t(cx, keys::project_home::project_template::BOOK),
                book_state,
                4.0,
                p,
            ))
            .into_any_element()
    }
}

impl Focusable for NewProjectModal {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for NewProjectModal {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let entity = cx.entity();

        let left = self.render_left_pane(window, cx);
        let right = self.render_right_pane(window, cx);

        let grid = div()
            .w_full()
            .flex()
            .flex_row()
            .items_start()
            .gap(px(20.0))
            .child(left)
            .child(right);

        let error_el = self.error.map(|key| {
            div()
                .debug_selector(|| "shelf-new-error".into())
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .text_color(p.danger.solid())
                .child(
                    div()
                        .debug_selector(|| "shelf-new-error-warning".into())
                        .child(sand::icon(Icon::StatusWarning, 13.0, p.danger.solid())),
                )
                .child(
                    div()
                        .debug_selector(move || key.name().into())
                        .child(t(cx, key)),
                )
        });

        let close_entity = entity.clone();
        let cancel_entity = entity.clone();
        let submit_entity = entity.clone();

        let submit_label = if self.busy {
            t(cx, keys::common::CREATING)
        } else {
            t(cx, keys::project_picker::form::CREATE_SUBMIT)
        };

        let dialog = Dialog::new("shelf-new-dialog", t(cx, keys::all_projects::NEW_PROJECT))
            .width(NEW_DIALOG_WIDTH)
            .close_label(t(cx, keys::common::CLOSE))
            .on_close(move |window, cx| {
                close_entity.update(cx, |m, cx| m.close(window, cx));
            })
            .body(grid)
            .when_some(error_el, |d, e| d.status(e))
            .action(
                div().debug_selector(|| "shelf-new-cancel".into()).child(
                    Button::new("shelf-new-cancel", t(cx, keys::common::CANCEL))
                        .text()
                        .disabled(self.busy)
                        .on_click(move |_, window, cx| {
                            cancel_entity.update(cx, |m, cx| m.close(window, cx));
                        }),
                ),
            )
            .action(
                div().debug_selector(|| "shelf-new-submit".into()).child(
                    Button::new("shelf-new-submit", submit_label)
                        .primary()
                        .disabled(self.busy || self.selected_value().is_none())
                        .on_click(move |_, window, cx| {
                            submit_entity.update(cx, |m, cx| m.submit(window, cx));
                        }),
                ),
            );
        // The dialog holds the keyboard itself: typing goes nowhere under it,
        // ↩ / ⌘↵ create, Esc closes it and nothing else.
        div()
            .id("shelf-new-dialog-keys")
            .key_context(NEW_PROJECT_CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(|m, _: &SubmitDialog, window, cx| m.submit(window, cx)))
            .on_action(cx.listener(|m, _: &Dismiss, window, cx| m.close(window, cx)))
            .child(dialog)
    }
}

fn preview_section(label: SharedString, body: AnyElement, p: &Palette) -> gpui::Div {
    div()
        .mt(px(14.0))
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(
            div()
                .font_role(Role::Index)
                .type_px(13.0, 18.0)
                .text_color(p.ink(3).solid())
                .child(label),
        )
        .child(body)
}

fn preview_kv_row(
    id: &'static str,
    key: SharedString,
    value: SharedString,
    mt: f32,
    p: &Palette,
) -> Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .mt(px(mt))
        .flex()
        .flex_row()
        .items_baseline()
        .gap(px(12.0))
        .child(
            div()
                .w(px(80.0))
                .flex_none()
                .font_role(Role::Index)
                .type_px(14.0, 22.0)
                .text_color(p.ink(3).solid())
                .child(key),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .font_role(Role::Ui)
                .type_px(15.0, 22.0)
                .text_color(p.ink(2).solid())
                .child(value),
        )
}

fn template_entry_color(entry: &TemplateEntry, tpl: Option<&TemplateEntryTemplate>) -> Option<Rgb> {
    let t = tpl?;
    for m in &t.modules {
        if let Some(cf) = &m.config.color_field
            && let Some(FieldValue::Text(s)) = entry.fields.get(&m.id).and_then(|fm| fm.get(cf))
            && let Some(rgb) = parse_hex(s)
        {
            return Some(rgb);
        }
    }
    t.color.as_deref().and_then(parse_hex)
}

fn build_preview_tree_rows(val: &ProjectTemplateValue, p: &Palette) -> Vec<AnyElement> {
    let templates: BTreeMap<&str, &TemplateEntryTemplate> =
        val.templates.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut children_by_parent: BTreeMap<Option<&str>, Vec<&TemplateEntry>> = BTreeMap::new();
    for entry in &val.entries {
        children_by_parent
            .entry(entry.parent.as_deref())
            .or_default()
            .push(entry);
    }

    fn walk<'a>(
        parent: Option<&'a str>,
        depth: usize,
        by_parent: &BTreeMap<Option<&'a str>, Vec<&'a TemplateEntry>>,
        templates: &BTreeMap<&'a str, &'a TemplateEntryTemplate>,
        p: &Palette,
        out: &mut Vec<AnyElement>,
    ) {
        let Some(kids) = by_parent.get(&parent) else {
            return;
        };
        for entry in kids {
            let tpl = entry
                .template
                .as_deref()
                .and_then(|tid| templates.get(tid).copied());
            let mark_name = entry
                .mark
                .as_deref()
                .or_else(|| tpl.and_then(|t| t.mark.as_deref()));
            let kind = dr_shell::book::v3::mark(mark_name, &entry.sym_ref);
            let color = template_entry_color(entry, tpl);
            let km = KindMark::new(
                ElementId::Name(format!("shelf-new-preview-mark-{}", entry.sym_ref).into()),
                kind,
            );
            let mark_el = match color {
                Some(c) => km.color(c),
                None => km,
            };
            out.push(
                div()
                    .min_h(px(26.0))
                    .pl(px(6.0 + depth as f32 * 16.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .font_role(Role::Ui)
                    .type_px(14.0, 20.0)
                    .text_color(p.ink(2).solid())
                    .child(div().flex_none().child(mark_el))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .child(entry.title.clone()),
                    )
                    .into_any_element(),
            );
            walk(
                Some(entry.sym_ref.as_str()),
                depth + 1,
                by_parent,
                templates,
                p,
                out,
            );
        }
    }

    let mut out = Vec::with_capacity(val.entries.len());
    walk(None, 0, &children_by_parent, &templates, p, &mut out);
    out
}

/// Renders the left-rail 「我的模板」 header and rows when `templates` is non-empty.
pub(crate) fn render_rail_templates(
    templates: &[ProjectTemplateSummary],
    press_taken: Rc<Cell<bool>>,
    window: &mut Window,
    cx: &mut Context<Shelf>,
) -> Option<AnyElement> {
    if templates.is_empty() {
        return None;
    }
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let entity = cx.entity();

    let mut rows = Vec::with_capacity(templates.len());
    for tpl in templates {
        let tid = tpl.id.clone();
        let row_id = format!("shelf-template-{tid}");
        let row_sel = row_id.clone();
        let group = SharedString::from(row_id.clone());
        let taken = press_taken.clone();
        let tname: SharedString = tpl.name.clone().into();

        let target_row = glass::glass_box(
            ElementId::Name(row_id.into()),
            GlassKind::Hidden,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, 10.0),
            window,
            cx,
        )
        .debug_selector(move || row_sel.clone())
        .group(group.clone())
        .role(gpui::Role::ListItem)
        .aria_label(tname.clone())
        .w_full()
        .min_h(px(32.0))
        .px(px(10.0))
        .py(px(6.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(10.0))
        .text_color(p.ink(2).solid())
        .group_hover(group, move |st| st.text_color(p.ink(1).solid()))
        .on_mouse_down(MouseButton::Left, move |_, _, _| taken.set(true))
        // Clicking a template row itself intentionally does nothing (`点一行没反应`).
        .on_click(|_, _, cx| cx.stop_propagation())
        .child(sand::icon(Icon::MovableType, 15.0, p.muted().solid()))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .font_role(Role::Ui)
                .type_px(s.body, 20.0)
                .truncate()
                .child(tname),
        );

        let tpl_for_card = tpl.clone();
        let card_entity = entity.clone();
        let hc_id = format!("shelf-template-hc-{tid}");
        let row_with_hc =
            HoverCard::new(ElementId::Name(hc_id.into()), target_row, move |w, cx| {
                let p = Theme::of(w, cx).palette;
                let tpl = &tpl_for_card;
                let tid = tpl.id.clone();
                let author = tpl
                    .credit
                    .as_ref()
                    .map(|c| c.author.trim())
                    .filter(|a| !a.is_empty())
                    .map(str::to_owned);

                let edit_id = tid.clone();
                let edit_entity = card_entity.clone();
                let export_id = tid.clone();
                let delete_tpl = tpl.clone();
                let delete_entity = card_entity.clone();

                let edit_sel = format!("shelf-template-edit-{tid}");
                let export_sel = format!("shelf-template-export-{tid}");
                let delete_sel = format!("shelf-template-delete-{tid}");

                let mut card = CardBody::new(
                    ElementId::Name(format!("shelf-template-card-{tid}").into()),
                    tpl.name.clone(),
                );
                if let Some(a) = author {
                    let author_sel = format!("shelf-template-author-{tid}");
                    card = card.meta(
                        div()
                            .id(ElementId::Name(author_sel.clone().into()))
                            .debug_selector(move || author_sel.clone())
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(5.0))
                            .child(sand::icon(Icon::NameSeal, 14.0, p.ink(3).solid()))
                            .child(a),
                    );
                }
                if !tpl.description.trim().is_empty() {
                    card = card.summary(tpl.description.clone());
                }
                card = card
                    .section(vec![
                        div()
                            .debug_selector({
                                let s = edit_sel.clone();
                                move || s.clone()
                            })
                            .child(
                                CardAction::new(
                                    ElementId::Name(edit_sel.into()),
                                    Icon::Edit,
                                    t(cx, keys::common::EDIT),
                                )
                                .on_click(move |_, window, cx| {
                                    edit_entity.update(cx, |s, cx| {
                                        s.edit_template(&edit_id, window, cx);
                                    });
                                }),
                            )
                            .into_any_element(),
                        div()
                            .debug_selector({
                                let s = export_sel.clone();
                                move || s.clone()
                            })
                            .child(
                                CardAction::new(
                                    ElementId::Name(export_sel.into()),
                                    Icon::ArrowOut,
                                    t(cx, keys::project_templates::EXPORT_FILE),
                                )
                                .on_click(move |_, window, cx| {
                                    window.dispatch_action(
                                        Box::new(ExportTemplate {
                                            template: export_id.clone(),
                                        }),
                                        cx,
                                    );
                                }),
                            )
                            .into_any_element(),
                    ])
                    .section(vec![
                        div()
                            .debug_selector({
                                let s = delete_sel.clone();
                                move || s.clone()
                            })
                            .child(
                                CardAction::new(
                                    ElementId::Name(delete_sel.into()),
                                    Icon::Trash,
                                    t(cx, keys::common::DELETE),
                                )
                                .danger()
                                .on_click(move |_, window, cx| {
                                    delete_entity.update(cx, |s, cx| {
                                        s.ask_delete_template(delete_tpl.clone(), window, cx);
                                    });
                                }),
                            )
                            .into_any_element(),
                    ]);

                card.into_any_element()
            })
            .beside();

        rows.push(row_with_hc.into_any_element());
    }

    Some(
        div()
            .id("shelf-my-templates-section")
            .debug_selector(|| "shelf-my-templates-section".into())
            .mt(px(26.0))
            .min_h_0()
            .flex()
            .flex_col()
            .child(
                div()
                    .id("shelf-my-templates-header")
                    .debug_selector(|| "shelf-my-templates-header".into())
                    .mx(px(10.0))
                    .mb(px(4.0))
                    .flex_none()
                    .font_role(Role::Index)
                    .type_px(13.0, 18.0)
                    .text_color(p.ink(4).solid())
                    .child(t(cx, keys::project_templates::MY_TEMPLATES)),
            )
            .child(
                div()
                    .id("shelf-my-templates")
                    .debug_selector(|| "shelf-my-templates".into())
                    .min_h_0()
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(1.0))
                    .children(rows),
            )
            .into_any_element(),
    )
}

pub(crate) fn render_delete_template_dialog(
    template: &ProjectTemplateSummary,
    busy: bool,
    error: Option<AnyElement>,
    close: impl Fn(&mut Window, &mut App) + Clone + 'static,
    cx: &mut Context<Shelf>,
) -> AnyElement {
    let entity = cx.entity();
    let cancel = {
        let close = close.clone();
        move |_: &ClickEvent, window: &mut Window, cx: &mut App| close(window, cx)
    };
    Dialog::new(
        "shelf-delete-template",
        tf(
            cx,
            keys::project_templates::DELETE_TITLE,
            &[("name", &template.name)],
        ),
    )
    .close_label(t(cx, keys::common::CLOSE))
    .when_some(error, |d, e| d.status(e))
    .action(
        div()
            .debug_selector(|| "shelf-delete-template-cancel".into())
            .child(
                Button::new("shelf-delete-template-cancel", t(cx, keys::common::CANCEL))
                    .disabled(busy)
                    .on_click(cancel),
            ),
    )
    .action(
        div()
            .debug_selector(|| "shelf-delete-template-confirm".into())
            .child(
                Button::new(
                    "shelf-delete-template-confirm",
                    if busy {
                        t(cx, keys::project_picker::delete::DELETING)
                    } else {
                        t(cx, keys::common::DELETE)
                    },
                )
                .danger()
                .icon(Icon::Trash)
                .busy(busy)
                .disabled(busy)
                .on_click(move |_, window, cx| {
                    entity.update(cx, |s, cx| s.confirm_delete_template(window, cx));
                }),
            ),
    )
    .on_close(close)
    .into_any_element()
}
