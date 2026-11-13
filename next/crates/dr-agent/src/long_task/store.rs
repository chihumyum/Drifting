use std::collections::{BTreeMap, BTreeSet};

use dr_model::id::{BookId, new_uuid_v7};
use dr_store::{Library, LocalTx, StoreError};
use rusqlite::{Connection, OptionalExtension};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::json;

use super::types::*;
use crate::{
    Error, Event, Result, State, events,
    evidence::{self, ReadProof, WriteProof},
};

const CHAINS: &str = "agent.task.chains";
const MEMBERS: &str = "agent.task.members";
const PLANS: &str = "agent.task.plans";
const STEPS: &str = "agent.task.steps";
const CONSTRAINTS: &str = "agent.task.constraints";
const COMMANDS: &str = "agent.task.commands";
const READS: &str = "agent.task.reads";
const WRITES: &str = "agent.task.writes";

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::Invalid {
        what: "long task",
        value: message.into(),
    }
}
fn get<T: DeserializeOwned>(
    conn: &Connection,
    scope: &str,
    key: &str,
) -> dr_store::Result<Option<T>> {
    conn.query_row(
        "SELECT value FROM local_state WHERE scope=?1 AND key=?2",
        [scope, key],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(|raw| serde_json::from_str(&raw).map_err(|_| invalid("invalid stored task data")))
    .transpose()
}
fn rows<T: DeserializeOwned>(
    conn: &Connection,
    scope: &str,
    prefix: &str,
) -> dr_store::Result<Vec<T>> {
    let prefix = format!("{prefix}/");
    let raw = conn.prepare("SELECT value FROM local_state WHERE scope=?1 AND substr(key,1,length(?2))=?2 ORDER BY key")?
        .query_map([scope, &prefix], |r| r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    raw.into_iter()
        .map(|raw| serde_json::from_str(&raw).map_err(|_| invalid("invalid stored task data")))
        .collect()
}
fn put(
    tx: &mut LocalTx<'_>,
    scope: &str,
    key: &str,
    value: &impl Serialize,
    book: &BookId,
) -> dr_store::Result<()> {
    tx.set_state(
        scope,
        key,
        &serde_json::to_string(value).map_err(|_| invalid("invalid task data"))?,
        Some(book.as_str()),
    )
}
fn book_exists(conn: &Connection, book: &BookId) -> dr_store::Result<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM loro_doc WHERE doc_id=?1 AND kind='book')",
        [format!("book:{book}")],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(invalid("book is unavailable"));
    }
    Ok(())
}
fn check_version(conn: &Connection, doc: &str, expected: &str) -> dr_store::Result<()> {
    let current: Option<String> = conn
        .query_row(
            "SELECT lower(hex(frontiers)) FROM loro_head WHERE doc_id=?1",
            [doc],
            |r| r.get(0),
        )
        .optional()?;
    if current.as_deref() != Some(expected) {
        return Err(invalid(format!(
            "TASK_MANIFEST_DRIFT: {doc} changed; read again"
        )));
    }
    Ok(())
}

pub(crate) fn member(conn: &Connection, session: &str) -> dr_store::Result<Option<Member>> {
    get(conn, MEMBERS, session)
}

/// Called in the exact transaction creating the Agent session and Started row.
pub(crate) fn begin(
    tx: &mut LocalTx<'_>,
    session: &str,
    start: &crate::Start,
    mode: StartMode,
    chain: Option<&str>,
) -> dr_store::Result<String> {
    book_exists(tx, &start.book)?;
    let mut chain = match chain {
        None if mode == StartMode::Author => Chain {
            id: new_uuid_v7(),
            book: start.book.clone(),
            conversation: start.conversation.clone(),
            original_request: start.input.clone(),
            config: start.config.clone(),
        },
        Some(id) if mode != StartMode::Author => {
            get::<Chain>(tx, CHAINS, id)?.ok_or_else(|| invalid("request chain is unavailable"))?
        }
        _ => return Err(invalid("invalid request-chain start mode")),
    };
    if chain.book != start.book || chain.conversation != start.conversation {
        return Err(invalid(
            "request chain belongs to another book or conversation",
        ));
    }
    if member(tx, session)?.is_some() {
        return Err(invalid("session already belongs to a request chain"));
    }
    chain.config = start.config.clone();
    put(tx, CHAINS, &chain.id, &chain, &chain.book)?;
    put(
        tx,
        MEMBERS,
        session,
        &Member {
            chain: chain.id.clone(),
            session: session.into(),
            mode,
        },
        &chain.book,
    )?;
    Ok(chain.id)
}

