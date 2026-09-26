//! Chapter lifecycle changes retire the target owner only after a durable
//! commit. Saving must happen while its old scope is still live.
use super::*;

impl WorkspaceSession {
    pub(super) fn trash_chapter(
        &mut self,
        documents: &mut HashMap<u64, LabSession>,
        project_id: &str,
        chapter_id: &str,
    ) -> Result<Value, String> {
        let project = self.project(project_id)?;
        let key = (project_id.to_owned(), chapter_id.to_owned());
        if let Some(handle) = self.documents.get(&key) {
            documents
                .get_mut(handle)
                .ok_or("Workspace document owner is missing")?
                .prepare_to_release()?;
        }
        WorkspaceStore::new(&self.gateway, CLIENT)
            .trash_chapter(&self.context(&project)?, chapter_id)?;
        // Never ask the retired owner to checkpoint after its lifecycle became
        // trashed. All its displayed views share this single Rust handle.
        if let Some(handle) = self.documents.remove(&key) {
            documents.remove(&handle);
        }
        self.chapter_lifecycle_reply(project_id, chapter_id)
    }

    pub(super) fn restore_chapter(
        &self,
        project_id: &str,
        chapter_id: &str,
    ) -> Result<Value, String> {
        let project = self.project(project_id)?;
        if self
            .documents
            .contains_key(&(project_id.into(), chapter_id.into()))
        {
            return Err("Chapter still has a live document owner".into());
        }
        drifting_prose::workspace::restore_chapter(
            &self.gateway,
            CLIENT,
            &self.context(&project)?,
            chapter_id,
        )?;
        // Restoring does not reopen an old owner or import its undo history.
        self.chapter_lifecycle_reply(project_id, chapter_id)
    }

    fn chapter_lifecycle_reply(&self, project_id: &str, chapter_id: &str) -> Result<Value, String> {
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        Ok(json!({"projectId":project_id,"chapterId":chapter_id,
            "chapters":store.list_chapters(project_id)?,
            "trashedChapters":store.list_trashed_chapters(project_id)?}))
    }
}
