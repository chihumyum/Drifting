//! Automatic continuation is an in-memory author authorization, never a
//! durable permission. A terminal slice is inspected only after settlement.
use super::*;
use dr_agent::{
    ContinuationStart, ResumeStart, RunConfig,
    long_task::{ChainSnapshot, Continuation, Decision, Store},
};

pub(super) struct Authorization {
    pub id: String,
    pub enabled: bool,
    chain: Option<String>,
    fingerprint: Option<String>,
    stagnant: u8,
    pause: Option<String>,
}

#[derive(Clone, Debug)]
pub struct TaskView {
    pub snapshot: ChainSnapshot,
    pub decision: Decision,
    pub authorized: bool,
    pub pause: Option<String>,
}

pub(super) enum StartRequest {
    Author(Start),
    Resume {
        start: ResumeStart,
        conversation: ConversationId,
    },
    Automatic {
        start: ContinuationStart,
        conversation: ConversationId,
    },
}

impl StartRequest {
    fn conversation(&self) -> &ConversationId {
        match self {
            Self::Author(start) => &start.conversation,
            Self::Resume { conversation, .. } | Self::Automatic { conversation, .. } => {
                conversation
            }
        }
    }
    fn automatic(&self) -> bool {
        matches!(self, Self::Automatic { .. })
    }
    fn chain(&self) -> Option<&str> {
        match self {
            Self::Author(_) => None,
            Self::Resume { start, .. } => Some(&start.chain),
            Self::Automatic { start, .. } => Some(&start.chain),
        }
    }
}

pub(super) struct PendingStart {
    controller: AgentController,
    lease: ReadLease,
    request: StartRequest,
    authorization: String,
    reserved: bool,
}

impl Drop for PendingStart {
    fn drop(&mut self) {
        if !self.reserved {
            return;
        }
        self.controller
            .inner
            .state
            .lock()
            .expect("Agent service")
            .starting
            .remove(self.request.conversation());
    }
}

impl PendingStart {
    pub fn run(mut self) -> Result<String, String> {
        let conversation = self.request.conversation().clone();
        let automatic = self.request.automatic();
        let resources = self.lease.resources();
        if let Some(chain) = self.request.chain() {
            let snapshot = Store::new(resources.workspace.library().clone())
                .snapshot(chain)
                .map_err(string)?;
            if snapshot.conversation != conversation {
                return Err("request chain belongs to another conversation".into());
            }
        }
        {
            let state = self.controller.inner.state.lock().expect("Agent service");
            if state.resources.is_none()
                || !state
                    .authorizations
                    .get(&conversation)
                    .is_some_and(|auth| auth.id == self.authorization && auth.enabled)
            {
                return Err(closed());
            }
        }
        let handle = match &self.request {
            StartRequest::Author(start) => resources.runtime.start(start.clone()),
            StartRequest::Resume { start, .. } => resources.runtime.start_resume(start.clone()),
            StartRequest::Automatic { start, .. } => {
                resources.runtime.start_continuation(start.clone())
            }
        }
        .map_err(string)?;
        let session = handle.session.clone();
        let chain = Store::new(resources.workspace.library().clone())
            .chain_for_session(&session)
            .map_err(string);
        let mut state = self.controller.inner.state.lock().expect("Agent service");
        if chain.is_err()
            || state.resources.is_none()
            || !state
                .authorizations
                .get(&conversation)
                .is_some_and(|auth| auth.id == self.authorization && auth.enabled)
        {
            drop(state);
            futures::executor::block_on(async move {
                let _ = handle.control.abort().await;
                let _ = handle.finish().await;
            });
            return Err(chain.err().unwrap_or_else(closed));
        }
        state
            .authorizations
            .get_mut(&conversation)
            .expect("checked authorization")
            .chain = chain?;
        let (completed, wait) = oneshot::channel();
        let completion = async move {
            wait.await
                .map_err(|_| "Agent completion monitor stopped before settlement".to_owned())
        }
        .boxed()
        .shared();
        state.runs.insert(
            session.clone(),
            ActiveRun {
                conversation,
                control: handle.control.clone(),
                completion,
                authorization: self.authorization.clone(),
                automatic,
            },
        );
        state.starting.remove(self.request.conversation());
        self.reserved = false;
        resources
            .monitor
            .unbounded_send(WatchedRun { handle, completed })
            .map_err(|_| "Agent completion monitor is unavailable".to_owned())?;
        drop(state);
        self.controller.inner.notify();
        Ok(session)
    }
}