pub(crate) fn persist_read(tx: &mut LocalTx<'_>, proof: &ReadProof) -> dr_store::Result<()> {
    let Some(member) = member(tx, &proof.session)? else {
        return Ok(());
    };
    let chain: Chain =
        get(tx, CHAINS, &member.chain)?.ok_or_else(|| invalid("request chain is unavailable"))?;
    book_exists(tx, &chain.book)?;
    put(
        tx,
        READS,
        &format!("{}/{}", chain.id, proof.id),
        proof,
        &chain.book,
    )
}
pub(crate) fn persist_writes(tx: &mut LocalTx<'_>, proof: &WriteProof) -> dr_store::Result<()> {
    let Some(member) = member(tx, &proof.session)? else {
        return Ok(());
    };
    let chain: Chain =
        get(tx, CHAINS, &member.chain)?.ok_or_else(|| invalid("request chain is unavailable"))?;
    book_exists(tx, &chain.book)?;
    put(
        tx,
        WRITES,
        &format!("{}/{}", chain.id, proof.id),
        proof,
        &chain.book,
    )
}

struct Canonical {
    version: String,
    manifest: Vec<ManifestEntry>,
    targets: Vec<Target>,
}
fn canonical(lib: &Library, book: &BookId) -> Result<Canonical> {
    let copy = lib.load_copy(&format!("book:{book}"))?;

    let borrowed = dr_doc::v3::BorrowedBookV3::new(&copy, book)?;
    let view = borrowed.view();
    let templates = view.templates_map();
    if view.trashed_at().is_some() {
        return Err(Error::Closed);
    }
    let ordered_entries = view.entries();
    let documents = lib.docs(Some(book.as_str()), None)?;
    let module_targets = |entry: &dr_model::v3::Entry| -> Vec<Target> {
        let template = entry.effective_template(&templates);
        let mut modules = Vec::new();
        if let Some(template) = template {
            modules.extend(
                template
                    .prose_modules()
                    .map(|m| (m.id.clone(), m.name.clone())),
            );
        }
        // A removed definition does not remove its persisted body. Keep the
        // original module identity instead of rebinding by a display name.
        for info in &documents {
            if let Ok(dr_model::DocId::Body(body)) = dr_model::DocId::parse(&info.doc_id)
                && body.entry() == &entry.id
                && !modules.iter().any(|(id, _)| id == body.module())
            {
                modules.push((body.module().clone(), body.module().to_string()));
            }
        }
        modules
            .into_iter()
            .map(|(module, name)| Target {
                kind: "module".into(),
                id: format!("{}/{}", entry.id, module),
                name: format!("{}/{}", entry.title, name),
                doc: Some(
                    dr_model::DocId::Body(dr_model::id::BodyDocId::new(entry.id.clone(), module))
                        .to_string(),
                ),
            })
            .collect()
    };
    // The book's text is the manuscript sequence: each entry's own book
    // prose before what lives under it (`BookStructureV3::manuscript`).
    let structure = view.structure_snapshot();
    let manuscript = structure.manuscript();
    let book_docs: BTreeSet<String> = manuscript
        .iter()
        .flat_map(|p| &p.entries)
        .flat_map(|e| e.prose.iter().map(|p| p.doc.to_string()))
        .collect();
    // Entries the sequence numbers also keep the prose an earlier template
    // left them, under its own module, as before the one kind of entry.
    let numbered: BTreeSet<&dr_model::id::EntryId> = manuscript
        .iter()
        .flat_map(|p| &p.entries)
        .filter(|e| e.ordinal.is_some())
        .map(|e| &e.entry.id)
        .collect();
    let mut manifest = Vec::new();
    let mut targets = Vec::new();
    for entry in ordered_entries.iter().filter(|e| !e.is_trashed()) {
        let modules = module_targets(entry);
        targets.push(Target {
            kind: "entry".into(),
            id: entry.id.to_string(),
            name: entry.title.clone(),
            // Multiple bodies require an explicit module, never the first.
            doc: (modules.len() == 1)
                .then(|| modules[0].doc.clone())
                .flatten(),
        });
        let defined: BTreeSet<String> = entry
            .effective_template(&templates)
            .into_iter()
            .flat_map(|t| t.modules.iter())
            .map(|m| format!("{}/{}", entry.id, m.id))
            .collect();
        for target in modules.iter().filter(|t| {
            if manuscript.is_empty() {
                entry.is_linkable(&templates)
            } else {
                t.doc.as_ref().is_some_and(|d| book_docs.contains(d))
                    || (numbered.contains(&entry.id) && !defined.contains(&t.id))
            }
        }) {
            manifest.push(ManifestEntry {
                target: target.clone(),
                ordinal: manifest.len(),
            });
        }
        targets.extend(modules);
    }
    for row in view.materials() {
        targets.push(Target {
            kind: "material".into(),
            id: row.id.to_string(),
            name: row.title,
            doc: Some(format!("material:{}", row.id)),
        });
    }
    Ok(Canonical {
        version: evidence::version(&copy.oplog_frontiers()),
        manifest,
        targets,
    })
}

