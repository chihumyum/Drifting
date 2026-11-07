//! Prose documents: one flat `LoroText` per body (decision D3).
//!
//! - [`ProseDoc`] is the one writer of a document (storage's document holder
//!   owns it); [`ProseReader`] is a cheap, shareable read handle.
//! - [`ProseView`] reads; [`ProseTxn`] writes, inside [`ProseDoc::edit`].
//! - Positions are Unicode scalars; convert with [`ProseView::pos`].

mod attrs;
pub mod embed;
pub mod event;
pub mod txn;
pub mod view;

use dr_model::{DocId, Origin, ProseProfile};
use loro::{CommitOptions, ExportMode, Frontiers, LoroDoc, LoroMap, LoroText, VersionVector};

use crate::core::{Committed, Core, Imported, check_borrowed, configured};
use crate::error::{DocError, Result};
use crate::peer::{PeerId, genesis_peer};
use crate::schema::{self, GENESIS_VERSION, SCHEMA_VERSION};

pub use embed::{EmbedKind, EmbedView, TableLine, TableWriter};
pub use event::{ProseEvent, TextChange, Trigger};
pub use txn::{ProseTxn, StyleKey};
pub use view::{BlockRef, Paragraph, Paragraphs, ProseView, Run};

/// The deterministic genesis change of a prose document: `meta` plus one
/// empty paragraph whose block id is `0@<genesis peer>`. Every device computes
/// identical bytes and Loro dedupes by op id, so two devices that initialise
/// the same document concurrently still have one empty paragraph.
pub fn genesis(doc_id: &DocId) -> Vec<u8> {
    let id = doc_id.to_string();
    let doc = LoroDoc::new();
    doc.config_text_style(schema::style_config());
    let peer = genesis_peer(&id, GENESIS_VERSION);
    doc.set_peer_id(peer).expect("genesis peer");
    let meta = doc.get_map(schema::prose::META);
    meta.insert(schema::meta::VERSION, SCHEMA_VERSION)
        .expect("meta");
    meta.insert(schema::meta::DOC, id.as_str()).expect("meta");
    let text = doc.get_text(schema::prose::BODY);
    text.insert(0, "\n").expect("genesis newline");
    text.mark(0..1, schema::block::ID, format!("0@{peer}"))
        .expect("genesis block id");
    doc.commit_with(CommitOptions::new().timestamp(0));
    doc.export(ExportMode::all_updates())
        .expect("export genesis")
}

struct Inner {
    core: Core,
    text: LoroText,
    embeds: LoroMap,
    profile: ProseProfile,
}

impl Inner {
    fn new(core: Core) -> Result<Self> {
        let profile = core.id.profile().ok_or(DocError::WrongDocument {
            expected: core.id.clone(),
            found: "a book document id".into(),
        })?;
        Ok(Self {
            text: core.doc.get_text(schema::prose::BODY),
            embeds: core.doc.get_map(schema::prose::EMBEDS),
            core,
            profile,
        })
    }

    fn view(&self) -> ProseView<'_> {
        ProseView {
            doc: &self.core.doc,
            text: &self.text,
            embeds: &self.embeds,
            profile: self.profile,
        }
    }

    fn reader(&self) -> ProseReader {
        ProseReader {
            inner: Inner {
                core: self.core.clone(),
                text: self.text.clone(),
                embeds: self.embeds.clone(),
                profile: self.profile,
            }
            .into(),
        }
    }
}

/// The writer of one prose document. Not `Clone`: one writer per document,
/// so the author's keystrokes and an Agent's edit never share a commit.
pub struct ProseDoc {
    inner: Inner,
}

impl ProseDoc {
    /// A new document at genesis, editing as `peer`.
    pub fn create(doc_id: DocId, peer: PeerId) -> Result<Self> {
        Self::load(doc_id, peer, &[])
    }

    /// Load from storage: a snapshot and/or updates in any order (the genesis
    /// is added). Fails if the bytes belong to another document.
    pub fn load(doc_id: DocId, peer: PeerId, blobs: &[Vec<u8>]) -> Result<Self> {
        let g = genesis(&doc_id);
        let core = Core::load(doc_id, &g, blobs, Some(peer), schema::meta::DOC)?;
        Ok(Self {
            inner: Inner::new(core)?,
        })
    }

