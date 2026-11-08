//! Domain ids and document ids.
//!
//! Every entity id is a string. New ids are uuidv7 (as in the old client), but
//! imported data keeps whatever string the old library used, and a few ids are
//! derived on purpose (the built-in relation type `rt-generic:<book>`, block
//! ids `"<counter>@<peer>"`). So an id type only promises a non-empty string
//! without control characters; [`is_uuid_v7`] tells the two apart when it
//! matters.
//!
//! Ids compare as UTF-8 bytes, like the old `compareIdsUtf8Bytewise`: order
//! ties (equal `book_order`) are broken by id, and every device must agree.

use std::borrow::Borrow;
use std::fmt;
use std::str::FromStr;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// Longest id accepted, in bytes. Old ids are 36-byte uuids; derived ids are a
/// few dozen bytes. The limit only stops garbage from becoming a map key.
pub const MAX_ID_LEN: usize = 256;

/// Why a string is not an id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IdError {
    Empty,
    TooLong(usize),
    /// A control character or a character this id type reserves as a
    /// separator (for example `|` in a device key).
    BadChar(char),
}

impl fmt::Display for IdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IdError::Empty => write!(f, "empty id"),
            IdError::TooLong(n) => write!(f, "id is {n} bytes, longer than {MAX_ID_LEN}"),
            IdError::BadChar(c) => write!(f, "id contains {c:?}"),
        }
    }
}

impl std::error::Error for IdError {}

fn validate(s: &str, reserved: &[char]) -> Result<(), IdError> {
    if s.is_empty() {
        return Err(IdError::Empty);
    }
    if s.len() > MAX_ID_LEN {
        return Err(IdError::TooLong(s.len()));
    }
    if let Some(c) = s.chars().find(|c| c.is_control() || reserved.contains(c)) {
        return Err(IdError::BadChar(c));
    }
    Ok(())
}

/// The rules every id follows (non-empty, at most [`MAX_ID_LEN`] bytes, no
/// control characters), for identities that are not one of the id types
/// here: a conversation entry's event id, session and kind.
pub fn check_id(s: &str) -> Result<(), IdError> {
    validate(s, &[])
}

/// Whether `s` is a uuid of version 7 (what new ids are).
pub fn is_uuid_v7(s: &str) -> bool {
    uuid::Uuid::try_parse(s).is_ok_and(|u| u.get_version_num() == 7)
}

/// A fresh uuidv7 string. Monotonic within the process.
pub fn new_uuid_v7() -> String {
    uuid::Uuid::now_v7().as_hyphenated().to_string()
}