pub(super) fn spawn_start(
    pending: Result<PendingStart, String>,
) -> BoxFuture<'static, Result<String, String>> {
    let pending = match pending {
        Ok(pending) => pending,
        Err(error) => return async move { Err(error) }.boxed(),
    };
    let (send, receive) = oneshot::channel();
    let spawned = std::thread::Builder::new()
        .name("agent-start".into())
        .spawn(move || {
            let result = pending.run();
            let _ = send.send(result);
        });
    async move {
        spawned.map_err(string)?;
        receive
            .await
            .map_err(|_| "Agent startup ended before acknowledgement".to_owned())?
    }
    .boxed()
}

impl AgentController {
    pub(super) fn prepare_start(
        &self,
        request: StartRequest,
        replace: Option<(&str, &str)>,
    ) -> Result<PendingStart, String> {
        let conversation = request.conversation().clone();
        let mut state = self.inner.state.lock().expect("Agent service");
        let resources = state.resources.as_ref().ok_or_else(closed)?.clone();
        if state.starting.contains(&conversation)
            || state.runs.iter().any(|(id, run)| {
                run.conversation == conversation && replace.is_none_or(|(session, _)| session != id)
            })
        {
            return Err("this conversation already has a running turn".into());
        }
        let authorization = if let Some((session, authorization)) = replace {
            if !state
                .runs
                .get(session)
                .is_some_and(|run| run.authorization == authorization)
                || !state
                    .authorizations
                    .get(&conversation)
                    .is_some_and(|auth| auth.id == authorization && auth.enabled)
            {
                return Err("automatic continuation was revoked".into());
            }
            state.runs.remove(session);
            authorization.to_owned()
        } else {
            let id = dr_model::id::new_uuid_v7();
            state.authorizations.insert(
                conversation.clone(),
                Authorization {
                    id: id.clone(),
                    enabled: true,
                    chain: request.chain().map(str::to_owned),
                    fingerprint: None,
                    stagnant: 0,
                    pause: None,
                },
            );
            id
        };
        state.starting.insert(conversation);
        resources.reads.enter();
        Ok(PendingStart {
            controller: self.clone(),
            lease: ReadLease {
                tracker: resources.reads.clone(),
                resources: Some(resources),
            },
            request,
            authorization,
            reserved: true,
        })
    }

