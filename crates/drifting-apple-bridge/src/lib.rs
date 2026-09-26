//! Versioned, fixture-only C ABI for the first Apple migration experiment.
//! The production command/query surface will be introduced by domain in P3.
use std::collections::HashMap;
use std::ffi::{c_char, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine};
use drifting_core::database::{DatabaseGateway, DatabaseValue, TransactionBehavior};
use drifting_core::original_body_archive::ArchiveScope;
use drifting_core::prose::{ProseRepository, RevisionSource};
use drifting_core::prose_journal::{AuthoredProseContext, AuthoredProseJournal};
use drifting_document::{
    CommentAnchorRecord, DocumentSession, NativeDraftCommit, NativeDraftStart, NativeInputEdit,
    NativeReplacement, NativeSelectionRequest,
};
use drifting_prose::{DurabilityPhase, DurableDocument};
use serde::Deserialize;
use serde_json::{json, Value};

const CLIENT: &str = "apple-native-lab";
const PROJECT: &str = "native-lab-fixture";
const DATABASE: &str = "native-lab.db";
const NODE: &str = "native-lab-synthetic-prose";
const DOCUMENT: &str = "node-content:native-lab-synthetic-prose";
const GENERATION: &str = "native-lab-synthetic-generation";
const PROJECT_SYNC: &str = "native-lab-synthetic-project-sync";
static NEXT_WRITER: AtomicU64 = AtomicU64::new(1);
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);
static SESSIONS: OnceLock<Mutex<HashMap<u64, LabSession>>> = OnceLock::new();

struct LabSession {
    directory: PathBuf,
    gateway: DatabaseGateway,
    document: DurableDocument,
    save_error: Option<String>,
    persisted_comments: HashMap<String, CommentAnchorRecord>,
}

impl LabSession {
    fn open(directory: &Path) -> Result<Self, String> {
        let gateway = open_fixture(directory)?;
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../docs/apple-native/fixtures/document-v1.json"
        ))
        .map_err(|e| e.to_string())?;
        prepare_document(&gateway, &fixture)?;
        let mut document = DurableDocument::open_for_replay_with_scope(
            gateway.clone(),
            CLIENT,
            lab_scope(&gateway)?,
        )?;
        seed_comments(&gateway, &fixture)?;
        let comments = load_comments(&gateway)?;
        let persisted_comments = comments
            .iter()
            .map(|record| (record.id.clone(), record.clone()))
            .collect();
        document.set_comment_anchors(comments)?;
        let mut session = Self {
            directory: directory.canonicalize().map_err(|e| e.to_string())?,
            gateway,
            document,
            save_error: None,
            persisted_comments,
        };
        // Tail replay may derive a relocation repair. Its journal, snapshot
        // and loaded comment anchors must commit before exposing the owner.
        session.persist_checkpoint()?;
        Ok(session)
    }

    /// Authored bytes, revision/provenance, immutable journal and comment CAS
    /// commit together. The following checkpoint can fail independently; a
    /// retry never authors the committed bytes twice.
    fn persist(&mut self) {
        let error = self.persist_checkpoint().err();
        // A durable but unapplied receipt is distinct from failed local saving.
        self.save_error = if self.document.remote_block().is_some() {
            None
        } else {
            error
        };
    }

    fn write_blocked(&self) -> bool {
        self.save_error.is_some() || self.document.remote_block().is_some()
    }

    fn persist_checkpoint(&mut self) -> Result<(), String> {
        let context = authored_context(&self.gateway)?;
        let mut committed = false;
        let mut comments = None;
        let baseline = &self.persisted_comments;
        let result = self.document.persist_authored(
            &context,
            &RevisionSource::User,
            |gateway, tx, document| {
                let records = document.comment_anchor_records();
                persist_comment_anchors(gateway, tx, &records, baseline)?;
                comments = Some(records);
                Ok(())
            },
            &mut |phase| {
                if phase == DurabilityPhase::AuthoredAfterCommit {
                    committed = true;
                }
            },
        );
        // COMMIT is the boundary even if subsequent replay fails. Reusing the
        // pre-commit CAS baseline would make a safe retry reject our own write.
        if committed {
            self.persisted_comments = comment_map(comments.ok_or("Committed comments missing")?);
        }
        result?;
        let baseline = &self.persisted_comments;
        let mut comments = None;
        self.document.checkpoint(
            &context.now_iso,
            |gateway, tx, document| {
                let records = document.comment_anchor_records();
                persist_comment_anchors(gateway, tx, &records, baseline)?;
                comments = Some(records);
                Ok(())
            },
            &mut |_| {},
        )?;
        self.persisted_comments = comment_map(comments.ok_or("Checkpoint comments missing")?);
        Ok(())
    }

    /// Lab delivery only: it does not implement the production remote reducer,
    /// change-set receipts. Uncovered duplicate bytes share one pending row.
    /// Durability precedes semantic validation and live replay.
    fn apply_remote(&mut self, bytes: &[u8], encoding: u8) -> Result<(), String> {
        let context = authored_context(&self.gateway)?;
        self.document
            .receive_remote(bytes, encoding, &context.now_iso, &mut |_| {})?;
        // persist_authored replays even when there are no authored bytes. Its
        // failure leaves a recoverable tail and blocks further edits/close.
        self.persist();
        Ok(())
    }

    fn document_state(&self) -> Result<Value, String> {
        let remote_block = self
            .document
            .remote_block()
            .map(|block| json!({"updateId":block.update_id,"reason":block.reason}));
        Ok(
            json!({"projection": self.document.native_projection()?, "saved": !self.write_blocked(), "saveError": self.save_error, "remoteBlock": remote_block}),
        )
    }
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Open {
        directory: PathBuf,
    },
    Read {
        handle: u64,
    },
    Rename {
        handle: u64,
        name: String,
    },
    Close {
        handle: u64,
    },
    DocumentRead {
        handle: u64,
    },
    DocumentExport {
        handle: u64,
    },
    DocumentApplyRemote {
        handle: u64,
        update: String,
        encoding: u8,
    },
    DocumentBeginDraft {
        handle: u64,
        start: NativeDraftStart,
    },
    DocumentCommitDraft {
        handle: u64,
        commit: NativeDraftCommit,
    },
    DocumentCancelDraft {
        handle: u64,
        key: String,
    },
    DocumentInputFork {
        handle: u64,
        key: String,
        source: Option<String>,
    },
    DocumentInputDrop {
        handle: u64,
        key: String,
    },
    DocumentInputReplace {
        handle: u64,
        edit: NativeInputEdit,
    },
    DocumentSelect {
        handle: u64,
        selection: NativeSelectionRequest,
    },
    DocumentDropSelection {
        handle: u64,
        #[serde(rename = "viewId")]
        view_id: String,
    },
    DocumentReplace {
        handle: u64,
        edit: NativeReplacement,
    },
    DocumentUndo {
        handle: u64,
    },
    DocumentRedo {
        handle: u64,
    },
    DocumentSave {
        handle: u64,
    },
}

fn text(value: &str) -> DatabaseValue {
    DatabaseValue::Text(value.into())
}

fn nullable_text(value: Option<&str>) -> DatabaseValue {
    value.map(text).unwrap_or(DatabaseValue::Null)
}

fn comment_map(records: Vec<CommentAnchorRecord>) -> HashMap<String, CommentAnchorRecord> {
    records
        .into_iter()
        .map(|record| (record.id.clone(), record))
        .collect()
}

fn persist_comment_anchors(
    gateway: &DatabaseGateway,
    tx: u64,
    comments: &[CommentAnchorRecord],
    baseline: &HashMap<String, CommentAnchorRecord>,
) -> Result<(), String> {
    for record in comments {
        let old = baseline
            .get(&record.id)
            .ok_or("Unloaded comment anchor cannot be overwritten")?;
        if record == old {
            continue;
        }
        let result = gateway.execute("UPDATE comment SET anchor_json = ?, target_block_id = ?, target_block_ids_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND project_id = ? AND target_kind = 'node' AND target_id = ? AND anchor_json = ? AND target_block_id IS ? AND target_block_ids_json = ?".into(),
            vec![text(&record.anchor_json), nullable_text(record.target_block_id.as_deref()), text(&record.target_block_ids_json), text(&record.id), text(PROJECT), text(NODE), text(&old.anchor_json), nullable_text(old.target_block_id.as_deref()), text(&old.target_block_ids_json)], Some(tx), CLIENT.into())?;
        if result.changes != 1 {
            return Err(
                "Comment anchor changed outside this owner; the checkpoint was not committed"
                    .into(),
            );
        }
    }
    Ok(())
}

