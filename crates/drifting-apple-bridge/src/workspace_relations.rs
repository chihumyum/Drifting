//! Relation types and curated relations between chapters, drifts, elements,
//! categories and storylines. Domain writes live in drifting-core; every reply
//! carries the complete relation library.
use super::*;
use drifting_core::workspace::RelationTypeDefinition;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum RelationCommand {
    Library,
    CreateType {
        definition: RelationTypeDefinition,
    },
    UpdateType {
        relation_type_id: String,
        definition: RelationTypeDefinition,
    },
    DeleteType {
        relation_type_id: String,
    },
    AddRelation {
        from_kind: String,
        from_id: String,
        to_kind: String,
        to_id: String,
        relation_type_id: String,
    },
    RemoveRelation {
        relation_id: String,
    },
    RetypeRelation {
        relation_id: String,
        relation_type_id: String,
        #[serde(default)]
        swap: bool,
    },
}

impl WorkspaceSession {
    pub(super) fn relations(
        &mut self,
        project_id: &str,
        command: &RelationCommand,
    ) -> Result<Value, String> {
        let project = self.project(project_id)?;
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        let result = match command {
            RelationCommand::Library => Value::Null,
            RelationCommand::CreateType { definition } => json!(store.create_relation_type(
                &self.context(&project)?,
                &identifier("relation-type")?,
                definition,
            )?),
            RelationCommand::UpdateType {
                relation_type_id,
                definition,
            } => json!(store.update_relation_type(
                &self.context(&project)?,
                relation_type_id,
                definition,
            )?),
            RelationCommand::DeleteType { relation_type_id } => {
                store.delete_relation_type(&self.context(&project)?, relation_type_id)?;
                Value::Null
            }
            RelationCommand::AddRelation {
                from_kind,
                from_id,
                to_kind,
                to_id,
                relation_type_id,
            } => json!(store.add_relation(
                &self.context(&project)?,
                &identifier("relation")?,
                (from_kind, from_id),
                (to_kind, to_id),
                relation_type_id,
            )?),
            RelationCommand::RemoveRelation { relation_id } => {
                store.remove_relation(&self.context(&project)?, relation_id)?;
                Value::Null
            }
            RelationCommand::RetypeRelation {
                relation_id,
                relation_type_id,
                swap,
            } => json!(store.retype_relation(
                &self.context(&project)?,
                relation_id,
                relation_type_id,
                *swap,
            )?),
        };
        Ok(json!({
            "result": result,
            "library": {
                "types": store.relation_types(project_id)?,
                "relations": store.relations(project_id)?,
            },
        }))
    }
}
