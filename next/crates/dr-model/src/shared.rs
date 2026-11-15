//! Shared canonical records and codecs, independent of source-format books.

use serde::{Deserialize, Serialize};

use crate::id::*;
use crate::kind::*;
use crate::pos::{PosKey, cmp_pos};
use crate::time::{Day, Timestamp};

/// A reference to any entity: a relation end, a comment or memory target.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct EntityRef {
    pub kind: EntityKind,
    pub id: String,
}

/// A position anchor as stored: two encoded Loro cursors (decision D4). The
/// bytes are opaque here; `dr-doc` decodes and resolves them against the
/// prose document the owning entity points at.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EncodedAnchor {
    pub start: Vec<u8>,
    pub end: Vec<u8>,
}

/// One entry of a key/value list (element fields, storyline fields, category
/// template fields, project facts, the storyline template). Lists are sorted
/// by position key, ties by entry id; an entry without a usable key sorts
/// last.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KvEntry {
    pub id: KvEntryId,
    pub key: String,
    pub value: String,
    pub pos: Option<PosKey>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Relation {
    pub id: RelationId,
    pub from: EntityRef,
    pub to: EntityRef,
    pub relation_type: RelationTypeId,
    pub created_at: Option<Timestamp>,
}

/// A row or column of a plot grid.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlotLine<Id> {
    pub id: Id,
    /// Fractional-index key (the old `position_key`); sorted bytewise, ties
    /// by id, a missing one last.
    pub pos: Option<PosKey>,
    pub label: String,
}

/// One block's text when a comment was made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockSnapshot {
    pub block: Option<BlockId>,
    pub text: String,
}

/// A rectangle on an image, or on one page of a PDF, as fractions (0–1) of
/// the media box, so it survives display size and zoom (the old
/// `MaterialRegion`, v1).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct MaterialRegion {
    /// 1-based PDF page; `None` for images.
    pub page: Option<u32>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Where a generated TODO came from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoProjection {
    pub kind: ProjectionKind,
    /// The block of the marker or the task line.
    pub block: BlockId,
}

/// An asset's record in the project's built-in asset library (`assets` in the
/// book document, `kernel-v5.md` §6 & §10).
/// The bytes are in SQLite / files, addressed by sha256; the binary identity is
/// written once, while `name`, `folder`, and `deleted_at` manage library state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Asset {
    pub id: AssetId,
    #[serde(default)]
    pub name: String,
    pub kind: AssetKind,
    pub mime: String,
    pub size: i64,
    /// Lowercase hex, 64 characters.
    pub sha256: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    /// When the file was added to the asset library.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<Timestamp>,
    /// The asset-library folder (素材夹) it is in (`None`: the top).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<AssetFolderId>,
    /// Its place among the files of its folder (manual order).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<PosKey>,
    /// Set when trashed from the asset library; bytes stay until purged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<Timestamp>,
    /// The folder whose trashing took it to Recently Deleted (restoring that
    /// folder brings it back); `None` when it was trashed on its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trashed_with: Option<AssetFolderId>,
}

/// A folder (素材夹) of the asset library (`asset_folders`, `kernel-v5.md`
/// §6 & §10): folders nest, in manual order. Trashing one trashes what is in
/// it in the same commit, each marked `trashed_with` that folder, which is
/// how restoring the folder knows what went with it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetFolder {
    pub id: AssetFolderId,
    pub name: String,
    /// The folder it is in (`None`: the top of the library).
    #[serde(default)]
    pub parent: Option<AssetFolderId>,
    #[serde(default)]
    pub pos: Option<PosKey>,
    #[serde(default)]
    pub deleted_at: Option<Timestamp>,
    /// The folder whose trashing took it to Recently Deleted (`None`: it was
    /// trashed on its own, or is live).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trashed_with: Option<AssetFolderId>,
}

impl AssetFolder {
    pub fn is_trashed(&self) -> bool {
        self.deleted_at.is_some()
    }
}

/// Sort asset folders (or files) of one folder by position key, ties by id.
pub fn sort_asset_folders(folders: &mut [AssetFolder]) {
    folders.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)));
}

