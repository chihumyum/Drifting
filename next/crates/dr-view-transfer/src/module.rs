//! `.driftingmodule` file transfer (`docs/rust-rewrite/custom-modules.md`
//! §10, CM3), as `.driftingtemplate`'s ([`crate::template`]):
//!
//! - **Export** (`dr_view_shelf::ExportModule`, a module's hover card on All
//!   Projects): straight to the system save panel with
//!   `<module name>.driftingmodule`, no dialog before it; credited to the
//!   signed-in account's display name, or to nobody.
//! - **Import** (`dr_view_shelf::ImportModule`, 「导入模块」 on All Projects,
//!   or `.driftingmodule` files dropped on All Projects): each file that
//!   passes the validator goes into my modules as a new module, with no
//!   question first; a file that fails is skipped, and one 「无法导入」 at the
//!   end says which and why, in the template import's words with 「模块」.

use std::path::{Path, PathBuf};

use dr_export::module_file::{self, ModuleFileError};
use dr_i18n::{Key, keys};
use dr_workspace::Workspace;
use gpui::{App, Entity, PathPromptOptions};

use crate::book::start_dir;
use crate::dialog::{State, TransferDialog};

use keys::module_bench::transfer as module;
use keys::project_picker::book_transfer as reason;

/// JSON-dispatchable module export action (`transfer::ExportModuleById`),
/// mirroring [`dr_view_shelf::ExportModule`] for scripted bridge sessions.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, schemars::JsonSchema, gpui::Action)]
#[action(namespace = transfer)]
pub struct ExportModuleById {
    pub id: String,
}

/// Failure sentence key for `e`: the template import's sentences with
/// 「模块」 for 「模板」.
pub fn import_reason(e: &ModuleFileError) -> Key {
    match e {
        ModuleFileError::NotAModule => module::NOT_MODULE,
        ModuleFileError::Newer => module::NEWER,
        ModuleFileError::TooLarge => module::TOO_LARGE,
        ModuleFileError::Damaged(_) => module::DAMAGED,
        _ => module::IMPORT_FAILED,
    }
}

/// 「导入模块 .driftingmodule」: opens the file panel, then [`import_path`].
pub fn import(cx: &mut App) {
    dr_shell::workspace::with_workspace(cx, |ws, _, cx| {
        let Some(lib) = ws.library.clone() else {
            return;
        };
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(dr_shell::t(cx, keys::module_bench::IMPORT_MODULE_FILE)),
        });
        cx.spawn(async move |_, cx| {
            let path = match paths.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                _ => None,
            };
            if let Some(path) = path {
                cx.update(|cx| {
                    import_path(lib, path, cx);
                });
            }
        })
        .detach();
    });
}

/// Imports the `.driftingmodule` at `path` into `lib`'s modules.
pub fn import_path(lib: Workspace, path: PathBuf, cx: &mut App) -> Entity<TransferDialog> {
    import_paths(lib, vec![path], cx).expect("single path is non-empty")
}

/// Imports one or more `.driftingmodule` files into `lib`'s modules, one
/// after another, each a new module; a file that cannot be imported is
/// skipped and the rest go on; at the end one 「无法导入」 says why.
pub fn import_paths(
    lib: Workspace,
    paths: Vec<PathBuf>,
    cx: &mut App,
) -> Option<Entity<TransferDialog>> {
    let first = paths.first()?;
    let dialog = TransferDialog::show(
        State::Working {
            title: keys::project_picker::desk::IMPORTING,
            name: file_name(first),
            progress: None,
        },
        cx,
    );
    let several = paths.len() > 1;
    let job = cx.background_executor().spawn(async move {
        paths
            .iter()
            .filter_map(|path| {
                module_file::import_module(&lib, path)
                    .err()
                    .map(|e| (file_name(path), e))
            })
            .collect::<Vec<_>>()
    });
    let shown = dialog.clone();
    cx.spawn(async move |cx| {
        let failed = job.await;
        shown.update(cx, |d, cx| match failed.as_slice() {
            [] => d.done(cx),
            [(_, e)] if !several => d.fail(
                reason::IMPORT_FAILED_TITLE,
                import_reason(e),
                e.to_string(),
                cx,
            ),
            _ => d.fail_files(
                reason::IMPORT_FAILED_TITLE,
                failed
                    .iter()
                    .map(|(name, e)| (name.clone(), import_reason(e), e.to_string()))
                    .collect(),
                cx,
            ),
        });
    })
    .detach();
    Some(dialog)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Exports module `id` of mine straight through the system save panel
/// (`<name>.driftingmodule`, no dialog before it), credited to the signed-in
/// account's display name, or to nobody.
pub fn export(id: String, cx: &mut App) {
    let author = dr_shell::account::author_name(cx).map(|s| s.to_string());
    dr_shell::workspace::with_workspace(cx, move |ws, _, cx| {
        let Some(lib) = ws.library.clone() else {
            return;
        };
        let name = dr_workspace::commands::v3::custom_module::my_module(
            &lib,
            &match id.parse() {
                Ok(id) => id,
                Err(_) => return,
            },
        )
        .ok()
        .flatten()
        .map(|(_, v)| v.name)
        .unwrap_or_default();
        let path = cx.prompt_for_new_path(&start_dir(), Some(&module_file::module_filename(&name)));
        cx.spawn(async move |_, cx| {
            if let Ok(Ok(Some(path))) = path.await {
                cx.update(|cx| export_path(lib, id, author, path, cx));
            }
        })
        .detach();
    });
}

/// Writes module `id` of `lib` to `path`, credited to `author`; silent on
/// success, a failure dialog otherwise.
pub fn export_path(
    lib: Workspace,
    id: String,
    author: Option<String>,
    path: PathBuf,
    cx: &mut App,
) {
    let job = cx
        .background_executor()
        .spawn(async move { module_file::export_module(&lib, &id, author.as_deref(), &path) });
    cx.spawn(async move |cx| {
        if let Err(e) = job.await {
            cx.update(|cx| {
                let d = TransferDialog::show(
                    State::Working {
                        title: reason::EXPORT_FAILED_TITLE,
                        name: String::new(),
                        progress: None,
                    },
                    cx,
                );
                d.update(cx, |d, cx| {
                    d.fail(
                        reason::EXPORT_FAILED_TITLE,
                        module::EXPORT_FAILED,
                        e.to_string(),
                        cx,
                    )
                });
            });
        }
    })
    .detach();
}

/// Whether `path` names a `.driftingmodule` file (case-insensitive).
pub fn is_module_file(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(module_file::EXTENSION))
}