macro_rules! id_type {
    ($(#[$meta:meta])* $name:ident $(, reserved = [$($r:literal),*])?) => {
        $(#[$meta])*
        #[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(Arc<str>);

        impl $name {
            const RESERVED: &'static [char] = &[$($($r),*)?];

            /// A new uuidv7 id.
            pub fn new_v7() -> Self {
                Self(new_uuid_v7().into())
            }

            /// Validate and wrap `s`.
            pub fn parse(s: &str) -> Result<Self, IdError> {
                validate(s, Self::RESERVED)?;
                Ok(Self(s.into()))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({:?})", stringify!($name), &*self.0)
            }
        }

        impl FromStr for $name {
            type Err = IdError;
            fn from_str(s: &str) -> Result<Self, IdError> {
                Self::parse(s)
            }
        }

        impl TryFrom<String> for $name {
            type Error = IdError;
            fn try_from(s: String) -> Result<Self, IdError> {
                Self::parse(&s)
            }
        }

        impl TryFrom<&str> for $name {
            type Error = IdError;
            fn try_from(s: &str) -> Result<Self, IdError> {
                Self::parse(s)
            }
        }

        impl From<$name> for String {
            fn from(id: $name) -> String {
                id.0.to_string()
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl Borrow<str> for $name {
            fn borrow(&self) -> &str {
                &self.0
            }
        }
    };
}

id_type!(
    /// A book (the old `project`).
    BookId
);
id_type!(
    /// A chapter or an idea (构想, internal name drift): the old `book_node`.
    NodeId
);
id_type!(
    /// An act (幕): a boundary on the book-order axis.
    ActId
);
id_type!(StorylineId);
id_type!(
    /// A synchronized Agent conversation (`conversation:<id>`).
    ConversationId
);
id_type!(
    /// An element category (分类).
    CategoryId
);
id_type!(
    /// An element (要素).
    ElementId
);
id_type!(
    /// An element patch: a passage of a chapter attached to an element.
    PatchId
);
id_type!(RelationTypeId);
id_type!(RelationId);
id_type!(
    /// A time pin (时间钉) on the narrative axis: the old `timeline_marker`.
    TimePinId
);
id_type!(
    /// A comment or a TODO (both live in `comments`; a TODO is a comment of
    /// kind `todo`).
    CommentId
);
id_type!(
    /// A material (素材): the old `library_item`.
    MaterialId
);
id_type!(
    /// An asset: the bytes of an image or a PDF (stored outside Loro).
    AssetId
);
id_type!(
    /// An idea group (构想分组): a node of the `drift_groups` tree.
    DriftGroupId
);
id_type!(
    /// A material folder (素材夹): a node of the `material_folders` tree.
    MaterialFolderId
);
id_type!(
    /// An entry of a key/value list: element fields, storyline fields, category
    /// template fields, project facts and the storyline template.
    KvEntryId
);
id_type!(
    /// A Project Memory entry.
    MemoryId
);
id_type!(
    /// A table or material embed inside a prose document (`embeds` map).
    EmbedId
);
id_type!(
    /// The owner of a body template (`template:` document): `category:<id>`
    /// for a category's element template, `storyline:<id>` for a
    /// storyline's chapter template. One template per owner, so the id is
    /// derived from it ([`TemplateId::for_category`],
    /// [`TemplateId::for_storyline`]) and two devices creating the same
    /// template write one document.
    TemplateId
);
id_type!(
    /// A paragraph's identity: `"<counter>@<peer>"` for paragraphs written by
    /// the new version (the op id of the paragraph's own newline), the old
    /// uuid for imported ones, with a `/<n>` suffix after a repair.
    BlockId
);
id_type!(
    /// A plot-grid row. `/` is reserved: cells are keyed `"<row>/<column>"`.
    PlotRowId,
    reserved = ['/']
);
id_type!(
    /// A plot-grid column. `/` is reserved: cells are keyed `"<row>/<column>"`.
    PlotColId,
    reserved = ['/']
);
id_type!(
    /// The device a writing day was counted on. `|` is reserved: writing days
    /// are keyed `"<device>|<date>"`.
    DeviceKey,
    reserved = ['|']
);

impl CommentId {
    /// The id of a TODO generated from prose: a function of what generated
    /// it, the document and the block, so two devices projecting the same
    /// marker create the same entity and nothing needs deduplicating.
    pub fn for_projection(
        kind: &crate::kind::ProjectionKind,
        doc: &DocId,
        block: &BlockId,
    ) -> Self {
        Self::parse(&format!("todo:{}:{doc}#{block}", kind.as_str())).expect("valid id")
    }
}

/// The id of default line `n` (1, 2, 3) of a plot grid: `<chapter>:r<n>` for
/// a row, `<chapter>:c<n>` for a column. Every device that creates the grid
/// writes these same lines (`dr_doc`'s `BookTxn::create_plot_grid`), so two
/// devices creating it before they sync get one 3 × 3 grid, not 6 × 6. A
/// `/` in the chapter id (never in a uuid) is written `%2F`; an id that would
/// be too long uses a hash of the chapter id instead.
fn default_plot_line(chapter: &NodeId, axis: char, n: usize) -> String {
    let s = format!("{}:{axis}{n}", chapter.as_str().replace('/', "%2F"));
    if s.len() <= MAX_ID_LEN {
        return s;
    }
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(chapter.as_str().as_bytes());
    let hex: String = hash[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!("{hex}:{axis}{n}")
}

impl PlotRowId {
    /// Default row `n` (1-based) of `chapter`'s plot grid.
    pub fn default_for(chapter: &NodeId, n: usize) -> Self {
        Self::parse(&default_plot_line(chapter, 'r', n)).expect("valid id")
    }
}

impl PlotColId {
    /// Default column `n` (1-based) of `chapter`'s plot grid.
    pub fn default_for(chapter: &NodeId, n: usize) -> Self {
        Self::parse(&default_plot_line(chapter, 'c', n)).expect("valid id")
    }
}

/// What a body template belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum TemplateOwner {
    /// The template new elements of this category start from (the old
    /// `element_category.element_template`).
    Category(CategoryId),
    /// The template new chapters of this storyline start from (the old
    /// `storylines.chapter_template`).
    Storyline(StorylineId),
}

impl TemplateId {
    pub fn for_category(id: &CategoryId) -> Self {
        Self::parse(&format!("category:{id}")).expect("valid id")
    }

    pub fn for_storyline(id: &StorylineId) -> Self {
        Self::parse(&format!("storyline:{id}")).expect("valid id")
    }

    /// Whose template this is; `None` for an id this version does not know.
    pub fn owner(&self) -> Option<TemplateOwner> {
        let (kind, id) = self.as_str().split_once(':')?;
        match kind {
            "category" => CategoryId::parse(id).ok().map(TemplateOwner::Category),
            "storyline" => StorylineId::parse(id).ok().map(TemplateOwner::Storyline),
            _ => None,
        }
    }
}

impl TemplateOwner {
    /// The template document's id.
    pub fn doc_id(&self) -> DocId {
        DocId::Template(match self {
            TemplateOwner::Category(c) => TemplateId::for_category(c),
            TemplateOwner::Storyline(s) => TemplateId::for_storyline(s),
        })
    }
}

impl DeviceKey {
    /// The key a device signs its writing days with, exactly as the old
    /// client (`services/writing-days/device-key.ts`): `device-` and the
    /// first 12 bytes, in hex, of SHA-256 over
    /// `"drifting.writing-day.v1\n" + installation id`. The synced rows name
    /// the device without carrying its identity. Storage (F2) owns the
    /// installation identity file.
    pub fn from_installation_id(installation_id: &str) -> Self {
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(format!("drifting.writing-day.v1\n{installation_id}").as_bytes());
        let hex: String = hash[..12].iter().map(|b| format!("{b:02x}")).collect();
        Self::parse(&format!("device-{hex}")).expect("valid id")
    }
}

/// Which kind of Loro document a [`DocId`] names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocKind {
    Book,
    Node,
    Element,
    Storyline,
    Category,
    Material,
    /// A body template (`template:category:<id>` / `template:storyline:<id>`).
    Template,
    /// An append-only Agent conversation, separate from prose.
    Conversation,
}

impl DocKind {
    pub const ALL: [DocKind; 8] = [
        DocKind::Book,
        DocKind::Node,
        DocKind::Element,
        DocKind::Storyline,
        DocKind::Category,
        DocKind::Material,
        DocKind::Template,
        DocKind::Conversation,
    ];

    /// The prefix of the document id (`book`, `node`, …).
    pub fn prefix(self) -> &'static str {
        match self {
            DocKind::Book => "book",
            DocKind::Node => "node",
            DocKind::Element => "element",
            DocKind::Storyline => "storyline",
            DocKind::Category => "category",
            DocKind::Material => "material",
            DocKind::Template => "template",
            DocKind::Conversation => "conversation",
        }
    }

    /// Whether the document's text is part of the book: searched, counted,
    /// exported, mirrored. Book and conversation documents have no prose, and a template is
    /// not the book's text: it is copied into new chapters and elements.
    pub fn is_book_text(self) -> bool {
        !matches!(
            self,
            DocKind::Book | DocKind::Template | DocKind::Conversation
        )
    }

    /// The editing profile of a prose document of this kind; `None` for the
    /// book or conversation document. Material notes use the note profile, everything else
    /// the prose profile (as the old `editor-schema-profile.ts`: the profile
    /// follows the document, not the view); templates the prose profile of
    /// the chapters and elements made from them.
    pub fn profile(self) -> Option<ProseProfile> {
        match self {
            DocKind::Book | DocKind::Conversation => None,
            DocKind::Material => Some(ProseProfile::Note),
            _ => Some(ProseProfile::Prose),
        }
    }
}

/// Which block attributes and inline marks a prose document may carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProseProfile {
    /// Chapters, ideas, element bodies, storyline and category descriptions.
    Prose,
    /// Material notes: adds lists, tasks, code blocks, callouts, highlight and
    /// inline code.
    Note,
}

/// The id of a Loro document: `book:<id>` for the book (catalog) document,
/// `node:<id>` / `element:<id>` / `storyline:<id>` / `category:<id>` /
/// `material:<id>` for prose documents, `template:category:<id>` /
/// `template:storyline:<id>` for body templates, `conversation:<id>` for
/// append-only Agent conversation content. The string form is what
/// storage keys documents by.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum DocId {
    Book(BookId),
    Node(NodeId),
    Element(ElementId),
    Storyline(StorylineId),
    Category(CategoryId),
    Material(MaterialId),
    Template(TemplateId),
    Conversation(ConversationId),
}