impl Asset {
    /// Whether `other` describes the exact same binary file under the same id
    /// (`AST-IMMUTABLE`).
    pub fn same_file(&self, other: &Self) -> bool {
        self.id == other.id
            && self.kind == other.kind
            && self.mime == other.mime
            && self.size == other.size
            && self.sha256 == other.sha256
            && self.width == other.width
            && self.height == other.height
    }

    pub fn is_trashed(&self) -> bool {
        self.deleted_at.is_some()
    }
}

/// A Project Memory entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Memory {
    pub id: MemoryId,
    pub kind: MemoryKind,
    pub body: String,
    pub target: Option<EntityRef>,
    pub target_block: Option<BlockId>,
    pub source: MemorySource,
    pub origin_ref: Option<String>,
    pub status: MemoryStatus,
    pub supersedes: Option<MemoryId>,
    pub deleted_at: Option<Timestamp>,
}

/// Words one device added to the book on one day of its own calendar. A
/// day's total is the sum over devices; each device writes only its own key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WritingDay {
    pub device: DeviceKey,
    pub day: Day,
    pub words: i64,
}

impl EntityRef {
    pub fn new(kind: EntityKind, id: impl Into<String>) -> Self {
        Self {
            kind,
            id: id.into(),
        }
    }
}

impl MaterialRegion {
    /// `None` unless the rectangle lies inside the box (the old
    /// `parseMaterialRegion`: each value 0–1, x + w and y + h at most 1,
    /// page ≥ 1).
    pub fn new(page: Option<u32>, x: f64, y: f64, w: f64, h: f64) -> Option<Self> {
        let unit = |v: f64| v.is_finite() && (0.0..=1.0).contains(&v);
        if !(unit(x) && unit(y) && unit(w) && unit(h)) || x + w > 1.000001 || y + h > 1.000001 {
            return None;
        }
        if page == Some(0) {
            return None;
        }
        Some(Self { page, x, y, w, h })
    }
}

impl WritingDay {
    /// The key in `writing_days`: `"<device>|<date>"`.
    pub fn key(device: &DeviceKey, day: &Day) -> String {
        format!("{}|{}", device.as_str(), day.as_str())
    }

    /// Split a `writing_days` key; `None` for a malformed one.
    pub fn parse_key(key: &str) -> Option<(DeviceKey, Day)> {
        let (d, day) = key.split_once('|')?;
        Some((DeviceKey::parse(d).ok()?, Day::parse(day)?))
    }
}

/// Sort a key/value list the way every reader shows it.
pub fn sort_kv(entries: &mut [KvEntry]) {
    entries.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)));
}

/// The key element names and aliases are compared by: trimmed, lowercased
/// (the old `findElementNameConflict`). Empty names never conflict.
pub fn element_name_key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Normalize a relation-type name the way uniqueness is judged, exactly as
/// the old `normalizeRelationTypeName`: trimmed, ASCII letters lowercased
/// (SQLite's `lower()` is ASCII-only, so the old data was normalized that
/// way; other letters keep their case).
pub fn normalize_relation_type_name(name: &str) -> String {
    name.trim().to_ascii_lowercase()
}

/// Canonical endpoint order of a symmetric relation: the smaller (kind, id)
/// first, so the same pair is stored one way on every device.
pub fn canonical_symmetric(a: EntityRef, b: EntityRef) -> (EntityRef, EntityRef) {
    let ka = (a.kind.as_str().to_string(), a.id.clone());
    let kb = (b.kind.as_str().to_string(), b.id.clone());
    if ka <= kb { (a, b) } else { (b, a) }
}

/// Whether `s` is a lowercase 64-character hex sha256.
pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub const DEFAULT_WORD_TARGET: i64 = 120_000;

pub const DEFAULT_DAILY_WORD_TARGET: i64 = 1_500;

pub const PLOT_CELL_W: std::ops::RangeInclusive<f64> = 120.0..=440.0;

pub const PLOT_CELL_H: std::ops::RangeInclusive<f64> = 56.0..=380.0;

pub const PLOT_DEFAULT_CELL: (f64, f64) = (184.0, 96.0);

pub const PLOT_DEFAULT_LINES: usize = 3;