fn drift(frozen: &[ManifestEntry], current: &[ManifestEntry]) -> ManifestState {
    let mut state = ManifestState::default();
    for entry in current {
        match frozen.iter().find(|old| old.target.id == entry.target.id) {
            None => state.added.push(entry.target.name.clone()),
            Some(old) => {
                if old.target.name != entry.target.name
                    || old.target.kind != entry.target.kind
                    || old.target.doc != entry.target.doc
                {
                    state.renamed.push(entry.target.name.clone());
                }
                if old.ordinal != entry.ordinal {
                    state.reordered.push(entry.target.name.clone());
                }
            }
        }
    }
    state.missing = frozen
        .iter()
        .filter(|old| !current.iter().any(|entry| entry.target.id == old.target.id))
        .map(|old| old.target.name.clone())
        .collect();
    state.drifted = !state.added.is_empty()
        || !state.missing.is_empty()
        || !state.renamed.is_empty()
        || !state.reordered.is_empty();
    state
}
fn target_key(target: &Target) -> String {
    target.doc.clone().unwrap_or_else(|| target.key())
}
fn new_step(target: Target, ordinal: usize) -> Step {
    Step {
        id: new_uuid_v7(),
        target,
        status: StepStatus::Pending,
        ordinal,
        started_ms: None,
        finished_ms: None,
        note: None,
        evidence: None,
        review: None,
        review_version: None,
    }
}
fn resolve_target(canonical: &Canonical, spec: &TargetSpec) -> dr_store::Result<Target> {
    if let Some(exact) = canonical.targets.iter().find(|target| {
        matches!(target.kind.as_str(), "entry" | "module")
            && target.kind == spec.kind
            && target.id == spec.name
    }) {
        return Ok(exact.clone());
    }
    let mut matching = canonical
        .targets
        .iter()
        .filter(|target| target.kind == spec.kind && target.name == spec.name);
    let first = matching
        .next()
        .cloned()
        .ok_or_else(|| invalid(format!("target not found: {} {}", spec.kind, spec.name)))?;
    if matching.next().is_some() {
        return Err(invalid(
            "ambiguous target name; rename or narrow the target first",
        ));
    }
    Ok(first)
}