    pub fn doc_id(&self) -> &DocId {
        &self.inner.core.id
    }

    pub fn profile(&self) -> ProseProfile {
        self.inner.profile
    }

    pub fn peer(&self) -> PeerId {
        self.inner.core.peer()
    }

    /// Switch to a new peer (storage's epoch rotation).
    pub fn set_peer(&mut self, peer: PeerId) -> Result<()> {
        self.inner.core.set_peer(peer)
    }

    pub fn view(&self) -> ProseView<'_> {
        self.inner.view()
    }

    /// A shareable read handle on the same document.
    pub fn reader(&self) -> ProseReader {
        self.inner.reader()
    }

    /// One commit with `origin`. `f` gets a transaction; whatever it applied
    /// is committed even if it returns an error. Returns `f`'s value and the
    /// commit to persist (`None` if nothing changed).
    pub fn edit<R>(
        &mut self,
        origin: Origin,
        f: impl FnOnce(&mut ProseTxn<'_>) -> Result<R>,
    ) -> (Result<R>, Option<Committed>) {
        self.edit_at(origin, None, f)
    }

    /// [`Self::edit`] with an explicit commit timestamp (seconds), for
    /// deterministic imports.
    pub fn edit_at<R>(
        &mut self,
        origin: Origin,
        timestamp: Option<i64>,
        f: impl FnOnce(&mut ProseTxn<'_>) -> Result<R>,
    ) -> (Result<R>, Option<Committed>) {
        let inner = &self.inner;
        inner.core.transact(&origin, timestamp, || {
            let mut txn = ProseTxn { view: inner.view() };
            f(&mut txn)
        })
    }

    /// Import remote bytes (origin `sync` normally), then repair duplicate
    /// block ids the merge may have produced.
    pub fn import(&mut self, bytes: &[u8], origin: Origin) -> Result<Imported> {
        let pending = self.inner.core.import(bytes, &origin)?;
        let repair = self.repair()?;
        Ok(Imported { pending, repair })
    }

    /// Run the block-id repair as its own commit (origin `repair`). Storage
    /// runs it after opening a document; [`Self::import`] runs it after
    /// every import.
    pub fn repair(&mut self) -> Result<Option<Committed>> {
        let (r, c) = self.edit(Origin::Repair, |t| t.repair_block_ids());
        r?;
        Ok(c)
    }

    pub fn version(&self) -> VersionVector {
        self.inner.core.version()
    }

    pub fn frontiers(&self) -> Frontiers {
        self.inner.core.frontiers()
    }

    pub fn export_updates_since(&self, vv: &VersionVector) -> Result<Vec<u8>> {
        self.inner.core.export_updates_since(vv)
    }

    pub fn export_snapshot(&self) -> Result<Vec<u8>> {
        self.inner.core.export_snapshot()
    }

    /// Subscribe to changes of this document (body, embeds, meta). The
    /// callback runs synchronously after each commit or import, on the thread
    /// that made it. Drop the returned subscription to unsubscribe.
    pub fn subscribe(&self, f: impl Fn(&ProseEvent) + Send + Sync + 'static) -> loro::Subscription {
        event::subscribe(&self.inner.core.doc, self.inner.profile, f)
    }

    /// The undo manager for the author's typing: merge interval 0 (the editor
    /// groups bursts itself, `loro-schema.md` "撤销"), every origin but `user`
    /// excluded. Undo/redo through [`crate::undo::ProseUndo`] so the step is
    /// persisted.
    pub fn undo_manager(&self) -> crate::undo::ProseUndo {
        crate::undo::ProseUndo::new(&self.inner.core.doc)
    }

    pub(crate) fn core(&self) -> &Core {
        &self.inner.core
    }
}

/// A prose document someone else holds — dr-store's document holder owns the
/// `LoroDoc` and commits; this gives the typed views and transactions on it.
///
/// - **Nothing here commits.** Writes from [`Self::txn`] go into the
///   document's pending transaction; the holder commits them (one commit, one
///   origin) and persists the update.
/// - Before running a write, the holder should set the commit's options
///   (`LoroDoc::set_next_commit_options` with origin and message): resolving
///   an anchor on deleted text commits implicitly behind a barrier, and that
///   implicit commit takes the options set then.
/// - The document must be configured with [`crate::schema::configure`] (the
///   one style table) and carry its genesis ([`genesis`]).
pub struct BorrowedProse<'a> {
    doc: &'a LoroDoc,
    text: LoroText,
    embeds: LoroMap,
    profile: ProseProfile,
}

