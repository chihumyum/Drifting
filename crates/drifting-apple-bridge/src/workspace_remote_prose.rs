//! Canonical remote originals enter the shared transaction before any live
//! chapter is reconciled. Transport credentials and writer authorization belong
//! to the caller; this endpoint does not accept fixture-only raw Yjs updates.
use super::*;
use drifting_core::original_operation::ChangeSetRef;

impl WorkspaceSession {
    pub(super) fn receive_prose(
        &self,
        documents: &mut HashMap<u64, LabSession>,
        original: &ChangeSetRef,
        envelope: &[u8],
    ) -> Result<Value, String> {
        let project = self.project(&original.project_id)?;
        let context = self.context(&project)?;
        let receipt = drifting_prose::remote_sync::receive_remote_prose(
            &self.gateway,
            CLIENT,
            &context,
            original,
            envelope,
            None,
        )?;
        // Receipt deduplication must not skip a notification lost after COMMIT.
        // Reconcile all open chapters of this project, including older tails.
        let states = self.reconcile_prose(documents, &project.id)?;
        Ok(json!({"changeSetId":receipt.change_set_id,
            "alreadyApplied":receipt.already_applied,
            "affectedDocuments":receipt.affected_documents,"documents":states}))
    }

    pub(super) fn reconcile_prose(
        &self,
        documents: &mut HashMap<u64, LabSession>,
        project_id: &str,
    ) -> Result<Vec<Value>, String> {
        self.project(project_id)?;
        let mut owned: Vec<_> = self
            .documents
            .iter()
            .filter(|((project, _), _)| project == project_id)
            .collect();
        owned.sort_by(|a, b| a.0 .1.cmp(&b.0 .1));
        let mut states = Vec::new();
        for ((project, chapter), handle) in owned {
            let owner = documents
                .get_mut(handle)
                .ok_or("Workspace document owner is missing")?;
            // Failure is reported per owner after the original is durably
            // accepted. Keep other chapters moving and retain every failed
            // owner's draft, history and SQLite tail for retry.
            owner.persist();
            states.push(
                json!({"handle":handle,"projectId":project,"chapterId":chapter,
                "document":owner.document_state()?}),
            );
        }
        Ok(states)
    }
}