#[derive(Clone)]
pub struct Store {
    lib: Library,
}
impl Store {
    pub fn new(lib: Library) -> Self {
        Self { lib }
    }
    pub fn chain_for_session(&self, session: &str) -> Result<Option<String>> {
        Ok(self
            .lib
            .local_read(|conn| Ok(member(conn, session)?.map(|member| member.chain)))?)
    }
    fn chain(&self, id: &str) -> Result<Chain> {
        self.lib
            .local_read(|conn| get(conn, CHAINS, id))?
            .ok_or_else(|| Error::Protocol("request chain is unavailable".into()))
    }
    fn members(&self, chain: &Chain) -> Result<Vec<Member>> {
        let mut result = Vec::new();
        for session in self.lib.agent_sessions(Some(chain.book.as_str()))? {
            if let Some(member) = self.lib.local_read(|conn| member(conn, &session.session))?
                && member.chain == chain.id
            {
                result.push(member);
            }
        }
        Ok(result)
    }
    pub fn snapshot(&self, id: &str) -> Result<ChainSnapshot> {
        let (chain, mut plan, constraints) = self.lib.local_read(|conn| {
            let tx = conn.unchecked_transaction()?;
            let chain: Chain =
                get(&tx, CHAINS, id)?.ok_or_else(|| invalid("request chain is unavailable"))?;
            book_exists(&tx, &chain.book)?;
            let mut plan = get::<Plan>(&tx, PLANS, id)?;
            if let Some(plan) = &mut plan {
                plan.steps = rows(&tx, STEPS, id)?;
                plan.steps.sort_by_key(|step| step.ordinal);
            }
            let constraints = rows(&tx, CONSTRAINTS, id)?;
            Ok((chain, plan, constraints))
        })?;
        let current = canonical(&self.lib, &chain.book)?;
        let manifest_state = plan
            .as_ref()
            .filter(|p| p.scope == Scope::WholeBook)
            .map(|p| drift(&p.manifest, &current.manifest))
            .unwrap_or_default();
        let mut steering = Vec::new();
        for member in self.members(&chain)? {
            for row in events(&self.lib, &member.session, 0)? {
                match row.event {
                    Event::SteeringReceived { id, text } => steering.push(AuthorInput {
                        session: member.session.clone(),
                        id,
                        text,
                    }),
                    Event::UserMessage { text }
                        if member.mode == StartMode::Resume && row.turn == 1 =>
                    {
                        steering.push(AuthorInput {
                            session: member.session.clone(),
                            id: format!("resume:{}", row.seq),
                            text,
                        })
                    }
                    _ => {}
                }
            }
        }
        Ok(ChainSnapshot {
            chain: chain.id,
            book: chain.book,
            conversation: chain.conversation,
            original_request: chain.original_request,
            steering,
            config: chain.config,
            plan: plan.take(),
            constraints,
            manifest_state,
        })
    }
    pub fn continuation(&self, session: &str) -> Result<Continuation> {
        let id = self
            .chain_for_session(session)?
            .ok_or_else(|| Error::Protocol("session has no request chain".into()))?;
        let snapshot = self.snapshot(&id)?;
        let log = events(&self.lib, session, 0)?;
        let waited_user = log.iter().any(|row| {
            matches!(
                row.event,
                Event::QuestionAsked { .. } | Event::PermissionAsked { .. }
            )
        });
        let state = log.iter().rev().find_map(|row| {
            if let Event::StateChanged { state } = row.event {
                Some(state)
            } else {
                None
            }
        });
        let failed=log.iter().any(|row|matches!(&row.event,Event::ToolFinished{result} if result.status!=crate::ToolStatus::Success));
        let writes: Vec<WriteProof> = self.lib.local_read(|conn| rows(conn, WRITES, &id))?;
        let fingerprint = evidence::hash(serde_json::to_vec(
            &json!({"plan":snapshot.plan.as_ref().map(|plan|json!({"status":plan.status,"manifest":plan.manifest,"steps":plan.steps.iter().map(|step|json!({"target":target_key(&step.target),"status":step.status,"evidence":step.evidence,"review":step.review})).collect::<Vec<_>>()})),"writes":writes.iter().map(|write|&write.id).collect::<Vec<_>>()}),
        )?);
        let decision = if waited_user {
            Decision::Pause {
                reason: "user_interaction".into(),
            }
        } else if failed {
            Decision::Pause {
                reason: "tool_error".into(),
            }
        } else if !matches!(state, Some(State::Completed | State::Checkpointed)) {
            Decision::Pause {
                reason: "run_not_completed".into(),
            }
        } else if log.iter().any(
            |row| matches!(&row.event,Event::Checkpoint{reason} if reason!="model_round_limit"),
        ) {
            Decision::Pause {
                reason: "context_capacity".into(),
            }
        } else {
            match &snapshot.plan {
                None => Decision::Off {
                    reason: "no_active_plan".into(),
                },
                Some(plan) if plan.status.terminal() => Decision::Off {
                    reason: "task_terminal".into(),
                },
                Some(plan) if plan.status != TaskStatus::Active => Decision::Pause {
                    reason: "task_paused".into(),
                },
                Some(_) if snapshot.manifest_state.drifted => Decision::Continue {
                    reason: "reconcile_manifest".into(),
                },
                Some(plan)
                    if plan.steps.iter().any(|step| {
                        matches!(step.status, StepStatus::Pending | StepStatus::InProgress)
                    }) =>
                {
                    Decision::Continue {
                        reason: "runnable_step".into(),
                    }
                }
                Some(plan)
                    if !plan.steps.is_empty()
                        && plan.steps.iter().all(|step| {
                            matches!(step.status, StepStatus::Completed | StepStatus::Retired)
                        }) =>
                {
                    Decision::Continue {
                        reason: "finalize_plan".into(),
                    }
                }
                _ => Decision::Pause {
                    reason: "no_actionable_work".into(),
                },
            }
        };
        Ok(Continuation {
            snapshot,
            decision,
            fingerprint,
            waited_user,
        })
    }

