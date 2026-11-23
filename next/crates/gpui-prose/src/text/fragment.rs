//! A piece of rich text to paste — paragraphs with their own attributes and
//! inline marks, as [`crate::html`] reads them from another program's HTML —
//! and how it goes into a document ([`PastePlan`]).
//!
//! Pasting follows what ProseMirror, the editor of Drifting 0.1, does with
//! a slice open at both ends (checked against prosemirror-transform 1.12):
//!
//! - **The first paragraph** joins the text before the caret, which keeps
//!   its paragraph's look. At a paragraph's start a heading, a list item, a
//!   code line, a quote or a callout brings its own look (to the whole
//!   paragraph, when one paragraph is pasted); a plain paragraph takes the
//!   look it lands in, or, landing in a plain paragraph that it fills
//!   entirely, brings its alignment and indent.
//! - **The ones after it** are exactly what was pasted, and the last one's
//!   look goes with the text after the caret.
//! - **Inside a quote, a callout or a list** what is pasted stays inside:
//!   pasted list items keep their depth under the item they land in, and a
//!   plain paragraph becomes an item of that list.
//! - **A horizontal rule** never takes text: next to text it gets a
//!   paragraph of its own, and the caret never ends up on it.
//!
//! What the edit sets is [`PASTED_KEYS`]. The block id is never pasted (each
//! new paragraph gets a fresh one by the Enter rule), and neither is a task's
//! linked TODO, which stays with its own task.
//!
//! One plan is one [`ProseDoc::edit_batch`]: one commit, one undo item.

use std::ops::Range;

use loro::LoroValue;

use super::{BlockAttrs, Edit, MarkOverride, ProseDoc};
use crate::schema::{OBJECT, block};

/// Paragraphs to paste, in order. Empty means nothing to paste.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Fragment {
    pub paragraphs: Vec<FragmentParagraph>,
}

/// One pasted paragraph.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FragmentParagraph {
    /// The text: no `\n` and no U+FFFC (an embed's placeholder; both are
    /// dropped if present); U+2028 is a line break inside the paragraph.
    pub text: String,
    /// Inline marks: a range of characters of `text`, the key and its value.
    pub marks: Vec<(Range<usize>, String, LoroValue)>,
    /// The paragraph's attributes ([`PASTED_KEYS`] only; empty for a plain
    /// body paragraph). A rule's text is ignored.
    pub attrs: BlockAttrs,
}

/// The paragraph attributes a pasted paragraph states: all of them but the
/// block id and a task's linked TODO.
pub const PASTED_KEYS: &[&str] = &[
    block::HEADING,
    block::QUOTE,
    block::INDENT,
    block::ALIGN,
    block::RULE,
    block::LIST,
    block::LIST_LEVEL,
    block::CHECKED,
    block::CODE_BLOCK,
    block::CALLOUT,
];

impl Fragment {
    pub fn is_empty(&self) -> bool {
        self.paragraphs.is_empty()
    }

    /// The text, paragraphs joined by `\n` (a rule's text left out).
    pub fn text(&self) -> String {
        let mut out = String::new();
        for (ix, p) in self.paragraphs.iter().enumerate() {
            if ix > 0 {
                out.push('\n');
            }
            out.extend(p.chars());
        }
        out
    }

    /// Whether it carries nothing plain text would not: no mark and no
    /// paragraph attribute.
    pub fn is_plain(&self) -> bool {
        self.paragraphs
            .iter()
            .all(|p| p.marks.is_empty() && p.attrs.is_empty())
    }
}

impl FragmentParagraph {
    /// Whether this paragraph is a horizontal rule.
    pub fn is_rule(&self) -> bool {
        truthy(self.attrs.get(block::RULE))
    }

    /// The characters that are pasted.
    fn chars(&self) -> impl Iterator<Item = char> + '_ {
        let text = if self.is_rule() { "" } else { &self.text };
        text.chars().filter(|c| *c != OBJECT && *c != '\n')
    }
}

fn truthy(v: Option<&LoroValue>) -> bool {
    !matches!(
        v,
        None | Some(LoroValue::Null) | Some(LoroValue::Bool(false))
    )
}

