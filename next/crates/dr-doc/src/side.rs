//! The three small documents beside a book document (`kernel-v4.md` §8 &
//! `kernel-v5.md` §8): `stats:<book>` holds the book's writing days,
//! `checkpoints:<book>` its complete-entry checkpoint manifests, and
//! `layout:<book>` its free-canvas positions (`<scope>/<mode> -> entry -> [x, y]`).
//!
//! None is prose and none is the book: no editing profile, not
//! counted, searched or exported, no TODO projection. They belong to the
//! book their id names. Keeping them out of the book document means that
//! recording a writing day, saving a checkpoint, or dragging a card on a
//! canvas never advances the book's version, never wakes the book's content
//! listeners, and never makes another device validate the whole book document.
//!
//! All three start from a deterministic genesis (`meta.v = 1`, `meta.doc = <id>`,
//! written by the document's genesis peer at timestamp 0), so two devices
//! that each create one write the same change and merge into one.

use std::collections::BTreeMap;

use dr_model::id::{BookId, DeviceKey, EntryId};
use dr_model::shared::WritingDay;
use dr_model::{Day, DocId, Origin};
use loro::{
    CommitOptions, ExportMode, Frontiers, LoroDoc, LoroValue, ValueOrContainer, VersionVector,
};

use crate::core::{Committed, Core, Imported, check_borrowed, configured};
use crate::error::{DocError, Result};
use crate::peer::{PeerId, genesis_peer};
use crate::schema::{self, SIDE_GENESIS_VERSION, SIDE_SCHEMA_VERSION};

fn side_genesis(doc_id: &DocId) -> Vec<u8> {
    let id = doc_id.to_string();
    let doc = configured();
    doc.set_peer_id(genesis_peer(&id, SIDE_GENESIS_VERSION))
        .expect("genesis peer");
    let meta = doc.get_map(schema::side::META);
    meta.insert(schema::meta::VERSION, SIDE_SCHEMA_VERSION)
        .expect("meta version");
    meta.insert(schema::meta::DOC, id.as_str())
        .expect("meta id");
    doc.commit_with(CommitOptions::new().timestamp(0));
    doc.export(ExportMode::all_updates())
        .expect("export side document genesis")
}

/// Deterministic genesis of `stats:<book>`.
pub fn stats_genesis(book: &BookId) -> Vec<u8> {
    side_genesis(&DocId::Stats(book.clone()))
}

/// Deterministic genesis of `checkpoints:<book>`.
pub fn checkpoints_genesis(book: &BookId) -> Vec<u8> {
    side_genesis(&DocId::Checkpoints(book.clone()))
}

/// Deterministic genesis of `layout:<book>`.
pub fn layout_genesis(book: &BookId) -> Vec<u8> {
    side_genesis(&DocId::Layout(book.clone()))
}

/// The genesis of a document beside a book, or `None` for any other id.
pub fn genesis(doc: &DocId) -> Option<Vec<u8>> {
    matches!(
        doc,
        DocId::Stats(_) | DocId::Checkpoints(_) | DocId::Layout(_)
    )
    .then(|| side_genesis(doc))
}

fn check_identity(doc: &LoroDoc, id: &DocId) -> Result<()> {
    check_borrowed(doc, id, schema::meta::DOC)?;
    match doc.get_map(schema::side::META).get(schema::meta::DOC) {
        Some(ValueOrContainer::Value(LoroValue::String(value)))
            if value.as_str() == id.to_string() =>
        {
            Ok(())
        }
        Some(ValueOrContainer::Value(LoroValue::String(value))) => Err(DocError::WrongDocument {
            expected: id.clone(),
            found: value.to_string(),
        }),
        _ => Err(DocError::NotInitialized(id.clone())),
    }
}

// ---- writing days --------------------------------------------------------

/// Reads of a `stats:<book>` document.
#[derive(Clone, Copy)]
pub struct StatsView<'a> {
    doc: &'a LoroDoc,
}

