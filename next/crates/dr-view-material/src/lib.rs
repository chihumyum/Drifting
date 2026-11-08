//! dr-view-material: materials (M19), first part — the image and PDF
//! viewer and its region comments.
//!
//! - [`page::MediaPage`]: an image or PDF material's whole page, on the
//!   desk: its title and description, the picture zoomed and panned, a
//!   PDF's pages turned, and comments on rectangles of the picture, listed
//!   in a column beside it.
//! - [`media`]: the picture: images decoded, PDF pages rendered with hayro
//!   (pure Rust, nothing to install; why not pdfium-render:
//!   docs/rust-rewrite/modules/m19-materials.md).
//! - [`viewport`] and [`regions`]: the arithmetic of zoom, pan and fitting,
//!   and of the rectangles and their order, tested on their own.
//!
//! - [`library`]: the right sidebar's 素材库 tab — the folders (素材夹)
//!   and materials as a tree, selected several at a time, dragged into
//!   folders, renamed, moved and deleted from their hover cards; files
//!   dropped in from the system or pasted become materials ([`import`]).
//! - For M23 (审阅与素材) and any other view that lists materials:
//!   [`card`] (a material's thumbnail, its second line, a tile card),
//!   [`folders`] (the folder tree, selection, and the move / rename /
//!   delete commands), [`previews`] (thumbnails and a note's first words,
//!   shared), [`library::MaterialDrag`] (what a dragged material carries).
//!
//! [`init`] registers the page and the tab with the shell: an image or PDF
//! material opens in the viewer instead of a prose editor (a text material,
//! the author's note, still opens in the editor), and the 素材库 tab shows
//! [`library::LibraryPanel`].

pub mod card;
pub mod folders;
pub mod import;
pub mod library;
pub mod media;
pub mod menu;
pub mod page;
pub mod previews;
pub mod regions;
pub mod viewport;

use dr_shell::nav::Target;
use gpui::{App, AppContext, Focusable};

pub use page::{MediaKind, MediaPage};

/// Registers the image and PDF material page and the 素材库 tab with the
/// shell, and the library's shortcuts. Call once, after `dr_shell::init`.
pub fn init(cx: &mut App) {
    cx.bind_keys(library::bindings());
    menu::register(cx);
    dr_shell::pages::set_library(cx, library::make);
    dr_shell::pages::add_page_view(cx, |target, host, window, cx| {
        let Target::Material(id) = target else {
            return None;
        };
        let id = id.to_string();
        let kind = host
            .book
            .materials
            .iter()
            .find(|m| m.id == id)
            .and_then(|m| MediaKind::parse(&m.kind))?;
        let page = cx.new(|cx| MediaPage::new(id, kind, host, window, cx));
        let focus = page.read(cx).focus_handle(cx);
        Some(dr_shell::pages::ModulePage {
            view: page.into(),
            focus,
        })
    });
}
