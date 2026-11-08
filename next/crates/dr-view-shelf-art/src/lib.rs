//! The bookshelf's pictures (M25): each book's cover in one of fourteen
//! styles the shelf's button turns through ([`cover`]), the library's year
//! of writing as sand ([`heatmap`]), and a card's last thirty days
//! ([`strip`]). The shelf (M01, dr-view-shelf) places them; the data come
//! from F3 through [`cover::cover_request`] and [`year::WritingYear::load`],
//! both to be run off the main thread.
//!
//! The pictures are painted with tiny-skia ([`art`], [`heat`]): no GPUI, so
//! any thread can draw them; what GPUI shows is the finished pixels.

pub mod art;
pub mod cover;
pub mod format;
pub mod heat;
pub mod heatmap;
mod images;
pub mod strip;
pub mod year;

pub use art::{CoverRequest, CoverStyle, cover_seed};
pub use cover::{CoverTurn, ShelfCover, cover_is_dark, cover_key, cover_request, style_name};
pub use heatmap::{HeatmapBook, WritingHeatmap};
pub use strip::SandStrip;
pub use year::WritingYear;
