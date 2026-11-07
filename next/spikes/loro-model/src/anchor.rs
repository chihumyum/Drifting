//! Text anchors as a pair of Loro cursors (decision D4).
//!
//! An anchor over `start..end` stores:
//! - `start`: a cursor on the first anchored character (`Side::Left`);
//! - `end`: a cursor on the last anchored character (`Side::Right`), resolved
//!   as "position of that character + 1" while it exists.
//!
//! Text typed at either boundary therefore stays outside the anchor, like the
//! old non-inclusive comment marks. When anchored characters are deleted,
//! Loro replays history to find where they were and returns a replacement
//! cursor on a live character; callers persist it (see [`Resolved::updated`]).

use std::ops::Range;

use loro::LoroDoc;
use loro::LoroText;
use loro::cursor::{Cursor, Side};

#[derive(Clone, Debug, PartialEq)]
pub struct Anchor {
    pub start: Cursor,
    pub end: Cursor,
}

/// What an anchor points at now.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub range: Range<usize>,
    /// Every anchored character is gone; `range` is the empty range where
    /// the text used to be.
    pub collapsed: bool,
    /// A cheaper equivalent anchor on live characters, returned when Loro had
    /// to replay history. Persist it so the next query does not replay.
    pub updated: Option<Anchor>,
}

impl Anchor {
    /// Anchor `range` (non-empty) in `text`.
    pub fn new(text: &LoroText, range: Range<usize>) -> Option<Self> {
        if range.is_empty() || range.end > text.len_unicode() {
            return None;
        }
        Some(Self {
            start: text.get_cursor(range.start, Side::Left)?,
            end: text.get_cursor(range.end - 1, Side::Right)?,
        })
    }

    /// A zero-width anchor (both cursors identical): what a fully deleted
    /// anchor collapses to.
    pub fn is_point(&self) -> bool {
        self.start.id == self.end.id && self.start.side == self.end.side
    }

    pub fn encode(&self) -> (Vec<u8>, Vec<u8>) {
        (self.start.encode(), self.end.encode())
    }

    pub fn decode(start: &[u8], end: &[u8]) -> Option<Self> {
        Some(Self {
            start: Cursor::decode(start).ok()?,
            end: Cursor::decode(end).ok()?,
        })
    }

    /// Resolve against the document that owns the text.
    pub fn resolve(&self, doc: &LoroDoc) -> Option<Resolved> {
        if self.is_point() {
            let s = doc.get_cursor_pos(&self.start).ok()?;
            let pos = s.current.pos;
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
        let start = s.current.pos;
        // A live end cursor sits on the last anchored character.
        let end = if end_alive {
            e.current.pos + 1
        } else {
            e.current.pos
        };
        let end = end.max(start);
        let collapsed = start == end;
        let updated = if start_alive && end_alive {
            None
        } else {
            let text = doc.get_text(self.start.container.clone());
            if collapsed {
                // Keep a zero-width anchor at the deletion point: both cursors
                // on the character after it.
                let c = text.get_cursor(start, Side::Left)?;
                Some(Anchor {
                    start: c.clone(),
                    end: c,
                })
            } else {
                Anchor::new(&text, start..end)
            }
        };
        Some(Resolved {
            range: start..end,
            collapsed,
            updated,
        })
    }
}
