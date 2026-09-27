//! Derived prose projections of chapter and drift bodies: the renderer's
//! `persistNodeProseProjectionInTransaction` (body cache, outline and the
//! canonical word count with its basis) and the counts read from them. These
//! are local projections; they never write sync originals.
use super::*;

#[cfg(test)]
mod tests;

/// One exact Yjs state's projection, derived by the prose owner.
#[derive(Clone, Debug, PartialEq)]
pub struct NodeProjection {
    pub content_json: String,
    pub outline_json: String,
    pub word_count: u64,
    pub basis_hash: String,
    /// The `yjs_document_revision` the projection was captured at.
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeWordCount {
    pub node_id: String,
    pub kind: String,
    /// `None` until a canonical basis exists (`hasCanonicalWordCount`).
    pub word_count: Option<u64>,
}

impl WorkspaceStore<'_> {
    /// Writes the projection unless the stored one is already exact
    /// (`canReuseCanonicalProjection`). A stale revision is refused so the
    /// caller can capture again. `touch` also stamps the node's and body's
    /// `updated_at`, as an editor save does; reconciliation does not.
    pub fn materialize_node_projection(
        &self,
        project_id: &str,
        node_id: &str,
        projection: &NodeProjection,
        now_iso: &str,
        touch: bool,
    ) -> Result<bool, String> {
        if !opaque(node_id) || !projection.basis_hash.starts_with("sha256:") {
            return Err("Invalid node projection".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            let doc_id = format!("node-content:{node_id}");
            let actual = ProseRepository::new(self.gateway, self.client).get_revision(&doc_id, Some(tx))?;
            if actual != projection.revision {
                return Err(format!(
                    "STALE_PROSE_METRIC_REVISION: node {node_id} expected Yjs revision {}, received {actual}",
                    projection.revision
                ));
            }
            let rows = self.query(Some(tx), r#"
                SELECT n.word_count,n.word_count_basis_kind,n.word_count_basis_hash,n.word_count_basis_revision,
                    n.word_count_basis_server_seq,c.content_json,c.outline_json
                FROM book_node n LEFT JOIN node_content c ON c.node_id=n.id
                WHERE n.id=? AND n.project_id=? AND n.deleted_at IS NULL
            "#, vec![text(node_id), text(project_id)])?;
            let row = rows.first().ok_or("Node no longer exists")?;
            let optional_text = |index: usize| match &row[index] {
                V::Text(value) => Some(value.clone()),
                _ => None,
            };
            let optional_integer = |index: usize| match &row[index] {
                V::Integer(value) => value.parse::<i64>().ok(),
                V::Real(value) => Some(*value as i64),
                _ => None,
            };
            let reusable = optional_text(1).as_deref() == Some("yjs")
                && optional_text(2).as_deref() == Some(projection.basis_hash.as_str())
                && optional_integer(0) == Some(projection.word_count as i64)
                && (optional_integer(4).is_some()
                    || optional_integer(3) == Some(projection.revision as i64))
                && optional_text(5).as_deref() == Some(projection.content_json.as_str())
                && optional_text(6).as_deref() == Some(projection.outline_json.as_str());
            if reusable {
                return Ok(false);
            }
            if row[5] == V::Null {
                self.execute(tx, r#"
                    INSERT INTO node_content(node_id,content_json,outline_json,plot_grid_json,created_at,updated_at)
                    VALUES (?,?,?,'{}',?,?)
                "#, vec![text(node_id), text(&projection.content_json), text(&projection.outline_json),
                    text(now_iso), text(now_iso)])?;
            } else if touch {
                self.execute(tx, "UPDATE node_content SET content_json=?,outline_json=?,updated_at=? WHERE node_id=?",
                    vec![text(&projection.content_json), text(&projection.outline_json), text(now_iso), text(node_id)])?;
            } else {
                self.execute(tx, "UPDATE node_content SET content_json=?,outline_json=? WHERE node_id=?",
                    vec![text(&projection.content_json), text(&projection.outline_json), text(node_id)])?;
            }
            self.execute(tx, &format!(r#"
                UPDATE book_node SET word_count=?,word_count_basis_kind='yjs',word_count_basis_hash=?,
                    word_count_basis_revision=?,word_count_basis_server_seq=NULL{}
                WHERE id=? AND project_id=? AND deleted_at IS NULL
            "#, if touch { ",updated_at=?" } else { "" }), {
                let mut values = vec![V::Integer(projection.word_count.to_string()), text(&projection.basis_hash),
                    V::Integer(projection.revision.to_string())];
                if touch {
                    values.push(text(now_iso));
                }
                values.extend([text(node_id), text(project_id)]);
                values
            })?;
            Ok(true)
        })
    }

    /// Live chapters and drifts with their canonical word counts.
    pub fn node_word_counts(&self, project_id: &str) -> Result<Vec<NodeWordCount>, String> {
        self.query(None, r#"
            SELECT n.id,n.kind,n.word_count,n.word_count_basis_kind,n.word_count_basis_hash,
                n.word_count_basis_revision,n.word_count_basis_server_seq
            FROM book_node n JOIN sync_generation g ON g.project_id=n.project_id AND g.status='active'
            LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=g.sync_generation_id
                AND l.entity_kind='node' AND l.entity_id=n.id
            WHERE n.project_id=? AND n.deleted_at IS NULL AND (l.state IS NULL OR l.state='live')
            ORDER BY n.kind,n.book_order,n.created_at,n.id
        "#, vec![text(project_id)])?
        .iter()
        .map(|row| {
            let kind = match &row[3] {
                V::Text(kind) => Some(kind.as_str()),
                _ => None,
            };
            let hash_ok = matches!(&row[4], V::Text(hash) if hash.len() == 71 && hash.starts_with("sha256:")
                && hash[7..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
            let canonical = hash_ok
                && match kind {
                    Some("seed") => true,
                    Some(_) => row[5] != V::Null || row[6] != V::Null,
                    None => false,
                };
            Ok(NodeWordCount {
                node_id: string(row, 0)?,
                kind: string(row, 1)?,
                word_count: match (&row[2], canonical) {
                    (V::Integer(value), true) => value.parse().ok(),
                    (V::Real(value), true) => Some(*value as u64),
                    _ => None,
                },
            })
        })
        .collect()
    }
}
