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
    document_handle: Option<u64>,
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
    ) -> Result<Value, String> {
        self.project(project_id)?;
        let scope =
            WorkspaceStore::new(&self.gateway, CLIENT).chapter_scope(project_id, chapter_id)?;
        if let Some(handle) = self.document_handle {
            documents
                .get_mut(&handle)
                .ok_or("Workspace document owner is missing")?
                .prepare_to_release()?;
        }
        // Keep the old owner and its history until load/replay/checkpoint succeeds.
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
        if let Some(previous) = self.document_handle.replace(handle) {
            documents.remove(&previous);
        }
        Ok(json!({"handle":handle,"projectId":project_id,"chapterId":chapter_id,"document":state}))
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
            | Request::WorkspaceChapters { .. }
            | Request::WorkspaceCreateChapter { .. }
            | Request::WorkspaceOpenChapter { .. }
            | Request::WorkspaceReopenChapter { .. }
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
                    document_handle: None,
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
        Request::WorkspaceChapters { handle, project_id } => {
            let workspace = workspaces
                .get(handle)
                .ok_or("Unknown or closed workspace")?;
            workspace.project(project_id)?;
            json!(WorkspaceStore::new(&workspace.gateway, CLIENT).list_chapters(project_id)?)
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
            .open_chapter(documents, project_id, chapter_id)?,
        Request::WorkspaceReopenChapter { handle } => {
            let workspace = workspaces
                .get_mut(handle)
                .ok_or("Unknown or closed workspace")?;
            let document = documents
                .get(&workspace.document_handle.ok_or("No chapter is selected")?)
                .ok_or("Workspace document owner is missing")?;
            let project_id = document.owner.scope.project_id.clone();
            let chapter_id = document.owner.chapter_id.clone();
            workspace.open_chapter(documents, &project_id, &chapter_id)?
        }
        Request::WorkspaceClose { handle } => {
            let workspace = workspaces
                .get(handle)
                .ok_or("Unknown or closed workspace")?;
            if let Some(document) = workspace.document_handle {
                documents
                    .get_mut(&document)
                    .ok_or("Workspace document owner is missing")?
                    .prepare_to_release()?;
            }
            workspace.gateway.close(CLIENT.into())?;
            if let Some(document) = workspace.document_handle {
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
        if workspace.document_handle == Some(handle) {
            workspace.document_handle = None;
            return Ok(());
        }
    }
    Err("Document no longer belongs to an open workspace".into())
}
