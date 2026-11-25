//! Agent Fill mode ("Agent Rewind"): chronological visual timeline of past
//! Agent turns, edited targets, and direct Snapshot History rewind actions
//! shown beside the active chat when the right sidebar fills the workspace.

use std::collections::HashMap;

use dr_agent::ContentBlock;
use dr_i18n::keys;
use dr_i18n::keys::agent_panel as k;
use dr_shell::strings::{t, tf};
use dr_ui::{
    Theme,
    components::Button,
    fonts::{Role, weight},
    sand,
    style::DrStyled as _,
    tokens::radius,
};
use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};

use super::{AgentPanel, format_compact_tokens, format_duration_ms};
use crate::{
    data::{self, ChangeTarget},
    state::{MessageContent, RunSnapshot},
};

struct RewindTurn {
    index: usize,
    session: String,
    turn: u32,
    prompt: String,
    reply: String,
    duration: Option<String>,
    tool_count: usize,
    tokens: u64,
    targets: Vec<ChangeTarget>,
}

fn excerpt(raw: &str, max_chars: usize) -> String {
    let first_line = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let mut out: String = first_line.chars().take(max_chars).collect();
    if first_line.chars().count() > max_chars {
        out.push('…');
    }
    out
}

impl AgentPanel {
    fn rewind_turns(&self) -> Vec<RewindTurn> {
        let Some(snapshot) = &self.snapshot else {
            return Vec::new();
        };
        let runs_by_session: HashMap<&str, &RunSnapshot> = snapshot
            .runs
            .iter()
            .map(|r| (r.session.as_str(), r))
            .collect();

        // Collect chronological (session, turn) keys in order of appearance.
        let mut order: Vec<(String, u32)> = Vec::new();
        let mut prompts: HashMap<(String, u32), String> = HashMap::new();
        let mut replies: HashMap<(String, u32), String> = HashMap::new();

        for msg in &snapshot.messages {
            let key = (msg.session.clone(), msg.turn);
            if !order.contains(&key) {
                order.push(key.clone());
            }
            match &msg.content {
                MessageContent::User { text, .. } => {
                    let clean = dr_shell::review_agent::parse_comment_user_message(text)
                        .map(|(_, body)| if body.is_empty() { text.as_str() } else { body })
                        .unwrap_or(text.as_str());
                    prompts.entry(key).or_insert_with(|| excerpt(clean, 88));
                }
                MessageContent::Assistant { message } => {
                    let text = message
                        .blocks
                        .iter()
                        .find_map(|b| match b {
                            ContentBlock::Text { text, .. } if !text.trim().is_empty() => {
                                Some(text.as_str())
                            }
                            _ => None,
                        })
                        .unwrap_or("");
                    if !text.is_empty() {
                        replies.insert(key, excerpt(text, 108));
                    }
                }
                _ => {}
            }
        }
        for run in &snapshot.runs {
            let key = (run.session.clone(), run.turn);
            if !order.contains(&key) {
                order.push(key);
            }
        }

        order
            .into_iter()
            .enumerate()
            .map(|(idx, (session, turn))| {
                let run = runs_by_session.get(session.as_str()).copied();
                let targets = run
                    .map(|r| data::change_targets(r, turn))
                    .unwrap_or_default();
                let duration = run
                    .filter(|r| r.turn == turn)
                    .and_then(|r| r.started_ms.zip(r.finished_ms))
                    .filter(|(s, f)| f > s)
                    .map(|(s, f)| format_duration_ms((f - s) as u64));
                let tool_count = run
                    .filter(|r| r.turn == turn)
                    .map(|r| r.tools.len())
                    .unwrap_or(0);
                let tokens =
                    run.filter(|r| r.turn == turn)
                        .map(|r| {
                            let u = r.usage;
                            let inp = u.input_tokens.saturating_add(
                                if r.config.as_ref().is_some_and(|c| {
                                    c.route.provider == dr_agent::Provider::Anthropic
                                }) {
                                    u.cached_input_tokens.saturating_add(u.cache_write_tokens)
                                } else {
                                    0
                                },
                            );
                            inp.saturating_add(u.output_tokens)
                        })
                        .unwrap_or(0);
                let prompt = prompts.remove(&(session.clone(), turn)).unwrap_or_default();
                let reply = replies.remove(&(session.clone(), turn)).unwrap_or_default();
                RewindTurn {
                    index: idx + 1,
                    session,
                    turn,
                    prompt,
                    reply,
                    duration,
                    tool_count,
                    tokens,
                    targets,
                }
            })
            .collect()
    }

