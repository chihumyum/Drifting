//! Where an import is, and the thread it runs on.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use dr_i18n::keys;
use dr_import_v1::gate::{Accept, Gate, Reason};
use dr_import_v1::locate::{self, Picked};
use dr_import_v1::progress::Progress;
use dr_import_v1::receipt::Receipt;
use dr_import_v1::run::{self, Options, Outcome};
use dr_shell::{Services, ShellInfo, t};
use futures::StreamExt as _;
use gpui::{Context, FocusHandle, PathPromptOptions, Task, Window};

/// Where the import is.
#[derive(Clone, Debug, Default)]
pub enum State {
    /// Nothing open.
    #[default]
    Idle,
    /// The system's folder panel is open.
    Picking,
    Running(Running),
    /// The gate stopped it; nothing was written.
    Blocked(Blocked),
    Done(Done),
    Failed(Failed),
}

#[derive(Clone, Debug)]
pub struct Running {
    /// The chosen folder's name (the dialogs show no full paths).
    pub folder: String,
    pub accept: Accept,
    /// The latest report; `None` until the first.
    pub progress: Option<Progress>,
}

#[derive(Clone, Debug)]
pub struct Blocked {
    pub folder: String,
    pub picked: Picked,
    pub gate: Gate,
}

#[derive(Clone, Debug)]
pub struct Done {
    pub folder: String,
    pub books: Vec<DoneBook>,
    /// Bodies of the imported books that came from caches the gate could not
    /// prove the latest (accepted with 「仍然导入」).
    pub from_caches: usize,
    /// Libraries in the chosen folder this import left alone (account
    /// libraries, M35).
    pub left: Vec<String>,
    pub total_ms: f64,
}

#[derive(Clone, Debug)]
pub struct DoneBook {
    pub id: String,
    pub name: String,
    /// `imported`, `already-imported`, `already-in-library`, or why not.
    pub status: String,
    /// The live chapters' words, as the bookshelf counts them; `None` for a
    /// book that is in Recently Deleted (or was not read).
    pub words: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct Failed {
    pub folder: Option<String>,
    /// What went wrong, as the import says it.
    pub message: String,
}

/// From the import's thread.
enum Msg {
    Progress(Progress),
    Blocked(Gate),
    Done(Done),
    Failed(String),
}

/// The app's import: its state, the dialog's focus, the task listening to
/// the import's thread.
pub struct LegacyImport {
    pub(crate) state: State,
    pub(crate) focus: FocusHandle,
    /// Where the focus was before the dialog took it.
    restore: Option<FocusHandle>,
    task: Option<Task<()>>,
}

impl LegacyImport {
    pub(crate) fn new(cx: &mut Context<Self>) -> LegacyImport {
        LegacyImport {
            state: State::Idle,
            focus: cx.focus_handle(),
            restore: None,
            task: None,
        }
    }

    pub fn state(&self) -> &State {
        &self.state
    }

    /// Whether a dialog (or the folder panel) is open.
    pub fn is_open(&self) -> bool {
        !matches!(self.state, State::Idle)
    }

