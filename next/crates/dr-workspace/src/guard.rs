//! Optional observations for callers that read before they write
//! (`docs/rust-rewrite/foundations/f3-write-guards.md`).
//!
//! A comparison runs inside the owning holder job, before any mutation. A
//! prose document is guarded as a whole, by its version. A book document
//! holds every structural collection of a book, so it is guarded by the
//! records a write depends on: an unrelated write to the same book does not
//! invalidate a pending one. These are per-document guards, not a
//! transaction across several documents.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use dr_doc::v3::{BorrowedBookV3, CollectionV3, RecordKeyV3, RecordReaderV3, RecordStateV3};
use dr_model::DocId;
use dr_model::id::BookId;
use loro::{Frontiers, LoroDoc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::naming::frontiers_from_hex;
use crate::{Result, WsError};

/// Canonical document data and the version it was read at, from one holder
/// read job. `value` is Loro's deep JSON value, not a rich-text serialization.
/// Reading a whole book this way costs as much as its history is long; a
/// caller that only needs to guard a write observes records instead
/// ([`crate::Workspace::observe_records`]).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Observation {
    pub doc: String,
    pub version: String,
    pub value: Value,
}

/// One independently guarded part of a book document.
///
/// `path` walks from the collection's root container: empty is the whole
/// collection, one segment is a record (a map key, or the id of an entry or
/// material folder), further segments select a value inside that record. A
/// shorter path contains every longer one that starts with it.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RecordKey {
    /// A root container of the book document: `entries`, `templates`,
    /// `timeline_views`, `patches`, …
    pub collection: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<String>,
    /// `entries` and `material_folders` only: the ordered resident children
    /// of the node `path` names (empty: the roots) instead of its own state.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub children: bool,
}

impl RecordKey {
    /// A whole root container, for a write derived from a list of it.
    pub fn collection(collection: impl Into<String>) -> Self {
        Self {
            collection: collection.into(),
            path: Vec::new(),
            children: false,
        }
    }

    pub fn record(collection: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            collection: collection.into(),
            path: vec![id.into()],
            children: false,
        }
    }

    /// An entry's own stored state: metadata, module values and residence.
    pub fn entry(id: impl Into<String>) -> Self {
        Self::record("entries", id)
    }

    /// The resident children of a level (`None`: the roots), in order.
    pub fn children_of(parent: Option<&str>) -> Self {
        Self {
            collection: "entries".into(),
            path: parent.map(str::to_owned).into_iter().collect(),
            children: true,
        }
    }

    pub fn template(id: impl Into<String>) -> Self {
        Self::record("templates", id)
    }

    pub fn timeline_view(id: impl Into<String>) -> Self {
        Self::record("timeline_views", id)
    }

    pub fn membership(host: &str, member: &str) -> Self {
        Self::record("memberships", format!("{host}|{member}"))
    }

    pub fn patch(id: impl Into<String>) -> Self {
        Self::record("patches", id)
    }

    pub fn plot_grid(entry: &str, module: &str) -> Self {
        Self::record("plot_grids", format!("{entry}/{module}"))
    }

    /// The same key, deeper: a field of a record, a row of a table.
    pub fn at<S: Into<String>>(mut self, segments: impl IntoIterator<Item = S>) -> Self {
        self.path.extend(segments.into_iter().map(Into::into));
        self
    }

    pub(crate) fn parse(&self) -> Result<RecordKeyV3> {
        let collection = CollectionV3::from_root(&self.collection)
            .ok_or_else(|| WsError::invalid(format!("unknown collection {:?}", self.collection)))?;
        let key = RecordKeyV3 {
            collection,
            path: self.path.clone(),
            children: self.children,
        };
        if !key.is_valid() {
            return Err(WsError::invalid(format!("invalid record key {key}")));
        }
        Ok(key)
    }
}

impl std::fmt::Display for RecordKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.collection)?;
        for segment in &self.path {
            write!(f, "/{segment}")?;
        }
        if self.children {
            f.write_str("/*")?;
        }
        Ok(())
    }
}

impl RecordPrecondition {
    /// How a refusal names this record: `<doc> record <key>`, the text after
    /// `stale observation:` and `read required:` in a conflict.
    pub fn subject(&self) -> String {
        format!("{} record {}", self.doc, self.key)
    }
}

