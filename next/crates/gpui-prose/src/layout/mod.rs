//! F4b — layout and virtualization: Chinese line breaking, paragraph
//! geometry and how rows are set (first-line indent, punctuation squeezing,
//! alignment, justification), height estimates for off-screen paragraphs,
//! typewriter scrolling, and the book (several body texts in one scroll).
//!
//! The editor virtualizes with GPUI's `list()`: one item per chapter title and
//! one per visible paragraph. `list()` has no per-item height hints and wipes
//! its heights on the first frame and on width changes, so the scrollbar and
//! pixel jumps use the editor's own [`heights::HeightIndex`] instead.

pub mod book;
pub mod heights;
pub mod linebreak;
pub mod paragraph;
pub mod setting;

pub use book::{Book, BookPos, BookRange, Chapter, Item};
pub use heights::{BlockMetrics, HeightIndex, estimate_height};
pub use paragraph::{Affinity, ProseLayout, RowAlign, RowSetting, column, shape, shape_set};
pub use setting::{ParaSet, estimate_indented, typewriter_bounds, typewriter_tail};

#[cfg(test)]
mod tests;
