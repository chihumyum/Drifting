//! Paragraph DTO and preserving replacement for module prose
//! (`module.set_prose`).
//!
//! A write gives every paragraph in order. Paragraphs that stay the same are
//! left as they are; one whose words or shape change is edited where it
//! stands, so it keeps its block id (a checklist item's comment id comes from
//! it, `kernel-v5.md` §7), its inline marks on untouched words and the block
//! attributes the shape does not say (quote, indent, alignment, callout).
//! Only paragraphs that are new get new ids.
use std::ops::{Add, Range};

use crate::{Result, WsError};
use dr_doc::prose::{ProseTxn, ProseView};
use dr_model::id::BlockId;
use dr_model::kind::ListKind;
use dr_model::prose::{BlockAttrs, Heading};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A list item's kind, written as in the project template format (§10).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ListItemKind {
    Bullet,
    Ordered,
    /// A checklist item: it is also a comment (origin `task`) whose words are
    /// the line's, and its tick is that comment's status.
    Task,
}

impl ListItemKind {
    fn kind(self) -> ListKind {
        match self {
            Self::Bullet => ListKind::Bullet,
            Self::Ordered => ListKind::Ordered,
            Self::Task => ListKind::Task,
        }
    }
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// One paragraph of a body template.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TemplateParagraph {
    /// 1, 2 or 3 for H1/H2/H3; omitted (or 0, as a read gives it) for body text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading: Option<u8>,
    #[serde(default)]
    pub text: String,
    /// A list item: `bullet`, `ordered` or `task` (a checklist item). Omitted
    /// for a paragraph that is not one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list: Option<ListItemKind>,
    /// How deep a list item is nested, 0 the outermost (only with `list`).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub list_level: u32,
    /// A checklist item's tick (only with `list: "task"`): ticked is its
    /// comment resolved, cleared is it open.
    #[serde(default, skip_serializing_if = "is_false")]
    pub checked: bool,
}

/// Refuse a paragraph whose shape means nothing, before anything is written.
pub(crate) fn validate(paragraphs: &[TemplateParagraph]) -> Result<()> {
    for p in paragraphs {
        if p.heading.is_some_and(|h| h > 3) || p.text.contains('\n') || p.text.contains('\u{fffc}')
        {
            return Err(WsError::invalid("invalid paragraph or heading"));
        }
        if p.list.is_none() && p.list_level > 0 {
            return Err(WsError::invalid("list_level is for a list item"));
        }
        if p.checked && p.list != Some(ListItemKind::Task) {
            return Err(WsError::invalid(
                "only a task item (list: \"task\") is checked",
            ));
        }
    }
    Ok(())
}

pub(crate) fn blank(view: &ProseView<'_>) -> bool {
    view.len() <= 1
}

/// What a paragraph says in the shape a read gives and a write takes; the
/// rest of its block attributes is not compared and not written.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Shape {
    heading: Option<u8>,
    list: Option<ListKind>,
    list_level: u32,
    checked: bool,
    text: Vec<char>,
}

fn heading(level: Option<u8>) -> Option<Heading> {
    match level {
        Some(1) => Some(Heading::H1),
        Some(2) => Some(Heading::H2),
        Some(3) => Some(Heading::H3),
        _ => None,
    }
}

impl Shape {
    fn read(attrs: &BlockAttrs, text: &str) -> Self {
        let list = attrs.list.clone();
        Self {
            heading: attrs.heading.map(|h| h.level() as u8),
            list_level: if list.is_some() { attrs.list_level } else { 0 },
            checked: list == Some(ListKind::Task) && attrs.checked,
            list,
            text: text.chars().collect(),
        }
    }

    fn wanted(p: &TemplateParagraph) -> Self {
        Self {
            heading: p.heading.filter(|h| *h != 0),
            list: p.list.map(ListItemKind::kind),
            list_level: p.list_level,
            checked: p.checked,
            text: p.text.chars().collect(),
        }
    }