impl From<&RecordKeyV3> for RecordKey {
    fn from(key: &RecordKeyV3) -> Self {
        Self {
            collection: key.collection.root().to_owned(),
            path: key.path.clone(),
            children: key.children,
        }
    }
}

/// The stored state of one record, read in one holder read job.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordObservation {
    /// The book document, `book:<id>`.
    pub doc: String,
    pub key: RecordKey,
    /// Identifies the complete stored state, hidden and retained fields
    /// included. Equal digests mean nothing in the record changed.
    pub digest: String,
    /// The record's plain deep value (`null` when absent), for a caller that
    /// must tell whether a filtered query showed everything that is stored.
    pub value: Value,
}

/// What a caller knows of a record.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Expected {
    /// The digest of an observation: nothing stored in the record changed.
    Digest(String),
    /// The record is one stored value (a plain value or a text; `null`: not
    /// stored) and equals one of these. An edit of a field from the value its
    /// author was shown says `[shown, edited]`: a third value means someone
    /// else changed the field. Never matches a whole record or any other
    /// container.
    AnyOf(Vec<Value>),
}

/// "This record is still as I read it."
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecordPrecondition {
    pub doc: String,
    pub key: RecordKey,
    #[serde(flatten)]
    pub expected: Expected,
}

impl From<RecordObservation> for RecordPrecondition {
    fn from(o: RecordObservation) -> Self {
        Self {
            doc: o.doc,
            key: o.key,
            expected: Expected::Digest(o.digest),
        }
    }
}

/// Preconditions for one registered call. A tool keeps these from its own
/// observations; they are not an alternative source of document content.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WritePreconditions {
    /// Whole-document versions: every prose document the call writes or
    /// derives from, and a book document only for a call that must hold the
    /// whole book still.
    pub versions: HashMap<String, String>,
    /// Records of book documents the call replaces or was derived from.
    #[serde(default)]
    pub records: Vec<RecordPrecondition>,
    /// Refuse a write to a prose document absent from `versions`, and a
    /// replacement in a book document of anything this call has not read (no
    /// record at or above it, and no version of the book). A write that
    /// replaces nothing in a book needs no read of it. Explicit source
    /// dependencies (v3 comment prose) remain required even when this is
    /// false.
    pub require_all: bool,
}

impl Default for WritePreconditions {
    fn default() -> Self {
        Self {
            versions: HashMap::new(),
            records: Vec::new(),
            require_all: true,
        }
    }
}

impl WritePreconditions {
    pub fn from_observations(observations: impl IntoIterator<Item = Observation>) -> Self {
        Self {
            versions: observations
                .into_iter()
                .map(|observation| (observation.doc, observation.version))
                .collect(),
            ..Self::default()
        }
    }

    pub fn from_records(records: impl IntoIterator<Item = RecordObservation>) -> Self {
        Self::default().with_records(records)
    }

    pub fn with_records(mut self, records: impl IntoIterator<Item = RecordObservation>) -> Self {
        self.records.extend(records.into_iter().map(Into::into));
        self
    }

    /// Expect the single value `key` names in book document `doc` to be one
    /// of `values` ([`Expected::AnyOf`]). Needs no observation: a view that
    /// edits a field already holds the value it showed.
    pub fn with_value(
        mut self,
        doc: impl Into<String>,
        key: RecordKey,
        values: impl IntoIterator<Item = Value>,
    ) -> Self {
        self.records.push(RecordPrecondition {
            doc: doc.into(),
            key,
            expected: Expected::AnyOf(values.into_iter().collect()),
        });
        self
    }
}

/// What a book write replaces on the caller's word: every stored value it
/// overwrites with a value from its input, or removes because its input
/// names it. A guarded caller must have read each of them, and that read must
/// still be current. Records a command creates under a fresh id, and
/// consequences it plans itself against the live document, are not listed.
#[derive(Clone, Debug)]
pub(crate) enum Replaces {
    /// No per-record contract: a guarded caller holds the whole document's
    /// version (atomic restores, history).
    Document,
    Records(Vec<RecordKeyV3>),
}