/// Bind this synthetic document's active lifecycle before accepting any input.
/// The durable owner revalidates the same scope in its loading/writing snapshot.
fn lab_scope(gateway: &DatabaseGateway) -> Result<ArchiveScope, String> {
    let tx = gateway.begin(TransactionBehavior::Deferred, CLIENT.into())?;
    let result = AuthoredProseJournal::new(gateway, CLIENT).current_incarnation(
        tx,
        PROJECT,
        PROJECT_SYNC,
        GENERATION,
        DOCUMENT,
    );
    match result {
        Ok(incarnation) => {
            if let Err(error) = gateway.commit(tx, CLIENT.into()) {
                let _ = gateway.rollback(tx, CLIENT.into());
                return Err(error);
            }
            Ok(ArchiveScope {
                project_id: PROJECT.into(),
                project_sync_id: PROJECT_SYNC.into(),
                sync_generation_id: GENERATION.into(),
                document_id: DOCUMENT.into(),
                incarnation,
            })
        }
        Err(error) => {
            let _ = gateway.rollback(tx, CLIENT.into());
            Err(error)
        }
    }
}

fn authored_context(gateway: &DatabaseGateway) -> Result<AuthoredProseContext, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    let clock = gateway.query(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')".into(),
        vec![],
        None,
        CLIENT.into(),
    )?;
    let Some([DatabaseValue::Text(now_iso)]) = clock.rows.first().map(Vec::as_slice) else {
        return Err("Invalid lab clock".into());
    };
    let token = format!(
        "lab-{}-{}-{}",
        std::process::id(),
        now.as_nanos(),
        NEXT_WRITER.fetch_add(1, Ordering::Relaxed)
    );
    Ok(AuthoredProseContext {
        project_id: PROJECT.into(),
        project_sync_id: PROJECT_SYNC.into(),
        sync_generation_id: GENERATION.into(),
        installation_id: "native-lab-synthetic-installation".into(),
        new_writer_id: format!("{token}-writer"),
        new_writer_epoch: format!("{token}-epoch"),
        now_ms: now
            .as_millis()
            .try_into()
            .map_err(|_| "Lab clock overflow")?,
        now_iso: now_iso.clone(),
    })
}

/// Only the old lab's synthetic storage key is upgraded here. Released domain
/// migrations remain immutable. Merge both snapshots before moving old tail IDs.
fn prepare_document(gateway: &DatabaseGateway, fixture: &Value) -> Result<(), String> {
    let tx = gateway.begin(TransactionBehavior::Immediate, CLIENT.into())?;
    let result = (|| {
        let repository = ProseRepository::new(gateway, CLIENT);
        let current = repository.get_snapshot(DOCUMENT, Some(tx))?;
        let legacy = repository.get_snapshot(NODE, Some(tx))?;
        if current.is_none() || legacy.is_some() {
            let mut document = DocumentSession::new();
            if let Some(snapshot) = &current {
                document.apply_remote(&snapshot.state_blob, 1)?;
            }
            if let Some(snapshot) = &legacy {
                document.apply_remote(&snapshot.state_blob, 1)?;
            }
            if current.is_none() && legacy.is_none() {
                let bytes = STANDARD
                    .decode(
                        fixture["updateBase64"]
                            .as_str()
                            .ok_or("Synthetic document missing")?,
                    )
                    .map_err(|e| e.to_string())?;
                document.apply_remote(&bytes, 1)?;
            }
            repository.save_snapshot(
                DOCUMENT,
                &document.update(None, 1)?,
                "synthetic-bootstrap",
                Some(tx),
            )?;
        }
        gateway.execute(
            "UPDATE yjs_updates SET document_id = ? WHERE document_id = ?".into(),
            vec![text(DOCUMENT), text(NODE)],
            Some(tx),
            CLIENT.into(),
        )?;
        gateway.execute(
            "DELETE FROM yjs_snapshots WHERE document_id = ?".into(),
            vec![text(NODE)],
            Some(tx),
            CLIENT.into(),
        )?;
        gateway.commit(tx, CLIENT.into())
    })();
    if let Err(error) = result {
        let _ = gateway.rollback(tx, CLIENT.into());
        return Err(error);
    }
    Ok(())
}

fn seed_comments(gateway: &DatabaseGateway, fixture: &Value) -> Result<(), String> {
    fn block_text(node: &Value, id: &str) -> Option<String> {
        if node["attrs"]["id"].as_str() == Some(id) {
            return Some(
                node["content"]
                    .as_array()?
                    .iter()
                    .filter_map(|part| part["text"].as_str())
                    .collect(),
            );
        }
        node["content"]
            .as_array()?
            .iter()
            .find_map(|child| block_text(child, id))
    }
    for comment in fixture["comments"]
        .as_array()
        .ok_or("Synthetic comments missing")?
    {
        let id = comment["id"]
            .as_str()
            .ok_or("Synthetic comment ID missing")?;
        let ids: Vec<String> =
            serde_json::from_value(comment["targetBlockIds"].clone()).map_err(|e| e.to_string())?;
        let snapshots: Vec<_> = ids.iter().map(|id| json!({"blockId": id, "blockText": block_text(&fixture["semantic"], id).unwrap_or_default()})).collect();
        let payload = json!({"textAnchor":comment["textAnchor"], "selectedText":comment["textAnchor"]["text"], "blockSnapshots":snapshots});
        gateway.execute("INSERT INTO comment (id, project_id, target_kind, target_id, target_block_id, target_block_ids_json, anchor_json, body_json, created_at, updated_at) VALUES (?, ?, 'node', ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(id) DO NOTHING".into(),
            vec![text(id),text(PROJECT),text(NODE),nullable_text(ids.first().map(String::as_str)),text(&json!(ids).to_string()),text(&payload.to_string()),text(&json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"合成评论：核对地名。"}]}]}).to_string())], None, CLIENT.into())?;
    }
    Ok(())
}

fn load_comments(gateway: &DatabaseGateway) -> Result<Vec<CommentAnchorRecord>, String> {
    let result = gateway.query("SELECT id, anchor_json, target_block_id, target_block_ids_json FROM comment WHERE project_id = ? AND target_kind = 'node' AND target_id = ? ORDER BY id".into(), vec![text(PROJECT),text(NODE)],None,CLIENT.into())?;
    result.rows.into_iter().map(|row| {
        let [DatabaseValue::Text(id),DatabaseValue::Text(anchor),block,DatabaseValue::Text(ids)] = row.as_slice() else {return Err("Invalid synthetic comment row".into());};
        let target_block_id = match block {DatabaseValue::Null => None, DatabaseValue::Text(id) => Some(id.clone()), _ => return Err("Invalid synthetic comment target".into())};
        Ok(CommentAnchorRecord {id:id.clone(),anchor_json:anchor.clone(),target_block_id,target_block_ids_json:ids.clone()})
    }).collect()
}

fn read_project(gateway: &DatabaseGateway, handle: u64) -> Result<Value, String> {
    let result = gateway.query(
        "SELECT id, name FROM project WHERE id = ? AND user_id = ?".into(),
        vec![text(PROJECT), text(CLIENT)],
        None,
        CLIENT.into(),
    )?;
    let Some(row) = result.rows.first() else {
        return Err("The synthetic project is missing".into());
    };
    let [DatabaseValue::Text(id), DatabaseValue::Text(name)] = row.as_slice() else {
        return Err("Unexpected project representation".into());
    };
    Ok(json!({ "handle": handle, "projectId": id, "name": name }))
}

