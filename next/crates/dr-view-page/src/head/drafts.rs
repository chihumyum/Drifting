//! V3 page-head inputs share the module save/release gate. Legacy heads keep
//! their frozen save path. A failed draft never acquires a new implicit base.
use super::*;
use crate::settlement::{self, Drafts, Drain};
use dr_workspace::{
    Actor, WritePreconditions, WsError,
    commands::v3::{module::In, types::FieldValue},
};

#[derive(Clone)]
struct Binding {
    target: In,
    field: String,
    base: FieldValue,
}
struct Draft {
    text: String,
    base: String,
    writing: bool,
    failed: bool,
    awaiting: bool,
}
impl Draft {
    fn new(value: &str) -> Self {
        Self {
            text: value.into(),
            base: value.into(),
            writing: false,
            failed: false,
            awaiting: false,
        }
    }
    fn dirty(&self) -> bool {
        self.text != self.base
    }
    fn refresh(&mut self, value: &str, focused: bool) -> bool {
        if self.awaiting && value == self.base {
            self.awaiting = false;
        }
        if self.writing || self.failed || self.dirty() || self.awaiting || focused {
            return false;
        }
        self.text = value.into();
        self.base = value.into();
        true
    }
}
pub(super) struct HeadDrafts {
    title: Draft,
    synopsis: Draft,
    binding: Option<Binding>,
}
impl HeadDrafts {
    pub(super) fn new(
        host: &PageHost,
        page: &PageInfo,
        fallback: Option<&dr_shell::book::Book>,
        cx: &gpui::App,
    ) -> Option<Self> {
        let (entry, _) = dr_editor::v3::body(&page.doc)?;
        let snapshot = host.workspace.upgrade().map(|ws| ws.read(cx).book.clone());
        let binding = snapshot.as_deref().or(fallback).and_then(|book| {
            let book = book.v3()?;
            let module = book
                .template_of(&entry)?
                .modules
                .iter()
                .find(|m| m.config.summary_field.is_some())?;
            let field = module.config.summary_field.clone()?;
            let base = book
                .entry(&entry)?
                .fields
                .get(&module.id)
                .and_then(|f| f.get(&field))
                .cloned()
                .unwrap_or(FieldValue::Null);
            Some(Binding {
                target: In {
                    book: host.book.clone(),
                    entry,
                    module: module.id.clone(),
                },
                field,
                base,
            })
        });
        Some(Self {
            title: Draft::new(&page.title),
            synopsis: Draft::new(&page.synopsis),
            binding,
        })
    }
    fn get(&self, summary: bool) -> &Draft {
        if summary { &self.synopsis } else { &self.title }
    }
    fn get_mut(&mut self, summary: bool) -> &mut Draft {
        if summary {
            &mut self.synopsis
        } else {
            &mut self.title
        }
    }
}
impl PageHead {
    pub(super) fn event_v3(
        &mut self,
        summary: bool,
        event: &FieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let input = if summary {
            self.synopsis.clone()
        } else {
            self.title.clone()
        };
        if !settlement::accepts(cx) {
            if matches!(event, FieldEvent::Changed(_)) {
                let text = self.drafts.as_ref().unwrap().get(summary).text.clone();
                input.update(cx, |f, cx| f.set_text(text, cx));
            }
            return;
        }
        match event {
            FieldEvent::Changed(value) => {
                self.drafts.as_mut().unwrap().get_mut(summary).text = value.clone()
            }
            FieldEvent::Blurred => self.save_v3(summary, false, cx),
            FieldEvent::Submitted(_) => {
                self.save_v3(summary, false, cx);
                if summary {
                    window.blur(cx);
                } else {
                    self.hand_over(window, cx);
                }
            }
            FieldEvent::Cancelled => {
                let value = if summary {
                    self.stored_synopsis.clone()
                } else {
                    self.stored_title.clone()
                };
                let draft = self.drafts.as_mut().unwrap().get_mut(summary);
                draft.text = value.clone();
                draft.failed = false;
                input.update(cx, |f, cx| f.set_text(value, cx));
                window.blur(cx);
            }
        }
        cx.notify();
    }
    pub(super) fn refresh_v3(
        &mut self,
        page: &PageInfo,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let state = self.drafts.as_mut().unwrap();
        if state
            .title
            .refresh(&page.title, self.title.focus_handle(cx).is_focused(window))
        {
            self.title
                .update(cx, |f, cx| f.set_text(page.title.clone(), cx));
        }
        if state.synopsis.refresh(
            &page.synopsis,
            self.synopsis.focus_handle(cx).is_focused(window),
        ) {
            self.synopsis
                .update(cx, |f, cx| f.set_text(page.synopsis.clone(), cx));
            if let Some(next) = HeadDrafts::new(&self.host, page, self.book.as_deref(), cx) {
                state.binding = next.binding;
            }
        }
        self.stored_title = page.title.clone();
        self.stored_synopsis = page.synopsis.clone();
        self.page = page.clone();
        self.refresh_group_path(cx);
        cx.notify();
    }
    fn save_v3(&mut self, summary: bool, retry: bool, cx: &mut Context<Self>) {
        if !settlement::accepts(cx) {
            return;
        }
        let state = self.drafts.as_mut().unwrap();
        let binding = state.binding.clone();
        let draft = state.get_mut(summary);
        if draft.writing || (!draft.dirty() && !draft.failed) || (draft.failed && !retry) {
            return;
        }
        let (sent, base) = (draft.text.clone(), draft.base.clone());
        draft.writing = true;
        draft.failed = false;
        let (lib, book, doc) = (
            self.host.library.clone(),
            self.host.book.clone(),
            self.page.doc.clone(),
        );
        let worker = lib.clone();
        let text = sent.clone();
        let (job, ticket) = settlement::write(&lib, cx, async move {
            let value = text.trim().to_string();
            if summary {
                let binding = binding.ok_or_else(|| {
                    WsError::Conflict(
                        "summary binding was unavailable when the input opened".into(),
                    )
                })?;
                settlement::field(
                    &worker,
                    binding.target,
                    binding.field,
                    binding.base,
                    FieldValue::Text(value.clone()),
                    retry,
                )?;
            } else {
                save_title(&worker, &book, &doc, &base, &value, retry)?;
            }
            Ok::<_, WsError>(value)
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            if this
                .update(cx, |head, cx| {
                    let state = head.drafts.as_mut().unwrap();
                    let draft = state.get_mut(summary);
                    draft.writing = false;
                    let mut again = false;
                    match result {
                        Ok(saved) => {
                            let untouched = draft.text == sent;
                            draft.base = saved.clone();
                            draft.awaiting = true;
                            if untouched {
                                draft.text = saved.clone();
                            }
                            again = draft.dirty();
                            if summary {
                                if let Some(binding) = state.binding.as_mut() {
                                    binding.base = FieldValue::Text(saved.clone());
                                }
                                head.stored_synopsis = saved.clone();
                            } else {
                                head.stored_title = saved.clone();
                            }
                            if untouched {
                                let input = if summary { &head.synopsis } else { &head.title };
                                input.update(cx, |f, cx| f.set_text(saved, cx));
                            }
                        }
                        Err(e) => {
                            log::warn!("v3 page-head save: {e}");
                            draft.failed = true;
                        }
                    }
                    if again {
                        head.save_v3(summary, false, cx);
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
    pub(super) fn errors_v3(&self, cx: &Context<Self>) -> gpui::Div {
        let mut errors = div();
        for summary in [false, true] {
            if self.drafts.as_ref().is_some_and(|s| s.get(summary).failed) {
                errors = errors.child(t(cx, keys::k4_pages::SAVE_FAILED)).child(
                    dr_ui::components::Button::new(
                        if summary {
                            "retry-page-synopsis"
                        } else {
                            "retry-page-title"
                        },
                        t(cx, keys::markdown_share::RETRY),
                    )
                    .on_click(cx.listener(move |v, _, _, cx| v.save_v3(summary, true, cx))),
                );
            }
        }
        errors
    }
}
impl Drafts for PageHead {
    fn drain(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Drain {
        self.save_v3(false, false, cx);
        self.save_v3(true, false, cx);
        let state = self.drafts.as_ref().unwrap();
        if state.title.writing || state.synopsis.writing {
            return Drain::Pending;
        }
        if state.title.failed
            || state.synopsis.failed
            || state.title.dirty()
            || state.synopsis.dirty()
        {
            return Drain::Failed(t(cx, keys::k4_pages::SAVE_FAILED).to_string());
        }
        Drain::Ready
    }
}
fn save_title(
    ws: &dr_workspace::Workspace,
    book: &str,
    doc: &str,
    base: &str,
    value: &str,
    retry: bool,
) -> Result<(), WsError> {
    if value.is_empty() {
        return Err(WsError::Invalid("title must not be empty".into()));
    }
    let (entry, _) =
        dr_editor::v3::body(doc).ok_or_else(|| WsError::Invalid("not a body document".into()))?;
    let observation = ws.observe(&format!("book:{book}"))?;
    let id = dr_model::id::EntryId::parse(&entry).map_err(|e| WsError::Invalid(e.to_string()))?;
    let raw = dr_editor::v3::read(ws, book, move |v| v.entry_owned_raw_state(&id))?
        .ok_or_else(|| WsError::Conflict("title owner was removed".into()))?;
    let current = raw["metadata"]["map"]["title"]
        .get("value")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| WsError::Conflict("title representation changed".into()))?;
    if !retry && current != base && current != value {
        return Err(WsError::Conflict("title changed while editing".into()));
    }
    ws.call_guarded(
        &Actor::User,
        "entry.update",
        serde_json::json!({"book":book,"id":entry,"title":value}),
        WritePreconditions::from_observations([observation]),
    )?;
    Ok(())
}
