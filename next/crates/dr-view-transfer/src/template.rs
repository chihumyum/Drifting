//! `.driftingtemplate` file transfer (`docs/rust-rewrite/project-templates.md`
//! §6, §11; `docs/rust-rewrite/modules/m41-export.md`):
//!
//! - **Export** (`dr_view_shelf::ExportTemplate`): goes straight to the system
//!   save panel with `<template name>.driftingtemplate` and no intermediate
//!   dialog; sets `credit.author` to the signed-in account's explicit profile
//!   name, or omits `credit` when signed out or when no profile name is set
//!   (never falling back to an email `@` prefix).
//! - **Import** (`dr_view_shelf::ImportTemplate`, or dragging a
//!   `.driftingtemplate` file onto the window): validates and stores the file
//!   in `project-template:<id>` (`origin = "file"`), never creating a project;
//!   failures show the shared transfer failure dialog (`allProjects.transfer.*`).

use std::path::{Path, PathBuf};

use dr_export::template_file::{self, TemplateFileError};
use dr_i18n::{Key, keys};
use dr_workspace::Workspace;
use gpui::{App, Entity, PathPromptOptions};

use crate::book::start_dir;
use crate::dialog::{State, TransferDialog};

pub use dr_view_shelf::{ExportTemplate, ImportTemplate};

use keys::all_projects::transfer as project;
use keys::project_picker::book_transfer as reason;

/// JSON-dispatchable template export action (`transfer::ExportTemplateById`),
/// mirroring [`dr_view_shelf::ExportTemplate`] for scripted bridge sessions.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, schemars::JsonSchema, gpui::Action)]
#[action(namespace = transfer)]
pub struct ExportTemplateById {
    pub id: String,
}

/// Failure sentence key for `e`, sharing `allProjects.transfer.*` and
/// `projectPicker.bookTransfer.*` with `.driftingproject` import.
pub fn import_reason(e: &TemplateFileError) -> Key {
    match e {
        TemplateFileError::NotATemplate => project::NOT_PROJECT,
        TemplateFileError::Newer => project::NEWER,
        TemplateFileError::TooLarge => project::TOO_LARGE,
        TemplateFileError::Damaged(_) => reason::INVALID,
        _ => project::IMPORT_FAILED,
    }
}

/// All Projects' 「导入模板 .driftingtemplate」: opens the file panel, then
/// [`import_path`].
pub fn import(cx: &mut App) {
    dr_shell::workspace::with_workspace(cx, |ws, _, cx| {
        let Some(lib) = ws.library.clone() else {
            return;
        };
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(dr_shell::t(cx, keys::all_projects::IMPORT_FILE)),
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

/// Imports the `.driftingtemplate` at `path` into `lib`'s saved templates
/// (`project_template.list`, `origin = "file"`), never creating a project.
pub fn import_path(lib: Workspace, path: PathBuf, cx: &mut App) -> Entity<TransferDialog> {
    import_paths(lib, vec![path], cx).expect("single path is non-empty")
}

/// Imports one or more `.driftingtemplate` files sequentially into `lib`'s
/// saved templates (`origin = "file"`), stopping at the first failure.
pub fn import_paths(
    lib: Workspace,
    paths: Vec<PathBuf>,
    cx: &mut App,
) -> Option<Entity<TransferDialog>> {
    let first = paths.first()?;
    let name = first
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let dialog = TransferDialog::show(
        State::Working {
            title: keys::project_picker::desk::IMPORTING,
            name,
            progress: None,
        },
        cx,
    );
    let job = cx.background_executor().spawn(async move {
        for path in &paths {
            template_file::import_template(&lib, path)?;
        }
        Ok::<(), TemplateFileError>(())
    });
    let shown = dialog.clone();
    cx.spawn(async move |cx| {
        let result = job.await;
        shown.update(cx, |d, cx| match result {
            Ok(()) => d.done(cx),
            Err(e) => d.fail(
                reason::IMPORT_FAILED_TITLE,
                import_reason(&e),
                e.to_string(),
                cx,
            ),
        });
    })
    .detach();
    Some(dialog)
}

/// Exports saved template `template` directly through the native save panel
/// (`<name>.driftingtemplate`, no intermediate dialog), crediting the signed-in
/// account's explicit display name or omitting `credit` when unset/signed out.
pub fn export(template: String, cx: &mut App) {
    let author = dr_shell::account::author_name(cx).map(|s| s.to_string());
    dr_shell::workspace::with_workspace(cx, move |ws, _, cx| {
        let Some(lib) = ws.library.clone() else {
            return;
        };
        let name = template_file::template_name(&lib, &template).unwrap_or_default();
        let path =
            cx.prompt_for_new_path(&start_dir(), Some(&template_file::template_filename(&name)));
        cx.spawn(async move |_, cx| {
            if let Ok(Ok(Some(path))) = path.await {
                cx.update(|cx| export_path(lib, template, author, path, cx));
            }
        })
        .detach();
    });
}

/// Writes saved template `template` of `lib` to `path` with attribution
/// `author`; silent on success, or opens a failure dialog on error.
pub fn export_path(
    lib: Workspace,
    template: String,
    author: Option<String>,
    path: PathBuf,
    cx: &mut App,
) {
    let job = cx.background_executor().spawn(async move {
        template_file::export_template(&lib, &template, author.as_deref(), &path)
    });
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
                        project::EXPORT_FAILED,
                        e.to_string(),
                        cx,
                    )
                });
            });
        }
    })
    .detach();
}

/// Whether `path` names a `.driftingtemplate` file (case-insensitive).
pub fn is_template_file(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(template_file::EXTENSION))
}
