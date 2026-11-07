//! The history dialog (components.md 「对话框」): the menus' slab lifted
//! off the desk, one column. A point is a row: its time and words in index
//! type, the title then, two lines of its text; the chosen point wears the
//! still selected ring and opens its preview under it. The restore asks
//! once more in place; while it runs the dialog does not close.

use dr_i18n::{I18n, Locale, Platform, keys};
use dr_ui::{
    Theme,
    components::{Button, Dialog, EmptyState, Loading},
    fonts::{Role, weight},
    glass::{self, Kind as GlassKind, Mode, Spec, Tone},
    style::DrStyled,
    tokens::{radius, space},
};
use dr_workspace::commands::points::{
    DocIn, HistoryPoint, HistoryPoints, HistoryPreview, HistoryPreviewOut, HistoryRestorePoint,
    PointIn, RestorePointIn,
};
use dr_workspace::{Actor, Workspace};
use gpui::{
    AnyElement, Context, ElementId, EventEmitter, InteractiveElement, IntoElement, ParentElement,
    Render, SharedString, StatefulInteractiveElement, Styled, Task, Window, div, px,
};

use crate::model;

/// The dialog's width (0.1: 520).
pub const WIDTH: f32 = 520.0;
/// The list's height at most; the dialog stays inside the window as well.
pub const LIST_MAX_HEIGHT: f32 = 460.0;
/// The preview's height at most, under its point.
pub const PREVIEW_MAX_HEIGHT: f32 = 240.0;

/// What the dialog asks of whoever shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HistoryEvent {
    Close,
    /// A point was restored (what changed comes on F3's bus as well).
    Restored {
        doc: String,
    },
}

/// The line under the list after a restore.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Note {
    Restored,
    Failed(String),
}

pub struct HistoryDialog {
    lib: Option<Workspace>,
    doc: String,
    title: SharedString,
    i18n: I18n,
    /// `None` while the first read runs.
    points: Option<Vec<HistoryPoint>>,
    /// The point whose preview is open, and the preview once read.
    selected: Option<i64>,
    preview: Option<HistoryPreviewOut>,
    /// The point whose restore waits for its confirmation.
    confirming: Option<i64>,
    busy: bool,
    note: Option<Note>,
    load: Option<Task<()>>,
    read_preview: Option<Task<()>>,
    restore: Option<Task<()>>,
}

impl EventEmitter<HistoryEvent> for HistoryDialog {}

impl HistoryDialog {
    /// The history of prose document `doc` (`node:<id>`, `element:<id>`,
    /// …) whose page is called `name`.
    pub fn new(
        lib: Option<Workspace>,
        doc: String,
        name: &str,
        locale: Locale,
        platform: Platform,
        cx: &mut Context<Self>,
    ) -> HistoryDialog {
        let i18n = I18n::new(locale, platform);
        let title = match model::kind_key(&doc) {
            Some(kind) => format!("{} · {name}", i18n.t(kind)),
            None => name.to_owned(),
        };
        let mut dialog = HistoryDialog {
            lib,
            doc,
            title: title.into(),
            i18n,
            points: None,
            selected: None,
            preview: None,
            confirming: None,
            busy: false,
            note: None,
            load: None,
            read_preview: None,
            restore: None,
        };
        dialog.reload(cx);
        dialog
    }

    pub fn doc(&self) -> &str {
        &self.doc
    }

    /// The points shown (newest first); `None` while reading.
    pub fn points(&self) -> Option<&[HistoryPoint]> {
        self.points.as_deref()
    }

    pub fn is_busy(&self) -> bool {
        self.busy
    }

