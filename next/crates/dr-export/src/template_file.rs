//! One project template in one file: `.driftingtemplate`, format version 1
//! (`docs/rust-rewrite/project-templates.md` §6, §9, §11;
//! `docs/rust-rewrite/project-template-format.md`).
//!
//! - Deterministic UTF-8 JSON (`dr_model::project_template::to_canonical_json`),
//!   2 MiB maximum (`MAX_BYTES`). Repeated exports of the same template with
//!   the same attribution produce byte-for-byte identical files.
//! - Export sets `credit.author` strictly to the exporter's explicit account
//!   display name (on one line: control characters are taken out), or omits
//!   `credit` when signed out, when the account has no profile name set, or
//!   when nothing of it is left (never using an email `@` prefix, `homepage`,
//!   `book.root`, or `derivedFrom`). The stored `project-template:<id>`
//!   document in the library is never mutated by exporting it.
//! - Import validates the file first through the shared validator
//!   ([`validate_template_file`], also run standalone by `dr-cli`), always
//!   creates a new `project-template:<id>` with `origin = "file"`, and writes
//!   nothing to the library on failure.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use dr_model::project_template::{
    MAX_PROJECT_TEMPLATE_BYTES, PROJECT_TEMPLATE_FORMAT, PROJECT_TEMPLATE_FORMAT_VERSION,
    ProjectTemplateError, ProjectTemplateValue, parse_project_template_json, to_canonical_json,
};
use dr_workspace::commands::v3::project_template::{
    ProjectTemplateImport, ProjectTemplateImportIn, ProjectTemplateSummary,
    prepare_export_template, saved_template_name,
};
use dr_workspace::{Actor, Workspace};

use crate::files::{readable_stem, write_file};

pub const FORMAT: &str = PROJECT_TEMPLATE_FORMAT;
pub const FORMAT_VERSION: i64 = PROJECT_TEMPLATE_FORMAT_VERSION;
pub const EXTENSION: &str = "driftingtemplate";
pub const MAX_BYTES: u64 = MAX_PROJECT_TEMPLATE_BYTES as u64;

/// Why a `.driftingtemplate` file could not be validated, imported, or exported.
#[derive(Debug, thiserror::Error)]
pub enum TemplateFileError {
    /// Not a Drifting project template file at all.
    #[error("the file is not a Drifting project template")]
    NotATemplate,
    /// Made with a newer `formatVersion` than this build supports.
    #[error("the template uses a newer formatVersion than this Drifting supports")]
    Newer,
    /// Exceeds the 2 MiB `.driftingtemplate` size limit.
    #[error("the template file exceeds the 2 MiB limit")]
    TooLarge,
    /// Claims `drifting.project-template` but fails closed-schema or structural validation.
    #[error("the template file is invalid: {0}")]
    Damaged(String),
    #[error(transparent)]
    Workspace(#[from] dr_workspace::WsError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T, E = TemplateFileError> = std::result::Result<T, E>;

/// Summary of an exported `.driftingtemplate` file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TemplateFileSummary {
    pub id: String,
    pub name: String,
    pub bytes: u64,
}

/// `<name>.driftingtemplate` suggested in the save panel.
pub fn template_filename(name: &str) -> String {
    format!("{}.{EXTENSION}", readable_stem(name))
}

/// Reads the display name of saved template `id` (`project-template:<id>`).
pub fn template_name(ws: &Workspace, id: &str) -> Result<String> {
    Ok(saved_template_name(ws, id)?)
}

fn claims_template_format(raw: &str) -> bool {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Object(map)) => {
            map.get("format").and_then(serde_json::Value::as_str) == Some(FORMAT)
        }
        Ok(_) => false,
        Err(_) => raw.contains(FORMAT),
    }
}

