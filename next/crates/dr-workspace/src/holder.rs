//! Writing and reading through dr-store's document holders.
//!
//! Each open document has one holder (dr-store), which owns the `LoroDoc`,
//! runs write jobs on its own thread, commits each job as one commit with
//! one origin and persists it before it announces it. The workspace writes
//! inside those jobs with dr-doc's typed transactions on the holder's own
//! document (`BorrowedBook` / `BorrowedProse`), and reads the same document
//! from any thread through dr-doc's readers made with `from_loro` over
//! [`dr_store::DocView::with_doc`]. There is one copy of each open document
//! and nothing to keep level.
//!
//! The rules (dr-doc's and dr-store's):
//!
//! - A job only edits; the holder commits. Before editing, the job sets the
//!   next commit's options (origin and message): resolving an anchor on
//!   deleted text commits implicitly part-way, and that commit takes the
//!   options set then. An empty explicit commit swallows them, so they never
//!   leak into a later write. The one exception is an author's command on
//!   prose ([`Commit::AsCommand`]): the job commits its own edits with
//!   [`COMMAND_ORIGIN`], so the editor's undo leaves them out; the holder's
//!   commit after it is empty and the row is stored as the author's.
//! - Readers read the current state only. Exports, checkouts, diffs, cursor
//!   positions and history walks run on the holder thread
//!   ([`dr_store::DocHandle::read`]) or on a detached copy.
//! - Whatever a job applied before failing is committed too (Loro cannot roll
//!   back), so commands validate before they write.

use std::sync::{Mutex, MutexGuard};

use dr_store::{AgentWrite, DocHandle};
use loro::{CommitOptions, LoroDoc};

use crate::error::Result;

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The Loro origin of the author's *commands* on prose (the command
/// palette, an Agent acting for the author, an object-level undo), as
/// opposed to the author's typing in an editor (`user`). The editor's undo
/// manager leaves it out ([`crate::ProseSession`]), so the editor's Undo
/// only ever takes back the editor's own steps; commands are undone through
/// the journal. Storage still records the write as the author's (`user`):
/// the origin of the stored row, its history and its attribution are
/// unchanged, only the commit Loro announces carries this.
pub const COMMAND_ORIGIN: &str = "user:command";

/// The options of a commit made with `origin` (the holder's own).
fn commit_options(origin: &dr_store::Origin) -> CommitOptions {
    let mut options = CommitOptions::new().origin(&origin.to_string());
    if let Some(message) = origin.commit_message() {
        options = options.commit_msg(&message);
    }
    options
}

/// How a write job's edits are committed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Commit {
    /// By the holder, with the job's origin.
    Holder,
    /// By the job itself, with [`COMMAND_ORIGIN`] (an author's command on
    /// prose). The holder's own commit then finds nothing left and stores
    /// the job's operations as one row with the job's origin, as it does for
    /// a commit an anchor resolution makes part-way.
    AsCommand,
}

/// Run `f` as one write job on `handle`'s holder: one commit with `origin`
/// (for an Agent, `agent` makes it a settled write), durable and announced
/// before this returns.
pub(crate) fn write<R, F>(
    handle: &DocHandle,
    origin: dr_store::Origin,
    agent: Option<AgentWrite>,
    f: F,
) -> Result<R>
where
    F: FnOnce(&LoroDoc) -> Result<R> + Send + 'static,
    R: Send + 'static,
{
    write_with(handle, origin, agent, Commit::Holder, f)
}

/// [`write`], choosing who commits.
pub(crate) fn write_with<R, F>(
    handle: &DocHandle,
    origin: dr_store::Origin,
    agent: Option<AgentWrite>,
    commit: Commit,
    f: F,
) -> Result<R>
where
    F: FnOnce(&LoroDoc) -> Result<R> + Send + 'static,
    R: Send + 'static,
{
    let options = match commit {
        Commit::Holder => commit_options(&origin),
        Commit::AsCommand => CommitOptions::new().origin(COMMAND_ORIGIN),
    };
    let job = move |doc: &LoroDoc| -> Result<R> {
        doc.set_next_commit_options(options);
        let r = f(doc);
        if commit == Commit::AsCommand {
            // Whatever `f` applied, also on failure (Loro cannot roll back).
            doc.commit_with(CommitOptions::new().origin(COMMAND_ORIGIN));
        }
        r
    };
    let (r, _) = match agent {
        Some(a) => handle.write_agent(a, job)?,
        None => handle.write(origin, job)?,
    };
    r
}
