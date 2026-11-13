//! What queries return: plain records with JSON Schemas. Ids and open enum
//! values are strings; positions are the stored keys.

use dr_model::shared::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A reference to an entity (relation end, comment or memory target).
#[derive(
    Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
pub struct Target {
    /// Canonical `entry`, `patch`, `comment` or `material`.
    pub kind: String,
    pub id: String,
}

impl From<&EntityRef> for Target {
    fn from(r: &EntityRef) -> Self {
        Target {
            kind: r.kind.as_str().to_string(),
            id: r.id.clone(),
        }
    }
}

impl From<&dr_text::autolink::LinkTarget> for Target {
    fn from(t: &dr_text::autolink::LinkTarget) -> Self {
        Target {
            kind: t.kind.as_str().to_string(),
            id: t.id.clone(),
        }
    }
}

impl Target {
    pub fn to_ref(&self) -> EntityRef {
        EntityRef::new(
            dr_model::kind::EntityKind::from(self.kind.as_str()),
            &self.id,
        )
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct BookInfo {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub trashed: bool,
    /// The book's word target (`None`: turned off).
    pub word_target: Option<i64>,
    pub daily_word_target: Option<i64>,
    /// When the book was created (Unix seconds).
    pub created_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct FieldInfo {
    pub id: String,
    pub key: String,
    pub value: String,
    pub pos: Option<String>,
}

impl From<&KvEntry> for FieldInfo {
    fn from(e: &KvEntry) -> Self {
        FieldInfo {
            id: e.id.to_string(),
            key: e.key.clone(),
            value: e.value.clone(),
            pos: e.pos.as_ref().map(|p| p.to_string()),
        }
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct RelationInfo {
    pub id: String,
    pub from: Target,
    pub to: Target,
    pub relation_type: String,
}

impl From<&Relation> for RelationInfo {
    fn from(r: &Relation) -> Self {
        RelationInfo {
            id: r.id.to_string(),
            from: (&r.from).into(),
            to: (&r.to).into(),
            relation_type: r.relation_type.to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct GroupInfo {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub parent: Option<String>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct CommentInfo {
    pub id: String,
    pub target: Option<Target>,
    pub module: Option<String>,
    pub part: Option<CommentPartDto>,
    /// The target or module sub-part is in the trash or gone: show as unlocated.
    pub unlocated: bool,
    pub target_block: Option<String>,
    pub anchored: bool,
    pub quote: Option<String>,
    pub body: String,
    /// `open` or `resolved`.
    pub status: String,
    pub priority: Option<String>,
    /// `manual`, `marker`, `task`, `agent` or `reader`.
    pub origin: String,
    /// `user`, `ai` or `external`.
    pub author_kind: String,
    pub author_name: Option<String>,
    /// `manual` or `api`.
    pub source: String,
    pub agent_conversation: Option<String>,
    /// Generated from prose (`marker` or `note_task`).
    pub projection: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

impl CommentInfo {
    /// Image or PDF rectangle carried by `part`, if any.
    pub fn region(&self) -> Option<&Region> {
        self.part.as_ref().and_then(CommentPartDto::region)
    }
}

/// Where inside `module` a comment sits (`part` in schema v5).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[schemars(rename = "CommentPart")]
pub enum CommentPartDto {
    /// An embedded file inside a `prose` module, optionally with a region on it.
    Embed {
        embed: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        region: Option<Region>,
    },
    /// A field definition inside a `fields` module.
    Field { field: String },
    /// A row inside a `key_value` module.
    KvRow { row: String },
    /// A cell inside a `plot_grid` module.
    PlotCell { row: String, col: String },
    /// A patch inside a `patches` module.
    Patch { patch: String },
    /// A file inside a `media` module, optionally with a region on the image or PDF page.
    Media {
        item: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        region: Option<Region>,
    },
    /// Region on an image or PDF material (transitional until Step 4).
    Region { region: Region },
}

impl CommentPartDto {
    pub fn region(&self) -> Option<&Region> {
        match self {
            Self::Embed { region, .. } | Self::Media { region, .. } => region.as_ref(),
            Self::Region { region } => Some(region),
            _ => None,
        }
    }

    pub fn to_model(&self) -> crate::Result<dr_model::v3::CommentPart> {
        use crate::commands::pid;
        use dr_model::v3::CommentPart;
        let to_reg = |r: &Region| {
            r.to_model().ok_or_else(|| {
                crate::WsError::invalid("the region does not fit its picture or page")
            })
        };
        Ok(match self {
            Self::Embed { embed, region } => CommentPart::Embed {
                embed: pid("embed", embed)?,
                region: region.as_ref().map(to_reg).transpose()?,
            },
            Self::Field { field } => {
                if field.trim().is_empty() {
                    return Err(crate::WsError::invalid("field id cannot be empty"));
                }
                CommentPart::Field {
                    field: field.clone(),
                }
            }
            Self::KvRow { row } => CommentPart::KvRow {
                row: pid("kv_row", row)?,
            },
            Self::PlotCell { row, col } => CommentPart::PlotCell {
                row: pid("plot_row", row)?,
                col: pid("plot_col", col)?,
            },
            Self::Patch { patch } => CommentPart::Patch {
                patch: pid("patch", patch)?,
            },
            Self::Media { item, region } => CommentPart::Media {
                item: pid("media_item", item)?,
                region: region.as_ref().map(to_reg).transpose()?,
            },
            Self::Region { region } => CommentPart::Region {
                region: to_reg(region)?,
            },
        })
    }
}

impl From<&dr_model::v3::CommentPart> for CommentPartDto {
    fn from(p: &dr_model::v3::CommentPart) -> Self {
        use dr_model::v3::CommentPart;
        match p {
            CommentPart::Embed { embed, region } => Self::Embed {
                embed: embed.to_string(),
                region: region.as_ref().map(Region::from),
            },
            CommentPart::Field { field } => Self::Field {
                field: field.clone(),
            },
            CommentPart::KvRow { row } => Self::KvRow {
                row: row.to_string(),
            },
            CommentPart::PlotCell { row, col } => Self::PlotCell {
                row: row.to_string(),
                col: col.to_string(),
            },
            CommentPart::Patch { patch } => Self::Patch {
                patch: patch.to_string(),
            },
            CommentPart::Media { item, region } => Self::Media {
                item: item.to_string(),
                region: region.as_ref().map(Region::from),
            },
            CommentPart::Region { region } => Self::Region {
                region: Region::from(region),
            },
        }
    }
}

/// A rectangle on an image, or on one page of a PDF, as fractions (0–1) of
/// the picture or the page, so it stays put at any size and zoom.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Region {
    /// The PDF page, from 1; omitted on an image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Region {
    /// The model's region; `None` unless it lies inside the box.
    pub fn to_model(&self) -> Option<MaterialRegion> {
        MaterialRegion::new(self.page, self.x, self.y, self.w, self.h)
    }
}

impl From<&MaterialRegion> for Region {
    fn from(r: &MaterialRegion) -> Self {
        Region {
            page: r.page,
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
        }
    }
}

/// A comment's anchor as stored: the two Loro cursors dr-doc writes
/// (`Cursor::encode()`, the start on the first anchored character, the end
/// on the last), each in base64 (standard alphabet, padded). The editor
/// moves these bytes between the book and the prose document unchanged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AnchorBytes {
    pub start: String,
    pub end: String,
}

impl From<&EncodedAnchor> for AnchorBytes {
    fn from(a: &EncodedAnchor) -> Self {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        AnchorBytes {
            start: b64.encode(&a.start),
            end: b64.encode(&a.end),
        }
    }
}

impl AnchorBytes {
    /// The bytes; `None` when either half is not base64.
    pub fn bytes(&self) -> Option<EncodedAnchor> {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        Some(EncodedAnchor {
            start: b64.decode(&self.start).ok()?,
            end: b64.decode(&self.end).ok()?,
        })
    }
}

/// One anchored comment, for an editor laying anchors out.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct CommentAnchor {
    pub id: String,
    /// `manual`, `marker`, `task`, `agent` or `reader`.
    pub origin: String,
    /// `open` or `resolved`.
    pub status: String,
    pub anchor: AnchorBytes,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct MaterialInfo {
    pub id: String,
    pub title: String,
    /// `image`, `pdf` or `text`.
    pub kind: String,
    pub asset: Option<String>,
    pub folder: Option<String>,
    pub pos: Option<String>,
    pub task_todos: bool,
    pub description: String,
}

impl From<&Material> for MaterialInfo {
    fn from(m: &Material) -> Self {
        MaterialInfo {
            id: m.id.to_string(),
            title: m.title.clone(),
            kind: m.kind.as_str().to_string(),
            asset: m.asset.as_ref().map(|a| a.to_string()),
            folder: m.folder.as_ref().map(|f| f.to_string()),
            pos: m.pos.as_ref().map(|p| p.to_string()),
            task_todos: m.task_todos,
            description: m.description.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct MemoryInfo {
    pub id: String,
    /// `preference`, `veto` or `directive`.
    pub kind: String,
    pub body: String,
    pub target: Option<Target>,
    pub source: String,
    /// `active`, … as stored.
    pub status: String,
    pub supersedes: Option<String>,
    pub removed: bool,
}

impl From<&Memory> for MemoryInfo {
    fn from(m: &Memory) -> Self {
        MemoryInfo {
            id: m.id.to_string(),
            kind: m.kind.as_str().to_string(),
            body: m.body.clone(),
            target: m.target.as_ref().map(Target::from),
            source: m.source.as_str().to_string(),
            status: m.status.as_str().to_string(),
            supersedes: m.supersedes.as_ref().map(|s| s.to_string()),
            removed: m.deleted_at.is_some(),
        }
    }
}

impl BookInfo {
    pub fn from_book(m: &dr_model::v3::BookMetaV3, p: &dr_model::v3::ProjectDefinition) -> Self {
        BookInfo {
            id: m.id.to_string(),
            name: m.name.clone(),
            summary: m.summary.clone(),
            trashed: m.deleted_at.is_some(),
            word_target: p.word_target(),
            daily_word_target: p.daily_word_target(),
            created_at: m.created_at.map(|t| t.0),
        }
    }
}
