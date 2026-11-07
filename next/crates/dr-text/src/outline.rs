//! The outline of a document: its H1, H2 and H3 paragraphs.
//!
//! The book's outline is act / chapter / H1 / H2 / H3; this is the part
//! inside one body. The three levels are treated alike. As in the 0.1 client
//! (`src/renderer/lib/outline.ts`): a heading's text is trimmed, a heading
//! with no text is left out, and `paragraphs_after` counts the paragraphs up
//! to the next heading that is listed (body paragraphs and embeds; headings
//! and horizontal rules do not count).

use dr_doc::prose::{Paragraph, ProseView};
use dr_model::id::BlockId;
use dr_model::prose::Heading;
use prose_metrics::is_js_whitespace;

use crate::plain::paragraph_text;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutlineItem {
    /// Index of the paragraph in the document.
    pub ord: usize,
    /// The block id readers use (`None` for a duplicate until the repair).
    pub block_id: Option<BlockId>,
    pub heading: Heading,
    /// Trimmed, never empty.
    pub text: String,
    pub paragraphs_after: usize,
}

/// A heading's outline text: trimmed of JavaScript whitespace (the old
/// `trim()`), `None` when nothing is left.
pub fn heading_text(text: &str) -> Option<&str> {
    let t = text.trim_matches(is_js_whitespace);
    (!t.is_empty()).then_some(t)
}

/// Builds an outline paragraph by paragraph (for callers that read the
/// paragraphs anyway, such as the deriver).
#[derive(Default)]
pub struct OutlineBuilder {
    items: Vec<OutlineItem>,
    ord: usize,
}

impl OutlineBuilder {
    /// Add the next paragraph, given its heading, block id and plain text.
    pub fn push(
        &mut self,
        heading: Option<Heading>,
        block_id: Option<&BlockId>,
        text: &str,
        rule: bool,
    ) {
        match heading {
            Some(h) => {
                if let Some(t) = heading_text(text) {
                    self.items.push(OutlineItem {
                        ord: self.ord,
                        block_id: block_id.cloned(),
                        heading: h,
                        text: t.to_string(),
                        paragraphs_after: 0,
                    });
                }
            }
            None if !rule => {
                if let Some(last) = self.items.last_mut() {
                    last.paragraphs_after += 1;
                }
            }
            None => {}
        }
        self.ord += 1;
    }

    pub fn push_paragraph(&mut self, p: &Paragraph) {
        self.push(
            p.attrs.heading,
            p.id.as_ref(),
            &paragraph_text(p),
            p.attrs.rule,
        );
    }

    pub fn finish(self) -> Vec<OutlineItem> {
        self.items
    }
}

/// The outline of `view`.
pub fn outline(view: &ProseView<'_>) -> Vec<OutlineItem> {
    let mut b = OutlineBuilder::default();
    for p in view.paragraphs() {
        b.push_paragraph(&p);
    }
    b.finish()
}
