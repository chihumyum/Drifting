//! dr-mirror: the Markdown folder (M40).
//!
//! Every book's chapters and ideas are written as Markdown files under a
//! folder the author chose, and an edit saved in any other editor is merged
//! back into the prose — alongside whatever was typed in Drifting meanwhile.
//! Live Loro state stays the truth: a file is a copy that only speaks
//! Markdown, merged as another device's change would be.
//!
//! - [`file`]: the file (frontmatter with `drifting-id`, `写作状态`,
//!   `摘要`, `aliases`, other entries kept; then the body).
//! - [`body`]: paragraphs as lines and back, exactly.
//! - [`plan`] and [`merge`]: the three-way merge on a fork at the file's
//!   base version.
//! - [`layout`]: `正文/<幕>/<NNN 章>.md`, `构想/<分组>/<标题>.md`.
//! - [`disk`]: owner-only whole-file writes, `.drifting/owner.json`,
//!   `.drifting/preserved`.
//! - [`ledger`]: what this device last wrote or read (dr-store's
//!   `local_state`, scope `mirror`).
//! - [`sync::Pass`]: one pass over a book's folder; [`Mirror`]: the
//!   worker that runs passes on file events and after the author pauses.
//!
//! Body templates (`template:` documents) are never written: only chapters
//! and ideas are.

pub mod body;
pub mod disk;
pub mod file;
pub mod layout;
pub mod ledger;
pub mod merge;
pub mod plan;
mod service;
pub mod sync;

pub use service::{Mirror, Options};
pub use sync::{Issue, Problem, Report};