fn open_fixture(directory: &Path) -> Result<DatabaseGateway, String> {
    // This pre-P3 bridge must never attach to the author's ordinary library.
    if !directory.is_absolute() || directory.file_name().and_then(|v| v.to_str()) != Some(CLIENT) {
        return Err("The lab requires its own absolute apple-native-lab directory".into());
    }
    std::fs::create_dir_all(directory).map_err(|_| "Cannot prepare the lab directory")?;
    if std::fs::symlink_metadata(directory)
        .map_err(|_| "Cannot inspect the lab directory")?
        .file_type()
        .is_symlink()
    {
        return Err("The lab directory must not be a symlink".into());
    }
    let gateway = DatabaseGateway::new(directory.to_path_buf())?;
    gateway.open(DATABASE.into(), CLIENT.into(), false)?;
    gateway.execute(
        "INSERT INTO project (id, name, user_id, created_at, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(id) DO NOTHING".into(),
        vec![text(PROJECT), text("原生写作实验"), text(CLIENT)], None, CLIENT.into(),
    )?;
    // Synthetic bootstrap only. Authored entity.create and full domain lifecycle
    // creation are P3 work; this lab never claims a production workspace import.
    gateway.execute("INSERT INTO book_node (id, title, project_id, position_x, position_y, created_at, updated_at) VALUES (?, ?, ?, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(id) DO NOTHING".into(), vec![text(NODE), text("合成章节"), text(PROJECT)], None, CLIENT.into())?;
    gateway.execute("INSERT INTO sync_generation (sync_generation_id, project_id, project_sync_id, created_at, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(sync_generation_id) DO NOTHING".into(), vec![text(GENERATION), text(PROJECT), text(PROJECT_SYNC)], None, CLIENT.into())?;
    Ok(gateway)
}

fn dispatch(request: Request) -> Result<Value, String> {
    let mut sessions = SESSIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "The lab session registry is unavailable")?;
    match request {
        Request::Open { directory } => {
            if let Ok(path) = directory.canonicalize() {
                if sessions.values().any(|session| session.directory == path) {
                    return Err("The synthetic workspace already has a live owner".into());
                }
            }
            let session = LabSession::open(&directory)?;
            let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
            let state = read_project(&session.gateway, handle)?;
            sessions.insert(handle, session);
            Ok(state)
        }
        Request::Read { handle } => read_project(
            &sessions
                .get(&handle)
                .ok_or("Unknown or closed session")?
                .gateway,
            handle,
        ),
        Request::Rename { handle, name } => {
            let name = name.trim();
            if name.is_empty() || name.chars().count() > 200 {
                return Err("Project names must contain between 1 and 200 characters".into());
            }
            let gateway = &sessions
                .get(&handle)
                .ok_or("Unknown or closed session")?
                .gateway;
            gateway.execute(
                "UPDATE project SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND user_id = ?".into(),
                vec![text(name), text(PROJECT), text(CLIENT)], None, CLIENT.into(),
            )?;
            read_project(gateway, handle)
        }
        Request::Close { handle } => {
            let session = sessions
                .get_mut(&handle)
                .ok_or("Unknown or closed session")?;
            if let Some(block) = session.document.remote_block() {
                return Err(format!(
                    "Stored remote update {} is unapplied; the live owner is retained",
                    block.update_id
                ));
            }
            if session.save_error.is_some() {
                return Err("Unsaved prose remains in memory; retry save before closing".into());
            }
            if session.document.active_drafts() > 0
                || session.document.active_input_compositions() > 0
            {
                return Err(
                    "An unsubmitted native draft is active; commit or cancel before closing".into(),
                );
            }
            // Notifications are hints; release always consumes committed tail.
            session.persist();
            if let Some(block) = session.document.remote_block() {
                return Err(format!(
                    "Stored remote update {} is unapplied; the live owner is retained: {}",
                    block.update_id, block.reason
                ));
            }
            if let Some(error) = &session.save_error {
                return Err(format!(
                    "Final checkpoint failed; the live owner is retained: {error}"
                ));
            }
            session.gateway.close(CLIENT.into())?;
            sessions.remove(&handle);
            Ok(Value::Null)
        }
        Request::DocumentRead { handle } => sessions
            .get(&handle)
            .ok_or("Unknown or closed session")?
            .document_state(),
        Request::DocumentExport { handle } => {
            let session = sessions.get(&handle).ok_or("Unknown or closed session")?;
            if session.write_blocked() {
                return Err("Stored remote updates remain unapplied; a bare checkpoint would omit their retained bytes".into());
            }
            Ok(
                json!({"update": STANDARD.encode(session.document.update(None, 1)?),
                "stateVector": STANDARD.encode(session.document.state_vector())}),
            )
        }
        Request::DocumentApplyRemote {
            handle,
            update,
            encoding,
        } => {
            let session = sessions
                .get_mut(&handle)
                .ok_or("Unknown or closed session")?;
            let bytes = STANDARD
                .decode(update)
                .map_err(|_| "Invalid remote update base64")?;
            session.apply_remote(&bytes, encoding)?;
            session.document_state()
        }
        Request::DocumentBeginDraft { handle, start } => {
            let session = sessions
                .get_mut(&handle)
                .ok_or("Unknown or closed session")?;
            if session.write_blocked() {
                return Err("Retry the pending save before composing".into());
            }
            session.document.begin_draft(start)?;
            Ok(Value::Null)
        }
        Request::DocumentCommitDraft { handle, commit } => {
            let session = sessions
                .get_mut(&handle)
                .ok_or("Unknown or closed session")?;
            if session.write_blocked() {
                return Err("Retry the pending save before committing the draft".into());
            }
            session.document.commit_draft(commit)?;
            session.persist();
            session.document_state()
        }
        Request::DocumentCancelDraft { handle, key } => {
            sessions
                .get_mut(&handle)
                .ok_or("Unknown or closed session")?
                .document
                .cancel_draft(&key);
            Ok(Value::Null)
        }
        Request::DocumentInputFork {
            handle,
            key,
            source,
        } => {
            let session = sessions
                .get_mut(&handle)
                .ok_or("Unknown or closed session")?;
            let input = session.document.fork_input(key, source.as_deref())?;
            Ok(json!({"input":input, "state":session.document_state()?}))
        }
        Request::DocumentInputDrop { handle, key } => {
            sessions
                .get_mut(&handle)
                .ok_or("Unknown or closed session")?
                .document
                .drop_input(&key);
            Ok(Value::Null)
        }
        Request::DocumentInputReplace { handle, edit } => {
            let session = sessions
                .get_mut(&handle)
                .ok_or("Unknown or closed session")?;
            if session.write_blocked() {
                return Err("Retry pending save before input".into());
            }
            let input = session.document.replace_input(edit)?;
            session.persist();
            Ok(json!({"input":input, "state":session.document_state()?}))
        }
        Request::DocumentSelect { handle, selection } => {
            let session = sessions
                .get_mut(&handle)
                .ok_or("Unknown or closed session")?;
            let view_id = selection.view_id.clone();
            session.document.set_selection(selection)?;
            let projection = session.document.native_projection()?;
            Ok(
                json!({"revision":projection.revision,"selection":projection.selections.into_iter().find(|item|item.view_id == view_id)}),
            )
        }
        Request::DocumentDropSelection { handle, view_id } => {
            sessions
                .get_mut(&handle)
                .ok_or("Unknown or closed session")?
                .document
                .drop_selection(&view_id);
            Ok(Value::Null)
        }
        Request::DocumentReplace { handle, edit } => {
            let session = sessions
                .get_mut(&handle)
                .ok_or("Unknown or closed session")?;
            if session.write_blocked() {
                return Err("Retry the pending save before another edit".into());
            }
            session.document.replace_native(edit)?;
            session.persist();
            session.document_state()
        }
        Request::DocumentUndo { handle }
        | Request::DocumentRedo { handle }
        | Request::DocumentSave { handle } => {
            let session = sessions
                .get_mut(&handle)
                .ok_or("Unknown or closed session")?;
            if !matches!(request, Request::DocumentSave { .. }) && session.write_blocked() {
                return Err("Retry the pending save before changing history".into());
            }
            if !matches!(request, Request::DocumentSave { .. })
                && (session.document.active_drafts() > 0
                    || session.document.active_input_compositions() > 0)
            {
                return Err("Commit or cancel active drafts before changing local history".into());
            }
            match request {
                Request::DocumentUndo { .. } => {
                    session.document.try_undo()?;
                }
                Request::DocumentRedo { .. } => {
                    session.document.try_redo()?;
                }
                _ => {}
            }
            session.persist();
            session.document_state()
        }
    }
}

