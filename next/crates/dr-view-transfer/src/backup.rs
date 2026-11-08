//! Whole-library backup and restore (the 0.1 client's
//! `LibraryBackupSettings`, on F2's `dr_store::backup`).
//!
//! - 「导出备份…」 ([`backup`]): the save panel (`Drifting-<date>.drifting`),
//!   then 「正在备份…」 while the package is written off the main thread (the
//!   library stays in use), then what it holds: 「已保存「…」。」, the books,
//!   asset files and size, and the asset files this device does not have.
//! - 「选择备份…」 ([`restore`]): the open panel, then 「正在核对…」 while the
//!   package is checked and extracted beside the library (still in use),
//!   then the 0.1 question: the file, when it was made, what it holds and
//!   which books, and that the current library is saved first. 「替换并恢复」
//!   hands the checked copy to the shell's [`Replace`], which closes the
//!   library, replaces it and opens it again; 「取消」 lets the copy go.
//!
//! A failure says why and leaves the library as it was.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use dr_i18n::keys;
use dr_store::StoreError;
use dr_store::backup::{self as store_backup, BackupSummary, Progress, StagedBackup, Step};
use dr_workspace::commands::book::{BookList, ListBooksIn};
use dr_workspace::{Actor, Workspace};
use futures::StreamExt as _;
use gpui::{App, Entity, PathPromptOptions, Task};

use crate::book::start_dir;
use crate::dialog::{State, TransferDialog};

use keys::settings::sync::backup as k;

/// Replaces the library with a checked backup: the shell closes the library
/// (everything holding it), calls `Library::restore_staged` and opens the
/// restored one (dr-store leaves the old one as it was on failure). The
/// dialog shows 「正在恢复…」 until the task ends; `Err` is said in it.
pub type Replace = Rc<dyn Fn(StagedBackup, ReportProgress, &mut App) -> Task<Result<(), String>>>;

/// Reports the store's current step from its worker thread. Keep this only
/// for the operation's lifetime; dropping it lets the dialog drain the last
/// reports before displaying the outcome. Losing a window does not cancel
/// the backup or interrupt a library replacement.
pub type ReportProgress = Box<dyn FnMut(&Progress) -> bool + Send>;

/// One receiver per operation. Completion waits for this task, so an old
/// inspection report cannot overwrite the subsequent restore's progress.
fn report_to(dialog: &Entity<TransferDialog>, cx: &mut App) -> (ReportProgress, Task<()>) {
    let (tx, mut rx) = futures::channel::mpsc::unbounded::<Progress>();
    let shown = dialog.downgrade();
    let updates = cx.spawn(async move |cx| {
        while let Some(p) = rx.next().await {
            shown
                .update(cx, |d, cx| {
                    if let State::Working { name, progress, .. } = &mut d.state {
                        let key = match p.step {
                            Step::Snapshot | Step::Pack | Step::SaveCurrent => k::EXPORTING,
                            Step::Extract | Step::Verify => k::INSPECTING,
                            Step::CopyAssets | Step::Replace => k::RESTORING,
                        };
                        *name = d.i18n.t(key).to_owned();
                        // The total belongs to this step, not the whole
                        // operation. Snapshot/verification/replacement have
                        // no byte total and remain indeterminate.
                        *progress = (p.total > 0)
                            .then(|| (p.done as f64 / p.total as f64).clamp(0.0, 1.0) as f32);
                        cx.notify();
                    }
                })
                .ok();
        }
    });
    let report = Box::new(move |p: &Progress| {
        let _ = tx.unbounded_send(*p);
        true
    });
    (report, updates)
}

struct Replacer(Replace);

impl gpui::Global for Replacer {}

/// Registers what replaces the library ([`Replace`]): the shell's swap
/// (close everything that holds the library, `Library::restore_staged`,
/// open the restored one), wired by the app once the shell has it.
pub fn set_replace(cx: &mut App, replace: Replace) {
    cx.set_global(Replacer(replace));
}