fn is_task(attrs: &BlockAttrs) -> bool {
    matches!(attrs.get(block::LIST), Some(LoroValue::String(s)) if s.as_str() == "task")
}

fn as_i64(v: Option<&LoroValue>) -> i64 {
    match v {
        Some(LoroValue::I64(i)) => *i,
        Some(LoroValue::Double(d)) if d.is_finite() => *d as i64,
        _ => 0,
    }
}

/// The deepest list level.
const MAX_LIST_LEVEL: i64 = 8;

/// Whether a paragraph is more than body text: a heading, a list item, a
/// code line, in a quote or a callout (and, with `rule`, a rule). Such a
/// paragraph keeps what it is where a plain one takes the look it lands in.
fn defines(attrs: &BlockAttrs, rule: bool) -> bool {
    [
        block::HEADING,
        block::LIST,
        block::CODE_BLOCK,
        block::QUOTE,
        block::CALLOUT,
    ]
    .iter()
    .any(|key| attrs.get(key).is_some())
        || rule && truthy(attrs.get(block::RULE))
}

/// `want` pasted into the host paragraph's surroundings: inside a quote or
/// a callout it stays inside; inside a list its items keep their depth
/// under the host's item, and a plain paragraph becomes an item of the
/// host's list (the old editor kept it in the item).
fn within(mut want: BlockAttrs, host: &BlockAttrs) -> BlockAttrs {
    for key in [block::QUOTE, block::CALLOUT] {
        if want.get(key).is_none()
            && let Some(value) = host.get(key)
        {
            want.set(key, Some(value.clone()));
        }
    }
    if let Some(kind) = host.get(block::LIST) {
        let base = as_i64(host.get(block::LIST_LEVEL)).clamp(0, MAX_LIST_LEVEL);
        let level = if want.get(block::LIST).is_some() {
            Some(base + as_i64(want.get(block::LIST_LEVEL)).clamp(0, MAX_LIST_LEVEL))
        } else if [block::HEADING, block::CODE_BLOCK, block::RULE]
            .iter()
            .all(|key| want.get(key).is_none())
        {
            want.set(block::LIST, Some(kind.clone()));
            Some(base)
        } else {
            None
        };
        if let Some(level) = level {
            let level = level.min(MAX_LIST_LEVEL);
            want.set(
                block::LIST_LEVEL,
                (level > 0).then_some(LoroValue::I64(level)),
            );
        }
    }
    want
}

/// One paragraph the paste leaves.
#[derive(Clone, Copy)]
enum Item<'f> {
    Pasted(&'f FragmentParagraph),
    /// An empty paragraph around a rule: `keep` when it joins text of the
    /// document (and so keeps that paragraph's look), else a plain one.
    Filler {
        keep: bool,
    },
}

