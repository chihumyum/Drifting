//! Optional document observations for tools that must read before writing.
//! A comparison runs inside the owning holder job, before any mutation. These
//! are per-document guards, not a transaction across several documents.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use dr_model::DocId;
use loro::{Frontiers, LoroDoc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::naming::frontiers_from_hex;
use crate::{Result, WsError};

/// Canonical document data and the version it was read at, from one holder
/// read job. `value` is Loro's deep JSON value, not a rich-text serialization.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Observation {
    pub doc: String,
    pub version: String,
    pub value: Value,
}

/// Preconditions for one registered call. A tool keeps these from its own
/// observations; they are not an alternative source of document content.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WritePreconditions {
    pub versions: HashMap<String, String>,
    /// Refuse writes to any document absent from `versions`.
    pub require_all: bool,
}

impl Default for WritePreconditions {
    fn default() -> Self {
        Self {
            versions: HashMap::new(),
            require_all: true,
        }
    }
}

impl WritePreconditions {
    pub fn from_observations(observations: impl IntoIterator<Item = Observation>) -> Self {
        Self {
            versions: observations
                .into_iter()
                .map(|observation| (observation.doc, observation.version))
                .collect(),
            require_all: true,
        }
    }
}

#[derive(Clone)]
pub(crate) struct Guards(Arc<Parsed>);

struct Parsed {
    versions: Mutex<HashMap<String, Frontiers>>,
    require_all: bool,
}

impl Guards {
    pub(crate) fn parse(preconditions: WritePreconditions) -> Result<Self> {
        let mut versions = HashMap::new();
        for (id, encoded) in preconditions.versions {
            let doc = DocId::parse(&id).map_err(|e| WsError::Invalid(e.to_string()))?;
            if doc.to_string() != id {
                return Err(WsError::Invalid("non-canonical document id".into()));
            }
            if !encoded.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(WsError::Invalid("frontiers: not hex".into()));
            }
            versions.insert(id, frontiers_from_hex(&encoded)?);
        }
        Ok(Self(Arc::new(Parsed {
            versions: Mutex::new(versions),
            require_all: preconditions.require_all,
        })))
    }

    pub(crate) fn check(&self, id: &str, doc: &LoroDoc) -> Result<()> {
        match crate::holder::lock(&self.0.versions).get(id) {
            Some(expected) if *expected != doc.oplog_frontiers() => {
                Err(WsError::Conflict(format!("stale observation: {id}")))
            }
            None if self.0.require_all => Err(Self::missing(id)),
            _ => Ok(()),
        }
    }

    pub(crate) fn check_required(&self, id: &str, doc: &LoroDoc) -> Result<()> {
        if !crate::holder::lock(&self.0.versions).contains_key(id) {
            return Err(Self::missing(id));
        }
        self.check(id, doc)
    }

    /// Only for a document this invocation has just registered. Its first
    /// write may replace genesis, never any pre-existing or intervening edit.
    pub(crate) fn created(&self, id: String, genesis: Frontiers) {
        crate::holder::lock(&self.0.versions)
            .entry(id)
            .or_insert(genesis);
    }

    pub(crate) fn missing(id: &str) -> WsError {
        WsError::Conflict(format!("read required: {id}"))
    }
}
