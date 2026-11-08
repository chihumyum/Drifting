//! A table cell as gpui-prose's text source.
//!
//! A cell is a `LoroText` in the note's own document
//! (`embeds[<table>].rows[<row>].cells[<col>]`, `loro-schema.md` 「表格和素材嵌入」):
//! inline marks only, line breaks as U+2028. The editor sees it as one
//! paragraph followed by a newline that is not stored, so the editor's Enter
//! (a split) writes a U+2028, and pasted lines are joined the same way.
//!
//! - **Writes** go through the note's own [`ProseSession`] (shared with the
//!   body's [`crate::SessionSource`]): one commit per edit, origin `user`,
//!   so each lands on the one undo stack of the document. The cell keeps no
//!   history of its own; it counts the items its commits pushed
//!   ([`CellSource::host_items`]) and the table folds them into the body
//!   editor's history (`ProseEditor::record_host_items`), so ⌘Z anywhere in
//!   the note takes back the last thing the author did, cell or body.
//! - **Events** come from one subscription per table ([`TableFeed`]) on the
//!   holder thread, routed to each cell by its path (`rows/<row>/cells/<col>`),
//!   so a cell created by its first keystroke is heard too; anything else
//!   under the table (rows, columns, positions) flags the structure.

use std::any::Any;
use std::collections::HashMap;
use std::ops::Range;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use dr_model::id::EmbedId;
use dr_store::DocHandle;
use dr_workspace::ProseSession;
use gpui_prose::text::{
    Anchor, Edit, EditResult, MarkOverride, ORIGIN_USER, ProseSource, Resolved, SourceEvent,
    SourceParagraph, change_of, read_paragraphs,
};
use loro::Index;
use loro::{ContainerTrait, EventTriggerKind, LoroDoc, LoroText, LoroValue, ValueOrContainer};

/// The note's root map of embeds.
pub(crate) const EMBEDS: &str = "embeds";
/// A line break inside a cell.
pub const CELL_BREAK: char = '\u{2028}';

/// A cell's key: `(row id, column id)`.
pub type CellKey = (String, String);

#[derive(Default)]
struct CellQueue {
    events: Vec<SourceEvent>,
    pushed: u64,
    /// A read saw commits the editor had not taken.
    stale: bool,
}

#[derive(Default)]
struct FeedState {
    cells: HashMap<CellKey, CellQueue>,
    /// Rows, columns or their order changed since the view last read them.
    structure: bool,
    /// Commits that touched the table, and of those the author's.
    commits: u64,
    user_commits: u64,
}

/// What one table's subscription heard, shared by its cells.
#[derive(Default)]
pub struct TableFeed {
    state: Mutex<FeedState>,
}

impl TableFeed {
    fn state(&self) -> MutexGuard<'_, FeedState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The author's commits that touched the table so far.
    pub fn user_commits(&self) -> u64 {
        self.state().user_commits
    }

    /// All commits that touched the table so far.
    pub fn commits(&self) -> u64 {
        self.state().commits
    }

    /// Whether rows or columns changed since the last call (and clears it).
    pub fn take_structure(&self) -> bool {
        std::mem::take(&mut self.state().structure)
    }

    /// Subscribes on the holder thread to everything under table `embed`.
    pub fn subscribe(self: &Arc<Self>, doc: &LoroDoc, embed: &str) -> loro::Subscription {
        let feed = self.clone();
        let embed = embed.to_owned();
        let embeds = doc.get_map(EMBEDS);
        doc.subscribe(
            &embeds.id(),
            Arc::new(move |event| {
                let local = matches!(event.triggered_by, EventTriggerKind::Local);
                let mut state = feed.state();
                let mut touched = false;
                for diff in &event.events {
                    let keys: Vec<&str> = diff
                        .path
                        .iter()
                        .filter_map(|(_, index)| match index {
                            Index::Key(k) => Some(k.as_str()),
                            _ => None,
                        })
                        .collect();
                    let Some(at) = keys.iter().position(|k| *k == embed) else {
                        continue;
                    };
                    touched = true;
                    let under = &keys[at + 1..];
                    match (&diff.diff, under) {
                        (loro::event::Diff::Text(delta), ["rows", row, "cells", col]) => {
                            let changes: Vec<_> = delta.iter().map(change_of).collect();
                            let queue = state
                                .cells
                                .entry(((*row).to_owned(), (*col).to_owned()))
                                .or_default();
                            queue.events.push(SourceEvent {
                                origin: event.origin.to_owned(),
                                local,
                                changes,
                            });
                            queue.pushed += 1;
                        }
                        _ => state.structure = true,
                    }
                }
                if touched {
                    state.commits += 1;
                    if event.origin == ORIGIN_USER {
                        state.user_commits += 1;
                    }
                }
            }),
        )
    }
}