    pub fn resume_job(
        &self,
        conversation: ConversationId,
        chain: String,
        config: RunConfig,
        input: Option<String>,
    ) -> BoxFuture<'static, Result<String, String>> {
        spawn_start(self.prepare_start(
            StartRequest::Resume {
                start: ResumeStart {
                    chain,
                    config,
                    input,
                },
                conversation,
            },
            None,
        ))
    }

    /// Revoke before enqueueing Stop. Even the gap between settled slices is
    /// covered; dropping the returned acknowledgement cannot re-arm it.
    pub fn stop_conversation(
        &self,
        conversation: &ConversationId,
    ) -> BoxFuture<'static, dr_agent::Result<()>> {
        let mut state = self.inner.state.lock().expect("Agent service");
        if let Some(auth) = state.authorizations.get_mut(conversation) {
            auth.enabled = false;
            auth.pause = Some("author_stopped".into());
        }
        let requests = state
            .runs
            .values()
            .filter(|run| &run.conversation == conversation)
            .map(|run| run.control.stop_after_tool())
            .collect::<Vec<_>>();
        drop(state);
        self.inner.notify();
        async move {
            for result in join_all(requests).await {
                result?;
            }
            Ok(())
        }
        .boxed()
    }

    pub fn task_view(&self, session: &str) -> Result<Option<TaskView>, String> {
        let lease = self.read_lease()?;
        let store = Store::new(lease.resources().workspace.library().clone());
        if store.chain_for_session(session).map_err(string)?.is_none() {
            return Ok(None);
        }
        let Continuation {
            snapshot, decision, ..
        } = store.continuation(session).map_err(string)?;
        let state = self.inner.state.lock().expect("Agent service");
        let auth = state
            .authorizations
            .get(&snapshot.conversation)
            .filter(|auth| auth.chain.as_deref() == Some(&snapshot.chain));
        Ok(Some(TaskView {
            snapshot,
            decision,
            authorized: auth.is_some_and(|auth| auth.enabled),
            pause: auth.and_then(|auth| auth.pause.clone()),
        }))
    }

    pub(super) fn retire_run(&self, session: &str, pause: Option<String>) {
        let mut state = self.inner.state.lock().expect("Agent service");
        if let Some(run) = state.runs.remove(session)
            && let Some(auth) = state.authorizations.get_mut(&run.conversation)
            && auth.id == run.authorization
        {
            auth.enabled = false;
            if pause.is_some() {
                auth.pause = pause;
            }
        }
        drop(state);
        self.inner.notify();
    }

    pub(super) fn after_run(&self, session: &str) {
        let completed = self
            .inner
            .state
            .lock()
            .expect("Agent service")
            .runs
            .get(session)
            .map(|r| r.conversation.clone());
        let success = self
            .with_workspace_read(|ws| {
                let log = dr_agent::events(ws.library(), session, 0).map_err(string)?;
                let failed = log.iter().any(|r| matches!(&r.event, dr_agent::Event::ToolFinished { result } if result.status != dr_agent::ToolStatus::Success));
                Ok(!failed && log.iter().rev().find_map(|r| match r.event {
                    dr_agent::Event::StateChanged { state } => Some(state), _ => None,
                }) == Some(dr_agent::State::Completed))
            })
            .unwrap_or(false);
        let result = (|| {
            let lease = self.read_lease()?;
            let continuation = Store::new(lease.resources().workspace.library().clone())
                .continuation(session)
                .map_err(string)?;
            let (authorization, automatic) = {
                let state = self.inner.state.lock().expect("Agent service");
                let Some(run) = state.runs.get(session) else {
                    return Ok(None);
                };
                (run.authorization.clone(), run.automatic)
            };
            {
                let mut state = self.inner.state.lock().expect("Agent service");
                let Some(auth) = state
                    .authorizations
                    .get_mut(&continuation.snapshot.conversation)
                    .filter(|auth| auth.id == authorization && auth.enabled)
                else {
                    return Ok(None);
                };
                if !matches!(continuation.decision, Decision::Continue { .. })
                    || continuation.waited_user
                {
                    auth.enabled = false;
                    auth.pause = Some(match continuation.decision {
                        Decision::Continue { reason }
                        | Decision::Pause { reason }
                        | Decision::Off { reason } => reason,
                    });
                    return Ok(None);
                }
                if automatic && auth.fingerprint.as_ref() == Some(&continuation.fingerprint) {
                    auth.stagnant = auth.stagnant.saturating_add(1);
                } else {
                    auth.stagnant = 0;
                }
                auth.fingerprint = Some(continuation.fingerprint);
                if auth.stagnant >= 2 {
                    auth.enabled = false;
                    auth.pause = Some("no_progress".into());
                    return Ok(None);
                }
            }
            let request = StartRequest::Automatic {
                start: ContinuationStart {
                    chain: continuation.snapshot.chain,
                    config: continuation.snapshot.config,
                },
                conversation: continuation.snapshot.conversation,
            };
            let next = self.prepare_start(request, Some((session, &authorization)))?;
            drop(lease);
            next.run().map(Some)
        })();
        match result {
            Ok(Some(_)) => {}
            Ok(None) => self.retire_run(session, None),
            Err(error) => self.retire_run(session, Some(error)),
        }
        if let Some(conversation) = completed {
            let active = self
                .inner
                .state
                .lock()
                .expect("Agent service")
                .runs
                .values()
                .any(|r| r.conversation == conversation);
            if !active {
                self.finish_organize(&conversation, success);
            }
        }
        self.inner.notify();
    }
}
