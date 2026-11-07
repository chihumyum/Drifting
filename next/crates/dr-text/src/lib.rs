//! Text tools over dr-doc's prose (`docs/rust-rewrite/foundations/dr-text-index.md`).
//!
//! - [`plain`]: a paragraph's or a document's plain text, for search, export
//!   and the Agent;
//! - [`metrics`]: words and characters, by the Apache-2.0 rule of the
//!   `prose-metrics` crate (re-exported as [`count_words`]);
//! - [`live`]: live counts of the document an editor has open, paragraph
//!   by paragraph, without waiting for the index (M07);
//! - [`outline`]: the H1/H2/H3 paragraphs of a document, with block ids;
//! - [`shape`]: paragraphs, sentences and the share of dialogue (M20);
//! - [`autolink`]: where the names and aliases of a book's elements (and
//!   its chapter and idea titles) occur in text, for automatic entity links.
//!
//! Everything reads through [`dr_doc::prose::ProseView`] or works on plain
//! strings; nothing here writes a document.

pub mod autolink;
pub mod live;
pub mod metrics;
pub mod outline;
pub mod plain;
pub mod shape;

pub use autolink::{LinkMatch, LinkMatcher, LinkName, LinkTarget, SuggestedLink};
pub use live::{LiveCount, paragraph_metrics, with_live};
pub use metrics::{TextMetrics, text_metrics};
pub use outline::{OutlineItem, outline};
pub use plain::{block_text, paragraph_text, plain_text, table_text};
pub use prose_metrics::count_words;
pub use shape::{ProseShape, prose_shape};

#[cfg(test)]
mod tests;
