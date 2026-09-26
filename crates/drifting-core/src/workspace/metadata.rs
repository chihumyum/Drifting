//! Node metadata (chapter and drift summary and writing status) and project
//! summary, facts and storyline-template facts: the renderer's
//! updateNodeSummary, updateNode({ writingStatus }) and updateProject originals.
use super::facts::{Fact, FactOwner};
use super::*;

#[cfg(test)]
mod tests;

const CHAPTER_STATUSES: [&str; 3] = ["draft", "finished", "discarded"];
const DRIFT_STATUSES: [&str; 2] = ["drifting", "resting"];

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceNodeMetadata {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub writing_status: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProjectDetails {
    #[serde(flatten)]
    pub project: WorkspaceProject,
    pub facts: Vec<Fact>,
    pub storyline_template: Vec<Fact>,
}

/// Absent fields are left alone, as in `UpdateProjectInput`.
#[derive(Default)]
pub struct ProjectChanges {
    pub summary: Option<String>,
    pub facts: Option<Vec<Fact>>,
    pub storyline_template: Option<Vec<Fact>>,
}

impl WorkspaceStore<'_> {
    pub fn project_details(&self, project_id: &str) -> Result<WorkspaceProjectDetails, String> {
        self.project_details_in(None, project_id)
    }

    /// One original: facts, then storyline-template facts (each through the
    /// KV authority), then `field.set summary`. `updated_at` is stamped only
    /// when something is written.
    pub fn update_project(
        &self,
        context: &AuthoredProseContext,
        changes: ProjectChanges,
        new_fact_id: &mut dyn FnMut() -> Result<String, String>,
    ) -> Result<WorkspaceProjectDetails, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            let incarnation = self.guard_project(tx, context)?;
            let current = self.project_details_in(Some(tx), &context.project_id)?;
            let mut mutations = Vec::new();
            for (namespace, column, desired) in [
                ("facts", "kv_json", &changes.facts),
                (
                    "storyline-template",
                    "storyline_template_kv_json",
                    &changes.storyline_template,
                ),
            ] {
                let Some(desired) = desired else { continue };
                let before = mutations.len();
                let projection = self.replace_facts(
                    tx,
                    context,
                    FactOwner {
                        kind: "project",
                        id: &context.project_id,
                        namespace,
                    },
                    desired,
                    new_fact_id,
                    &mut mutations,
                )?;
                if mutations.len() > before {
                    self.execute(
                        tx,
                        &format!("UPDATE project SET {column}=? WHERE id=?"),
                        vec![text(&projection), text(&context.project_id)],
                    )?;
                }
            }
            if let Some(summary) = &changes.summary {
                if *summary != current.project.summary {
                    self.execute(
                        tx,
                        "UPDATE project SET summary=? WHERE id=?",
                        vec![text(summary), text(&context.project_id)],
                    )?;
                    mutations.push(journal::Mutation::field(
                        "project",
                        &context.project_id,
                        incarnation,
                        "summary",
                        json!(summary),
                    ));
                }
            }
            if mutations.is_empty() {
                return Ok(current);
            }
            self.execute(
                tx,
                "UPDATE project SET updated_at=? WHERE id=?",
                vec![text(&context.now_iso), text(&context.project_id)],
            )?;
            self.commit_changes(tx, context, &mutations, None)?;
            self.project_details_in(Some(tx), &context.project_id)
        })
    }

    pub fn node_metadata(
        &self,
        project_id: &str,
        node_id: &str,
    ) -> Result<WorkspaceNodeMetadata, String> {
        let rows = self.query(None, r#"
            SELECT n.id,n.kind,n.title,n.summary,n.writing_status,n.updated_at FROM book_node n
            JOIN sync_generation g ON g.project_id=n.project_id AND g.status='active'
            LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=g.sync_generation_id
                AND l.entity_kind='node' AND l.entity_id=n.id
            WHERE n.id=? AND n.project_id=? AND n.deleted_at IS NULL AND (l.state IS NULL OR l.state='live')
        "#, vec![text(node_id), text(project_id)])?;
        metadata_from_row(
            rows.first()
                .ok_or("Chapter or drift is not available in this project")?,
        )
    }

    /// updateNodeSummary: the wall-clock stamp and one `field.set summary`.
    pub fn set_node_summary(
        &self,
        context: &AuthoredProseContext,
        node_id: &str,
        summary: &str,
    ) -> Result<WorkspaceNodeMetadata, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let (node, incarnation) = self.live_node(tx, context, node_id)?;
            if node.summary == summary {
                return Ok(node);
            }
            self.execute(
                tx,
                "UPDATE book_node SET summary=?,updated_at=? WHERE id=? AND project_id=?",
                vec![
                    text(summary),
                    text(&context.now_iso),
                    text(node_id),
                    text(&context.project_id),
                ],
            )?;
            self.commit_changes(
                tx,
                context,
                &[journal::Mutation::field(
                    "node",
                    node_id,
                    incarnation,
                    "summary",
                    json!(summary),
                )],
                None,
            )?;
            Ok(self.live_node(tx, context, node_id)?.0)
        })
    }

    /// updateNode({ writingStatus }): chapters take draft/finished/discarded,
    /// drifts drifting/resting; the node revision advances by at least 1 ms.
    pub fn set_node_status(
        &self,
        context: &AuthoredProseContext,
        node_id: &str,
        status: &str,
    ) -> Result<WorkspaceNodeMetadata, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let (node, incarnation) = self.live_node(tx, context, node_id)?;
            let allowed: &[&str] = if node.kind == "drift" { &DRIFT_STATUSES } else { &CHAPTER_STATUSES };
            if !allowed.contains(&status) {
                return Err(format!("A {} cannot have status {status}", node.kind));
            }
            if node.writing_status == status {
                return Ok(node);
            }
            self.execute(tx, r#"
                UPDATE book_node SET writing_status=?1,updated_at=CASE
                    WHEN julianday(updated_at) IS NULL OR julianday(?2)>julianday(updated_at) THEN ?2
                    ELSE strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds')
                END WHERE id=?3 AND project_id=?4
            "#, vec![text(status), text(&context.now_iso), text(node_id), text(&context.project_id)])?;
            self.commit_changes(tx, context, &[journal::Mutation::field("node", node_id, incarnation,
                "writingStatus", json!(status))], None)?;
            Ok(self.live_node(tx, context, node_id)?.0)
        })
    }

    fn live_node(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        node_id: &str,
    ) -> Result<(WorkspaceNodeMetadata, u64), String> {
        let rows = self.query(Some(tx), r#"
            SELECT n.id,n.kind,n.title,n.summary,n.writing_status,n.updated_at,l.incarnation,l.state FROM book_node n
            LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=? AND l.entity_kind='node' AND l.entity_id=n.id
            WHERE n.id=? AND n.project_id=? AND n.kind IN ('chapter','drift') AND n.deleted_at IS NULL
        "#, vec![text(&context.sync_generation_id), text(node_id), text(&context.project_id)])?;
        let row = rows
            .first()
            .ok_or("Chapter or drift is not available in this project")?;
        if !matches!(&row[7], V::Null) && string(row, 7)? != "live" {
            return Err("Chapter or drift is not live".into());
        }
        let incarnation = match &row[6] {
            V::Null => 0,
            V::Integer(v) => v
                .parse::<u64>()
                .ok()
                .filter(|n| *n <= MAX_SAFE)
                .ok_or("Invalid node incarnation")?,
            _ => return Err("Invalid node incarnation".into()),
        };
        Ok((metadata_from_row(row)?, incarnation))
    }

    fn project_details_in(
        &self,
        tx: Option<u64>,
        project_id: &str,
    ) -> Result<WorkspaceProjectDetails, String> {
        let rows = self.query(
            tx,
            r#"
            SELECT p.id,p.name,p.summary,p.user_id,p.created_at,p.updated_at,
                   g.project_sync_id,g.sync_generation_id,p.kv_json,p.storyline_template_kv_json
            FROM project p JOIN sync_generation g ON g.project_id=p.id AND g.status='active'
            WHERE p.id=?
        "#,
            vec![text(project_id)],
        )?;
        let row = rows.first().ok_or("Project does not exist")?;
        let parse = |index| {
            serde_json::from_str::<Vec<Fact>>(&string(row, index)?).map_err(|e| e.to_string())
        };
        Ok(WorkspaceProjectDetails {
            project: project_from_row(row)?,
            facts: parse(8)?,
            storyline_template: parse(9)?,
        })
    }
}

fn metadata_from_row(row: &[V]) -> Result<WorkspaceNodeMetadata, String> {
    Ok(WorkspaceNodeMetadata {
        id: string(row, 0)?,
        kind: string(row, 1)?,
        title: string(row, 2)?,
        summary: string(row, 3)?,
        writing_status: string(row, 4)?,
        updated_at: string(row, 5)?,
    })
}