    /// A command receipt and all its changes commit together. The same Actor
    /// call may be replayed only with byte-equivalent structured arguments.
    pub fn apply(
        &self,
        session: &str,
        turn: u32,
        call: &str,
        command: Command,
    ) -> Result<CommandReceipt> {
        let chain_id = self
            .chain_for_session(session)?
            .ok_or_else(|| Error::Protocol("session has no request chain".into()))?;
        let chain = self.chain(&chain_id)?;
        let canonical = canonical(&self.lib, &chain.book)?;
        let command_hash = evidence::hash(serde_json::to_vec(&command)?);
        let command_id = evidence::hash(format!("{session}/{turn}/{call}"));
        let key = format!("{chain_id}/{command_id}");
        if let Some((stored_hash, receipt)) = self.lib.local_read(|conn| {
            book_exists(conn, &chain.book)?;
            get::<(String, CommandReceipt)>(conn, COMMANDS, &key)
        })? {
            if stored_hash != command_hash {
                return Err(Error::Protocol(
                    "command identity reused with different arguments".into(),
                ));
            }
            return Ok(receipt);
        }
        let prepared_review = match &command {
            Command::Step {
                step,
                status: StepStatus::Completed,
                review: Some(review),
                ..
            } => Some(self.review(&chain_id, step, review)?),
            _ => None,
        };
        Ok(self.lib.local_write(|tx| {
            book_exists(tx, &chain.book)?;
            if member(tx, session)?.is_none_or(|member| member.chain != chain_id) {
                return Err(invalid("session is not a member of this request chain"));
            }
            if let Some((hash, receipt)) = get::<(String, CommandReceipt)>(tx, COMMANDS, &key)? {
                if hash != command_hash {
                    return Err(invalid("command identity reused with different arguments"));
                }
                return Ok(receipt);
            }
            check_version(tx, &format!("book:{}", chain.book), &canonical.version)?;
            let mut plan = get::<Plan>(tx, PLANS, &chain_id)?;
            let mut steps: Vec<Step> = rows(tx, STEPS, &chain_id)?;
            steps.sort_by_key(|step| step.ordinal);
            let mut merged = Vec::new();
            if let Command::Create {
                objective,
                scope,
                work_kind,
                targets,
            } = &command
            {
                if plan.is_some() {
                    return Err(invalid(
                        "this request chain already has a plan; terminal plans are immutable",
                    ));
                }
                if objective.trim().is_empty() {
                    return Err(invalid("task objective is empty"));
                }
                if *scope == Scope::WholeBook && !targets.is_empty() {
                    return Err(invalid("whole-book targets are enumerated by the product"));
                }
                let chosen = if *scope == Scope::WholeBook {
                    canonical
                        .manifest
                        .iter()
                        .map(|entry| entry.target.clone())
                        .collect()
                } else {
                    targets
                        .iter()
                        .map(|spec| resolve_target(&canonical, spec))
                        .collect::<dr_store::Result<Vec<_>>>()?
                };
                if chosen.is_empty() {
                    return Err(invalid("a plan needs at least one current target"));
                }
                let mut seen = BTreeSet::new();
                for target in chosen {
                    if seen.insert(target_key(&target)) {
                        steps.push(new_step(target, steps.len()));
                    }
                }
                plan = Some(Plan {
                    id: new_uuid_v7(),
                    objective: objective.clone(),
                    scope: *scope,
                    work_kind: *work_kind,
                    status: TaskStatus::Active,
                    revision: 0,
                    manifest: if *scope == Scope::WholeBook {
                        canonical.manifest.clone()
                    } else {
                        Vec::new()
                    },
                    steps: Vec::new(),
                });
            } else {
                let plan = plan
                    .as_mut()
                    .ok_or_else(|| invalid("create a task plan first"))?;
                if plan.status.terminal() {
                    return Err(invalid("task is terminal; stop updating this checklist"));
                }
                let expected = match command {
                    Command::Update {
                        expected_revision, ..
                    }
                    | Command::AppendSteps {
                        expected_revision, ..
                    }
                    | Command::ReconcileManifest { expected_revision }
                    | Command::Step {
                        expected_revision, ..
                    }
                    | Command::Constraint {
                        expected_revision, ..
                    } => expected_revision,
                    Command::Create { .. } => unreachable!(),
                };
                if expected != plan.revision {
                    return Err(invalid("task revision conflict; read the host plan again"));
                }
                match &command {
                    Command::Update {
                        objective, status, ..
                    } => {
                        if let Some(objective) = objective {
                            if objective.trim().is_empty() {
                                return Err(invalid("task objective is empty"));
                            }
                            plan.objective = objective.clone();
                        }
                        if let Some(status) = status {
                            if *status == TaskStatus::Completed {
                                validate_complete(plan, &steps, &canonical)?;
                                if plan.work_kind == WorkKind::Review {
                                    for step in &steps {
                                        if step.status == StepStatus::Completed
                                            && canonical
                                                .manifest
                                                .iter()
                                                .any(|entry| entry.target.id == step.target.id)
                                            || step.status == StepStatus::Completed
                                                && plan.scope == Scope::Targets
                                        {
                                            check_version(
                                                tx,
                                                step.target
                                                    .doc
                                                    .as_deref()
                                                    .ok_or_else(|| invalid("review target has no prose"))?,
                                                step.review_version.as_deref().ok_or_else(|| {
                                                    invalid("review evidence has no version")
                                                })?,
                                            )?;
                                        }
                                    }
                                }
                            }
                            plan.status = *status;
                        }
                    }
                    Command::AppendSteps { targets, .. } => {
                        if plan.scope == Scope::WholeBook {
                            return Err(invalid(
                                "whole-book membership changes through reconcile_manifest",
                            ));
                        }
                        for spec in targets {
                            let target = resolve_target(&canonical, spec)?;
                            if let Some(old) = steps
                                .iter()
                                .find(|step| target_key(&step.target) == target_key(&target))
                            {
                                merged.push(old.id.clone());
                            } else {
                                steps.push(new_step(target, steps.len()));
                            }
                        }
                    }
                    Command::ReconcileManifest { .. } => {
                        if plan.scope != Scope::WholeBook || canonical.manifest.is_empty() {
                            return Err(invalid(
                                "cannot reconcile an empty or non-whole-book manifest",
                            ));
                        }
                        let mut ordered = Vec::new();
                        for entry in &canonical.manifest {
                            let mut step = if let Some(index) = steps
                                .iter()
                                .position(|step| step.target.id == entry.target.id)
                            {
                                steps.remove(index)
                            } else {
                                new_step(entry.target.clone(), entry.ordinal)
                            };
                            if step.status == StepStatus::Retired {
                                let id = step.id.clone();
                                step = new_step(entry.target.clone(), entry.ordinal);
                                step.id = id;
                            }
                            step.target = entry.target.clone();
                            step.ordinal = ordered.len();
                            ordered.push(step);
                        }
                        for mut step in steps.drain(..) {
                            if step.status != StepStatus::Completed {
                                step.status = StepStatus::Retired;
                                step.finished_ms = Some(dr_store::now_ms());
                            }
                            step.ordinal = ordered.len();
                            ordered.push(step);
                        }
                        steps = ordered;
                        plan.manifest = canonical.manifest.clone();
                    }
                    Command::Step {
                        step,
                        status,
                        note,
                        review,
                        ..
                    } => {
                        if *status == StepStatus::Retired {
                            return Err(invalid("only manifest reconciliation retires a step"));
                        }
                        let index = steps
                            .iter()
                            .position(|row| row.id == *step)
                            .ok_or_else(|| invalid("step does not belong to this plan"))?;
                        if steps[index].status == StepStatus::Completed
                            && plan.work_kind == WorkKind::Review
                            && *status == StepStatus::Pending
                        {
                            let row = &mut steps[index];
                            let changed = check_version(
                                tx,
                                row.target.doc.as_deref().unwrap_or(""),
                                row.review_version.as_deref().unwrap_or(""),
                            )
                            .is_err();
                            if !changed {
                                return Err(invalid("completed current review cannot be reopened"));
                            }
                            row.evidence = None;
                            row.review = None;
                            row.review_version = None;
                            row.started_ms = None;
                            row.finished_ms = None;
                        } else if matches!(
                            steps[index].status,
                            StepStatus::Completed | StepStatus::Retired
                        ) {
                            return Err(invalid("terminal step cannot be changed"));
                        }
                        if *status == StepStatus::InProgress
                            && steps
                                .iter()
                                .enumerate()
                                .any(|(i, row)| i != index && row.status == StepStatus::InProgress)
                        {
                            return Err(invalid("only one step may be in progress"));
                        }
                        if *status == StepStatus::Completed {
                            match plan.work_kind {
                                WorkKind::Edit => {
                                    if review.is_some() {
                                        return Err(invalid(
                                            "edit steps require durable writes, not review claims",
                                        ));
                                    }
                                    let proofs: Vec<WriteProof> = rows(tx, WRITES, &chain_id)?;
                                    let proof=proofs.iter().rev().find(|proof|proof.targets.contains(&target_key(&steps[index].target)) && !steps.iter().any(|row|row.evidence.as_ref()==Some(&proof.id)))
                                                .ok_or_else(||invalid(format!("no unclaimed saved change for {}; save a change to or anchored to this target, or append_steps for another target",steps[index].target.name)))?;
                                    steps[index].evidence = Some(proof.id.clone());
                                }
                                WorkKind::Review => {
                                    let (doc,version,reference)=prepared_review.as_ref().ok_or_else(||invalid("review steps require cited reviewResult after a complete current read"))?;
                                    check_version(tx, doc, version)?;
                                    steps[index].evidence = Some(reference.clone());
                                    steps[index].review = review.clone();
                                    steps[index].review_version = Some(version.clone());
                                }
                            }
                        }
                        let row = &mut steps[index];
                        if *status == StepStatus::InProgress && row.started_ms.is_none() {
                            row.started_ms = Some(dr_store::now_ms());
                        }
                        row.status = *status;
                        row.note = note.clone();
                        if matches!(status, StepStatus::Completed | StepStatus::Failed) {
                            row.finished_ms = Some(dr_store::now_ms());
                        }
                    }
                    Command::Constraint {
                        id, text, active, ..
                    } => {
                        if text.trim().is_empty() {
                            return Err(invalid("constraint text is empty"));
                        }
                        let id = id.clone().unwrap_or_else(new_uuid_v7);
                        if id.contains('/') || id.len() > 128 {
                            return Err(invalid("invalid constraint identity"));
                        }
                        put(
                            tx,
                            CONSTRAINTS,
                            &format!("{chain_id}/{id}"),
                            &Constraint {
                                id: id.clone(),
                                text: text.clone(),
                                active: *active,
                            },
                            &chain.book,
                        )?;
                    }
                    Command::Create { .. } => unreachable!(),
                }
            }
            let plan = plan.as_mut().expect("created or existing plan");
            plan.revision = plan
                .revision
                .checked_add(1)
                .ok_or_else(|| invalid("task revision overflow"))?;
            put(tx, PLANS, &chain_id, plan, &chain.book)?;
            for step in &steps {
                put(
                    tx,
                    STEPS,
                    &format!("{chain_id}/{}", step.id),
                    step,
                    &chain.book,
                )?;
            }
            let receipt = CommandReceipt {
                id: command_id.clone(),
                revision: plan.revision,
                merged_steps: merged,
                fingerprint: command_hash.clone(),
            };
            put(
                tx,
                COMMANDS,
                &key,
                &(command_hash.clone(), receipt.clone()),
                &chain.book,
            )?;
            Ok(receipt)
        })?)
    }

