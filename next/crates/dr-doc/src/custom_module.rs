//! My modules: one library-level document per custom module (`module:<id>`,
//! `docs/rust-rewrite/custom-modules.md` §7), stored the way my templates
//! are (`project-template:<id>`, `project-templates.md` §5): owned by no
//! book, synced with the library, one record replaced whole.
//!
//! The record is `payload.record = {info: {origin, created_at?,
//! updated_at?}, value: <canonical JSON of the module>}`: a save and a
//! rename on two devices at once keep one whole module (the later one),
//! never one's name over the other's blocks. The name lives in the value.

use dr_model::custom_module::{
    ModuleError, ModuleValue, parse_module_json, to_canonical_json, validate_module_value,
};
use dr_model::id::CustomModuleId;
use dr_model::{DocId, Origin, Timestamp};
use loro::{
    CommitOptions, ExportMode, Frontiers, LoroDoc, LoroValue, ValueOrContainer, VersionVector,
};

use crate::core::{Committed, Core, Imported, check_borrowed, configured};
use crate::error::{DocError, Result};
use crate::peer::{PeerId, genesis_peer};
use crate::schema::{self, CUSTOM_MODULE_GENESIS_VERSION, CUSTOM_MODULE_SCHEMA_VERSION};

/// Where a module in my modules came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModuleOrigin {
    /// Made in this library: the workbench, the Agent, 「另存一份」, 「存进我的模块」.
    Own,
    /// Imported from a `.driftingmodule` file.
    File,
}

impl ModuleOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            ModuleOrigin::Own => "own",
            ModuleOrigin::File => "file",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "own" => Some(ModuleOrigin::Own),
            "file" => Some(ModuleOrigin::File),
            _ => None,
        }
    }
}

/// What a module's record keeps beside its value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModuleInfo {
    pub origin: ModuleOrigin,
    pub created_at: Option<Timestamp>,
    pub updated_at: Option<Timestamp>,
}

/// Deterministic genesis of `module:<id>`: `meta.v = 1` and `meta.doc`,
/// committed at timestamp 0.
pub fn genesis(id: &CustomModuleId) -> Vec<u8> {
    let doc_id = DocId::Module(id.clone()).to_string();
    let doc = configured();
    doc.set_peer_id(genesis_peer(&doc_id, CUSTOM_MODULE_GENESIS_VERSION))
        .expect("genesis peer");
    let meta = doc.get_map(schema::custom_module::META);
    meta.insert(schema::meta::VERSION, CUSTOM_MODULE_SCHEMA_VERSION)
        .expect("meta version");
    meta.insert(schema::meta::DOC, doc_id.as_str())
        .expect("meta doc");
    doc.commit_with(CommitOptions::new().timestamp(0));
    doc.export(ExportMode::all_updates())
        .expect("export module genesis")
}

fn version_ok(v: &ValueOrContainer) -> bool {
    match v {
        ValueOrContainer::Value(LoroValue::I64(v)) => *v == CUSTOM_MODULE_SCHEMA_VERSION,
        ValueOrContainer::Value(LoroValue::Double(v)) => *v == CUSTOM_MODULE_SCHEMA_VERSION as f64,
        _ => false,
    }
}

fn check_identity(doc: &LoroDoc, id: &CustomModuleId) -> Result<()> {
    check_borrowed(doc, &DocId::Module(id.clone()), schema::meta::DOC)?;
    match doc
        .get_map(schema::custom_module::META)
        .get(schema::meta::VERSION)
    {
        Some(v) if version_ok(&v) => Ok(()),
        _ => Err(DocError::NotInProfile("unsupported module schema version")),
    }
}

/// Check an incoming update to `module:<id>` before it is imported: the
/// header (when it has one) is this document's, and the merged module (when
/// there is one) passes the module validator.
pub fn validate_import(
    id: &CustomModuleId,
    current: &LoroDoc,
    bytes: &[u8],
) -> std::result::Result<(), String> {
    let incoming = configured();
    incoming.import(bytes).map_err(|e| e.to_string())?;
    let meta = incoming.get_map(schema::custom_module::META);
    if let Some(v) = meta.get(schema::meta::VERSION)
        && !version_ok(&v)
    {
        return Err("unsupported module schema version".into());
    }
    let want_doc = DocId::Module(id.clone()).to_string();
    if let Some(doc_val) = meta.get(schema::meta::DOC)
        && !matches!(doc_val, ValueOrContainer::Value(LoroValue::String(ref s)) if s.as_str() == want_doc)
    {
        return Err("module identity mismatch".into());
    }
    let merged = configured();
    merged
        .import(
            &current
                .export(ExportMode::Snapshot)
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    if let Some(waiting) = current
        .export_pending_updates()
        .map_err(|e| e.to_string())?
    {
        merged.import(&waiting).map_err(|e| e.to_string())?;
    }
    merged.import(bytes).map_err(|e| e.to_string())?;
    if let Some(raw) = (ModuleDocView { doc: &merged }).raw_value() {
        parse_module_json(&raw).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Read-only view of a `module:<id>` document.
#[derive(Clone, Copy)]
pub struct ModuleDocView<'a> {
    doc: &'a LoroDoc,
}

impl ModuleDocView<'_> {
    fn record(&self) -> Option<(loro::LoroMapValue, String)> {
        let Some(ValueOrContainer::Value(LoroValue::Map(record))) = self
            .doc
            .get_map(schema::custom_module::PAYLOAD)
            .get(schema::custom_module::RECORD)
        else {
            return None;
        };
        let info = match record.get(schema::custom_module::RECORD_INFO) {
            Some(LoroValue::Map(info)) => info.clone(),
            _ => return None,
        };
        let value = match record.get(schema::custom_module::VALUE) {
            Some(LoroValue::String(value)) => value.to_string(),
            _ => return None,
        };
        Some((info, value))
    }

    /// The record's `info` (`None` while only the genesis is there).
    pub fn info(&self) -> Option<ModuleInfo> {
        let (m, _) = self.record()?;
        let origin = match m.get("origin") {
            Some(LoroValue::String(s)) => ModuleOrigin::parse(s).unwrap_or(ModuleOrigin::Own),
            _ => ModuleOrigin::Own,
        };
        let ts = |key: &str| match m.get(key) {
            Some(LoroValue::I64(ms)) => Some(Timestamp(*ms)),
            _ => None,
        };
        Some(ModuleInfo {
            origin,
            created_at: ts("created_at"),
            updated_at: ts("updated_at"),
        })
    }

    /// The stored canonical JSON of the module.
    pub fn raw_value(&self) -> Option<String> {
        self.record().map(|(_, v)| v)
    }

    /// The module, through the validator.
    pub fn value(&self) -> std::result::Result<ModuleValue, ModuleError> {
        let raw = self
            .raw_value()
            .ok_or_else(|| ModuleError::Invalid("the module has not been saved yet".into()))?;
        parse_module_json(&raw)
    }
}

/// Write transaction on a `module:<id>` document. Does not commit.
pub struct ModuleDocTxn<'a> {
    doc: &'a LoroDoc,
}

