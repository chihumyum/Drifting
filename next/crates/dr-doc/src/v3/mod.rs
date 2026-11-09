//! Universal kernel v3 book document (`docs/rust-rewrite/kernel-v3.md`).
//!
//! Coexists alongside [`crate::book`] (v2.2) until K4 switches the shell over.
//! Every v3 book document starts from [`genesis_v3`] with `meta.v = 3`.

pub mod novel;
mod raw;
pub mod read;
mod structure;
pub mod write;

use std::collections::BTreeSet;
use std::sync::Arc;

use dr_model::id::BookId;
use dr_model::kind::EntityKind;
use dr_model::{DocId, Origin};
use loro::event::{Diff, DiffEvent};
use loro::{
    CommitOptions, ContainerID, ExportMode, Frontiers, Index, LoroDoc, LoroValue, ValueOrContainer,
    VersionVector,
};

use crate::book::{GENERIC_DESCRIPTION, GENERIC_NAME, generic_relation_type_id};
use crate::core::{Committed, Core, Imported, check_borrowed, configured};
use crate::error::Result;
use crate::peer::{PeerId, genesis_peer};
use crate::prose::Trigger;
use crate::schema::{self, GENESIS_VERSION_V3, SCHEMA_VERSION_V3, book_v3};

pub use novel::{
    NOVEL_PROJECT_TEMPLATE_ID, NOVEL_PROJECT_TEMPLATE_VERSION, NovelRootEntries,
    apply_novel_project_template, apply_novel_project_template_with, find_novel_roots,
    novel_project_templates,
};
pub use raw::raw_document_state;
pub use read::{BookViewV3, EntrySnapshotV3, RepairPlanV3, TimelineFieldV3};
pub use structure::BookStructureV3;
pub use write::BookTxnV3;

/// Whether `doc` is a universal kernel v3 book document (`meta.v == 3`).
pub fn is_v3_doc(doc: &LoroDoc) -> bool {
    match doc.get_map(book_v3::META).get(schema::meta::VERSION) {
        Some(ValueOrContainer::Value(LoroValue::I64(v))) => v == SCHEMA_VERSION_V3,
        Some(ValueOrContainer::Value(LoroValue::Double(d))) => d == SCHEMA_VERSION_V3 as f64,
        _ => false,
    }
}

/// Deterministic genesis of a v3 book document (`meta.v = 3` and the built-in
/// locked relation type whose target kinds are `entry` and `patch`).
pub fn genesis_v3(book_id: &BookId) -> Vec<u8> {
    let doc = LoroDoc::new();
    doc.config_text_style(schema::style_config());
    let doc_id = DocId::Book(book_id.clone()).to_string();
    doc.set_peer_id(genesis_peer(&doc_id, GENESIS_VERSION_V3))
        .expect("genesis peer");
    let meta = doc.get_map(book_v3::META);
    meta.insert(schema::meta::VERSION, SCHEMA_VERSION_V3)
        .expect("meta");
    meta.insert(schema::meta::BOOK, book_id.as_str())
        .expect("meta");
    let rt = doc
        .get_map(book_v3::RELATION_TYPES)
        .ensure_mergeable_map(generic_relation_type_id(book_id).as_str())
        .expect("relation type");
    let kinds = |ks: &[EntityKind]| -> LoroValue {
        LoroValue::List(
            ks.iter()
                .map(|k| LoroValue::from(k.as_str()))
                .collect::<Vec<_>>()
                .into(),
        )
    };
    for (k, v) in [
        ("name", LoroValue::from(GENERIC_NAME)),
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
            kinds(&[EntityKind::Entry, EntityKind::Patch]),
        ),
    ] {
        rt.insert(k, v).expect("relation type field");
    }
    doc.commit_with(CommitOptions::new().timestamp(0));
    doc.export(ExportMode::all_updates())
        .expect("export v3 genesis")
}

/// A root container of the v3 book document.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum CollectionV3 {
    Meta,
    Entries,
    Templates,
    Memberships,
    TimelineViews,
    Patches,
    PlotGrids,
    RelationTypes,
    Relations,
    Comments,
    Materials,
    Assets,
    MaterialFolders,
    Facts,
    Memory,
    WritingDays,
}

