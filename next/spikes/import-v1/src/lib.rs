//! P0-E spike: how the GPUI + Loro rewrite imports a Drifting 0.1.x library
//! without Yjs. See `docs/rust-rewrite/spikes/p0-e-import.md`.
//!
//! - [`tables`]: where each of the 100 old tables goes;
//! - [`legacy`]: reading rows, caches and the evidence of how fresh they are;
//! - [`prose`]: ProseMirror JSON to and from flat lines (decision D3);
//! - [`loro_body`]: lines as one `LoroText`, cursors, history replay;
//! - [`anchors`]: comment and patch anchors to cursor pairs;
//! - [`book`]: authored rows as a book document;
//! - [`probe`]: all of it over one library, as a JSON report.

pub mod anchors;
pub mod book;
pub mod legacy;
pub mod loro_body;
pub mod probe;
pub mod prose;
pub mod tables;
