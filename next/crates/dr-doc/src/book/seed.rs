//! Seed changes: default values every device writes the same way.
//!
//! Some writes come out the same on every device that makes them, and two
//! devices often make them before they have synced: the TODO projected from
//! a marker, the default rows and columns of a new plot grid. Written as
//! ordinary local changes they merge badly:
//!
//! - a text inserted on two devices reads twice ("补一场雨补一场雨");
//! - fresh row ids on two devices make a six-by-six grid;
//! - a default written later on a device with more history can overwrite
//!   what the author typed on another (a map key keeps the write with the
//!   larger Lamport time), so a TODO resolved on one device could reopen.
//!
//! A seed change avoids all three. Like the genesis, it is written on an
//! empty document by a peer derived from what it writes
//! ([`crate::peer::seed_peer`]), with timestamp 0 and no commit message, then
//! imported:
//!
//! - the same seed made on two devices is the same change, byte for byte,
//!   and Loro keeps one;
//! - it has no history before it, so its operations carry the smallest
//!   Lamport times there are: any real edit of the same key, on any device,
//!   before or after the seed arrives, wins over it;
//! - two different seeds for the same thing (two task texts for one marker,
//!   read on two devices from different versions of the paragraph) are two
//!   concurrent changes at the bottom; Loro picks the same one everywhere,
//!   and nothing is doubled because the varying part is a single value.
//!
//! The key a seed is imported under names everything it writes: one key, one
//! content, forever (two different changes under one op id would corrupt
//! the document). Changing what a seed writes means a new key: bump its
//! version suffix.
//!
//! **Importing commits what the write did before it** (Loro's import
//! barrier). The pending operations are committed with the options set by
//! `set_next_commit_options`, so set the write's origin and message first, as
//! `BookDoc::edit` does; otherwise seed before writing anything else.

use dr_model::DocId;
use dr_model::book::{EntityRef, PLOT_DEFAULT_LINES};
use dr_model::id::{BlockId, CommentId, NodeId, PlotColId, PlotRowId};
use dr_model::kind::{CommentKind, CommentStatus, EntityKind, ProjectionKind};
use dr_model::pos::PosKey;
use loro::{CommitOptions, ContainerID, ContainerType, ExportMode, LoroDoc, LoroMap};

use super::fields::set;
use super::write::{BookTxn, CommentWriter, PlotGridWriter};
use crate::error::{DocError, Result};
use crate::peer::seed_peer;
use crate::schema::book;

/// Seed versions; see the module documentation.
const TODO_SEED: &str = "todo-v1";
const PLOT_GRID_SEED: &str = "plot-grid-v1";

/// The fields a projected TODO's seed writes. Everything else on the entity
/// (author, source, times, metadata, body edits) is an ordinary write.
const TODO_SEED_KEYS: &[&str] = &[
    "kind",
    "target_kind",
    "target",
    "target_block",
    "projection",
    "projection_block",
    "projection_text",
    "status",
];

/// The entity a TODO projected from `doc` sits on. Only the book's text
/// projects TODOs: not the book document, a template or a conversation.
pub(super) fn projection_target(doc: &DocId) -> Result<EntityRef> {
    let kind = match doc {
        DocId::Node(_) => EntityKind::Node,
        DocId::Material(_) => EntityKind::Material,
        DocId::Element(_) => EntityKind::Element,
        DocId::Storyline(_) => EntityKind::Storyline,
        DocId::Category(_) => EntityKind::Category,
        DocId::Book(_) | DocId::Template(_) | DocId::Conversation(_) => {
            return Err(DocError::NotInProfile(
                "a TODO projected from a document that is not the book's text",
            ));
        }
    };
    Ok(EntityRef::new(kind, doc.entity_id()))
}

fn write_todo(
    w: &CommentWriter,
    kind: &ProjectionKind,
    doc: &DocId,
    block: &BlockId,
    task: &str,
) -> Result<()> {
    w.kind(&CommentKind::Todo)?
        .target(Some(&projection_target(doc)?))?
        .target_block(Some(block))?
        .status(&CommentStatus::Open)?;
    set(&w.map, "projection", kind)?;
    set(&w.map, "projection_block", block)?;
    w.map.insert("projection_text", task)?;
    Ok(())
}

/// The default rows and columns of `chapter`'s grid: positions only (a line
/// without a label reads as an empty label; a grid without a size reads as
/// the default size).
fn write_default_lines(grid: &LoroMap, chapter: &NodeId) -> Result<()> {
    for (key, ids) in [
        (
            "rows",
            (1..=PLOT_DEFAULT_LINES)
                .map(|n| PlotRowId::default_for(chapter, n).to_string())
                .collect::<Vec<_>>(),
        ),
        (
            "cols",
            (1..=PLOT_DEFAULT_LINES)
                .map(|n| PlotColId::default_for(chapter, n).to_string())
                .collect(),
        ),
    ] {
        let lines = grid.ensure_mergeable_map(key)?;
        let mut pos = PosKey::first();
        for (i, id) in ids.iter().enumerate() {
            if i > 0 {
                pos = pos.after();
            }
            lines
                .ensure_mergeable_map(id)?
                .insert("pos", pos.as_str())?;
        }
    }
    Ok(())
}

