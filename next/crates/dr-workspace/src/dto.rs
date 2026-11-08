//! What queries return: plain records with JSON Schemas. Ids and open enum
//! values are strings; positions are the stored keys.

use dr_model::book::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A reference to an entity (relation end, comment or memory target).
#[derive(
    Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
pub struct Target {
    /// `node`, `element`, `patch`, `category`, `storyline`, `comment`,
    /// `material`.
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
    pub(crate) fn to_ref(&self) -> EntityRef {
        EntityRef::new(
            dr_model::kind::EntityKind::parse(&self.kind),
            self.id.clone(),
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

impl From<&BookMeta> for BookInfo {
    fn from(m: &BookMeta) -> Self {
        BookInfo {
            id: m.id.to_string(),
            name: m.name.clone(),
            summary: m.summary.clone(),
            trashed: m.deleted_at.is_some(),
            word_target: m.word_target(),
            daily_word_target: m.daily_word_target(),
            created_at: m.created_at.map(|t| t.0),
        }
    }
}

/// A chapter, in reading order.
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct ChapterInfo {
    pub id: String,
    pub title: String,
    pub summary: String,
    /// 1-based position in reading order (live chapters only).
    pub number: Option<u32>,
    pub book_order: Option<f64>,
    pub narrative_order: Option<f64>,
    /// `draft`, `finished` or `discarded`.
    pub status: String,
    /// The act the chapter is in, if any.
    pub act: Option<String>,
    pub storylines: Vec<String>,
    pub primary_storyline: Option<String>,
    pub trashed: bool,
    /// Words in the chapter's prose, as the derived index counts them (0
    /// until dr-index has reached it).
    pub words: u64,
    /// When the chapter was created (Unix seconds).
    pub created_at: Option<i64>,
    /// When the chapter last changed (Unix seconds): its prose's newest
    /// stored change, or its creation if later. The book document keeps no
    /// `updated_at` (simplifications.md 第一节第 13 条), so a new title,
    /// summary or status alone does not move it.
    pub updated_at: Option<i64>,
}

impl ChapterInfo {
    pub(crate) fn of(n: &Node, number: Option<u32>, act: Option<String>) -> Self {
        ChapterInfo {
            id: n.id.to_string(),
            title: n.title.clone(),
            summary: n.summary.clone(),
            number,
            book_order: n.effective_book_order(),
            narrative_order: n.narrative_order,
            status: n.effective_status().as_str().to_string(),
            act,
            storylines: n.storylines.iter().map(|s| s.to_string()).collect(),
            primary_storyline: n.effective_primary_storyline().map(|s| s.to_string()),
            trashed: n.is_trashed(),
            words: 0,
            created_at: n.created_at.map(|t| t.0),
            updated_at: n.created_at.map(|t| t.0),
        }
    }

    /// With what storage knows of its prose ([`crate::commands::ProseFacts`]).
    pub(crate) fn with_prose(mut self, facts: crate::commands::ProseFacts) -> Self {
        self.words = facts.words;
        self.updated_at = self.updated_at.max(facts.edited_at);
        self
    }
}

/// An idea (构想; internal name drift).
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct IdeaInfo {
    pub id: String,
    pub title: String,
    pub summary: String,
    /// `drifting` or `resting`.
    pub status: String,
    pub group: Option<String>,
    pub x: f64,
    pub y: f64,
    pub narrative_order: Option<f64>,
    pub trashed: bool,
}

impl From<&Node> for IdeaInfo {
    fn from(n: &Node) -> Self {
        IdeaInfo {
            id: n.id.to_string(),
            title: n.title.clone(),
            summary: n.summary.clone(),
            status: n.effective_status().as_str().to_string(),
            group: n.group.as_ref().map(|g| g.to_string()),
            x: n.x,
            y: n.y,
            narrative_order: n.narrative_order,
            trashed: n.is_trashed(),
        }
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct ActInfo {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    /// `None`: the book-head act.
    pub start_order: Option<f64>,
    pub drift: Option<String>,
    /// The act's chapters, in reading order.
    pub chapters: Vec<String>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct StorylineInfo {
    pub id: String,
    pub name: String,
    pub color: String,
    pub summary: String,
    pub pos: Option<String>,
    pub trashed: bool,
    /// Live chapters on this storyline.
    pub chapters: u32,
    /// Its fields (key/value), in order.
    pub fields: Vec<FieldInfo>,
    /// Whether it has a chapter template (the body new chapters on it start
    /// with; `chapter_template.body`).
    pub has_chapter_template: bool,
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
pub struct ElementInfo {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub category: Option<String>,
    pub aliases: Vec<String>,
    pub fields: Vec<FieldInfo>,
    pub group_name: Option<String>,
    pub portrait: Option<String>,
    pub relate_pin: Option<(f64, f64)>,
    pub trashed: bool,
    /// When a merge left two live elements with one name: the element that
    /// keeps it (show this one as a conflict to rename).
    pub name_conflict: Option<String>,
    /// Seconds since the epoch.
    pub created_at: Option<i64>,
    /// When it last changed, in seconds: its name, aliases, fields, summary,
    /// category, portrait or pin (stamped by `element.update`), or its body.
    pub updated_at: Option<i64>,
}

impl From<&Element> for ElementInfo {
    fn from(e: &Element) -> Self {
        ElementInfo {
            id: e.id.to_string(),
            name: e.name.clone(),
            summary: e.summary.clone(),
            category: e.category.as_ref().map(|c| c.to_string()),
            aliases: e.aliases.iter().cloned().collect(),
            fields: e.facts.iter().map(FieldInfo::from).collect(),
            group_name: e.group_name.clone(),
            portrait: e.portrait.as_ref().map(|a| a.to_string()),
            relate_pin: e.relate_pin,
            trashed: e.deleted_at.is_some(),
            name_conflict: e.name_conflict.as_ref().map(|c| c.to_string()),
            created_at: e.created_at.map(|t| t.0),
            updated_at: e.created_at.map(|t| t.0),
        }
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct CategoryInfo {
    pub id: String,
    pub name: String,
    pub color: String,
    pub layout: String,
    pub grid_x: Option<i64>,
    pub grid_y: Option<i64>,
    pub trashed: bool,
    /// Live elements in this category.
    pub elements: u32,
    /// The fields its new elements start with (`category_template.*`).
    pub template_fields: Vec<FieldInfo>,
    /// Whether it has an element template (the body its new elements start
    /// with; `category_template.body`).
    pub has_element_template: bool,
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
pub struct RelationTypeInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    /// `directed` or `symmetric`.
    pub orientation: String,
    pub source_role: String,
    pub target_role: String,
    pub source_kinds: Vec<String>,
    pub target_kinds: Vec<String>,
    pub color: Option<String>,
    /// The built-in type (TODO and material links): cannot be changed.
    pub locked: bool,
}

impl From<&RelationType> for RelationTypeInfo {
    fn from(t: &RelationType) -> Self {
        RelationTypeInfo {
            id: t.id.to_string(),
            name: t.name.clone(),
            description: t.description.clone(),
            orientation: t.orientation.as_str().to_string(),
            source_role: t.source_role.clone(),
            target_role: t.target_role.clone(),
            source_kinds: t.source_kinds.iter().map(|k| k.as_str().into()).collect(),
            target_kinds: t.target_kinds.iter().map(|k| k.as_str().into()).collect(),
            color: t.color.clone(),
            locked: t.locked || t.system_key.is_some(),
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
    /// `note` or `todo`.
    pub kind: String,
    pub target: Option<Target>,
    /// The target is in the trash or gone: show as unlocated.
    pub unlocated: bool,
    pub target_block: Option<String>,
    pub anchored: bool,
    pub quote: Option<String>,
    pub body: String,
    /// `open` or `resolved`.
    pub status: String,
    pub priority: Option<String>,
    /// `user`, `ai` or `external`.
    pub author_kind: String,
    pub author_name: Option<String>,
    /// `manual` or `api`.
    pub source: String,
    pub agent_conversation: Option<String>,
    /// Generated from prose (`marker` or `note_task`).
    pub projection: Option<String>,
    /// The rectangle it marks on an image or a PDF page.
    pub region: Option<Region>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
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

impl From<&Comment> for CommentInfo {
    fn from(c: &Comment) -> Self {
        CommentInfo {
            id: c.id.to_string(),
            kind: c.kind.as_str().to_string(),
            target: c.target.as_ref().map(Target::from),
            unlocated: c.target_missing,
            target_block: c.target_block.as_ref().map(|b| b.to_string()),
            anchored: c.anchor.is_some(),
            quote: c.quote.clone(),
            body: c.body.clone(),
            status: c.status.as_str().to_string(),
            priority: c.priority.as_ref().map(|p| p.as_str().to_string()),
            author_kind: c.author_kind.as_str().to_string(),
            author_name: c.author_name.clone(),
            source: c.source.as_str().to_string(),
            agent_conversation: c.agent_conversation.clone(),
            projection: c.projection.as_ref().map(|p| p.kind.as_str().to_string()),
            region: c.region.as_ref().map(Region::from),
            created_at: c.created_at.map(|t| t.0),
            updated_at: c.updated_at.map(|t| t.0),
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
    /// `note` or `todo`.
    pub kind: String,
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
