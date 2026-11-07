//! The book (catalog) document: one per book.
//!
//! Every entity is a mergeable map under its root map, keyed by its id, so
//! the same entity written on two devices merges field by field. Writes are
//! field by field too, so a field a newer version added survives this
//! version's edit. Order is numbers on the entities, not lists; idea groups
//! and material folders are Loro trees.

pub(crate) mod fields;
pub mod read;
mod seed;
pub mod write;

use std::collections::BTreeSet;
use std::sync::Arc;

use dr_model::id::{BookId, RelationTypeId};
use dr_model::kind::EntityKind;
use dr_model::{DocId, Origin};
use loro::event::{Diff, DiffEvent};
use loro::{CommitOptions, ContainerID, ExportMode, Frontiers, Index, LoroDoc, VersionVector};

use crate::core::{Committed, Core, Imported, check_borrowed, configured};
use crate::error::Result;
use crate::peer::{PeerId, genesis_peer};
use crate::prose::Trigger;
use crate::schema::{self, GENESIS_VERSION, SCHEMA_VERSION, book};

pub use read::{BookView, EntitySnapshot, RepairPlan, metadata_fields};
pub use write::BookTxn;

/// Id of the built-in relation type every book has, exactly as the old client
/// (`genericAssociationRelationTypeId`), so imported relations keep pointing
/// at it. The genesis creates it, so it never exists twice.
pub fn generic_relation_type_id(book: &BookId) -> RelationTypeId {
    RelationTypeId::parse(&format!("system:generic-association:{book}")).expect("valid id")
}

/// The built-in type's definition (old `genericAssociationRelationType`):
/// directed, from a comment or material to any structural entity.
pub(crate) const GENERIC_NAME: &str = "Generic association";
pub(crate) const GENERIC_DESCRIPTION: &str =
    "Built-in association for TODO and library item links.";

/// The deterministic genesis of a book document: `meta` and the built-in,
/// locked relation type.
pub fn genesis(book_id: &BookId) -> Vec<u8> {
    let doc = LoroDoc::new();
    doc.config_text_style(schema::style_config());
    let doc_id = DocId::Book(book_id.clone()).to_string();
    doc.set_peer_id(genesis_peer(&doc_id, GENESIS_VERSION))
        .expect("genesis peer");
    let meta = doc.get_map(book::META);
    meta.insert(schema::meta::VERSION, SCHEMA_VERSION)
        .expect("meta");
    meta.insert(schema::meta::BOOK, book_id.as_str())
        .expect("meta");
    let rt = doc
        .get_map(book::RELATION_TYPES)
        .ensure_mergeable_map(generic_relation_type_id(book_id).as_str())
        .expect("relation type");
    let kinds = |ks: &[EntityKind]| -> loro::LoroValue {
        loro::LoroValue::List(
            ks.iter()
                .map(|k| loro::LoroValue::from(k.as_str()))
                .collect::<Vec<_>>()
                .into(),
        )
    };
    for (k, v) in [
        ("name", loro::LoroValue::from(GENERIC_NAME)),
        (
            "normalized_name",
            dr_model::book::normalize_relation_type_name(GENERIC_NAME).into(),
        ),
        ("description", GENERIC_DESCRIPTION.into()),
        ("orientation", "directed".into()),
        ("system_key", "generic-association".into()),
        ("locked", true.into()),
        ("source_role", "Source".into()),
        ("target_role", "Target".into()),
        (
            "source_kinds",
            kinds(&[EntityKind::Comment, EntityKind::Material]),
        ),
        (
            "target_kinds",
            kinds(&[
                EntityKind::Node,
                EntityKind::Element,
                EntityKind::Patch,
                EntityKind::Category,
                EntityKind::Storyline,
            ]),
        ),
    ] {
        rt.insert(k, v).expect("relation type field");
    }
    doc.commit_with(CommitOptions::new().timestamp(0));
    doc.export(ExportMode::all_updates())
        .expect("export genesis")
}

/// A collection of the book document (a root container).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Collection {
    Meta,
    Nodes,
    Acts,
    Storylines,
    Categories,
    Elements,
    Patches,
    RelationTypes,
    Relations,
    TimePins,
    PlotGrids,
    Comments,
    Materials,
    Assets,
    DriftGroups,
    MaterialFolders,
    Facts,
    Memory,
    WritingDays,
}

impl Collection {
    pub const ALL: [Collection; 19] = [
        Collection::Meta,
        Collection::Nodes,
        Collection::Acts,
        Collection::Storylines,
        Collection::Categories,
        Collection::Elements,
        Collection::Patches,
        Collection::RelationTypes,
        Collection::Relations,
        Collection::TimePins,
        Collection::PlotGrids,
        Collection::Comments,
        Collection::Materials,
        Collection::Assets,
        Collection::DriftGroups,
        Collection::MaterialFolders,
        Collection::Facts,
        Collection::Memory,
        Collection::WritingDays,
    ];