impl StatsView<'_> {
    /// Every readable writing day, sorted by day then device. A key that is
    /// not `<device>|<day>`, or a value that is not a non-negative integer,
    /// is skipped and kept.
    pub fn writing_days(&self) -> Vec<WritingDay> {
        let LoroValue::Map(m) = self
            .doc
            .get_map(schema::side::WRITING_DAYS)
            .get_deep_value()
        else {
            return Vec::new();
        };
        let mut v: Vec<WritingDay> = m
            .iter()
            .filter_map(|(k, w)| {
                let (device, day) = WritingDay::parse_key(k)?;
                let words = match w {
                    LoroValue::I64(i) if *i >= 0 => *i,
                    _ => return None,
                };
                Some(WritingDay { device, day, words })
            })
            .collect();
        v.sort_by(|a, b| (&a.day, &a.device).cmp(&(&b.day, &b.device)));
        v
    }

    /// The words of one day, summed over devices.
    pub fn words_on(&self, day: &Day) -> i64 {
        self.writing_days()
            .iter()
            .filter(|w| &w.day == day)
            .map(|w| w.words)
            .sum()
    }

    /// What `device` has stored for `day`, if anything.
    pub fn stored(&self, device: &DeviceKey, day: &Day) -> Option<i64> {
        match self
            .doc
            .get_map(schema::side::WRITING_DAYS)
            .get(&WritingDay::key(device, day))
        {
            Some(ValueOrContainer::Value(LoroValue::I64(i))) if i >= 0 => Some(i),
            _ => None,
        }
    }
}

/// Writes to a `stats:<book>` document. Does not commit.
pub struct StatsTxn<'a> {
    doc: &'a LoroDoc,
}

impl<'a> StatsTxn<'a> {
    pub fn view(&self) -> StatsView<'a> {
        StatsView { doc: self.doc }
    }

    /// One device's words for one day. Each device writes only its own keys;
    /// a negative count is stored as 0.
    pub fn writing_day(&mut self, device: &DeviceKey, day: &Day, words: i64) -> Result<()> {
        self.doc
            .get_map(schema::side::WRITING_DAYS)
            .insert(&WritingDay::key(device, day), words.max(0))?;
        Ok(())
    }
}

// ---- checkpoint manifests ------------------------------------------------

/// Reads of a `checkpoints:<book>` document.
#[derive(Clone, Copy)]
pub struct CheckpointsView<'a> {
    doc: &'a LoroDoc,
}

impl CheckpointsView<'_> {
    /// Every manifest, `(checkpoint id, manifest)`. Manifests are opaque
    /// here: dr-workspace versions and validates them.
    pub fn entry_checkpoints(&self) -> Vec<(String, String)> {
        let LoroValue::Map(m) = self
            .doc
            .get_map(schema::side::ENTRY_CHECKPOINTS)
            .get_deep_value()
        else {
            return Vec::new();
        };
        m.iter()
            .filter_map(|(id, v)| match v {
                LoroValue::String(s) => Some((id.clone(), s.to_string())),
                _ => None,
            })
            .collect()
    }
}

/// Writes to a `checkpoints:<book>` document. Does not commit.
pub struct CheckpointsTxn<'a> {
    doc: &'a LoroDoc,
}

impl<'a> CheckpointsTxn<'a> {
    pub fn view(&self) -> CheckpointsView<'a> {
        CheckpointsView { doc: self.doc }
    }

    /// Append an immutable manifest; an existing id is refused.
    pub fn put_entry_checkpoint(&mut self, id: &str, manifest: &str) -> Result<()> {
        let root = self.doc.get_map(schema::side::ENTRY_CHECKPOINTS);
        if root.get(id).is_some() {
            return Err(DocError::NotInProfile("checkpoint already exists"));
        }
        root.insert(id, manifest)?;
        Ok(())
    }

    /// Remove a manifest chosen by the owner's retention plan. Manifests are
    /// never replaced; the complete history stays in the Loro log.
    pub fn remove_entry_checkpoint(&mut self, id: &str) -> Result<()> {
        self.doc
            .get_map(schema::side::ENTRY_CHECKPOINTS)
            .delete(id)?;
        Ok(())
    }
}