/// The registered [`Replace`]; without one a restore checks and asks, then
/// says it could not replace the library (nothing changes).
pub fn replacer(cx: &App) -> Replace {
    cx.try_global::<Replacer>()
        .map(|r| r.0.clone())
        .unwrap_or_else(|| {
            Rc::new(|_, _, cx| {
                cx.background_executor().spawn(async {
                    Err("this build cannot replace the open library yet".to_owned())
                })
            })
        })
}

/// `1.5 MB`, as 0.1 wrote sizes in these sentences.
pub fn size(bytes: u64) -> String {
    let b = bytes as f64;
    if b < 1024.0 * 1024.0 {
        format!("{} KB", ((b / 1024.0).round() as u64).max(1))
    } else if b < 1024.0 * 1024.0 * 1024.0 {
        format!("{:.1} MB", b / 1024.0 / 1024.0)
    } else {
        format!("{:.2} GB", b / 1024.0 / 1024.0 / 1024.0)
    }
}

/// `Drifting-2026-11-08.drifting`.
pub fn backup_filename(now: chrono::DateTime<chrono::Local>) -> String {
    format!(
        "Drifting-{}.{}",
        now.format("%Y-%m-%d"),
        store_backup::EXTENSION
    )
}

fn summary_text(dialog: &TransferDialog, s: &BackupSummary) -> String {
    dialog.i18n.fmt(
        k::SUMMARY,
        &[
            ("projects", &s.books.len()),
            ("assets", &s.asset_files),
            ("size", &size(s.package_bytes)),
        ],
    )
}

/// 「导出备份…」: the save panel, then [`backup_path`].
pub fn backup(cx: &mut App) {
    dr_shell::workspace::with_workspace(cx, |ws, _, cx| {
        let Some(lib) = ws.library.clone() else {
            return;
        };
        let path =
            cx.prompt_for_new_path(&start_dir(), Some(&backup_filename(chrono::Local::now())));
        cx.spawn(async move |_, cx| {
            if let Ok(Ok(Some(path))) = path.await {
                cx.update(|cx| {
                    backup_path(lib, path, cx);
                });
            }
        })
        .detach();
    });
}

/// Writes a backup of `lib` to `path` (whole or not at all).
pub fn backup_path(lib: Workspace, path: PathBuf, cx: &mut App) -> Entity<TransferDialog> {
    let file = file_name(&path);
    let dialog = TransferDialog::show(
        State::Working {
            title: k::EXPORT_TITLE,
            name: dr_shell::t(cx, k::EXPORTING).to_string(),
            progress: None,
        },
        cx,
    );
    let (mut report, updates) = report_to(&dialog, cx);
    let job = cx.background_executor().spawn(async move {
        let names: HashMap<String, String> = lib
            .run::<BookList>(&Actor::User, ListBooksIn { trashed: true })
            .map(|o| o.output.into_iter().map(|b| (b.id, b.name)).collect())
            .unwrap_or_default();
        lib.library().export_backup_with(&path, &names, &mut report)
    });
    let shown = dialog.clone();
    cx.spawn(async move |cx| {
        let result = job.await;
        updates.await;
        shown.update(cx, |d, cx| match result {
            Ok(summary) => {
                let mut text = format!(
                    "{}\n{}",
                    d.i18n.fmt(k::EXPORTED, &[("file", &file)]),
                    summary_text(d, &summary)
                );
                if summary.missing_assets > 0 {
                    text.push('\n');
                    text.push_str(
                        &d.i18n
                            .fmt(k::MISSING_ASSETS, &[("count", &summary.missing_assets)]),
                    );
                }
                d.set(
                    State::Done {
                        title: k::EXPORT_TITLE,
                        text,
                    },
                    cx,
                );
            }
            Err(e) => d.fail(k::EXPORT_TITLE, k::errors::UNKNOWN, e.to_string(), cx),
        });
    })
    .detach();
    dialog
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The sentence for a failed check or restore (0.1's codes, and 0.1's own
/// backups).
fn restore_reason(e: &StoreError) -> dr_i18n::Key {
    match e {
        StoreError::Backup { code, .. } if *code == store_backup::NEWER => k::errors::NEWER,
        StoreError::Backup { code, .. } if *code == store_backup::LEGACY => k::errors::LEGACY,
        StoreError::Backup { .. } => k::errors::INVALID,
        _ => k::errors::UNKNOWN,
    }
}

/// 「选择备份…」: the open panel, then [`restore_path`].
pub fn restore(replace: Replace, cx: &mut App) {
    dr_shell::workspace::with_workspace(cx, move |ws, _, cx| {
        let Some(lib) = ws.library.clone() else {
            return;
        };
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(dr_shell::t(cx, k::RESTORE_BUTTON)),
        });
        cx.spawn(async move |_, cx| {
            let path = match paths.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                _ => None,
            };
            if let Some(path) = path {
                cx.update(|cx| {
                    restore_path(lib, path, replace, cx);
                });
            }
        })
        .detach();
    });
}