    /// Left timeline column rendered when the Agent panel enters Fill mode.
    pub(super) fn render_rewind_column(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let turns = self.rewind_turns();
        let total_edits: usize = turns.iter().map(|turn| turn.targets.len()).sum();

        // Conversation switcher pills (top strip).
        let mut conv_strip = div().flex().flex_row().flex_wrap().gap(px(5.0)).pt(px(6.0));
        for conv in self.conversations.iter().take(6) {
            let active = self.selected.as_ref() == Some(&conv.id);
            let conv_id = conv.id.clone();
            let raw_title = dr_shell::review_agent::clean_conversation_title(&conv.title);
            let title: SharedString = if raw_title.trim().is_empty() {
                t(cx, k::NEW_CONVERSATION)
            } else {
                excerpt(raw_title, 20).into()
            };
            conv_strip = conv_strip.child(
                div()
                    .id(SharedString::from(format!("agent-rewind-conv-{}", conv.id)))
                    .px(px(8.0))
                    .py(px(3.0))
                    .rounded(px(radius::SM))
                    .border_1()
                    .border_color(if active {
                        p.accent.alpha(0.45)
                    } else {
                        p.hairline()
                    })
                    .bg(if active {
                        p.accent.alpha(0.11)
                    } else {
                        p.paper.alpha(0.55)
                    })
                    .cursor_pointer()
                    .hover(|st| st.bg(p.ink(1).alpha(0.06)))
                    .font_role(Role::Ui)
                    .type_px(s.caption, s.line_caption)
                    .text_color(if active {
                        p.ink(1).solid()
                    } else {
                        p.ink(3).solid()
                    })
                    .child(title)
                    .on_click(cx.listener(move |panel, _, _, cx| {
                        panel.select_conversation(conv_id.clone(), cx);
                    })),
            );
        }

        let header = div()
            .flex_none()
            .px(px(14.0))
            .py(px(12.0))
            .border_b(px(0.5))
            .border_color(p.hairline())
            .flex()
            .flex_col()
            .gap(px(4.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .font_role(Role::Structure)
                            .weight(weight::SEMIBOLD)
                            .type_px(s.secondary, s.line_body)
                            .text_color(p.ink(1).solid())
                            .child(sand::icon(sand::Icon::Rotate, 13.0, p.accent.solid()))
                            .child(t(cx, keys::snapshot_history::TITLE)),
                    )
                    .child(
                        div()
                            .font_role(Role::Index)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(3).solid())
                            .child(if total_edits > 0 {
                                format!(
                                    "#{} · {} {}",
                                    turns.len(),
                                    total_edits,
                                    t(cx, k::TURN_CHANGES)
                                )
                            } else {
                                format!("#{}", turns.len())
                            }),
                    ),
            )
            .when(!self.conversations.is_empty(), |el| el.child(conv_strip));

        let mut timeline = div()
            .id("agent-rewind-timeline")
            .debug_selector(|| "agent-rewind-timeline".into())
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px(px(14.0))
            .py(px(12.0))
            .flex()
            .flex_col()
            .gap(px(10.0));

