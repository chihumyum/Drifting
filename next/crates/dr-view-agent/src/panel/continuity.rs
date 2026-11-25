//! M30 in the companion: Project Memory, working memory and resuming a
//! saved run. The suggestion cards are on Project Home (HC,
//! `crate::home_cards`); 主动建议 is in 设置 → 智能 → Agent. It adds no model
//! tools.
use super::*;
use crate::controller::TaskView;
use dr_i18n::keys;

#[derive(Default)]
pub(super) struct Continuity {
    pub task: Option<TaskView>,
    pub project: Option<Entity<crate::project_memory::ProjectMemoryView>>,
    pub working: Option<Entity<crate::working_memory::WorkingMemoryView>>,
    pub shown: Option<bool>,
}

impl AgentPanel {
    pub(super) fn close_memory(&mut self, cx: &mut Context<Self>) {
        if let Some(view) = self.continuity.project.take() {
            view.update(cx, |v, cx| v.close(cx));
        }
        if let Some(view) = self.continuity.working.take() {
            view.update(cx, |v, cx| v.close(cx));
        }
        self.continuity.shown = None;
        self.navigation.retain(|_, req| !req.project_memory);
    }

    pub(super) fn reveal_project_memory(
        &mut self,
        id: dr_model::id::MemoryId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<futures::channel::oneshot::Receiver<bool>> {
        self.memory(false, window, cx);
        let view = self.continuity.project.as_ref()?.clone();
        Some(view.update(cx, |v, cx| v.reveal(id, cx)))
    }

    fn memory(&mut self, working: bool, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(controller), Some(book)) = (self.controller.clone(), self.book.clone()) else {
            return;
        };
        if working {
            self.navigation.retain(|_, req| !req.project_memory);
            if let Some(project) = &self.continuity.project {
                project.update(cx, |v, cx| v.set_visible(false, cx));
            }
            if self.continuity.working.is_none() {
                self.continuity.working = Some(cx.new(|cx| {
                    crate::working_memory::WorkingMemoryView::new(controller, book, window, cx)
                }));
            } else if let Some(view) = &self.continuity.working {
                view.update(cx, |v, cx| v.set_visible(true, cx));
            }
        } else {
            if let Some(working_view) = &self.continuity.working {
                working_view.update(cx, |v, cx| v.set_visible(false, cx));
            }
            if self.continuity.project.is_none() {
                self.continuity.project = Some(cx.new(|cx| {
                    crate::project_memory::ProjectMemoryView::new(controller, book, window, cx)
                }));
            } else if let Some(view) = &self.continuity.project {
                view.update(cx, |v, cx| v.set_visible(true, cx));
            }
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

    pub(super) fn continuity_header(&self, cx: &mut Context<Self>) -> AnyElement {
        let mut row = div()
            .debug_selector(|| "agent-continuity".into())
            .flex()
            .flex_wrap()
            .gap(px(6.));
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

    pub(super) fn plan_card(&self, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let plan = self.continuity.task.as_ref()?.snapshot.plan.as_ref()?;
        if plan.steps.is_empty() {
            return None;
        }
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let completed = plan
            .steps
            .iter()
            .filter(|st| st.status == dr_agent::long_task::StepStatus::Completed)
            .count();
        let total = plan.steps.len();
        let mut card = div()
            .id("agent-plan-card")
            .debug_selector(|| "agent-plan-card".into())
            .flex()
            .flex_col()
            .gap(px(6.0))
            .p(px(10.0))
            .rounded(px(10.0))
            .bg(p.paper.solid())
            .border(px(0.5))
            .border_color(p.hairline())
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .min_w_0()
                            .child(
                                div()
                                    .font_role(Role::Index)
                                    .type_px(s.caption, s.line_caption)
                                    .text_color(p.accent.solid())
                                    .child(t(cx, k::todos::PLAN)),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .font_role(Role::Ui)
                                    .type_px(s.caption, s.line_caption)
                                    .text_color(p.ink(1).solid())
                                    .child(plan.objective.clone()),
                            ),
                    )
                    .child(
                        div()
                            .flex_none()
                            .font_role(Role::Index)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(3).solid())
                            .child(format!("{completed} / {total}")),
                    ),
            );
        for step in &plan.steps {
            let (icon, color) = match step.status {
                dr_agent::long_task::StepStatus::Completed => {
                    (sand::Icon::TaskDone, p.accent.solid())
                }
                dr_agent::long_task::StepStatus::InProgress => {
                    (sand::Icon::TaskDoing, p.accent.solid())
                }
                dr_agent::long_task::StepStatus::Pending => {
                    (sand::Icon::TaskTodo, p.ink(4).solid())
                }
                dr_agent::long_task::StepStatus::Blocked
                | dr_agent::long_task::StepStatus::Failed
                | dr_agent::long_task::StepStatus::Retired => {
                    (sand::Icon::StatusWarning, p.ink(3).solid())
                }
            };
            let note = step
                .note
                .as_deref()
                .map(str::trim)
                .filter(|n| !n.is_empty());
            card = card.child(
                div()
                    .flex()
                    .items_start()
                    .gap(px(6.0))
                    .min_w_0()
                    .child(
                        div()
                            .pt(px(2.0))
                            .flex_none()
                            .child(sand::icon(icon, 13.0, color)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .type_px(s.caption, s.line_caption)
                                    .text_color(
                                        if step.status == dr_agent::long_task::StepStatus::Completed
                                        {
                                            p.ink(3).solid()
                                        } else {
                                            p.ink(1).solid()
                                        },
                                    )
                                    .child(step.target.name.clone()),
                            )
                            .when_some(note, |el, n| {
                                el.child(
                                    div()
                                        .type_px((s.caption - 0.5).max(11.0), s.line_caption)
                                        .text_color(p.ink(4).solid())
                                        .child(n.to_owned()),
                                )
                            }),
                    ),
            );
        }
        Some(card.into_any_element())
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
