//! Search display DTOs shared by canonical v3 results.
use std::ops::Range;
/// Where in its owner a hit is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Field {
    Title,
    Summary,
    Body,
    Description,
    Patch,
}
/// One hit, ready to draw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub field: Field,
    pub snippet: String,
    /// The match in `snippet`, in bytes.
    pub highlight: Range<usize>,
    /// The prose paragraph (body hits).
    pub paragraph: Option<u32>,
}
/// One line of the result list: a group's header or one of its rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Line {
    Header(usize),
    Hit(usize, usize),
}
pub fn char_range(s: &str, start: usize, len: usize) -> Range<usize> {
    let mut idx = s
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(s.len()));
    let from = idx.by_ref().nth(start).unwrap_or(s.len());
    let to = if len == 0 {
        from
    } else {
        idx.nth(len - 1).unwrap_or(s.len())
    };
    from..to
}
