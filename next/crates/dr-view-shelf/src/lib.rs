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
//! The data comes from F3 (`dr-workspace`): [`data`] reads it off the main
//! thread, again whenever F3 reports a change. Covers, the heat map, the
//! 30-day strip and the sea of characters under the desk are M24 and M25.
//!
//! The app registers the bookshelf with [`init`]; the shell
//! (`dr_shell::pages`) shows it.
//!
//! docs/rust-rewrite/modules/m01-shelf.md has the design and the numbers.

pub mod data;
pub mod format;
mod view;

pub use view::{ImportBook, ImportLegacyLibrary, Shelf, ShelfDialog};

use gpui::{App, AppContext as _};

/// Registers the bookshelf as the shell's start page.
pub fn init(cx: &mut App) {
    dr_shell::pages::set_shelf(cx, |ws, window, cx| {
        let shelf = cx.new(|cx| Shelf::new(ws, window, cx));
        let bell = shelf.read(cx).bell();
        dr_shell::pages::ShelfPage {
            view: shelf.into(),
            bell: Some(bell),
        }
    });
}