impl Replaces {
    pub(crate) fn nothing() -> Self {
        Self::Records(Vec::new())
    }

    pub(crate) fn record(collection: CollectionV3, id: impl ToString) -> Self {
        Self::Records(vec![RecordKeyV3::record(collection, id.to_string())])
    }

    pub(crate) fn records(keys: impl IntoIterator<Item = RecordKeyV3>) -> Self {
        Self::Records(keys.into_iter().collect())
    }
}

/// The digest of a record's stored state ([`dr_doc::v3::RecordStateV3::raw`]).
pub(crate) fn digest(raw: &Value) -> String {
    let bytes = serde_json::to_vec(raw).expect("JSON values serialize");
    Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Equal as stored values: an integer and the same number as a float are one
/// value (a typed field writes floats; an import may have stored integers).
fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a == b || a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_value(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, a)| b.get(k).is_some_and(|b| same_value(a, b)))
        }
        _ => a == b,
    }
}

fn holds(expected: &Expected, state: &RecordStateV3) -> bool {
    match expected {
        Expected::Digest(expected) => digest(&state.raw) == *expected,
        Expected::AnyOf(values) => state
            .single()
            .is_some_and(|stored| values.iter().any(|value| same_value(stored, value))),
    }
}

/// Observe `keys` of the v3 book document `doc`. Call inside a holder job.
pub(crate) fn observe_records(
    id: &str,
    doc: &LoroDoc,
    book: &BookId,
    keys: &[(RecordKey, RecordKeyV3)],
) -> Result<Vec<RecordObservation>> {
    let borrowed = BorrowedBookV3::new(doc, book)?;
    let view = borrowed.view();
    let mut reader = RecordReaderV3::new(&view);
    Ok(keys
        .iter()
        .map(|(key, parsed)| {
            let state = reader.state(parsed);
            RecordObservation {
                doc: id.to_owned(),
                key: key.clone(),
                digest: digest(&state.raw),
                value: state.value,
            }
        })
        .collect())
}

#[derive(Clone)]
pub(crate) struct Guards(Arc<Parsed>);

struct Parsed {
    versions: Mutex<HashMap<String, Frontiers>>,
    records: HashMap<String, Vec<(RecordKeyV3, Expected)>>,
    require_all: bool,
}

