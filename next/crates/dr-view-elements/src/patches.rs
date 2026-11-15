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
use dr_view_page::settlement::{self, Drafts, Drain};
use dr_workspace::{
    Actor,
    commands::v3::{
        content::{Patch, PatchIn, PatchPut},
        module::{In, ModuleRead},
    },
};
use gpui::{prelude::*, *};
use std::collections::BTreeMap;

#[cfg(test)]
#[path = "element/patches/tests.rs"]
mod tests;

struct Row {
    title: Entity<TextArea>,
    body: Entity<TextArea>,
    stored: (String, String),
    draft: (String, String),
    removing: bool,
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
    add_failed: bool,
    _review_focus: Subscription,
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
    pub(crate) fn new(host: ModuleHost, window: &mut Window, cx: &mut Context<Self>) -> Self {
        settlement::register(&host.page.library, window.window_handle(), cx);
        let review_focus = cx.observe_global::<dr_shell::ReviewFocus>(|_, cx| cx.notify());
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
            add_failed: false,
            _review_focus: review_focus,
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
        if !settlement::accepts(cx) {
            return;
        }
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
        self.rows.retain(|id, row| {
            row.dirty
                || row.writing
                || row.error
                || row.removing
                || self.records.iter().any(|p| &p.id == id)
        });
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
                    row.draft = stored.clone();
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
                .enumerate()
                .map(|(index, field)| {
                    let id = patch.id.clone();
                    cx.subscribe(&field, move |v, field, event, cx| match event {
                        FieldEvent::Changed(value) => {
                            if let Some(row) = v.rows.get_mut(&id) {
                                if settlement::accepts(cx) {
                                    if index == 0 {
                                        row.draft.0 = value.clone();
                                    } else {
                                        row.draft.1 = value.clone();
                                    }
                                    row.dirty = true;
                                } else {
                                    let text = if index == 0 {
                                        &row.draft.0
                                    } else {
                                        &row.draft.1
                                    };
                                    field.update(cx, |a, cx| a.set_text(text.clone(), cx));
                                }
                            }
                        }
                        FieldEvent::Blurred | FieldEvent::Submitted(_) => v.save(&id, cx),
                        FieldEvent::Cancelled => {
                            if v.rows.get(&id).is_some_and(|r| r.writing || r.error) {
                                return;
                            }
                            if !settlement::accepts(cx) {
                                return;
                            }
                            if let Some(row) = v.rows.get_mut(&id) {
                                row.title
                                    .update(cx, |f, cx| f.set_text(row.stored.0.clone(), cx));
                                row.body
                                    .update(cx, |f, cx| f.set_text(row.stored.1.clone(), cx));
                                row.draft = row.stored.clone();
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
                    draft: stored.clone(),
                    stored,
                    removing: false,
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
        if !settlement::accepts(cx) {
            return;
        }
        if self.rows.get(id).is_some_and(|r| r.removing) {
            self.remove_draft(id, retry, cx);
            return;
        }
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
        let sent = row.draft.clone();
        let base = row.stored.clone();
        row.writing = true;
        row.queued = false;
        row.error = false;
        let (lib, id) = (self.host.page.library.clone(), id.to_owned());
        let (draft, patch_id) = (sent.clone(), id.clone());
        let worker = lib.clone();
        let (job, ticket) = settlement::write(&lib, cx, async move {
            guarded::patch(&worker, input, patch_id, base, draft, retry)?.commit(&worker)
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            if this
                .update(cx, |v, cx| {
                    let mut again = false;
                    if let Some(row) = v.rows.get_mut(&id) {
                        row.writing = false;
                        match result {
                            Ok(saved) => {
                                let baseline =
                                    guarded::acknowledged_base(&sent, saved.clone(), &row.draft);
                                // Keep typing that happened while the command was in
                                // flight, but refresh fields merged from the fresh read.
                                if sent.0 != saved.0 && row.draft.0 == sent.0 {
                                    row.draft.0 = saved.0.clone();
                                    row.title
                                        .update(cx, |f, cx| f.set_text(saved.0.clone(), cx));
                                }
                                if sent.1 != saved.1 && row.draft.1 == sent.1 {
                                    row.draft.1 = saved.1.clone();
                                    row.body.update(cx, |f, cx| f.set_text(saved.1.clone(), cx));
                                }
                                row.stored = baseline;
                                row.dirty = row.draft != row.stored;
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
                .is_ok()
            {
                ticket.acknowledge();
            }
        })
        .detach();
    }
    fn add(&mut self, cx: &mut Context<Self>) {
        if !settlement::accepts(cx) {
            return;
        }
        self.pending_add += 1;
        self.pump_add(cx);
    }
    fn pump_add(&mut self, cx: &mut Context<Self>) {
        if self.add_failed
            || self.pending_add == 0
            || self.adding
            || self.rows.values().any(|r| r.writing)
        {
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
        let worker = lib.clone();
        let (job, ticket) = settlement::write(&lib, cx, async move {
            worker.run::<PatchPut>(
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
            if this
                .update(cx, |v, cx| {
                    v.adding = false;
                    match result {
                        Ok(_) => {
                            v.read_epoch += 1;
                            v.reload(cx);
                        }
                        Err(e) => {
                            log::warn!("new patch: {e}");
                            v.pending_add += 1;
                            v.add_failed = true;
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
                .is_ok()
            {
                ticket.acknowledge();
            }
        })
        .detach();
    }
    fn remove(&mut self, id: &str, cx: &mut Context<Self>) {
        self.remove_draft(id, false, cx);
    }
    fn remove_draft(&mut self, id: &str, retry: bool, cx: &mut Context<Self>) {
        if !settlement::accepts(cx) {
            return;
        }
        let target = self.target();
        let Some(row) = self.rows.get_mut(id) else {
            return;
        };
        if row.writing || (row.error && !retry) {
            return;
        }
        row.removing = true;
        row.writing = true;
        row.error = false;
        let base = row.stored.clone();
        let (lib, id) = (self.host.page.library.clone(), id.to_owned());
        let (worker, patch_id) = (lib.clone(), id.clone());
        let (job, ticket) = settlement::write(&lib, cx, async move {
            guarded::remove_patch(&worker, target, patch_id, base, retry)
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            if this
                .update(cx, |v, cx| {
                    match result {
                        Ok(()) => {
                            v.rows.remove(&id);
                            v.records.retain(|r| r.id != id);
                            v.read_epoch += 1;
                            v.reload(cx);
                        }
                        Err(e) => {
                            log::warn!("remove patch: {e}");
                            if let Some(row) = v.rows.get_mut(&id) {
                                row.writing = false;
                                row.error = true;
                            }
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
            let is_saved = self.records.iter().any(|p| p.id == id);
            let row_focused = row.title.focus_handle(cx).is_focused(window)
                || row.body.focus_handle(cx).is_focused(window);
            let title_focus = row.title.focus_handle(cx);
            let patch_group = SharedString::from(format!("patch-row-{id}"));
            let patch_comments = if is_saved {
                self.host
                    .page
                    .book
                    .v3()
                    .map(|b| b.patch_comments(&self.host.entry, &self.host.module.id, &id))
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            let patch_ul = dr_shell::comment_underline(
                SharedString::from(format!("patch-ul-{id}")),
                patch_comments,
                self.host.page.workspace.clone(),
                cx,
            );
            let theme = dr_ui::Theme::of(window, cx);
            let comment_btn = is_saved.then(|| {
                let ws = self.host.page.workspace.clone();
                let entry = self.host.entry.clone();
                let module = self.host.module.id.clone();
                let pid = id.clone();
                let ret = title_focus.clone();
                let label = t(cx, dr_i18n::keys::v3_review::WRITE_COMMENT);
                div()
                    .id(SharedString::from(format!("patch-comment-{id}")))
                    .size(px(20.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(3.0))
                    .cursor_pointer()
                    .role(gpui::Role::Button)
                    .aria_label(label)
                    .map(|el| {
                        if row_focused {
                            el
                        } else {
                            el.invisible()
                                .group_hover(patch_group.clone(), |st| st.visible())
                        }
                    })
                    .hover(|st| st.bg(theme.palette.ink(1).alpha(0.05)))
                    .on_click(move |e, window, cx| {
                        cx.stop_propagation();
                        if let Some(ws) = ws.upgrade() {
                            let pos = e.position();
                            let entry = entry.clone();
                            let module = module.clone();
                            let pid = pid.clone();
                            let ret = ret.clone();
                            ws.update(cx, |ws, cx| {
                                ws.open_part_composer(
                                    &entry,
                                    &module,
                                    dr_workspace::dto::CommentPartDto::Patch { patch: pid },
                                    Some(pos),
                                    Some(ret),
                                    window,
                                    cx,
                                );
                            });
                        }
                    })
                    .child(dr_ui::sand::icon(
                        dr_ui::sand::Icon::CommentPlus,
                        12.0,
                        theme.palette.ink(4).solid(),
                    ))
            });
            let ws_action = self.host.page.workspace.clone();
            let entry_action = self.host.entry.clone();
            let mod_action = self.host.module.id.clone();
            let pid_action = id.clone();
            let focus_action = title_focus;
            let retry_id = id.clone();
            list = list.child(
                div()
                    .id(patch_group.clone())
                    .group(patch_group)
                    .on_action(move |_: &dr_shell::NewComment, window, cx| {
                        if !is_saved {
                            return;
                        }
                        cx.stop_propagation();
                        if let Some(ws) = ws_action.upgrade() {
                            let entry = entry_action.clone();
                            let module = mod_action.clone();
                            let pid = pid_action.clone();
                            let ret = focus_action.clone();
                            ws.update(cx, |ws, cx| {
                                ws.open_part_composer(
                                    &entry,
                                    &module,
                                    dr_workspace::dto::CommentPartDto::Patch { patch: pid },
                                    None,
                                    Some(ret),
                                    window,
                                    cx,
                                );
                            });
                        }
                    })
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_start()
                            .gap_2()
                            .child(
                                div()
                                    .id(SharedString::from(format!("patch-title-group-{id}")))
                                    .role(gpui::Role::Group)
                                    .aria_label(t(cx, dr_i18n::keys::k4_pages::TITLE))
                                    .flex_1()
                                    .min_w_0()
                                    .child(row.title.clone())
                                    .children(patch_ul),
                            )
                            .children(comment_btn),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("patch-body-group-{id}")))
                            .role(gpui::Role::Group)
                            .aria_label(t(cx, dr_i18n::keys::k4_pages::BODY))
                            .child(row.body.clone()),
                    )
                    .children(
                        source.map(|s| div().text_color(theme.palette.ink(3).solid()).child(s)),
                    )
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
            (self.error || self.add_failed).then(|| t(cx, dr_i18n::keys::k4_pages::SAVE_FAILED)),
        )
        .children(self.add_failed.then(|| {
            Button::new(
                "retry-new-patch",
                t(cx, dr_i18n::keys::markdown_share::RETRY),
            )
            .on_click(cx.listener(|v, _, _, cx| {
                if settlement::accepts(cx) {
                    v.add_failed = false;
                    v.pump_add(cx);
                }
            }))
        }))
    }
}

impl Drafts for Patches {
    fn drain(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Drain {
        for id in self.rows.keys().cloned().collect::<Vec<_>>() {
            self.save(&id, cx);
        }
        self.pump_add(cx);
        if self.reading || self.adding || self.rows.values().any(|r| r.writing) {
            return Drain::Pending;
        }
        if self.add_failed
            || self.pending_add != 0
            || self.rows.values().any(|r| r.error || r.dirty || r.removing)
        {
            return Drain::Failed(t(cx, dr_i18n::keys::k4_pages::SAVE_FAILED).to_string());
        }
        Drain::Ready
    }
}

#[cfg(test)]
impl Patches {
    pub(crate) fn release_test_refresh(
        &mut self,
        book: std::rc::Rc<dr_shell::book::Book>,
        cx: &mut Context<Self>,
    ) {
        self.host.page.book = book;
        self.reload(cx);
    }
    pub(crate) fn release_test_input(&self) -> Option<Entity<TextArea>> {
        self.rows.get("release-record").map(|r| r.body.clone())
    }
    pub(crate) fn release_test_retry(&mut self, cx: &mut Context<Self>) {
        self.save_draft("release-record", true, cx);
    }
}