    fn review(
        &self,
        chain: &str,
        step: &str,
        review: &ReviewResult,
    ) -> Result<(String, String, String)> {
        let snapshot = self.snapshot(chain)?;
        let step = snapshot
            .plan
            .as_ref()
            .and_then(|plan| plan.steps.iter().find(|row| row.id == step))
            .ok_or_else(|| Error::Protocol("review step not found".into()))?;
        let doc = step.target.doc.as_ref().ok_or_else(|| {
            Error::Protocol("target has no supported prose review evidence".into())
        })?;
        let copy = self.lib.load_copy(doc)?;
        let version = evidence::version(&copy.oplog_frontiers());
        let proofs: Vec<ReadProof> = self.lib.local_read(|conn| rows(conn, READS, chain))?;
        let mut coverage = BTreeMap::new();
        let mut ids = Vec::new();
        let canonical = evidence::paragraphs(&self.lib, doc, &version)?;
        for proof in proofs.into_iter().filter(|proof| {
            proof.doc == *doc && proof.version == version && proof.total == canonical.len()
        }) {
            for (index, hash) in proof.paragraphs {
                if canonical.get(index).is_none_or(|paragraph| {
                    evidence::hash(serde_json::to_vec(paragraph).unwrap_or_default()) != hash
                }) {
                    return Err(Error::Protocol(
                        "stored review evidence source mismatch".into(),
                    ));
                }
                coverage.insert(index, hash);
            }
            ids.push(proof.id);
        }
        if ids.is_empty()
            || coverage.len() != canonical.len()
            || review.outcome.trim().is_empty()
            || review.claims.is_empty()
                && canonical.iter().any(|paragraph| !paragraph.text.is_empty())
        {
            return Err(Error::Protocol(
                "review needs a complete current target read and cited claims".into(),
            ));
        }
        for claim in review.claims.iter().chain(&review.findings) {
            if claim.text.trim().is_empty() || claim.citations.is_empty() {
                return Err(Error::Protocol(
                    "every review claim and finding needs a source citation".into(),
                ));
            }
            for citation in &claim.citations {
                if citation.quote.is_empty()
                    || canonical
                        .get(citation.paragraph)
                        .is_none_or(|paragraph| !paragraph.text.contains(&citation.quote))
                {
                    return Err(Error::Protocol(
                        "review quote is not in the exact target".into(),
                    ));
                }
            }
        }
        Ok((
            doc.clone(),
            version.clone(),
            evidence::hash(serde_json::to_vec(&(doc, &version, ids, review))?),
        ))
    }
}

fn validate_complete(plan: &Plan, steps: &[Step], canonical: &Canonical) -> dr_store::Result<()> {
    if plan.scope == Scope::WholeBook {
        if canonical.manifest.is_empty() || drift(&plan.manifest, &canonical.manifest).drifted {
            return Err(invalid(
                "TASK_MANIFEST_DRIFT: reconcile_manifest before completion",
            ));
        }
        for entry in &canonical.manifest {
            if !steps.iter().any(|step| {
                step.target.id == entry.target.id
                    && step.status == StepStatus::Completed
                    && step.evidence.is_some()
            }) {
                return Err(invalid(
                    "every current chapter needs its own accepted evidence",
                ));
            }
        }
    }
    if steps.is_empty()
        || steps.iter().any(|step| {
            !matches!(step.status, StepStatus::Completed | StepStatus::Retired)
                || step.status == StepStatus::Completed && step.evidence.is_none()
        })
    {
        return Err(invalid("unfinished steps prevent completion"));
    }
    Ok(())
}
