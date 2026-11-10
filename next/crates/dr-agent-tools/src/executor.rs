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
    catalog::{ActionRef, ActionTarget, Catalog, Search, is_v3_book},
    prose::{self, Projection},
    resolve::{self, ResolvedCall},
    structure::{FocusRequest, StructureContext},
};

#[path = "checkpoints.rs"]
mod checkpoints;
#[path = "evidence.rs"]
mod evidence;
#[path = "timeline.rs"]
mod timeline;

#[derive(Clone, Debug)]
pub struct CallRequest {
    pub name: String,
    pub arguments: Value,
    pub revision: Option<String>,
    /// The exact edited projection returned by prose.read, for prose.replace.
    /// Other operations use their registry-generated input directly.
    pub edited_text: Option<String>,
}

impl CallRequest {
    pub fn for_action(reference: &ActionRef, arguments: Value, revision: Option<String>) -> Self {
        Self {
            name: reference.canonical_id(),
            arguments,
            revision,
            edited_text: None,
        }
    }

    pub fn for_action_target(
        target: &ActionTarget,
        arguments: Value,
        revision: Option<String>,
    ) -> Self {
        Self {
            name: target.canonical_id(),
            arguments,
            revision,
            edited_text: None,
        }
    }

    pub fn is_action(&self) -> bool {
        self.name.starts_with("action:") || self.name.starts_with("action_json:")
    }

    pub(crate) fn descriptor_in(
        &self,
        catalog: &Catalog,
        book: &BookId,
    ) -> Result<Option<ToolDescriptor>> {
        if self.is_action() {
            let canonical = self.canonical_name_in(catalog, book)?;
            return Ok(catalog.descriptor(&canonical));
        }
        Ok(catalog.descriptor(&self.name))
    }

    pub(crate) fn canonical_name_in(&self, catalog: &Catalog, book: &BookId) -> Result<String> {
        if let Some(encoded) = self.name.strip_prefix("action_json:") {
            let val: Value =
                serde_json::from_str(encoded).map_err(|e| Error::Invalid(e.to_string()))?;
            let binding = catalog.resolve_action_target(book, &val)?;
            return Ok(binding.id);
        }
        if self.name.starts_with("action:") {
            let binding = catalog.resolve_action_target(book, &Value::String(self.name.clone()))?;
            return Ok(binding.id);
        }
        Ok(self.name.clone())
    }
}

impl<'de> Deserialize<'de> for CallRequest {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct WireCallRequest {
            #[serde(default)]
            name: Option<String>,
            #[serde(default)]
            action: Option<Value>,
            #[serde(default = "empty_arguments")]
            arguments: Value,
            #[serde(default)]
            revision: Option<String>,
            #[serde(default)]
            edited_text: Option<String>,
        }
        let wire = WireCallRequest::deserialize(deserializer)?;
        let name = match (wire.name, wire.action) {
            (Some(name), None) => {
                let trimmed = name.trim();
                if trimmed.is_empty() {
                    return Err(serde::de::Error::custom("tool name must not be empty"));
                }
                if trimmed.starts_with("action:") || trimmed.starts_with("action_json:") {
                    return Err(serde::de::Error::custom(
                        "template actions must be called with the action field, not name",
                    ));
                }
                name
            }
            (None, Some(action)) => {
                if let Some(raw) = action.as_str() {
                    if ActionRef::parse_canonical(raw).is_none() {
                        return Err(serde::de::Error::custom(
                            "action string must be a canonical action:<book>/<level>/<template>/<verb> reference",
                        ));
                    }
                    raw.to_owned()
                } else if action.is_object() {
                    let encoded =
                        serde_json::to_string(&action).map_err(serde::de::Error::custom)?;
                    format!("action_json:{encoded}")
                } else {
                    return Err(serde::de::Error::custom(
                        "action must be a canonical string or object",
                    ));
                }
            }
            (Some(_), Some(_)) => {
                return Err(serde::de::Error::custom(
                    "name and action are mutually exclusive",
                ));
            }
            (None, None) => {
                return Err(serde::de::Error::custom(
                    "call_tool requires either name or action",
                ));
            }
        };
        Ok(Self {
            name,
            arguments: wire.arguments,
            revision: wire.revision,
            edited_text: wire.edited_text,
        })
    }
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
    // Bound to this exact version, like prose coverage. A filtered list is
    // useful for local edits but does not authorize whole-view replacement.
    timeline_views: Option<timeline::Coverage>,
}

