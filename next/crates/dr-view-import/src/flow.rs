//! Where an import is, and the thread it runs on.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::reimport::{self, Destination, ResultOfImport};
use dr_i18n::keys;
use dr_import_v1::gate::{Accept, Gate, Reason};
use dr_import_v1::locate::{self, Owner, Picked};
use dr_import_v1::progress::Progress;
use dr_import_v1::receipt::{Receipt, Unfinished};
use dr_import_v1::run::Cancel;
use dr_import_v1::{
    ImportError,
    v3::{MappingChoices, Pending},
};
use dr_shell::notifications::{NoticeAction, Notifications, Source};
use dr_shell::strings::tf;
use dr_shell::{Services, ShellInfo, t};
use futures::StreamExt as _;
use gpui::{
    AnyWindowHandle, App, AppContext as _, Context, Entity, FocusHandle, PathPromptOptions, Task,
    Window,
};

/// Where the 0.1 client keeps its libraries on this device, by its own rule
/// (`src-tauri/src/data_paths.rs`, `base_local_root`): `DRIFTING_APP_DATA_DIR`
/// when set (0.1's development override; tests and the debug bridge point it
/// at synthetic libraries), else the release app's local data folder. A
/// development build has no 0.1 counterpart and never looks into the release
/// app's folder: without the variable it finds nothing and shows the folder
/// panel.
pub const V1_DATA_DIR_ENV: &str = "DRIFTING_APP_DATA_DIR";

/// After asking the import to finish its book, how long quitting waits;
/// then it asks it to stop at once and waits [`QUIT_WAIT_NOW`] more. One
/// second each (F7, f7-platform.md): the window stands frozen meanwhile, and
/// a book stopped at once is carried on byte for byte by the next import.
pub const QUIT_WAIT_BOOK: Duration = Duration::from_secs(1);

/// Where the import is.
#[derive(Clone, Debug, Default)]
pub enum State {
    /// Nothing open.
    #[default]
    Idle,
    /// The system's folder panel is open.
    Picking,
    /// The 0.1 libraries found on this device, to pick one from.
    Found(Found),
    Ready(Ready),
    Running(Running),
    Switching(Done),
    /// The gate stopped it; nothing was written.
    Blocked(Blocked),
    Done(Done),
    Failed(Failed),
}

#[derive(Clone, Debug)]
pub struct Found {
    pub libraries: Vec<FoundLibrary>,
}

/// A local 0.1 library on this device.
#[derive(Clone, Debug)]
pub struct FoundLibrary {
    /// What the dialogs call it: the last part of its folder.
    pub folder: String,
    pub picked: Picked,
    /// When its database last changed, ms since the epoch.
    pub modified_ms: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct Ready {
    pub folder: String,
    pub target: PathBuf,
    pub pending: Vec<Pending>,
    pub explicit_choices: bool,
}

#[derive(Clone, Debug)]
pub struct Running {
    /// The chosen folder's name (the dialogs show no full paths).
    pub folder: String,
    pub accept: Accept,
    /// The latest report; `None` until the first.
    pub progress: Option<Progress>,
    /// 「取消」 was pressed: the book being written is finished, then it stops.
    pub cancelling: bool,
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
    /// Stopped with 「取消」 before the last book.
    pub cancelled: bool,
    /// The device took over the 0.1 library's installation id.
    pub identity_adopted: bool,
    pub total_ms: f64,
}

#[derive(Clone, Debug)]
pub struct DoneBook {
    pub id: String,
    pub name: String,
    /// `imported`, `already-imported`, `already-in-library`, `cancelled`,
    /// `importing` (stopped while written; the next import carries it on),
    /// or why not.
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
    Cancelled,
    Done(Done, Box<Destination>),
    Pending(Vec<Pending>),
    Failed(String),
}

/// The app's import: its state, the dialog's focus, the import's thread and
/// the task listening to it.
pub struct LegacyImport {
    pub(crate) state: State,
    pub(crate) focus: FocusHandle,
    /// Where the focus was before the dialog took it.
    restore: Option<FocusHandle>,
    task: Option<Task<()>>,
    thread: Option<JoinHandle<()>>,
    worker_live: Arc<AtomicBool>,
    cancel: Cancel,
    destination: Option<Destination>,
    draining: bool,
    /// Where to look for the local 0.1 libraries ([`v1_data_dir`]).
    v1_dir: Option<PathBuf>,
    /// The window the author started the import in: its dialogs show there.
    window: Option<AnyWindowHandle>,
    /// The reminders posted for books an import left unfinished: (notice,
    /// book id). Each goes once its book is imported.
    reminders: Vec<(u64, String)>,
}

impl LegacyImport {
    pub(crate) fn new(cx: &mut Context<Self>) -> LegacyImport {
        LegacyImport {
            state: State::Idle,
            focus: cx.focus_handle(),
            restore: None,
            task: None,
            thread: None,
            worker_live: Arc::new(AtomicBool::new(false)),
            cancel: Cancel::default(),
            destination: None,
            draining: false,
            v1_dir: v1_data_dir(),
            window: None,
            reminders: Vec::new(),
        }
    }

