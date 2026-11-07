//! dr-editor (F4e): Drifting's editor, gpui-prose on Drifting's storage.
//!
//! - [`SessionSource`]: gpui-prose's text source on a workspace editing
//!   session. Writes and undo go through F3's `ProseSession` (dr-doc's
//!   transactions in the document holder's write job), reads and anchors run
//!   on the holder thread, every commit (the author's, an Agent's command, a
//!   sync) reaches the editor as an event.
//! - [`DriftingExtension`]: entity link looks (from the workspace's catalog)
//!   and Markdown input rules ([`rules`]).
//! - [`todo`]: typed TODO markers.
//! - [`ChapterEditor`]: the editor view the shell puts on the paper, with
//!   chapter switching, settings ([`EditorSettings`]) and the anchors an undo
//!   brings back written to the book.
//!
//! Docs: `docs/rust-rewrite/foundations/f4-editor.md` (F4e).

pub mod anchors;
pub mod convert;
pub mod decor;
pub mod links;
pub mod rules;
pub mod settings;
pub mod source;
pub mod todo;
pub mod view;

pub use links::{DriftingExtension, LinkTargets};
pub use settings::EditorSettings;
pub use source::SessionSource;
pub use todo::TodoMarker;
pub use view::{ChapterEditor, ChapterEditorEvent};
