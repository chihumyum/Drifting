//! A project template's working copy (编辑模板的工作区, `project-templates.md`
//! §12; `handoff/v5-tracks.md` DW; contract `WORKING-COPY-LOCAL`).
//!
//! - `project_template.edit` makes it the way `project.create` makes a
//!   project, after the store marks the book as kept on this device
//!   ([`dr_store::Library::keep_local`]): sync never lists its documents,
//!   asset bytes or purge records, the project lists leave it out and it
//!   records no writing day.
//! - The store's note for the book is a [`CopyNote`]: the template it edits,
//!   and the template's revision and content it last matched.
//! - Every change saves itself (作者 2026-11-15 夜里：「改了什么就自动保存」):
//!   the [`Saver`] hears every committed write to the copy's book, prose and
//!   template prose on the library's bus, gathers them for a moment and
//!   saves the copy over its template the way `project_template.save` does
//!   ([`crate::commands::v3::project_template::save_working_copy`]); an undo
//!   is a write like any, so the template follows it back. Nothing is lost
//!   on the way out: [`crate::Workspace::close`] and
//!   [`crate::Workspace::before_quit`] save what is still waiting, and a copy
//!   left by a crash is brought up to date when its template is edited
//!   again (`project_template.edit`).

use std::collections::BTreeSet;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::Duration;

use dr_model::DocId;
use dr_store::{Library, StoreEvent};
use serde::{Deserialize, Serialize};

use crate::Workspace;
use crate::workspace::Inner;

/// How long the saver gathers writes before it saves (typing is a write a
/// keystroke).
pub const GATHER: Duration = Duration::from_millis(250);

/// The store's note for a working copy.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CopyNote {
    /// The saved template it edits (`project-template:<id>`'s id).
    pub template: String,
    /// The template's revision the copy last matched.
    #[serde(default)]
    pub revision: i64,
    /// The digest of the template content the copy last matched
    /// ([`crate::commands::v3::project_template::content_digest`]).
    #[serde(default)]
    pub digest: String,
}

impl CopyNote {
    pub fn parse(note: &str) -> CopyNote {
        serde_json::from_str(note).unwrap_or_else(|_| CopyNote {
            template: note.to_owned(),
            ..CopyNote::default()
        })
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("strings and integers serialize")
    }
}

#[derive(Default)]
struct State {
    /// Working copies with writes not saved yet.
    pending: BTreeSet<String>,
    /// A save round is running (on the thread or in a flush).
    busy: bool,
    /// The saver thread is alive.
    thread: bool,
    stop: bool,
    /// The books that are working copies (read from the store when first
    /// needed).
    copies: Option<BTreeSet<String>>,
}

/// Saves working copies over their templates after their writes.
#[derive(Default)]
pub(crate) struct Saver {
    state: Mutex<State>,
    cv: Condvar,
}

fn lock(m: &Mutex<State>) -> MutexGuard<'_, State> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The book a committed document belongs to, when the document feeds a
/// template (the book document, an entry's prose, a template's prose).
fn book_of(lib: &Library, doc_id: &str) -> Option<String> {
    match DocId::parse(doc_id).ok()? {
        DocId::Book(book) => Some(book.to_string()),
        DocId::Template(t) => t.entry_module().map(|(book, _, _)| book.to_string()),
        DocId::Body(_) => lib.doc_info(doc_id).ok().flatten()?.book_id,
        _ => None,
    }
}

impl Saver {
    fn copies(&self, lib: &Library) -> BTreeSet<String> {
        let mut st = lock(&self.state);
        if st.copies.is_none() {
            let read = lib
                .local_books()
                .map(|books| books.into_iter().map(|b| b.book_id).collect())
                .unwrap_or_else(|e| {
                    log::warn!("working copies could not be listed: {e}");
                    BTreeSet::new()
                });
            st.copies = Some(read);
        }
        st.copies.clone().unwrap_or_default()
    }

    /// A book became a working copy.
    pub(crate) fn add(&self, lib: &Library, book: &str) {
        self.copies(lib);
        if let Some(c) = &mut lock(&self.state).copies {
            c.insert(book.to_owned());
        }
    }

