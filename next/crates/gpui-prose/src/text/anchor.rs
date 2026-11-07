//! Text anchors (comments, patches, later references): a pair of Loro
//! cursors over a range of a body text.
//!
//! - `start` is a cursor on the first anchored character (`Side::Left`);
//! - `end` is a cursor on the last anchored character (`Side::Right`), which
//!   resolves to "that character's position + 1" while it exists.
//!
//! Typing at either edge stays outside; typing inside is part of the anchor.
//! Deleting some anchored text shrinks the anchor; deleting all of it
//! collapses it to a point. Undoing a delete puts back *new* characters, which
//! the old cursors cannot find, so the editor records anchors in its undo
//! items and re-anchors them when it undoes (see `text::undo`).
//!
//! The editor only holds anchors while a document is open. Where they are
//! stored (Drifting keeps them in the book document) is the host's business:
//! it loads them with [`crate::ProseDoc::set_anchor`] and persists what
//! [`crate::ProseDoc::take_anchor_changes`] reports. Anchors are made and
//! resolved by the text source ([`ProseSource::anchor`], [`ProseSource::resolve`]).

use std::{collections::BTreeMap, ops::Range};

use gpui::SharedString;
use loro::{
    LoroDoc, LoroText,
    cursor::{Cursor, Side},
};

use super::source::ProseSource;

/// The host's id for an anchor (a comment id, say).
pub type AnchorId = SharedString;

#[derive(Clone, Debug, PartialEq)]
pub struct Anchor {
    pub start: Cursor,
    pub end: Cursor,
}

/// Where an anchor points now.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub range: Range<usize>,
    /// All anchored text is gone; `range` is the empty range where it was.
    pub collapsed: bool,
    /// A cheaper equivalent on live characters, returned when Loro had to
    /// replay history to find a deleted character. Keep it locally; it need
    /// not be written back.
    pub updated: Option<Anchor>,
}

impl Anchor {
    /// Anchors `range` (non-empty) of `text`.
    pub fn new(text: &LoroText, range: Range<usize>) -> Option<Anchor> {
        if range.is_empty() || range.end > text.len_unicode() {
            return None;
        }
        Some(Anchor {
            start: text.get_cursor(range.start, Side::Left)?,
            end: text.get_cursor(range.end - 1, Side::Right)?,
        })
    }

    /// A zero-width anchor at `pos` (both cursors on the character after it).
    pub fn point(text: &LoroText, pos: usize) -> Option<Anchor> {
        let cursor = text.get_cursor(pos, Side::Left)?;
        Some(Anchor {
            start: cursor.clone(),
            end: cursor,
        })
    }

    pub fn is_point(&self) -> bool {
        self.start.id == self.end.id && self.start.side == self.end.side
    }

    /// `(start, end)` as `Cursor::encode` bytes, the stored form.
    pub fn encode(&self) -> (Vec<u8>, Vec<u8>) {
        (self.start.encode(), self.end.encode())
    }

    pub fn decode(start: &[u8], end: &[u8]) -> Option<Anchor> {
        Some(Anchor {
            start: Cursor::decode(start).ok()?,
            end: Cursor::decode(end).ok()?,
        })
    }

    /// Resolves against the document that owns the text.
    pub fn resolve(&self, doc: &LoroDoc) -> Option<Resolved> {
        if self.is_point() {
            let found = doc.get_cursor_pos(&self.start).ok()?;
            let pos = found.current.pos;
            return Some(Resolved {
                range: pos..pos,
                collapsed: true,
                updated: found.update.map(|cursor| Anchor {
                    start: cursor.clone(),
                    end: cursor,
                }),
            });
        }
        let start = doc.get_cursor_pos(&self.start).ok()?;
        let end = doc.get_cursor_pos(&self.end).ok()?;
        let (start_alive, end_alive) = (start.update.is_none(), end.update.is_none());
        let from = start.current.pos;
        let to = if end_alive {
            end.current.pos + 1
        } else {
            end.current.pos
        }
        .max(from);
        let collapsed = from == to;
        let updated = if start_alive && end_alive {
            None
        } else {
            let text = doc.get_text(self.start.container.clone());
            if collapsed {
                Anchor::point(&text, from)
            } else {
                Anchor::new(&text, from..to)
            }
        };
        Some(Resolved {
            range: from..to,
            collapsed,
            updated,
        })
    }
}

/// The anchors held for one open body text.
#[derive(Clone, Debug, Default)]
pub struct AnchorSet {
    anchors: BTreeMap<AnchorId, Anchor>,
}

impl AnchorSet {
    pub fn insert(&mut self, id: AnchorId, anchor: Anchor) {
        self.anchors.insert(id, anchor);
    }

    pub fn remove(&mut self, id: &str) -> Option<Anchor> {
        self.anchors.remove(id)
    }

    pub fn get(&self, id: &str) -> Option<&Anchor> {
        self.anchors.get(id)
    }

    pub fn len(&self) -> usize {
        self.anchors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.anchors.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&AnchorId, &Anchor)> {
        self.anchors.iter()
    }

    /// Resolves one anchor, keeping Loro's replacement cursor locally.
    pub fn resolve(&mut self, id: &str, source: &dyn ProseSource) -> Option<Resolved> {
        let resolved = source.resolve(self.anchors.get(id)?)?;
        if let Some(updated) = resolved.updated.clone()
            && let Some(anchor) = self.anchors.get_mut(id)
        {
            *anchor = updated;
        }
        Some(resolved)
    }

    /// Every anchor with its current range.
    pub fn resolve_all(&mut self, source: &dyn ProseSource) -> Vec<(AnchorId, Resolved)> {
        let ids: Vec<AnchorId> = self.anchors.keys().cloned().collect();
        ids.into_iter()
            .filter_map(|id| {
                let resolved = self.resolve(&id, source)?;
                Some((id, resolved))
            })
            .collect()
    }
}

/// An anchor the editor moved (an undo brought its text back). The host
/// persists `anchor`; `range` is where it points now.
#[derive(Clone, Debug, PartialEq)]
pub struct AnchorChange {
    pub id: AnchorId,
    pub anchor: Anchor,
    pub range: Range<usize>,
}
