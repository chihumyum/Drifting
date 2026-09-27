//! Element patches (设定补丁) through the C ABI. Every reply lists the
//! affected element's patches in order; `nodePatches` lists a chapter's.
use super::elements::present;
use super::*;
use drifting_core::workspace::{NewPatch, PatchChanges, PatchSource};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PatchSourceInput {
    node_id: String,
    #[serde(default)]
    block_id: Option<String>,
    #[serde(default)]
    block_text: Option<String>,
    #[serde(default)]
    anchor_text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum PatchCommand {
    Patches {
        element_id: String,
    },
    NodePatches {
        node_id: String,
    },
    CreatePatch {
        element_id: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        body: String,
        #[serde(default)]
        source: Option<PatchSourceInput>,
    },
    /// Absent fields stay; `title: null` clears the title.
    UpdatePatch {
        patch_id: String,
        #[serde(default, deserialize_with = "present")]
        title: Option<Option<String>>,
        #[serde(default)]
        body: Option<String>,
    },
    MovePatch {
        patch_id: String,
        #[serde(default)]
        before: Option<String>,
    },
    DeletePatch {
        patch_id: String,
    },
}

impl WorkspaceSession {
    pub(super) fn patches(
        &mut self,
        project_id: &str,
        command: &PatchCommand,
    ) -> Result<Value, String> {
        let project = self.project(project_id)?;
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        let element_of = |patch_id: &str| -> Result<String, String> {
            self.gateway
                .query(
                    "SELECT element_id FROM element_patch WHERE id=? AND project_id=?".into(),
                    vec![
                        DatabaseValue::Text(patch_id.into()),
                        DatabaseValue::Text(project_id.into()),
                    ],
                    None,
                    CLIENT.into(),
                )?
                .rows
                .first()
                .and_then(|row| match &row[0] {
                    DatabaseValue::Text(id) => Some(id.clone()),
                    _ => None,
                })
                .ok_or_else(|| "这个补丁不存在".into())
        };
        let (result, element) = match command {
            PatchCommand::Patches { element_id } => (Value::Null, Some(element_id.clone())),
            PatchCommand::NodePatches { node_id } => {
                return Ok(
                    json!({"result": Value::Null, "patches": store.node_patches(project_id, node_id)?}),
                );
            }
            PatchCommand::CreatePatch {
                element_id,
                title,
                body,
                source,
            } => (
                json!(store.create_patch(
                    &self.context(&project)?,
                    NewPatch {
                        id: identifier("patch")?,
                        element_id: element_id.clone(),
                        title: title.clone(),
                        body: body.clone(),
                        source: source.as_ref().map(|source| PatchSource {
                            node_id: source.node_id.clone(),
                            block_id: source.block_id.clone(),
                            block_text: source.block_text.clone(),
                            anchor_text: source.anchor_text.clone(),
                        }),
                    },
                )?),
                Some(element_id.clone()),
            ),
            PatchCommand::UpdatePatch {
                patch_id,
                title,
                body,
            } => {
                let element = element_of(patch_id)?;
                (
                    json!(store.update_patch(
                        &self.context(&project)?,
                        patch_id,
                        PatchChanges {
                            title: title.clone(),
                            body: body.clone()
                        },
                    )?),
                    Some(element),
                )
            }
            PatchCommand::MovePatch { patch_id, before } => {
                let element = element_of(patch_id)?;
                store.move_patch(&self.context(&project)?, patch_id, before.as_deref())?;
                (Value::Null, Some(element))
            }
            PatchCommand::DeletePatch { patch_id } => {
                let element = element_of(patch_id)?;
                store.delete_patch(&self.context(&project)?, patch_id)?;
                (Value::Null, Some(element))
            }
        };
        let patches = match element {
            Some(element) => json!(store.element_patches(project_id, &element)?),
            None => json!([]),
        };
        Ok(json!({"result": result, "patches": patches}))
    }
}