        if turns.is_empty() {
            timeline = timeline.child(
                div()
                    .py(px(24.0))
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(4).solid())
                    .child(t(cx, k::empty::START)),
            );
        } else {
            let last_idx = turns.len().saturating_sub(1);
            for (pos, item) in turns.into_iter().enumerate() {
                let has_changes = !item.targets.is_empty();
                let mut meta_parts: Vec<String> = Vec::new();
                if let Some(dur) = &item.duration {
                    meta_parts.push(tf(cx, k::usage::WORKED_FOR, &[("duration", dur)]).to_string());
                }
                if item.tool_count > 0 {
                    meta_parts.push(
                        tf(cx, k::usage::TOOLS_COUNT, &[("count", &item.tool_count)]).to_string(),
                    );
                }
                if item.tokens > 0 {
                    meta_parts.push(format_compact_tokens(item.tokens));
                }

                let mut targets_row = div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .items_center()
                    .gap(px(5.0))
                    .pt(px(4.0));

                for (t_idx, target) in item.targets.iter().enumerate() {
                    let doc = target.clone();
                    let label = self.change_target_label(target, cx);
                    targets_row = targets_row.child(
                        div()
                            .id(SharedString::from(format!(
                                "agent-rewind-open-{}-{}-{t_idx}",
                                item.session, item.turn
                            )))
                            .px(px(7.0))
                            .py(px(3.0))
                            .rounded(px(radius::SM))
                            .bg(p.page.solid())
                            .border_1()
                            .border_color(p.hairline())
                            .cursor_pointer()
                            .hover(|st| st.bg(p.ink(1).alpha(0.06)))
                            .font_role(Role::Ui)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(1).solid())
                            .child(label)
                            .on_click(cx.listener(move |panel, _, window, cx| {
                                panel.change(&doc, false, window, cx);
                            })),
                    );
                    if target.history.is_some() {
                        let history = target.clone();
                        targets_row = targets_row.child(
                            Button::new(
                                SharedString::from(format!(
                                    "agent-rewind-history-{}-{}-{t_idx}",
                                    item.session, item.turn
                                )),
                                t(cx, k::onboarding::HISTORY),
                            )
                            .small()
                            .text()
                            .on_click(cx.listener(
                                move |panel, _, window, cx| {
                                    panel.change(&history, true, window, cx);
                                },
                            )),
                        );
                    }
                }

                let card = div()
                    .flex_1()
                    .min_w_0()
                    .p(px(10.0))
                    .rounded(px(radius::MD))
                    .bg(p.paper.solid())
                    .border_1()
                    .border_color(if has_changes {
                        p.accent.alpha(0.28)
                    } else {
                        p.hairline()
                    })
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .justify_between()
                            .gap(px(6.0))
                            .font_role(Role::Index)
                            .type_px(s.caption, s.line_caption)
                            .child(
                                div()
                                    .weight(weight::MEDIUM)
                                    .text_color(if has_changes {
                                        p.accent.solid()
                                    } else {
                                        p.ink(2).solid()
                                    })
                                    .child(format!("#{}", item.index)),
                            )
                            .when(!meta_parts.is_empty(), |el| {
                                el.child(
                                    div()
                                        .text_color(p.ink(4).solid())
                                        .truncate()
                                        .child(meta_parts.join(" · ")),
                                )
                            }),
                    )
                    .when(!item.prompt.is_empty(), |el| {
                        el.child(
                            div()
                                .font_role(Role::Ui)
                                .weight(weight::MEDIUM)
                                .type_px(s.secondary, s.line_body)
                                .text_color(p.ink(1).solid())
                                .child(item.prompt),
                        )
                    })
                    .when(!item.reply.is_empty(), |el| {
                        el.child(
                            div()
                                .font_role(Role::Ui)
                                .type_px(s.caption, s.line_caption)
                                .text_color(p.ink(3).solid())
                                .child(item.reply),
                        )
                    })
                    .when(has_changes, |el| el.child(targets_row));

                // Outer timeline dot + hairline stem (never an inset card border).
                let stem = div()
                    .w(px(14.0))
                    .flex_none()
                    .flex()
                    .flex_col()
                    .items_center()
                    .pt(px(12.0))
                    .child(
                        div()
                            .size(px(8.0))
                            .rounded_full()
                            .border_1()
                            .border_color(if has_changes {
                                p.accent.solid()
                            } else {
                                p.ink(4).solid()
                            })
                            .bg(if has_changes {
                                p.accent.solid()
                            } else {
                                p.paper.solid()
                            }),
                    )
                    .when(pos < last_idx, |el| {
                        el.child(div().w(px(1.0)).flex_1().mt(px(4.0)).bg(p.hairline()))
                    });

                timeline = timeline.child(
                    div()
                        .id(SharedString::from(format!(
                            "agent-rewind-turn-{}-{}",
                            item.session, item.turn
                        )))
                        .flex()
                        .flex_row()
                        .items_stretch()
                        .gap(px(8.0))
                        .child(stem)
                        .child(card),
                );
            }
        }

        div()
            .id("agent-rewind-column")
            .debug_selector(|| "agent-rewind-column".into())
            .w(px(340.0))
            .flex_none()
            .h_full()
            .min_h_0()
            .border_r(px(0.5))
            .border_color(p.hairline())
            .bg(p.page.alpha(0.32))
            .flex()
            .flex_col()
            .child(header)
            .child(timeline)
            .into_any_element()
    }
}