/// Checks the backup at `path` beside `lib`, asks, then replaces the
/// library through `replace`.
pub fn restore_path(
    lib: Workspace,
    path: PathBuf,
    replace: Replace,
    cx: &mut App,
) -> Entity<TransferDialog> {
    let file = file_name(&path);
    let dialog = TransferDialog::show(
        State::Working {
            title: k::RESTORE_TITLE,
            name: dr_shell::t(cx, k::INSPECTING).to_string(),
            progress: None,
        },
        cx,
    );
    let root = lib.library().paths().root.clone();
    let version = lib.library().options().app_version.clone();
    let (mut report, updates) = report_to(&dialog, cx);
    let job = cx
        .background_executor()
        .spawn(async move { store_backup::stage_with(root, &path, &version, &mut report) });
    let shown = dialog.clone();
    cx.spawn(async move |cx| {
        let staged = job.await;
        updates.await;
        shown.update(cx, |d, cx| match staged {
            Ok(staged) => {
                let s = staged.summary();
                let mut names: Vec<String> = s
                    .books
                    .iter()
                    .take(5)
                    .map(|b| b.name.clone().unwrap_or_else(|| b.id.clone()))
                    .collect();
                if names.is_empty() {
                    names.push(d.i18n.t(k::NO_PROJECTS).to_owned());
                }
                let date = chrono::DateTime::from_timestamp_millis(s.created_at_ms)
                    .map(|t| {
                        t.with_timezone(&chrono::Local)
                            .format("%Y-%m-%d %H:%M")
                            .to_string()
                    })
                    .unwrap_or_default();
                let text = d.i18n.fmt(
                    k::RESTORE_CONFIRM,
                    &[
                        ("file", &file),
                        ("date", &date),
                        ("summary", &summary_text(d, s)),
                        ("projects", &names.join("、")),
                    ],
                );
                d.ask(
                    State::Confirm {
                        title: k::RESTORE_TITLE,
                        text,
                        confirm: k::RESTORE_CONFIRM_BUTTON,
                    },
                    Box::new(move |dialog, cx| run_replace(dialog, staged, replace, cx)),
                    cx,
                );
            }
            Err(e) => d.fail(k::RESTORE_TITLE, restore_reason(&e), e.to_string(), cx),
        });
    })
    .detach();
    dialog
}

fn run_replace(
    dialog: Entity<TransferDialog>,
    staged: StagedBackup,
    replace: Replace,
    cx: &mut App,
) {
    let restoring = dr_shell::t(cx, k::RESTORING).to_string();
    dialog.update(cx, |d, cx| {
        d.set(
            State::Working {
                title: k::RESTORE_TITLE,
                name: restoring,
                progress: None,
            },
            cx,
        )
    });
    let (report, updates) = report_to(&dialog, cx);
    let task = replace(staged, report, cx);
    cx.spawn(async move |cx| {
        let result = task.await;
        updates.await;
        dialog.update(cx, |d, cx| match result {
            Ok(()) => d.done(cx),
            Err(e) => d.fail(k::RESTORE_TITLE, k::errors::UNKNOWN, e, cx),
        });
    })
    .detach();
}