impl Guards {
    pub(crate) fn parse(preconditions: WritePreconditions) -> Result<Self> {
        let canonical = |id: &str| -> Result<DocId> {
            let doc = DocId::parse(id).map_err(|e| WsError::Invalid(e.to_string()))?;
            if doc.to_string() != id {
                return Err(WsError::Invalid("non-canonical document id".into()));
            }
            Ok(doc)
        };
        let mut versions = HashMap::new();
        for (id, encoded) in preconditions.versions {
            canonical(&id)?;
            if !encoded.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(WsError::Invalid("frontiers: not hex".into()));
            }
            versions.insert(id, frontiers_from_hex(&encoded)?);
        }
        let mut records: HashMap<String, Vec<(RecordKeyV3, Expected)>> = HashMap::new();
        for record in preconditions.records {
            if !matches!(canonical(&record.doc)?, DocId::Book(_)) {
                return Err(WsError::Invalid(
                    "record preconditions name a book document".into(),
                ));
            }
            match &record.expected {
                Expected::Digest(d)
                    if d.len() != 64 || !d.bytes().all(|b| b.is_ascii_hexdigit()) =>
                {
                    return Err(WsError::Invalid("record digest: not a digest".into()));
                }
                Expected::AnyOf(values) if values.is_empty() => {
                    return Err(WsError::Invalid("expected values: none given".into()));
                }
                _ => {}
            }
            records
                .entry(record.doc)
                .or_default()
                .push((record.key.parse()?, record.expected));
        }
        Ok(Self(Arc::new(Parsed {
            versions: Mutex::new(versions),
            records,
            require_all: preconditions.require_all,
        })))
    }

    /// A whole-document guard: prose, and the atomic commands on a book.
    pub(crate) fn check(&self, id: &str, doc: &LoroDoc) -> Result<()> {
        match crate::holder::lock(&self.0.versions).get(id) {
            Some(expected) if *expected != doc.oplog_frontiers() => Err(Self::stale(id)),
            None if self.0.require_all => Err(Self::missing(id)),
            _ => Ok(()),
        }
    }

    pub(crate) fn check_required(&self, id: &str, doc: &LoroDoc) -> Result<()> {
        if !crate::holder::lock(&self.0.versions).contains_key(id) {
            return Err(Self::missing(id));
        }
        self.check(id, doc)
    }

    /// A reserved read source is not a write target, but an explicit caller
    /// observation of it must still be honored before deriving new content.
    pub(crate) fn check_if_observed(&self, id: &str, doc: &LoroDoc) -> Result<()> {
        if let Some(expected) = crate::holder::lock(&self.0.versions).get(id)
            && *expected != doc.oplog_frontiers()
        {
            return Err(Self::stale(id));
        }
        Ok(())
    }

    /// Everything the caller said about book document `id` still holds: its
    /// version if it gave one, and every record it named. Returns whether the
    /// whole document was guarded.
    fn check_supplied(&self, id: &str, doc: &LoroDoc, book: &BookId) -> Result<bool> {
        let version = crate::holder::lock(&self.0.versions).get(id).cloned();
        if let Some(expected) = &version
            && *expected != doc.oplog_frontiers()
        {
            return Err(Self::stale(id));
        }
        if let Some(records) = self.0.records.get(id) {
            let borrowed = BorrowedBookV3::new(doc, book)?;
            let view = borrowed.view();
            let mut reader = RecordReaderV3::new(&view);
            for (key, expected) in records {
                if !holds(expected, &reader.state(key)) {
                    return Err(WsError::Conflict(format!(
                        "stale observation: {id} record {key}"
                    )));
                }
            }
        }
        Ok(version.is_some())
    }

    /// The guard of one book write, inside its holder job and before its
    /// first mutation.
    pub(crate) fn check_book(
        &self,
        id: &str,
        doc: &LoroDoc,
        book: &BookId,
        replaces: &Replaces,
    ) -> Result<()> {
        if self.check_supplied(id, doc, book)? || !self.0.require_all {
            return Ok(());
        }
        let supplied = self.0.records.get(id).map(Vec::as_slice).unwrap_or(&[]);
        let Replaces::Records(keys) = replaces else {
            return Err(Self::missing(id));
        };
        match keys
            .iter()
            .find(|key| !supplied.iter().any(|(read, _)| read.contains(key)))
        {
            // Nothing is replaced, or every replaced value was read.
            None => Ok(()),
            Some(_) if supplied.is_empty() => Err(Self::missing(id)),
            Some(key) => Err(WsError::Conflict(format!(
                "read required: {id} record {key}"
            ))),
        }
    }

    /// Before a guarded call registers a new prose document under book `id`:
    /// what the caller said about that book still holds, so a stale call
    /// leaves no document nobody owns.
    pub(crate) fn check_parent(&self, id: &str, doc: &LoroDoc, book: &BookId) -> Result<()> {
        self.check_supplied(id, doc, book).map(drop)
    }

    /// The guard of an atomic multi-document command on one of its reserved
    /// documents. These commands have no per-record contract, but records the
    /// caller named are still compared.
    pub(crate) fn check_atomic(&self, id: &str, doc: &LoroDoc) -> Result<()> {
        if self.0.records.contains_key(id)
            && let Ok(DocId::Book(book)) = DocId::parse(id)
        {
            return if self.check_supplied(id, doc, &book)? || !self.0.require_all {
                Ok(())
            } else {
                Err(Self::missing(id))
            };
        }
        self.check(id, doc)
    }

    /// Only for a document this invocation has just registered. Its first
    /// write may replace genesis, never any pre-existing or intervening edit.
    pub(crate) fn created(&self, id: String, genesis: Frontiers) {
        crate::holder::lock(&self.0.versions)
            .entry(id)
            .or_insert(genesis);
    }

    fn stale(id: &str) -> WsError {
        WsError::Conflict(format!("stale observation: {id}"))
    }

    pub(crate) fn missing(id: &str) -> WsError {
        WsError::Conflict(format!("read required: {id}"))
    }
}
