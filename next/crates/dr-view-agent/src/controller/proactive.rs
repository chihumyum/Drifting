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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SuggestionActivity {
    Checking,
    Starting,
    Other,
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum SuggestionStartError {
    #[error("suggestion is no longer available")]
    CardUnavailable,
    #[error("proactive suggestions are disabled")]
    Disabled,
    #[error("suggestion operation already running")]
    Busy,
    #[error("{0}")]
    Other(String),
}

impl From<String> for SuggestionStartError {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

/// A running suggestion operation as the service holds it. `cancel` reaches
/// the model request, which also cancels it on its own failures; `stopped`
/// is set only when the author stops it (主动建议 off, or the service
/// closing), so a stop is told apart from a failure (HC).
#[derive(Clone)]
pub(super) struct SuggestionStop {
    activity: SuggestionActivity,
    cancel: Cancellation,
    stopped: Cancellation,
}
impl SuggestionStop {
    pub(super) fn stop(&self) {
        self.stopped.cancel();
        self.cancel.cancel();
    }
}

struct Job {
    controller: AgentController,
    lease: ReadLease,
    book: BookId,
    cancel: Cancellation,
    stopped: Cancellation,
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
    /// The author stopped it: 主动建议 turned off, or the service closing.
    fn stopped(&self) -> bool {
        self.stopped.is_cancelled()
    }

    fn can_start(&self) -> Result<(), SuggestionStartError> {
        let state = self.controller.inner.state.lock().expect("Agent service");
        if state.resources.is_none() {
            return Err(closed().into());
        }
        if self.stopped() || !state.proactive_enabled {
            return Err(SuggestionStartError::Disabled);
        }
        Ok(())
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

fn background<T: Send + 'static, E: From<String> + Send + 'static>(
    job: Result<Job, E>,
    run: impl FnOnce(&Job) -> Result<T, E> + Send + 'static,
) -> BoxFuture<'static, Result<T, E>> {
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
    comments: Vec<String>,
    guidance: Option<dr_agent::context::Contribution>,
}

fn checkin_project(ws: &Workspace, book: &BookId) -> Result<CheckinProject, String> {
    if !ws.is_v3_book(book).map_err(string)? {
        return Err("a book of the current format is required".into());
    }
    let book_owned = book.clone();
    let lib = ws.library().clone();
    ws.read_book_v3(book.as_str(), move |doc, version| {
        let borrowed = dr_doc::v3::BorrowedBookV3::new(doc, &book_owned)
            .map_err(|e| dr_workspace::WsError::Invalid(e.to_string()))?;
        let view = borrowed.view();
        if view.trashed_at().is_some() {
            return Ok(Err("book is unavailable".to_owned()));
        }
        let structure =
            match dr_agent_tools::StructureContext::from_v3_view(Some(&lib), &view, &version, None)
            {
                Ok(s) => s,
                Err(e) => return Ok(Err(e.to_string())),
            };
        let guidance = match structure.to_contribution() {
            Ok(g) => g,
            Err(e) => return Ok(Err(e.to_string())),
        };
        Ok(Ok(CheckinProject {
            name: view.meta().name,
            titles: structure
                .roots
                .iter()
                .map(|entry| entry.title.clone())
                .collect(),
            comments: view
                .comments()
                .into_iter()
                .filter(|c| c.status == dr_model::kind::CommentStatus::Open)
                .map(|c| format!("{} [{}]: {}", c.id, c.origin.as_str(), c.body.text))
                .collect(),
            guidance: Some(guidance),
        }))
    })
    .map_err(string)?
}

impl AgentController {
    /// Wakes the views only when the value changes: every settings write
    /// hands it over again (HC).
    pub fn set_proactive_enabled(&self, enabled: bool) {
        let mut state = self.inner.state.lock().expect("Agent service");
        if state.proactive_enabled == enabled {
            return;
        }
        state.proactive_enabled = enabled;
        if !enabled {
            for job in state.suggestion_jobs.values() {
                job.stop();
            }
        }
        drop(state);
        self.inner.notify();
    }
    fn suggestion_job(
        &self,
        book: BookId,
        activity: SuggestionActivity,
    ) -> Result<Job, SuggestionStartError> {
        let mut state = self.inner.state.lock().expect("Agent service");
        let resources = state.resources.as_ref().ok_or_else(closed)?.clone();
        if let Some(running) = state.suggestion_jobs.get(&book) {
            return Err(if running.activity == SuggestionActivity::Starting {
                SuggestionStartError::Busy
            } else {
                "suggestion operation already running".to_owned().into()
            });
        }
        let stop = SuggestionStop {
            activity,
            cancel: Cancellation::default(),
            stopped: Cancellation::default(),
        };
        state.suggestion_jobs.insert(book.clone(), stop.clone());
        resources.reads.enter();
        drop(state);
        self.inner.notify();
        Ok(Job {
            controller: self.clone(),
            lease: ReadLease {
                tracker: resources.reads.clone(),
                resources: Some(resources),
            },
            book,
            cancel: stop.cancel,
            stopped: stop.stopped,
        })
    }

    pub(crate) fn suggestion_activity(&self, book: &BookId) -> Option<SuggestionActivity> {
        self.inner
            .state
            .lock()
            .expect("Agent service")
            .suggestion_jobs
            .get(book)
            .map(|job| job.activity)
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

    /// Called when Project Home comes to the front or the window comes back
    /// with it in front (HC). Reservation occurs now; view cancellation
    /// cannot orphan the worker.
    pub fn trigger_suggestions(
        &self,
        book: BookId,
        config: Option<RunConfig>,
        now_ms: i64,
    ) -> BoxFuture<'static, Result<(), String>> {
        let activity = if config.is_some() {
            SuggestionActivity::Checking
        } else {
            SuggestionActivity::Other
        };
        let job = self.suggestion_job(book, activity).map_err(string);
        background(job, move |job| {
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
                open_comments: project.comments,
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
                // 主动建议 turned off (or the app closing) while it looked:
                // the author's own stop is no failure, and the attempt
                // does not count against the 90 minutes (HC). A request
                // that failed cancelled itself, which is not a stop.
                _ if job.stopped() => {
                    ProactiveStore::cancel_checkin(lib, book, &ticket, state.last_attempt_ms)
                        .map_err(string)?;
                }
                Ok(outcome) if job.allowed() => {
                    ProactiveStore::complete_checkin(lib, book, &ticket, &outcome)
                        .map_err(string)?;
                }
                Ok(_) => {
                    ProactiveStore::cancel_checkin(lib, book, &ticket, state.last_attempt_ms)
                        .map_err(string)?;
                }
                Err(reason) => {
                    ProactiveStore::fail_checkin(lib, book, &ticket, reason).map_err(string)?;
                }
            }
            Ok(())
        })
    }

    /// Whether `conversation` of `book` is still there (a doc or a session
    /// of it): a card's 查看对话 opens nothing that is gone.
    pub fn has_conversation(
        &self,
        book: &BookId,
        conversation: &ConversationId,
    ) -> Result<bool, String> {
        self.with_workspace_read(|ws| {
            let lib = ws.library();
            let doc = DocId::Conversation(conversation.clone()).to_string();
            if let Some(info) = lib.doc_info(&doc).map_err(string)? {
                return Ok(
                    info.kind == "conversation" && info.book_id.as_deref() == Some(book.as_str())
                );
            }
            Ok(lib
                .agent_sessions(Some(book.as_str()))
                .map_err(string)?
                .iter()
                .any(|session| session.conversation == doc))
        })
    }

    pub fn dismiss_suggestion(
        &self,
        book: BookId,
        card: String,
    ) -> BoxFuture<'static, Result<(), String>> {
        background(
            self.suggestion_job(book, SuggestionActivity::Other)
                .map_err(string),
            move |job| {
                ProactiveStore::dismiss_card(job.ws().library(), &job.book, &card)
                    .map_err(string)?;
                Ok(())
            },
        )
    }

    pub fn open_suggestion(
        &self,
        book: BookId,
        card: String,
        config: RunConfig,
        _now_ms: i64,
    ) -> BoxFuture<'static, Result<ConversationId, SuggestionStartError>> {
        let job = self.suggestion_job(book, SuggestionActivity::Starting);
        background(job, move |job| {
            job.can_start()?;
            let ws = job.ws();
            let lib = ws.library();
            let book = &job.book;
            let state = ProactiveStore::load(lib, book).map_err(string)?;

            if let Some(stored) = state.cards.iter().find(|c| c.card.id == card)
                && let CardStatus::Started { conversation } = &stored.status
            {
                return ConversationId::parse(conversation)
                    .map_err(|error| SuggestionStartError::Other(error.to_string()));
            }
            let Some(claim) =
                ProactiveStore::claim_card(lib, book, &card, &new_uuid_v7(), job.allowed())
                    .map_err(string)?
            else {
                job.can_start()?;
                return Err(SuggestionStartError::CardUnavailable);
            };
            let conversation = ConversationId::new_v7();
            let started = job.can_start().and_then(|()| {
                job.controller
                    .start(Start {
                        book: book.clone(),
                        conversation: conversation.clone(),
                        config,
                        input: claim.card.instruction.clone(),
                    })
                    .map_err(Into::into)
            });
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