impl CollectionV3 {
    pub const ALL: [CollectionV3; 16] = [
        CollectionV3::Meta,
        CollectionV3::Entries,
        CollectionV3::Templates,
        CollectionV3::Memberships,
        CollectionV3::TimelineViews,
        CollectionV3::Patches,
        CollectionV3::PlotGrids,
        CollectionV3::RelationTypes,
        CollectionV3::Relations,
        CollectionV3::Comments,
        CollectionV3::Materials,
        CollectionV3::Assets,
        CollectionV3::MaterialFolders,
        CollectionV3::Facts,
        CollectionV3::Memory,
        CollectionV3::WritingDays,
    ];

    pub fn root(self) -> &'static str {
        match self {
            CollectionV3::Meta => book_v3::META,
            CollectionV3::Entries => book_v3::ENTRIES,
            CollectionV3::Templates => book_v3::TEMPLATES,
            CollectionV3::Memberships => book_v3::MEMBERSHIPS,
            CollectionV3::TimelineViews => book_v3::TIMELINE_VIEWS,
            CollectionV3::Patches => book_v3::PATCHES,
            CollectionV3::PlotGrids => book_v3::PLOT_GRIDS,
            CollectionV3::RelationTypes => book_v3::RELATION_TYPES,
            CollectionV3::Relations => book_v3::RELATIONS,
            CollectionV3::Comments => book_v3::COMMENTS,
            CollectionV3::Materials => book_v3::MATERIALS,
            CollectionV3::Assets => book_v3::ASSETS,
            CollectionV3::MaterialFolders => book_v3::MATERIAL_FOLDERS,
            CollectionV3::Facts => book_v3::FACTS,
            CollectionV3::Memory => book_v3::MEMORY,
            CollectionV3::WritingDays => book_v3::WRITING_DAYS,
        }
    }

    pub fn from_root(name: &str) -> Option<Self> {
        CollectionV3::ALL.into_iter().find(|c| c.root() == name)
    }

    pub fn is_tree(self) -> bool {
        matches!(self, CollectionV3::Entries | CollectionV3::MaterialFolders)
    }
}

/// One changed entity or root container in a v3 book document.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ChangeV3 {
    pub collection: CollectionV3,
    pub id: Option<String>,
}

/// A change event on a v3 book document.
#[derive(Clone, Debug)]
pub struct BookEventV3 {
    pub trigger: Trigger,
    pub origin: Option<Origin>,
    pub changes: BTreeSet<ChangeV3>,
}

fn root_name(id: &ContainerID) -> Option<&str> {
    match id {
        ContainerID::Root { name, .. } => Some(name.as_str()),
        ContainerID::Normal { .. } => None,
    }
}

pub(crate) fn convert_v3(e: &DiffEvent<'_>) -> BookEventV3 {
    let mut changes = BTreeSet::new();
    for d in &e.events {
        let root = d
            .path
            .first()
            .and_then(|(id, _)| root_name(id))
            .or_else(|| root_name(d.target));
        let Some(collection) = root.and_then(CollectionV3::from_root) else {
            continue;
        };
        let entity = d.path.get(1).and_then(|(_, idx)| match idx {
            Index::Key(k) => Some(k.to_string()),
            _ => None,
        });
        if let Some(id) = entity {
            changes.insert(ChangeV3 {
                collection,
                id: Some(id),
            });
            continue;
        }
        match &d.diff {
            Diff::Map(m) if collection != CollectionV3::Meta => {
                for k in m.updated.keys() {
                    changes.insert(ChangeV3 {
                        collection,
                        id: Some(k.to_string()),
                    });
                }
            }
            _ => {
                changes.insert(ChangeV3 {
                    collection,
                    id: None,
                });
            }
        }
    }
    BookEventV3 {
        trigger: e.triggered_by.into(),
        origin: Origin::parse(e.origin),
        changes,
    }
}

struct InnerV3 {
    core: Core,
    book: BookId,
}

impl InnerV3 {
    fn view(&self) -> BookViewV3<'_> {
        BookViewV3 {
            doc: &self.core.doc,
            book: &self.book,
        }
    }
}

/// Writer of one v3 book document.
pub struct BookDocV3 {
    inner: InnerV3,
}

impl BookDocV3 {
    pub fn create(book: BookId, peer: PeerId) -> Result<Self> {
        Self::load(book, peer, &[])
    }

