//! The controller owns every accepted suggestion operation through its real
//! worker completion, including callers that disappear before the reply.
use super::*;
use dr_agent::{Cancellation, RunConfig, proactive::*};
use dr_model::id::new_uuid_v7;

#[derive(Clone, Debug)]
pub struct Suggestions {
    pub state: ProactiveState,
    pub enabled: bool,
}

struct Job {
    controller: AgentController,
    lease: ReadLease,
    book: BookId,
    cancel: Cancellation,
}
impl Job {
    fn ws(&self) -> &Workspace {
        &self.lease.resources().workspace
    }
    fn allowed(&self) -> bool {
        !self.cancel.is_cancelled() && {
            let state = self.controller.inner.state.lock().expect("Agent service");
            state.resources.is_some() && state.proactive_enabled
        }
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        self.controller
            .inner
            .state
            .lock()
            .expect("Agent service")
            .suggestion_jobs
            .remove(&self.book);
        self.controller.inner.notify();
    }
}

fn background<T: Send + 'static>(
    job: Result<Job, String>,
    run: impl FnOnce(&Job) -> Result<T, String> + Send + 'static,
) -> BoxFuture<'static, Result<T, String>> {
    let job = match job {
        Ok(job) => job,
        Err(error) => return async move { Err(error) }.boxed(),
    };
    let (send, receive) = oneshot::channel();
    let spawned = std::thread::Builder::new()
        .name("agent-suggestions".into())
        .spawn(move || {
            let result = run(&job);
            drop(job);
            let _ = send.send(result);
        });
    async move {
        spawned.map_err(string)?;
        receive
            .await
            .map_err(|_| "suggestion worker ended before acknowledgement".to_owned())?
    }
    .boxed()
}

struct CheckinProject {
    name: String,
    titles: Vec<String>,
    todos: Vec<String>,
    guidance: Option<dr_agent::context::Contribution>,
}

fn checkin_project(ws: &Workspace, book: &BookId) -> Result<CheckinProject, String> {
    let doc = format!("book:{book}");
    for _ in 0..3 {
        let before = ws.version(&doc).map_err(string)?;
        let copy = ws.library().load_copy(&doc).map_err(string)?;
        if dr_doc::v3::is_v3_doc(&copy) {
            let borrowed = dr_doc::v3::BorrowedBookV3::new(&copy, book).map_err(string)?;
            let view = borrowed.view();
            if view.trashed_at().is_some() {
                return Err("book is unavailable".into());
            }
            let structure = dr_agent_tools::StructureContext::from_v3_view(
                Some(ws.library()),
                &view,
                &before,
                None,
            )
            .map_err(string)?;
            let result = CheckinProject {
                name: view.meta().name,
                titles: structure
                    .roots
                    .iter()
                    .map(|entry| entry.title.clone())
                    .collect(),
                todos: view
                    .comments()
                    .into_iter()
                    .filter(|c| c.is_todo() && c.status.as_str() == "open")
                    .map(|c| format!("{}: {}", c.id, c.body))
                    .collect(),
                guidance: Some(structure.to_contribution().map_err(string)?),
            };
            if before == ws.version(&doc).map_err(string)? {
                return Ok(result);
            }
        } else {
            return Err("canonical v3 book required".into());
        }
    }
    Err("book structure changed while preparing suggestions; read again".into())
}

impl AgentController {
    pub fn set_proactive_enabled(&self, enabled: bool) {
        let mut state = self.inner.state.lock().expect("Agent service");
        state.proactive_enabled = enabled;
        if !enabled {
            for cancel in state.suggestion_jobs.values() {
                cancel.cancel();
            }
        }
        drop(state);
        self.inner.notify();
    }
    fn suggestion_job(&self, book: BookId) -> Result<Job, String> {
        let mut state = self.inner.state.lock().expect("Agent service");
        let resources = state.resources.as_ref().ok_or_else(closed)?.clone();
        if state.suggestion_jobs.contains_key(&book) {
            return Err("suggestion operation already running".into());
        }
        let cancel = Cancellation::default();
        state.suggestion_jobs.insert(book.clone(), cancel.clone());
        resources.reads.enter();
        Ok(Job {
            controller: self.clone(),
            lease: ReadLease {
                tracker: resources.reads.clone(),
                resources: Some(resources),
            },
            book,
            cancel,
        })
    }

    /// Local read only. It never changes cooldown or dispatches a model.
    pub fn suggestions(&self, book: &BookId, _now_ms: i64) -> Result<Suggestions, String> {
        let enabled = self
            .inner
            .state
            .lock()
            .expect("Agent service")
            .proactive_enabled;
        self.with_workspace_read(|ws| {
            let state = ProactiveStore::load(ws.library(), book).map_err(string)?;
            Ok(Suggestions { state, enabled })
        })
    }