    /// `old` with what this shape says written over it; what it does not
    /// say stays, unless a heading or a list item cannot carry it.
    fn onto(&self, old: &BlockAttrs) -> BlockAttrs {
        let was = Shape::read(old, "");
        let mut a = old.clone();
        if was.heading != self.heading {
            a.heading = heading(self.heading);
            if a.heading.is_some() {
                a.code_block = None;
                a.callout = None;
                a.rule = false;
            }
        }
        if was.list != self.list {
            a.list = self.list.clone();
            a.list_level = self.list_level;
            a.checked = self.checked;
            a.todo = None;
            if a.list.is_some() {
                a.code_block = None;
                a.rule = false;
            }
        } else {
            if was.list_level != self.list_level {
                a.list_level = self.list_level;
            }
            if was.checked != self.checked {
                a.checked = self.checked;
                a.todo = None;
            }
        }
        if !self.text.is_empty() {
            a.rule = false;
        }
        a
    }

    fn fresh(&self) -> BlockAttrs {
        self.onto(&BlockAttrs::default())
    }
}

/// One paragraph as it stands before the write.
struct Old {
    shape: Shape,
    /// Its text, as positions.
    range: Range<usize>,
    attrs: BlockAttrs,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    /// `old` becomes `new` in place (`same`: nothing to write).
    Pair {
        old: usize,
        new: usize,
        same: bool,
    },
    Delete(usize),
    Insert(usize),
}

/// Which pairing is better: more paragraphs unchanged, then more kept in
/// place, then closer words.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
struct Score(u32, u32, u64);

impl Add for Score {
    type Output = Score;
    fn add(self, o: Score) -> Score {
        Score(self.0 + o.0, self.1 + o.1, self.2 + o.2)
    }
}

/// Above this many pairs the middle is paired in order instead.
const ALIGN_CELLS: usize = 250_000;
/// How far shared words are counted at each end.
const SIMILAR_CHARS: usize = 64;

fn pair_score(a: &Shape, b: &Shape) -> Score {
    if a == b {
        return Score(1, 1, 0);
    }
    let prefix = a
        .text
        .iter()
        .zip(&b.text)
        .take(SIMILAR_CHARS)
        .take_while(|(x, y)| x == y)
        .count();
    let room = a.text.len().min(b.text.len()) - prefix;
    let suffix = a
        .text
        .iter()
        .rev()
        .zip(b.text.iter().rev())
        .take(SIMILAR_CHARS.min(room))
        .take_while(|(x, y)| x == y)
        .count();
    let kind = u64::from(a.heading == b.heading && a.list == b.list);
    Score(0, 1, (prefix + suffix) as u64 * 2 + kind)
}

/// Line the old paragraphs up with the new ones.
fn align(old: &[Shape], new: &[Shape]) -> Vec<Step> {
    let (n, m) = (old.len(), new.len());
    let mut k = 0;
    while k < n.min(m) && old[k] == new[k] {
        k += 1;
    }
    let mut s = 0;
    while s < n.min(m) - k && old[n - 1 - s] == new[m - 1 - s] {
        s += 1;
    }
    let mut steps: Vec<Step> = (0..k)
        .map(|i| Step::Pair {
            old: i,
            new: i,
            same: true,
        })
        .collect();
    let (o, w) = (&old[k..n - s], &new[k..m - s]);
    let (p, q) = (o.len(), w.len());
    if p == 0 || q == 0 || p * q > ALIGN_CELLS {
        // In order: as many kept in place as both sides have.
        for t in 0..p.max(q) {
            steps.push(match (t < p, t < q) {
                (true, true) => Step::Pair {
                    old: k + t,
                    new: k + t,
                    same: o[t] == w[t],
                },
                (true, false) => Step::Delete(k + t),
                _ => Step::Insert(k + t),
            });
        }
    } else {
        let at = |i: usize, j: usize| i * (q + 1) + j;
        let mut dp = vec![Score::default(); (p + 1) * (q + 1)];
        for i in 1..=p {
            for j in 1..=q {
                let pair = dp[at(i - 1, j - 1)] + pair_score(&o[i - 1], &w[j - 1]);
                dp[at(i, j)] = pair.max(dp[at(i - 1, j)]).max(dp[at(i, j - 1)]);
            }
        }
        let mut back = Vec::new();
        let (mut i, mut j) = (p, q);
        while i > 0 || j > 0 {
            if i > 0
                && j > 0
                && dp[at(i, j)] == dp[at(i - 1, j - 1)] + pair_score(&o[i - 1], &w[j - 1])
            {
                back.push(Step::Pair {
                    old: k + i - 1,
                    new: k + j - 1,
                    same: o[i - 1] == w[j - 1],
                });
                i -= 1;
                j -= 1;
            } else if i > 0 && (j == 0 || dp[at(i, j)] == dp[at(i - 1, j)]) {
                back.push(Step::Delete(k + i - 1));
                i -= 1;
            } else {
                back.push(Step::Insert(k + j - 1));
                j -= 1;
            }
        }
        steps.extend(back.into_iter().rev());
    }
    steps.extend((0..s).map(|t| Step::Pair {
        old: n - s + t,
        new: m - s + t,
        same: true,
    }));
    steps
}