fn classify_parse_error(raw: &str, err: ProjectTemplateError) -> TemplateFileError {
    match err {
        ProjectTemplateError::TooLarge { .. } => TemplateFileError::TooLarge,
        ProjectTemplateError::InvalidFormat(_) => TemplateFileError::NotATemplate,
        ProjectTemplateError::UnsupportedFormatVersion { .. } => TemplateFileError::Newer,
        ProjectTemplateError::InvalidFormatVersion(v) => {
            TemplateFileError::Damaged(format!("invalid formatVersion {v}"))
        }
        ProjectTemplateError::Invalid(msg) => TemplateFileError::Damaged(msg),
        ProjectTemplateError::MalformedJson(msg) => {
            if claims_template_format(raw) {
                TemplateFileError::Damaged(msg)
            } else {
                TemplateFileError::NotATemplate
            }
        }
    }
}

/// Validates raw bytes as a `.driftingtemplate` payload without touching any library.
pub fn validate_template_bytes(bytes: &[u8]) -> Result<ProjectTemplateValue> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err(TemplateFileError::TooLarge);
    }
    let Ok(raw) = std::str::from_utf8(bytes) else {
        return Err(TemplateFileError::NotATemplate);
    };
    parse_project_template_json(raw).map_err(|e| classify_parse_error(raw, e))
}

/// Reads and validates `path` as a `.driftingtemplate` file without opening a library.
///
/// Shared by standalone CLI validation (`cargo drifting template check`) and
/// App template import (`import_template`) so both reach 100% identical verdicts.
pub fn validate_template_file(path: &Path) -> Result<ProjectTemplateValue> {
    let file = File::open(path)?;
    let meta_len = file.metadata()?.len();
    if meta_len > MAX_BYTES {
        return Err(TemplateFileError::TooLarge);
    }
    let mut bytes = Vec::with_capacity((meta_len as usize).min(MAX_PROJECT_TEMPLATE_BYTES));
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    validate_template_bytes(&bytes)
}

/// Exports saved template `id` from `ws` to `path` as deterministic UTF-8 JSON.
///
/// `author` is the exporter's explicit account profile name (`None` or blank
/// omits `credit` in the file, overwriting any upstream attribution on `id`
/// without mutating the library copy).
pub fn export_template(
    ws: &Workspace,
    id: &str,
    author: Option<&str>,
    path: &Path,
) -> Result<TemplateFileSummary> {
    let author = author.and_then(credit_author);
    let (pt_id, value) = prepare_export_template(ws, id, author.as_deref())?;
    let json = to_canonical_json(&value).map_err(|e| match e {
        ProjectTemplateError::TooLarge { .. } => TemplateFileError::TooLarge,
        other => TemplateFileError::Damaged(other.to_string()),
    })?;
    write_file(path, json.as_bytes())?;
    Ok(TemplateFileSummary {
        id: pt_id.to_string(),
        name: value.name,
        bytes: json.len() as u64,
    })
}

/// The account name as a template's credit: one line, so control
/// characters (which the account name's own check lets through) are taken
/// out; nothing left is no credit.
fn credit_author(name: &str) -> Option<String> {
    let line: String = name.chars().filter(|c| !c.is_control()).collect();
    let line = line.trim();
    (!line.is_empty()).then(|| line.to_owned())
}

/// Validates the `.driftingtemplate` file at `path` and imports it into `ws`
/// as a new saved project template (`origin = "file"`), through
/// `project_template.import`. Writes nothing on failure. A path that is not
/// UTF-8 cannot be handed to the command and is refused.
pub fn import_template(ws: &Workspace, path: &Path) -> Result<ProjectTemplateSummary> {
    let Some(path_str) = path.to_str() else {
        return Err(TemplateFileError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the template file's path is not UTF-8",
        )));
    };
    validate_template_file(path)?;
    let outcome = ws.run::<ProjectTemplateImport>(
        &Actor::User,
        ProjectTemplateImportIn {
            path: path_str.to_owned(),
        },
    )?;
    Ok(outcome.output)
}