    /// Called on Home open/focus and after successful organize settlement.
    /// Reservation occurs now; view cancellation cannot orphan the worker.
    pub fn trigger_suggestions(
        &self,
        book: BookId,
        config: Option<RunConfig>,
        now_ms: i64,
    ) -> BoxFuture<'static, Result<(), String>> {
        background(self.suggestion_job(book), move |job| {
            if !job.allowed() {
                return Ok(());
            }
            let ws = job.ws();
            let lib = ws.library();
            let book = &job.book;
            let previous = ProactiveStore::record_open(lib, book, now_ms).map_err(string)?;
            let state = ProactiveStore::load(lib, book).map_err(string)?;
            // Missing model and busy/cooldown paths never inspect manuscript
            // text or consume an attempt.
            if config.is_none()
                || state.active.is_some()
                || state
                    .last_attempt_ms
                    .is_some_and(|at| now_ms.saturating_sub(at) < CHECKIN_COOLDOWN_MS)
            {
                return Ok(());
            }
            let since = state
                .checkin_cursor
                .since_ms
                .or(state.last_checkin_ms)
                .unwrap_or(now_ms - 24 * 60 * 60 * 1000)
                .max(now_ms - CHECKIN_LOOKBACK_MS);
            let batch = collect_delta(
                lib,
                &DeltaRequest {
                    book: book.clone(),
                    since_ms: since,
                    captured_ms: now_ms,
                    mode: DeltaMode::AllProse,
                    cursor: state.checkin_cursor.clone(),
                    limit: CHECKIN_DOCUMENT_LIMIT,
                },
            )
            .map_err(string)?;
            let has_changes = !batch.documents.is_empty();
            let recent = if !has_changes
                && previous.is_some_and(|at| now_ms.saturating_sub(at) >= CHECKIN_AWAY_MS)
            {
                collect_delta(
                    lib,
                    &DeltaRequest {
                        book: book.clone(),
                        since_ms: now_ms - CHECKIN_LOOKBACK_MS,
                        captured_ms: now_ms,
                        mode: DeltaMode::AllProse,
                        cursor: DeltaCursor::default(),
                        limit: CHECKIN_DOCUMENT_LIMIT,
                    },
                )
                .map_err(string)?
            } else {
                DeltaBatch::default()
            };
            let CheckinDecision::Run(mode) = decide_checkin(CheckinEligibility {
                state: &state,
                now_ms,
                enabled: job.allowed(),
                model_ready: true,
                has_changes,
                has_recent_changes: !recent.documents.is_empty(),
                previous_opened_ms: previous,
            }) else {
                return Ok(());
            };
            let shown = if mode == CheckinMode::Resume {
                &recent
            } else {
                &batch
            };
            let project = checkin_project(ws, book)?;
            let memory = dr_agent::memory::project(ws, book).map_err(string)?;
            let working = dr_agent::memory::load(lib, book).map_err(string)?;
            let context = CheckinContext {
                book_name: project.name,
                now_ms,
                since_ms: since,
                mode,
                documents: shown.documents.clone(),
                project_memory: memory
                    .entries
                    .into_iter()
                    .filter(|m| m.active())
                    .map(|m| MemoryContext {
                        id: m.id.to_string(),
                        body: m.body,
                    })
                    .collect(),
                working_memory: (working.approx_tokens <= 20_000).then_some(working.content_md),
                open_todos: project.todos,
                entry_titles: project.titles,
            };
            if !job.allowed() {
                return Ok(());
            }
            let Some(ticket) = ProactiveStore::begin_checkin(
                lib,
                book,
                &SuggestionStart {
                    expected_revision: state.revision,
                    id: new_uuid_v7(),
                    now_ms,
                    enabled: job.allowed(),
                    coverage: batch.coverage,
                },
            )
            .map_err(string)?
            else {
                return Ok(());
            };
            let result = futures::executor::block_on(run_checkin_with_guidance(
                job.lease.resources().driver.clone(),
                CheckinInput {
                    book: book.clone(),
                    attempt_id: ticket.id.clone(),
                    config: Arc::new(config.expect("checked model")),
                    context,
                },
                job.cancel.clone(),
                project.guidance,
            ));
            match result {
                Ok(outcome) if job.allowed() => {
                    ProactiveStore::complete_checkin(lib, book, &ticket, &outcome)
                        .map_err(string)?;
                }
                Ok(_) => {
                    ProactiveStore::fail_checkin(lib, book, &ticket, "cancelled")
                        .map_err(string)?;
                }
                Err(_) => {
                    ProactiveStore::fail_checkin(
                        lib,
                        book,
                        &ticket,
                        "suggestion request did not complete",
                    )
                    .map_err(string)?;
                }
            }
            Ok(())
        })
    }

    pub fn dismiss_suggestion(
        &self,
        book: BookId,
        card: String,
    ) -> BoxFuture<'static, Result<(), String>> {
        background(self.suggestion_job(book), move |job| {
            ProactiveStore::dismiss_card(job.ws().library(), &job.book, &card).map_err(string)?;
            Ok(())
        })
    }

    pub fn open_suggestion(
        &self,
        book: BookId,
        card: String,
        config: RunConfig,
        _now_ms: i64,
    ) -> BoxFuture<'static, Result<ConversationId, String>> {
        background(self.suggestion_job(book), move |job| {
            if !job.allowed() {
                return Err("proactive suggestions are disabled".into());
            }
            let ws = job.ws();
            let lib = ws.library();
            let book = &job.book;
            let state = ProactiveStore::load(lib, book).map_err(string)?;

            if let Some(stored) = state.cards.iter().find(|c| c.card.id == card)
                && let CardStatus::Started { conversation } = &stored.status
            {
                return ConversationId::parse(conversation).map_err(string);
            }
            let claim = ProactiveStore::claim_card(lib, book, &card, &new_uuid_v7(), job.allowed())
                .map_err(string)?
                .ok_or("suggestion is no longer available")?;
            let conversation = ConversationId::new_v7();
            let started = if job.allowed() {
                job.controller.start(Start {
                    book: book.clone(),
                    conversation: conversation.clone(),
                    config,
                    input: claim.card.instruction.clone(),
                })
            } else {
                Err("suggestions disabled".into())
            };
            ProactiveStore::settle_card(
                lib,
                book,
                &claim,
                started.as_ref().ok().map(|_| conversation.as_str()),
            )
            .map_err(string)?;
            started?;
            Ok(conversation)
        })
    }
}