// ---- canvas positions (`layout:<book>`) ----------------------------------

fn decode_coord_num(v: &LoroValue) -> Option<f64> {
    match v {
        LoroValue::Double(d) if d.is_finite() => Some(*d),
        LoroValue::I64(i) => Some(*i as f64),
        _ => None,
    }
}

fn decode_coord_pair(v: &LoroValue) -> Option<(f64, f64)> {
    let LoroValue::List(items) = v else {
        return None;
    };
    if items.len() != 2 {
        return None;
    }
    Some((decode_coord_num(&items[0])?, decode_coord_num(&items[1])?))
}

fn decode_scope_map(v: &LoroValue) -> BTreeMap<EntryId, (f64, f64)> {
    let LoroValue::Map(m) = v else {
        return BTreeMap::new();
    };
    m.iter()
        .filter_map(|(k, val)| Some((EntryId::parse(k).ok()?, decode_coord_pair(val)?)))
        .collect()
}

/// Reads of a `layout:<book>` document.
#[derive(Clone, Copy)]
pub struct LayoutView<'a> {
    doc: &'a LoroDoc,
}

impl LayoutView<'_> {
    /// Positions stored for `<scope>/<mode>`, skipping malformed ids or
    /// non-finite coordinates.
    pub fn positions(&self, scope_mode: &str) -> BTreeMap<EntryId, (f64, f64)> {
        let Some(ValueOrContainer::Container(loro::Container::Map(m))) =
            self.doc.get_map(schema::side::POSITIONS).get(scope_mode)
        else {
            return BTreeMap::new();
        };
        decode_scope_map(&m.get_deep_value())
    }

    /// Every non-empty `<scope>/<mode>` map of valid coordinates.
    pub fn all_positions(&self) -> BTreeMap<String, BTreeMap<EntryId, (f64, f64)>> {
        let LoroValue::Map(m) = self.doc.get_map(schema::side::POSITIONS).get_deep_value() else {
            return BTreeMap::new();
        };
        m.iter()
            .filter_map(|(k, v)| {
                let (scope, mode) = k.split_once('/')?;
                if scope.is_empty() || mode.is_empty() || mode.contains('/') {
                    return None;
                }
                let parsed = decode_scope_map(v);
                (!parsed.is_empty()).then(|| (k.clone(), parsed))
            })
            .collect()
    }
}

/// Writes to a `layout:<book>` document. Does not commit.
pub struct LayoutTxn<'a> {
    doc: &'a LoroDoc,
}

