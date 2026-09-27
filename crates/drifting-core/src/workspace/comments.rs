//! Comments: selection notes on chapters and the project's TODOs (floating,
//! on a whole chapter or drift, or on a block range). Rows and canonical
//! originals commit together; anchor movement stays with the live prose
//! owner, and body, kind, priority or status writes never touch anchors,
//! metadata or prose.
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

/// A TODO or note written outside a text selection: floating (TODOs only),
/// or on a whole chapter, drift, element, category or storyline.
pub struct NewComment {
    pub id: String,
    pub author_id: String,
    /// `note` or `todo`.
    pub kind: String,
    /// `(kind, id)` with a relation endpoint kind: `node`, `element`,
    /// `category` or `storyline`.
    pub target: Option<(String, String)>,
    /// Blocks of a chapter or drift the owner captured; empty for a whole
    /// target or a floating comment.
    pub target_block_ids: Vec<String>,
    pub anchor_json: Option<String>,
    pub body_text: String,
    /// `low`, `med` or `high`.
    pub priority: Option<String>,
    /// Written by the writing assistant rather than the author.
    pub by_assistant: bool,
}

/// What makes an anchored comment a Copilot suggestion.
pub struct NewSuggestion {
    /// A JSON object describing the proposal (for example a new element or a
    /// patch), kept verbatim for the review.
    pub metadata_json: String,
    pub priority: Option<String>,
}

/// A review decision recorded on a suggestion.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCommentAction {
    pub id: String,
    pub comment_id: String,
    pub kind: String,
    pub label: Option<String>,
    pub payload_json: String,
    pub status: String,
    pub result_json: Option<String>,
    pub created_at: String,
}