/// The paragraph whose text starts at `start`, as stored: its id and its
/// block attributes.
fn stored_at(txn: &ProseTxn<'_>, start: usize) -> (Option<BlockId>, BlockAttrs) {
    txn.view()
        .paragraphs()
        .find(|p| p.range.start == start)
        .map(|p| (p.stored_id, p.attrs))
        .unwrap_or_default()
}

/// Put the stored id and attributes back on the paragraph at `start`.
fn restore_at(
    txn: &mut ProseTxn<'_>,
    start: usize,
    id: Option<&BlockId>,
    attrs: &BlockAttrs,
) -> Result<()> {
    let (have_id, have) = stored_at(txn, start);
    if have_id.as_ref() != id {
        txn.set_block_id(start, id)?;
    }
    if &have != attrs {
        txn.set_block_attrs(start, attrs)?;
    }
    Ok(())
}

/// A new paragraph at `at`, in front of the one that starts there.
fn insert_fresh(txn: &mut ProseTxn<'_>, at: usize, want: &Shape) -> Result<()> {
    txn.split(at)?;
    let text: String = want.text.iter().collect();
    txn.insert_text(at, &text)?;
    txn.set_block_attrs(at, &want.fresh())?;
    Ok(())
}

/// The paragraph at `old` becomes `want` where it stands: only the words that
/// differ are rewritten, then what its shape says.
fn edit_in_place(txn: &mut ProseTxn<'_>, old: &Old, want: &Shape) -> Result<()> {
    let (a, b) = (&old.shape.text, &want.text);
    let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let room = a.len().min(b.len()) - prefix;
    let suffix = a
        .iter()
        .rev()
        .zip(b.iter().rev())
        .take(room)
        .take_while(|(x, y)| x == y)
        .count();
    let start = old.range.start;
    txn.delete(start + prefix..start + a.len() - suffix)?;
    let middle: String = b[prefix..b.len() - suffix].iter().collect();
    txn.insert_text(start + prefix, &middle)?;
    let attrs = want.onto(&old.attrs);
    if attrs != old.attrs {
        txn.set_block_attrs(start, &attrs)?;
    }
    Ok(())
}

