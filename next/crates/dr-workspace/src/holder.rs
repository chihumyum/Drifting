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
//!   leak into a later write. An author's command on prose is written with
//!   dr-store's `Origin::Command` (`user:command`), so the editor's undo
//!   leaves it to the journal ([`crate::cx::Cx`]'s `write_prose_raw`).
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
/// opposed to the author's typing in an editor (`user`): dr-store's
/// `Origin::Command`. The editor's undo leaves it out ([`crate::ProseSession`]
/// and dr-doc's excluded prefixes), so an editor's Undo only takes back the
/// editor's own steps; commands are undone through the journal.
pub use dr_store::COMMAND_ORIGIN;

/// The options of a commit made with `origin` (the holder's own).
fn commit_options(origin: &dr_store::Origin) -> CommitOptions {
    let mut options = CommitOptions::new().origin(&origin.to_string());
    if let Some(message) = origin.commit_message() {
        options = options.commit_msg(&message);
    }
    options
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
    let options = commit_options(&origin);
    let job = move |doc: &LoroDoc| -> Result<R> {
        doc.set_next_commit_options(options);
        f(doc)
    };
    let (r, _) = match agent {
        Some(a) => handle.write_agent(a, job)?,
        None => handle.write(origin, job)?,
    };
    r
}

/// `f` over `items` on a few threads (at most 8, never more than the
/// machine's parallelism or the items), results in `items`' order. After an
/// error no new item starts; the first error in `items`' order is returned.
/// For work that waits on many documents' holders: opening one loads it
/// from SQLite, which on a long chapter is most of the time.
pub(crate) fn par_map<T, R, F>(items: &[T], f: F) -> Result<Vec<R>>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> Result<R> + Sync,
{
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .clamp(1, 8)
        .min(items.len());
    if threads <= 1 {
        return items.iter().map(&f).collect();
    }
    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let done: Mutex<Vec<(usize, Result<R>)>> = Mutex::new(Vec::with_capacity(items.len()));
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| {
                loop {
                    if failed.load(Ordering::Relaxed) {
                        break;
                    }
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(i) else { break };
                    let r = f(item);
                    if r.is_err() {
                        failed.store(true, Ordering::Relaxed);
                    }
                    lock(&done).push((i, r));
                }
            });
        }
    });
    let mut done = done.into_inner().unwrap_or_else(|e| e.into_inner());
    done.sort_by_key(|(i, _)| *i);
    done.into_iter().map(|(_, r)| r).collect()
}
