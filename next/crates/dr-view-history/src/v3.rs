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

#[cfg(test)]
#[path = "v3_tests.rs"]
pub(crate) mod tests;

pub struct EntryHistoryDialog {
    lib: Workspace,
    target: api::EntryIn,
    title: String,
    strings: I18n,
    points: Option<Vec<api::Point>>,
    summaries: std::collections::BTreeMap<String, (u64, String)>,
    preview: Option<api::PreviewOut>,
    selected: Option<String>,
    confirming: bool,
    busy: bool,
    error: Option<String>,
    task: Option<Task<()>>,
    known_seq: i64,
    pending_seq: i64,
    reads: u64,
    _events: dr_workspace::Subscription,
    _watch: Task<()>,
    focus: FocusHandle,
    restored: bool,
}
impl EventEmitter<HistoryEvent> for EntryHistoryDialog {}
impl EntryHistoryDialog {
    pub fn is_busy(&self) -> bool {
        self.busy
    }
    pub fn reads(&self) -> u64 {
        self.reads
    }
    pub fn points(&self) -> Option<&[api::Point]> {
        self.points.as_deref()
    }
    pub fn new(
        lib: Workspace,
        target: api::EntryIn,
        title: String,
        locale: Locale,
        platform: Platform,
        cx: &mut Context<Self>,
    ) -> Self {
        let book = target.book.clone();
        let signal = std::sync::Arc::new(std::sync::Mutex::new((
            None::<i64>,
            None::<std::task::Waker>,
        )));
        let tx = signal.clone();
        let events = lib.subscribe(move |event| {
            if let dr_workspace::WsEvent::Checkpoints(c) = event
                && c.book.as_str() == book
            {
                let waker = {
                    let mut state = tx.lock().expect("checkpoint signal lock");
                    state.0 = Some(state.0.map_or(c.seq, |old| old.max(c.seq)));
                    state.1.take()
                };
                if let Some(waker) = waker {
                    waker.wake();
                }
            }
        });
        let watch = cx.spawn(async move |this, cx| {
            loop {
                let seq = std::future::poll_fn(|cx| {
                    let mut state = signal.lock().expect("checkpoint signal lock");
                    if let Some(seq) = state.0.take() {
                        std::task::Poll::Ready(seq)
                    } else {
                        state.1 = Some(cx.waker().clone());
                        std::task::Poll::Pending
                    }
                })
                .await;
                if this.update(cx, |d, cx| d.on_checkpoints(seq, cx)).is_err() {
                    break;
                }
            }
        });
        let mut d = Self {
            lib,
            target,
            title,
            strings: I18n::new(locale, platform),
            points: None,
            summaries: std::collections::BTreeMap::new(),
            preview: None,
            selected: None,
            confirming: false,
            busy: false,
            error: None,
            task: None,
            known_seq: 0,
            pending_seq: 0,
            reads: 0,
            _events: events,
            _watch: watch,
            focus: cx.focus_handle(),
            restored: false,
        };
        d.reload(cx);
        d
    }
    fn on_checkpoints(&mut self, seq: i64, cx: &mut Context<Self>) {
        self.pending_seq = self.pending_seq.max(seq);
        if !self.busy && self.pending_seq > self.known_seq {
            self.reload(cx);
        }
    }
    fn reload(&mut self, cx: &mut Context<Self>) {
        let (lib, target) = (self.lib.clone(), self.target.clone());
        self.reads += 1;
        self.busy = true;
        self.task = Some(cx.spawn(async move |this, cx| {
            let (seq, result, summaries) = cx
                .background_executor()
                .spawn(async move {
                    let seq = lib
                        .library()
                        .head(&format!("checkpoints:{}", target.book))
                        .ok()
                        .flatten()
                        .map_or(0, |h| h.seq);
                    let list = lib
                        .run::<api::List>(&Actor::User, target.clone())
                        .map(|o| o.output);
                    let mut summaries = std::collections::BTreeMap::new();
                    if let Ok(points) = &list {
                        for pt in points.iter().take(30) {
                            if let Ok(prev) = lib.run::<api::Preview>(
                                &Actor::User,
                                api::PointIn {
                                    target: target.clone(),
                                    point: pt.id.clone(),
                                },
                            ) {
                                summaries.insert(pt.id.clone(), point_summary(&prev.output));
                            }
                        }
                    }
                    (seq, list, summaries)
                })
                .await;
            this.update(cx, |d, cx| {
                d.busy = false;
                d.known_seq = d.known_seq.max(seq);
                match result {
                    Ok(p) => {
                        if d.selected
                            .as_ref()
                            .is_some_and(|sel| !p.iter().any(|pt| &pt.id == sel))
                        {
                            d.selected = None;
                            d.preview = None;
                            d.confirming = false;
                        }
                        d.points = Some(p);
                        d.summaries = summaries;
                    }
                    Err(e) => d.error = Some(e.to_string()),
                }
                if d.pending_seq > d.known_seq {
                    d.reload(cx);
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
                if d.pending_seq > d.known_seq {
                    d.reload(cx);
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
        self.preview = None;
        self.selected = None;
        self.confirming = false;
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
                    Err(e) => {
                        d.error = Some(e.to_string());
                        if d.pending_seq > d.known_seq {
                            d.reload(cx);
                        }
                    }
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
                        d.error = None;
                        d.restored = true;
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
                        if d.pending_seq > d.known_seq {
                            d.reload(cx);
                        }
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
impl Focusable for EntryHistoryDialog {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
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
                let summary = self.summaries.get(&point.id);
                let header = match summary {
                    Some((words, _)) if *words > 0 => format!(
                        "{} · {} · {}",
                        model::stamp(point.ts, model::now_ms()),
                        point.title,
                        self.strings
                            .fmt(keys::shell_ui::WORDS_SHORT, &[("count", words)]),
                    ),
                    _ => format!(
                        "{} · {}",
                        model::stamp(point.ts, model::now_ms()),
                        point.title
                    ),
                };
                let excerpt = summary
                    .map(|(_, ex)| ex.as_str())
                    .filter(|ex| !ex.is_empty());
                let mut row = div().flex().flex_col().gap(px(2.0)).child(
                    Button::new(
                        ElementId::Name(format!("entry-history-point-{i}").into()),
                        header,
                    )
                    .text()
                    .disabled(self.busy)
                    .on_click(move |_, _, cx| select.update(cx, |d, cx| d.select(id.clone(), cx))),
                );
                if let Some(ex) = excerpt {
                    row = row.child(
                        div()
                            .pl(px(10.0))
                            .text_xs()
                            .text_color(p.ink(3).solid())
                            .truncate()
                            .child(ex.to_owned()),
                    );
                }
                list = list.child(row);
                if let Some(preview) = self.preview.as_ref().filter(|v| v.point.id == point.id) {
                    let mut detail = div()
                        .id(ElementId::Name(format!("entry-history-preview-{i}").into()))
                        .max_h(px(crate::PREVIEW_MAX_HEIGHT))
                        .overflow_y_scroll()
                        .flex()
                        .flex_col()
                        .gap(px(space::S3));
                    for (section, (label, text)) in
                        preview_sections(preview).into_iter().enumerate()
                    {
                        detail = detail
                            .child(
                                div()
                                    .id(ElementId::Name(
                                        format!("entry-history-label-{i}-{section}").into(),
                                    ))
                                    .role(gpui::Role::Label)
                                    .aria_label(label.clone())
                                    .text_color(p.ink(2).solid())
                                    .child(label),
                            )
                            .child(
                                div()
                                    .id(ElementId::Name(
                                        format!("entry-history-content-{i}-{section}").into(),
                                    ))
                                    .role(gpui::Role::Label)
                                    .aria_label(text.clone())
                                    .child(text),
                            );
                    }
                    let mut body = div().flex().flex_col().gap(px(space::S3)).child(detail);
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
        } else if self.restored {
            dialog =
                dialog.status(div().child(self.strings.t(keys::snapshot_history::RESTORE_SUCCESS)));
        }
        div()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|d, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    d.close(cx);
                }
                cx.stop_propagation();
            }))
            .child(dialog)
    }
}

/// Display historical definitions and stored content, without current-template
/// filtering. Unnamed retained modules still show all their content.
pub(crate) fn preview_sections(p: &api::PreviewOut) -> Vec<(String, String)> {
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
            .unwrap_or_else(|| id.to_owned())
    };
    let text = |v: &serde_json::Value| match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    };
    // Each body once, by its module's name.
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
                    let rendered = format_field_value(value);
                    if rendered.trim().is_empty() {
                        continue;
                    }
                    let label = modules
                        .iter()
                        .find(|m| &m.id == module)
                        .and_then(|m| m.config.defs.iter().find(|d| &d.id == id))
                        .map(|d| d.name.clone())
                        .unwrap_or_else(|| id.clone());
                    out.push((label, rendered));
                }
            }
        }
    }
    for (key, rows) in p.metadata.iter().filter(|(k, _)| k.starts_with("kv:")) {
        if let Some(rows) = rows.as_object() {
            for value in rows.values() {
                let k_str = value
                    .get("key")
                    .map(&text)
                    .unwrap_or_else(|| name(&key[3..]));
                let v_str = value.get("value").map(&text).unwrap_or_default();
                if !k_str.trim().is_empty() || !v_str.trim().is_empty() {
                    out.push((k_str, v_str));
                }
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
                let joined = cells
                    .values()
                    .map(&text)
                    .filter(|s| !s.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                if !joined.is_empty() {
                    out.push((name(id.rsplit('/').next().unwrap_or_default()), joined));
                }
            }
        }
    }
    out
}

fn format_field_value(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|x| x.as_str())
            .collect::<Vec<_>>()
            .join(" · "),
        serde_json::Value::Bool(b) => if *b { "✓" } else { "—" }.into(),
        serde_json::Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

fn point_summary(p: &api::PreviewOut) -> (u64, String) {
    let mut words = 0u64;
    let mut excerpt = String::new();
    for b in &p.bodies {
        words += dr_text::count_words(&b.text);
        if excerpt.is_empty() {
            let clean: String = b.text.split_whitespace().collect::<Vec<_>>().join(" ");
            if !clean.is_empty() {
                let chars: Vec<char> = clean.chars().collect();
                if chars.len() > 120 {
                    excerpt = chars[..120].iter().collect::<String>() + "…";
                } else {
                    excerpt = clean;
                }
            }
        }
    }
    (words, excerpt)
}
