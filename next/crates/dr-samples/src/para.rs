//! Paragraphs of a body before they become a prose document: what the
//! sample lay-out and dr-testkit's synthetic corpus (`dr_testkit::text`,
//! which re-exports these) both produce.

use dr_model::kind::ListKind;
use dr_model::prose::{Heading, InlineStyle};

/// One paragraph of a body.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Para {
    pub text: String,
    pub heading: Option<Heading>,
    /// A task item (material notes): whether it is ticked.
    pub task: Option<bool>,
    /// A bullet or ordered list item (material notes).
    pub list: Option<ListKind>,
    pub quote: bool,
    pub links: Vec<Link>,
    /// Inline styles, in characters within the paragraph.
    pub styles: Vec<(std::ops::Range<usize>, InlineStyle)>,
}

/// An entity link inside a paragraph, in characters.
#[derive(Clone, Debug, PartialEq)]
pub struct Link {
    pub start: usize,
    pub len: usize,
    /// Index into the names the body was generated with.
    pub target: usize,
}

/// The plain text of a body: paragraphs joined by `\n`.
pub fn plain(paras: &[Para]) -> String {
    let mut s = String::new();
    for (i, p) in paras.iter().enumerate() {
        if i > 0 {
            s.push('\n');
        }
        s.push_str(&p.text);
    }
    s
}
