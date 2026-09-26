//! Small local workspace adapter. Domain creation and journal transactions live
//! in drifting-core; this module only owns Apple handles and chapter transitions.
use super::*;
use drifting_core::workspace::{
    ChapterSeed, CreateChapter, CreateProject, WorkspaceProject, WorkspaceStore,
};
use drifting_document::Edit;

const WORKSPACE_DATABASE: &str = "apple-native-workspace.db";
const WORKSPACE_USER: &str = "local-user";
static WORKSPACES: OnceLock<Mutex<HashMap<u64, WorkspaceSession>>> = OnceLock::new();

struct WorkspaceSession {
    directory: PathBuf,
    gateway: DatabaseGateway,
    installation_id: String,
    documents: HashMap<(String, String), u64>,
}

fn identifier(kind: &str) -> Result<String, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "native-{kind}-{}-{}-{}",
        std::process::id(),
        now.as_nanos(),
        NEXT_WRITER.fetch_add(1, Ordering::Relaxed)
    ))
}

impl WorkspaceSession {
    fn project(&self, project_id: &str) -> Result<WorkspaceProject, String> {
        WorkspaceStore::new(&self.gateway, CLIENT)
            .list_projects(WORKSPACE_USER)?
            .into_iter()
            .find(|project| project.id == project_id)
            .ok_or_else(|| "Project does not belong to this local workspace".into())
    }

    fn context(&self, project: &WorkspaceProject) -> Result<AuthoredProseContext, String> {
        context_for_scope(
            &self.gateway,
            &project.id,
            &project.project_sync_id,
            &project.sync_generation_id,
            &self.installation_id,
        )
    }

    fn open_chapter(
        &mut self,
        documents: &mut HashMap<u64, LabSession>,
        project_id: &str,
        chapter_id: &str,
        reopen: bool,
    ) -> Result<Value, String> {
        self.project(project_id)?;
        let scope =
            WorkspaceStore::new(&self.gateway, CLIENT).chapter_scope(project_id, chapter_id)?;
        let key = (project_id.to_owned(), chapter_id.to_owned());
        let previous = self.documents.get(&key).copied();
        if reopen && previous.is_none() {
            return Err("Chapter is not open in this workspace".into());
        }
        if let Some(handle) = previous {
            let owner = documents
                .get(&handle)
                .ok_or("Workspace document owner is missing")?;
            if !reopen && owner.owner.scope != scope {
                return Err("Open chapter scope changed; reopen before editing".into());
            }
        }
        let handles = if reopen {
            vec![previous.unwrap()]
        } else {
            self.document_handles()
        };
        for handle in handles {
            documents
                .get_mut(&handle)
                .ok_or("Workspace document owner is missing")?
                .prepare_to_release()?;
        }
        if let Some(handle) = previous.filter(|_| !reopen) {
            let state = documents[&handle].document_state()?;
            return Ok(
                json!({"handle":handle,"projectId":project_id,"chapterId":chapter_id,"document":state}),
            );
        }
        // Keep every old owner until load/replay/checkpoint succeeds. An explicit
        // reopen replaces only this chapter; opening another chapter retains it.
        let candidate = LabSession::open_chapter(
            self.directory.clone(),
            self.gateway.clone(),
            scope,
            chapter_id.into(),
            self.installation_id.clone(),
        )?;
        let state = candidate.document_state()?;
        let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
        documents.insert(handle, candidate);
        if let Some(previous) = self.documents.insert(key, handle) {
            documents.remove(&previous);
        }
        Ok(json!({"handle":handle,"projectId":project_id,"chapterId":chapter_id,"document":state}))
    }

    fn document_handles(&self) -> Vec<u64> {
        let mut handles: Vec<_> = self.documents.values().copied().collect();
        handles.sort_unstable();
        handles
    }
}