impl<'a> ModuleDocTxn<'a> {
    pub fn view(&self) -> ModuleDocView<'a> {
        ModuleDocView { doc: self.doc }
    }

    /// Validate `value` and write it with `info` as the one record, whole.
    pub fn save(
        &mut self,
        info: &ModuleInfo,
        value: &ModuleValue,
    ) -> std::result::Result<(), ModuleError> {
        validate_module_value(value)?;
        let json = to_canonical_json(value)?;
        let mut info_value: std::collections::HashMap<String, LoroValue> =
            [("origin".to_owned(), LoroValue::from(info.origin.as_str()))]
                .into_iter()
                .collect();
        if let Some(t) = info.created_at {
            info_value.insert("created_at".into(), LoroValue::from(t.0));
        }
        if let Some(t) = info.updated_at {
            info_value.insert("updated_at".into(), LoroValue::from(t.0));
        }
        let record: std::collections::HashMap<String, LoroValue> = [
            (
                schema::custom_module::RECORD_INFO.to_owned(),
                LoroValue::from(info_value),
            ),
            (
                schema::custom_module::VALUE.to_owned(),
                LoroValue::from(json),
            ),
        ]
        .into_iter()
        .collect();
        self.doc
            .get_map(schema::custom_module::PAYLOAD)
            .insert(schema::custom_module::RECORD, LoroValue::from(record))
            .map_err(|e| ModuleError::Invalid(e.to_string()))?;
        Ok(())
    }
}

/// A `module:<id>` document held by the store.
pub struct BorrowedModuleDoc<'a> {
    doc: &'a LoroDoc,
}

impl<'a> BorrowedModuleDoc<'a> {
    pub fn new(doc: &'a LoroDoc, id: &CustomModuleId) -> Result<Self> {
        check_identity(doc, id)?;
        Ok(Self { doc })
    }

    pub fn view(&self) -> ModuleDocView<'_> {
        ModuleDocView { doc: self.doc }
    }

    pub fn txn(&self) -> ModuleDocTxn<'_> {
        ModuleDocTxn { doc: self.doc }
    }
}

/// A standalone `module:<id>` document (tests, tools).
pub struct ModuleDoc {
    core: Core,
    id: CustomModuleId,
}

impl ModuleDoc {
    pub fn create(id: CustomModuleId, peer: PeerId) -> Result<Self> {
        Self::load(id, peer, &[])
    }

    pub fn load(id: CustomModuleId, peer: PeerId, blobs: &[Vec<u8>]) -> Result<Self> {
        let doc_id = DocId::Module(id.clone());
        let core = Core::load(doc_id, &genesis(&id), blobs, Some(peer), schema::meta::DOC)?;
        check_identity(&core.doc, &id)?;
        Ok(Self { core, id })
    }

    pub fn id(&self) -> &CustomModuleId {
        &self.id
    }

    pub fn view(&self) -> ModuleDocView<'_> {
        ModuleDocView {
            doc: &self.core.doc,
        }
    }

    pub fn edit<R>(
        &mut self,
        origin: Origin,
        f: impl FnOnce(&mut ModuleDocTxn<'_>) -> Result<R>,
    ) -> (Result<R>, Option<Committed>) {
        let core = &self.core;
        core.transact(&origin, None, || {
            let mut txn = ModuleDocTxn { doc: &core.doc };
            f(&mut txn)
        })
    }

    pub fn import(&mut self, bytes: &[u8], origin: Origin) -> Result<Imported> {
        validate_import(&self.id, &self.core.doc, bytes)
            .map_err(|_| DocError::NotInProfile("invalid module update"))?;
        let pending = self.core.import(bytes, &origin)?;
        Ok(Imported {
            pending,
            repair: None,
        })
    }

    pub fn version(&self) -> VersionVector {
        self.core.version()
    }

    pub fn frontiers(&self) -> Frontiers {
        self.core.frontiers()
    }

    pub fn export_updates_since(&self, vv: &VersionVector) -> Result<Vec<u8>> {
        self.core.export_updates_since(vv)
    }

    pub fn export_snapshot(&self) -> Result<Vec<u8>> {
        self.core.export_snapshot()
    }
}
