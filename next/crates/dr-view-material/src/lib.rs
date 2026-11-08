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
//! [`init`] registers the page with the shell: an image or PDF material
//! opens here instead of in a prose editor. A text material (the author's
//! note) still opens in the editor.

pub mod media;
pub mod page;
pub mod regions;
pub mod viewport;

use dr_shell::nav::Target;
use gpui::{App, AppContext, Focusable};

pub use page::{MediaKind, MediaPage};

/// Registers the image and PDF material page with the shell. Call once,
/// after `dr_shell::init`.
pub fn init(cx: &mut App) {
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
