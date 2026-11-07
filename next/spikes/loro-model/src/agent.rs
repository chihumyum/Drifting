//! Two ways to apply an Agent write to a prose document.
//!
//! - **In place**: the Agent's edit is a local commit on the open document
//!   with origin and message `agent:<session>/<turn>`; the editor's
//!   `UndoManager` excludes the `agent:` prefix, so the author's Undo never
//!   removes Agent text, and the Agent's ops are composed into the undo
//!   stacks like a remote change.
//! - **Forked**: fork the document, edit the fork as a separate Agent peer,
//!   export the new ops and import them into the open document with origin
//!   `agent:<session>/<turn>`.

use loro::{CommitOptions, ExportMode, LoroDoc};

use crate::prose::ProseDoc;
use crate::schema;

pub const AGENT_PREFIX: &str = "agent:";

pub fn agent_origin(session: &str, turn: u32) -> String {
    format!("{AGENT_PREFIX}{session}/{turn}")
}

/// In-place Agent write. Returns the size of the resulting update.
pub fn write_in_place(prose: &ProseDoc, origin: &str, edit: impl FnOnce(&ProseDoc)) -> usize {
    let before = prose.doc.oplog_vv();
    edit(prose);
    prose
        .doc
        .commit_with(CommitOptions::new().origin(origin).commit_msg(origin));
    prose
        .doc
        .export(ExportMode::updates(&before))
        .map(|b| b.len())
        .unwrap_or(0)
}

/// Forked Agent write: edit a fork as `agent_peer`, import the result.
/// Returns the size of the imported update.
pub fn write_forked(
    prose: &ProseDoc,
    origin: &str,
    agent_peer: u64,
    edit: impl FnOnce(&ProseDoc),
) -> usize {
    let fork: LoroDoc = prose.doc.fork();
    schema::configure(&fork);
    fork.set_peer_id(agent_peer).expect("agent peer");
    let f = ProseDoc::from_doc(fork);
    edit(&f);
    f.doc.commit_with(CommitOptions::new().commit_msg(origin));
    let bytes = f
        .doc
        .export(ExportMode::updates(&prose.doc.oplog_vv()))
        .expect("export fork");
    prose.doc.import_with(&bytes, origin).expect("import fork");
    bytes.len()
}

/// The commit message stored with the change that contains `id`, if any.
pub fn message_of(doc: &LoroDoc, id: loro::ID) -> Option<String> {
    doc.get_change(id)
        .and_then(|c| c.message.as_ref().map(|m| m.to_string()))
}
