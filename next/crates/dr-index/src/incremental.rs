//! Updating a document's derived paragraphs from Loro diffs.
//!
//! The paragraphs derived last time are laid out as segments of the body.
//! Each body diff (Quill-style retain / insert / delete, in Unicode scalars,
//! applied in commit order) edits that layout: retained text stays as it
//! was, restyled text becomes "dirty", inserted text is dirty, deleted text
//! goes. Afterwards a paragraph that is still exactly one old paragraph,
//! whole and unchanged, keeps its derived data ([`Slot::Kept`]); everything
//! else is re-read from the document ([`Slot::Read`]), and only the dirty
//! text is scanned for newlines.
//!
//! The result is the same as reading the whole document (a property test
//! checks it); when the diffs do not add up to the document's length, or so
//! much changed that re-reading would cost more than a full read, the caller
//! reads the whole document instead.

use dr_doc::prose::ProseView;
use dr_doc::schema;
use dr_model::prose::PARAGRAPH_END;
use dr_store::ContainerChange;
use loro::event::Diff;
use loro::{ContainerID, TextDelta};

use crate::paragraphs::Block;

/// More body diff items than this: read the whole document.
pub const MAX_DELTA_ITEMS: usize = 4096;
/// Re-reading a paragraph costs about what reading it in a full pass costs
/// (dr-doc's `paragraph_in` looks at nothing before it), so the diffs are
/// used until half the document's paragraphs would be re-read, and always
/// for this many.
pub const MIN_READ_LIMIT: usize = 32;

/// How many paragraphs may be re-read for a document that had `old`.
pub fn read_limit(old: usize) -> usize {
    MIN_READ_LIMIT.max(old / 2)
}

/// Why diffs could not be used.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fallback {
    TooManyDiffs,
    TooManyParagraphs,
    /// The diffs do not line up with what was derived (a bug, or a cache
    /// entry from another version of the document).
    Mismatch(&'static str),
}

impl std::fmt::Display for Fallback {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Fallback::TooManyDiffs => write!(f, "more than {MAX_DELTA_ITEMS} diff items"),
            Fallback::TooManyParagraphs => write!(f, "more than half the paragraphs changed"),
            Fallback::Mismatch(why) => write!(f, "diffs do not line up: {why}"),
        }
    }
}

/// One paragraph after the diffs.
#[derive(Debug)]
pub enum Slot {
    /// Old paragraph `idx`, whole and unchanged.
    Kept(usize),
    /// Re-read from the document.
    Read(Block),
}

/// The paragraphs after the diffs, in order, and how many were re-read.
#[derive(Debug)]
pub struct Update {
    pub slots: Vec<Slot>,
    pub read: usize,
}

/// A piece of the body: part of an old paragraph, unchanged, or changed text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Seg {
    Clean { idx: usize, off: usize, len: usize },
    Dirty { len: usize },
}

impl Seg {
    fn len(&self) -> usize {
        match *self {
            Seg::Clean { len, .. } | Seg::Dirty { len } => len,
        }
    }

    /// The first `n` characters, and the rest.
    fn split(self, n: usize) -> (Seg, Seg) {
        match self {
            Seg::Clean { idx, off, len } => (
                Seg::Clean { idx, off, len: n },
                Seg::Clean {
                    idx,
                    off: off + n,
                    len: len - n,
                },
            ),
            Seg::Dirty { len } => (Seg::Dirty { len: n }, Seg::Dirty { len: len - n }),
        }
    }
}

/// Append, merging with the previous segment where they continue each other.
fn push(out: &mut Vec<Seg>, s: Seg) {
    if s.len() == 0 {
        return;
    }
    match (out.last_mut(), s) {
        (Some(Seg::Dirty { len }), Seg::Dirty { len: n }) => *len += n,
        (
            Some(Seg::Clean { idx, off, len }),
            Seg::Clean {
                idx: i,
                off: o,
                len: n,
            },
        ) if *idx == i && *off + *len == o => *len += n,
        _ => out.push(s),
    }
}

/// Apply one body diff to the layout.
fn apply(input: Vec<Seg>, delta: &[TextDelta]) -> Result<Vec<Seg>, Fallback> {
    let mut out: Vec<Seg> = Vec::with_capacity(input.len() + 2);
    let mut rest = input.into_iter();
    let mut head: Option<Seg> = None;
    // The next piece of at most `n` characters of the old layout.
    let mut take = |head: &mut Option<Seg>, n: usize| -> Result<Seg, Fallback> {
        let s = match head.take() {
            Some(s) => s,
            None => rest
                .next()
                .ok_or(Fallback::Mismatch("a diff runs past the end"))?,
        };
        if s.len() <= n {
            Ok(s)
        } else {
            let (a, b) = s.split(n);
            *head = Some(b);
            Ok(a)
        }
    };
    for d in delta {
        match d {
            TextDelta::Retain { retain, attributes } => {
                let restyled = attributes.as_ref().is_some_and(|a| !a.is_empty());
                let mut n = *retain;
                while n > 0 {
                    let s = take(&mut head, n)?;
                    n -= s.len();
                    push(
                        &mut out,
                        if restyled {
                            Seg::Dirty { len: s.len() }
                        } else {
                            s
                        },
                    );
                }
            }
            TextDelta::Insert { insert, .. } => push(
                &mut out,
                Seg::Dirty {
                    len: insert.chars().count(),
                },
            ),
            TextDelta::Delete { delete } => {
                let mut n = *delete;
                while n > 0 {
                    n -= take(&mut head, n)?.len();
                }
            }
        }
    }
    if let Some(s) = head {
        push(&mut out, s);
    }
    for s in rest {
        push(&mut out, s);
    }
    Ok(out)
}