impl BookTxn<'_> {
    /// Import the seed named `key`: `write` fills an empty document as
    /// [`seed_peer`]`(book, key)`; see the module documentation.
    fn import_seed(&self, key: &str, write: impl FnOnce(&LoroDoc) -> Result<()>) -> Result<()> {
        let seed = LoroDoc::new();
        let doc_id = DocId::Book(self.view.book.clone()).to_string();
        seed.set_peer_id(seed_peer(&doc_id, key))?;
        write(&seed)?;
        seed.commit_with(CommitOptions::new().timestamp(0));
        let bytes = seed.export(ExportMode::all_updates())?;
        self.view.doc.import(&bytes)?;
        Ok(())
    }

    /// The child map `root/<id>` whether or not `root` points at it now (a
    /// deleted entity's fields are still there); `None` if it never existed.
    fn detached_entity(&self, root: &str, id: &str) -> Option<LoroMap> {
        let parent = ContainerID::new_root(root, ContainerType::Map);
        self.view
            .doc
            .try_get_map(ContainerID::new_mergeable(&parent, id, ContainerType::Map))
    }

    /// Whether `root/<id>` never held anything: the seed was never imported.
    fn never_written(&self, root: &str, id: &str) -> bool {
        self.detached_entity(root, id).is_none_or(|m| m.is_empty())
    }

    /// Project a TODO from a marker (or a material-note task line) this device
    /// found in block `block` of `doc`, whose task reads `task`. Its id is
    /// [`CommentId::for_projection`].
    ///
    /// The seed (kind, target, block, projection, status open, and the task
    /// as `projection_text`) is a seed change, so the same projection made on
    /// two devices before they sync merges into one TODO with one body, and a
    /// TODO resolved on one device stays resolved when another projects it
    /// late. Until the author edits it, the body *is* `projection_text`:
    /// set author, source, times and metadata on the writer returned, but not
    /// the body or the status.
    ///
    /// - The TODO exists: nothing is written.
    /// - A TODO of this block was deleted before (its marker was removed,
    ///   then typed again): the entity comes back as ordinary writes, with
    ///   only the seed's fields; what the old one had (an edited body, a
    ///   priority, an Agent conversation) is cleared.
    pub fn project_todo(
        &mut self,
        kind: &ProjectionKind,
        doc: &DocId,
        block: &BlockId,
        task: &str,
    ) -> Result<(CommentId, CommentWriter)> {
        projection_target(doc)?;
        let id = CommentId::for_projection(kind, doc, block);
        let live = self
            .view
            .doc
            .get_map(book::COMMENTS)
            .get(id.as_str())
            .is_some();
        if !live {
            if self.never_written(book::COMMENTS, id.as_str()) {
                let key = format!("{TODO_SEED}\0{id}\0{doc}\0{block}\0{task}");
                self.import_seed(&key, |seed| {
                    let map = seed
                        .get_map(book::COMMENTS)
                        .ensure_mergeable_map(id.as_str())?;
                    write_todo(&CommentWriter { map }, kind, doc, block, task)
                })?;
            }
            // Deleted before (or a seed this document already had, under a
            // later deletion): write it back as an ordinary change.
            let seeded = self
                .detached_entity(book::COMMENTS, id.as_str())
                .is_some_and(|m| m.get("projection").is_some())
                && self
                    .view
                    .doc
                    .get_map(book::COMMENTS)
                    .get(id.as_str())
                    .is_some();
            if !seeded {
                let w = self.comment(&id)?;
                let stale: Vec<String> = w
                    .map
                    .keys()
                    .map(|k| k.to_string())
                    .filter(|k| !TODO_SEED_KEYS.contains(&k.as_str()))
                    .collect();
                for k in &stale {
                    w.map.delete(k)?;
                }
                write_todo(&w, kind, doc, block, task)?;
            }
        }
        Ok((id.clone(), self.comment(&id)?))
    }

    /// Create `chapter`'s plot grid: three rows and three columns with the
    /// ids [`PlotRowId::default_for`] / [`PlotColId::default_for`], in that
    /// order, unlabelled, at the default cell size. Written as a seed
    /// change, so two devices creating the grid before they sync get one
    /// 3 × 3 grid, and a label typed on one device is never overwritten by
    /// another device's late default. An existing grid is left as it is.
    /// Returns its writer.
    pub fn create_plot_grid(&mut self, chapter: &NodeId) -> Result<PlotGridWriter> {
        let live = self
            .view
            .doc
            .get_map(book::PLOT_GRIDS)
            .get(chapter.as_str())
            .is_some();
        if !live && self.never_written(book::PLOT_GRIDS, chapter.as_str()) {
            let key = format!("{PLOT_GRID_SEED}\0{chapter}\0{PLOT_DEFAULT_LINES}");
            self.import_seed(&key, |seed| {
                let grid = seed
                    .get_map(book::PLOT_GRIDS)
                    .ensure_mergeable_map(chapter.as_str())?;
                write_default_lines(&grid, chapter)
            })?;
        }
        // A grid deleted before (only with its chapter) comes back as it was.
        self.plot_grid(chapter)
    }
}