fn sub_map(m: &loro::LoroMap, key: &str) -> Option<loro::LoroMap> {
    match m.get(key)? {
        ValueOrContainer::Container(loro::Container::Map(m)) => Some(m),
        _ => None,
    }
}

/// The text of cell `(row, col)` of table `embed`, if it exists.
pub(crate) fn cell_text(doc: &LoroDoc, embed: &str, row: &str, col: &str) -> Option<LoroText> {
    let entry = sub_map(&doc.get_map(EMBEDS), embed)?;
    let row = sub_map(&sub_map(&entry, "rows")?, row)?;
    match sub_map(&row, "cells")?.get(col)? {
        ValueOrContainer::Container(loro::Container::Text(t)) => Some(t),
        _ => None,
    }
}

/// A cell as the editor reads it: its text as one paragraph, then the
/// empty line after the newline that is not stored.
fn paragraphs(doc: &LoroDoc, embed: &str, row: &str, col: &str) -> Vec<SourceParagraph> {
    let mut out = match cell_text(doc, embed, row, col) {
        Some(t) => read_paragraphs(&t.to_delta()),
        None => Vec::new(),
    };
    if out.is_empty() {
        out.push(SourceParagraph::default());
    }
    out.truncate(1);
    out.push(SourceParagraph::default());
    out
}

/// One edit, owned (it crosses to the holder thread).
#[derive(Clone, Debug)]
enum CellOp {
    Replace {
        range: Range<usize>,
        text: String,
        overrides: Vec<MarkOverride>,
    },
    Delete(Range<usize>),
    Break(usize),
    Mark {
        range: Range<usize>,
        key: String,
        value: LoroValue,
    },
    Unmark {
        range: Range<usize>,
        key: String,
    },
    Nothing,
}

impl From<Edit<'_>> for CellOp {
    fn from(edit: Edit<'_>) -> Self {
        match edit {
            Edit::Replace {
                range,
                text,
                overrides,
            } => CellOp::Replace {
                range,
                text: text.to_owned(),
                overrides: overrides.to_vec(),
            },
            Edit::Delete { range } => CellOp::Delete(range),
            Edit::Split { at } => CellOp::Break(at),
            Edit::SetBlockAttr { .. } => CellOp::Nothing,
            Edit::Mark { range, key, value } => CellOp::Mark {
                range,
                key: key.to_owned(),
                value,
            },
            Edit::Unmark { range, key } => CellOp::Unmark {
                range,
                key: key.to_owned(),
            },
        }
    }
}

/// `text` as a cell holds it: paragraphs joined by U+2028.
pub fn cell_line(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace(['\n', '\r'], &CELL_BREAK.to_string())
}

fn clamp(range: Range<usize>, len: usize) -> Range<usize> {
    range.start.min(len)..range.end.min(len).max(range.start.min(len))
}