pub(crate) fn replace_paragraphs(txn: &mut ProseTxn<'_>, new: &[TemplateParagraph]) -> Result<()> {
    let view = txn.view();
    let was_blank = blank(&view);
    let old: Vec<Old> = if was_blank {
        Vec::new()
    } else {
        view.paragraphs()
            .map(|p| Old {
                shape: Shape::read(&p.attrs, &p.text()),
                range: p.range.clone(),
                attrs: p.attrs.clone(),
            })
            .collect()
    };
    let want: Vec<Shape> = new.iter().map(Shape::wanted).collect();
    let shapes: Vec<Shape> = old.iter().map(|o| o.shape.clone()).collect();
    let steps = align(&shapes, &want);
    if old.len() == want.len()
        && steps
            .iter()
            .all(|s| matches!(s, Step::Pair { same: true, .. }))
    {
        return Ok(());
    }

    // What happens to each old paragraph, and the new ones in front of it.
    let n = old.len();
    let mut before: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut fate: Vec<Option<usize>> = vec![None; n];
    let mut pending = Vec::new();
    for step in &steps {
        match *step {
            Step::Pair { old: i, new: j, .. } => {
                before[i] = std::mem::take(&mut pending);
                fate[i] = Some(j);
            }
            Step::Delete(i) => {
                before[i] = std::mem::take(&mut pending);
            }
            Step::Insert(j) => pending.push(j),
        }
    }
    let after = pending;

    // A trailing empty paragraph to write in front of, so no old paragraph
    // is ever the last one while the others move (the last newline is never
    // deleted). A blank module's one empty paragraph is that already.
    let sentinel = if was_blank {
        true
    } else if fate[n - 1].is_none() || !after.is_empty() {
        let last = &old[n - 1];
        if last.range.is_empty() {
            // Enter in an empty paragraph opens the new one above it: give
            // the upper one the last paragraph's id and attributes.
            let (id, attrs) = stored_at(txn, last.range.start);
            txn.split(last.range.start)?;
            let (fresh_id, fresh) = stored_at(txn, last.range.start);
            restore_at(txn, last.range.start + 1, fresh_id.as_ref(), &fresh)?;
            restore_at(txn, last.range.start, id.as_ref(), &attrs)?;
        } else {
            txn.split(last.range.end)?;
        }
        true
    } else {
        false
    };

    // From the end, so every old position still holds where it is used.
    let end = txn.view().len() - 1;
    for j in after.iter().rev() {
        insert_fresh(txn, end, &want[*j])?;
    }
    for i in (0..n).rev() {
        let o = &old[i];
        match fate[i] {
            Some(j) if o.shape == want[j] => {}
            Some(j) => edit_in_place(txn, o, &want[j])?,
            None => txn.delete(o.range.start..o.range.end + 1)?,
        }
        for j in before[i].iter().rev() {
            insert_fresh(txn, o.range.start, &want[*j])?;
        }
    }

    if sentinel {
        let last = txn.view().len() - 1;
        if want.is_empty() {
            // Nothing left: one plain empty paragraph.
            txn.set_block_attrs(last, &BlockAttrs::default())?;
        } else {
            // The paragraph before it takes the last newline, as it stood.
            let prev = txn
                .view()
                .paragraphs()
                .take_while(|p| p.range.start < last)
                .last()
                .map(|p| (p.range.start, p.newline, p.stored_id, p.attrs))
                .ok_or_else(|| WsError::Internal("no paragraph before the end".into()))?;
            let (start, newline, id, attrs) = prev;
            txn.delete(newline..newline + 1)?;
            restore_at(txn, start, id.as_ref(), &attrs)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(text: &str) -> Shape {
        Shape {
            heading: None,
            list: None,
            list_level: 0,
            checked: false,
            text: text.chars().collect(),
        }
    }

    #[test]
    fn the_closest_paragraph_keeps_its_place() {
        let old = [shape("甲"), shape("买宣纸"), shape("乙")];
        let new = [
            shape("甲"),
            shape("磨墨"),
            shape("买上好的宣纸"),
            shape("乙"),
        ];
        let steps = align(&old, &new);
        assert!(steps.contains(&Step::Insert(1)), "{steps:?}");
        assert!(
            steps.contains(&Step::Pair {
                old: 1,
                new: 2,
                same: false
            }),
            "{steps:?}"
        );
    }

    #[test]
    fn unchanged_paragraphs_inside_the_changed_part_stay() {
        let old = [shape("一"), shape("二"), shape("三"), shape("四")];
        let new = [shape("一改"), shape("二"), shape("三"), shape("四改")];
        let steps = align(&old, &new);
        for i in [1, 2] {
            assert!(
                steps.contains(&Step::Pair {
                    old: i,
                    new: i,
                    same: true
                }),
                "{steps:?}"
            );
        }
        assert!(
            !steps
                .iter()
                .any(|s| matches!(s, Step::Insert(_) | Step::Delete(_)))
        );
    }
}
