//! A patch module: editable title and text, with source references kept by F3.
use crate::fields::guarded;
use dr_shell::{
    t,
    v3::{ModuleHost, Rendered},
};
use dr_ui::{
    components::Button,
    input::{FieldEvent, TextArea},
};
use dr_workspace::{
    Actor,
    commands::v3::{
        content::{Patch, PatchIn, PatchPut, PatchRemove, RecordIn},
        module::{In, ModuleRead},
    },
};
use gpui::{prelude::*, *};
use std::collections::BTreeMap;

#[cfg(test)]
mod tests;

struct Row {
    title: Entity<TextArea>,
    body: Entity<TextArea>,
    stored: (String, String),
    dirty: bool,
    writing: bool,
    queued: bool,
    error: bool,
    _events: Vec<Subscription>,
}
pub struct Patches {
    host: ModuleHost,
    records: Vec<Patch>,
    rows: BTreeMap<String, Row>,
    reading: bool,
    stale: bool,
    error: bool,
    read_epoch: u64,
    pending_add: usize,
    adding: bool,
}
pub fn register(cx: &mut App) {
    dr_shell::v3::add_module_view(cx, "patches", |host, window, cx| {
        let view = cx.new(|cx| Patches::new(host, window, cx));
        let weak = view.downgrade();
        Rendered::new(view).on_refresh(move |book, cx| {
            weak.update(cx, |v, cx| {
                v.host.page.book = book;
                v.reload(cx);
            })
            .ok();
        })
    });
}
impl Patches {
    fn new(host: ModuleHost, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut v = Self {
            host,
            records: Vec::new(),
            rows: BTreeMap::new(),
            reading: false,
            stale: false,
            error: false,
            read_epoch: 0,
            pending_add: 0,
            adding: false,
        };
        v.reload(cx);
        v
    }
    fn target(&self) -> In {
        In {
            book: self.host.page.book_id.clone(),
            entry: self.host.entry.clone(),
            module: self.host.module.id.clone(),
        }
    }
    fn reload(&mut self, cx: &mut Context<Self>) {
        if self.reading {
            self.stale = true;
            return;
        }
        self.reading = true;
        let epoch = self.read_epoch;
        let (lib, input) = (self.host.page.library.clone(), self.target());
        let job = cx.background_spawn(async move { lib.run::<ModuleRead>(&Actor::User, input) });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            this.update(cx, |v, cx| {
                v.reading = false;
                if epoch != v.read_epoch {
                    v.stale = true;
                } else {
                    match result {
                        Ok(data) => {
                            v.records = data.output.patches;
                            v.error = false;
                        }
                        Err(e) => {
                            log::warn!("patch module: {e}");
                            v.error = true;
                        }
                    }
                }
                if v.stale {
                    v.stale = false;
                    v.reload(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.rows
            .retain(|id, row| row.dirty || row.writing || self.records.iter().any(|p| &p.id == id));
        for patch in &self.records {
            let stored = (patch.title.clone().unwrap_or_default(), patch.body.clone());
            if let Some(row) = self.rows.get_mut(&patch.id) {
                if !row.dirty
                    && !row.writing
                    && !row.error
                    && !row.title.focus_handle(cx).is_focused(window)
                    && !row.body.focus_handle(cx).is_focused(window)
                    && row.stored != stored
                {
                    row.title
                        .update(cx, |f, cx| f.set_text(stored.0.clone(), cx));
                    row.body
                        .update(cx, |f, cx| f.set_text(stored.1.clone(), cx));
                    row.stored = stored;
                }
                continue;
            }
            let title = cx.new(|cx| {
                TextArea::new(
                    SharedString::from(format!("patch-title-{}", patch.id)),
                    window,
                    cx,
                )
                .submit_on_enter()
                .placeholder(t(cx, dr_i18n::keys::k4_pages::TITLE))
                .with_text(stored.0.clone())
            });
            let body = cx.new(|cx| {
                TextArea::new(
                    SharedString::from(format!("patch-body-{}", patch.id)),
                    window,
                    cx,
                )
                .placeholder(t(cx, dr_i18n::keys::k4_pages::BODY))
                .with_text(stored.1.clone())
            });
            let events = [title.clone(), body.clone()]
                .into_iter()
                .map(|field| {
                    let id = patch.id.clone();
                    cx.subscribe(&field, move |v, _, event, cx| match event {
                        FieldEvent::Changed(_) => {
                            if let Some(row) = v.rows.get_mut(&id) {
                                row.dirty = true;
                            }
                        }
                        FieldEvent::Blurred | FieldEvent::Submitted(_) => v.save(&id, cx),
                        FieldEvent::Cancelled => {
                            if let Some(row) = v.rows.get_mut(&id) {
                                row.title
                                    .update(cx, |f, cx| f.set_text(row.stored.0.clone(), cx));
                                row.body
                                    .update(cx, |f, cx| f.set_text(row.stored.1.clone(), cx));
                                row.dirty = false;
                                row.error = false;
                            }
                        }
                    })
                })
                .collect();
            self.rows.insert(
                patch.id.clone(),
                Row {
                    title,
                    body,
                    stored,
                    dirty: false,
                    writing: false,
                    queued: false,
                    error: false,
                    _events: events,
                },
            );
        }
    }
    fn save(&mut self, id: &str, cx: &mut Context<Self>) {
        self.save_draft(id, false, cx);
    }
    fn save_draft(&mut self, id: &str, retry: bool, cx: &mut Context<Self>) {
        let input = self.target();
        let Some(row) = self.rows.get_mut(id) else {
            return;
        };
        if row.writing || self.adding {
            row.queued = true;
            return;
        }
        if !row.dirty || (row.error && !retry) {
            return;
        }
        let sent = (row.title.read(cx).text(), row.body.read(cx).text());
        let base = row.stored.clone();
        row.writing = true;
        row.queued = false;
        row.error = false;
        let (lib, id) = (self.host.page.library.clone(), id.to_owned());
        let (draft, patch_id) = (sent.clone(), id.clone());
        let job = cx.background_spawn(async move {
            guarded::patch(&lib, input, patch_id, base, draft, retry)?.commit(&lib)
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            this.update(cx, |v, cx| {
                let mut again = false;
                if let Some(row) = v.rows.get_mut(&id) {
                    row.writing = false;
                    match result {
                        Ok(saved) => {
                            let baseline = guarded::acknowledged_base(
                                &sent,
                                saved.clone(),
                                &(row.title.read(cx).text(), row.body.read(cx).text()),
                            );
                            // Keep typing that happened while the command was in
                            // flight, but refresh fields merged from the fresh read.
                            if sent.0 != saved.0 && row.title.read(cx).text() == sent.0 {
                                row.title
                                    .update(cx, |f, cx| f.set_text(saved.0.clone(), cx));
                            }
                            if sent.1 != saved.1 && row.body.read(cx).text() == sent.1 {
                                row.body.update(cx, |f, cx| f.set_text(saved.1.clone(), cx));
                            }
                            row.stored = baseline;
                            row.dirty =
                                (row.title.read(cx).text(), row.body.read(cx).text()) != row.stored;
                            again = row.queued && row.dirty;
                            v.read_epoch += 1;
                        }
                        Err(e) => {
                            log::warn!("patch write: {e}");
                            row.error = true;
                        }
                    }
                }
                if again {
                    v.save(&id, cx);
                }
                v.pump_add(cx);
                v.reload(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
    fn add(&mut self, cx: &mut Context<Self>) {
        self.pending_add += 1;
        self.pump_add(cx);
    }
    fn pump_add(&mut self, cx: &mut Context<Self>) {
        if self.pending_add == 0 || self.adding || self.rows.values().any(|r| r.writing) {
            return;
        }
        // A click on New patch also blurs the current field. Finish that save
        // before the creation changes the shared book frontier.
        if let Some(id) = self
            .rows
            .iter()
            .find(|(_, r)| r.dirty && !r.error)
            .map(|(id, _)| id.clone())
        {
            self.save(&id, cx);
            return;
        }
        self.pending_add -= 1;
        self.adding = true;
        let (lib, target) = (self.host.page.library.clone(), self.target());
        let job = cx.background_spawn(async move {
            lib.run::<PatchPut>(
                &Actor::User,
                PatchIn {
                    target,
                    id: None,
                    title: None,
                    body: String::new(),
                    pos: None,
                },
            )
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            this.update(cx, |v, cx| {
                v.adding = false;
                match result {
                    Ok(_) => {
                        v.read_epoch += 1;
                        v.reload(cx);
                    }
                    Err(e) => {
                        log::warn!("new patch: {e}");
                        v.error = true;
                    }
                }
                let queued = v
                    .rows
                    .iter()
                    .filter(|(_, r)| r.queued && r.dirty && !r.error)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                for id in queued {
                    v.save(&id, cx);
                }
                v.pump_add(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
    fn remove(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.rows.get(id).is_some_and(|r| r.writing) {
            return;
        }
        let (lib, target, id) = (self.host.page.library.clone(), self.target(), id.to_owned());
        let job = cx.background_spawn(async move {
            lib.run::<PatchRemove>(&Actor::User, RecordIn { target, id })
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            this.update(cx, |v, cx| {
                match result {
                    Ok(_) => {
                        v.read_epoch += 1;
                        v.reload(cx);
                    }
                    Err(e) => {
                        log::warn!("remove patch: {e}");
                        v.error = true;
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}
impl Render for Patches {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync(window, cx);
        let mut list = div().flex().flex_col().gap_4();
        // A deleted record with a refused draft must remain visible and editable.
        let ids = self
            .records
            .iter()
            .map(|p| p.id.clone())
            .chain(
                self.rows
                    .keys()
                    .filter(|id| !self.records.iter().any(|p| &p.id == *id))
                    .cloned(),
            )
            .collect::<Vec<_>>();
        for id in ids {
            let Some(row) = self.rows.get(&id) else {
                continue;
            };
            let source = self
                .records
                .iter()
                .find(|p| p.id == id)
                .and_then(|p| p.source_text.clone());
            let retry_id = id.clone();
            list = list.child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(
                        div()
                            .id(SharedString::from(format!("patch-title-group-{id}")))
                            .role(gpui::Role::Group)
                            .aria_label(t(cx, dr_i18n::keys::k4_pages::TITLE))
                            .child(row.title.clone()),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("patch-body-group-{id}")))
                            .role(gpui::Role::Group)
                            .aria_label(t(cx, dr_i18n::keys::k4_pages::BODY))
                            .child(row.body.clone()),
                    )
                    .children(source.map(|s| {
                        div()
                            .text_color(dr_ui::Theme::of(window, cx).palette.ink(3).solid())
                            .child(s)
                    }))
                    .children(
                        row.error
                            .then(|| t(cx, dr_i18n::keys::k4_pages::SAVE_FAILED)),
                    )
                    .children(row.error.then(|| {
                        Button::new(
                            SharedString::from(format!("retry-patch-{id}")),
                            t(cx, dr_i18n::keys::markdown_share::RETRY),
                        )
                        .on_click(cx.listener(move |v, _, _, cx| v.save_draft(&retry_id, true, cx)))
                    }))
                    .child(
                        Button::new(
                            SharedString::from(format!("remove-patch-{id}")),
                            t(cx, dr_i18n::keys::common::DELETE),
                        )
                        .on_click(cx.listener(move |v, _, _, cx| v.remove(&id, cx))),
                    ),
            );
        }
        list.child(
            Button::new("new-v3-patch", t(cx, dr_i18n::keys::k4_pages::NEW_PATCH))
                .on_click(cx.listener(|v, _, _, cx| v.add(cx))),
        )
        .children(
            self.error
                .then(|| t(cx, dr_i18n::keys::k4_pages::SAVE_FAILED)),
        )
    }
}
