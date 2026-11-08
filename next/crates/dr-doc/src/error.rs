//! Errors.

use std::fmt;

use dr_model::DocId;

use crate::pos::PosError;

/// Everything that can go wrong reading or writing a document.
#[derive(Debug)]
pub enum DocError {
    /// Loro refused an operation or could not decode bytes.
    Loro(loro::LoroError),
    /// Loro could not export.
    Encode(loro::LoroEncodeError),
    /// The bytes loaded for one document belong to another (its
    /// `meta.doc` / `meta.book` names a different id).
    WrongDocument { expected: DocId, found: String },
    /// A position outside the text or inside a character.
    Pos(PosError),
    /// A range that ends before it starts or reaches past the final newline.
    BadRange {
        start: usize,
        end: usize,
        len: usize,
    },
    /// Text for `insert_text` may not contain a paragraph break; use `split`
    /// or `insert_paragraphs`.
    NewlineInText,
    /// U+FFFC only appears as an embed placeholder (`insert_embed`).
    ObjectCharInText,
    /// The document's profile does not allow this attribute or mark (a list
    /// in a chapter, say).
    NotInProfile(&'static str),
    /// No paragraph ends at this position.
    NotANewline(usize),
    /// A borrowed document has no genesis yet (no `meta`): create it from
    /// `prose::genesis` / `book::genesis` first.
    NotInitialized(DocId),
    /// The peer id is reserved (zero, or a genesis peer).
    ReservedPeer(u64),
    /// The entity does not exist.
    Missing {
        collection: &'static str,
        id: String,
    },
    /// The built-in relation type cannot be changed or deleted.
    Locked(String),
    /// Invalid conversation data or a repeated event id with different content.
    Conversation(String),
}

impl fmt::Display for DocError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DocError::Loro(e) => write!(f, "loro: {e}"),
            DocError::Encode(e) => write!(f, "loro export: {e}"),
            DocError::WrongDocument { expected, found } => {
                write!(f, "bytes for {found:?} loaded as {expected}")
            }
            DocError::Pos(e) => write!(f, "{e}"),
            DocError::BadRange { start, end, len } => {
                write!(f, "range {start}..{end} does not fit text of length {len}")
            }
            DocError::NewlineInText => write!(f, "text contains a paragraph break"),
            DocError::ObjectCharInText => write!(f, "text contains U+FFFC"),
            DocError::NotInProfile(what) => {
                write!(f, "{what} is not allowed in this document's profile")
            }
            DocError::NotANewline(p) => write!(f, "no paragraph ends at {p}"),
            DocError::ReservedPeer(p) => write!(f, "peer {p} is reserved"),
            DocError::NotInitialized(id) => write!(f, "{id} has no genesis yet"),
            DocError::Missing { collection, id } => write!(f, "no {id:?} in {collection}"),
            DocError::Locked(id) => write!(f, "{id} is built in and locked"),
            DocError::Conversation(reason) => write!(f, "conversation: {reason}"),
        }
    }
}

impl std::error::Error for DocError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            DocError::Loro(e) => Some(e),
            DocError::Pos(e) => Some(e),
            _ => None,
        }
    }
}

impl From<loro::LoroError> for DocError {
    fn from(e: loro::LoroError) -> Self {
        DocError::Loro(e)
    }
}

impl From<loro::LoroEncodeError> for DocError {
    fn from(e: loro::LoroEncodeError) -> Self {
        DocError::Encode(e)
    }
}

impl From<PosError> for DocError {
    fn from(e: PosError) -> Self {
        DocError::Pos(e)
    }
}

pub type Result<T, E = DocError> = std::result::Result<T, E>;
