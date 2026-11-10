//! The temporary M30 surface lives in the companion until the project-home
//! owner supplies a placement contract. It adds no model tools.
use super::*;
use crate::controller::{TaskView, proactive::Suggestions};
use dr_agent::proactive::CardStatus;
use dr_i18n::keys;
use dr_shell::Settings;

const PROACTIVE: &str = "agent.proactive_suggestions";
#[derive(Default)]
pub(super) struct Continuity {
    pub task: Option<TaskView>,
    pub suggestions: Option<Suggestions>,
    pub project: Option<Entity<crate::project_memory::ProjectMemoryView>>,
    pub working: Option<Entity<crate::working_memory::WorkingMemoryView>>,
    pub shown: Option<bool>,
}

pub(super) fn enabled(cx: &App) -> bool {
    Settings::device_memory(cx, PROACTIVE)
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

impl AgentPanel {
    pub(super) fn trigger_suggestions(&self, cx: &Context<Self>) {
        let (Some(controller), Some(book)) = (&self.controller, &self.book) else {
            return;
        };
        controller.set_proactive_enabled(enabled(cx));
        if !enabled(cx)
            || self
                .ws
                .upgrade()
                .is_none_or(|ws| !ws.read(cx).companion_visible(cx.entity_id()))
        {
            return;
        }
        let config = self.connections.read(cx).run_config().ok();
        // Controller accepts/owns this operation before returning its waiter.
        drop(controller.trigger_suggestions(
            book.clone(),
            config,
            chrono::Utc::now().timestamp_millis(),
        ));
    }

    pub(super) fn close_memory(&mut self, cx: &mut Context<Self>) {
        if let Some(view) = self.continuity.project.take() {
            view.update(cx, |v, cx| v.close(cx));
        }
        if let Some(view) = self.continuity.working.take() {
            view.update(cx, |v, cx| v.close(cx));
        }
        self.continuity.shown = None;
    }

    fn memory(&mut self, working: bool, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(controller), Some(book)) = (self.controller.clone(), self.book.clone()) else {
            return;
        };
        if working {
            if self.continuity.working.is_none() {
                self.continuity.working = Some(cx.new(|cx| {
                    crate::working_memory::WorkingMemoryView::new(controller, book, window, cx)
                }));
            }
        } else if self.continuity.project.is_none() {
            self.continuity.project = Some(cx.new(|cx| {
                crate::project_memory::ProjectMemoryView::new(controller, book, window, cx)
            }));
        }
        self.continuity.shown = Some(working);
        cx.notify();
    }

    fn resume(&mut self, cx: &mut Context<Self>) {
        let (Some(controller), Some(task), Some(conversation)) = (
            self.controller.clone(),
            self.continuity.task.as_ref(),
            self.selected.clone(),
        ) else {
            return;
        };
        let mut config = match self.connections.read(cx).run_config() {
            Ok(c) => c,
            Err(e) => {
                self.error = Some(e.to_string());
                return;
            }
        };
        config.system_prompt =
            crate::prompt::system_prompt(task.snapshot.book.as_str(), &self.name);
        let pending =
            controller.resume_job(conversation, task.snapshot.chain.clone(), config, None);
        self.busy = true;
        let generation = self.generation;
        cx.spawn(async move |this, cx| {
            let result = pending.await;
            let _ = this.update(cx, |panel, cx| {
                if panel.generation == generation {
                    panel.busy = false;
                    panel.error = result.err();
                    panel.refresh(cx);
                }
            });
        })
        .detach();
        cx.notify();
    }

    fn suggestion(&mut self, card: String, skip: bool, cx: &mut Context<Self>) {
        let (Some(controller), Some(book)) = (self.controller.clone(), self.book.clone()) else {
            return;
        };
        let now = chrono::Utc::now().timestamp_millis();
        let job: BoxFuture<'static, Result<Option<ConversationId>, String>> = if skip {
            let task = controller.dismiss_suggestion(book, card);
            Box::pin(async move { task.await.map(|_| None) })
        } else {
            let mut config = match self.connections.read(cx).run_config() {
                Ok(c) => c,
                Err(e) => {
                    self.error = Some(e.to_string());
                    return;
                }
            };
            config.system_prompt = crate::prompt::system_prompt(book.as_str(), &self.name);
            let task = controller.open_suggestion(book, card, config, now);
            Box::pin(async move { task.await.map(Some) })
        };
        self.busy = true;
        let generation = self.generation;
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |panel, cx| {
                if panel.generation != generation {
                    return;
                }
                panel.busy = false;
                match result {
                    Ok(Some(id)) => panel.select_conversation(id, cx),
                    Ok(None) => {}
                    Err(e) => panel.error = Some(e),
                }
                panel.refresh(cx);
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn continuity_header(&self, cx: &mut Context<Self>) -> AnyElement {
        let mut row = div().flex().flex_wrap().gap(px(6.));
        row = row
            .child(
                Button::new("agent-project-memory", t(cx, keys::project_memory::TITLE))
                    .text()
                    .small()
                    .on_click(cx.listener(|p, _, w, cx| p.memory(false, w, cx))),
            )
            .child(
                Button::new("agent-working-memory", t(cx, k::working_memory::TITLE))
                    .text()
                    .small()
                    .on_click(cx.listener(|p, _, w, cx| p.memory(true, w, cx))),
            );
        if self.continuity.shown.is_some() {
            row = row.child(
                Button::new("agent-memory-back", t(cx, keys::common::CANCEL))
                    .text()
                    .small()
                    .on_click(cx.listener(|p, _, _, cx| {
                        p.close_memory(cx);
                        cx.notify();
                    })),
            );
        }
        row.into_any_element()
    }

    pub(super) fn suggestion_cards(&self, cx: &mut Context<Self>) -> AnyElement {
        let on = enabled(cx);
        let panel = cx.weak_entity();
        let mut column = div().flex().flex_col().gap(px(8.)).child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(t(cx, keys::project_home::settings::PROACTIVE))
                .child(
                    dr_ui::components::Switch::new("agent-proactive", on).on_change(
                        move |on, _, cx| {
                            Settings::set_device_memory(cx, PROACTIVE, Some(json!(on)));
                            let _ = panel.update(cx, |p, cx| {
                                if let Some(c) = &p.controller {
                                    c.set_proactive_enabled(on);
                                }
                                p.trigger_suggestions(cx);
                                p.refresh(cx);
                            });
                        },
                    ),
                ),
        );
        if !on {
            return column.into_any_element();
        }
        let Some(suggestions) = &self.continuity.suggestions else {
            return column.into_any_element();
        };

        for (i, stored) in suggestions
            .state
            .cards
            .iter()
            .filter(|c| c.status == CardStatus::Open)
            .enumerate()
        {
            let open = stored.card.id.clone();
            let dismiss = open.clone();
            column = column.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(3.))
                    .child(
                        div()
                            .flex()
                            .gap(px(4.))
                            .child(
                                Button::new(("agent-suggestion", i), stored.card.title.clone())
                                    .text()
                                    .disabled(self.busy)
                                    .on_click(cx.listener(move |p, _, _, cx| {
                                        p.suggestion(open.clone(), false, cx)
                                    })),
                            )
                            .child(
                                Button::new(("agent-suggestion-dismiss", i), "×")
                                    .text()
                                    .disabled(self.busy)
                                    .on_click(cx.listener(move |p, _, _, cx| {
                                        p.suggestion(dismiss.clone(), true, cx)
                                    })),
                            ),
                    )
                    .child(text::wrapped(stored.card.detail.clone())),
            );
        }
        column.into_any_element()
    }

    pub(super) fn continuation_card(&self, cx: &mut Context<Self>) -> AnyElement {
        let mut row = div().flex().flex_col().gap(px(5.));
        let resumable = self.active().is_none()
            && self.continuity.task.as_ref().is_some_and(|task| {
                task.snapshot
                    .plan
                    .as_ref()
                    .is_some_and(|p| !p.status.terminal())
                    || self
                        .snapshot
                        .as_ref()
                        .and_then(|s| s.runs.last())
                        .is_some_and(|r| {
                            matches!(
                                r.state,
                                State::Checkpointed
                                    | State::Stopped
                                    | State::Aborted
                                    | State::Interrupted
                                    | State::Failed
                            )
                        })
            });
        if resumable {
            row = row.child(t(cx, k::slice::PAUSED)).child(
                Button::new("agent-resume", t(cx, k::budget::CONTINUE))
                    .text()
                    .disabled(self.busy)
                    .on_click(cx.listener(|p, _, _, cx| p.resume(cx))),
            );
        }
        row.into_any_element()
    }
}
