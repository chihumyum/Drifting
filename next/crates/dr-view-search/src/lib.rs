//! dr-view-search: search the whole book (module M06).
//!
//! ⌘⇧F opens a floating sheet over the workspace: one field, results grouped
//! by what they are in (chapters in reading order, then ideas, elements,
//! storylines, categories, materials), each hit a snippet with the match
//! deeper and heavier. A hit in the prose jumps to its paragraph through a
//! location link (`drifting:chapters/id-<id>/prose.md#L<line>`), which the
//! shell resolves with its navigation model; a hit in a title, a summary, a
//! patch or a material's description opens the thing.
//!
//! Results come from F3's `book.search` (F2's ordered search over the
//! derived index for the prose, the book document's short texts read at
//! query time). Finding inside one chapter is F4c's find bar, not this.
//! docs/rust-rewrite/modules/m06-search.md has the decisions.

pub mod model;
mod panel;

pub use model::{Field, Group, Jump, Line, Owner, Row};
pub use panel::{
    DEBOUNCE, KEY_CONTEXT, LIMIT, Marks, SearchEvent, SearchPanel, SelectNext, SelectPrevious,
    WIDTH, key_bindings,
};