/// How to paste a [`Fragment`] over a range of one document: the text, the
/// marks and the paragraph attributes, as one batch of [`Edit`]s.
#[derive(Clone, Debug)]
pub struct PastePlan<'f> {
    range: Range<usize>,
    text: String,
    marks: Vec<(Range<usize>, &'f str, LoroValue)>,
    attrs: Vec<(usize, &'static str, Option<LoroValue>)>,
    caret: usize,
}

impl<'f> PastePlan<'f> {
    /// Plans pasting `fragment` over `range` of `doc`, in positions of `doc`
    /// as it is now. The range must lie in the text, before the final `\n`,
    /// and must not hold an embed. An empty fragment plans deleting it.
    pub fn new(doc: &ProseDoc, range: Range<usize>, fragment: &'f Fragment) -> PastePlan<'f> {
        let (start, end) = (range.start, range.end.max(range.start));
        // The text left before the range in its paragraph, and after it in
        // the paragraph that holds its end: what the pasted text joins.
        let first_line = doc.line_of(start);
        let before = start - doc.line_start(first_line);
        let last_line = doc.line_of(end);
        let tail = doc.line_start(last_line) + doc.line(last_line).chars - end;
        // The paragraph the pasted text lands in once the range is gone: the
        // one holding the start, unless whole paragraphs went (from a
        // paragraph's start to just after a `\n`), which leaves the one
        // after them as it was. Every paragraph the paste makes gets its
        // attributes from this one (the Enter rule), or from none.
        let host = if before == 0 && end > start && doc.line_start(last_line) == end {
            last_line
        } else {
            first_line
        };
        let host_attrs = doc.line(host).block.clone();

        let mut items: Vec<Item<'f>> = fragment.paragraphs.iter().map(Item::Pasted).collect();
        let rule = |item: Option<&Item<'_>>| matches!(item, Some(Item::Pasted(p)) if p.is_rule());
        // A rule never shares a paragraph with text, and the caret never
        // ends up on one.
        if rule(items.first()) && before > 0 {
            items.insert(0, Item::Filler { keep: true });
        }
        if rule(items.last()) {
            items.push(Item::Filler { keep: tail > 0 });
        }

        let n = items.len();
        let mut text = String::new();
        let mut marks = Vec::new();
        // Where each paragraph's text starts and ends after the edit.
        let mut spans = Vec::with_capacity(n);
        let mut at = start;
        for (ix, item) in items.iter().enumerate() {
            if ix > 0 {
                text.push('\n');
                at += 1;
            }
            let from = at;
            if let Item::Pasted(p) = item {
                for c in p.chars() {
                    text.push(c);
                    at += 1;
                }
                let len = at - from;
                for (r, key, value) in &p.marks {
                    let (a, b) = (r.start.min(len), r.end.min(len));
                    if a < b && !block::is_block_key(key) {
                        marks.push((from + a..from + b, key.as_str(), value.clone()));
                    }
                }
            }
            spans.push(from..at);
        }

        let host_defines = defines(&host_attrs, false);
        let mut attrs = Vec::new();
        for (ix, item) in items.iter().enumerate() {
            let want = match *item {
                Item::Filler { keep: true } => continue,
                Item::Filler { keep: false } => within(BlockAttrs::default(), &host_attrs),
                Item::Pasted(p) => {
                    // The first paragraph joins the text before the range,
                    // which keeps its paragraph's look. At a paragraph's
                    // start a plain paragraph takes the look it lands in
                    // (a heading, a list item …), or joins the text after
                    // the range; anything else brings its own.
                    if ix == 0
                        && (before > 0
                            || !defines(&p.attrs, true) && (host_defines || n == 1 && tail > 0))
                    {
                        continue;
                    }
                    within(p.attrs.clone(), &host_attrs)
                }
            };
            // The `\n` that ends this paragraph after the edit: a pasted one,
            // or for the last, the one after the text that followed the range.
            let newline = if ix + 1 < n {
                spans[ix].end
            } else {
                spans[ix].end + tail
            };
            // State the pasted attributes; clear the rest of what the Enter
            // rule may have carried over from the host paragraph.
            for key in PASTED_KEYS {
                match want.get(key) {
                    Some(value) => attrs.push((newline, *key, Some(value.clone()))),
                    None if host_attrs.get(key).is_some() => attrs.push((newline, *key, None)),
                    None => {}
                }
            }
            if host_attrs.get(block::TODO).is_some() && !is_task(&want) {
                attrs.push((newline, block::TODO, None));
            }
        }

        PastePlan {
            range: start..end,
            text,
            marks,
            attrs,
            caret: at,
        }
    }

    /// The pasted text, paragraphs joined by `\n`.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// Where the caret goes: after the pasted text.
    pub fn caret(&self) -> usize {
        self.caret
    }

    /// The edits, in order, for one [`ProseDoc::edit_batch`]: replace the
    /// range (with `overrides` on the new text, as typing would — usually
    /// the marks the text before the caret would carry on, cleared), then
    /// the marks, then the paragraph attributes.
    pub fn edits<'a>(&'a self, overrides: &'a [MarkOverride]) -> Vec<Edit<'a>> {
        let mut edits = Vec::with_capacity(1 + self.marks.len() + self.attrs.len());
        edits.push(Edit::Replace {
            range: self.range.clone(),
            text: &self.text,
            overrides,
        });
        for (range, key, value) in &self.marks {
            edits.push(Edit::Mark {
                range: range.clone(),
                key,
                value: value.clone(),
            });
        }
        for (newline, key, value) in &self.attrs {
            edits.push(Edit::SetBlockAttr {
                newline: *newline,
                key,
                value: value.clone(),
            });
        }
        edits
    }
}

#[cfg(test)]
mod tests;
