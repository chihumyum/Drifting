//! Narrow nonstructural receive entry point for hosts that can refresh prose
//! without refreshing workspace metadata. The canonical transaction is shared
//! with the complete workspace receiver.
use crate::database::DatabaseGateway;
use crate::original_operation::{verify_change_set, ChangeSetRef, MutationTarget};
use crate::prose::ProseRepository;
use crate::prose_journal::AuthoredProseContext;
pub use crate::remote_workspace::RemoteWorkspaceCommit as RemoteProseCommit;
use crate::remote_workspace::RemoteWorkspaceJournal;

#[cfg(test)]
mod tests;

pub struct RemoteProseJournal<'a> {
    gateway: &'a DatabaseGateway,
    client: &'a str,
}
impl<'a> RemoteProseJournal<'a> {
    pub fn new(gateway: &'a DatabaseGateway, client: &'a str) -> Self {
        Self { gateway, client }
    }
    pub fn receive<F>(
        &self,
        context: &AuthoredProseContext,
        expected: &ChangeSetRef,
        envelope: &[u8],
        transaction: Option<u64>,
        project: F,
    ) -> Result<RemoteProseCommit, String>
    where
        F: FnMut(&ProseRepository<'_>, u64, &MutationTarget, &[u8]) -> Result<String, String>,
    {
        let original = verify_change_set(envelope, expected)?;
        if original.mutations().iter().any(|m| {
            m.action() != "yjs.update"
                || m.target().family != "yjs"
                || m.target().kind != "prose-document"
        }) {
            return Err("Remote prose accepts only complete yjs.update envelopes".into());
        }
        RemoteWorkspaceJournal::new(self.gateway, self.client).receive_verified(
            context,
            original,
            envelope,
            transaction,
            project,
        )
    }
}