/// Why a string is not a document id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DocIdError {
    MissingPrefix,
    UnknownPrefix(String),
    Id(IdError),
}

impl fmt::Display for DocIdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DocIdError::MissingPrefix => write!(f, "document id has no `<kind>:` prefix"),
            DocIdError::UnknownPrefix(p) => write!(f, "unknown document kind {p:?}"),
            DocIdError::Id(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for DocIdError {}

impl DocId {
    pub fn kind(&self) -> DocKind {
        match self {
            DocId::Book(_) => DocKind::Book,
            DocId::Node(_) => DocKind::Node,
            DocId::Element(_) => DocKind::Element,
            DocId::Storyline(_) => DocKind::Storyline,
            DocId::Category(_) => DocKind::Category,
            DocId::Material(_) => DocKind::Material,
            DocId::Template(_) => DocKind::Template,
            DocId::Conversation(_) => DocKind::Conversation,
        }
    }

    /// The entity id after the prefix.
    pub fn entity_id(&self) -> &str {
        match self {
            DocId::Book(id) => id.as_str(),
            DocId::Node(id) => id.as_str(),
            DocId::Element(id) => id.as_str(),
            DocId::Storyline(id) => id.as_str(),
            DocId::Category(id) => id.as_str(),
            DocId::Material(id) => id.as_str(),
            DocId::Template(id) => id.as_str(),
            DocId::Conversation(id) => id.as_str(),
        }
    }

    pub fn profile(&self) -> Option<ProseProfile> {
        self.kind().profile()
    }

    pub fn is_book(&self) -> bool {
        matches!(self, DocId::Book(_))
    }

    pub fn parse(s: &str) -> Result<Self, DocIdError> {
        let (prefix, id) = s.split_once(':').ok_or(DocIdError::MissingPrefix)?;
        let e = DocIdError::Id;
        Ok(match prefix {
            "book" => DocId::Book(BookId::parse(id).map_err(e)?),
            "node" => DocId::Node(NodeId::parse(id).map_err(e)?),
            "element" => DocId::Element(ElementId::parse(id).map_err(e)?),
            "storyline" => DocId::Storyline(StorylineId::parse(id).map_err(e)?),
            "category" => DocId::Category(CategoryId::parse(id).map_err(e)?),
            "material" => DocId::Material(MaterialId::parse(id).map_err(e)?),
            "conversation" => DocId::Conversation(ConversationId::parse(id).map_err(e)?),
            "template" => {
                let t = TemplateId::parse(id).map_err(e)?;
                if t.owner().is_none() {
                    return Err(DocIdError::UnknownPrefix(s.to_string()));
                }
                DocId::Template(t)
            }
            other => return Err(DocIdError::UnknownPrefix(other.to_string())),
        })
    }
}

impl fmt::Display for DocId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.kind().prefix(), self.entity_id())
    }
}

