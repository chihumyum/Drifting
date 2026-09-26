//! Direct chapter comments (`target_kind='node'`). Rows and canonical originals
//! commit together; anchor movement stays with the live prose owner, and body
//! or status writes never touch anchors, metadata or prose.
use super::*;

#[cfg(test)]
mod tests;

const COLUMNS: &str = "id,project_id,kind,target_kind,target_id,target_block_id,anchor_json,\
    author_kind,author_id,author_name,body_json,status,priority,source,metadata_json,\
    target_block_ids_json,resolved_at,created_at,updated_at";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceComment {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub target_kind: Option<String>,
    pub target_id: Option<String>,
    pub target_block_id: Option<String>,
    pub anchor_json: String,
    pub author_kind: String,
    pub author_id: Option<String>,
    pub author_name: Option<String>,
    pub body_json: String,
    pub status: String,
    pub priority: Option<String>,
    pub source: String,
    pub metadata_json: Option<String>,
    pub target_block_ids_json: String,
    pub resolved_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A manual note on a chapter selection. The anchor is captured by the live
/// prose owner from its current projection; this layer stores it verbatim.
pub struct NewChapterComment {
    pub id: String,
    pub chapter_id: String,
    pub author_id: String,
    pub body_text: String,
    pub anchor_json: String,
    pub target_block_ids: Vec<String>,
}

impl WorkspaceStore<'_> {
    /// Comments whose direct target is this chapter, in the renderer's order.
    pub fn chapter_comments(
        &self,
        project_id: &str,
        chapter_id: &str,
    ) -> Result<Vec<WorkspaceComment>, String> {
        self.query(
            None,
            &format!("SELECT {COLUMNS} FROM comment WHERE project_id=? AND target_kind='node' AND target_id=? ORDER BY created_at,rowid"),
            vec![text(project_id), text(chapter_id)],
        )?
        .iter()
        .map(|row| comment_from_row(row))
        .collect()
    }

    pub fn create_chapter_comment(
        &self,
        context: &AuthoredProseContext,
        input: NewChapterComment,
    ) -> Result<WorkspaceComment, String> {
        validate_context(context)?;
        if !opaque(&input.id) || !opaque(&input.chapter_id) || !opaque(&input.author_id) {
            return Err("Invalid comment, chapter or author identity".into());
        }
        if js_trim(&input.body_text).is_empty() {
            return Err("Comment body is empty".into());
        }
        let first_block = input
            .target_block_ids
            .first()
            .filter(|_| input.target_block_ids.iter().all(|id| opaque(id)))
            .ok_or("Comment requires its anchored block identities")?
            .clone();
        if !serde_json::from_str::<Value>(&input.anchor_json).is_ok_and(|value| value.is_object()) {
            return Err("Comment anchor must be a JSON object".into());
        }
        let comment = WorkspaceComment {
            id: input.id,
            project_id: context.project_id.clone(),
            kind: "note".into(),
            target_kind: Some("node".into()),
            target_id: Some(input.chapter_id),
            target_block_id: Some(first_block),
            anchor_json: input.anchor_json,
            author_kind: "user".into(),
            author_id: Some(input.author_id),
            author_name: None,
            body_json: plain_comment_doc(&input.body_text),
            status: "open".into(),
            priority: None,
            source: "manual".into(),
            metadata_json: None,
            target_block_ids_json: json!(input.target_block_ids).to_string(),
            resolved_at: None,
            created_at: context.now_iso.clone(),
            updated_at: context.now_iso.clone(),
        };
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            self.live_chapter(tx, context, comment.target_id.as_deref().unwrap())?;
            let taken = self.query(Some(tx), r#"
                SELECT 1 FROM comment WHERE id=?
                UNION ALL SELECT 1 FROM sync_entity_lifecycle
                WHERE sync_generation_id=? AND entity_kind='comment' AND entity_id=?
            "#, vec![text(&comment.id), text(&context.sync_generation_id), text(&comment.id)])?;
            if !taken.is_empty() {
                return Err("Comment identity already exists".into());
            }
            self.execute(tx, &format!("INSERT INTO comment({COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"),
                comment_values(&comment))?;
            self.commit_changes(tx, context, &[journal::Mutation::create("comment", &comment.id, json!({
                "kind": comment.kind, "targetKind": comment.target_kind, "targetId": comment.target_id,
                "targetBlockId": comment.target_block_id, "anchorJson": comment.anchor_json,
                "authorKind": comment.author_kind, "authorId": comment.author_id,
                "authorName": comment.author_name, "bodyJson": comment.body_json,
                "status": comment.status, "priority": comment.priority, "source": comment.source,
                "metadataJson": comment.metadata_json,
                "targetBlockIdsJson": comment.target_block_ids_json, "resolvedAt": comment.resolved_at,
            }))], None)?;
            Ok(comment.clone())
        })
    }

    /// Replaces only the body; an unchanged body writes nothing.
    pub fn update_chapter_comment_body(
        &self,
        context: &AuthoredProseContext,
        chapter_id: &str,
        comment_id: &str,
        body_text: &str,
    ) -> Result<WorkspaceComment, String> {
        validate_context(context)?;
        if js_trim(body_text).is_empty() {
            return Err("Comment body is empty".into());
        }
        let body_json = plain_comment_doc(body_text);
        self.transaction(TransactionBehavior::Immediate, |tx| {
            let (mut comment, incarnation) =
                self.chapter_comment(tx, context, chapter_id, comment_id)?;
            if comment.body_json == body_json {
                return Ok(comment);
            }
            self.execute(
                tx,
                "UPDATE comment SET body_json=?,updated_at=? WHERE id=? AND project_id=?",
                vec![
                    text(&body_json),
                    text(&context.now_iso),
                    text(comment_id),
                    text(&context.project_id),
                ],
            )?;
            self.commit_changes(
                tx,
                context,
                &[journal::Mutation::field(
                    "comment",
                    comment_id,
                    incarnation,
                    "bodyJson",
                    json!(body_json),
                )],
                None,
            )?;
            comment.body_json = body_json;
            comment.updated_at = context.now_iso.clone();
            Ok(comment)
        })
    }

    /// Resolve or reopen. Converted suggestions are terminal here, as in Review.
    pub fn set_chapter_comment_resolved(
        &self,
        context: &AuthoredProseContext,
        chapter_id: &str,
        comment_id: &str,
        resolved: bool,
    ) -> Result<WorkspaceComment, String> {
        validate_context(context)?;
        let (status, resolved_at) = if resolved {
            ("resolved", Some(context.now_iso.clone()))
        } else {
            ("open", None)
        };
        self.transaction(TransactionBehavior::Immediate, |tx| {
            let (mut comment, incarnation) = self.chapter_comment(tx, context, chapter_id, comment_id)?;
            if comment.status == status {
                return Ok(comment);
            }
            if comment.status == "converted" {
                return Err("A converted suggestion cannot be resolved or reopened".into());
            }
            self.execute(tx, "UPDATE comment SET status=?,resolved_at=?,updated_at=? WHERE id=? AND project_id=?",
                vec![text(status), resolved_at.as_deref().map(text).unwrap_or(V::Null),
                    text(&context.now_iso), text(comment_id), text(&context.project_id)])?;
            // Field names in UTF-8 order, as the renderer journals this update.
            self.commit_changes(tx, context, &[
                journal::Mutation::field("comment", comment_id, incarnation, "resolvedAt", json!(resolved_at)),
                journal::Mutation::field("comment", comment_id, incarnation, "status", json!(status)),
            ], None)?;
            comment.status = status.into();
            comment.resolved_at = resolved_at;
            comment.updated_at = context.now_iso.clone();
            Ok(comment)
        })
    }

    fn live_chapter(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        chapter_id: &str,
    ) -> Result<(), String> {
        if self
            .chapters(Some(tx), &context.project_id)?
            .iter()
            .any(|chapter| chapter.id == chapter_id)
        {
            Ok(())
        } else {
            Err("Chapter is not available in this project".into())
        }
    }

    /// A comment row directly on this live chapter, with its lifecycle
    /// incarnation. Rows written before lifecycles existed update at 0, like
    /// the renderer's placeholder normalization; a retired lifecycle refuses.
    fn chapter_comment(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        chapter_id: &str,
        comment_id: &str,
    ) -> Result<(WorkspaceComment, u64), String> {
        self.guard_project(tx, context)?;
        self.live_chapter(tx, context, chapter_id)?;
        let rows = self.query(Some(tx),
            &format!("SELECT {COLUMNS} FROM comment WHERE id=? AND project_id=? AND target_kind='node' AND target_id=?"),
            vec![text(comment_id), text(&context.project_id), text(chapter_id)])?;
        let comment = comment_from_row(rows.first().ok_or("Comment is not on this chapter")?)?;
        let lifecycle = self.query(
            Some(tx),
            r#"
            SELECT incarnation,state FROM sync_entity_lifecycle
            WHERE sync_generation_id=? AND entity_kind='comment' AND entity_id=?
        "#,
            vec![text(&context.sync_generation_id), text(comment_id)],
        )?;
        let incarnation = match lifecycle.first() {
            None => 0,
            Some(row) if row[1] == text("live") => match &row[0] {
                V::Integer(value) => value.parse::<u64>().ok().filter(|n| *n <= MAX_SAFE),
                _ => None,
            }
            .ok_or("Invalid comment incarnation")?,
            Some(_) => return Err("Comment is not live".into()),
        };
        Ok((comment, incarnation))
    }
}

