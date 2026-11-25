//! Connects M18's comment Agent handoff (`dr_shell::review_agent`) to M31's
//! [`AgentHub`] and [`Connections`].

use std::sync::Arc;

use dr_agent::Start;
use dr_model::id::{BookId, ConversationId};
use dr_shell::review_agent::{self, CommentAgentRequest, CommentAgentTracker};
use dr_workspace::{Actor, commands::comment::CommentUpdateIn};
use futures::{StreamExt as _, channel::mpsc};
use gpui::{App, AppContext as _, Context, Entity, Subscription, Task};

use crate::{
    connection::Connections,
    controller::{AgentController, Subscription as RunSubscription},
    hub::AgentHub,
    onboarding,
};

pub(crate) struct BridgeWatcher {
    hub: Entity<AgentHub>,
    tracker: Entity<CommentAgentTracker>,
    _run_sub: Option<RunSubscription>,
    _signal: Option<Task<()>>,
    _hub_sub: Option<Subscription>,
}

impl BridgeWatcher {
    fn new(
        hub: Entity<AgentHub>,
        tracker: Entity<CommentAgentTracker>,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut watcher = Self {
            hub: hub.clone(),
            tracker,
            _run_sub: None,
            _signal: None,
            _hub_sub: None,
        };
        watcher._hub_sub = Some(cx.observe(&hub, |this, _, cx| this.bind(cx)));
        watcher.bind(cx);
        watcher
    }

    fn bind(&mut self, cx: &mut Context<Self>) {
        self._run_sub = None;
        self._signal = None;
        let Some(controller) = self.hub.read(cx).controller.clone() else {
            return;
        };
        let (send, mut receive) = mpsc::unbounded();
        self._run_sub = Some(controller.subscribe(Arc::new(move || {
            let _ = send.unbounded_send(());
        })));
        self._signal = Some(cx.spawn(async move |this, cx| {
            while receive.next().await.is_some() {
                if this.update(cx, |w, cx| w.sync(cx)).is_err() {
                    break;
                }
            }
        }));
        self.sync(cx);
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        sync_tracker(&self.hub, &self.tracker, cx);
    }
}

fn sync_tracker(hub: &Entity<AgentHub>, tracker: &Entity<CommentAgentTracker>, cx: &mut App) {
    let Some(controller) = hub.read(cx).controller.clone() else {
        return;
    };
    if controller.is_closed() {
        return;
    }
    let keys = tracker.read(cx).tracked_keys();
    if keys.is_empty() {
        return;
    }
    let panels = crate::panels(cx);
    for (book_id, conv_str) in keys {
        let Ok(conv_id) = ConversationId::parse(&conv_str) else {
            continue;
        };
        let active = controller.is_conversation_active(&conv_id);
        let viewed_now = !active
            && panels.iter().any(|p| {
                p.read(cx)
                    .is_visibly_showing(p.entity_id(), &book_id, &conv_id, cx)
            });
        tracker.update(cx, |t, cx| {
            t.set_running(&book_id, &conv_str, active, viewed_now, cx)
        });
    }
}

pub(crate) fn install(
    hub: &Entity<AgentHub>,
    connections: &Entity<Connections>,
    cx: &mut App,
) -> Entity<BridgeWatcher> {
    let hub_dispatch = hub.clone();
    let connections_dispatch = connections.clone();
    let hub_query = hub.clone();
    let tracker = review_agent::register(
        Box::new(move |req: CommentAgentRequest, cx: &mut App| {
            if dr_shell::release::is_releasing(cx) {
                return Err("workspace is releasing".into());
            }
            let controller: AgentController = hub_dispatch
                .read(cx)
                .controller
                .clone()
                .ok_or_else(|| "Agent runtime is still starting".to_owned())?;
            let mut config = connections_dispatch
                .read(cx)
                .run_config()
                .map_err(|e| e.to_string())?;
            let book = BookId::parse(&req.book_id).map_err(|e| e.to_string())?;
            config.system_prompt = crate::prompt::system_prompt(book.as_str(), &req.book_name);
            let reused = req
                .existing_conversation
                .as_deref()
                .and_then(|s| ConversationId::parse(s).ok());
            let need_link = reused.is_none();
            let conversation = reused.unwrap_or_else(ConversationId::new_v7);
            let conv_str = conversation.to_string();
            let input = review_agent::format_user_message(&req);

            let tracker = review_agent::ensure_tracker(cx);
            tracker.update(cx, |t, cx| t.mark_dispatched(&req.book_id, &conv_str, cx));

            let hub_after = hub_dispatch.clone();
            let book_id = req.book_id.clone();
            let comment_id = req.comment_id.clone();
            let conv_link = conv_str.clone();
            let conv_finish = conv_str.clone();
            cx.spawn(async move |cx| {
                if need_link {
                    let update = CommentUpdateIn {
                        book: book_id.clone(),
                        id: comment_id,
                        body: None,
                        status: None,
                        agent_conversation: Some(Some(conv_link)),
                        target: None,
                    };
                    let link_res = controller
                        .workspace_job(move |ws| {
                            let val = serde_json::to_value(update).map_err(|e| e.to_string())?;
                            ws.call(&Actor::User, "comment.update", val)
                                .map(|_| ())
                                .map_err(|e| e.to_string())
                        })
                        .await;
                    if let Err(err) = link_res {
                        log::warn!("comment agent_conversation link failed: {err}");
                        cx.update(|cx| {
                            tracker.update(cx, |t, cx| t.finish_launch(&book_id, &conv_finish, cx));
                            sync_tracker(&hub_after, &tracker, cx);
                        });
                        return;
                    }
                }
                let run_res = if let Some(control) =
                    controller.active_control_for_conversation(&conversation)
                {
                    control.steer(input).await.map_err(|e| e.to_string())
                } else {
                    controller
                        .start_job(Start {
                            config,
                            book,
                            conversation,
                            input,
                        })
                        .await
                        .map(|_| ())
                };
                cx.update(|cx| {
                    tracker.update(cx, |t, cx| t.finish_launch(&book_id, &conv_finish, cx));
                    if run_res.is_ok() {
                        onboarding::note(cx, onboarding::Event::Sent);
                    }
                    sync_tracker(&hub_after, &tracker, cx);
                });
            })
            .detach();

            Ok(conv_str)
        }),
        Box::new(move |conv_str: &str, cx: &mut App| {
            let Ok(conv_id) = ConversationId::parse(conv_str) else {
                return false;
            };
            hub_query
                .read(cx)
                .controller
                .as_ref()
                .is_some_and(|c| !c.is_closed() && c.is_conversation_active(&conv_id))
        }),
        cx,
    );
    let hub_w = hub.clone();
    cx.new(|cx| BridgeWatcher::new(hub_w, tracker, cx))
}