/// Fields to change; absent fields stay.
#[derive(Default)]
pub struct CommentPatch {
    pub body_text: Option<String>,
    pub kind: Option<String>,
    pub priority: Option<Option<String>>,
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
        self.create_anchored_comment(context, input, None)
    }

    /// A Copilot suggestion on a chapter selection: a note by `copilot`
    /// whose metadata carries the proposal for the review to accept or
    /// reject.
    pub fn create_chapter_suggestion(
        &self,
        context: &AuthoredProseContext,
        input: NewChapterComment,
        suggestion: NewSuggestion,
    ) -> Result<WorkspaceComment, String> {
        self.create_anchored_comment(context, input, Some(suggestion))
    }

    fn create_anchored_comment(
        &self,
        context: &AuthoredProseContext,
        input: NewChapterComment,
        suggestion: Option<NewSuggestion>,
    ) -> Result<WorkspaceComment, String> {
        validate_context(context)?;
        if let Some(suggestion) = &suggestion {
            valid_priority(suggestion.priority.as_deref())?;
            if !serde_json::from_str::<Value>(&suggestion.metadata_json)
                .is_ok_and(|value| value.is_object())
            {
                return Err("Suggestion metadata must be a JSON object".into());
            }
        }
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
            author_kind: if suggestion.is_some() {
                "copilot"
            } else {
                "user"
            }
            .into(),
            author_id: if suggestion.is_some() {
                None
            } else {
                Some(input.author_id)
            },
            author_name: suggestion.as_ref().map(|_| "Copilot".to_string()),
            body_json: plain_comment_doc(&input.body_text),
            status: "open".into(),
            priority: suggestion.as_ref().and_then(|s| s.priority.clone()),
            source: if suggestion.is_some() {
                "copilot"
            } else {
                "manual"
            }
            .into(),
            metadata_json: suggestion.as_ref().map(|s| s.metadata_json.clone()),
            target_block_ids_json: json!(input.target_block_ids).to_string(),
            resolved_at: None,
            created_at: context.now_iso.clone(),
            updated_at: context.now_iso.clone(),
        };
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            self.live_body_node(tx, context, comment.target_id.as_deref().unwrap())?;
            self.insert_comment(tx, context, &comment)?;
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

    /// Every comment of the project, notes and TODOs, oldest first.
    pub fn project_comments(&self, project_id: &str) -> Result<Vec<WorkspaceComment>, String> {
        self.query(
            None,
            &format!("SELECT {COLUMNS} FROM comment WHERE project_id=? ORDER BY created_at,rowid"),
            vec![text(project_id)],
        )?
        .iter()
        .map(|row| comment_from_row(row))
        .collect()
    }

    pub fn create_comment(
        &self,
        context: &AuthoredProseContext,
        input: NewComment,
    ) -> Result<WorkspaceComment, String> {
        validate_context(context)?;
        if !opaque(&input.id) || !opaque(&input.author_id) {
            return Err("Invalid comment or author identity".into());
        }
        if !matches!(input.kind.as_str(), "note" | "todo") {
            return Err("Invalid comment kind".into());
        }
        if input.target.is_none() && input.kind != "todo" {
            return Err("浮动的只能是待办".into());
        }
        if let Some((kind, _)) = &input.target {
            if !matches!(kind.as_str(), "node" | "element" | "category" | "storyline") {
                return Err(format!("Comments on {kind} are not supported natively"));
            }
        }
        if !input.target_block_ids.is_empty()
            && !input
                .target
                .as_ref()
                .is_some_and(|(kind, _)| kind == "node")
        {
            return Err("Blocks need a target chapter or drift".into());
        }
        if !input.target_block_ids.iter().all(|id| opaque(id)) {
            return Err("Invalid comment block identity".into());
        }
        valid_priority(input.priority.as_deref())?;
        if js_trim(&input.body_text).is_empty() {
            return Err("内容不能为空".into());
        }
        let anchor_json = input.anchor_json.unwrap_or_else(|| "{}".into());
        if !serde_json::from_str::<Value>(&anchor_json).is_ok_and(|value| value.is_object()) {
            return Err("Comment anchor must be a JSON object".into());
        }
        let comment = WorkspaceComment {
            id: input.id,
            project_id: context.project_id.clone(),
            kind: input.kind,
            target_kind: input.target.as_ref().map(|(kind, _)| kind.clone()),
            target_id: input.target.map(|(_, id)| id),
            target_block_id: input.target_block_ids.first().cloned(),
            anchor_json,
            author_kind: if input.by_assistant { "ai" } else { "user" }.into(),
            author_id: (!input.by_assistant).then_some(input.author_id),
            author_name: input.by_assistant.then(|| "写作助手".to_string()),
            body_json: plain_comment_doc(&input.body_text),
            status: "open".into(),
            priority: input.priority,
            source: if input.by_assistant { "api" } else { "manual" }.into(),
            metadata_json: None,
            target_block_ids_json: json!(input.target_block_ids).to_string(),
            resolved_at: None,
            created_at: context.now_iso.clone(),
            updated_at: context.now_iso.clone(),
        };
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            if let (Some(kind), Some(id)) = (&comment.target_kind, &comment.target_id) {
                self.guard_endpoint(tx, context, kind, id)?;
            }
            self.insert_comment(tx, context, &comment)?;
            Ok(comment.clone())
        })
    }

    /// Body, kind and priority; unchanged fields write nothing. A floating
    /// TODO cannot become a note.
    pub fn update_comment(
        &self,
        context: &AuthoredProseContext,
        comment_id: &str,
        patch: CommentPatch,
    ) -> Result<WorkspaceComment, String> {
        validate_context(context)?;
        if let Some(kind) = &patch.kind {
            if !matches!(kind.as_str(), "note" | "todo") {
                return Err("Invalid comment kind".into());
            }
        }
        if let Some(priority) = &patch.priority {
            valid_priority(priority.as_deref())?;
        }
        let body_json = match &patch.body_text {
            Some(body) if js_trim(body).is_empty() => return Err("内容不能为空".into()),
            Some(body) => Some(plain_comment_doc(body)),
            None => None,
        };
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let (mut comment, incarnation) = self.project_comment(tx, context, comment_id)?;
            // Field names in UTF-8 order.
            let mut changes: Vec<(&str, &str, Value)> = Vec::new();
            if let Some(body) = body_json.filter(|body| *body != comment.body_json) {
                changes.push(("body_json", "bodyJson", json!(body)));
                comment.body_json = body;
            }
            if let Some(kind) = patch.kind.filter(|kind| *kind != comment.kind) {
                if kind == "note" && comment.target_id.is_none() {
                    return Err("浮动的待办不能转为批注".into());
                }
                changes.push(("kind", "kind", json!(kind)));
                comment.kind = kind;
            }
            if let Some(priority) = patch
                .priority
                .filter(|priority| *priority != comment.priority)
            {
                changes.push(("priority", "priority", json!(priority)));
                comment.priority = priority;
            }
            if changes.is_empty() {
                return Ok(comment);
            }
            let mut mutations = Vec::new();
            for (column, field, value) in &changes {
                self.execute(
                    tx,
                    &format!(
                        "UPDATE comment SET {column}=?,updated_at=? WHERE id=? AND project_id=?"
                    ),
                    vec![
                        value.as_str().map(text).unwrap_or(V::Null),
                        text(&context.now_iso),
                        text(comment_id),
                        text(&context.project_id),
                    ],
                )?;
                mutations.push(journal::Mutation::field(
                    "comment",
                    comment_id,
                    incarnation,
                    field,
                    value.clone(),
                ));
            }
            self.commit_changes(tx, context, &mutations, None)?;
            comment.updated_at = context.now_iso.clone();
            Ok(comment)
        })
    }

    /// Removes the comment, its review actions and every relation touching
    /// it (`entity.purge`), as the renderer's delete does.
    pub fn delete_comment(
        &self,
        context: &AuthoredProseContext,
        comment_id: &str,
    ) -> Result<(), String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let (_, incarnation) = self.project_comment(tx, context, comment_id)?;
            let mut mutations = self.purge_relations(tx, context, "comment", comment_id)?;
            self.remove_comment_actions(tx, context, comment_id, &mut mutations)?;
            self.execute(
                tx,
                "DELETE FROM comment WHERE id=? AND project_id=?",
                vec![text(comment_id), text(&context.project_id)],
            )?;
            mutations.push(
                journal::Mutation::json("entity", "comment", comment_id, "entity.purge", json!({}))
                    .at_incarnation(incarnation),
            );
            self.commit_changes(tx, context, &mutations, None)
        })
    }

    /// Accepts or rejects an open Copilot suggestion: one applied action
    /// (`accept_suggestion` / `reject_suggestion`) with the suggestion's
    /// metadata as payload and `result`, and the comment becomes
    /// `converted`. The host applies an accepted proposal first and passes
    /// what it created as `result`.
    pub fn resolve_suggestion(
        &self,
        context: &AuthoredProseContext,
        comment_id: &str,
        action_id: &str,
        accepted: bool,
        result_json: Option<&str>,
    ) -> Result<WorkspaceCommentAction, String> {
        validate_context(context)?;
        if !opaque(action_id) {
            return Err("Invalid action identity".into());
        }
        if result_json.is_some_and(|json| serde_json::from_str::<Value>(json).is_err()) {
            return Err("Suggestion result must be JSON".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let (comment, incarnation) = self.project_comment(tx, context, comment_id)?;
            if comment.source != "copilot" {
                return Err("这条批注不是 Copilot 建议".into());
            }
            if comment.status != "open" {
                return Err("这条建议已经处理过了".into());
            }
            let action = WorkspaceCommentAction {
                id: action_id.into(),
                comment_id: comment_id.into(),
                kind: if accepted { "accept_suggestion" } else { "reject_suggestion" }.into(),
                label: Some(if accepted { "Accept copilot suggestion" } else { "Reject copilot suggestion" }.into()),
                payload_json: comment.metadata_json.clone().unwrap_or_else(|| "{}".into()),
                status: "applied".into(),
                result_json: result_json.map(String::from),
                created_at: context.now_iso.clone(),
            };
            self.execute(tx, "UPDATE comment SET status='converted',resolved_at=?,updated_at=? WHERE id=? AND project_id=?",
                vec![text(&context.now_iso), text(&context.now_iso), text(comment_id), text(&context.project_id)])?;
            self.execute(tx, r#"
                INSERT INTO comment_action(id,project_id,comment_id,kind,label,payload_json,status,result_json,
                    created_by_kind,created_by_id,created_at,updated_at,applied_at)
                VALUES (?,?,?,?,?,?,?,?,'user',NULL,?,?,?)
            "#, vec![text(&action.id), text(&context.project_id), text(comment_id), text(&action.kind),
                action.label.as_deref().map(text).unwrap_or(V::Null), text(&action.payload_json), text(&action.status),
                action.result_json.as_deref().map(text).unwrap_or(V::Null), text(&context.now_iso), text(&context.now_iso),
                text(&context.now_iso)])?;
            self.commit_changes(tx, context, &[
                journal::Mutation::field("comment", comment_id, incarnation, "resolvedAt", json!(context.now_iso)),
                journal::Mutation::field("comment", comment_id, incarnation, "status", json!("converted")),
                journal::Mutation::create("comment-action", &action.id, json!({
                    "id": action.id, "commentId": comment_id, "kind": action.kind, "label": action.label,
                    "payloadJson": action.payload_json, "status": action.status, "resultJson": action.result_json,
                    "createdByKind": "user", "createdById": null, "appliedAt": context.now_iso,
                })),
            ], None)?;
            Ok(action)
        })
    }

    /// Every review decision on suggestions, oldest first; rejected
    /// payloads keep Copilot from proposing the same thing again.
    pub fn suggestion_actions(
        &self,
        project_id: &str,
    ) -> Result<Vec<WorkspaceCommentAction>, String> {
        self.query(None, r#"
            SELECT id,comment_id,kind,label,payload_json,status,result_json,created_at FROM comment_action
            WHERE project_id=? AND kind IN ('accept_suggestion','reject_suggestion') ORDER BY created_at,rowid
        "#, vec![text(project_id)])?
        .iter()
        .map(|row| {
            Ok(WorkspaceCommentAction {
                id: string(row, 0)?,
                comment_id: string(row, 1)?,
                kind: string(row, 2)?,
                label: optional(row, 3)?,
                payload_json: string(row, 4)?,
                status: string(row, 5)?,
                result_json: optional(row, 6)?,
                created_at: string(row, 7)?,
            })
        })
        .collect()
    }

    /// Removes a comment's review actions with their trash originals.
    pub(super) fn remove_comment_actions(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        comment_id: &str,
        mutations: &mut Vec<journal::Mutation>,
    ) -> Result<(), String> {
        for row in self.query(
            Some(tx),
            "SELECT id FROM comment_action WHERE comment_id=? AND project_id=? ORDER BY id",
            vec![text(comment_id), text(&context.project_id)],
        )? {
            let action = string(&row, 0)?;
            let lifecycle = self.query(Some(tx), "SELECT incarnation,state FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind='comment-action' AND entity_id=?",
                vec![text(&context.sync_generation_id), text(&action)])?;
            if let Some(row) = lifecycle.first() {
                if row[1] == text("live") {
                    let incarnation = match &row[0] {
                        V::Integer(value) => value
                            .parse::<u64>()
                            .map_err(|_| "Invalid incarnation".to_string())?,
                        _ => return Err("Invalid incarnation".into()),
                    };
                    mutations.push(
                        journal::Mutation::json(
                            "entity",
                            "comment-action",
                            &action,
                            "entity.trash",
                            json!({}),
                        )
                        .at_incarnation(incarnation),
                    );
                }
            }
        }
        self.execute(
            tx,
            "DELETE FROM comment_action WHERE comment_id=? AND project_id=?",
            vec![text(comment_id), text(&context.project_id)],
        )?;
        Ok(())
    }

    fn insert_comment(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        comment: &WorkspaceComment,
    ) -> Result<(), String> {
        let taken = self.query(
            Some(tx),
            r#"
            SELECT 1 FROM comment WHERE id=?
            UNION ALL SELECT 1 FROM sync_entity_lifecycle
            WHERE sync_generation_id=? AND entity_kind='comment' AND entity_id=?
        "#,
            vec![
                text(&comment.id),
                text(&context.sync_generation_id),
                text(&comment.id),
            ],
        )?;
        if !taken.is_empty() {
            return Err("Comment identity already exists".into());
        }
        self.execute(
            tx,
            &format!(
                "INSERT INTO comment({COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
            ),
            comment_values(comment),
        )?;
        self.commit_changes(tx, context, &[journal::Mutation::create("comment", &comment.id, json!({
            "kind": comment.kind, "targetKind": comment.target_kind, "targetId": comment.target_id,
            "targetBlockId": comment.target_block_id, "anchorJson": comment.anchor_json,
            "authorKind": comment.author_kind, "authorId": comment.author_id,
            "authorName": comment.author_name, "bodyJson": comment.body_json,
            "status": comment.status, "priority": comment.priority, "source": comment.source,
            "metadataJson": comment.metadata_json,
            "targetBlockIdsJson": comment.target_block_ids_json, "resolvedAt": comment.resolved_at,
        }))], None)
    }

    /// Resolve or reopen any comment of the project. Converted suggestions
    /// are terminal here, as in Review.
    pub fn set_comment_resolved(
        &self,
        context: &AuthoredProseContext,
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
            self.guard_project(tx, context)?;
            let (mut comment, incarnation) = self.project_comment(tx, context, comment_id)?;
            if comment.status == status {
                return Ok(comment);
            }
            if comment.status == "converted" {
                return Err("A converted suggestion cannot be resolved or reopened".into());
            }
            self.execute(tx, "UPDATE comment SET status=?,resolved_at=?,updated_at=? WHERE id=? AND project_id=?",
                vec![text(status), resolved_at.as_deref().map(text).unwrap_or(V::Null),
                    text(&context.now_iso), text(comment_id), text(&context.project_id)])?;
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

    /// Any comment row of this project with its lifecycle incarnation.
    fn project_comment(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        comment_id: &str,
    ) -> Result<(WorkspaceComment, u64), String> {
        let rows = self.query(
            Some(tx),
            &format!("SELECT {COLUMNS} FROM comment WHERE id=? AND project_id=?"),
            vec![text(comment_id), text(&context.project_id)],
        )?;
        let comment = comment_from_row(rows.first().ok_or("这条批注或待办不存在")?)?;
        Ok((comment, self.comment_incarnation(tx, context, comment_id)?))
    }

    fn comment_incarnation(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        comment_id: &str,
    ) -> Result<u64, String> {
        let lifecycle = self.query(
            Some(tx),
            r#"
            SELECT incarnation,state FROM sync_entity_lifecycle
            WHERE sync_generation_id=? AND entity_kind='comment' AND entity_id=?
        "#,
            vec![text(&context.sync_generation_id), text(comment_id)],
        )?;
        match lifecycle.first() {
            None => Ok(0),
            Some(row) if row[1] == text("live") => match &row[0] {
                V::Integer(value) => value.parse::<u64>().ok().filter(|n| *n <= MAX_SAFE),
                _ => None,
            }
            .ok_or_else(|| "Invalid comment incarnation".into()),
            Some(_) => Err("Comment is not live".into()),
        }
    }

    /// Anchored notes live on a live chapter or drift body of this project.
    fn live_body_node(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        node_id: &str,
    ) -> Result<(), String> {
        let live = self.query(Some(tx), r#"
            SELECT 1 FROM book_node n
            LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=? AND l.entity_kind='node' AND l.entity_id=n.id
            WHERE n.id=? AND n.project_id=? AND n.kind IN ('chapter','drift') AND n.deleted_at IS NULL
                AND (l.state IS NULL OR l.state='live')
        "#, vec![text(&context.sync_generation_id), text(node_id), text(&context.project_id)])?;
        if live.is_empty() {
            Err("Chapter is not available in this project".into())
        } else {
            Ok(())
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
        self.live_body_node(tx, context, chapter_id)?;
        let rows = self.query(Some(tx),
            &format!("SELECT {COLUMNS} FROM comment WHERE id=? AND project_id=? AND target_kind='node' AND target_id=?"),
            vec![text(comment_id), text(&context.project_id), text(chapter_id)])?;
        let comment = comment_from_row(rows.first().ok_or("Comment is not on this chapter")?)?;
        let incarnation = self.comment_incarnation(tx, context, comment_id)?;
        Ok((comment, incarnation))
    }
}

fn valid_priority(priority: Option<&str>) -> Result<(), String> {
    match priority {
        None | Some("low" | "med" | "high") => Ok(()),
        Some(_) => Err("Invalid comment priority".into()),
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