impl fmt::Debug for DocId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DocId({self})")
    }
}

impl FromStr for DocId {
    type Err = DocIdError;
    fn from_str(s: &str) -> Result<Self, DocIdError> {
        Self::parse(s)
    }
}

impl TryFrom<String> for DocId {
    type Error = DocIdError;
    fn try_from(s: String) -> Result<Self, DocIdError> {
        Self::parse(&s)
    }
}

impl From<DocId> for String {
    fn from(id: DocId) -> String {
        id.to_string()
    }
}

impl From<BookId> for DocId {
    fn from(id: BookId) -> Self {
        DocId::Book(id)
    }
}
impl From<NodeId> for DocId {
    fn from(id: NodeId) -> Self {
        DocId::Node(id)
    }
}
impl From<ElementId> for DocId {
    fn from(id: ElementId) -> Self {
        DocId::Element(id)
    }
}
impl From<StorylineId> for DocId {
    fn from(id: StorylineId) -> Self {
        DocId::Storyline(id)
    }
}
impl From<CategoryId> for DocId {
    fn from(id: CategoryId) -> Self {
        DocId::Category(id)
    }
}
impl From<MaterialId> for DocId {
    fn from(id: MaterialId) -> Self {
        DocId::Material(id)
    }
}
impl From<TemplateId> for DocId {
    fn from(id: TemplateId) -> Self {
        DocId::Template(id)
    }
}

