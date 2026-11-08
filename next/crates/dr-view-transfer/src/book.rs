//! `.driftingbook` from the bookshelf (docs/book-transfer.md's 「What the
//! author sees」): the card's export icon asks where to save
//! `<book name>.driftingbook` and writes it; 「导入书（.driftingbook）」 asks
//! for a file and imports it as a new book while 「正在导入」 shows how
//! far it is. A failure names the reason and leaves the library as it was.

use std::path::{Path, PathBuf};

use dr_export::book_file::{self, BookFileError};
use dr_i18n::{Key, keys};
use dr_workspace::commands::BookIn;
use dr_workspace::commands::book::BookGet;
use dr_workspace::{Actor, Workspace};
use futures::StreamExt as _;
use gpui::{App, Entity, PathPromptOptions};

use crate::dialog::{State, TransferDialog};

use keys::project_picker::book_transfer as reason;

/// Where the save panel starts: the author's home folder.
pub(crate) fn start_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// What the import dialog says for `e` (the 0.1 reasons, and 0.1's own
/// files).
pub fn import_reason(e: &BookFileError) -> Key {
    match e {
        BookFileError::NotABook => reason::NOT_ABOOK,
        BookFileError::Legacy => reason::LEGACY,
        BookFileError::Newer => reason::NEWER,
        BookFileError::TooLarge => reason::TOO_LARGE,
        BookFileError::Damaged(_) => reason::INVALID,
        _ => reason::IMPORT_FAILED,
    }
}

/// 「导入书（.driftingbook）」: the file panel, then [`import_path`].
pub fn import(cx: &mut App) {
    dr_shell::workspace::with_workspace(cx, |ws, _, cx| {
        let Some(lib) = ws.library.clone() else {
            return;
        };
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(dr_shell::t(cx, keys::user_menu::IMPORT_BOOK)),
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

/// Imports the book at `path` into `lib` as a new book, showing how far it
/// is; the dialog goes when the book is in (the bookshelf reads again as it
/// lands) or says why it is not.
pub fn import_path(lib: Workspace, path: PathBuf, cx: &mut App) -> Entity<TransferDialog> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let dialog = TransferDialog::show(
        State::Working {
            title: keys::project_picker::desk::IMPORTING,
            name,
            progress: Some(0.0),
        },
        cx,
    );
    let (tx, mut rx) = futures::channel::mpsc::unbounded::<book_file::Progress>();
    let job = cx.background_executor().spawn(async move {
        book_file::import_book(&lib, &path, &move |p| {
            let _ = tx.unbounded_send(p);
        })
    });
    let shown = dialog.clone();
    cx.spawn(async move |cx| {
        while let Some(p) = rx.next().await {
            shown.update(cx, |d, cx| d.progress(p.done, p.total, cx));
        }
    })
    .detach();
    let shown = dialog.clone();
    cx.spawn(async move |cx| {
        let result = job.await;
        shown.update(cx, |d, cx| match result {
            Ok(_) => d.done(cx),
            Err(e) => d.fail(
                reason::IMPORT_FAILED_TITLE,
                import_reason(&e),
                e.to_string(),
                cx,
            ),
        });
    })
    .detach();
    dialog
}

/// The card's export icon: the save panel, then [`export_path`].
pub fn export(book: String, cx: &mut App) {
    dr_shell::workspace::with_workspace(cx, move |ws, _, cx| {
        let Some(lib) = ws.library.clone() else {
            return;
        };
        let title = lib
            .run::<BookGet>(&Actor::User, BookIn { book: book.clone() })
            .map(|o| o.output.info.name)
            .unwrap_or_default();
        let path = cx.prompt_for_new_path(&start_dir(), Some(&book_file::book_filename(&title)));
        cx.spawn(async move |_, cx| {
            if let Ok(Ok(Some(path))) = path.await {
                cx.update(|cx| export_path(lib, book, path, cx));
            }
        })
        .detach();
    });
}

/// Writes book `book` of `lib` to `path` (whole or not at all); a failure
/// opens a dialog that says so.
pub fn export_path(lib: Workspace, book: String, path: PathBuf, cx: &mut App) {
    let job = cx
        .background_executor()
        .spawn(async move { book_file::export_book(&lib, &book, &path, &|_| {}) });
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
                        reason::EXPORT_FAILED,
                        e.to_string(),
                        cx,
                    )
                });
            });
        }
    })
    .detach();
}

/// Whether `path` names a `.driftingbook`.
pub fn is_book_file(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(book_file::EXTENSION))
}