fn reply(input: &str) -> Value {
    match serde_json::from_str::<Request>(input)
        .map_err(|e| e.to_string())
        .and_then(dispatch)
    {
        Ok(value) => json!({"abiVersion": 1, "ok": true, "value": value}),
        Err(error) => json!({"abiVersion": 1, "ok": false, "error": error}),
    }
}

/// Invoke ABI v1. Calls may block on SQLite; hosts must use a serial background queue.
///
/// # Safety
/// `input` must be null or point to a valid NUL-terminated UTF-8 string for this call.
/// Free the returned string exactly once using `drifting_lab_free`.
#[no_mangle]
pub unsafe extern "C" fn drifting_lab_call(input: *const c_char) -> *mut c_char {
    let value = std::panic::catch_unwind(|| {
        if input.is_null() {
            return json!({"abiVersion": 1, "ok": false, "error": "Null request"});
        }
        match unsafe { CStr::from_ptr(input) }.to_str() {
            Ok(input) => reply(input),
            Err(_) => json!({"abiVersion": 1, "ok": false, "error": "Request must be UTF-8"}),
        }
    })
    .unwrap_or_else(|_| json!({"abiVersion": 1, "ok": false, "error": "Core operation failed"}));
    CString::new(value.to_string())
        .expect("JSON cannot contain raw NUL")
        .into_raw()
}