/// Port of `createPlainCommentDoc`, byte-for-byte including key order.
pub fn plain_comment_doc(body: &str) -> String {
    let trimmed = js_trim(body);
    let mut paragraphs = Vec::new();
    let mut rest = trimmed;
    // String.split(/\n{2,}/)
    while let Some(start) = rest.find("\n\n") {
        paragraphs.push(&rest[..start]);
        rest = rest[start..].trim_start_matches('\n');
    }
    paragraphs.push(rest);
    let content: Vec<String> = paragraphs
        .into_iter()
        .map(js_trim)
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut text = String::new();
            let mut newline = false;
            for c in part.chars() {
                if c == '\n' {
                    if !newline {
                        text.push(' ');
                    }
                    newline = true;
                } else {
                    text.push(c);
                    newline = false;
                }
            }
            format!(
                r#"{{"type":"paragraph","content":[{{"type":"text","text":{}}}]}}"#,
                json!(text)
            )
        })
        .collect();
    let content = if content.is_empty() {
        r#"{"type":"paragraph","content":[]}"#.to_string()
    } else {
        content.join(",")
    };
    format!(r#"{{"type":"doc","content":[{content}]}}"#)
}

fn optional(row: &[V], index: usize) -> Result<Option<String>, String> {
    match row.get(index) {
        Some(V::Null) => Ok(None),
        Some(V::Text(value)) => Ok(Some(value.clone())),
        _ => Err("Invalid comment optional text".into()),
    }
}

