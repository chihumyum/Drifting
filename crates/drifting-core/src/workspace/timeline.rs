//! The story timeline: chapters' narrative (story-time) order beside their
//! book order, timeline markers on the narrative axis (optionally captioned
//! by a bound drift) and drift card positions on the story graph.
use super::*;

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineNode {
    pub id: String,
    pub kind: String,
    pub narrative_order: Option<f64>,
    pub position_x: f64,
    pub position_y: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineMarker {
    pub id: String,
    pub narrative_order: f64,
    pub label: String,
    pub drift_node_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTimeline {
    pub nodes: Vec<TimelineNode>,
    pub markers: Vec<TimelineMarker>,
}

fn finite(value: f64, what: &str) -> Result<f64, String> {
    if value.is_finite() {
        Ok(value)
    } else {
        Err(format!("{what} must be finite"))
    }
}

impl WorkspaceStore<'_> {
    pub fn timeline(&self, project_id: &str) -> Result<WorkspaceTimeline, String> {
        let nodes = self
            .query(None, r#"
                SELECT n.id,n.kind,n.narrative_order,n.position_x,n.position_y FROM book_node n
                JOIN sync_generation g ON g.project_id=n.project_id AND g.status='active'
                LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=g.sync_generation_id
                    AND l.entity_kind='node' AND l.entity_id=n.id
                WHERE n.project_id=? AND n.deleted_at IS NULL AND (l.state IS NULL OR l.state='live')
                ORDER BY n.kind,n.book_order,n.created_at,n.id
            "#, vec![text(project_id)])?
            .iter()
            .map(|row| {
                Ok(TimelineNode {
                    id: string(row, 0)?,
                    kind: string(row, 1)?,
                    narrative_order: if row[2] == V::Null { None } else { Some(number(row, 2)?) },
                    position_x: number(row, 3)?,
                    position_y: number(row, 4)?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(WorkspaceTimeline {
            nodes,
            markers: self.markers(None, project_id)?,
        })
    }

    /// A chapter's place in story time (`null` removes it from the narrative
    /// axis); the node revision advances by at least 1 ms.
    pub fn set_narrative_order(
        &self,
        context: &AuthoredProseContext,
        chapter_id: &str,
        order: Option<f64>,
    ) -> Result<TimelineNode, String> {
        validate_context(context)?;
        if let Some(order) = order {
            finite(order, "Narrative order")?;
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let (current, incarnation) = self.timeline_node(tx, context, chapter_id)?;
            if current.kind != "chapter" {
                return Err("只有章节能放在故事时间线上".into());
            }
            if current.narrative_order == order {
                return Ok(current);
            }
            self.execute(tx, r#"
                UPDATE book_node SET narrative_order=?1,updated_at=CASE
                    WHEN julianday(updated_at) IS NULL OR julianday(?2)>julianday(updated_at) THEN ?2
                    ELSE strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds') END
                WHERE id=?3 AND project_id=?4
            "#, vec![order.map(V::Real).unwrap_or(V::Null), text(&context.now_iso), text(chapter_id),
                text(&context.project_id)])?;
            self.commit_changes(tx, context, &[journal::Mutation::field("node", chapter_id, incarnation,
                "narrativeOrder", json!(order))], None)?;
            Ok(self.timeline_node(tx, context, chapter_id)?.0)
        })
    }

    /// A card's place on the story graph (`tuple.set graph.position`).
    pub fn set_node_position(
        &self,
        context: &AuthoredProseContext,
        node_id: &str,
        x: f64,
        y: f64,
    ) -> Result<TimelineNode, String> {
        validate_context(context)?;
        finite(x, "Position")?;
        finite(y, "Position")?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let (current, incarnation) = self.timeline_node(tx, context, node_id)?;
            if (current.position_x, current.position_y) == (x, y) {
                return Ok(current);
            }
            self.execute(tx, "UPDATE book_node SET position_x=?,position_y=?,updated_at=? WHERE id=? AND project_id=?",
                vec![V::Real(x), V::Real(y), text(&context.now_iso), text(node_id), text(&context.project_id)])?;
            self.commit_changes(tx, context, &[journal::Mutation::json("entity", "node", node_id, "tuple.set",
                json!({"tuple": "graph.position", "value": {"x": x, "y": y}})).at_incarnation(incarnation)], None)?;
            Ok(self.timeline_node(tx, context, node_id)?.0)
        })
    }

    /// A label-less marker must be bound to a drift, which captions it.
    pub fn create_marker(
        &self,
        context: &AuthoredProseContext,
        id: &str,
        narrative_order: f64,
        label: &str,
        drift_id: Option<&str>,
    ) -> Result<TimelineMarker, String> {
        validate_context(context)?;
        finite(narrative_order, "Marker order")?;
        let label = js_trim(label);
        if !opaque(id) || (label.is_empty() && drift_id.is_none()) {
            return Err("时间标记需要名称，或绑定一条漂流".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            if let Some(drift) = drift_id {
                self.guard_marker_drift(tx, context, drift)?;
            }
            self.execute(tx, r#"
                INSERT INTO timeline_marker(id,project_id,narrative_order,label,drift_node_id,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?)
            "#, vec![text(id), text(&context.project_id), V::Real(narrative_order), text(label),
                drift_id.map(text).unwrap_or(V::Null), text(&context.now_iso), text(&context.now_iso)])?;
            self.commit_changes(tx, context, &[journal::Mutation::create("timeline-marker", id, json!({
                "narrativeOrder": narrative_order, "label": label, "driftNodeId": drift_id,
            }))], None)?;
            self.marker(tx, context, id)
        })
    }

    /// Present fields change; `Some(None)` unbinds the drift. Unchanged
    /// fields write nothing.
    pub fn update_marker(
        &self,
        context: &AuthoredProseContext,
        id: &str,
        narrative_order: Option<f64>,
        label: Option<&str>,
        drift_id: Option<Option<&str>>,
    ) -> Result<TimelineMarker, String> {
        validate_context(context)?;
        if let Some(order) = narrative_order {
            finite(order, "Marker order")?;
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let current = self.marker(tx, context, id)?;
            let incarnation = self.marker_incarnation(tx, context, id)?;
            let order = narrative_order.unwrap_or(current.narrative_order);
            let label = label.map(js_trim).unwrap_or(&current.label).to_string();
            let drift = drift_id.map(|d| d.map(String::from)).unwrap_or(current.drift_node_id.clone());
            if label.is_empty() && drift.is_none() {
                return Err("时间标记需要名称，或绑定一条漂流".into());
            }
            if let Some(drift) = drift.as_deref().filter(|d| Some(*d) != current.drift_node_id.as_deref()) {
                self.guard_marker_drift(tx, context, drift)?;
            }
            let mut mutations = Vec::new();
            if drift != current.drift_node_id {
                mutations.push(journal::Mutation::field("timeline-marker", id, incarnation, "driftNodeId", json!(drift)));
            }
            if label != current.label {
                mutations.push(journal::Mutation::field("timeline-marker", id, incarnation, "label", json!(label)));
            }
            if order != current.narrative_order {
                mutations.push(journal::Mutation::field("timeline-marker", id, incarnation, "narrativeOrder", json!(order)));
            }
            if mutations.is_empty() {
                return Ok(current);
            }
            self.execute(tx, "UPDATE timeline_marker SET narrative_order=?,label=?,drift_node_id=?,updated_at=? WHERE id=? AND project_id=?",
                vec![V::Real(order), text(&label), drift.as_deref().map(text).unwrap_or(V::Null), text(&context.now_iso),
                    text(id), text(&context.project_id)])?;
            self.commit_changes(tx, context, &mutations, None)?;
            self.marker(tx, context, id)
        })
    }

    pub fn delete_marker(&self, context: &AuthoredProseContext, id: &str) -> Result<(), String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            self.marker(tx, context, id)?;
            let journaled = self.query(Some(tx), "SELECT 1 FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind='timeline-marker' AND entity_id=?",
                vec![text(&context.sync_generation_id), text(id)])?;
            let incarnation = self.marker_incarnation(tx, context, id)?;
            self.execute(tx, "DELETE FROM timeline_marker WHERE id=? AND project_id=?",
                vec![text(id), text(&context.project_id)])?;
            // A marker from before native journaling has no lifecycle to purge.
            if !journaled.is_empty() {
                self.commit_changes(tx, context, &[journal::Mutation::json("entity", "timeline-marker", id,
                    "entity.purge", json!({})).at_incarnation(incarnation)], None)?;
            }
            Ok(())
        })
    }

    fn guard_marker_drift(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        drift: &str,
    ) -> Result<(), String> {
        let live = self.query(Some(tx), "SELECT 1 FROM book_node WHERE id=? AND project_id=? AND kind='drift' AND deleted_at IS NULL",
            vec![text(drift), text(&context.project_id)])?;
        if live.is_empty() {
            return Err("只能绑定未删除的漂流".into());
        }
        Ok(())
    }

    fn timeline_node(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        id: &str,
    ) -> Result<(TimelineNode, u64), String> {
        let rows = self.query(Some(tx), r#"
            SELECT n.id,n.kind,n.narrative_order,n.position_x,n.position_y,l.incarnation,l.state FROM book_node n
            LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=? AND l.entity_kind='node' AND l.entity_id=n.id
            WHERE n.id=? AND n.project_id=? AND n.deleted_at IS NULL
        "#, vec![text(&context.sync_generation_id), text(id), text(&context.project_id)])?;
        let row = rows.first().ok_or("章节或漂流不存在")?;
        if !matches!(&row[6], V::Null) && string(row, 6)? != "live" {
            return Err("章节或漂流不存在".into());
        }
        let incarnation = match &row[5] {
            V::Null => 0,
            V::Integer(v) => v
                .parse::<u64>()
                .ok()
                .filter(|n| *n <= MAX_SAFE)
                .ok_or("Invalid node incarnation")?,
            _ => return Err("Invalid node incarnation".into()),
        };
        Ok((
            TimelineNode {
                id: string(row, 0)?,
                kind: string(row, 1)?,
                narrative_order: if row[2] == V::Null {
                    None
                } else {
                    Some(number(row, 2)?)
                },
                position_x: number(row, 3)?,
                position_y: number(row, 4)?,
            },
            incarnation,
        ))
    }

    fn markers(&self, tx: Option<u64>, project_id: &str) -> Result<Vec<TimelineMarker>, String> {
        self.query(tx, "SELECT id,narrative_order,label,drift_node_id,created_at,updated_at FROM timeline_marker WHERE project_id=? ORDER BY narrative_order,created_at,id",
            vec![text(project_id)])?
            .iter()
            .map(|row| {
                Ok(TimelineMarker {
                    id: string(row, 0)?,
                    narrative_order: number(row, 1)?,
                    label: string(row, 2)?,
                    drift_node_id: if row[3] == V::Null { None } else { Some(string(row, 3)?) },
                    created_at: string(row, 4)?,
                    updated_at: string(row, 5)?,
                })
            })
            .collect()
    }

    fn marker(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        id: &str,
    ) -> Result<TimelineMarker, String> {
        self.markers(Some(tx), &context.project_id)?
            .into_iter()
            .find(|marker| marker.id == id)
            .ok_or_else(|| "时间标记不存在".into())
    }

    fn marker_incarnation(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        id: &str,
    ) -> Result<u64, String> {
        let rows = self.query(Some(tx), "SELECT incarnation,state FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind='timeline-marker' AND entity_id=?",
            vec![text(&context.sync_generation_id), text(id)])?;
        match rows.first() {
            // Markers from before native journaling have no lifecycle.
            None => Ok(0),
            Some(row) if string(row, 1)? == "live" => match &row[0] {
                V::Integer(v) => v.parse::<u64>().map_err(|e| e.to_string()),
                _ => Err("Invalid marker incarnation".into()),
            },
            Some(_) => Err("时间标记不存在".into()),
        }
    }
}