fn root_name(id: &ContainerID) -> Option<&str> {
    match id {
        ContainerID::Root { name, .. } => Some(name.as_str()),
        ContainerID::Normal { .. } => None,
    }
}

/// The root container a change belongs to.
fn root_of(c: &ContainerChange) -> Option<&str> {
    c.path
        .first()
        .and_then(|(id, _)| root_name(id))
        .or_else(|| root_name(&c.target))
}

/// Re-read paragraphs as the layout is walked, counting them.
struct Reader<'v, 'a> {
    view: &'v ProseView<'a>,
    out: Vec<Slot>,
    read: usize,
    limit: usize,
}

impl Reader<'_, '_> {
    /// Read the paragraph starting at `start` whose newline is at `newline`
    /// (`None`: the unterminated end of a damaged body).
    fn read(&mut self, start: usize, newline: Option<usize>) -> Result<(), Fallback> {
        self.read += 1;
        if self.read > self.limit {
            return Err(Fallback::TooManyParagraphs);
        }
        // The stored block id: which paragraph keeps a duplicated one is
        // decided over the whole document afterwards.
        let p = self
            .view
            .paragraph_in(start, 1)
            .pop()
            .ok_or(Fallback::Mismatch("a paragraph start is out of range"))?;
        let ok = p.range.start == start
            && match newline {
                Some(nl) => p.terminated && p.newline == nl,
                None => !p.terminated,
            };
        if !ok {
            return Err(Fallback::Mismatch(
                "a paragraph is not where the diffs put it",
            ));
        }
        self.out.push(Slot::Read(Block::read(self.view, &p)));
        Ok(())
    }
}

/// The paragraphs of `view`, from `old` (derived from an earlier version of
/// the same document) and the Loro changes since then.
pub fn update(
    view: &ProseView<'_>,
    old: &[Block],
    changes: &[ContainerChange],
) -> Result<Update, Fallback> {
    let mut segs: Vec<Seg> = Vec::with_capacity(old.len());
    for (idx, b) in old.iter().enumerate() {
        push(
            &mut segs,
            Seg::Clean {
                idx,
                off: 0,
                len: b.len,
            },
        );
    }
    let mut items = 0usize;
    let mut embeds_changed = false;
    for c in changes {
        match root_of(c) {
            Some(schema::prose::BODY) => {
                if let Diff::Text(delta) = &c.diff {
                    items += delta.len();
                    if items > MAX_DELTA_ITEMS {
                        return Err(Fallback::TooManyDiffs);
                    }
                    segs = apply(segs, delta)?;
                }
            }
            Some(schema::prose::EMBEDS) => embeds_changed = true,
            _ => {}
        }
    }
    let total: usize = segs.iter().map(Seg::len).sum();
    if total != view.len() {
        return Err(Fallback::Mismatch("the length differs from the document"));
    }
    let mut r = Reader {
        view,
        out: Vec::with_capacity(old.len() + 1),
        read: 0,
        limit: read_limit(old.len()),
    };
    let mut pos = 0usize;
    // Start of the paragraph being assembled.
    let mut start = 0usize;
    for s in segs {
        let len = s.len();
        match s {
            Seg::Clean { idx, off, len: n } => {
                let b = &old[idx];
                let ends_paragraph = b.terminated && off + n == b.len;
                if off == 0 && n == b.len && ends_paragraph && start == pos {
                    // Exactly an old paragraph, untouched.
                    if embeds_changed && b.embed.is_some() {
                        r.read(pos, Some(pos + n - 1))?;
                    } else {
                        r.out.push(Slot::Kept(idx));
                    }
                    start = pos + n;
                } else if ends_paragraph {
                    // The end of an old paragraph closes the one assembled.
                    r.read(start, Some(pos + n - 1))?;
                    start = pos + n;
                }
            }
            Seg::Dirty { .. } => {
                let text = view
                    .text_in(pos..pos + len)
                    .map_err(|_| Fallback::Mismatch("changed text is out of range"))?;
                for (k, c) in text.chars().enumerate() {
                    if c == PARAGRAPH_END {
                        r.read(start, Some(pos + k))?;
                        start = pos + k + 1;
                    }
                }
            }
        }
        pos += len;
    }
    if start < pos {
        r.read(start, None)?;
    }
    Ok(Update {
        slots: r.out,
        read: r.read,
    })
}
