//! Text anchors as a pair of Loro cursors (decision D4).
//!
//! An anchor over `start..end` stores:
//! - `start`: a cursor on the first anchored character (`Side::Left`);
//! - `end`: a cursor on the last anchored character (`Side::Right`), read as
//!   "that character's position + 1" while it exists.
//!
//! Typing at either edge stays outside, typing inside is part of it. When
//! some anchored text is deleted the anchor shrinks; when all of it is, the
//! anchor collapses to a point where the text was (the comment stays, shown
//! as "原文已删除"). Undo does not bring a collapsed anchor back: undo
//! re-inserts text under new op ids. The editor carries anchors through its
//! own undo items (F4).
//!
//! After a deletion Loro must replay history to find a cursor (0.1–1 ms on
//! the heavy seed) and hands back a replacement cursor on a live character.
//! That replacement goes into an [`AnchorCache`] on this device, not back into
//! the book document: a read should not cause a synced write.

use std::collections::HashMap;
use std::ops::Range;

use dr_model::book::EncodedAnchor;
use loro::cursor::{Cursor, Side};
use loro::{ContainerTrait, LoroDoc, LoroText};

/// An anchor: two cursors.
#[derive(Clone, Debug, PartialEq)]
pub struct Anchor {
    pub start: Cursor,
    pub end: Cursor,
}

/// Where an anchor points now.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub range: Range<usize>,
    /// Every anchored character is gone; `range` is the empty range where the
    /// text was.
    pub collapsed: bool,
    /// An equivalent anchor on live characters, given when Loro had to replay
    /// history. Keep it in the [`AnchorCache`] so the next query is cheap.
    pub updated: Option<Anchor>,
}

impl Anchor {
    /// Anchor a non-empty `range` of `text`.
    pub fn new(text: &LoroText, range: Range<usize>) -> Option<Self> {
        if range.is_empty() || range.end > text.len_unicode() {
            return None;
        }
        Some(Self {
            start: text.get_cursor(range.start, Side::Left)?,
            end: text.get_cursor(range.end - 1, Side::Right)?,
        })
    }

    /// A zero-width anchor (both cursors identical).
    pub fn is_point(&self) -> bool {
        self.start.id == self.end.id && self.start.side == self.end.side
    }

    pub fn encode(&self) -> EncodedAnchor {
        EncodedAnchor {
            start: self.start.encode(),
            end: self.end.encode(),
        }
    }

    /// `None` for bytes that are not two cursors (damaged data reads as an
    /// unlocated comment).
    pub fn decode(e: &EncodedAnchor) -> Option<Self> {
        Some(Self {
            start: Cursor::decode(&e.start).ok()?,
            end: Cursor::decode(&e.end).ok()?,
        })
    }

    /// Resolve against the document that owns the text (use
    /// `ProseView::resolve`). `None` when the cursors belong to another
    /// container or cannot be found at all.
    pub(crate) fn resolve(&self, doc: &LoroDoc, text: &LoroText) -> Option<Resolved> {
        // Both cursors must point into this body. Asking Loro for a container
        // that does not exist panics, and damaged anchor bytes can name any
        // container (found by the `load_bytes` fuzz target).
        let body = text.id();
        if self.start.container != body || self.end.container != body {
            return None;
        }
        let len = text.len_unicode();
        if self.is_point() {
            let s = doc.get_cursor_pos(&self.start).ok()?;
            let pos = s.current.pos.min(len);
            let updated = s.update.map(|c| Anchor {
                start: c.clone(),
                end: c,
            });
            return Some(Resolved {
                range: pos..pos,
                collapsed: true,
                updated,
            });
        }
        let s = doc.get_cursor_pos(&self.start).ok()?;
        let e = doc.get_cursor_pos(&self.end).ok()?;
        let start_alive = s.update.is_none();
        let end_alive = e.update.is_none();
        let start = s.current.pos.min(len);
        let end = if end_alive {
            e.current.pos + 1
        } else {
            e.current.pos
        };
        let end = end.min(len).max(start);
        let collapsed = start == end;
        let updated = if start_alive && end_alive {
            None
        } else {
            if collapsed {
                let c = text.get_cursor(start, Side::Left)?;
                Some(Anchor {
                    start: c.clone(),
                    end: c,
                })
            } else {
                Anchor::new(text, start..end)
            }
        };
        Some(Resolved {
            range: start..end,
            collapsed,
            updated,
        })
    }
}

/// Replacement anchors found while resolving, kept on this device. Key them by
/// the owning entity id (a comment, a patch). Storage may persist the cache
/// locally; it is never synced.
#[derive(Default, Debug)]
pub struct AnchorCache {
    map: HashMap<String, Anchor>,
}

impl AnchorCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Resolve `stored` (the anchor in the book document), preferring a cached
    /// replacement, and remember any new replacement.
    pub fn resolve(
        &mut self,
        key: &str,
        stored: &Anchor,
        view: &crate::prose::ProseView<'_>,
    ) -> Option<Resolved> {
        let anchor = self.map.get(key).unwrap_or(stored);
        let r = view.resolve(anchor)?;
        if let Some(u) = &r.updated {
            self.map.insert(key.to_string(), u.clone());
        }
        Some(r)
    }

    pub fn get(&self, key: &str) -> Option<&Anchor> {
        self.map.get(key)
    }

    /// Forget a replacement (the entity was re-anchored or deleted).
    pub fn forget(&mut self, key: &str) {
        self.map.remove(key);
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// Every cached replacement, encoded, for local persistence.
    pub fn export(&self) -> Vec<(String, EncodedAnchor)> {
        let mut v: Vec<_> = self
            .map
            .iter()
            .map(|(k, a)| (k.clone(), a.encode()))
            .collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    }

    pub fn import(&mut self, entries: impl IntoIterator<Item = (String, EncodedAnchor)>) {
        for (k, e) in entries {
            if let Some(a) = Anchor::decode(&e) {
                self.map.insert(k, a);
            }
        }
    }
}
