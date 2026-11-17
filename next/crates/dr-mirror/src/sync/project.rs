use std::collections::{BTreeMap, BTreeSet};

use dr_doc::{
    prose::BorrowedProse,
    side::BorrowedCheckpoints,
    v3::{BookStructureV3, BorrowedBookV3},
};
use dr_model::{
    DocId,
    id::{AssetId, BodyDocId, BookId, EntryId, EntryTemplateId},
    shared::{Asset, AssetFolder},
    v3::{EntryTemplate, FieldType, ModuleKind},
};
use dr_store::{Library, OpenDoc, Origin, StoreError};
use dr_workspace::{Actor, Workspace};
use loro::{Frontiers, LoroDoc};

use crate::{
    Options,
    body::{FileLinks, Kind, Para, render_with},
    file::Header,
    layout::{AssetFile, BookLayout, Names},
    ledger::Version,
};

use super::{Result, SyncError};

pub(super) struct Project {
    pub book: BookId,
    pub epoch: String,
    pub title: String,
    pub structure: BookStructureV3,
    pub assets: Vec<Asset>,
    pub folders: Vec<AssetFolder>,
    restores: BTreeMap<String, Vec<String>>,
}

impl Project {
    pub fn read(ws: &Workspace, id: &BookId) -> Result<Option<Self>> {
        if ws.is_working_copy(id.as_str())? {
            return Ok(None);
        }
        let book = id.clone();
        let epoch = ws.library().epoch();
        let result = ws.read_book_v3(id.as_str(), move |raw, _| {
            let view = BorrowedBookV3::new(raw, &book)?;
            let view = view.view();
            let meta = view.meta();
            if meta.deleted_at.is_some() {
                return Ok(None);
            }
            Ok(Some(Self {
                book,
                epoch,
                title: meta.name,
                structure: view.structure_snapshot(),
                assets: view.assets_raw(),
                folders: view.asset_folders_raw(),
                restores: BTreeMap::new(),
            }))
        })?;
        let Some(mut project) = result else {
            return Ok(None);
        };
        project.restores = restore_epochs(ws.library(), id)?;
        Ok(Some(project))
    }

    pub fn layout(&self, lib: &Library, names: &Names) -> Result<BookLayout> {
        let mut filled = BTreeSet::new();
        for entry in self.structure.levels().filter(|entry| entry.is_level()) {
            let Some(tpl) = entry.effective_template(self.structure.templates_map()) else {
                continue;
            };
            for module in tpl.prose_modules() {
                let doc = DocId::Body(BodyDocId::new(entry.id.clone(), module.id.clone()));
                let raw = read_copy(lib, &doc)?;
                if BorrowedProse::new(&raw, &doc)?
                    .view()
                    .paragraphs()
                    .any(|p| !Para::of(&p).is_empty())
                {
                    filled.insert(doc);
                }
            }
        }
        Ok(BookLayout::new(
            &self.structure,
            &self.folders,
            &self.assets,
            &filled,
            names,
        ))
    }

    pub fn template(&self, body: &BodyDocId) -> Option<&EntryTemplate> {
        let entry = self
            .structure
            .entry(body.entry())
            .filter(|entry| !entry.is_trashed())?;
        let template = entry.effective_template(self.structure.templates_map())?;
        template
            .module(body.module())
            .filter(|module| module.kind == ModuleKind::Prose)?;
        Some(template)
    }

    pub fn headers(
        &self,
        body: &BodyDocId,
        layout: &BookLayout,
        links: &FileLinks<'_>,
        options: &Options,
    ) -> Option<(EntryTemplateId, Header)> {
        let tpl = self.template(body)?;
        let entry = self.structure.entry(body.entry())?;
        let hosts = layout
            .memberships
            .get(body.entry())
            .cloned()
            .unwrap_or_default();
        let header = Header::for_entry(entry, tpl, &options.labels, hosts, |kind, id| match kind {
            FieldType::EntityRef => layout.entry_links.get(&EntryId::parse(id).ok()?).cloned(),
            FieldType::Image => {
                let id = AssetId::parse(id).ok()?;
                links.destination(&id).map(|path| {
                    format!(
                        "[{}]({path})",
                        links.asset(&id).map_or("", |f| f.name.as_str())
                    )
                })
            }
            _ => None,
        });
        Some((tpl.id.clone(), header))
    }

    pub fn restore(&self, body: &BodyDocId) -> Vec<String> {
        self.restores
            .get(body.entry().as_str())
            .cloned()
            .unwrap_or_default()
    }

    pub fn accepts(&self, body: &BodyDocId, old: &Version) -> bool {
        !old.retired
            && self.epoch == old.epoch
            && self.template(body).is_some_and(|t| t.id == old.template)
            && self.restore(body) == old.restore
    }

    pub fn title_for(&self, body: &BodyDocId) -> &str {
        self.structure
            .entry(body.entry())
            .map_or("", |entry| entry.title.as_str())
    }
}