/// # Safety
/// `value` must be null or an unfreed pointer returned by `drifting_lab_call`.
#[no_mangle]
pub unsafe extern "C" fn drifting_lab_free(value: *mut c_char) {
    if !value.is_null() {
        drop(unsafe { CString::from_raw(value) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call(value: Value) -> Value {
        let input = CString::new(value.to_string()).unwrap();
        let result = unsafe { drifting_lab_call(input.as_ptr()) };
        let output: Value =
            serde_json::from_slice(unsafe { CStr::from_ptr(result) }.to_bytes()).unwrap();
        unsafe { drifting_lab_free(result) };
        output
    }

    fn count_rows(gateway: &DatabaseGateway, table: &str) -> u64 {
        let rows = gateway
            .query(
                format!("SELECT count(*) FROM {table}"),
                vec![],
                None,
                CLIENT.into(),
            )
            .unwrap();
        let DatabaseValue::Integer(value) = &rows.rows[0][0] else {
            panic!("Expected count")
        };
        value.parse().unwrap()
    }

    fn edited_peer(base: &[u8], client: u64, value: &str) -> DocumentSession {
        let mut peer = DocumentSession::with_test_client_id(client).unwrap();
        peer.apply_remote(base, 1).unwrap();
        peer.edit(drifting_document::Edit::Insert {
            block: "fixture-paragraph".into(),
            offset: 0,
            text: value.into(),
        })
        .unwrap();
        peer
    }

    #[test]
    fn abi_distinguishes_stored_remote_from_applied_and_retains_blocked_owner() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(CLIENT);
        let opened = call(json!({"operation":"open", "directory":directory}));
        let handle = opened["value"]["handle"].as_u64().unwrap();
        let (late, baseline) = {
            let mut sessions = SESSIONS.get().unwrap().lock().unwrap();
            let session = sessions.get_mut(&handle).unwrap();
            let base = session.document.update(None, 1).unwrap();
            let mut peer = DocumentSession::with_test_client_id(61901).unwrap();
            peer.apply_remote(&base, 1).unwrap();
            let log = peer.capture_authored_updates().unwrap();
            peer.edit(drifting_document::Edit::Insert {
                block: "fixture-paragraph".into(),
                offset: 0,
                text: "保".into(),
            })
            .unwrap();
            session
                .document
                .edit(drifting_document::Edit::DeleteBlock {
                    block: "fixture-paragraph".into(),
                })
                .unwrap();
            session.persist();
            assert!(!session.write_blocked());
            (log.drain().remove(0), session.document_state().unwrap())
        };
        let delivered = call(
            json!({"operation":"documentApplyRemote", "handle":handle,"update":STANDARD.encode(&late),"encoding":1}),
        );
        assert_eq!(delivered["ok"], true, "{delivered}");
        let blocked = &delivered["value"];
        assert_eq!(blocked["saved"], false);
        assert_eq!(blocked["saveError"], Value::Null);
        assert_eq!(blocked["projection"], baseline["projection"]);
        let block_id = blocked["remoteBlock"]["updateId"].as_u64().unwrap();
        assert!(blocked["remoteBlock"]["reason"]
            .as_str()
            .unwrap()
            .contains("REMOTE_TEXT_RETENTION_REQUIRED"));
        for operation in ["documentSave", "documentApplyRemote", "documentSave"] {
            let request = if operation == "documentApplyRemote" {
                json!({"operation":operation,"handle":handle,"update":STANDARD.encode(&late),"encoding":1})
            } else {
                json!({"operation":operation,"handle":handle})
            };
            let retried = call(request);
            assert_eq!(retried["ok"], true, "{retried}");
            assert_eq!(retried["value"], *blocked);
        }
        for operation in ["documentUndo", "documentRedo", "documentExport", "close"] {
            assert_eq!(
                call(json!({"operation":operation,"handle":handle}))["ok"],
                false
            );
        }
        assert_eq!(
            call(json!({"operation":"documentRead","handle":handle}))["value"],
            *blocked
        );
        let session = SESSIONS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .remove(&handle)
            .unwrap();
        let rows = ProseRepository::new(&session.gateway, CLIENT)
            .list_updates(DOCUMENT, None, None)
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, block_id);
        assert_eq!(rows[0].update_blob, late);
        session.gateway.close(CLIENT.into()).unwrap();
        let error = match LabSession::open(&directory) {
            Ok(_) => panic!("Unsafe persisted tail must stop reopen"),
            Err(error) => error,
        };
        assert!(error.contains("original bytes retained"), "{error}");
    }

    #[test]
    fn old_lab_keys_merge_snapshots_and_tail_without_losing_content_or_comment_targets() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(CLIENT);
        let session = LabSession::open(&directory).unwrap();
        let base = session.document.update(None, 1).unwrap();
        let mut legacy = edited_peer(&base, 61001, "旧快照");
        let canonical = edited_peer(&base, 61002, "新快照");
        let repo = ProseRepository::new(&session.gateway, CLIENT);
        repo.save_snapshot(
            NODE,
            &legacy.update(None, 1).unwrap(),
            "legacy-fixture",
            None,
        )
        .unwrap();
        repo.save_snapshot(
            DOCUMENT,
            &canonical.update(None, 1).unwrap(),
            "current-fixture",
            None,
        )
        .unwrap();
        let vector = legacy.state_vector();
        legacy
            .edit(drifting_document::Edit::Insert {
                block: "fixture-paragraph".into(),
                offset: 0,
                text: "旧尾日志".into(),
            })
            .unwrap();
        // Exact old lab tail: it had no semantic revision/journal writer.
        session
            .gateway
            .execute(
                "INSERT INTO yjs_updates (document_id,update_blob,created_at) VALUES (?,?,?)"
                    .into(),
                vec![
                    text(NODE),
                    DatabaseValue::Blob(legacy.update(Some(&vector), 1).unwrap()),
                    text("legacy-tail"),
                ],
                None,
                CLIENT.into(),
            )
            .unwrap();
        session.gateway.close(CLIENT.into()).unwrap();
        let recovered = LabSession::open(&directory).unwrap();
        assert!(recovered.save_error.is_none(), "{:?}", recovered.save_error);
        let projection = recovered.document.native_projection().unwrap();
        for value in ["旧快照", "新快照", "旧尾日志"] {
            assert!(projection.text.contains(value), "{}", projection.text);
        }
        assert_eq!(projection.comments.len(), 1);
        assert_eq!(projection.comments[0].quote, "北塔");
        assert_eq!(load_comments(&recovered.gateway).unwrap().len(), 1);
        assert!(ProseRepository::new(&recovered.gateway, CLIENT)
            .get_snapshot(NODE, None)
            .unwrap()
            .is_none());
        assert_eq!(count_rows(&recovered.gateway, "yjs_updates"), 0);
        assert_eq!(count_rows(&recovered.gateway, "sync_change_set"), 0);
        recovered.gateway.close(CLIENT.into()).unwrap();
        let reopened = LabSession::open(&directory).unwrap();
        assert_eq!(
            reopened.document.native_projection().unwrap().text,
            projection.text
        );
    }

    #[test]
    fn authored_commit_survives_checkpoint_failure_without_duplicate_journal_or_stale_comment_cas()
    {
        let temp = tempfile::tempdir().unwrap();
        let mut session = LabSession::open(&temp.path().join(CLIENT)).unwrap();
        let original_snapshot = snapshot(&session);
        session.gateway.execute("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON yjs_snapshots BEGIN SELECT RAISE(ABORT, 'checkpoint unavailable'); END".into(), vec![], None, CLIENT.into()).unwrap();
        edit_comment_prefix(&mut session);
        session.persist();
        assert!(session
            .save_error
            .as_ref()
            .unwrap()
            .contains("checkpoint unavailable"));
        assert_eq!(snapshot(&session), original_snapshot);
        assert_eq!(count_rows(&session.gateway, "yjs_updates"), 1);
        for table in [
            "sync_change_set",
            "sync_mutation",
            "sync_apply_receipt",
            "yjs_document_revision_provenance",
        ] {
            assert_eq!(count_rows(&session.gateway, table), 1, "{table}");
        }
        assert_eq!(
            ProseRepository::new(&session.gateway, CLIENT)
                .get_revision(DOCUMENT, None)
                .unwrap(),
            1
        );
        assert_eq!(
            session.persisted_comments,
            comment_map(load_comments(&session.gateway).unwrap())
        );
        assert!(!session.document.has_uncommitted_updates());
        session
            .gateway
            .execute(
                "DROP TRIGGER fail_checkpoint".into(),
                vec![],
                None,
                CLIENT.into(),
            )
            .unwrap();
        session.persist();
        assert!(session.save_error.is_none(), "{:?}", session.save_error);
        assert_eq!(count_rows(&session.gateway, "yjs_updates"), 0);
        assert_eq!(count_rows(&session.gateway, "sync_apply_receipt"), 1);
        assert_eq!(
            ProseRepository::new(&session.gateway, CLIENT)
                .get_revision(DOCUMENT, None)
                .unwrap(),
            1
        );
        assert!(session.document.undo());
        session.persist();
        assert!(session.save_error.is_none());
        assert!(session.document.redo());
        session.persist();
        assert!(session.save_error.is_none());
        assert_eq!(count_rows(&session.gateway, "sync_apply_receipt"), 3);
        assert_eq!(
            ProseRepository::new(&session.gateway, CLIENT)
                .get_revision(DOCUMENT, None)
                .unwrap(),
            3
        );
    }

    #[test]
    fn remote_delivery_commits_before_live_replay_and_does_not_author_local_journal() {
        let temp = tempfile::tempdir().unwrap();
        let mut session = LabSession::open(&temp.path().join(CLIENT)).unwrap();
        let base = session.document.update(None, 1).unwrap();
        let peer = edited_peer(&base, 62001, "提交后才可见");
        let update = peer
            .update(Some(&session.document.state_vector()), 1)
            .unwrap();
        let before = session.document.native_projection().unwrap().text;
        session.gateway.execute("CREATE TRIGGER fail_remote BEFORE INSERT ON yjs_updates BEGIN SELECT RAISE(ABORT, 'remote write unavailable'); END".into(),vec![],None,CLIENT.into()).unwrap();
        assert!(session
            .apply_remote(&update, 1)
            .unwrap_err()
            .contains("remote write unavailable"));
        assert_eq!(session.document.native_projection().unwrap().text, before);
        assert_eq!(
            ProseRepository::new(&session.gateway, CLIENT)
                .get_revision(DOCUMENT, None)
                .unwrap(),
            0
        );
        assert_eq!(
            count_rows(&session.gateway, "yjs_document_revision_provenance"),
            0
        );
        session
            .gateway
            .execute(
                "DROP TRIGGER fail_remote".into(),
                vec![],
                None,
                CLIENT.into(),
            )
            .unwrap();
        session.apply_remote(&update, 1).unwrap();
        assert!(session.save_error.is_none(), "{:?}", session.save_error);
        assert!(session
            .document
            .native_projection()
            .unwrap()
            .text
            .contains("提交后才可见"));
        assert_eq!(count_rows(&session.gateway, "sync_change_set"), 0);
        let provenance = session
            .gateway
            .query(
                "SELECT source_kind FROM yjs_document_revision_provenance WHERE document_id = ?"
                    .into(),
                vec![text(DOCUMENT)],
                None,
                CLIENT.into(),
            )
            .unwrap();
        assert_eq!(provenance.rows, vec![vec![text("remote")]]);
    }

    #[test]
    fn sparse_remote_dependencies_survive_checkpoint_reopen_and_later_delivery() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(CLIENT);
        let mut session = LabSession::open(&directory).unwrap();
        let mut peer = DocumentSession::with_test_client_id(64001).unwrap();
        peer.apply_remote(&session.document.update(None, 1).unwrap(), 1)
            .unwrap();
        let mut updates = Vec::new();
        for value in ["甲", "乙", "丙"] {
            let vector = peer.state_vector();
            peer.edit(drifting_document::Edit::Insert {
                block: "fixture-paragraph".into(),
                offset: 0,
                text: value.into(),
            })
            .unwrap();
            updates.push(peer.update(Some(&vector), 1).unwrap());
        }
        session.apply_remote(&updates[2], 1).unwrap();
        assert!(session.save_error.is_none(), "{:?}", session.save_error);
        assert!(session.document.has_pending());
        assert_eq!(count_rows(&session.gateway, "yjs_updates"), 0);
        session.gateway.close(CLIENT.into()).unwrap();
        let mut reopened = LabSession::open(&directory).unwrap();
        assert!(
            reopened.document.has_pending(),
            "Checkpoint must retain dependency holes"
        );
        reopened.apply_remote(&updates[1], 1).unwrap();
        assert!(reopened.document.has_pending());
        reopened.apply_remote(&updates[0], 1).unwrap();
        assert!(reopened.save_error.is_none(), "{:?}", reopened.save_error);
        assert!(!reopened.document.has_pending());
        assert_eq!(
            reopened.document.native_projection().unwrap().text,
            peer.native_projection().unwrap().text
        );
        assert!(
            !reopened.document.undo(),
            "Remote delivery must not enter local history"
        );
        assert_eq!(count_rows(&reopened.gateway, "sync_change_set"), 0);
        assert_eq!(
            ProseRepository::new(&reopened.gateway, CLIENT)
                .get_revision(DOCUMENT, None)
                .unwrap(),
            3
        );
        reopened.gateway.close(CLIENT.into()).unwrap();
        let final_owner = LabSession::open(&directory).unwrap();
        assert!(!final_owner.document.has_pending());
        assert_eq!(
            final_owner.document.native_projection().unwrap().text,
            peer.native_projection().unwrap().text
        );
    }

    #[test]
    fn final_close_replays_committed_remote_tail_after_lost_notification() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(CLIENT);
        let opened = call(json!({"operation":"open","directory":directory}));
        let handle = opened["value"]["handle"].as_u64().unwrap();
        {
            let sessions = SESSIONS.get().unwrap().lock().unwrap();
            let session = &sessions[&handle];
            let peer = edited_peer(
                &session.document.update(None, 1).unwrap(),
                63001,
                "回调丢失仍恢复",
            );
            let update = peer
                .update(Some(&session.document.state_vector()), 1)
                .unwrap();
            ProseRepository::new(&session.gateway, CLIENT)
                .append_update(
                    DOCUMENT,
                    &update,
                    &RevisionSource::Remote,
                    "synthetic-remote",
                    None,
                    None,
                )
                .unwrap();
            assert!(!session
                .document
                .native_projection()
                .unwrap()
                .text
                .contains("回调丢失仍恢复"));
        }
        let closed = call(json!({"operation":"close","handle":handle}));
        assert_eq!(closed["ok"], true, "{closed}");
        let reopened = LabSession::open(&directory).unwrap();
        assert!(reopened
            .document
            .native_projection()
            .unwrap()
            .text
            .contains("回调丢失仍恢复"));
        assert_eq!(count_rows(&reopened.gateway, "yjs_updates"), 0);
        assert_eq!(count_rows(&reopened.gateway, "sync_change_set"), 0);
        assert_eq!(
            ProseRepository::new(&reopened.gateway, CLIENT)
                .get_revision(DOCUMENT, None)
                .unwrap(),
            1
        );
    }

    #[test]
    fn input_branches_checkpoint_once_and_guard_active_composition() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(CLIENT);
        let opened = call(json!({"operation":"open","directory":directory}));
        let handle = opened["value"]["handle"].as_u64().unwrap();
        assert_eq!(
            call(json!({"operation":"documentInputFork","handle":handle,"key":"shared"}))["ok"],
            true
        );
        assert_eq!(
            call(
                json!({"operation":"documentInputFork","handle":handle,"key":"ime","source":"shared"})
            )["ok"],
            true
        );
        assert_eq!(
            call(json!({"operation":"close","handle":handle}))["ok"],
            false
        );
        assert_eq!(
            call(json!({"operation":"documentUndo","handle":handle}))["ok"],
            false
        );
        {
            let sessions = SESSIONS.get().unwrap().lock().unwrap();
            let gateway = &sessions[&handle].gateway;
            gateway.execute("CREATE TRIGGER fail_input BEFORE UPDATE ON yjs_snapshots BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END".into(), vec![], None, CLIENT.into()).unwrap();
        }
        let edit =
            json!({"key":"ime","sequence":0,"range":{"location":0,"length":0},"text":"唯一输入"});
        let failed = call(json!({"operation":"documentInputReplace","handle":handle,"edit":edit}));
        assert_eq!(failed["ok"], true, "{failed}");
        assert_eq!(failed["value"]["state"]["saved"], false);
        assert_eq!(
            call(json!({"operation":"documentInputReplace","handle":handle,"edit":edit}))["ok"],
            false
        );
        {
            let sessions = SESSIONS.get().unwrap().lock().unwrap();
            sessions[&handle]
                .gateway
                .execute(
                    "DROP TRIGGER fail_input".into(),
                    vec![],
                    None,
                    CLIENT.into(),
                )
                .unwrap();
        }
        assert_eq!(
            call(json!({"operation":"documentSave","handle":handle}))["value"]["saved"],
            true
        );
        assert_eq!(
            call(json!({"operation":"documentInputReplace","handle":handle,"edit":edit}))["ok"],
            false
        );
        assert_eq!(
            call(json!({"operation":"close","handle":handle}))["ok"],
            true
        );
        let reopened = call(json!({"operation":"open","directory":directory}));
        let handle = reopened["value"]["handle"].as_u64().unwrap();
        let saved = call(json!({"operation":"documentRead","handle":handle}));
        assert_eq!(
            saved["value"]["projection"]["text"]
                .as_str()
                .unwrap()
                .matches("唯一输入")
                .count(),
            1
        );
        assert_eq!(
            call(json!({"operation":"documentInputReplace","handle":handle,"edit":edit}))["ok"],
            false
        );
        assert_eq!(
            call(json!({"operation":"close","handle":handle}))["ok"],
            true
        );
    }

    #[test]
    fn draft_remote_abi_preserves_concurrent_text_and_survives_checkpoint_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(CLIENT);
        let opened = call(json!({"operation":"open","directory":directory}));
        let handle = opened["value"]["handle"].as_u64().unwrap();
        let state = call(json!({"operation":"documentRead","handle":handle}));
        let range = state["value"]["projection"]["comments"][0]["ranges"][0].clone();
        let revision = state["value"]["projection"]["revision"].clone();
        let exported = call(json!({"operation":"documentExport","handle":handle}));
        assert_eq!(
            call(
                json!({"operation":"documentBeginDraft","handle":handle,"start":{"key":"ime","revision":revision,"range":range}})
            )["ok"],
            true
        );
        assert_eq!(
            call(json!({"operation":"close","handle":handle}))["ok"],
            false
        );
        assert_eq!(
            call(json!({"operation":"documentUndo","handle":handle}))["ok"],
            false
        );
        assert_eq!(
            call(json!({"operation":"documentExport","handle":handle}))["value"],
            exported["value"]
        );
        let mut peer = DocumentSession::with_test_client_id(32001).unwrap();
        peer.apply_remote(
            &STANDARD
                .decode(exported["value"]["update"].as_str().unwrap())
                .unwrap(),
            1,
        )
        .unwrap();
        let vector = peer.state_vector();
        peer.edit(drifting_document::Edit::Insert {
            block: "fixture-paragraph".into(),
            offset: 6,
            text: "远端".into(),
        })
        .unwrap();
        let update = STANDARD.encode(peer.update(Some(&vector), 1).unwrap());
        let incoming = call(
            json!({"operation":"documentApplyRemote","handle":handle,"update":update,"encoding":1}),
        );
        assert_eq!(incoming["ok"], true, "{incoming}");
        assert_eq!(incoming["value"]["saved"], true);
        assert_eq!(
            call(
                json!({"operation":"documentApplyRemote","handle":handle,"update":"!","encoding":1})
            )["ok"],
            false
        );
        let committed = call(
            json!({"operation":"documentCommitDraft","handle":handle,"commit":{"key":"ime","text":"新词"}}),
        );
        assert_eq!(committed["ok"], true, "{committed}");
        let text = committed["value"]["projection"]["text"].as_str().unwrap();
        assert!(text.contains("新词") && text.contains("远端"));
        assert!(!text.contains("北远端塔"));
        let undone = call(json!({"operation":"documentUndo","handle":handle}));
        assert!(undone["value"]["projection"]["text"]
            .as_str()
            .unwrap()
            .contains("北远端塔"));
        let redone = call(json!({"operation":"documentRedo","handle":handle}));
        assert_eq!(
            redone["value"]["projection"]["text"],
            committed["value"]["projection"]["text"]
        );
        assert_eq!(
            call(json!({"operation":"close","handle":handle}))["ok"],
            true
        );
        let reopened = call(json!({"operation":"open","directory":directory}));
        let handle = reopened["value"]["handle"].as_u64().unwrap();
        assert_eq!(
            call(json!({"operation":"documentRead","handle":handle}))["value"]["projection"]
                ["text"],
            committed["value"]["projection"]["text"]
        );
        assert_eq!(
            call(json!({"operation":"close","handle":handle}))["ok"],
            true
        );
    }

    #[test]
    fn draft_checkpoint_failure_consumes_commit_once_and_retries_only_persistence() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(CLIENT);
        let mut session = LabSession::open(&directory).unwrap();
        let revision = session.document.native_projection().unwrap().revision;
        session
            .document
            .begin_draft(NativeDraftStart {
                key: "draft".into(),
                revision,
                range: drifting_document::NativeRange {
                    location: 0,
                    length: 0,
                },
            })
            .unwrap();
        session.gateway.close(CLIENT.into()).unwrap();
        session
            .document
            .commit_draft(NativeDraftCommit {
                key: "draft".into(),
                text: "唯一提交".into(),
                selection: None,
            })
            .unwrap();
        session.persist();
        assert!(session.save_error.is_some());
        assert_eq!(session.document.active_drafts(), 0);
        session
            .gateway
            .open(DATABASE.into(), CLIENT.into(), false)
            .unwrap();
        session.persist();
        assert!(session.save_error.is_none());
        session.gateway.close(CLIENT.into()).unwrap();
        let recovered = LabSession::open(&directory).unwrap();
        assert_eq!(
            recovered
                .document
                .native_projection()
                .unwrap()
                .text
                .matches("唯一提交")
                .count(),
            1
        );
    }

    #[test]
    fn c_abi_preserves_unicode_across_close_and_reopen_and_rejects_stale_handles() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(CLIENT);
        let opened = call(json!({"operation": "open", "directory": directory}));
        assert_eq!(opened["ok"], true, "{opened}");
        let handle = opened["value"]["handle"].as_u64().unwrap();
        let name = "合成项目：星河 👩🏽‍🚀 e\u{301}";
        let renamed = call(json!({"operation": "rename", "handle": handle, "name": name}));
        assert_eq!(renamed["value"]["name"], name);
        assert_eq!(
            call(json!({"operation": "rename", "handle": handle, "name": " "}))["ok"],
            false
        );
        let closed = call(json!({"operation": "close", "handle": handle}));
        assert_eq!(closed["ok"], true);
        assert!(
            closed["value"].is_null(),
            "void replies must decode as an optional Swift value"
        );
        assert_eq!(
            call(json!({"operation": "read", "handle": handle}))["ok"],
            false
        );
        let reopened = call(json!({"operation": "open", "directory": directory}));
        assert_eq!(reopened["value"]["name"], name);
        assert_eq!(
            call(json!({"operation": "close", "handle": reopened["value"]["handle"]}))["ok"],
            true
        );
    }

    #[test]
    fn native_lab_scoped_deletion_persists_original_for_current_incarnation_and_cold_reopen() {
        use drifting_core::original_operation::{MutationTarget, OriginalOperationRef};
        use drifting_core::original_operation_store::OriginalOperationStore;
        for incarnation in [0u64, 3] {
            let temp = tempfile::tempdir().unwrap();
            let directory = temp.path().join(CLIENT);
            let mut session = LabSession::open(&directory).unwrap();
            session
                .document
                .edit(drifting_document::Edit::AppendParagraph {
                    id: "synthetic-native-evidence".into(),
                    text: "头中🙂尾".into(),
                })
                .unwrap();
            session.persist();
            assert!(session.save_error.is_none());
            if incarnation != 0 {
                let rows = session
                    .gateway
                    .query(
                        "SELECT change_set_id FROM sync_change_set ORDER BY device_seq LIMIT 1"
                            .into(),
                        vec![],
                        None,
                        CLIENT.into(),
                    )
                    .unwrap();
                let DatabaseValue::Text(id) = &rows.rows[0][0] else {
                    panic!()
                };
                session.gateway.execute("INSERT INTO sync_entity_lifecycle(sync_generation_id,entity_kind,entity_id,incarnation,state,hlc_wall_ms,hlc_counter,writer_id,writer_epoch,device_seq,change_set_id,mutation_index) VALUES (?,'node',?,3,'live',1,0,'synthetic-lifecycle','epoch',1,?,0)".into(),vec![text(GENERATION),text(NODE),text(id)],None,CLIENT.into()).unwrap();
                drop(session);
                session = LabSession::open(&directory).unwrap();
            }
            let before = session.document.native_projection().unwrap();
            let block = before
                .blocks
                .iter()
                .find(|b| b.id.as_deref() == Some("synthetic-native-evidence"))
                .unwrap();
            session
                .document
                .replace_native(NativeReplacement {
                    revision: before.revision,
                    range: drifting_document::NativeRange {
                        location: block.range.location + 1,
                        length: 3,
                    },
                    text: String::new(),
                })
                .unwrap();
            session.persist();
            assert!(session.save_error.is_none(), "{:?}", session.save_error);
            let rows = session.gateway.query("SELECT c.change_set_id,c.payload_sha256,m.payload_sha256 FROM sync_change_set c JOIN sync_mutation m USING(change_set_id) ORDER BY c.device_seq DESC LIMIT 1".into(),vec![],None,CLIENT.into()).unwrap();
            let [DatabaseValue::Text(id), DatabaseValue::Text(envelope), DatabaseValue::Text(payload)] =
                rows.rows[0].as_slice()
            else {
                panic!()
            };
            let reference = OriginalOperationRef {
                project_id: PROJECT.into(),
                project_sync_id: PROJECT_SYNC.into(),
                sync_generation_id: GENERATION.into(),
                change_set_id: id.clone(),
                mutation_index: 0,
                target: MutationTarget {
                    family: "yjs".into(),
                    kind: "prose-document".into(),
                    id: DOCUMENT.into(),
                    incarnation,
                },
                payload_sha256: format!("sha256:{payload}"),
                original_envelope_sha256: envelope.clone(),
            };
            let original = OriginalOperationStore::new(&session.gateway, CLIENT)
                .load_verified(&reference)
                .unwrap();
            assert_eq!(original.intent().offset_utf16, 1);
            assert_eq!(original.intent().length_utf16, 3);
            assert!(session
                .document
                .native_projection()
                .unwrap()
                .text
                .ends_with("头尾"));
            drop(session);
            let reopened = LabSession::open(&directory).unwrap();
            assert!(reopened
                .document
                .native_projection()
                .unwrap()
                .text
                .ends_with("头尾"));
            assert!(OriginalOperationStore::new(&reopened.gateway, CLIENT)
                .load_verified(&reference)
                .is_ok());
        }
    }

    #[test]
    fn native_prose_unicode_history_and_metadata_survive_sqlite_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(CLIENT);
        let opened = call(json!({"operation": "open", "directory": directory}));
        let handle = opened["value"]["handle"].as_u64().unwrap();
        assert_eq!(
            call(json!({"operation": "open", "directory": directory}))["ok"],
            false
        );
        let initial = call(json!({"operation": "documentRead", "handle": handle}))["value"].clone();
        let block = &initial["projection"]["blocks"][1];
        let original = initial["projection"]["text"].as_str().unwrap();
        let revision = initial["projection"]["revision"].as_u64().unwrap();
        let edited = call(
            json!({"operation": "documentReplace", "handle": handle, "edit": {
                "revision": revision, "range": {"location": block["range"]["location"], "length": 0}, "text": "续写👩🏽‍🚀"
            }}),
        );
        assert_eq!(edited["ok"], true, "{edited}");
        assert_eq!(edited["value"]["saved"], true);
        assert!(edited["value"]["projection"]["text"]
            .as_str()
            .unwrap()
            .contains("续写👩🏽‍🚀夜航员"));
        assert_eq!(
            edited["value"]["projection"]["blocks"][1]["attributes"]["nativeUnknownAttribute"],
            block["attributes"]["nativeUnknownAttribute"]
        );
        let undo = call(json!({"operation": "documentUndo", "handle": handle}));
        assert_eq!(undo["value"]["projection"]["text"], original);
        let redo = call(json!({"operation": "documentRedo", "handle": handle}));
        assert_eq!(
            redo["value"]["projection"]["text"],
            edited["value"]["projection"]["text"]
        );
        assert_eq!(
            call(json!({"operation": "close", "handle": handle}))["ok"],
            true
        );
        let reopened = call(json!({"operation": "open", "directory": directory}));
        let handle = reopened["value"]["handle"].as_u64().unwrap();
        let recovered = call(json!({"operation": "documentRead", "handle": handle}));
        assert_eq!(
            recovered["value"]["projection"]["text"],
            edited["value"]["projection"]["text"]
        );
        assert_eq!(
            recovered["value"]["projection"]["blocks"],
            edited["value"]["projection"]["blocks"]
        );
        assert_eq!(
            call(json!({"operation": "close", "handle": handle}))["ok"],
            true
        );
    }

    #[test]
    fn failed_checkpoint_retains_prose_until_retry() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(CLIENT);
        let mut session = LabSession::open(&directory).unwrap();
        session.gateway.close(CLIENT.into()).unwrap();
        let revision = session.document.native_projection().unwrap().revision;
        session.document.replace_native(serde_json::from_value(json!({"revision": revision, "range": {"location": 0, "length": 0}, "text": "待重试"})).unwrap()).unwrap();
        session.persist();
        assert!(session.save_error.is_some());
        assert_eq!(session.document_state().unwrap()["saved"], false);
        session
            .gateway
            .open(DATABASE.into(), CLIENT.into(), false)
            .unwrap();
        session.persist();
        assert!(session.save_error.is_none());
        session.gateway.close(CLIENT.into()).unwrap();
        let recovered = LabSession::open(&directory).unwrap();
        assert!(recovered
            .document
            .native_projection()
            .unwrap()
            .text
            .starts_with("待重试"));
    }

    #[test]
    fn comment_split_redo_and_checkpoint_restore_original_quote() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(CLIENT);
        let mut session = LabSession::open(&directory).unwrap();
        let before = session.document.native_projection().unwrap();
        let quote = before.comments[0].quote.clone();
        assert_eq!(quote, "北塔");
        let at = before.comments[0].ranges[0].location + 1;
        session.document.replace_native(serde_json::from_value(json!({"revision":before.revision,"range":{"location":at,"length":0},"text":"\n"})).unwrap()).unwrap();
        session.persist();
        assert!(session.save_error.is_none());
        assert!(session.document.undo());
        session.persist();
        assert!(session.document.redo());
        session.persist();
        assert!(session.save_error.is_none());
        let split = session.document.comment_anchor_records();
        assert_eq!(load_comments(&session.gateway).unwrap(), split);
        session.gateway.close(CLIENT.into()).unwrap();
        let recovered = LabSession::open(&directory).unwrap();
        let projection = recovered.document.native_projection().unwrap();
        assert_eq!(projection.comments[0].quote, quote);
        assert_eq!(projection.comments[0].ranges[0].length, 3);
        assert_eq!(recovered.document.comment_anchor_records(), split);
    }

    fn snapshot(session: &LabSession) -> Vec<u8> {
        let result = session
            .gateway
            .query(
                "SELECT state_blob FROM yjs_snapshots WHERE document_id = ?".into(),
                vec![text(DOCUMENT)],
                None,
                CLIENT.into(),
            )
            .unwrap();
        let DatabaseValue::Blob(bytes) = &result.rows[0][0] else {
            panic!("snapshot missing")
        };
        bytes.clone()
    }

    fn edit_comment_prefix(session: &mut LabSession) {
        let before = session.document.native_projection().unwrap();
        session.document.replace_native(serde_json::from_value(json!({"revision":before.revision,"range":{"location":before.comments[0].ranges[0].location,"length":0},"text":"远"})).unwrap()).unwrap();
    }

    #[test]
    fn comment_write_failure_rolls_back_prose_and_anchor_until_atomic_retry() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(CLIENT);
        let mut session = LabSession::open(&directory).unwrap();
        let before = snapshot(&session);
        let anchors = load_comments(&session.gateway).unwrap();
        session.gateway.execute("CREATE TRIGGER fail_comment BEFORE UPDATE ON comment BEGIN SELECT RAISE(ABORT, 'injected anchor failure'); END".into(), vec![], None, CLIENT.into()).unwrap();
        edit_comment_prefix(&mut session);
        session.persist();
        assert!(session
            .save_error
            .as_ref()
            .unwrap()
            .contains("injected anchor failure"));
        assert_eq!(
            snapshot(&session),
            before,
            "snapshot write must roll back with the comment"
        );
        assert_eq!(load_comments(&session.gateway).unwrap(), anchors);
        assert!(session
            .document
            .native_projection()
            .unwrap()
            .text
            .contains("远北塔"));
        session
            .gateway
            .execute(
                "DROP TRIGGER fail_comment".into(),
                vec![],
                None,
                CLIENT.into(),
            )
            .unwrap();
        session.persist();
        assert!(session.save_error.is_none());
        assert_ne!(snapshot(&session), before);
        assert_eq!(
            load_comments(&session.gateway).unwrap(),
            session.document.comment_anchor_records()
        );
        session.gateway.close(CLIENT.into()).unwrap();
        let recovered = LabSession::open(&directory).unwrap();
        let projection = recovered.document.native_projection().unwrap();
        assert!(projection.text.contains("远北塔"));
        assert_eq!(projection.comments[0].quote, "北塔");
        assert_eq!(projection.comments[0].status, "anchored");
    }

    #[test]
    fn checkpoint_preserves_comment_body_and_refuses_external_anchor_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(CLIENT);
        let mut session = LabSession::open(&directory).unwrap();
        session.gateway.execute("UPDATE comment SET body_json = ?, status = 'resolved' WHERE id = 'fixture-comment'".into(), vec![text("{\"syntheticFutureBody\":true}")], None, CLIENT.into()).unwrap();
        edit_comment_prefix(&mut session);
        session.persist();
        assert!(session.save_error.is_none());
        let row = session
            .gateway
            .query(
                "SELECT body_json, status FROM comment WHERE id = 'fixture-comment'".into(),
                vec![],
                None,
                CLIENT.into(),
            )
            .unwrap();
        assert!(
            matches!(&row.rows[0][0], DatabaseValue::Text(v) if v == "{\"syntheticFutureBody\":true}")
        );
        assert!(matches!(&row.rows[0][1], DatabaseValue::Text(v) if v == "resolved"));
        let before = snapshot(&session);
        session
            .gateway
            .execute(
                "UPDATE comment SET anchor_json = ? WHERE id = 'fixture-comment'".into(),
                vec![text("{\"externallyChanged\":true}")],
                None,
                CLIENT.into(),
            )
            .unwrap();
        let external = load_comments(&session.gateway).unwrap();
        edit_comment_prefix(&mut session);
        session.persist();
        assert!(session
            .save_error
            .as_ref()
            .unwrap()
            .contains("changed outside this owner"));
        assert_eq!(snapshot(&session), before);
        assert_eq!(load_comments(&session.gateway).unwrap(), external);
    }

    #[test]
    fn ephemeral_selection_abi_tracks_history_and_drops_without_checkpoint_writes() {
        let temp = tempfile::tempdir().unwrap();
        let opened = call(json!({"operation":"open","directory":temp.path().join(CLIENT)}));
        let handle = opened["value"]["handle"].as_u64().unwrap();
        let before = call(json!({"operation":"documentRead","handle":handle}))["value"].clone();
        let bytes = {
            let sessions = SESSIONS.get().unwrap().lock().unwrap();
            snapshot(&sessions[&handle])
        };
        let selected = call(
            json!({"operation":"documentSelect","handle":handle,"selection":{
            "viewId":"synthetic-view","epoch":1,"revision":before["projection"]["revision"],"range":{"location":2,"length":0}}}),
        );
        assert_eq!(selected["ok"], true, "{selected}");
        assert_eq!(selected["value"]["selection"]["range"]["location"], 2);
        assert_eq!(
            selected["value"]["revision"],
            before["projection"]["revision"]
        );
        assert_eq!(
            {
                let sessions = SESSIONS.get().unwrap().lock().unwrap();
                snapshot(&sessions[&handle])
            },
            bytes
        );
        let edited = call(
            json!({"operation":"documentReplace","handle":handle,"edit":{
            "revision":before["projection"]["revision"],"range":{"location":0,"length":0},"text":"远"}}),
        );
        assert_eq!(
            edited["value"]["projection"]["selections"][0]["range"]["location"],
            3
        );
        let restored = call(json!({"operation":"documentUndo","handle":handle}));
        assert_eq!(
            restored["value"]["projection"]["selections"][0]["range"]["location"],
            2
        );
        let dropped = call(
            json!({"operation":"documentDropSelection","handle":handle,"viewId":"synthetic-view"}),
        );
        assert_eq!(dropped["ok"], true, "{dropped}");
        assert!(
            call(json!({"operation":"documentRead","handle":handle}))["value"]["projection"]
                ["selections"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            call(json!({"operation":"close","handle":handle}))["ok"],
            true
        );
    }

    #[test]
    fn rejects_production_directories_and_malformed_requests() {
        assert_eq!(
            call(json!({"operation": "open", "directory": "databases"}))["ok"],
            false
        );
        assert_eq!(
            call(json!({"operation": "execute", "sql": "DROP TABLE project"}))["ok"],
            false
        );
        assert_eq!(
            call(json!({"operation": "read", "handle": 99999}))["ok"],
            false
        );
    }
}