fn apply(t: &LoroText, op: CellOp, out: &mut EditResult) -> loro::LoroResult<()> {
    let len = t.len_unicode();
    match op {
        CellOp::Replace {
            range,
            text,
            overrides,
        } => {
            let r = clamp(range, len);
            if !r.is_empty() {
                t.delete(r.start, r.len())?;
                out.deleted.push((r.start, r.len()));
            }
            let s = cell_line(&text);
            let n = s.chars().count();
            if n > 0 {
                t.insert(r.start, &s)?;
                let inserted = r.start..r.start + n;
                for (key, value) in &overrides {
                    match value {
                        Some(v) => t.mark(inserted.clone(), key, v.clone())?,
                        None => t.unmark(inserted.clone(), key)?,
                    }
                }
            }
            out.inserted = r.start..r.start + n;
            out.caret = r.start + n;
        }
        CellOp::Delete(range) => {
            let r = clamp(range, len);
            if !r.is_empty() {
                t.delete(r.start, r.len())?;
                out.deleted.push((r.start, r.len()));
            }
            out.inserted = r.start..r.start;
            out.caret = r.start;
        }
        CellOp::Break(at) => {
            let at = at.min(len);
            t.insert(at, &CELL_BREAK.to_string())?;
            out.inserted = at..at + 1;
            out.caret = at + 1;
        }
        CellOp::Mark { range, key, value } => {
            let r = clamp(range, len);
            if !r.is_empty() {
                t.mark(r.clone(), &key, value)?;
            }
            out.caret = r.end;
        }
        CellOp::Unmark { range, key } => {
            let r = clamp(range, len);
            if !r.is_empty() {
                t.unmark(r.clone(), &key)?;
            }
            out.caret = r.end;
        }
        CellOp::Nothing => {}
    }
    Ok(())
}

/// gpui-prose's text source on one cell of a note's table.
pub struct CellSource {
    doc_id: String,
    embed: EmbedId,
    row: String,
    col: String,
    session: Arc<ProseSession>,
    handle: DocHandle,
    feed: Arc<TableFeed>,
    /// Events handed to the editor.
    taken: u64,
    host_items: Arc<AtomicUsize>,
}

impl CellSource {
    pub(crate) fn new(
        doc_id: &str,
        embed: EmbedId,
        key: &CellKey,
        session: Arc<ProseSession>,
        handle: DocHandle,
        feed: Arc<TableFeed>,
    ) -> CellSource {
        CellSource {
            doc_id: doc_id.to_owned(),
            embed,
            row: key.0.clone(),
            col: key.1.clone(),
            session,
            handle,
            feed,
            taken: 0,
            host_items: Arc::default(),
        }
    }

    /// Items this cell's commits pushed onto the document's undo stack and
    /// nobody has folded into an editor's history yet (taken by the table).
    pub fn host_items(&self) -> Arc<AtomicUsize> {
        self.host_items.clone()
    }

    fn key(&self) -> CellKey {
        (self.row.clone(), self.col.clone())
    }

    fn write(&mut self, ops: Vec<CellOp>) -> EditResult {
        let (embed, row, col) = (self.embed.clone(), self.row.clone(), self.col.clone());
        let before = self.feed.user_commits();
        let written = self.session.edit(move |txn| {
            let table = txn.table(&embed)?;
            let text = table.cell(&row, &col)?;
            let mut out = EditResult::default();
            for op in ops {
                apply(&text, op, &mut out)?;
            }
            Ok(out)
        });
        let pushed = (self.feed.user_commits() - before) as usize;
        self.host_items.fetch_add(pushed, Ordering::Relaxed);
        match written {
            Ok(mut out) => {
                // The cell keeps no history of its own (see the module docs).
                out.undo_items = 0;
                out
            }
            Err(e) => {
                log::error!("dr-editor: cell edit in {} failed: {e}", self.doc_id);
                EditResult::default()
            }
        }
    }
}

impl ProseSource for CellSource {
    fn read_all(&self) -> Vec<SourceParagraph> {
        let (feed, key, taken) = (self.feed.clone(), self.key(), self.taken);
        let (embed, row, col) = (self.embed.to_string(), self.row.clone(), self.col.clone());
        self.handle
            .read(move |doc| {
                let mut state = feed.state();
                let queue = state.cells.entry(key).or_default();
                if queue.pushed != taken {
                    queue.stale = true;
                }
                drop(state);
                paragraphs(doc, &embed, &row, &col)
            })
            .unwrap_or_else(|e| {
                log::error!("dr-editor: cell read failed: {e}");
                vec![SourceParagraph::default(), SourceParagraph::default()]
            })
    }