impl<'a> LayoutTxn<'a> {
    pub fn view(&self) -> LayoutView<'a> {
        LayoutView { doc: self.doc }
    }

    /// Set `entry`'s position in `<scope>/<mode>`. Non-finite coordinates are refused.
    pub fn put_position(
        &mut self,
        scope_mode: &str,
        entry: &EntryId,
        x: f64,
        y: f64,
    ) -> Result<()> {
        if !x.is_finite() || !y.is_finite() {
            return Err(DocError::NotInProfile("layout coordinates must be finite"));
        }
        let sub = self
            .doc
            .get_map(schema::side::POSITIONS)
            .ensure_mergeable_map(scope_mode)?;
        sub.insert(
            entry.as_str(),
            LoroValue::List(vec![LoroValue::Double(x), LoroValue::Double(y)].into()),
        )?;
        Ok(())
    }

    /// Remove `entry`'s position from `<scope>/<mode>`.
    pub fn remove_position(&mut self, scope_mode: &str, entry: &EntryId) -> Result<()> {
        let root = self.doc.get_map(schema::side::POSITIONS);
        if root.get(scope_mode).is_some() {
            let sub = root.ensure_mergeable_map(scope_mode)?;
            if sub.get(entry.as_str()).is_some() {
                sub.delete(entry.as_str())?;
            }
        }
        Ok(())
    }

    /// Remove every stored position under `<scope>/<mode>`, one entry at a
    /// time: the canvas itself stays, so a card another device drags onto
    /// it meanwhile survives the merge.
    pub fn clear_scope(&mut self, scope_mode: &str) -> Result<()> {
        let root = self.doc.get_map(schema::side::POSITIONS);
        if let Some(ValueOrContainer::Container(loro::Container::Map(sub))) = root.get(scope_mode) {
            for key in sub.keys().map(|k| k.to_string()).collect::<Vec<_>>() {
                sub.delete(&key)?;
            }
        }
        Ok(())
    }

    /// Drop the coordinates of every entry `gone` names: its own on every
    /// canvas, and every canvas of its own scope (`<entry>/<mode>`). The
    /// scope `root` names no entry. Returns whether anything was removed.
    pub fn forget_entries(&mut self, gone: impl Fn(&EntryId) -> bool) -> Result<bool> {
        let named = |s: &str| EntryId::parse(s).is_ok_and(|id| gone(&id));
        let root = self.doc.get_map(schema::side::POSITIONS);
        let mut removed = false;
        for scope_mode in root.keys().map(|k| k.to_string()).collect::<Vec<_>>() {
            let Some(ValueOrContainer::Container(loro::Container::Map(sub))) =
                root.get(&scope_mode)
            else {
                continue;
            };
            let whole = scope_mode
                .split_once('/')
                .is_some_and(|(scope, _)| scope != "root" && named(scope));
            for key in sub.keys().map(|k| k.to_string()).collect::<Vec<_>>() {
                if whole || named(&key) {
                    sub.delete(&key)?;
                    removed = true;
                }
            }
        }
        Ok(removed)
    }
}

// ---- borrowed and owned documents ---------------------------------------

/// A `stats:<book>` document held by F2. Does not commit.
pub struct BorrowedStats<'a> {
    doc: &'a LoroDoc,
}

impl<'a> BorrowedStats<'a> {
    pub fn new(doc: &'a LoroDoc, book: &BookId) -> Result<Self> {
        check_identity(doc, &DocId::Stats(book.clone()))?;
        Ok(Self { doc })
    }
    pub fn view(&self) -> StatsView<'_> {
        StatsView { doc: self.doc }
    }
    pub fn txn(&self) -> StatsTxn<'_> {
        StatsTxn { doc: self.doc }
    }
}

/// A `checkpoints:<book>` document held by F2. Does not commit.
pub struct BorrowedCheckpoints<'a> {
    doc: &'a LoroDoc,
}

impl<'a> BorrowedCheckpoints<'a> {
    pub fn new(doc: &'a LoroDoc, book: &BookId) -> Result<Self> {
        check_identity(doc, &DocId::Checkpoints(book.clone()))?;
        Ok(Self { doc })
    }
    pub fn view(&self) -> CheckpointsView<'_> {
        CheckpointsView { doc: self.doc }
    }
    pub fn txn(&self) -> CheckpointsTxn<'_> {
        CheckpointsTxn { doc: self.doc }
    }
}

/// A `layout:<book>` document held by F2. Does not commit.
pub struct BorrowedLayout<'a> {
    doc: &'a LoroDoc,
}

impl<'a> BorrowedLayout<'a> {
    pub fn new(doc: &'a LoroDoc, book: &BookId) -> Result<Self> {
        check_identity(doc, &DocId::Layout(book.clone()))?;
        Ok(Self { doc })
    }
    pub fn view(&self) -> LayoutView<'_> {
        LayoutView { doc: self.doc }
    }
    pub fn txn(&self) -> LayoutTxn<'_> {
        LayoutTxn { doc: self.doc }
    }
}