    /// The root container's name.
    pub fn root(self) -> &'static str {
        match self {
            Collection::Meta => book::META,
            Collection::Nodes => book::NODES,
            Collection::Acts => book::ACTS,
            Collection::Storylines => book::STORYLINES,
            Collection::Categories => book::CATEGORIES,
            Collection::Elements => book::ELEMENTS,
            Collection::Patches => book::PATCHES,
            Collection::RelationTypes => book::RELATION_TYPES,
            Collection::Relations => book::RELATIONS,
            Collection::TimePins => book::TIME_PINS,
            Collection::PlotGrids => book::PLOT_GRIDS,
            Collection::Comments => book::COMMENTS,
            Collection::Materials => book::MATERIALS,
            Collection::Assets => book::ASSETS,
            Collection::DriftGroups => book::DRIFT_GROUPS,
            Collection::MaterialFolders => book::MATERIAL_FOLDERS,
            Collection::Facts => book::FACTS,
            Collection::Memory => book::MEMORY,
            Collection::WritingDays => book::WRITING_DAYS,
        }
    }

    pub fn from_root(name: &str) -> Option<Self> {
        Collection::ALL.into_iter().find(|c| c.root() == name)
    }

    /// Whether entities of this collection are keyed by id in a root map
    /// (everything but meta, the two trees, facts and writing days, which are
    /// keyed too but by entry id / device-day).
    pub fn is_tree(self) -> bool {
        matches!(self, Collection::DriftGroups | Collection::MaterialFolders)
    }
}

/// One changed thing: a whole collection (`id: None`, e.g. a tree move or a
/// meta field) or one entity (`id`: its key in the root map).
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Change {
    pub collection: Collection,
    pub id: Option<String>,
}

/// A change to the book document.
#[derive(Clone, Debug)]
pub struct BookEvent {
    pub trigger: Trigger,
    pub origin: Option<Origin>,
    pub changes: BTreeSet<Change>,
}

fn root_name(id: &ContainerID) -> Option<&str> {
    match id {
        ContainerID::Root { name, .. } => Some(name.as_str()),
        ContainerID::Normal { .. } => None,
    }
}

pub(crate) fn convert(e: &DiffEvent<'_>) -> BookEvent {
    let mut changes = BTreeSet::new();
    for d in &e.events {
        let root = d
            .path
            .first()
            .and_then(|(id, _)| root_name(id))
            .or_else(|| root_name(d.target));
        let Some(collection) = root.and_then(Collection::from_root) else {
            continue;
        };
        // path[0] is the root; path[1], when present, is the entity's key.
        let entity = d.path.get(1).and_then(|(_, idx)| match idx {
            Index::Key(k) => Some(k.to_string()),
            _ => None,
        });
        if let Some(id) = entity {
            changes.insert(Change {
                collection,
                id: Some(id),
            });
            continue;
        }
        match &d.diff {
            // A change of the root map itself: entities added, replaced or
            // removed.
            Diff::Map(m) if collection != Collection::Meta => {
                for k in m.updated.keys() {
                    changes.insert(Change {
                        collection,
                        id: Some(k.to_string()),
                    });
                }
            }
            _ => {
                changes.insert(Change {
                    collection,
                    id: None,
                });
            }
        }
    }
    BookEvent {
        trigger: e.triggered_by.into(),
        origin: Origin::parse(e.origin),
        changes,
    }
}

struct Inner {
    core: Core,
    book: BookId,
}

impl Inner {
    fn view(&self) -> BookView<'_> {
        BookView {
            doc: &self.core.doc,
            book: &self.book,
        }
    }
}

/// The writer of one book document (one per book, like [`crate::prose::ProseDoc`]).
pub struct BookDoc {
    inner: Inner,
}

impl BookDoc {
    pub fn create(book: BookId, peer: PeerId) -> Result<Self> {
        Self::load(book, peer, &[])
    }

    pub fn load(book: BookId, peer: PeerId, blobs: &[Vec<u8>]) -> Result<Self> {
        let g = genesis(&book);
        let core = Core::load(
            DocId::Book(book.clone()),
            &g,
            blobs,
            Some(peer),
            schema::meta::BOOK,
        )?;
        Ok(Self {
            inner: Inner { core, book },
        })
    }

    pub fn book_id(&self) -> &BookId {
        &self.inner.book
    }

    pub fn doc_id(&self) -> &DocId {
        &self.inner.core.id
    }

    pub fn peer(&self) -> PeerId {
        self.inner.core.peer()
    }

    pub fn set_peer(&mut self, peer: PeerId) -> Result<()> {
        self.inner.core.set_peer(peer)
    }