    /// A working copy is gone.
    pub(crate) fn remove(&self, book: &str) {
        let mut st = lock(&self.state);
        if let Some(c) = &mut st.copies {
            c.remove(book);
        }
        st.pending.remove(book);
    }

    /// Hear a library event: a committed write to a working copy waits to
    /// be saved.
    pub(crate) fn on_event(self: &Arc<Self>, inner: &Weak<Inner>, lib: &Library, e: &StoreEvent) {
        let StoreEvent::Doc(ev) = e else {
            return;
        };
        let copies = self.copies(lib);
        if copies.is_empty() {
            return;
        }
        let Some(book) = book_of(lib, &ev.doc_id).filter(|b| copies.contains(b)) else {
            return;
        };
        let mut st = lock(&self.state);
        st.pending.insert(book);
        // Closing: what comes in now waits for the next flush.
        if !st.thread && !st.stop {
            st.thread = true;
            let (saver, inner) = (Arc::clone(self), inner.clone());
            let spawned = std::thread::Builder::new()
                .name("dr-working-copy-saver".into())
                .spawn(move || saver.run(inner));
            if let Err(e) = spawned {
                st.thread = false;
                log::warn!("the working-copy saver could not start: {e}");
            }
        }
        self.cv.notify_all();
    }

    fn run(self: Arc<Self>, inner: Weak<Inner>) {
        loop {
            {
                let mut st = lock(&self.state);
                loop {
                    if st.stop || inner.strong_count() == 0 {
                        st.thread = false;
                        self.cv.notify_all();
                        return;
                    }
                    if !st.pending.is_empty() && !st.busy {
                        break;
                    }
                    st = self
                        .cv
                        .wait_timeout(st, Duration::from_secs(5))
                        .map(|(g, _)| g)
                        .unwrap_or_else(|e| e.into_inner().0);
                }
            }
            // Gather the writes that follow (a word being typed).
            std::thread::sleep(GATHER);
            let books = {
                let mut st = lock(&self.state);
                if st.busy || st.stop {
                    continue;
                }
                st.busy = true;
                std::mem::take(&mut st.pending)
            };
            if let Some(inner) = inner.upgrade() {
                let ws = Workspace { inner };
                for book in &books {
                    if let Err(e) = save(&ws, book) {
                        log::warn!("working copy {book}: saving over its template failed: {e}");
                    }
                }
            }
            let mut st = lock(&self.state);
            st.busy = false;
            self.cv.notify_all();
        }
    }

    /// Save every working copy that waits, now, on this thread (after a
    /// round already running).
    pub(crate) fn flush(&self, ws: &Workspace) -> crate::Result<()> {
        loop {
            let books = {
                let mut st = lock(&self.state);
                while st.busy {
                    st = self.cv.wait(st).unwrap_or_else(|e| e.into_inner());
                }
                if st.pending.is_empty() {
                    return Ok(());
                }
                st.busy = true;
                std::mem::take(&mut st.pending)
            };
            let mut first = None;
            for book in &books {
                if let Err(e) = save(ws, book) {
                    log::warn!("working copy {book}: saving over its template failed: {e}");
                    first.get_or_insert(e);
                }
            }
            let mut st = lock(&self.state);
            st.busy = false;
            self.cv.notify_all();
            drop(st);
            if let Some(e) = first {
                return Err(e);
            }
        }
    }

    /// Stop the thread (the workspace is closing; a flush still saves what
    /// waits).
    pub(crate) fn stop(&self) {
        let mut st = lock(&self.state);
        st.stop = true;
        self.cv.notify_all();
    }

    /// Start hearing writes again (the workspace listens to its library).
    pub(crate) fn resume(&self) {
        lock(&self.state).stop = false;
    }
}

fn save(ws: &Workspace, book: &str) -> crate::Result<()> {
    crate::commands::v3::project_template::save_working_copy(
        ws,
        &crate::Actor::User,
        book,
        crate::commands::v3::project_template::WorkingCopyWords::default(),
    )
    .map(|_| ())
}
