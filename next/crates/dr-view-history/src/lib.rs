//! dr-view-history: snapshot history (module M09).
//!
//! The page's ⋯ menu opens a dialog over the workspace, as the 0.1 client's
//! `EntitySnapshotHistoryModal`: the kind and name of the page, then its
//! history points newest first, each with its time, its words, the page's
//! title then and the first lines of its text. Clicking a point opens a
//! preview of the whole text then under it (new: 0.1 showed only the
//! excerpt). 「恢复…」 asks once more inline (「确认覆盖当前版本」); the
//! restore puts the text and the page's own fields back as they were, after
//! keeping the current state as a point of its own, and the list reloads.
//!
//! Everything goes through F3: `history.points`, `history.preview` and
//! `history.restore_point` (the points are F2's history labels: one every
//! 15 minutes of writing at most, kept 30 days). Undo reaches the restore
//! like any command of the author's.

mod dialog;
pub mod model;

pub use dialog::{HistoryDialog, HistoryEvent, LIST_MAX_HEIGHT, PREVIEW_MAX_HEIGHT, WIDTH};
