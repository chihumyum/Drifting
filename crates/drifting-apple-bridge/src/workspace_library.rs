//! The materials library (素材库) and element portraits. Bytes live in the
//! workspace's app-owned asset store; rows and journals in SQLite.
use super::*;
use drifting_core::asset_store::AssetStore;
use drifting_core::workspace::NewAssetFile;
use std::path::Path;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AssetFile {
    path: String,
    mime: String,
    extension: String,
    #[serde(default)]
    width: Option<u64>,
    #[serde(default)]
    height: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum LibraryCommand {
    Library,
    ImportFile {
        title: String,
        file: AssetFile,
    },
    CreateLink {
        title: String,
        url: String,
    },
    CreateText {
        title: String,
        body: String,
    },
    UpdateItem {
        item_id: String,
        title: Option<String>,
        notes: Option<String>,
        body: Option<String>,
    },
    DeleteItem {
        item_id: String,
    },
    /// Before `before`, or last when absent; the reply lists the new order.
    MoveItem {
        item_id: String,
        #[serde(default)]
        before: Option<String>,
    },
    SetPortrait {
        element_id: String,
        /// Absent or null clears the portrait.
        #[serde(default)]
        file: Option<AssetFile>,
    },
}

fn file(file: &AssetFile) -> Result<NewAssetFile<'_>, String> {
    Ok(NewAssetFile {
        asset_id: identifier("asset")?,
        mime: file.mime.clone(),
        extension: file.extension.clone(),
        width: file.width,
        height: file.height,
        source: Path::new(&file.path),
    })
}

impl WorkspaceSession {
    pub(super) fn assets(&self) -> AssetStore {
        AssetStore::new(self.directory.join("assets"), self.installation_id.clone())
    }

    pub(super) fn library(
        &mut self,
        project_id: &str,
        command: &LibraryCommand,
    ) -> Result<Value, String> {
        let project = self.project(project_id)?;
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        let assets = self.assets();
        let result = match command {
            LibraryCommand::Library => Value::Null,
            LibraryCommand::ImportFile {
                title,
                file: source,
            } => json!(store.import_library_file(
                &self.context(&project)?,
                &assets,
                &identifier("library")?,
                title,
                file(source)?,
            )?),
            LibraryCommand::CreateLink { title, url } => json!(store.create_library_link(
                &self.context(&project)?,
                &identifier("library")?,
                title,
                url,
            )?),
            LibraryCommand::CreateText { title, body } => json!(store.create_library_text(
                &self.context(&project)?,
                &identifier("library")?,
                title,
                body,
            )?),
            LibraryCommand::UpdateItem {
                item_id,
                title,
                notes,
                body,
            } => json!(store.update_library_item(
                &self.context(&project)?,
                item_id,
                title.as_deref(),
                notes.as_deref(),
                body.as_deref(),
            )?),
            LibraryCommand::DeleteItem { item_id } => {
                store.delete_library_item(&self.context(&project)?, &assets, item_id)?;
                Value::Null
            }
            LibraryCommand::MoveItem { item_id, before } => {
                store.move_library_item(&self.context(&project)?, item_id, before.as_deref())?;
                Value::Null
            }
            LibraryCommand::SetPortrait {
                element_id,
                file: source,
            } => json!(store.set_element_portrait(
                &self.context(&project)?,
                &assets,
                element_id,
                source.as_ref().map(file).transpose()?,
            )?),
        };
        // Hosts read committed bytes from these paths; they never write them.
        let path = |asset: &drifting_core::workspace::WorkspaceAsset| {
            assets
                .path(project_id, &asset.id, &asset.extension)
                .map(|path| path.to_string_lossy().into_owned())
                .ok()
        };
        let items: Vec<Value> = store
            .library_items(project_id)?
            .into_iter()
            .map(|item| {
                let file = item.asset.as_ref().and_then(path);
                let mut value = json!(item);
                value["assetPath"] = json!(file);
                value
            })
            .collect();
        let portraits: Vec<Value> = store
            .element_portraits(project_id)?
            .into_iter()
            .map(|portrait| {
                let file = path(&portrait.asset);
                let mut value = json!(portrait);
                value["assetPath"] = json!(file);
                value
            })
            .collect();
        Ok(json!({"result": result, "library": {"items": items, "portraits": portraits}}))
    }
}