#[derive(Default)]
struct TurnState {
    reads: HashMap<String, ReadState>,
    conflicts: HashMap<String, u32>,
    checkpointed: HashSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct CatalogCacheKey {
    book: String,
}

type V3CatalogCache = HashMap<CatalogCacheKey, (String, Arc<Catalog>)>;

#[derive(Clone)]
pub struct AgentTools {
    catalog: Arc<Catalog>,
    v3_catalog: Arc<Catalog>,
    v3_cache: Arc<Mutex<V3CatalogCache>>,
    turns: Arc<Mutex<HashMap<TurnKey, TurnState>>>,
    leases: Arc<Mutex<HashMap<String, Weak<AtomicBool>>>>,
    focus: Arc<Mutex<HashMap<String, FocusRequest>>>,
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
            v3_catalog: Arc::new(Catalog::new_v3()),
            v3_cache: Arc::default(),
            turns: Arc::default(),
            leases: Arc::default(),
            focus: Arc::default(),
        }
    }
    pub fn catalog(&self) -> &Catalog {
        &self.catalog
    }

    pub fn set_focus(&self, session: &str, focus: Option<FocusRequest>) {
        let mut map = self.focus.lock().expect("tool focus");
        if let Some(focus) = focus {
            map.insert(session.to_owned(), focus);
        } else {
            map.remove(session);
        }
    }

    pub fn structure_context(
        &self,
        ws: &Workspace,
        book: &BookId,
        focus: Option<&FocusRequest>,
    ) -> Result<Option<StructureContext>> {
        StructureContext::for_book(ws, book, focus)
    }

    pub fn catalog_for_book(&self, ws: &Workspace, book: &BookId) -> Result<Arc<Catalog>> {
        if !is_v3_book(ws, book)? {
            return Ok(Arc::clone(&self.catalog));
        }
        let book_doc = format!("book:{book}");
        let version = ws.observe(&book_doc)?.version;
        let cache_key = CatalogCacheKey {
            book: book.to_string(),
        };
        if let Some((cached_version, cached)) = self
            .v3_cache
            .lock()
            .expect("v3 catalog cache")
            .get(&cache_key)
            .cloned()
            && cached_version == version
        {
            return Ok(cached);
        }
        let catalog = Arc::new(Catalog::for_book(ws, book)?);
        let after = ws.observe(&book_doc)?.version;
        if after == version {
            self.v3_cache
                .lock()
                .expect("v3 catalog cache")
                .insert(cache_key, (version, Arc::clone(&catalog)));
        }
        Ok(catalog)
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
        self.focus.lock().expect("tool focus").remove(session);
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
        let (value, _) = self.invoke_leased_with_resolved(ws, book, actor, request, lease)?;
        Ok(value)
    }

    fn invoke_leased_with_resolved(
        &self,
        ws: &Workspace,
        book: &BookId,
        actor: &Actor,
        request: CallRequest,
        lease: &AtomicBool,
    ) -> Result<(Value, ResolvedCall)> {
        if lease.load(Ordering::SeqCst) {
            return Err(Error::Invalid("the tool session ended".into()));
        }
        let catalog = self.catalog_for_book(ws, book)?;
        let descriptor = request
            .descriptor_in(&catalog, book)?
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
        let canonical_name = request.canonical_name_in(&catalog, book)?;
        let key = turn_key(book, actor);
        let mut resolved = resolve::resolve(ws, book, &canonical_name, request.arguments)?;
        if descriptor.access == ToolAccess::Read {
            if request.edited_text.is_some() {
                return Err(Error::Invalid(
                    "edited_text is only for prose.replace".into(),
                ));
            }
            let value = self.read(ws, actor, &key, &resolved, lease)?;
            return Ok((value, resolved));
        }
        if let Some(edited) = request.edited_text {
            if canonical_name != "prose.replace" {
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
                return Ok((json!({"output":{"unchanged":true},"effects":[]}), resolved));
            };
            resolved.arguments = replacement.input();
        }
        let value = self.write(ws, actor, &key, resolved.clone())?;
        Ok((value, resolved))
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
        let book_id = BookId::parse(&key.book)
            .map_err(|e| Error::Invalid(format!("invalid book id: {e}")))?;
        let is_v3 = is_v3_book(ws, &book_id)?;
        for _ in 0..3 {
            let before = targets
                .iter()
                .map(|doc| ws.observe(doc))
                .collect::<dr_workspace::Result<Vec<_>>>()?;
            let mut value = ws.call(actor, &call.name, call.arguments.clone())?;
            let comments_v2 = if call.name == "prose.read" && !is_v3 {
                Some(ws.call(actor, "comment.list", json!({"book":key.book}))?)
            } else {
                None
            };
            let comments_v3 = if call.name == "prose.read" && is_v3 {
                let doc = ws
                    .library()
                    .load_copy(&book_doc)
                    .map_err(dr_workspace::WsError::from)?;
                let borrowed = dr_doc::v3::BorrowedBookV3::new(&doc, &book_id)
                    .map_err(|e| Error::Invalid(e.to_string()))?;
                Some(borrowed.view().comments())
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
                let anchors = if let Some(v3_list) = &comments_v3 {
                    prose::comment_anchors_v3(doc, v3_list)
                } else {
                    prose::comment_anchors(
                        doc,
                        &comments_v2.as_ref().expect("prose comments")["output"],
                    )
                };
                Some(prose::project(doc, &output, &anchors)?)
            } else {
                None
            };
            let module_prose_doc = if call.name == "module.read_prose" {
                resolve::prose_doc_from_module_args(&call.arguments)
            } else {
                None
            };
            let mut turns = self.turns.lock().expect("tool observations");
            if lease.load(Ordering::SeqCst) {
                return Err(Error::Invalid("the tool session ended".into()));
            }
            let turn = turns.entry(key.clone()).or_default();
            for observation in &after {
                let read = turn.reads.entry(observation.doc.clone()).or_default();
                if read.version != observation.version {
                    *read = ReadState {
                        version: observation.version.clone(),
                        ..Default::default()
                    };
                }
                if call.name == "timeline_view.list" && observation.doc == book_doc {
                    read.timeline_views =
                        Some(timeline::Coverage::from_read(&observation.value, &output)?);
                }
                read.subjects.extend(
                    subjects
                        .iter()
                        .filter(|subject| {
                            if let Some(doc) = subject.strip_prefix("prose:") {
                                doc == observation.doc
                                    || (!after.iter().any(|o| o.doc == doc)
                                        && observation.doc == book_doc)
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
                if let Some(prose_doc) = &module_prose_doc {
                    if observation.doc == *prose_doc
                        && output["version"].as_str() == Some(observation.version.as_str())
                    {
                        for block in output["paragraphs"].as_array().into_iter().flatten() {
                            if let (Some(id), Some(text)) =
                                (block["block_id"].as_str(), block["text"].as_str())
                            {
                                read.blocks.insert(id.into(), text.into());
                            }
                        }
                        read.full_prose = true;
                    } else if observation.doc == book_doc
                        && !after.iter().any(|o| o.doc == *prose_doc)
                    {
                        read.full_prose = true;
                    }
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
        self.write_with_checkpoint(ws, actor, key, call, || {})
    }

    fn write_with_checkpoint(
        &self,
        ws: &Workspace,
        actor: &Actor,
        key: &TurnKey,
        call: ResolvedCall,
        after_checkpoint: impl FnOnce(),
    ) -> Result<Value> {
        let canonical = call.arguments["doc"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| resolve::prose_doc_from_module_args(&call.arguments))
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
        let is_v3 = is_v3_book(
            ws,
            &BookId::parse(&key.book).map_err(|e| Error::Invalid(e.to_string()))?,
        )?;
        let mut guards = {
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
                if !subject_covered(&turn.reads, subject) {
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
            if matches!(
                call.name.as_str(),
                "membership.remove" | "timeline_view.remove"
            ) {
                turn.reads
                    .get(&format!("book:{}", key.book))
                    .and_then(|read| read.timeline_views.as_ref())
                    .ok_or_else(|| Error::ReadRequired("timeline_view:*".into()))?
                    .require_membership_removal()?;
            }
            if matches!(
                call.name.as_str(),
                "timeline_view.put" | "timeline_view.put_pin" | "timeline_view.remove_pin"
            ) {
                let coverage = turn
                    .reads
                    .get(&format!("book:{}", key.book))
                    .and_then(|read| read.timeline_views.as_ref())
                    .ok_or_else(|| Error::ReadRequired("timeline_view:*".into()))?;
                if call.name == "timeline_view.put" {
                    let id = call.arguments["view"]["id"]
                        .as_str()
                        .ok_or_else(|| Error::Invalid("timeline view needs id".into()))?;
                    coverage.require_complete(id)?;
                } else {
                    let view = call.arguments["view"]
                        .as_str()
                        .ok_or_else(|| Error::Invalid("timeline view needs id".into()))?;
                    let pin = if call.name == "timeline_view.put_pin" {
                        &call.arguments["pin"]["id"]
                    } else {
                        &call.arguments["pin"]
                    };
                    coverage.require_pin(
                        view,
                        pin.as_str()
                            .ok_or_else(|| Error::Invalid("timeline pin needs id".into()))?,
                    )?;
                }
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
            } else if call.name == "module.replace_prose" {
                let doc = resolve::prose_doc_from_module_args(&call.arguments)
                    .ok_or_else(|| Error::Invalid("missing prose document".into()))?;
                let read = turn
                    .reads
                    .get(&doc)
                    .ok_or_else(|| Error::ReadRequired(doc.clone()))?;
                let find = call.arguments["find"].as_str().unwrap_or_default();
                let block_id = call.arguments["block_id"].as_str().unwrap_or_default();
                let covered = read
                    .blocks
                    .get(block_id)
                    .is_some_and(|text| text.contains(find));
                if !covered {
                    return Err(Error::ReadRequired(format!("paragraph in {doc}")));
                }
            } else if call.name.starts_with("prose.") || call.name == "module.set_prose" {
                // Link/restore/set_prose operations can touch unshown ranges or whole
                // documents. A partial prose window is insufficient evidence.
                for doc in &call.targets {
                    if !doc.starts_with("book:")
                        && !turn.reads.get(doc).is_some_and(|read| read.full_prose)
                    {
                        return Err(Error::ReadRequired(doc.clone()));
                    }
                }
            }
            if is_v3 && matches!(call.name.as_str(), "comment.create" | "comment.reanchor") {
                for doc in call.targets.iter().filter(|d| !d.starts_with("book:")) {
                    let read = turn
                        .reads
                        .get(doc)
                        .ok_or_else(|| Error::ReadRequired(doc.clone()))?;
                    let whole = ["range", "anchor"]
                        .iter()
                        .any(|k| call.arguments.get(*k).is_some_and(|v| !v.is_null()));
                    let block = call.arguments["block_id"].as_str();
                    if (whole && !read.full_prose)
                        || block.is_some_and(|b| !read.blocks.contains_key(b))
                    {
                        return Err(Error::ReadRequired(format!("source prose in {doc}")));
                    }
                }
            }
            WritePreconditions {
                versions,
                require_all: true,
            }
        };
        let mut captured = Vec::new();
        let result = self
            .checkpoint_before_write(ws, actor, key, &call, &mut guards, &mut captured)
            .and_then(|()| {
                after_checkpoint();
                Ok(ws.call_guarded(actor, &call.name, call.arguments.clone(), guards)?)
            });
        // A later observation could contain unseen concurrent author changes;
        // never refresh an observation implicitly after a write. Read again.
        let mut turns = self.turns.lock().expect("tool observations");
        let turn = turns.entry(key.clone()).or_default();
        for target in &call.targets {
            turn.reads.remove(target);
        }
        // A checkpoint itself changes this book, even for a prose-only call.
        if !captured.is_empty() {
            turn.reads.remove(&format!("book:{}", key.book));
        }
        match result {
            Ok(value) => {
                turn.checkpointed.extend(captured);
                Ok(value)
            }
            Err(Error::Workspace(WsError::Conflict(message)))
                if message.starts_with("stale observation:") =>
            {
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
            Err(Error::Workspace(WsError::Conflict(message)))
                if message.starts_with("read required:") =>
            {
                Err(Error::ReadRequired(message))
            }
            Err(error) => Err(error),
        }
    }
}

fn subject_covered(reads: &HashMap<String, ReadState>, subject: &str) -> bool {
    let has = |candidate: &str| reads.values().any(|read| read.subjects.contains(candidate));
    if has(subject) {
        return true;
    }
    if let Some(id) = subject.strip_prefix("entry:")
        && id != "*"
        && id != "all"
    {
        return has(&format!("level:{id}")) || has("entry:*") || has("entry:all");
    }
    if let Some(rest) = subject.strip_prefix("module_inline:") {
        if has(&format!("module:{rest}")) {
            return true;
        }
        if let Some((entry, _)) = rest.split_once(':') {
            return has(&format!("module:{entry}:*"));
        }
    }
    for prefix in ["entry_template:", "timeline_view:", "entry_relation_type:"] {
        if let Some(id) = subject.strip_prefix(prefix)
            && id != "*"
        {
            return has(&format!("{prefix}*"));
        }
    }
    false
}

impl ToolExecutor for AgentTools {
    fn descriptors(&self) -> Vec<ToolDescriptor> {
        vec![search_descriptor(), call_descriptor()]
    }
    fn describe(&self, call: &ToolCall) -> Option<ToolDescriptor> {
        match call.name.as_str() {
            "tool_search" => Some(search_descriptor()),
            "call_tool" => call.arguments["name"].as_str().and_then(|name| {
                self.catalog
                    .descriptor(name)
                    .or_else(|| self.v3_catalog.descriptor(name))
            }),
            _ => None,
        }
    }
    fn describe_in_book(
        &self,
        workspace: &Workspace,
        book: &BookId,
        call: &ToolCall,
    ) -> Option<ToolDescriptor> {
        match call.name.as_str() {
            "tool_search" => Some(search_descriptor()),
            "call_tool" => {
                let request: CallRequest = serde_json::from_value(call.arguments.clone()).ok()?;
                let catalog = self.catalog_for_book(workspace, book).ok()?;
                match request.descriptor_in(&catalog, book) {
                    Ok(Some(descriptor)) => Some(descriptor),
                    Ok(None) => None,
                    Err(_) => request.is_action().then(|| ToolDescriptor {
                        name: request.name,
                        revision: String::new(),
                        description: String::new(),
                        input_schema: json!({}),
                        access: ToolAccess::Write,
                        policy: ToolPolicy::Local,
                    }),
                }
            }
            _ => None,
        }
    }
    fn finish_session(&self, session: &str) {
        self.forget_session(session);
    }
    fn context(
        &self,
        workspace: &Workspace,
        book: &BookId,
        session: &str,
    ) -> dr_agent::Result<Vec<dr_agent::context::Contribution>> {
        let focus = self.focus.lock().expect("tool focus").get(session).cloned();
        let Some(structure) = self
            .structure_context(workspace, book, focus.as_ref())
            .map_err(|e| dr_agent::Error::Protocol(e.to_string()))?
        else {
            return Ok(Vec::new());
        };
        let contribution = structure
            .to_contribution()
            .map_err(|e| dr_agent::Error::Protocol(e.to_string()))?;
        Ok(vec![contribution])
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
                        let catalog =
                            facade.catalog_for_book(context.workspace(), &context.book)?;
                        match call.name.as_str() {
                            "tool_search" => {
                                let search: Search = serde_json::from_value(call.arguments)
                                    .map_err(|e| Error::Invalid(e.to_string()))?;
                                search.validate()?;
                                Ok(catalog.search(search))
                            }
                            "call_tool" => {
                                let request: CallRequest =
                                    serde_json::from_value(call.arguments)
                                        .map_err(|e| Error::Invalid(e.to_string()))?;
                                if !context.descriptor.revision.is_empty()
                                    && request.descriptor_in(&catalog, &context.book)?.as_ref()
                                        != Some(&context.descriptor)
                                {
                                    return Err(Error::Invalid(
                                        "tool definition changed; search again".into(),
                                    ));
                                }
                                let (value, resolved) = facade.invoke_leased_with_resolved(
                                    context.workspace(),
                                    &context.book,
                                    &context.actor,
                                    request,
                                    &lease,
                                )?;
                                evidence::capture(&context, &resolved, &value)?;
                                Ok(value)
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
    ToolDescriptor{name:"call_tool".into(),revision:"m29-call-v1".into(),description:"Call a discovered book tool or level template action. Read a target before editing it; reread after any conflict. For prose.replace, edited_text may contain the edited projection returned by prose.read. Structural prose edits are not available.".into(),input_schema:json!({"type":"object","properties":{"name":{"type":"string"},"action":{"type":"object","properties":{"level":{"type":"string"},"path":{"type":"array","items":{"type":"string"},"minItems":1},"verb":{"type":"string"}},"required":["verb"],"additionalProperties":false},"arguments":{"type":"object"},"revision":{"type":"string"},"edited_text":{"type":"string"}},"required":["arguments"],"oneOf":[{"required":["name"]},{"required":["action"]}],"additionalProperties":false}),access:ToolAccess::Write,policy:ToolPolicy::Local}
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

#[cfg(test)]
#[path = "checkpoint_tests.rs"]
mod checkpoint_tests;