    /// The window the import was started in (its dialogs show there).
    pub fn window(&self) -> Option<AnyWindowHandle> {
        self.window
    }

    /// The notices posted for unfinished books: (notice id, book id).
    pub fn reminders(&self) -> &[(u64, String)] {
        &self.reminders
    }

    /// Looks for the local 0.1 libraries in `dir` instead (tests and
    /// captures: synthetic libraries, never the process environment).
    #[doc(hidden)]
    pub fn look_in(&mut self, dir: Option<PathBuf>) {
        self.v1_dir = dir;
    }

    pub fn state(&self) -> &State {
        &self.state
    }

    /// Whether a dialog (or the folder panel) is open.
    pub fn is_open(&self) -> bool {
        !matches!(self.state, State::Idle)
    }

    /// Whether the import's thread is still working.
    pub fn is_running(&self) -> bool {
        self.worker_live.load(Ordering::Acquire)
    }

    /// The bookshelf's entry: the 0.1 libraries on this device to pick from,
    /// or, when there are none, the folder panel. Does nothing while an
    /// import is open.
    pub fn choose(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_open() || self.draining || dr_shell::release::is_releasing(cx) {
            return;
        }
        self.window = Some(window.window_handle());
        let libraries = self
            .v1_dir
            .as_deref()
            .map(find_local_libraries)
            .unwrap_or_default();
        if libraries.is_empty() {
            self.choose_folder(window, cx);
        } else {
            log::info!("{} local 0.1 libraries on this device", libraries.len());
            self.state = State::Found(Found { libraries });
            self.take_focus(window, cx);
            cx.notify();
        }
    }