macro_rules! owned {
    ($name:ident, $variant:ident, $view:ident, $txn:ident) => {
        /// One writer of the document (imports, seeds, the aging model);
        /// every edit returns its update for the caller to persist.
        pub struct $name {
            core: Core,
            book: BookId,
        }

        impl $name {
            pub fn create(book: BookId, peer: PeerId) -> Result<Self> {
                Self::load(book, peer, &[])
            }

            pub fn load(book: BookId, peer: PeerId, blobs: &[Vec<u8>]) -> Result<Self> {
                let id = DocId::$variant(book.clone());
                let core = Core::load(
                    id.clone(),
                    &side_genesis(&id),
                    blobs,
                    Some(peer),
                    schema::meta::DOC,
                )?;
                check_identity(&core.doc, &id)?;
                Ok(Self { core, book })
            }

            pub fn book_id(&self) -> &BookId {
                &self.book
            }

            pub fn doc_id(&self) -> &DocId {
                &self.core.id
            }

            pub fn peer(&self) -> PeerId {
                self.core.peer()
            }

            pub fn set_peer(&mut self, peer: PeerId) -> Result<()> {
                self.core.set_peer(peer)
            }

            pub fn view(&self) -> $view<'_> {
                $view {
                    doc: &self.core.doc,
                }
            }

            pub fn edit<R>(
                &mut self,
                origin: Origin,
                f: impl FnOnce(&mut $txn<'_>) -> Result<R>,
            ) -> (Result<R>, Option<Committed>) {
                self.edit_at(origin, None, f)
            }

            pub fn edit_at<R>(
                &mut self,
                origin: Origin,
                timestamp: Option<i64>,
                f: impl FnOnce(&mut $txn<'_>) -> Result<R>,
            ) -> (Result<R>, Option<Committed>) {
                let core = &self.core;
                core.transact(&origin, timestamp, || {
                    let mut txn = $txn { doc: &core.doc };
                    f(&mut txn)
                })
            }

            pub fn import(&mut self, bytes: &[u8], origin: Origin) -> Result<Imported> {
                let pending = self.core.import(bytes, &origin)?;
                Ok(Imported {
                    pending,
                    repair: None,
                })
            }

            pub fn version(&self) -> VersionVector {
                self.core.version()
            }

            pub fn frontiers(&self) -> Frontiers {
                self.core.frontiers()
            }

            pub fn export_updates_since(&self, vv: &VersionVector) -> Result<Vec<u8>> {
                self.core.export_updates_since(vv)
            }

            pub fn export_snapshot(&self) -> Result<Vec<u8>> {
                self.core.export_snapshot()
            }

            /// The underlying document, for a holder that persists it.
            pub fn loro(&self) -> &LoroDoc {
                &self.core.doc
            }
        }
    };
}

owned!(StatsDoc, Stats, StatsView, StatsTxn);
owned!(CheckpointsDoc, Checkpoints, CheckpointsView, CheckpointsTxn);
owned!(LayoutDoc, Layout, LayoutView, LayoutTxn);

#[cfg(test)]
mod tests {
    use super::*;
    use dr_model::id::DocKind;

    fn device(n: &str) -> DeviceKey {
        DeviceKey::from_installation_id(n)
    }

    fn peer(n: u64) -> PeerId {
        n
    }

    #[test]
    fn stats_and_checkpoints_are_neither_prose_nor_the_book() {
        let book = BookId::parse("b1").unwrap();
        for (id, genesis) in [
            (DocId::Stats(book.clone()), stats_genesis(&book)),
            (DocId::Checkpoints(book.clone()), checkpoints_genesis(&book)),
            (DocId::Layout(book.clone()), layout_genesis(&book)),
        ] {
            assert!(!id.kind().is_book_text(), "{id}");
            assert_eq!(id.kind().profile(), None, "{id}");
            assert_ne!(id.kind(), DocKind::Book);
            assert_eq!(id.named_book(), Some(&book));
            // Deterministic: the same bytes on every device.
            assert_eq!(super::genesis(&id), Some(genesis.clone()));
            let doc = configured();
            doc.import(&genesis).unwrap();
            assert!(
                !crate::v3::is_book_doc(&doc),
                "{id} must never read as a book"
            );
        }
        assert_eq!(super::genesis(&DocId::Book(book)), None);
    }

    #[test]
    fn two_devices_create_one_stats_document_and_keep_each_others_days() {
        let book = BookId::parse("b1").unwrap();
        let day = Day::parse("2026-11-13").unwrap();
        let (mac, win) = (device("mac"), device("win"));
        let mut a = StatsDoc::create(book.clone(), peer(1)).unwrap();
        let mut b = StatsDoc::create(book.clone(), peer(2)).unwrap();
        a.edit(Origin::User, |t| t.writing_day(&mac, &day, 300))
            .0
            .unwrap();
        b.edit(Origin::User, |t| t.writing_day(&win, &day, 200))
            .0
            .unwrap();
        let (_, c) = a.edit(Origin::User, |t| t.writing_day(&mac, &day, -5));
        assert!(c.is_some());
        let to_b = a.export_updates_since(&b.version()).unwrap();
        let to_a = b.export_updates_since(&a.version()).unwrap();
        b.import(&to_b, Origin::Sync).unwrap();
        a.import(&to_a, Origin::Sync).unwrap();
        for d in [&a, &b] {
            assert_eq!(
                d.view().words_on(&day),
                200,
                "a negative count is stored as 0"
            );
            assert_eq!(d.view().stored(&mac, &day), Some(0));
            assert_eq!(d.view().writing_days().len(), 2);
            // One genesis: one `meta`, not two.
            assert_eq!(d.loro().get_map(schema::side::META).len(), 2);
        }
    }

    #[test]
    fn checkpoint_manifests_are_written_once_and_removed_by_id() {
        let book = BookId::parse("b1").unwrap();
        let mut d = CheckpointsDoc::create(book.clone(), peer(1)).unwrap();
        d.edit(Origin::User, |t| {
            t.put_entry_checkpoint("p1", "{\"format\":1}")
        })
        .0
        .unwrap();
        assert!(
            d.edit(Origin::User, |t| t.put_entry_checkpoint("p1", "{}"))
                .0
                .is_err()
        );
        assert_eq!(
            d.view().entry_checkpoints(),
            vec![("p1".to_string(), "{\"format\":1}".to_string())]
        );
        d.edit(Origin::User, |t| t.remove_entry_checkpoint("p1"))
            .0
            .unwrap();
        assert!(d.view().entry_checkpoints().is_empty());
    }

    #[test]
    fn a_side_document_refuses_the_bytes_of_another() {
        let a = BookId::parse("a").unwrap();
        let b = BookId::parse("b").unwrap();
        let other = StatsDoc::create(a.clone(), peer(1)).unwrap();
        let bytes = other.export_snapshot().unwrap();
        assert!(StatsDoc::load(b.clone(), peer(2), std::slice::from_ref(&bytes)).is_err());
        assert!(CheckpointsDoc::load(a.clone(), peer(2), &[bytes]).is_err());
        let doc = configured();
        doc.import(&stats_genesis(&a)).unwrap();
        assert!(BorrowedStats::new(&doc, &a).is_ok());
        assert!(BorrowedStats::new(&doc, &b).is_err());
        assert!(BorrowedCheckpoints::new(&doc, &a).is_err());
        assert!(BorrowedLayout::new(&doc, &a).is_err());
    }

    #[test]
    fn two_devices_merge_layout_positions_per_scope_and_mode() {
        let book = BookId::parse("b1").unwrap();
        let e1 = EntryId::parse("e-1").unwrap();
        let e2 = EntryId::parse("e-2").unwrap();
        let mut a = LayoutDoc::create(book.clone(), peer(1)).unwrap();
        let mut b = LayoutDoc::create(book, peer(2)).unwrap();
        a.edit(Origin::User, |t| {
            t.put_position("ideas/board", &e1, 12.5, -4.0)?;
            t.put_position("root/relation_graph", &e1, 100.0, 200.0)
        })
        .0
        .unwrap();
        b.edit(Origin::User, |t| {
            t.put_position("ideas/board", &e2, 48.0, 96.0)
        })
        .0
        .unwrap();
        assert!(
            a.edit(Origin::User, |t| t.put_position(
                "ideas/board",
                &e1,
                f64::NAN,
                0.0
            ))
            .0
            .is_err()
        );
        let to_b = a.export_updates_since(&b.version()).unwrap();
        let to_a = b.export_updates_since(&a.version()).unwrap();
        b.import(&to_b, Origin::Sync).unwrap();
        a.import(&to_a, Origin::Sync).unwrap();
        for d in [&a, &b] {
            let board = d.view().positions("ideas/board");
            assert_eq!(board.get(&e1), Some(&(12.5, -4.0)));
            assert_eq!(board.get(&e2), Some(&(48.0, 96.0)));
            assert_eq!(
                d.view().positions("root/relation_graph").get(&e1),
                Some(&(100.0, 200.0))
            );
            assert_eq!(d.view().all_positions().len(), 2);
        }
        a.edit(Origin::User, |t| t.remove_position("ideas/board", &e1))
            .0
            .unwrap();
        assert_eq!(a.view().positions("ideas/board").len(), 1);
        a.edit(Origin::User, |t| t.clear_scope("ideas/board"))
            .0
            .unwrap();
        assert!(a.view().positions("ideas/board").is_empty());
    }

    /// Clearing a canvas on one device while another drags a card onto it:
    /// the drag survives the merge, the cleared cards stay cleared.
    #[test]
    fn clearing_a_canvas_keeps_another_devices_concurrent_drag() {
        let book = BookId::parse("b1").unwrap();
        let (e1, e2, e3) = (
            EntryId::parse("e-1").unwrap(),
            EntryId::parse("e-2").unwrap(),
            EntryId::parse("e-3").unwrap(),
        );
        let mut a = LayoutDoc::create(book.clone(), peer(1)).unwrap();
        let mut b = LayoutDoc::create(book, peer(2)).unwrap();
        a.edit(Origin::User, |t| {
            t.put_position("ideas/board", &e1, 1.0, 1.0)?;
            t.put_position("ideas/board", &e2, 2.0, 2.0)?;
            t.put_position("ideas/grid", &e1, 9.0, 9.0)
        })
        .0
        .unwrap();
        b.import(&a.export_updates_since(&b.version()).unwrap(), Origin::Sync)
            .unwrap();
        // Offline: A clears the board, B drags a third card onto it.
        a.edit(Origin::User, |t| t.clear_scope("ideas/board"))
            .0
            .unwrap();
        b.edit(Origin::User, |t| {
            t.put_position("ideas/board", &e3, 3.0, 3.0)
        })
        .0
        .unwrap();
        let to_b = a.export_updates_since(&b.version()).unwrap();
        let to_a = b.export_updates_since(&a.version()).unwrap();
        b.import(&to_b, Origin::Sync).unwrap();
        a.import(&to_a, Origin::Sync).unwrap();
        for d in [&a, &b] {
            let board = d.view().positions("ideas/board");
            assert_eq!(
                board.into_iter().collect::<Vec<_>>(),
                [(e3.clone(), (3.0, 3.0))]
            );
            assert_eq!(
                d.view().positions("ideas/grid").get(&e1),
                Some(&(9.0, 9.0)),
                "another canvas is untouched"
            );
        }
    }
}
