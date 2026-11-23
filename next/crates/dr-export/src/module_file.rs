//! One custom module in one file: `.driftingmodule`, module format version
//! 1 (`docs/rust-rewrite/custom-modules.md` §6, §10, §12).
//!
//! - The file is the module's canonical UTF-8 JSON
//!   (`dr_model::custom_module::to_canonical_json`), 256 KiB at most: the
//!   same module exported twice is the same bytes.
//! - Export writes the module as my modules keep it, with `credit.author`
//!   set to the exporter's account display name only (on one line; none when
//!   signed out or unnamed), the way a project template's is. The library
//!   document is not changed by exporting it.
//! - Import validates the file first through the one validator
//!   ([`validate_module_file`], which `cargo drifting module check` runs
//!   too), then always adds a new module with a new id; nothing is written
//!   when the file is refused.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use dr_model::custom_module::{
    MAX_MODULE_BYTES, MODULE_FORMAT, MODULE_FORMAT_VERSION, ModuleError, ModuleValue,
    parse_module_json, to_canonical_json,
};
use dr_workspace::commands::v3::custom_module::{
    CustomModuleImport, ImportIn, ModuleSummary, prepare_export,
};
use dr_workspace::{Actor, Workspace};

use crate::files::{readable_stem, write_file};

pub const FORMAT: &str = MODULE_FORMAT;
pub const FORMAT_VERSION: i64 = MODULE_FORMAT_VERSION;
pub const EXTENSION: &str = "driftingmodule";
pub const MAX_BYTES: u64 = MAX_MODULE_BYTES as u64;

/// Why a `.driftingmodule` file could not be validated, imported or exported.
#[derive(Debug, thiserror::Error)]
pub enum ModuleFileError {
    /// Not a Drifting module at all.
    #[error("the file is not a Drifting module")]
    NotAModule,
    /// Made with a newer `formatVersion` than this build reads.
    #[error("the module uses a newer formatVersion than this Drifting supports")]
    Newer,
    /// More than 256 KiB.
    #[error("the module file exceeds the 256 KiB limit")]
    TooLarge,
    /// Says it is a module but fails the closed format or a rule.
    #[error("the module file is invalid: {0}")]
    Damaged(String),
    #[error(transparent)]
    Workspace(#[from] dr_workspace::WsError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T, E = ModuleFileError> = std::result::Result<T, E>;

/// `<name>.driftingmodule`, suggested in the save panel.
pub fn module_filename(name: &str) -> String {
    format!("{}.{EXTENSION}", readable_stem(name))
}

fn claims_module_format(raw: &str) -> bool {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Object(map)) => {
            map.get("format").and_then(serde_json::Value::as_str) == Some(FORMAT)
        }
        Ok(_) => false,
        Err(_) => raw.contains(FORMAT),
    }
}

/// How a validator refusal reads for a file.
pub fn classify(raw: &str, err: ModuleError) -> ModuleFileError {
    match err {
        ModuleError::TooLarge { .. } => ModuleFileError::TooLarge,
        ModuleError::InvalidFormat(_) => ModuleFileError::NotAModule,
        ModuleError::UnsupportedFormatVersion { .. } => ModuleFileError::Newer,
        ModuleError::InvalidFormatVersion(v) => {
            ModuleFileError::Damaged(format!("invalid formatVersion {v}"))
        }
        ModuleError::Invalid(msg) => ModuleFileError::Damaged(msg),
        ModuleError::MalformedJson(msg) => {
            if claims_module_format(raw) {
                ModuleFileError::Damaged(msg)
            } else {
                ModuleFileError::NotAModule
            }
        }
    }
}

/// Validate raw bytes as a `.driftingmodule` file without touching a library.
pub fn validate_module_bytes(bytes: &[u8]) -> Result<ModuleValue> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err(ModuleFileError::TooLarge);
    }
    let Ok(raw) = std::str::from_utf8(bytes) else {
        return Err(ModuleFileError::NotAModule);
    };
    parse_module_json(raw).map_err(|e| classify(raw, e))
}

/// Read and validate `path` as a `.driftingmodule` file without opening a
/// library: `cargo drifting module check` and [`import_module`] reach the
/// same verdict through it.
pub fn validate_module_file(path: &Path) -> Result<ModuleValue> {
    let file = File::open(path)?;
    let len = file.metadata()?.len();
    if len > MAX_BYTES {
        return Err(ModuleFileError::TooLarge);
    }
    let mut bytes = Vec::with_capacity((len as usize).min(MAX_MODULE_BYTES));
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    validate_module_bytes(&bytes)
}

/// An exported `.driftingmodule` file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModuleFileSummary {
    pub id: String,
    pub name: String,
    pub bytes: u64,
}

/// Write module `id` of my modules to `path`: its canonical JSON, with
/// `credit.author` the exporter's account display name `author` (none when
/// `None`, blank or only control characters). The same module and name
/// give the same bytes every time; my modules are not changed.
pub fn export_module(
    ws: &Workspace,
    id: &str,
    author: Option<&str>,
    path: &Path,
) -> Result<ModuleFileSummary> {
    let (id, value) = prepare_export(ws, id, author)?;
    let json = to_canonical_json(&value).map_err(|e| match e {
        ModuleError::TooLarge { .. } => ModuleFileError::TooLarge,
        other => ModuleFileError::Damaged(other.to_string()),
    })?;
    write_file(path, json.as_bytes())?;
    Ok(ModuleFileSummary {
        id: id.to_string(),
        name: value.name,
        bytes: json.len() as u64,
    })
}

/// Validate the `.driftingmodule` file at `path` and add it to my modules
/// as a new module (`custom_module.import`, a new id every time). Nothing
/// is written when the file is refused; a path that is not UTF-8 is refused.
pub fn import_module(ws: &Workspace, path: &Path) -> Result<ModuleSummary> {
    let Some(path_str) = path.to_str() else {
        return Err(ModuleFileError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the module file's path is not UTF-8",
        )));
    };
    validate_module_file(path)?;
    let outcome = ws.run::<CustomModuleImport>(
        &Actor::User,
        ImportIn {
            path: path_str.to_owned(),
        },
    )?;
    Ok(outcome.output)
}