impl<'a> BorrowedProse<'a> {
    /// Wrap `doc`, checking it is `doc_id`'s prose document and initialised.
    pub fn new(doc: &'a LoroDoc, doc_id: &DocId) -> Result<Self> {
        let profile = doc_id.profile().ok_or(DocError::WrongDocument {
            expected: doc_id.clone(),
            found: "a book document id".into(),
        })?;
        check_borrowed(doc, doc_id, schema::meta::DOC)?;
        Ok(Self {
            text: doc.get_text(schema::prose::BODY),
            embeds: doc.get_map(schema::prose::EMBEDS),
            doc,
            profile,
        })
    }

    pub fn view(&self) -> ProseView<'_> {
        ProseView {
            doc: self.doc,
            text: &self.text,
            embeds: &self.embeds,
            profile: self.profile,
        }
    }

    /// A write on the borrowed document; the holder commits it.
    pub fn txn(&self) -> ProseTxn<'_> {
        ProseTxn { view: self.view() }
    }

    /// The author's undo stack for this document; see
    /// [`crate::undo::ProseUndo::undo_step`].
    pub fn undo_manager(&self) -> crate::undo::ProseUndo {
        crate::undo::ProseUndo::new(self.doc)
    }
}

/// A read-only handle on a prose document: `Clone`, `Send`, `Sync`. Reads see
/// the writer's latest applied state, which during an open transaction may
/// include half of it; read in an event callback (or on the writer's thread)
/// for a consistent picture.
#[derive(Clone)]
pub struct ProseReader {
    inner: std::sync::Arc<Inner>,
}

impl ProseReader {
    pub fn doc_id(&self) -> &DocId {
        &self.inner.core.id
    }

    pub fn view(&self) -> ProseView<'_> {
        self.inner.view()
    }

    pub fn subscribe(&self, f: impl Fn(&ProseEvent) + Send + Sync + 'static) -> loro::Subscription {
        event::subscribe(&self.inner.core.doc, self.inner.profile, f)
    }

    /// A reader on a document someone else holds (a dr-store holder's hot
    /// document): shares it, copies and writes nothing. Checks that `doc` is
    /// `doc_id`'s prose document and initialised.
    pub fn from_loro(doc_id: DocId, doc: &LoroDoc) -> Result<ProseReader> {
        check_borrowed(doc, &doc_id, schema::meta::DOC)?;
        let core = Core {
            doc: doc.clone(),
            id: doc_id,
        };
        Ok(ProseReader {
            inner: Inner::new(core)?.into(),
        })
    }

    /// A private, detached copy of the document at `frontiers`, loaded from
    /// storage's `blobs`. For history views and Agent-change previews: do not
    /// check out the open document (P0-C: that expands history in it for
    /// good). Drop the copy when done.
    pub fn load_at(doc_id: DocId, blobs: &[Vec<u8>], frontiers: &Frontiers) -> Result<ProseReader> {
        let g = genesis(&doc_id);
        let doc = configured();
        for b in blobs {
            LoroDoc::decode_import_blob_meta(b, true)?;
        }
        let mut all = blobs.to_vec();
        all.push(g);
        doc.import_batch(&all)?;
        doc.checkout(frontiers)?;
        let core = Core { doc, id: doc_id };
        Ok(ProseReader {
            inner: Inner::new(core)?.into(),
        })
    }
}

#[cfg(test)]
mod tests;
