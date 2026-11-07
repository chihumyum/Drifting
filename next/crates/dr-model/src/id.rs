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
}

impl DocKind {
    pub const ALL: [DocKind; 6] = [
        DocKind::Book,
        DocKind::Node,
        DocKind::Element,
        DocKind::Storyline,
        DocKind::Category,
        DocKind::Material,
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
        }
    }

    /// The editing profile of a prose document of this kind; `None` for the
    /// book document. Material notes use the note profile, everything else
    /// the prose profile (as the old `editor-schema-profile.ts`: the profile
    /// follows the document, not the view).
    pub fn profile(self) -> Option<ProseProfile> {
        match self {
            DocKind::Book => None,
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
/// `material:<id>` for prose documents. The string form is what storage keys
/// documents by.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum DocId {
    Book(BookId),
    Node(NodeId),
    Element(ElementId),
    Storyline(StorylineId),
    Category(CategoryId),
    Material(MaterialId),
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
            "node:n1",
            "element:e1",
            "storyline:s1",
            "category:c1",
            "material:m1",
            "node:0199-x:y",
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
    }

    #[test]
    fn ids_serialize_as_strings() {
        let id = ElementId::parse("el-1").unwrap();
        assert_eq!(serde_json::to_string(&id).unwrap(), "\"el-1\"");
        assert!(serde_json::from_str::<ElementId>("\"\"").is_err());
    }
}