impl From<ConversationId> for DocId {
    fn from(id: ConversationId) -> Self {
        DocId::Conversation(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_ids_are_uuid_v7_and_increase() {
        let a = NodeId::new_v7();
        let b = NodeId::new_v7();
        assert!(is_uuid_v7(a.as_str()));
        assert!(a < b, "uuidv7 ids sort by creation within a process");
        assert!(!is_uuid_v7("rt-generic:b1"));
    }

    #[test]
    fn ids_reject_garbage() {
        assert_eq!(NodeId::parse(""), Err(IdError::Empty));
        assert_eq!(NodeId::parse("a\nb"), Err(IdError::BadChar('\n')));
        assert!(NodeId::parse(&"x".repeat(MAX_ID_LEN + 1)).is_err());
        assert_eq!(DeviceKey::parse("mac|1"), Err(IdError::BadChar('|')));
        assert_eq!(PlotRowId::parse("r/1"), Err(IdError::BadChar('/')));
        assert!(NodeId::parse("r/1").is_ok());
        assert!(RelationTypeId::parse("rt-generic:b1").is_ok());
    }

    #[test]
    fn ids_order_bytewise_like_the_old_client() {
        // Bytewise UTF-8 order: uppercase ASCII, then lowercase, then
        // multi-byte characters.
        let mut v = [
            NodeId::parse("é").unwrap(),
            NodeId::parse("a").unwrap(),
            NodeId::parse("Z").unwrap(),
        ];
        v.sort();
        let s: Vec<&str> = v.iter().map(|i| i.as_str()).collect();
        assert_eq!(s, vec!["Z", "a", "é"]);
    }

    #[test]
    fn doc_ids_round_trip() {
        for s in [
            "book:b1",
            "conversation:c1",
            "node:n1",
            "element:e1",
            "storyline:s1",
            "category:c1",
            "material:m1",
            "node:0199-x:y",
            "template:category:c1",
            "template:storyline:s1",
        ] {
            let id = DocId::parse(s).unwrap();
            assert_eq!(id.to_string(), s);
            let json = serde_json::to_string(&id).unwrap();
            assert_eq!(serde_json::from_str::<DocId>(&json).unwrap(), id);
        }
        assert_eq!(DocId::parse("x"), Err(DocIdError::MissingPrefix));
        assert!(matches!(
            DocId::parse("chapter:1"),
            Err(DocIdError::UnknownPrefix(_))
        ));
        assert_eq!(
            DocId::parse("material:m").unwrap().profile(),
            Some(ProseProfile::Note)
        );
        assert_eq!(
            DocId::parse("node:m").unwrap().profile(),
            Some(ProseProfile::Prose)
        );
        assert_eq!(DocId::parse("book:m").unwrap().profile(), None);
        assert_eq!(DocId::parse("conversation:c1").unwrap().profile(), None);
        assert!(!DocKind::Conversation.is_book_text());
        // Templates: one per category or storyline, derived from it.
        let c = CategoryId::parse("c1").unwrap();
        let t = TemplateOwner::Category(c.clone()).doc_id();
        assert_eq!(t.to_string(), "template:category:c1");
        assert_eq!(t, DocId::parse("template:category:c1").unwrap());
        assert_eq!(t.profile(), Some(ProseProfile::Prose));
        let DocId::Template(tid) = &t else {
            unreachable!()
        };
        assert_eq!(tid.owner(), Some(TemplateOwner::Category(c)));
        let s = StorylineId::parse("s1").unwrap();
        assert_eq!(
            TemplateId::for_storyline(&s).owner(),
            Some(TemplateOwner::Storyline(s))
        );
        assert!(matches!(
            DocId::parse("template:node:n1"),
            Err(DocIdError::UnknownPrefix(_))
        ));
        assert!(DocId::parse("template:").is_err());
        assert!(!t.kind().is_book_text() && !DocKind::Book.is_book_text());
        assert!(
            DocKind::ALL
                .iter()
                .filter(|k| !matches!(k, DocKind::Book | DocKind::Template | DocKind::Conversation))
                .all(|k| k.is_book_text())
        );
    }

    #[test]
    fn derived_ids() {
        let doc = DocId::parse("node:n1").unwrap();
        let b = BlockId::parse("3@7").unwrap();
        let k = crate::kind::ProjectionKind::Marker;
        let id = CommentId::for_projection(&k, &doc, &b);
        assert_eq!(id.as_str(), "todo:marker:node:n1#3@7");
        let n = NodeId::parse("n1").unwrap();
        assert_eq!(PlotRowId::default_for(&n, 2).as_str(), "n1:r2");
        assert_eq!(PlotColId::default_for(&n, 3).as_str(), "n1:c3");
        let odd = NodeId::parse("a/b").unwrap();
        assert_eq!(PlotRowId::default_for(&odd, 1).as_str(), "a%2Fb:r1");
        let long = NodeId::parse(&"x".repeat(MAX_ID_LEN)).unwrap();
        let r = PlotRowId::default_for(&long, 1);
        assert!(r.as_str().len() < 64 && r.as_str().ends_with(":r1"), "{r}");
        assert_eq!(id, CommentId::for_projection(&k, &doc, &b));
        // Matches the old client's digest (computed with its device-key.ts
        // formula for installation id "test-installation").
        assert_eq!(
            DeviceKey::from_installation_id("test-installation").as_str(),
            "device-a07079fbdbda43404d66e3c6"
        );
    }

    #[test]
    fn ids_serialize_as_strings() {
        let id = ElementId::parse("el-1").unwrap();
        assert_eq!(serde_json::to_string(&id).unwrap(), "\"el-1\"");
        assert!(serde_json::from_str::<ElementId>("\"\"").is_err());
    }
}
