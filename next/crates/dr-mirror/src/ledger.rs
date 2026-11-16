//! Device-local format 5 projection state. This scope never reads the
//! removed projection's ledger.

use std::collections::{BTreeMap, BTreeSet};

use dr_model::id::{BlockId, BodyDocId, BookId, EntryTemplateId};
use dr_store::Library;
use loro::Frontiers;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    disk::Stat,
    file::Header,
    layout::{AssetFile, Names},
};

pub const SCOPE: &str = "markdown-folder-v5";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Fingerprint {
    pub sha: String,
    pub stat: Stat,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Version {
    pub path: String,
    pub disk: Option<Fingerprint>,
    pub base: Vec<u8>,
    pub template: EntryTemplateId,
    pub restore: Vec<String>,
    pub fields: Header,
    #[serde(default)]
    pub asset_links: Vec<AssetFile>,
    pub extra: String,
    #[serde(default)]
    pub retired: bool,
}

impl Version {
    pub fn frontiers(&self) -> Option<Frontiers> {
        Frontiers::decode(&self.base).ok()
    }

    pub fn sha(&self) -> Option<&str> {
        self.disk.as_ref().map(|f| f.sha.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Row {
    pub current: Version,
    /// Saved before the temporary file is installed. A restart can recognize
    /// the completed write by its fingerprint even if its mtime changed.
    pub outgoing: Option<Version>,
    /// Acknowledged only after the body and its side effects reached the
    /// workspace. Durable so a crash between commits cannot lose the notice.
    #[serde(default)]
    pub applying: Option<Applying>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Applying {
    pub sha: String,
    pub conflicts: Vec<BlockId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CopyRow {
    pub path: String,
    pub sha: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ProjectRow {
    pub folder: String,
    pub title: String,
    pub names: Names,
    #[serde(default)]
    pub renaming: Option<String>,
    #[serde(default)]
    pub assets: Vec<AssetFile>,
    #[serde(default)]
    pub copies: BTreeMap<String, CopyRow>,
    #[serde(default)]
    pub directories: BTreeSet<String>,
}

pub(crate) struct Ledger<'a> {
    lib: &'a Library,
    book: &'a BookId,
    prefix: String,
}

impl<'a> Ledger<'a> {
    pub fn new(lib: &'a Library, book: &'a BookId, root: &std::path::Path) -> Self {
        let root_key = crate::disk::sha256_hex(root.as_os_str().as_encoded_bytes());
        Self {
            lib,
            book,
            prefix: format!("{root_key}/{book}/"),
        }
    }

    pub fn project(&self) -> dr_store::Result<Option<ProjectRow>> {
        self.get("project")
    }

    pub fn put_project(&self, row: &ProjectRow) -> dr_store::Result<()> {
        self.put("project", row)
    }

    pub fn files(&self) -> dr_store::Result<BTreeMap<BodyDocId, Row>> {
        let mut rows = BTreeMap::new();
        let prefix = format!("{}file/", self.prefix);
        for row in self.lib.local_entries(SCOPE, Some(self.book.as_str()))? {
            if let Some(id) = row.key.strip_prefix(&prefix) {
                let id = BodyDocId::parse(id).map_err(invalid)?;
                rows.insert(id, serde_json::from_str(&row.value).map_err(invalid)?);
            }
        }
        Ok(rows)
    }

    pub fn put_file(&self, id: &BodyDocId, row: &Row) -> dr_store::Result<()> {
        self.put(&format!("file/{id}"), row)
    }

    fn put(&self, name: &str, value: &impl Serialize) -> dr_store::Result<()> {
        let payload = serde_json::to_string(value).map_err(invalid)?;
        self.lib.local_set(
            SCOPE,
            &format!("{}{name}", self.prefix),
            &payload,
            Some(self.book.as_str()),
        )
    }

    fn get<T: DeserializeOwned>(&self, name: &str) -> dr_store::Result<Option<T>> {
        self.lib
            .local_get(SCOPE, &format!("{}{name}", self.prefix))?
            .map(|value| serde_json::from_str(&value).map_err(invalid))
            .transpose()
    }
}

fn invalid(error: impl ToString) -> dr_store::StoreError {
    std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string()).into()
}