    /// The system's folder panel (from the list too: 「选择文件夹」).
    pub fn choose_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.draining
            || dr_shell::release::is_releasing(cx)
            || matches!(
                self.state,
                State::Running(_) | State::Switching(_) | State::Picking
            )
        {
            return;
        }
        self.window = Some(window.window_handle());
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
                    _ => import.close_now(window, cx),
                })
            })
            .ok();
        }));
        cx.notify();
    }

    /// Imports the library at `index` of the list.
    pub fn pick(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let State::Found(found) = &self.state else {
            return;
        };
        let Some(library) = found.libraries.get(index).cloned() else {
            return;
        };
        self.configure(library.folder, library.picked, window, cx);
    }

    /// Imports the 0.1 library `folder` stands for: what the folder panel
    /// gave (tests and captures call it directly).
    pub fn start(&mut self, folder: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_running()
            || self.draining
            || matches!(self.state, State::Switching(_))
            || dr_shell::release::is_releasing(cx)
        {
            return;
        }
        let name = folder_name(&folder);
        match locate::resolve(&folder) {
            Ok(picked) => self.configure(name, picked, window, cx),
            Err(error) => self.fail(Some(name), error.to_string(), window, cx),
        }
    }

    fn configure(
        &mut self,
        folder: String,
        picked: Picked,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.window = Some(window.window_handle());
        let original = cx
            .try_global::<Services>()
            .and_then(|s| s.library.as_ref())
            .map(|ws| ws.library().paths().root.clone());
        match original
            .ok_or_else(|| "no library is open".to_owned())
            .and_then(|old| Destination::prepare(&old, &picked))
        {
            Ok(job) => {
                self.state = State::Ready(Ready {
                    folder,
                    target: job.target(),
                    pending: Vec::new(),
                    explicit_choices: serde_json::to_value(&job.choices).ok()
                        != serde_json::to_value(MappingChoices::default()).ok(),
                });
                self.destination = Some(job);
                self.take_focus(window, cx);
                cx.notify();
            }
            Err(error) => self.fail(Some(folder), error, window, cx),
        }
    }

    pub fn destination(&self) -> Option<&Destination> {
        self.destination.as_ref()
    }

    /// The same serialized MappingChoices consumed by the v3 importer. No
    /// fixture policy or guessed product default is substituted here.
    pub fn set_mapping_choices(&mut self, choices: MappingChoices) -> Result<(), String> {
        if !matches!(self.state, State::Ready(_)) {
            return Err("import is not awaiting mapping choices".into());
        }
        self.destination
            .as_mut()
            .ok_or("no import destination")?
            .set_choices(choices)?;
        if let State::Ready(ready) = &mut self.state {
            ready.explicit_choices = true;
            ready.pending.clear();
        }
        Ok(())
    }

    pub fn choose_mapping(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !matches!(self.state, State::Ready(_)) {
            return;
        }
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: None,
        });
        self.task = Some(cx.spawn_in(window, async move |this, cx| {
            let answer = paths.await;
            cx.update(|_, cx| {
                let _ = this.update(cx, |import, cx| {
                    if let Ok(Ok(Some(paths))) = answer {
                        let result = paths
                            .first()
                            .ok_or_else(|| "no mapping file selected".to_owned())
                            .and_then(|path| std::fs::read(path).map_err(|e| e.to_string()))
                            .and_then(|bytes| {
                                serde_json::from_slice(&bytes).map_err(|e| e.to_string())
                            })
                            .and_then(|choices| import.set_mapping_choices(choices));
                        if let Err(message) = result {
                            dr_shell::notifications::Notifications::post(
                                Source::Import,
                                message,
                                cx,
                            );
                        }
                        cx.notify();
                    }
                });
            })
            .ok();
        }));
    }

    pub fn start_configured(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let State::Ready(ready) = &self.state else {
            return;
        };
        let Some(job) = self.destination.clone() else {
            return;
        };
        self.run(
            ready.folder.clone(),
            job.picked(),
            Accept::NOTHING,
            window,
            cx,
        );
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

    /// A reminder's 「接着导入」: imports again the 0.1 library `book` came
    /// from, which carries the book on (and any other book that import left
    /// unfinished). When that library is no longer where it was, the
    /// bookshelf entry's choice instead. The gate decides again: what was
    /// accepted before is not taken as accepted now.
    pub fn carry_on(&mut self, book: &Unfinished, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_open() || self.draining || dr_shell::release::is_releasing(cx) {
            return;
        }
        match book.database.as_ref().filter(|d| d.is_file()) {
            Some(database) => {
                let root = book.root.clone().unwrap_or_else(|| {
                    database
                        .parent()
                        .and_then(Path::parent)
                        .unwrap_or(database)
                        .to_path_buf()
                });
                log::info!("carrying on the 0.1 library import of {:?}", book.book_id);
                let picked = Picked {
                    database: database.clone(),
                    root: root.clone(),
                    id: None,
                    left: Vec::new(),
                };
                self.configure(folder_name(&root), picked, window, cx);
            }
            None => {
                log::info!("the 0.1 library of an unfinished book is gone; choosing again");
                self.choose(window, cx);
            }
        }
    }

    /// Posts a reminder for each book an import left unfinished (read off
    /// the main thread at launch, [`check_unfinished`]).
    pub(crate) fn remind(&mut self, books: Vec<Unfinished>, cx: &mut Context<Self>) {
        let this = cx.entity();
        for book in books {
            if self.reminders.iter().any(|(_, id)| *id == book.book_id) {
                continue;
            }
            let name = if book.name.trim().is_empty() {
                t(cx, keys::common::UNTITLED)
            } else {
                book.name.clone().into()
            };
            let text = tf(cx, k_notice::UNFINISHED, &[("name", &name)]);
            let id = book.book_id.clone();
            let import = this.clone();
            let action = NoticeAction {
                label: t(cx, k_notice::CARRY_ON),
                run: std::rc::Rc::new(move |_, window, cx| {
                    import.update(cx, |import, cx| import.carry_on(&book, window, cx));
                }),
            };
            let notice = Notifications::post_with(Source::Import, text, action, cx);
            self.reminders.push((notice, id));
        }
    }

    /// 「取消」 while it runs: the book being written is finished (no book is
    /// left half-written), the rest are left out; before any book is written,
    /// nothing is.
    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        let State::Running(running) = &mut self.state else {
            return;
        };
        if !running.cancelling {
            log::info!("the 0.1 library import is asked to stop after this book");
            running.cancelling = true;
            self.cancel.after_book();
            cx.notify();
        }
    }

    pub(crate) fn begin_drain(&mut self) -> Option<(JoinHandle<()>, Cancel)> {
        self.draining = true;
        self.cancel.after_book();
        self.thread
            .take()
            .map(|thread| (thread, self.cancel.clone()))
    }
    pub(crate) fn end_drain(&mut self) {
        self.draining = false;
    }

    /// Closes the dialog: the list, a stopped import, the summary or the
    /// failure. Not while the import runs.
    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(
            self.state,
            State::Running(_) | State::Switching(_) | State::Picking | State::Idle
        ) {
            return;
        }
        self.close_now(window, cx);
    }

    fn close_now(&mut self, window: &mut Window, cx: &mut Context<Self>) {
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
        if self.is_running() || self.draining || dr_shell::release::is_releasing(cx) {
            return;
        }
        self.window = Some(window.window_handle());
        let Some(job) = self.destination.clone() else {
            self.fail(
                Some(folder),
                "no explicit import destination".into(),
                window,
                cx,
            );
            return;
        };
        let Some(options) = cx
            .try_global::<Services>()
            .and_then(|s| s.library.as_ref())
            .map(|ws| ws.library().options().clone())
        else {
            self.fail(Some(folder), "no library is open".into(), window, cx);
            return;
        };
        let version = cx
            .try_global::<ShellInfo>()
            .map_or(env!("CARGO_PKG_VERSION"), |i| i.version)
            .to_owned();
        self.cancel = Cancel::default();
        let cancel = self.cancel.clone();
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<Msg>();
        self.worker_live.store(true, Ordering::Release);
        let live = WorkerLive(self.worker_live.clone());
        let spawned = {
            let (picked, folder) = (picked.clone(), folder.clone());
            std::thread::Builder::new()
                .name("legacy-import".into())
                .spawn(move || {
                    let _live = live;
                    let reports = tx.clone();
                    let outcome = reimport::import(job, &version, accept, cancel, &mut |p| {
                        let _ = reports.unbounded_send(Msg::Progress(p.clone()));
                    });
                    let msg = match outcome {
                        Ok(ResultOfImport::Blocked(gate)) => Msg::Blocked(gate),
                        Ok(ResultOfImport::Cancelled) => Msg::Cancelled,
                        Ok(ResultOfImport::Imported {
                            job,
                            receipt,
                            timing,
                        }) => {
                            // Import's unindexed store is closed already. Rebuild canonical
                            // indexes using an ordinary workspace, then close that too.
                            match dr_store::Library::open(job.target(), options)
                                .map_err(|e| e.to_string())
                                .and_then(|lib| {
                                    dr_workspace::Workspace::open(
                                        lib,
                                        dr_workspace::WorkspaceOptions::default(),
                                    )
                                    .map_err(|e| e.to_string())
                                }) {
                                Ok(ws) => {
                                    let done =
                                        summary(&ws, folder, &picked, &receipt, timing.total_ms);
                                    match ws.try_shutdown() {
                                        Ok(()) => Msg::Done(done, job),
                                        Err(error) => Msg::Failed(format!(
                                            "import target could not close: {}",
                                            error.error
                                        )),
                                    }
                                }
                                Err(error) => Msg::Failed(error),
                            }
                        }
                        Err(ImportError::V3Pending(pending)) => Msg::Pending(pending),
                        Err(error) => Msg::Failed(error.to_string()),
                    };
                    let _ = tx.unbounded_send(msg);
                })
        };
        let thread = match spawned {
            Ok(thread) => thread,
            Err(error) => {
                self.fail(Some(folder), error.to_string(), window, cx);
                return;
            }
        };
        self.thread = Some(thread);
        log::info!("importing the 0.1 library in {folder:?} (accepting {accept:?})");
        self.state = State::Running(Running {
            folder: folder.clone(),
            accept,
            progress: None,
            cancelling: false,
        });
        self.take_focus(window, cx);
        self.task = Some(cx.spawn_in(window, async move |this, cx| {
            // Progress comes in bursts; take what is there and paint once.
            while let Some(first) = rx.next().await {
                let mut batch = vec![first];
                while let Ok(more) = rx.try_recv() {
                    batch.push(more);
                }
                let alive = this.update_in(cx, |import, window, cx| {
                    for msg in batch {
                        import.receive(&folder, &picked, msg, window, cx);
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

    fn receive(
        &mut self,
        folder: &str,
        picked: &Picked,
        msg: Msg,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
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
            Msg::Cancelled => {
                log::info!("the 0.1 library import was cancelled before writing anything");
                self.close_now(window, cx);
            }
            Msg::Done(done, job) => {
                let job = *job;
                self.destination = Some(job.clone());
                let finished: HashSet<&str> = done
                    .books
                    .iter()
                    .filter(|b| matches!(b.status.as_str(), "imported" | "already-imported"))
                    .map(|b| b.id.as_str())
                    .collect();
                let (gone, kept) = std::mem::take(&mut self.reminders)
                    .into_iter()
                    .partition::<Vec<_>, _>(|(_, book)| {
                        finished.contains(book.as_str()) || book == &job.id
                    });
                self.reminders = kept;
                for (notice, _) in gone {
                    Notifications::remove(notice, cx);
                }
                log::info!(
                    "imported the 0.1 library: {} books in {:.0} ms{}",
                    done.books.len(),
                    done.total_ms,
                    if done.cancelled { " (cancelled)" } else { "" }
                );
                if done.cancelled || !job.completed || self.draining {
                    self.state = State::Done(done);
                } else {
                    self.activate(job, done, cx);
                }
            }
            Msg::Pending(pending) => {
                if let Some(job) = &self.destination {
                    self.state = State::Ready(Ready {
                        folder: folder.to_owned(),
                        target: job.target(),
                        pending,
                        explicit_choices: serde_json::to_value(&job.choices).ok()
                            != serde_json::to_value(MappingChoices::default()).ok(),
                    });
                }
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
    fn activate(&mut self, job: Destination, done: Done, cx: &mut Context<Self>) {
        self.state = State::Switching(done.clone());
        let thread = self.thread.take();
        let this = cx.entity();
        cx.spawn(async move |_, cx| {
            let joined = cx
                .background_executor()
                .spawn(async move {
                    thread.map_or(Ok(()), |thread| {
                        thread
                            .join()
                            .map_err(|_| "import worker panicked".to_owned())
                    })
                })
                .await;
            cx.update(|cx| {
                if let Err(message) = joined {
                    this.update(cx, |import, cx| {
                        import.state = State::Failed(Failed {
                            folder: Some(done.folder),
                            message,
                        });
                        cx.notify();
                    });
                    return;
                }
                // Release hooks only settle already finished work; the long
                // cancellable import above ran with ordinary UI admission.
                let commit = job.clone();
                dr_shell::library::replace_with_commit(
                    cx,
                    move |old, options| job.open_target(old, options),
                    move |ws| commit.commit_selection(ws),
                    move |result, cx| {
                        this.update(cx, |import, cx| {
                            import.state = match result {
                                Ok(()) => State::Done(done),
                                Err(message) => State::Failed(Failed {
                                    folder: Some(done.folder),
                                    message,
                                }),
                            };
                            cx.notify();
                        })
                    },
                );
            });
        })
        .detach();
    }
}

use dr_i18n::keys::import::v1::notice as k_notice;

/// At launch: the books this device's imports left unfinished, read from the
/// library's receipt off the main thread, each posted as a reminder in the
/// notification center ([`LegacyImport::remind`]).
pub(crate) fn check_unfinished(import: Entity<LegacyImport>, cx: &mut App) {
    let Some(ws) = cx.try_global::<Services>().and_then(|s| s.library.clone()) else {
        return;
    };
    let root = ws.library().paths().root.clone();
    let read = cx.background_spawn(async move {
        let mut books = ws
            .library()
            .local_read(|c| Ok(dr_import_v1::receipt::unfinished(c)?))
            .map_err(|e| e.to_string())?;
        if let Some(job) = Destination::unfinished(&root)? {
            books.push(Unfinished {
                book_id: job.id,
                name: folder_name(&job.source_root),
                database: Some(job.database),
                root: Some(job.source_root),
            });
        }
        Ok::<_, String>(books)
    });
    cx.spawn(async move |cx| {
        let books = match read.await {
            Ok(books) => books,
            Err(error) => {
                log::warn!("the import receipts could not be read: {error}");
                return;
            }
        };
        if books.is_empty() {
            return;
        }
        log::info!("{} books an import left unfinished", books.len());
        cx.update(|cx| import.update(cx, |import, cx| import.remind(books, cx)));
    })
    .detach();
}

struct WorkerLive(Arc<AtomicBool>);
impl Drop for WorkerLive {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub(crate) fn drain_worker(thread: JoinHandle<()>, cancel: Cancel) -> Result<(), String> {
    cancel.after_book();
    if !wait_for(&thread, QUIT_WAIT_BOOK) {
        cancel.now();
    }
    thread
        .join()
        .map_err(|_| "import worker panicked during release".to_owned())
}

fn wait_for(thread: &JoinHandle<()>, at_most: Duration) -> bool {
    let until = Instant::now() + at_most;
    while !thread.is_finished() {
        if Instant::now() >= until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    true
}

/// The 0.1 client's data folder on this device ([`V1_DATA_DIR_ENV`]).
pub fn v1_data_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os(V1_DATA_DIR_ENV).filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let identity = dr_platform::Identity::current();
    if !identity.is_release() {
        return None;
    }
    dr_platform::AppDirs::for_identity(&dr_platform::identity::RELEASE)
        .ok()
        .map(|dirs| dirs.data)
}

/// The local 0.1 libraries in the 0.1 data folder `base` (the registry's
/// `legacy` and `local` ones whose database exists; account libraries wait
/// for M35), the active one first. Reads the registry and the files' times
/// only.
pub fn find_local_libraries(base: &Path) -> Vec<FoundLibrary> {
    let all = match locate::discover(base) {
        Ok(all) => all,
        Err(error) => {
            log::warn!("the 0.1 libraries on this device could not be listed: {error}");
            return Vec::new();
        }
    };
    let existing: Vec<_> = all.into_iter().filter(|l| l.exists).collect();
    existing
        .iter()
        .filter(|l| matches!(l.owner, None | Some(Owner::Local)))
        .map(|l| FoundLibrary {
            folder: folder_name(&l.root),
            picked: Picked {
                database: l.database.clone(),
                root: l.root.clone(),
                id: Some(l.id.clone()),
                left: existing
                    .iter()
                    .filter(|o| o.id != l.id && !matches!(o.owner, None | Some(Owner::Local)))
                    .map(|o| o.id.clone())
                    .collect(),
            },
            modified_ms: modified_ms(&l.database),
        })
        .collect()
}

fn modified_ms(path: &Path) -> Option<i64> {
    let at = std::fs::metadata(path).ok()?.modified().ok()?;
    let since = at.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}

/// Now, ms since the epoch (the list's 「多久以前」).
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
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
            .and_then(|b| b.words)
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
        cancelled: receipt.cancelled,
        identity_adopted: receipt.installation_id_adopted,
        total_ms,
    }
}