/// The caller already holds SESSIONS. Every path acquires locks in this order.
pub(super) fn dispatch(
    request: &Request,
    documents: &mut HashMap<u64, LabSession>,
) -> Result<Option<Value>, String> {
    if !matches!(
        request,
        Request::WorkspaceOpen { .. }
            | Request::WorkspaceProjects { .. }
            | Request::WorkspaceCreateProject { .. }
            | Request::WorkspaceRenameProject { .. }
            | Request::WorkspaceRenameChapter { .. }
            | Request::WorkspaceMoveChapter { .. }
            | Request::WorkspaceChapters { .. }
            | Request::WorkspaceOutline { .. }
            | Request::WorkspaceChapterOutline { .. }
            | Request::WorkspaceCreateChapter { .. }
            | Request::WorkspaceOpenChapter { .. }
            | Request::WorkspaceReopenChapter { .. }
            | Request::WorkspaceCloseChapter { .. }
            | Request::WorkspaceClose { .. }
    ) {
        return Ok(None);
    }
    let mut workspaces = WORKSPACES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Workspace registry is unavailable")?;
    let value = match request {
        Request::WorkspaceOpen { directory } => {
            validate_directory(directory)?;
            let directory = directory.canonicalize().map_err(|e| e.to_string())?;
            if workspaces
                .values()
                .any(|session| session.directory == directory)
            {
                return Err("This workspace already has a live owner".into());
            }
            let gateway = DatabaseGateway::new(directory.clone())?;
            gateway.open(WORKSPACE_DATABASE.into(), CLIENT.into(), false)?;
            let projects = WorkspaceStore::new(&gateway, CLIENT).list_projects(WORKSPACE_USER)?;
            let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
            workspaces.insert(
                handle,
                WorkspaceSession {
                    directory,
                    gateway,
                    installation_id: identifier("installation")?,
                    documents: HashMap::new(),
                },
            );
            json!({"handle":handle,"projects":projects})
        }
        Request::WorkspaceProjects { handle } => {
            let workspace = workspaces
                .get(handle)
                .ok_or("Unknown or closed workspace")?;
            json!(WorkspaceStore::new(&workspace.gateway, CLIENT).list_projects(WORKSPACE_USER)?)
        }
        Request::WorkspaceCreateProject { handle, name } => {
            let workspace = workspaces
                .get(handle)
                .ok_or("Unknown or closed workspace")?;
            let project_id = identifier("project")?;
            let context = context_for_scope(
                &workspace.gateway,
                &project_id,
                &identifier("project-sync")?,
                &identifier("generation")?,
                &workspace.installation_id,
            )?;
            let key_base = identifier("default")?;
            let created = WorkspaceStore::new(&workspace.gateway, CLIENT).create_project(
                &context,
                CreateProject {
                    user_id: WORKSPACE_USER.into(),
                    name: name.clone(),
                    default_kv_ids: std::array::from_fn(|index| format!("{key_base}-{index}")),
                },
            )?;
            json!(created)
        }
        Request::WorkspaceRenameProject {
            handle,
            project_id,
            name,
        } => {
            let workspace = workspaces
                .get(handle)
                .ok_or("Unknown or closed workspace")?;
            let project = workspace.project(project_id)?;
            json!(WorkspaceStore::new(&workspace.gateway, CLIENT)
                .rename_project(&workspace.context(&project)?, name)?)
        }
        Request::WorkspaceRenameChapter {
            handle,
            project_id,
            chapter_id,
            title,
        } => {
            let workspace = workspaces
                .get(handle)
                .ok_or("Unknown or closed workspace")?;
            let project = workspace.project(project_id)?;
            json!(
                WorkspaceStore::new(&workspace.gateway, CLIENT).rename_chapter(
                    &workspace.context(&project)?,
                    chapter_id,
                    title
                )?
            )
        }
        Request::WorkspaceMoveChapter {
            handle,
            project_id,
            chapter_id,
            before_chapter_id,
        } => {
            let workspace = workspaces
                .get(handle)
                .ok_or("Unknown or closed workspace")?;
            let project = workspace.project(project_id)?;
            json!(
                WorkspaceStore::new(&workspace.gateway, CLIENT).move_chapter(
                    &workspace.context(&project)?,
                    chapter_id,
                    before_chapter_id.as_deref()
                )?
            )
        }
        Request::WorkspaceChapters { handle, project_id } => {
            let workspace = workspaces
                .get(handle)
                .ok_or("Unknown or closed workspace")?;
            workspace.project(project_id)?;
            json!(WorkspaceStore::new(&workspace.gateway, CLIENT).list_chapters(project_id)?)
        }
        Request::WorkspaceOutline { handle, project_id } => {
            let workspace = workspaces
                .get(handle)
                .ok_or("Unknown or closed workspace")?;
            workspace.project(project_id)?;
            json!(WorkspaceStore::new(&workspace.gateway, CLIENT).outline(project_id)?)
        }
        Request::WorkspaceChapterOutline {
            handle,
            project_id,
            chapter_id,
        } => {
            let workspace = workspaces
                .get(handle)
                .ok_or("Unknown or closed workspace")?;
            workspace.project(project_id)?;
            let scope = WorkspaceStore::new(&workspace.gateway, CLIENT)
                .chapter_scope(project_id, chapter_id)?;
            if let Some(current) = workspace
                .documents
                .get(&(project_id.clone(), chapter_id.clone()))
                .map(|id| {
                    documents
                        .get(id)
                        .ok_or("Workspace document owner is missing")
                })
                .transpose()?
            {
                if current.owner.scope != scope {
                    return Err(
                        "Selected chapter scope changed; reopen before reading its outline".into(),
                    );
                }
                json!(current.document.native_projection()?.outline)
            } else {
                // This constructor validates scope and loads snapshot + tail
                // in one read transaction. It neither saves nor compacts, and
                // rejects tails requiring a durable repair instead of hiding
                // them behind a stale cached outline. The active owner stays put.
                let reader =
                    DurableDocument::open_with_scope(workspace.gateway.clone(), CLIENT, scope)?;
                if reader.has_pending() {
                    return Err(
                        "Chapter outline is unavailable while prose dependencies are unresolved"
                            .into(),
                    );
                }
                json!(reader.native_projection()?.outline)
            }
        }
        Request::WorkspaceCreateChapter {
            handle,
            project_id,
            title,
        } => {
            let workspace = workspaces
                .get(handle)
                .ok_or("Unknown or closed workspace")?;
            let project = workspace.project(project_id)?;
            let mut seed = DocumentSession::new();
            seed.edit(Edit::AppendParagraph {
                id: identifier("paragraph")?,
                text: String::new(),
            })?;
            let chapter = WorkspaceStore::new(&workspace.gateway, CLIENT).create_chapter(
                &workspace.context(&project)?,
                CreateChapter {
                    id: identifier("chapter")?,
                    title: title.clone(),
                    book_order: None,
                    seed: ChapterSeed {
                        update: seed.update(None, 1)?,
                        content_json: seed.semantic()?.to_string(),
                    },
                },
            )?;
            json!(chapter)
        }
        Request::WorkspaceOpenChapter {
            handle,
            project_id,
            chapter_id,
        } => workspaces
            .get_mut(handle)
            .ok_or("Unknown or closed workspace")?
            .open_chapter(documents, project_id, chapter_id, false)?,
        Request::WorkspaceReopenChapter {
            handle,
            project_id,
            chapter_id,
        } => workspaces
            .get_mut(handle)
            .ok_or("Unknown or closed workspace")?
            .open_chapter(documents, project_id, chapter_id, true)?,
        Request::WorkspaceCloseChapter {
            handle,
            project_id,
            chapter_id,
        } => {
            let workspace = workspaces
                .get_mut(handle)
                .ok_or("Unknown or closed workspace")?;
            let key = (project_id.clone(), chapter_id.clone());
            let document = *workspace
                .documents
                .get(&key)
                .ok_or("Chapter is not open in this workspace")?;
            documents
                .get_mut(&document)
                .ok_or("Workspace document owner is missing")?
                .prepare_to_release()?;
            workspace.documents.remove(&key);
            documents.remove(&document);
            Value::Null
        }
        Request::WorkspaceClose { handle } => {
            let workspace = workspaces
                .get(handle)
                .ok_or("Unknown or closed workspace")?;
            let handles = workspace.document_handles();
            for document in &handles {
                documents
                    .get_mut(document)
                    .ok_or("Workspace document owner is missing")?
                    .prepare_to_release()?;
            }
            workspace.gateway.close(CLIENT.into())?;
            for document in handles {
                documents.remove(&document);
            }
            workspaces.remove(handle);
            Value::Null
        }
        _ => unreachable!(),
    };
    Ok(Some(value))
}

pub(super) fn document_closed(handle: u64) -> Result<(), String> {
    let mut workspaces = WORKSPACES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Workspace registry is unavailable")?;
    for workspace in workspaces.values_mut() {
        if let Some(key) = workspace
            .documents
            .iter()
            .find_map(|(key, value)| (*value == handle).then(|| key.clone()))
        {
            workspace.documents.remove(&key);
            return Ok(());
        }
    }
    Err("Document no longer belongs to an open workspace".into())
}