fn comment_from_row(row: &[V]) -> Result<WorkspaceComment, String> {
    Ok(WorkspaceComment {
        id: string(row, 0)?,
        project_id: string(row, 1)?,
        kind: string(row, 2)?,
        target_kind: optional(row, 3)?,
        target_id: optional(row, 4)?,
        target_block_id: optional(row, 5)?,
        anchor_json: string(row, 6)?,
        author_kind: string(row, 7)?,
        author_id: optional(row, 8)?,
        author_name: optional(row, 9)?,
        body_json: string(row, 10)?,
        status: string(row, 11)?,
        priority: optional(row, 12)?,
        source: string(row, 13)?,
        metadata_json: optional(row, 14)?,
        target_block_ids_json: string(row, 15)?,
        resolved_at: optional(row, 16)?,
        created_at: string(row, 17)?,
        updated_at: string(row, 18)?,
    })
}

fn comment_values(c: &WorkspaceComment) -> Vec<V> {
    let optional = |value: &Option<String>| value.as_deref().map(text).unwrap_or(V::Null);
    vec![
        text(&c.id),
        text(&c.project_id),
        text(&c.kind),
        optional(&c.target_kind),
        optional(&c.target_id),
        optional(&c.target_block_id),
        text(&c.anchor_json),
        text(&c.author_kind),
        optional(&c.author_id),
        optional(&c.author_name),
        text(&c.body_json),
        text(&c.status),
        optional(&c.priority),
        text(&c.source),
        optional(&c.metadata_json),
        text(&c.target_block_ids_json),
        optional(&c.resolved_at),
        text(&c.created_at),
        text(&c.updated_at),
    ]
}
