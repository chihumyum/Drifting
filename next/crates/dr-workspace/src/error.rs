//! Errors of commands and queries.
//!
//! Every error has a stable [`WsError::code`] that Agent tools, MCP and the
//! dev CLI can match on; the message is for people.

use dr_model::check::Violation;

pub type Result<T, E = WsError> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum WsError {
    /// The thing a command names does not exist (or is not in this book).
    #[error("{what} {id} not found")]
    NotFound { what: &'static str, id: String },
    /// The input breaks a rule of the command (a missing field, a value out
    /// of range).
    #[error("invalid input: {0}")]
    Invalid(String),
    /// The write would break an invariant (`dr_model::invariant`).
    #[error("{0}")]
    Violation(#[from] Violation),
    /// An element name or alias, or a relation type name, is already used
    /// in the book (`ELEMENT-NAME-UNIQUE`, `RT-NAME`). The holder is named so
    /// the caller can use it instead.
    #[error("name {name:?} is already used by {kind} {id}")]
    NameTaken {
        kind: &'static str,
        id: String,
        name: String,
    },
    /// The built-in relation type cannot be changed or deleted.
    #[error("{0} is locked")]
    Locked(String),
    /// A text to replace occurs more than once (or the target is otherwise
    /// ambiguous).
    #[error("ambiguous: {0}")]
    Ambiguous(String),
    /// The command needs a newer state than the caller saw.
    #[error("conflict: {0}")]
    Conflict(String),
    /// No command or query is registered under this name.
    #[error("unknown command {0}")]
    UnknownCommand(String),
    /// The JSON input does not match the command's schema.
    #[error("bad input for {command}: {detail}")]
    BadInput {
        command: &'static str,
        detail: String,
    },
    /// A fault injected by a test.
    #[error("injected fault at {0}")]
    Fault(&'static str),
    #[error(transparent)]
    Store(#[from] dr_store::StoreError),
    #[error(transparent)]
    Doc(#[from] dr_doc::DocError),
    #[error("local table: {0}")]
    Local(#[from] rusqlite::Error),
    #[error("loro: {0}")]
    Loro(#[from] loro::LoroError),
    #[error("loro export: {0}")]
    LoroEncode(#[from] loro::LoroEncodeError),
    #[error("internal: {0}")]
    Internal(String),
}

impl WsError {
    pub(crate) fn not_found(what: &'static str, id: impl Into<String>) -> Self {
        WsError::NotFound {
            what,
            id: id.into(),
        }
    }

    pub(crate) fn invalid(detail: impl Into<String>) -> Self {
        WsError::Invalid(detail.into())
    }

    /// A stable machine-readable code: `not_found`, `invalid`,
    /// `invariant:<ID>`, `name_taken`, `locked`, `ambiguous`, `conflict`,
    /// `unknown_command`, `bad_input`, `fault`, `storage`, `document`,
    /// `local`, `internal`.
    pub fn code(&self) -> String {
        match self {
            WsError::NotFound { .. } => "not_found".into(),
            WsError::Invalid(_) => "invalid".into(),
            WsError::Violation(v) => format!("invariant:{}", v.invariant),
            WsError::NameTaken { .. } => "name_taken".into(),
            WsError::Locked(_) => "locked".into(),
            WsError::Ambiguous(_) => "ambiguous".into(),
            WsError::Conflict(_) => "conflict".into(),
            WsError::UnknownCommand(_) => "unknown_command".into(),
            WsError::BadInput { .. } => "bad_input".into(),
            WsError::Fault(_) => "fault".into(),
            WsError::Store(_) => "storage".into(),
            WsError::Doc(dr_doc::DocError::Locked(_)) => "locked".into(),
            WsError::Doc(_) | WsError::Loro(_) | WsError::LoroEncode(_) => "document".into(),
            WsError::Local(_) => "local".into(),
            WsError::Internal(_) => "internal".into(),
        }
    }
}