    /// Read the points again.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            self.points = Some(Vec::new());
            return;
        };
        let doc = self.doc.clone();
        self.load = Some(cx.spawn(async move |this, cx| {
            let read = cx
                .background_executor()
                .spawn(async move {
                    lib.run::<HistoryPoints>(&Actor::User, DocIn { doc })
                        .map(|o| o.output.points)
                })
                .await;
            this.update(cx, |d, cx| {
                d.load = None;
                match read {
                    Ok(points) => d.points = Some(points),
                    Err(error) => {
                        log::warn!("history of {}: {error}", d.doc);
                        d.points = Some(Vec::new());
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Open (or close) the preview of point `id`.
    pub fn select(&mut self, id: i64, cx: &mut Context<Self>) {
        if self.selected == Some(id) {
            self.selected = None;
            self.preview = None;
            self.read_preview = None;
            cx.notify();
            return;
        }
        self.selected = Some(id);
        self.preview = None;
        let Some(lib) = self.lib.clone() else { return };
        let doc = self.doc.clone();
        self.read_preview = Some(cx.spawn(async move |this, cx| {
            let read = cx
                .background_executor()
                .spawn(async move {
                    lib.run::<HistoryPreview>(&Actor::User, PointIn { doc, point: id })
                        .map(|o| o.output)
                })
                .await;
            this.update(cx, |d, cx| {
                if d.selected != Some(id) {
                    return;
                }
                d.read_preview = None;
                match read {
                    Ok(p) => d.preview = Some(p),
                    Err(error) => log::warn!("preview of {} at {id}: {error}", d.doc),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// 「恢复…」: ask once more, in place.
    pub fn ask_restore(&mut self, id: i64, cx: &mut Context<Self>) {
        if !self.busy {
            self.confirming = Some(id);
            self.note = None;
            cx.notify();
        }
    }

    pub fn cancel_restore(&mut self, cx: &mut Context<Self>) {
        if !self.busy {
            self.confirming = None;
            cx.notify();
        }
    }

    /// 「确认覆盖当前版本」.
    pub fn restore(&mut self, id: i64, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Some(lib) = self.lib.clone() else { return };
        self.busy = true;
        let doc = self.doc.clone();
        self.restore = Some(cx.spawn(async move |this, cx| {
            let input = RestorePointIn {
                doc: doc.clone(),
                point: Some(id),
                at: None,
                book_at: None,
            };
            let done = cx
                .background_executor()
                .spawn(async move { lib.run::<HistoryRestorePoint>(&Actor::User, input) })
                .await;
            this.update(cx, |d, cx| {
                d.busy = false;
                d.confirming = None;
                d.restore = None;
                match done {
                    Ok(_) => {
                        d.note = Some(Note::Restored);
                        cx.emit(HistoryEvent::Restored { doc: doc.clone() });
                    }
                    Err(error) => d.note = Some(Note::Failed(error.to_string())),
                }
                // The restore made a point of its own and changed the text.
                d.selected = None;
                d.preview = None;
                d.reload(cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Close, unless a restore is running.
    pub fn close(&mut self, cx: &mut Context<Self>) {
        if !self.busy {
            cx.emit(HistoryEvent::Close);
        }
    }

    fn row(
        &self,
        i: usize,
        point: &HistoryPoint,
        now: i64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let id = point.id;
        let chosen = self.selected == Some(id);
        let entity = cx.entity();

        let actions: Vec<AnyElement> = if self.confirming == Some(id) {
            let (cancel, confirm) = (entity.clone(), entity.clone());
            vec![
                Button::new(
                    ElementId::Name(format!("history-cancel-{i}").into()),
                    self.i18n.t(keys::common::CANCEL),
                )
                .text()
                .small()
                .disabled(self.busy)
                .on_click(move |_, _, cx| {
                    cx.stop_propagation();
                    cancel.update(cx, |d, cx| d.cancel_restore(cx));
                })
                .into_any_element(),
                Button::new(
                    ElementId::Name(format!("history-confirm-{i}").into()),
                    if self.busy {
                        self.i18n.t(keys::snapshot_history::RESTORING)
                    } else {
                        self.i18n.t(keys::snapshot_history::CONFIRM_RESTORE)
                    },
                )
                .primary()
                .small()
                .busy(self.busy)
                .on_click(move |_, _, cx| {
                    cx.stop_propagation();
                    confirm.update(cx, |d, cx| d.restore(id, cx));
                })
                .into_any_element(),
            ]
        } else {
            let ask = entity.clone();
            vec![
                Button::new(
                    ElementId::Name(format!("history-restore-{i}").into()),
                    self.i18n.t(keys::snapshot_history::RESTORE),
                )
                .small()
                .disabled(self.busy)
                .on_click(move |_, _, cx| {
                    cx.stop_propagation();
                    ask.update(cx, |d, cx| d.ask_restore(id, cx));
                })
                .into_any_element(),
            ]
        };

        let index = |text: String| {
            div()
                .flex_none()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.ink(3).solid())
                .child(text)
        };
        let head = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(space::S3))
            .child(index(model::stamp(point.ts, now)))
            .child(index(
                self.i18n
                    .fmt(keys::common::WORDS_COUNT, &[("count", &point.words)]),
            ))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(2).solid())
                    .children(point.title.clone()),
            )
            .child(
                div()
                    .flex_none()
                    .flex()
                    .flex_row()
                    .gap(px(space::S2))
                    .children(actions),
            );
        let excerpt = (!point.excerpt.is_empty()).then(|| {
            div()
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(p.ink(2).solid())
                .line_clamp(2)
                .text_ellipsis()
                .child(point.excerpt.clone())
        });
        let preview = chosen.then(|| self.preview_view(i, window, cx));

        let select = entity.clone();
        glass::glass_box(
            ElementId::Name(format!("history-point-{i}").into()),
            GlassKind::Hidden,
            Mode::default(),
            chosen,
            Spec::new(Tone::Clear, radius::MENU_ROW).rim(3.0),
            window,
            cx,
        )
        .w_full()
        .flex()
        .flex_col()
        .gap(px(space::S1))
        .px(px(space::S4))
        .py(px(space::S3))
        .cursor_pointer()
        .on_click(move |_, _, cx| select.update(cx, |d, cx| d.select(id, cx)))
        .child(head)
        .children(excerpt)
        .children(preview)
        .into_any_element()
    }

    /// The text at the chosen point: H1/H2/H3 heavier, paragraphs in the
    /// manuscript's face.
    fn preview_view(&self, i: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let body = match &self.preview {
            None => Loading::new(ElementId::Name(
                format!("history-preview-loading-{i}").into(),
            ))
            .inline()
            .into_any_element(),
            Some(pv) => div()
                .flex()
                .flex_col()
                .gap(px(space::S2))
                .children(pv.paragraphs.iter().map(|para| {
                    let el = div().text_color(p.ink(1).solid());
                    match para.heading {
                        Some(level) => el
                            .font_role(Role::Ui)
                            .weight(if level == 1 {
                                weight::SEMIBOLD
                            } else {
                                weight::MEDIUM
                            })
                            .type_px(if level == 1 { s.emphasis } else { s.body }, s.line_body),
                        None => el.font_role(Role::Prose).type_px(s.body, s.line_body),
                    }
                    .child(para.text.clone())
                }))
                .into_any_element(),
        };
        div()
            .id(ElementId::Name(format!("history-preview-{i}").into()))
            .mt(px(space::S2))
            .pt(px(space::S3))
            .border_t(px(0.5))
            .border_color(p.hairline())
            .max_h(px(PREVIEW_MAX_HEIGHT))
            .overflow_y_scroll()
            .child(body)
            .into_any_element()
    }
}

impl Render for HistoryDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let viewport = window.viewport_size();
        // The dialog's frame (title, padding, note) takes about 160px.
        let list_h = LIST_MAX_HEIGHT
            .min(f32::from(viewport.height) - 96.0 - 160.0)
            .max(120.0);
        let now = model::now_ms();

        let body: AnyElement = match &self.points {
            None => Loading::new("history-loading")
                .label(self.i18n.t(keys::snapshot_history::LOADING))
                .into_any_element(),
            Some(points) if points.is_empty() => {
                EmptyState::new("history-empty", self.i18n.t(keys::snapshot_history::EMPTY))
                    .into_any_element()
            }
            Some(points) => {
                let rows: Vec<AnyElement> = points
                    .clone()
                    .iter()
                    .enumerate()
                    .map(|(i, point)| self.row(i, point, now, window, cx))
                    .collect();
                div()
                    .id("history-list")
                    .max_h(px(list_h))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(space::S1))
                    .children(rows)
                    .into_any_element()
            }
        };

        let note = self.note.as_ref().map(|n| {
            let (text, color) = match n {
                Note::Restored => (
                    self.i18n
                        .t(keys::snapshot_history::RESTORE_SUCCESS)
                        .to_string(),
                    p.ink(2),
                ),
                Note::Failed(e) => (
                    self.i18n
                        .fmt(keys::snapshot_history::RESTORE_FAILED, &[("error", e)])
                        .to_string(),
                    p.danger,
                ),
            };
            div()
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(color.solid())
                .child(text)
        });

        let entity = cx.entity();
        let mut dialog = Dialog::new("history-dialog", self.title.clone())
            .eyebrow(self.i18n.t(keys::snapshot_history::TITLE))
            .width(WIDTH)
            .body(body)
            .on_close(move |_, cx| entity.update(cx, |d, cx| d.close(cx)));
        if let Some(note) = note {
            dialog = dialog.status(note);
        }
        div().child(dialog)
    }
}