pub(super) fn render_prose(
    raw: &LoroDoc,
    doc: &DocId,
    links: &FileLinks<'_>,
) -> Result<(String, Vec<AssetFile>)> {
    let prose = BorrowedProse::new(raw, doc)?;
    let view = prose.view();
    let projection: Vec<_> = view
        .paragraphs()
        .map(|p| Para::project(&view, &p, links))
        .collect();
    let mut used = BTreeSet::new();
    for para in &projection {
        if let Kind::Asset { asset, .. } = &para.kind {
            used.insert(asset);
        }
        let cells = if let Kind::Table(rows) = &para.kind {
            rows.as_slice()
        } else {
            &[]
        };
        for span in std::iter::once(para).chain(cells.iter().flatten()) {
            used.extend(span.marks.iter().filter_map(|mark| mark.file.as_ref()));
        }
    }
    let files = used
        .into_iter()
        .filter_map(|id| links.asset(id).cloned())
        .collect();
    Ok((render_with(&projection, links), files))
}

fn restore_epochs(lib: &Library, book: &BookId) -> Result<BTreeMap<String, Vec<String>>> {
    let doc = DocId::Checkpoints(book.clone()).to_string();
    let raw = match lib.load_copy(&doc) {
        Ok(raw) => raw,
        Err(StoreError::NotFound(_)) => return Ok(BTreeMap::new()),
        Err(err) => return Err(err.into()),
    };
    let view = BorrowedCheckpoints::new(&raw, book)?;
    let mut restores: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, manifest) in view.view().entry_checkpoints() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&manifest)
            && value["reason"] == "restore"
            && let Some(entry) = value["entry"].as_str()
        {
            restores.entry(entry.to_owned()).or_default().push(id);
        }
    }
    restores.values_mut().for_each(|points| points.sort());
    Ok(restores)
}

pub(super) fn read_copy(lib: &Library, doc: &DocId) -> Result<LoroDoc> {
    match lib.load_copy(&doc.to_string()) {
        Ok(raw) => Ok(raw),
        Err(StoreError::NotFound(_)) => {
            let raw = LoroDoc::new();
            dr_doc::schema::configure(&raw);
            raw.import(&dr_doc::prose::genesis(doc))?;
            Ok(raw)
        }
        Err(err) => Err(err.into()),
    }
}

pub(super) fn check_active(
    lib: &Library,
    book: &BookId,
    id: &BodyDocId,
    version: &Version,
) -> Result<bool> {
    if lib.epoch() != version.epoch {
        return Ok(false);
    }
    let doc = DocId::Body(id.clone());
    if lib
        .doc_info(&doc.to_string())?
        .is_some_and(|info| info.book_id.as_deref() != Some(book.as_str()))
    {
        return Ok(false);
    }
    let raw = lib.load_copy(&DocId::Book(book.clone()).to_string())?;
    let view = BorrowedBookV3::new(&raw, book)?;
    let view = view.view();
    let Some(entry) = view.entry(id.entry()).filter(|e| !e.is_trashed()) else {
        return Ok(false);
    };
    let templates = view.templates_map();
    let active = entry
        .effective_template(&templates)
        .is_some_and(|template| {
            template.id == version.template
                && template
                    .module(id.module())
                    .is_some_and(|module| module.kind == ModuleKind::Prose)
        });
    Ok(active
        && view.meta().deleted_at.is_none()
        && restore_epochs(lib, book)?
            .get(id.entry().as_str())
            .cloned()
            .unwrap_or_default()
            == version.restore)
}

pub(super) fn import(
    ws: &Workspace,
    book: &BookId,
    id: &BodyDocId,
    version: &Version,
    head: Frontiers,
    update: Vec<u8>,
) -> Result<bool> {
    if update.is_empty() {
        return Ok(true);
    }
    if !check_active(ws.library(), book, id, version)? {
        return Ok(false);
    }
    let doc = DocId::Body(id.clone());
    let key = doc.to_string();
    if ws.library().doc_info(&key)?.is_none() {
        ws.call(
            &Actor::Mirror,
            "module.prose_document",
            serde_json::json!({"book":book,"owner":id.entry(),"module":id.module()}),
        )?;
    }
    let handle = ws.library().open_doc(&key, OpenDoc::Existing)?;
    let lib = ws.library().clone();
    let book = book.clone();
    let id = id.clone();
    let version = version.clone();
    let (applied, _) = handle.write(Origin::Mirror, move |live| -> Result<bool> {
        if live.oplog_frontiers() != head || !check_active(&lib, &book, &id, &version)? {
            return Ok(false);
        }
        let result = live.import(&update)?;
        if result.pending.is_some() {
            return Err(SyncError::Invalid(
                "mirror update is missing its base".into(),
            ));
        }
        Ok(true)
    })?;
    if applied? {
        ws.repair_after_sync(&key);
        Ok(true)
    } else {
        Ok(false)
    }
}
