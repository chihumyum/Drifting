use std::collections::{HashMap, HashSet};
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, Ordering},
};

use dr_agent::{
    ToolAccess, ToolCall, ToolContext, ToolDescriptor, ToolExecutor, ToolPolicy, tools::ToolOutput,
};
use dr_model::id::BookId;
use dr_workspace::{Actor, Workspace, WritePreconditions, WsError};
use futures::{FutureExt, channel::oneshot, future::BoxFuture};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    Error, Result,
    catalog::{Catalog, Search},
    prose::{self, Projection},
    resolve::{self, ResolvedCall},
};

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallRequest {
    pub name: String,
    #[serde(default = "empty_arguments")]
    pub arguments: Value,
    #[serde(default)]
    pub revision: Option<String>,
    /// The exact edited projection returned by prose.read, for prose.replace.
    /// Other operations use their registry-generated input directly.
    #[serde(default)]
    pub edited_text: Option<String>,
}
fn empty_arguments() -> Value {
    json!({})
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct TurnKey {
    book: String,
    session: String,
    turn: u32,
}

#[derive(Default)]
struct ReadState {
    version: String,
    subjects: HashSet<String>,
    blocks: HashMap<String, String>,
    full_prose: bool,
    projection: Option<Projection>,
}

#[derive(Default)]
struct TurnState {
    reads: HashMap<String, ReadState>,
    conflicts: HashMap<String, u32>,
}

#[derive(Clone)]
pub struct AgentTools {
    catalog: Arc<Catalog>,
    turns: Arc<Mutex<HashMap<TurnKey, TurnState>>>,
    leases: Arc<Mutex<HashMap<String, Weak<AtomicBool>>>>,
}

impl Default for AgentTools {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentTools {
    pub fn new() -> Self {
        Self {
            catalog: Arc::new(Catalog::new()),
            turns: Arc::default(),
            leases: Arc::default(),
        }
    }
    pub fn catalog(&self) -> &Catalog {
        &self.catalog
    }

    /// A connection owner (MCP) can discard observations when its session ends.
    /// Runtime calls the same hook at run settlement.
    pub fn forget_session(&self, session: &str) {
        if let Some(lease) = self
            .leases
            .lock()
            .expect("tool leases")
            .remove(session)
            .and_then(|lease| lease.upgrade())
        {
            lease.store(true, Ordering::SeqCst);
        }
        self.turns
            .lock()
            .expect("tool observations")
            .retain(|key, _| key.session != session);
    }

    fn lease(&self, session: &str) -> Arc<AtomicBool> {
        let mut leases = self.leases.lock().expect("tool leases");
        if let Some(lease) = leases.get(session).and_then(Weak::upgrade) {
            return lease;
        }
        let lease = Arc::new(AtomicBool::new(false));
        leases.insert(session.into(), Arc::downgrade(&lease));
        lease
    }

    /// The shared, synchronous facade. UI/runtime callers offload this work;
    /// MCP can use the same catalog, names, barriers and guarded dispatcher.
    pub fn invoke(
        &self,
        ws: &Workspace,
        book: &BookId,
        actor: &Actor,
        request: CallRequest,
    ) -> Result<Value> {
        let lease = self.lease(&turn_key(book, actor).session);
        self.invoke_leased(ws, book, actor, request, &lease)
    }

    fn invoke_leased(
        &self,
        ws: &Workspace,
        book: &BookId,
        actor: &Actor,
        request: CallRequest,
        lease: &AtomicBool,
    ) -> Result<Value> {
        if lease.load(Ordering::SeqCst) {
            return Err(Error::Invalid("the tool session ended".into()));
        }
        let descriptor = self
            .catalog
            .descriptor(&request.name)
            .ok_or_else(|| Error::Invalid("unknown book tool".into()))?;
        if request
            .revision
            .as_ref()
            .is_some_and(|revision| revision != &descriptor.revision)
        {
            return Err(Error::Invalid(
                "tool definition changed; search it again".into(),
            ));
        }
        // F3 accepts an id for undo, but an Agent must not use that path to
        // replace a stored relation hidden by relation.list's live-end filter.
        if request.name == "relation.create" && request.arguments.get("id").is_some() {
            return Err(Error::Invalid(
                "relation.create assigns its own id; omit id".into(),
            ));
        }
        let key = turn_key(book, actor);
        let mut resolved = resolve::resolve(ws, book, &request.name, request.arguments)?;
        if descriptor.access == ToolAccess::Read {
            if request.edited_text.is_some() {
                return Err(Error::Invalid(
                    "edited_text is only for prose.replace".into(),
                ));
            }
            return self.read(ws, actor, &key, &resolved, lease);
        }
        if let Some(edited) = request.edited_text {
            if request.name != "prose.replace" {
                return Err(Error::Invalid(
                    "edited_text is only for prose.replace".into(),
                ));
            }
            let doc = resolved.arguments["doc"]
                .as_str()
                .ok_or_else(|| Error::Invalid("missing prose document".into()))?;
            let projection = self
                .turns
                .lock()
                .expect("tool observations")
                .get(&key)
                .and_then(|turn| turn.reads.get(doc))
                .and_then(|read| read.projection.clone())
                .ok_or_else(|| Error::ReadRequired(doc.into()))?;
            let Some(replacement) = prose::plan(&projection, &edited)? else {
                if ws.observe(doc)?.version != projection.version {
                    let mut turns = self.turns.lock().expect("tool observations");
                    let turn = turns.entry(key.clone()).or_default();
                    turn.reads.remove(doc);
                    let count = turn.conflicts.entry(doc.to_owned()).or_default();
                    *count += 1;
                    return Err(if *count >= 2 {
                        Error::ConflictLimit(doc.into())
                    } else {
                        Error::Conflict(doc.into())
                    });
                }
                return Ok(json!({"output":{"unchanged":true},"effects":[]}));
            };
            resolved.arguments = replacement.input();
        }
        self.write(ws, actor, &key, resolved)
    }

    fn read(
        &self,
        ws: &Workspace,
        actor: &Actor,
        key: &TurnKey,
        call: &ResolvedCall,
        lease: &AtomicBool,
    ) -> Result<Value> {
        // Holder delivery invalidates F3's canonical book cache synchronously.
        // Two equal observations bracket a coherent canonical metadata query.
        // Derived search/count projections never establish entity coverage.
        let mut targets = call.targets.clone();
        let book_doc = format!("book:{}", key.book);
        if call.name == "prose.read" && !targets.contains(&book_doc) {
            targets.push(book_doc.clone());
        }
        for _ in 0..3 {
            let before = targets
                .iter()
                .map(|doc| ws.observe(doc))
                .collect::<dr_workspace::Result<Vec<_>>>()?;
            let mut value = ws.call(actor, &call.name, call.arguments.clone())?;
            let comments = if call.name == "prose.read" {
                Some(ws.call(actor, "comment.list", json!({"book":key.book}))?)
            } else {
                None
            };
            let after = targets
                .iter()
                .map(|doc| ws.observe(doc))
                .collect::<dr_workspace::Result<Vec<_>>>()?;
            if before
                .iter()
                .zip(&after)
                .any(|(a, b)| a.version != b.version)
            {
                continue;
            }
            let output = value.get("output").cloned().unwrap_or(Value::Null);
            let subjects = resolve::coverage(&call.name, &call.arguments, &output);
            let projection = if call.name == "prose.read" {
                let doc = call.arguments["doc"]
                    .as_str()
                    .ok_or_else(|| Error::Invalid("missing prose document".into()))?;
                Some(prose::project(
                    doc,
                    &output,
                    &prose::comment_anchors(
                        doc,
                        &comments.as_ref().expect("prose comments")["output"],
                    ),
                )?)
            } else {
                None
            };
            let mut turns = self.turns.lock().expect("tool observations");
            if lease.load(Ordering::SeqCst) {
                return Err(Error::Invalid("the tool session ended".into()));
            }
            let turn = turns.entry(key.clone()).or_default();
            for observation in after {
                let read = turn.reads.entry(observation.doc.clone()).or_default();
                if read.version != observation.version {
                    *read = ReadState {
                        version: observation.version.clone(),
                        ..Default::default()
                    };
                }
                read.subjects.extend(
                    subjects
                        .iter()
                        .filter(|subject| {
                            if let Some(doc) = subject.strip_prefix("prose:") {
                                doc == observation.doc
                            } else if subject.starts_with("history:") {
                                true
                            } else {
                                observation.doc == book_doc
                            }
                        })
                        .cloned(),
                );
                if let Some(projection) = &projection {
                    if projection.doc != observation.doc
                        || projection.version != observation.version
                    {
                        continue;
                    }
                    for block in output["paragraphs"].as_array().into_iter().flatten() {
                        if let (Some(id), Some(text)) =
                            (block["block_id"].as_str(), block["text"].as_str())
                        {
                            read.blocks.insert(id.into(), text.into());
                        }
                    }
                    read.full_prose |= output["paragraphs"].as_array().is_some_and(|blocks| {
                        Some(blocks.len() as u64) == output["total"].as_u64()
                    });
                    read.projection = Some(projection.clone());
                }
            }
            if let Some(projection) = projection {
                value["output"]["projection"] =
                    serde_json::to_value(projection).map_err(|e| Error::Invalid(e.to_string()))?;
            }
            return Ok(value);
        }
        Err(Error::Conflict(
            "the target changed while reading; read again".into(),
        ))
    }

    fn write(
        &self,
        ws: &Workspace,
        actor: &Actor,
        key: &TurnKey,
        call: ResolvedCall,
    ) -> Result<Value> {
        let canonical = call.arguments["doc"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| {
                call.arguments["id"]
                    .as_str()
                    .map(|id| format!("{}:{id}", call.name.split('.').next().unwrap_or_default()))
            })
            .or_else(|| {
                call.subjects
                    .iter()
                    .find(|subject| !subject.ends_with(":*"))
                    .cloned()
            })
            .or_else(|| call.targets.first().cloned())
            .ok_or_else(|| Error::Invalid("write has no guarded target".into()))?;
        let guards = {
            let turns = self.turns.lock().expect("tool observations");
            let turn = turns
                .get(key)
                .ok_or_else(|| Error::ReadRequired(canonical.clone()))?;
            if let Some(doc) = call
                .targets
                .iter()
                .find(|doc| turn.conflicts.get(*doc).copied().unwrap_or(0) >= 2)
            {
                return Err(Error::ConflictLimit(doc.clone()));
            }
            for subject in &call.subjects {
                if !turn
                    .reads
                    .values()
                    .any(|read| read.subjects.contains(subject))
                {
                    return Err(Error::ReadRequired(subject.clone()));
                }
            }
            let mut versions = HashMap::new();
            for doc in &call.targets {
                let read = turn
                    .reads
                    .get(doc)
                    .ok_or_else(|| Error::ReadRequired(doc.clone()))?;
                versions.insert(doc.clone(), read.version.clone());
            }
            if call.name == "prose.replace" {
                let doc = call.arguments["doc"]
                    .as_str()
                    .ok_or_else(|| Error::Invalid("missing prose document".into()))?;
                let read = turn
                    .reads
                    .get(doc)
                    .ok_or_else(|| Error::ReadRequired(doc.into()))?;
                let find = call.arguments["find"].as_str().unwrap_or_default();
                let covered = if let Some(id) = call.arguments["block_id"].as_str() {
                    read.blocks.get(id).is_some_and(|text| text.contains(find))
                } else {
                    read.full_prose && read.blocks.values().any(|text| text.contains(find))
                };
                if !covered {
                    return Err(Error::ReadRequired(format!("paragraph in {doc}")));
                }
            } else if call.name.starts_with("prose.") {
                // Link/restore operations can touch unshown ranges or whole
                // documents. A partial prose window is insufficient evidence.
                for doc in &call.targets {
                    if !doc.starts_with("book:")
                        && !turn.reads.get(doc).is_some_and(|read| read.full_prose)
                    {
                        return Err(Error::ReadRequired(doc.clone()));
                    }
                }
            }
            WritePreconditions {
                versions,
                require_all: true,
            }
        };
        let result = ws.call_guarded(actor, &call.name, call.arguments.clone(), guards);
        // A later observation could contain unseen concurrent author changes;
        // never refresh an observation implicitly after a write. Read again.
        let mut turns = self.turns.lock().expect("tool observations");
        let turn = turns.entry(key.clone()).or_default();
        for target in &call.targets {
            turn.reads.remove(target);
        }
        match result {
            Ok(value) => Ok(value),
            Err(WsError::Conflict(message)) if message.starts_with("stale observation:") => {
                // Count by the holder's actual document, including the later
                // document of a multi-document call. Changing tool names or
                // input shapes must not reset the same target's CAS budget.
                let target = message
                    .trim_start_matches("stale observation:")
                    .trim()
                    .to_owned();
                let count = turn.conflicts.entry(target.clone()).or_default();
                *count += 1;
                // No automatic retry: a multi-document call may have receipts
                // before a later document's guard fails. M27 reconciles them.
                if *count >= 2 {
                    Err(Error::ConflictLimit(target))
                } else {
                    Err(Error::Conflict(target))
                }
            }
            Err(WsError::Conflict(message)) if message.starts_with("read required:") => {
                Err(Error::ReadRequired(message))
            }
            Err(error) => Err(error.into()),
        }
    }
}

impl ToolExecutor for AgentTools {
    fn descriptors(&self) -> Vec<ToolDescriptor> {
        vec![search_descriptor(), call_descriptor()]
    }
    fn describe(&self, call: &ToolCall) -> Option<ToolDescriptor> {
        match call.name.as_str() {
            "tool_search" => Some(search_descriptor()),
            "call_tool" => call.arguments["name"]
                .as_str()
                .and_then(|name| self.catalog.descriptor(name)),
            _ => None,
        }
    }
    fn finish_session(&self, session: &str) {
        self.forget_session(session);
    }
    fn execute(
        &self,
        context: ToolContext,
        call: ToolCall,
    ) -> BoxFuture<'static, dr_agent::Result<ToolOutput>> {
        let facade = self.clone();
        let lease = self.lease(&turn_key(&context.book, &context.actor).session);
        async move {
            let (tx, rx) = oneshot::channel();
            std::thread::Builder::new()
                .name("dr-agent-facade".into())
                .spawn(move || {
                    let result = (|| -> Result<Value> {
                        if context.cancellation.is_cancelled() {
                            return Err(Error::Invalid("cancelled before tool entry".into()));
                        }
                        match call.name.as_str() {
                            "tool_search" => {
                                let search: Search = serde_json::from_value(call.arguments)
                                    .map_err(|e| Error::Invalid(e.to_string()))?;
                                search.validate()?;
                                Ok(facade.catalog.search(search))
                            }
                            "call_tool" => {
                                let request: CallRequest =
                                    serde_json::from_value(call.arguments)
                                        .map_err(|e| Error::Invalid(e.to_string()))?;
                                if facade.catalog.descriptor(&request.name).as_ref()
                                    != Some(&context.descriptor)
                                {
                                    return Err(Error::Invalid(
                                        "tool definition changed; search again".into(),
                                    ));
                                }
                                facade.invoke_leased(
                                    context.workspace(),
                                    &context.book,
                                    &context.actor,
                                    request,
                                    &lease,
                                )
                            }
                            _ => Err(Error::Invalid("unknown tool envelope".into())),
                        }
                    })();
                    let _ = tx.send(result);
                })
                .map_err(|e| dr_agent::Error::Tool(e.to_string()))?;
            let result = rx
                .await
                .map_err(|_| dr_agent::Error::Tool("tool facade worker panicked".into()))?;
            Ok(match result {
                Ok(value) => ToolOutput::Value(value),
                Err(error @ Error::ConflictLimit(_)) => ToolOutput::Stop(error_value(error)),
                Err(error) => ToolOutput::Error(error_value(error)),
            })
        }
        .boxed()
    }
}

fn turn_key(book: &BookId, actor: &Actor) -> TurnKey {
    match actor {
        Actor::Agent { session, turn, .. } => TurnKey {
            book: book.to_string(),
            session: session.clone(),
            turn: *turn,
        },
        _ => TurnKey {
            book: book.to_string(),
            session: actor.journal_key(),
            turn: 0,
        },
    }
}
fn error_value(error: Error) -> Value {
    let code = match &error {
        Error::ReadRequired(_) => "read_required".into(),
        Error::Conflict(_) => "conflict".into(),
        Error::ConflictLimit(_) => "conflict_limit".into(),
        Error::Workspace(error) => error.code(),
        _ => "invalid".into(),
    };
    json!({"error":{"code":code,"message":error.to_string()}})
}
fn search_descriptor() -> ToolDescriptor {
    ToolDescriptor{name:"tool_search".into(),revision:"m29-search-v1".into(),description:"Find registered book tools by name or description. Search before calling an unfamiliar tool.".into(),input_schema:json!({"type":"object","properties":{"query":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":50}},"additionalProperties":false}),access:ToolAccess::Read,policy:ToolPolicy::Local}
}
fn call_descriptor() -> ToolDescriptor {
    ToolDescriptor{name:"call_tool".into(),revision:"m29-call-v1".into(),description:"Call a discovered book tool. Read a target before editing it; reread after any conflict. For prose.replace, edited_text may contain the edited projection returned by prose.read. Structural prose edits are not available.".into(),input_schema:json!({"type":"object","properties":{"name":{"type":"string"},"arguments":{"type":"object"},"revision":{"type":"string"},"edited_text":{"type":"string"}},"required":["name","arguments"],"additionalProperties":false}),access:ToolAccess::Write,policy:ToolPolicy::Local}
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_testkit::seed::{self, Preset};

    #[test]
    fn read_finishing_after_session_end_cannot_publish_write_authority() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "m29-late-read").unwrap();
        let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        seeded.write_to(ws.library()).unwrap();
        let book = seeded.books[0].book_id().clone();
        let tools = AgentTools::new();
        let actor = Actor::agent("late-read", 1, "read");
        let key = turn_key(&book, &actor);
        let lease = tools.lease(&key.session);
        let resolved = resolve::resolve(&ws, &book, "chapter.list", json!({})).unwrap();

        // This read passed its entry gate before the run ended. Its underlying
        // F3 read may still finish after cancellation dropped the async waiter.
        tools.forget_session(&key.session);
        assert!(matches!(
            tools.read(&ws, &actor, &key, &resolved, &lease),
            Err(Error::Invalid(_))
        ));
        let chapters = ws
            .call(&Actor::User, "chapter.list", json!({"book":book}))
            .unwrap();
        let result = tools.invoke(&ws, &book, &actor, CallRequest {
            name: "chapter.update".into(),
            arguments: json!({"id":chapters["output"][0]["id"],"summary":chapters["output"][0]["title"]}),
            revision: None,
            edited_text: None,
        });
        assert!(matches!(result, Err(Error::ReadRequired(_))), "{result:?}");
        assert!(
            ws.library()
                .settlements(Some("late-read"), None)
                .unwrap()
                .is_empty()
        );
        ws.close();
    }
}