    pub fn load(book: BookId, peer: PeerId, blobs: &[Vec<u8>]) -> Result<Self> {
        let g = genesis_v3(&book);
        let core = Core::load(
            DocId::Book(book.clone()),
            &g,
            blobs,
            Some(peer),
            schema::meta::BOOK,
        )?;
        Ok(Self {
            inner: InnerV3 { core, book },
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

    pub fn view(&self) -> BookViewV3<'_> {
        self.inner.view()
    }

    pub fn reader(&self) -> BookReaderV3 {
        BookReaderV3 {
            inner: Arc::new(InnerV3 {
                core: self.inner.core.clone(),
                book: self.inner.book.clone(),
            }),
        }
    }

    pub fn edit<R>(
        &mut self,
        origin: Origin,
        f: impl FnOnce(&mut BookTxnV3<'_>) -> Result<R>,
    ) -> (Result<R>, Option<Committed>) {
        self.edit_at(origin, None, f)
    }

    pub fn edit_at<R>(
        &mut self,
        origin: Origin,
        timestamp: Option<i64>,
        f: impl FnOnce(&mut BookTxnV3<'_>) -> Result<R>,
    ) -> (Result<R>, Option<Committed>) {
        let inner = &self.inner;
        inner.core.transact(&origin, timestamp, || {
            let mut txn = BookTxnV3 { view: inner.view() };
            f(&mut txn)
        })
    }

    pub fn import(&mut self, bytes: &[u8], origin: Origin) -> Result<Imported> {
        let pending = self.inner.core.import(bytes, &origin)?;
        Ok(Imported {
            pending,
            repair: None,
        })
    }

    pub fn repair(&mut self) -> Result<(RepairPlanV3, Option<Committed>)> {
        if !self.view().needs_repair() {
            return Ok((RepairPlanV3::default(), None));
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

    pub fn subscribe(
        &self,
        f: impl Fn(&BookEventV3) + Send + Sync + 'static,
    ) -> loro::Subscription {
        subscribe_v3(&self.inner.core.doc, f)
    }
}

fn subscribe_v3(
    doc: &LoroDoc,
    f: impl Fn(&BookEventV3) + Send + Sync + 'static,
) -> loro::Subscription {
    doc.subscribe_root(Arc::new(move |e| f(&convert_v3(&e))))
}

/// A v3 book document borrowed from an external holder (`dr-store`).
pub struct BorrowedBookV3<'a> {
    doc: &'a LoroDoc,
    book: BookId,
}

impl<'a> BorrowedBookV3<'a> {
    pub fn new(doc: &'a LoroDoc, book: &BookId) -> Result<Self> {
        check_borrowed(doc, &DocId::Book(book.clone()), schema::meta::BOOK)?;
        Ok(Self {
            doc,
            book: book.clone(),
        })
    }

    pub fn view(&self) -> BookViewV3<'_> {
        BookViewV3 {
            doc: self.doc,
            book: &self.book,
        }
    }

    pub fn txn(&self) -> BookTxnV3<'_> {
        BookTxnV3 { view: self.view() }
    }
}

/// Shareable read handle on a v3 book document.
#[derive(Clone)]
pub struct BookReaderV3 {
    inner: Arc<InnerV3>,
}

impl BookReaderV3 {
    pub fn book_id(&self) -> &BookId {
        &self.inner.book
    }

    pub fn view(&self) -> BookViewV3<'_> {
        self.inner.view()
    }

    pub fn subscribe(
        &self,
        f: impl Fn(&BookEventV3) + Send + Sync + 'static,
    ) -> loro::Subscription {
        subscribe_v3(&self.inner.core.doc, f)
    }

    pub fn from_loro(book: BookId, doc: &LoroDoc) -> Result<BookReaderV3> {
        check_borrowed(doc, &DocId::Book(book.clone()), schema::meta::BOOK)?;
        Ok(BookReaderV3 {
            inner: Arc::new(InnerV3 {
                core: Core {
                    doc: doc.clone(),
                    id: DocId::Book(book.clone()),
                },
                book,
            }),
        })
    }

    pub fn load_at(book: BookId, blobs: &[Vec<u8>], frontiers: &Frontiers) -> Result<BookReaderV3> {
        let doc = configured();
        for b in blobs {
            LoroDoc::decode_import_blob_meta(b, true)?;
        }
        let mut all = blobs.to_vec();
        all.push(genesis_v3(&book));
        doc.import_batch(&all)?;
        doc.checkout(frontiers)?;
        Ok(BookReaderV3 {
            inner: Arc::new(InnerV3 {
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