    fn read(&self, range: Range<usize>) -> Vec<SourceParagraph> {
        if range.is_empty() {
            return vec![SourceParagraph::default()];
        }
        // One paragraph: whatever part is asked for, it is all of it.
        let mut all = self.read_all();
        if range.start > 0 {
            return vec![all.pop().unwrap_or_default()];
        }
        all.truncate(1);
        all
    }

    fn take_events(&mut self) -> Vec<SourceEvent> {
        let mut state = self.feed.state();
        let queue = state.cells.entry(self.key()).or_default();
        self.taken = queue.pushed;
        std::mem::take(&mut queue.events)
    }

    fn edit(&mut self, edit: Edit<'_>, _origin: &str) -> EditResult {
        self.write(vec![edit.into()])
    }

    fn edit_batch(&mut self, edits: &[Edit<'_>], _origin: &str) -> EditResult {
        self.write(edits.iter().cloned().map(CellOp::from).collect())
    }

    fn undo_item(&mut self) -> bool {
        false
    }

    fn redo_item(&mut self) -> bool {
        false
    }

    fn anchor(&self, _range: Range<usize>) -> Option<Anchor> {
        None
    }

    fn resolve(&self, _anchor: &Anchor) -> Option<Resolved> {
        None
    }

    fn resync(&mut self) -> Vec<SourceParagraph> {
        let (feed, key) = (self.feed.clone(), self.key());
        let (embed, row, col) = (self.embed.to_string(), self.row.clone(), self.col.clone());
        let read = self.handle.read(move |doc| {
            let mut state = feed.state();
            let queue = state.cells.entry(key).or_default();
            queue.events.clear();
            queue.stale = false;
            let pushed = queue.pushed;
            drop(state);
            (paragraphs(doc, &embed, &row, &col), pushed)
        });
        match read {
            Ok((paragraphs, pushed)) => {
                self.taken = pushed;
                paragraphs
            }
            Err(e) => {
                log::error!("dr-editor: cell resync failed: {e}");
                vec![SourceParagraph::default(), SourceParagraph::default()]
            }
        }
    }

    fn needs_resync(&mut self) -> bool {
        let mut state = self.feed.state();
        std::mem::take(&mut state.cells.entry(self.key()).or_default().stale)
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_become_cell_breaks() {
        assert_eq!(cell_line("一\n二\r\n三"), "一\u{2028}二\u{2028}三");
    }

    #[test]
    fn the_feed_hears_cells_by_path_and_flags_the_rest() {
        let doc = LoroDoc::new();
        let feed = Arc::new(TableFeed::default());
        let _sub = feed.subscribe(&doc, "t1");
        let entry = doc
            .get_map(EMBEDS)
            .insert_container("t1", loro::LoroMap::new())
            .unwrap();
        entry.insert("kind", "table").unwrap();
        doc.commit();
        assert!(feed.take_structure(), "the entry itself is structure");
        let cells = entry
            .insert_container("rows", loro::LoroMap::new())
            .unwrap()
            .insert_container("r1", loro::LoroMap::new())
            .unwrap()
            .insert_container("cells", loro::LoroMap::new())
            .unwrap();
        doc.commit();
        feed.take_structure();
        let text = cells.insert_container("c1", LoroText::new()).unwrap();
        text.insert(0, "格").unwrap();
        doc.set_next_commit_origin(ORIGIN_USER);
        doc.commit();
        let state = feed.state();
        let queue = &state.cells[&("r1".to_owned(), "c1".to_owned())];
        assert_eq!(queue.pushed, 1);
        assert_eq!(state.user_commits, 1);
        drop(state);
        // Another table's commits are not this one's.
        doc.get_map(EMBEDS).insert("t2", 1).unwrap();
        doc.commit();
        assert_eq!(feed.commits(), 3);
    }
}
