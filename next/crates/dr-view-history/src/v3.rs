//! Complete-entry history, separate from the frozen single-prose dialog.
use crate::{HistoryEvent, model};
use dr_i18n::{I18n, Locale, Platform, keys};
use dr_ui::{
    Theme,
    components::{Button, Dialog, Loading},
    tokens::space,
};
use dr_workspace::{Actor, Workspace, commands::v3::snapshots as api};
use gpui::{prelude::*, *};

pub struct EntryHistoryDialog {
    lib: Workspace,
    target: api::EntryIn,
    title: String,
    strings: I18n,
    points: Option<Vec<api::Point>>,
    preview: Option<api::PreviewOut>,
    selected: Option<String>,
    confirming: bool,
    busy: bool,
    error: Option<String>,
    task: Option<Task<()>>,
}
impl EventEmitter<HistoryEvent> for EntryHistoryDialog {}
impl EntryHistoryDialog {
    pub fn new(
        lib: Workspace,
        target: api::EntryIn,
        title: String,
        locale: Locale,
        platform: Platform,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut d = Self {
            lib,
            target,
            title,
            strings: I18n::new(locale, platform),
            points: None,
            preview: None,
            selected: None,
            confirming: false,
            busy: false,
            error: None,
            task: None,
        };
        d.reload(cx);
        d
    }
    fn reload(&mut self, cx: &mut Context<Self>) {
        let (lib, target) = (self.lib.clone(), self.target.clone());
        self.busy = true;
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { lib.run::<api::List>(&Actor::User, target).map(|o| o.output) })
                .await;
            this.update(cx, |d, cx| {
                d.busy = false;
                match result {
                    Ok(p) => d.points = Some(p),
                    Err(e) => d.error = Some(e.to_string()),
                }
                cx.notify();
            })
            .ok();
        }));
    }
    pub fn select(&mut self, point: String, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.selected = Some(point.clone());
        self.preview = None;
        self.confirming = false;
        self.error = None;
        self.busy = true;
        let (lib, target) = (self.lib.clone(), self.target.clone());
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    lib.run::<api::Preview>(&Actor::User, api::PointIn { target, point })
                        .map(|o| o.output)
                })
                .await;
            this.update(cx, |d, cx| {
                d.busy = false;
                match result {
                    Ok(p) => d.preview = Some(p),
                    Err(e) => d.error = Some(e.to_string()),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }
    pub fn save(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.error = None;
        let (lib, target) = (self.lib.clone(), self.target.clone());
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { lib.run::<api::Create>(&Actor::User, target) })
                .await;
            this.update(cx, |d, cx| {
                d.busy = false;
                match result {
                    Ok(_) => d.reload(cx),
                    Err(e) => d.error = Some(e.to_string()),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }
    pub fn restore(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Some(preview) = &self.preview else {
            return;
        };
        if !self.confirming {
            self.confirming = true;
            cx.notify();
            return;
        }
        let input = api::RestoreIn {
            point: api::PointIn {
                target: self.target.clone(),
                point: preview.point.id.clone(),
            },
            expected: preview.expected.clone(),
        };
        self.busy = true;
        let lib = self.lib.clone();
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { lib.run::<api::Restore>(&Actor::User, input) })
                .await;
            this.update(cx, |d, cx| {
                d.busy = false;
                d.confirming = false;
                match result {
                    Ok(_) => {
                        d.preview = None;
                        d.selected = None;
                        cx.emit(HistoryEvent::Restored {
                            doc: format!("entry:{}", d.target.entry),
                        });
                        d.reload(cx);
                    }
                    Err(e) => {
                        d.error = Some(e.to_string());
                        // Keep the old preview. Selecting again explicitly reads
                        // fresh guards; a refused restore never retries silently.
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }
    pub fn close(&mut self, cx: &mut Context<Self>) {
        if !self.busy {
            cx.emit(HistoryEvent::Close);
        }
    }
}
impl Render for EntryHistoryDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Theme::of(window, cx).palette;
        let mut content = div().flex().flex_col().gap(px(space::S3));
        let entity = cx.entity();
        let save = entity.clone();
        content = content.child(
            Button::new(
                "entry-history-save",
                self.strings.t(keys::entry_snapshot::SAVE),
            )
            .disabled(self.busy)
            .on_click(move |_, _, cx| save.update(cx, |d, cx| d.save(cx))),
        );
        if self.points.is_none() && self.busy {
            content = content.child(Loading::new("entry-history-loading"));
        }
        let mut list = div()
            .id("entry-history-list")
            .max_h(px(
                (f32::from(window.viewport_size().height) - 250.0).max(160.0)
            ))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(space::S3));
        if let Some(points) = &self.points {
            if points.is_empty() {
                list = list.child(self.strings.t(keys::entry_snapshot::EMPTY));
            }
            for (i, point) in points.iter().enumerate() {
                let select = entity.clone();
                let id = point.id.clone();
                list = list.child(
                    Button::new(
                        ElementId::Name(format!("entry-history-point-{i}").into()),
                        format!(
                            "{} · {}",
                            model::stamp(point.ts, model::now_ms()),
                            point.title
                        ),
                    )
                    .text()
                    .disabled(self.busy)
                    .on_click(move |_, _, cx| select.update(cx, |d, cx| d.select(id.clone(), cx))),
                );
                if let Some(preview) = self.preview.as_ref().filter(|v| v.point.id == point.id) {
                    let mut body = div()
                        .id(ElementId::Name(format!("entry-history-preview-{i}").into()))
                        .flex()
                        .flex_col()
                        .gap(px(space::S3));
                    for (label, text) in preview_sections(preview) {
                        body = body
                            .child(div().text_color(p.ink(2).solid()).child(label))
                            .child(div().child(text));
                    }
                    let restore = entity.clone();
                    body = body.child(
                        Button::new(
                            "entry-history-restore",
                            self.strings.t(if self.confirming {
                                keys::snapshot_history::CONFIRM_RESTORE
                            } else {
                                keys::snapshot_history::RESTORE
                            }),
                        )
                        .disabled(self.busy)
                        .on_click(move |_, _, cx| restore.update(cx, |d, cx| d.restore(cx))),
                    );
                    if self.confirming {
                        let cancel = entity.clone();
                        body = body.child(
                            Button::new(
                                "entry-history-cancel",
                                self.strings.t(keys::common::CANCEL),
                            )
                            .text()
                            .disabled(self.busy)
                            .on_click(move |_, _, cx| {
                                cancel.update(cx, |d, cx| {
                                    d.confirming = false;
                                    cx.notify();
                                })
                            }),
                        );
                    }
                    list = list.child(body);
                }
            }
        }
        content = content.child(list);
        let mut dialog = Dialog::new("entry-history-dialog", self.title.clone())
            .eyebrow(self.strings.t(keys::entry_snapshot::TITLE))
            .width(crate::WIDTH)
            .body(content)
            .on_close(move |_, cx| entity.update(cx, |d, cx| d.close(cx)));
        if let Some(error) = &self.error {
            dialog = dialog.status(
                div().text_color(p.danger.solid()).child(
                    self.strings
                        .fmt(keys::snapshot_history::RESTORE_FAILED, &[("error", error)]),
                ),
            );
        }
        div().child(dialog)
    }
}

/// Display historical definitions and stored content, without current-template
/// filtering. Unnamed retained modules still show all their content.
fn preview_sections(p: &api::PreviewOut) -> Vec<(String, String)> {
    let modules = p
        .template
        .as_ref()
        .map(|t| t.modules.as_slice())
        .unwrap_or_default();
    let name = |id: &str| {
        modules
            .iter()
            .find(|m| m.id == id)
            .map(|m| m.name.clone())
            .unwrap_or_default()
    };
    let text = |v: &serde_json::Value| match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    };
    let mut out = Vec::new();
    for b in &p.bodies {
        out.push((
            name(b.doc.rsplit('/').next().unwrap_or_default()),
            b.text.clone(),
        ));
    }
    if let Some(fields) = p.metadata.get("fields").and_then(|v| v.as_object()) {
        for (module, values) in fields {
            if let Some(values) = values.as_object() {
                for (id, value) in values {
                    let label = modules
                        .iter()
                        .find(|m| &m.id == module)
                        .and_then(|m| m.config.defs.iter().find(|d| &d.id == id))
                        .map(|d| d.name.clone())
                        .unwrap_or_default();
                    out.push((label, text(value)));
                }
            }
        }
    }
    for (key, rows) in p.metadata.iter().filter(|(k, _)| k.starts_with("kv:")) {
        if let Some(rows) = rows.as_object() {
            for value in rows.values() {
                out.push((
                    value
                        .get("key")
                        .map(&text)
                        .unwrap_or_else(|| name(&key[3..])),
                    value.get("value").map(&text).unwrap_or_default(),
                ));
            }
        }
    }
    if let Some(patches) = p.records.get("patches") {
        for row in patches.values() {
            out.push((
                row.get("title").map(&text).unwrap_or_default(),
                row.get("body").map(&text).unwrap_or_default(),
            ));
        }
    }
    if let Some(grids) = p.records.get("plot_grids") {
        for (id, row) in grids {
            if let Some(cells) = row.get("cells").and_then(|v| v.as_object()) {
                out.push((
                    name(id.rsplit('/').next().unwrap_or_default()),
                    cells.values().map(&text).collect::<Vec<_>>().join("\n"),
                ));
            }
        }
    }
    out
}
