//! A patch module: editable title and text, with source references kept by F3.
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

struct Row {
    title: Entity<TextArea>,
    body: Entity<TextArea>,
    stored: (String, String),
    dirty: bool,
    writing: bool,
    queued: bool,
    error: bool,
    awaiting: Option<(String, String)>,
    _events: Vec<Subscription>,
}
pub struct Patches {
    host: ModuleHost,
    records: Vec<Patch>,
    rows: BTreeMap<String, Row>,
    reading: bool,
    stale: bool,
    error: bool,
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
        let (lib, input) = (self.host.page.library.clone(), self.target());
        let job = cx.background_spawn(async move { lib.run::<ModuleRead>(&Actor::User, input) });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            this.update(cx, |v, cx| {
                v.reading = false;
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
                if let Some(awaiting) = &row.awaiting {
                    if awaiting == &stored {
                        row.awaiting = None;
                    } else {
                        continue;
                    }
                }
                if !row.dirty
                    && !row.writing
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
                    awaiting: None,
                    _events: events,
                },
            );
        }
    }
    fn save(&mut self, id: &str, cx: &mut Context<Self>) {
        let input = self.target();
        let Some(row) = self.rows.get_mut(id) else {
            return;
        };
        if row.writing {
            row.queued = true;
            return;
        }
        if !row.dirty {
            return;
        }
        let sent = (row.title.read(cx).text(), row.body.read(cx).text());
        row.writing = true;
        row.queued = false;
        row.error = false;
        let (lib, id) = (self.host.page.library.clone(), id.to_owned());
        let write = PatchIn {
            target: input,
            id: Some(id.clone()),
            title: Some(sent.0.clone()),
            body: sent.1.clone(),
            pos: None,
        };
        let job = cx.background_spawn(async move { lib.run::<PatchPut>(&Actor::User, write) });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            this.update(cx, |v, cx| {
                let mut again = false;
                if let Some(row) = v.rows.get_mut(&id) {
                    row.writing = false;
                    match result {
                        Ok(_) => {
                            row.stored = sent.clone();
                            row.awaiting = Some(sent.clone());
                            row.dirty =
                                (row.title.read(cx).text(), row.body.read(cx).text()) != sent;
                            again = row.queued && row.dirty;
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
                v.reload(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
    fn add(&mut self, cx: &mut Context<Self>) {
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
                match result {
                    Ok(_) => v.reload(cx),
                    Err(e) => {
                        log::warn!("new patch: {e}");
                        v.error = true;
                    }
                }
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
                    Ok(_) => v.reload(cx),
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
        for patch in &self.records {
            let Some(row) = self.rows.get(&patch.id) else {
                continue;
            };
            let id = patch.id.clone();
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
                    .children(patch.source_text.clone().map(|s| {
                        div()
                            .text_color(dr_ui::Theme::of(window, cx).palette.ink(3).solid())
                            .child(s)
                    }))
                    .children(
                        row.error
                            .then(|| t(cx, dr_i18n::keys::k4_pages::SAVE_FAILED)),
                    )
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