    pub fn view(&self) -> BookView<'_> {
        self.inner.view()
    }

    pub fn reader(&self) -> BookReader {
        BookReader {
            inner: Arc::new(Inner {
                core: self.inner.core.clone(),
                book: self.inner.book.clone(),
            }),
        }
    }

    /// One commit with `origin`; see [`crate::prose::ProseDoc::edit`].
    pub fn edit<R>(
        &mut self,
        origin: Origin,
        f: impl FnOnce(&mut BookTxn<'_>) -> Result<R>,
    ) -> (Result<R>, Option<Committed>) {
        self.edit_at(origin, None, f)
    }

    pub fn edit_at<R>(
        &mut self,
        origin: Origin,
        timestamp: Option<i64>,
        f: impl FnOnce(&mut BookTxn<'_>) -> Result<R>,
    ) -> (Result<R>, Option<Committed>) {
        let inner = &self.inner;
        inner.core.transact(&origin, timestamp, || {
            let mut txn = BookTxn { view: inner.view() };
            f(&mut txn)
        })
    }

    /// Import remote bytes. Book repairs are background work
    /// ([`Self::repair`]), not run on every import.
    pub fn import(&mut self, bytes: &[u8], origin: Origin) -> Result<Imported> {
        let pending = self.inner.core.import(bytes, &origin)?;
        Ok(Imported {
            pending,
            repair: None,
        })
    }

    /// Compute and apply the deterministic background repairs
    /// ([`RepairPlan`]) as one commit with origin `repair`.
    pub fn repair(&mut self) -> Result<(RepairPlan, Option<Committed>)> {
        if !self.view().needs_repair() {
            return Ok((RepairPlan::default(), None));
        }
        let plan = self.view().repair_plan();
        if plan.is_empty() {
            return Ok((plan, None));
        }
        let (r, c) = self.edit(Origin::Repair, |t| t.apply_repair(&plan));
        r?;
        Ok((plan, c))
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

    /// Entity-level change events.
    pub fn subscribe(&self, f: impl Fn(&BookEvent) + Send + Sync + 'static) -> loro::Subscription {
        subscribe(&self.inner.core.doc, f)
    }
}

fn subscribe(doc: &LoroDoc, f: impl Fn(&BookEvent) + Send + Sync + 'static) -> loro::Subscription {
    doc.subscribe_root(Arc::new(move |e| f(&convert(&e))))
}

/// A book document someone else holds (dr-store's holder): the typed views
/// and transactions on its `LoroDoc`. Nothing here commits; see
/// [`crate::prose::BorrowedProse`] for the rules (the holder commits with one
/// origin and sets the commit options before writing).
pub struct BorrowedBook<'a> {
    doc: &'a LoroDoc,
    book: BookId,
}

impl<'a> BorrowedBook<'a> {
    /// Wrap `doc`, checking it is `book`'s book document and initialised.
    pub fn new(doc: &'a LoroDoc, book: &BookId) -> Result<Self> {
        check_borrowed(doc, &DocId::Book(book.clone()), schema::meta::BOOK)?;
        Ok(Self {
            doc,
            book: book.clone(),
        })
    }

    pub fn view(&self) -> BookView<'_> {
        BookView {
            doc: self.doc,
            book: &self.book,
        }
    }

    /// A write on the borrowed document; the holder commits it.
    pub fn txn(&self) -> BookTxn<'_> {
        BookTxn { view: self.view() }
    }
}

/// A shareable read handle on a book document (see [`crate::prose::ProseReader`]).
#[derive(Clone)]
pub struct BookReader {
    inner: Arc<Inner>,
}

impl BookReader {
    pub fn book_id(&self) -> &BookId {
        &self.inner.book
    }

    pub fn view(&self) -> BookView<'_> {
        self.inner.view()
    }

    pub fn subscribe(&self, f: impl Fn(&BookEvent) + Send + Sync + 'static) -> loro::Subscription {
        subscribe(&self.inner.core.doc, f)
    }

    /// A reader on a book document someone else holds: shares it, copies and
    /// writes nothing.
    pub fn from_loro(book: BookId, doc: &LoroDoc) -> Result<BookReader> {
        check_borrowed(doc, &DocId::Book(book.clone()), schema::meta::BOOK)?;
        Ok(BookReader {
            inner: Arc::new(Inner {
                core: Core {
                    doc: doc.clone(),
                    id: DocId::Book(book.clone()),
                },
                book,
            }),
        })
    }

    /// A private, detached copy at `frontiers` (history views).
    pub fn load_at(book: BookId, blobs: &[Vec<u8>], frontiers: &Frontiers) -> Result<BookReader> {
        let doc = configured();
        for b in blobs {
            LoroDoc::decode_import_blob_meta(b, true)?;
        }
        let mut all = blobs.to_vec();
        all.push(genesis(&book));
        doc.import_batch(&all)?;
        doc.checkout(frontiers)?;
        Ok(BookReader {
            inner: Arc::new(Inner {
                core: Core {
                    doc,
                    id: DocId::Book(book.clone()),
                },
                book,
            }),
        })
    }
}

#[cfg(test)]
mod tests;
