//! dr-view-shelf: the bookshelf (module M01).
//!
//! The page the app opens on, and where ⇧⌘W or the red light come back to
//! (components.md, 「书架」): a flat desk; on the left the rail with the
//! shelf's name, how much the library holds, import, Recently Deleted and
//! the account cell beside the notification bell; on the right the books,
//! and a slip at the end to start a new one. A double click on the empty
//! desk starts one too. Each book's card opens it; its two actions (edit,
//! move to Recently Deleted) show under the pointer. There is no context
//! menu.
//!
//! Recently Deleted lists each book with the days it has left, to restore
//! or delete for good; two minutes after the bookshelf comes up, the books
//! whose 30 days are over go (as in the 0.1 client).
//!
//! The data comes from F3 (`dr-workspace`, one `book.shelf` read): [`data`]
//! reads it off the main thread, again whenever F3 reports a change.
//! Each card carries its cover and its last 30 days in sand, and the year
//! of writing days lies over the books; the pictures are M25's
//! (`dr-view-shelf-art`), fed by [`art`]. The round button at the foot
//! turns every cover to the next style. The sea of characters under the
//! desk is M24.
//!
//! The app registers the bookshelf with [`init`]; the shell
//! (`dr_shell::pages`) shows it.
//!
//! docs/rust-rewrite/modules/m01-shelf.md has the design and the numbers.

pub mod art;
pub mod data;
pub mod format;
mod view;

pub use view::{
    ExportBook, ImportBook, ImportLegacyLibrary, PURGE_EXPIRED_AFTER, Shelf, ShelfDialog,
    SubmitDialog,
};

use gpui::{App, AppContext as _, KeyBinding};

/// Registers the bookshelf as the shell's start page, and its key: ⌘↵
/// (Ctrl+↵) in a dialog creates or saves, kept by the shell's keymap.
pub fn init(cx: &mut App) {
    dr_shell::keymap::add_bindings(cx, || {
        let keys = if cfg!(target_os = "macos") {
            "cmd-enter"
        } else {
            "ctrl-enter"
        };
        vec![KeyBinding::new(keys, SubmitDialog, Some("Shelf"))]
    });
    dr_shell::pages::set_shelf(cx, |ws, window, cx| {
        let shelf = cx.new(|cx| Shelf::new(ws, window, cx));
        let bell = shelf.read(cx).bell();
        dr_shell::pages::ShelfPage {
            view: shelf.into(),
            bell: Some(bell),
        }
    });
}