    /// The bookshelf's entry: the folder panel, then the import. Does nothing
    /// while an import is open.
    pub fn choose(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_open() {
            return;
        }
        self.state = State::Picking;
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some(t(cx, keys::import_dialog::CHOOSE_FOLDER)),
        });
        self.task = Some(cx.spawn_in(window, async move |this, cx| {
            let answer = paths.await;
            // In the window it was started in: the dialog is not drawn while
            // the folder panel is up, so the entity has no window of its own.
            cx.update(|window, cx| {
                this.update(cx, |import, cx| match answer {
                    Ok(Ok(Some(paths))) if !paths.is_empty() => {
                        let folder = paths.into_iter().next().expect("one path");
                        import.start(folder, window, cx);
                    }
                    Ok(Err(error)) => import.fail(None, error.to_string(), window, cx),
                    // Cancelled.
                    _ => {
                        import.state = State::Idle;
                        cx.notify();
                    }
                })
            })
            .ok();
        }));
        cx.notify();
    }

    /// Imports the 0.1 library `folder` stands for: what the folder panel
    /// gave (tests and captures call it directly).
    pub fn start(&mut self, folder: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let name = folder_name(&folder);
        match locate::resolve(&folder) {
            Ok(picked) => self.run(name, picked, Accept::NOTHING, window, cx),
            Err(error) => self.fail(Some(name), error.to_string(), window, cx),
        }
    }

    /// 「仍然导入」: the import the gate stopped, again, accepting what it
    /// stopped for.
    pub fn import_anyway(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let State::Blocked(blocked) = &self.state else {
            return;
        };
        let reasons = &blocked.gate.reasons;
        let accept = Accept {
            unproven_bodies: reasons.iter().any(|r| *r != Reason::Sync),
            sync_blockers: reasons.contains(&Reason::Sync),
        };
        let (folder, picked) = (blocked.folder.clone(), blocked.picked.clone());
        self.run(folder, picked, accept, window, cx);
    }

    /// Closes the dialog: cancels a stopped import, dismisses the summary or
    /// the failure. Not while the import runs.
    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.state, State::Running(_) | State::Picking | State::Idle) {
            return;
        }
        self.state = State::Idle;
        self.task = None;
        if let Some(back) = self.restore.take() {
            window.focus(&back, cx);
        }
        cx.notify();
    }

    /// Shows `state` as it is (screenshots: a progress report recorded from
    /// a real import, held still).
    #[doc(hidden)]
    pub fn show(&mut self, state: State, window: &mut Window, cx: &mut Context<Self>) {
        self.task = None;
        self.state = state;
        self.take_focus(window, cx);
        cx.notify();
    }

    fn take_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus.is_focused(window) {
            self.restore = window.focused(cx);
            window.focus(&self.focus, cx);
        }
    }

    fn fail(
        &mut self,
        folder: Option<String>,
        message: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        log::warn!("the 0.1 library import failed: {message}");
        self.state = State::Failed(Failed { folder, message });
        self.task = None;
        self.take_focus(window, cx);
        cx.notify();
    }

    fn run(
        &mut self,
        folder: String,
        picked: Picked,
        accept: Accept,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(ws) = cx.try_global::<Services>().and_then(|s| s.library.clone()) else {
            self.fail(Some(folder), "no library is open".into(), window, cx);
            return;
        };
        let version = cx
            .try_global::<ShellInfo>()
            .map_or(env!("CARGO_PKG_VERSION"), |i| i.version);
        let mut options = Options::new(version);
        options.accept = accept;
        options.old_root = Some(picked.root.clone());
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<Msg>();
        let spawned = {
            let (picked, folder) = (picked.clone(), folder.clone());
            std::thread::Builder::new()
                .name("legacy-import".into())
                .spawn(move || {
                    let reports = tx.clone();
                    let outcome = run::import_into_library(
                        &picked.database,
                        ws.library(),
                        &options,
                        &mut |p| {
                            let _ = reports.unbounded_send(Msg::Progress(p.clone()));
                        },
                    );
                    let msg = match outcome {
                        Ok((Outcome::Blocked(gate), _)) => Msg::Blocked(gate),
                        Ok((Outcome::Imported(receipt), timing)) => {
                            Msg::Done(summary(&ws, folder, &picked, &receipt, timing.total_ms))
                        }
                        Err(error) => Msg::Failed(error.to_string()),
                    };
                    let _ = tx.unbounded_send(msg);
                })
        };
        if let Err(error) = spawned {
            self.fail(Some(folder), error.to_string(), window, cx);
            return;
        }
        log::info!("importing the 0.1 library in {folder:?} (accepting {accept:?})");
        self.state = State::Running(Running {
            folder: folder.clone(),
            accept,
            progress: None,
        });
        self.take_focus(window, cx);
        self.task = Some(cx.spawn_in(window, async move |this, cx| {
            // Progress comes in bursts; take what is there and paint once.
            while let Some(first) = rx.next().await {
                let mut batch = vec![first];
                while let Ok(more) = rx.try_recv() {
                    batch.push(more);
                }
                let alive = this.update(cx, |import, cx| {
                    for msg in batch {
                        import.receive(&folder, &picked, msg);
                    }
                    cx.notify();
                });
                if alive.is_err() {
                    return;
                }
            }
            // The thread ended without a word (it panicked).
            cx.update(|window, cx| {
                this.update(cx, |import, cx| {
                    if matches!(import.state, State::Running(_)) {
                        import.fail(
                            Some(folder.clone()),
                            "the import stopped unexpectedly".into(),
                            window,
                            cx,
                        );
                    }
                })
            })
            .ok();
        }));
        cx.notify();
    }

    fn receive(&mut self, folder: &str, picked: &Picked, msg: Msg) {
        match msg {
            Msg::Progress(p) => {
                if let State::Running(running) = &mut self.state {
                    running.progress = Some(p);
                }
            }
            Msg::Blocked(gate) => {
                log::info!(
                    "the 0.1 library import stopped at the gate: {:?}",
                    gate.reasons
                );
                self.state = State::Blocked(Blocked {
                    folder: folder.to_owned(),
                    picked: picked.clone(),
                    gate,
                });
            }
            Msg::Done(done) => {
                log::info!(
                    "imported the 0.1 library: {} books in {:.0} ms",
                    done.books.len(),
                    done.total_ms
                );
                self.state = State::Done(done);
            }
            Msg::Failed(message) => {
                log::warn!("the 0.1 library import failed: {message}");
                self.state = State::Failed(Failed {
                    folder: Some(folder.to_owned()),
                    message,
                });
            }
        }
    }
}

/// The last component of the chosen folder (the dialogs show no full paths).
fn folder_name(folder: &Path) -> String {
    folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| folder.display().to_string())
}

/// The summary, read on the import's thread: each book of the receipt with
/// its words as the bookshelf counts them (the indexes are built by now).
fn summary(
    ws: &dr_workspace::Workspace,
    folder: String,
    picked: &Picked,
    receipt: &Receipt,
    total_ms: f64,
) -> Done {
    let shelf = match dr_view_shelf::data::ShelfData::load(ws) {
        Ok(data) => Some(data),
        Err(error) => {
            log::warn!("the bookshelf could not be read for the import summary: {error}");
            None
        }
    };
    let words = |id: &str| {
        shelf
            .as_ref()?
            .books
            .iter()
            .find(|b| b.id == id)
            .map(|b| b.words)
    };
    let books: Vec<DoneBook> = receipt
        .books
        .iter()
        .map(|b| DoneBook {
            id: b.book_id.clone(),
            name: b.name.clone(),
            status: b.status.clone(),
            words: words(&b.book_id),
        })
        .collect();
    let imported: HashSet<&str> = receipt
        .books
        .iter()
        .filter(|b| b.status == "imported")
        .map(|b| b.book_id.as_str())
        .collect();
    let from_caches = receipt
        .docs
        .iter()
        .filter(|d| imported.contains(d.book_id.as_str()) && !d.freshness.proven_fresh())
        .count();
    Done {
        folder,
        books,
        from_caches,
        left: picked.left.clone(),
        total_ms,
    }
}
