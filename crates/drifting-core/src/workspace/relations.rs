//! Curated relations between entities, each owned by a first-class relation
//! type: the renderer's useEntityRelationTypes / useEntityRelations rows and
//! originals, and deleteEntityRelationsInTransaction for trash.
use super::*;
use serde::Deserialize;

#[cfg(test)]
mod tests;

const STRUCTURAL: [&str; 5] = ["node", "element", "patch", "category", "storyline"];
const ALL_KINDS: [&str; 7] = [
    "node",
    "element",
    "patch",
    "category",
    "storyline",
    "comment",
    "library_item",
];
/// Endpoints the native client can currently address.
const NATIVE_ENDPOINTS: [(&str, &str); 4] = [
    ("node", "book_node"),
    ("element", "element"),
    ("category", "element_category"),
    ("storyline", "storylines"),
];

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRelationType {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub normalized_name: String,
    pub description: String,
    pub orientation: String,
    pub system_key: Option<String>,
    pub locked: bool,
    pub source_role: String,
    pub target_role: String,
    pub source_kinds: Vec<String>,
    pub target_kinds: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRelation {
    pub id: String,
    pub project_id: String,
    pub from_kind: String,
    pub from_id: String,
    pub to_kind: String,
    pub to_id: String,
    pub relation_type_id: String,
    pub created_at: String,
    pub updated_at: String,
}

/// `EntityRelationTypeDefinition` as the author enters it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelationTypeDefinition {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub orientation: String,
    #[serde(default)]
    pub source_role: Option<String>,
    #[serde(default)]
    pub target_role: Option<String>,
    pub source_kinds: Vec<String>,
    pub target_kinds: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct Normalized {
    name: String,
    normalized_name: String,
    description: String,
    orientation: String,
    source_role: String,
    target_role: String,
    source_kinds: Vec<String>,
    target_kinds: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct Endpoints {
    from_kind: String,
    from_id: String,
    to_kind: String,
    to_id: String,
}

/// normalizeRelationTypeName: trimmed, ASCII-only lowercase.
fn normalized_name(name: &str) -> String {
    js_trim(name)
        .chars()
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn ordered(canonical: &[&str], values: &[String]) -> Vec<String> {
    canonical
        .iter()
        .filter(|kind| values.iter().any(|value| value == *kind))
        .map(|kind| kind.to_string())
        .collect()
}

/// normalizeRelationTypeDefinition, with the renderer's messages.
fn normalize(input: &RelationTypeDefinition) -> Result<Normalized, String> {
    let name = js_trim(&input.name);
    if name.is_empty() {
        return Err("关系类型名称不能为空".into());
    }
    let description = input
        .description
        .as_deref()
        .map(js_trim)
        .unwrap_or("")
        .to_string();
    if input
        .source_kinds
        .iter()
        .any(|kind| !ALL_KINDS.contains(&kind.as_str()))
    {
        return Err("关系类型包含不支持的源实体类型".into());
    }
    if input
        .target_kinds
        .iter()
        .any(|kind| !STRUCTURAL.contains(&kind.as_str()))
    {
        return Err("关系类型包含不支持的目标实体类型".into());
    }
    let source_kinds = ordered(&ALL_KINDS, &input.source_kinds);
    let target_kinds = ordered(&STRUCTURAL, &input.target_kinds);
    if source_kinds.is_empty() || target_kinds.is_empty() {
        return Err("关系类型必须至少允许一种源实体和一种目标实体".into());
    }
    let role = |value: &Option<String>| value.as_deref().map(js_trim).unwrap_or("").to_string();
    let (source_role, target_role) = match input.orientation.as_str() {
        "directed" => {
            let (source, target) = (role(&input.source_role), role(&input.target_role));
            if source.is_empty() || target.is_empty() {
                return Err("有向关系类型必须填写源角色和目标角色".into());
            }
            (source, target)
        }
        "symmetric" => {
            if source_kinds
                .iter()
                .any(|kind| !STRUCTURAL.contains(&kind.as_str()))
                || ordered(&STRUCTURAL, &source_kinds) != target_kinds
            {
                return Err("对称关系只能连接结构实体，且两端允许的实体类型必须一致".into());
            }
            let shared = [role(&input.source_role), role(&input.target_role)]
                .into_iter()
                .find(|role| !role.is_empty())
                .unwrap_or_else(|| "端点".into());
            (shared.clone(), shared)
        }
        _ => return Err("关系类型方向必须是 directed 或 symmetric".into()),
    };
    Ok(Normalized {
        normalized_name: normalized_name(name),
        name: name.into(),
        description,
        orientation: input.orientation.clone(),
        source_role,
        target_role,
        source_kinds,
        target_kinds,
    })
}

/// validateRelationAgainstType: symmetric edges are stored with the
/// bytewise-smaller `kind:id` endpoint first.
fn validate(kind: &WorkspaceRelationType, relation: Endpoints) -> Result<Endpoints, String> {
    let allowed = |from: &str, to: &str| {
        kind.source_kinds.iter().any(|k| k == from) && kind.target_kinds.iter().any(|k| k == to)
    };
    if allowed(&relation.from_kind, &relation.to_kind) {
        if kind.orientation != "symmetric" {
            return Ok(relation);
        }
        let from = format!("{}:{}", relation.from_kind, relation.from_id);
        let to = format!("{}:{}", relation.to_kind, relation.to_id);
        return Ok(if from.as_bytes() <= to.as_bytes() {
            relation
        } else {
            Endpoints {
                from_kind: relation.to_kind,
                from_id: relation.to_id,
                to_kind: relation.from_kind,
                to_id: relation.from_id,
            }
        });
    }
    let swap = STRUCTURAL.contains(&relation.from_kind.as_str())
        && allowed(&relation.to_kind, &relation.from_kind);
    let or = |value: &str, fallback: &str| {
        if value.is_empty() {
            fallback.to_string()
        } else {
            value.to_string()
        }
    };
    let expected = format!(
        "{} → {}",
        or(&kind.source_role, "源端"),
        or(&kind.target_role, "目标端")
    );
    Err(if swap {
        format!(
            "关系类型「{}」要求 {expected}；当前两端方向相反，请交换两端后重试。",
            kind.name
        )
    } else {
        format!(
            "关系类型「{}」要求 {expected}，当前实体类型不符合其端点约束。",
            kind.name
        )
    })
}

fn type_seed(kind: &Normalized, system_key: &Option<String>, locked: bool) -> Value {
    json!({
        "name": kind.name, "normalizedName": kind.normalized_name, "description": kind.description,
        "orientation": kind.orientation, "systemKey": system_key, "locked": locked,
        "sourceRole": kind.source_role, "targetRole": kind.target_role,
        "sourceKinds": kind.source_kinds, "targetKinds": kind.target_kinds,
    })
}

const RELATION_COLUMNS: &str =
    "id,project_id,from_kind,from_id,to_kind,to_id,relation_type_id,created_at,updated_at";

impl WorkspaceStore<'_> {
    /// Every relation type of the project, by name (the repository order).
    pub fn relation_types(&self, project_id: &str) -> Result<Vec<WorkspaceRelationType>, String> {
        self.relation_type_rows(None, project_id, None)
    }

    pub fn relations(&self, project_id: &str) -> Result<Vec<WorkspaceRelation>, String> {
        self.query(
            None,
            &format!(
                "SELECT {RELATION_COLUMNS} FROM entity_relation WHERE project_id=? ORDER BY rowid"
            ),
            vec![text(project_id)],
        )?
        .iter()
        .map(|row| relation_from_row(row))
        .collect()
    }

    pub fn create_relation_type(
        &self,
        context: &AuthoredProseContext,
        id: &str,
        definition: &RelationTypeDefinition,
    ) -> Result<WorkspaceRelationType, String> {
        validate_context(context)?;
        if !opaque(id) {
            return Err("Invalid relation type identity".into());
        }
        let normalized = normalize(definition)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            self.guard_type_name(tx, context, &normalized, None)?;
            self.execute(tx, r#"
                INSERT INTO entity_relation_type(id,project_id,name,normalized_name,description,orientation,
                    system_key,locked,source_role,target_role,created_at,updated_at)
                VALUES (?,?,?,?,?,?,NULL,0,?,?,?,?)
            "#, vec![text(id), text(&context.project_id), text(&normalized.name), text(&normalized.normalized_name),
                text(&normalized.description), text(&normalized.orientation), text(&normalized.source_role),
                text(&normalized.target_role), text(&context.now_iso), text(&context.now_iso)])?;
            self.insert_endpoints(tx, id, &normalized)?;
            self.commit_changes(tx, context, &[journal::Mutation::create(
                "entity-relation-type", id, type_seed(&normalized, &None, false))], None)?;
            self.relation_type(tx, context, id)
        })
    }

    /// Author types only. Every existing relation of the type must satisfy the
    /// new endpoints, and a type may become symmetric only when its relations
    /// are already stored in canonical order.
    pub fn update_relation_type(
        &self,
        context: &AuthoredProseContext,
        id: &str,
        definition: &RelationTypeDefinition,
    ) -> Result<WorkspaceRelationType, String> {
        validate_context(context)?;
        let normalized = normalize(definition)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let current = self.relation_type(tx, context, id)?;
            if current.locked {
                return Err("内建关系类型不能修改".into());
            }
            self.guard_type_name(tx, context, &normalized, Some(id))?;
            let next = WorkspaceRelationType {
                name: normalized.name.clone(),
                normalized_name: normalized.normalized_name.clone(),
                description: normalized.description.clone(),
                orientation: normalized.orientation.clone(),
                source_role: normalized.source_role.clone(),
                target_role: normalized.target_role.clone(),
                source_kinds: normalized.source_kinds.clone(),
                target_kinds: normalized.target_kinds.clone(),
                ..current.clone()
            };
            for relation in self.relation_rows(tx, context, "relation_type_id=?", vec![text(id)])? {
                let endpoints = endpoints(&relation);
                match validate(&next, endpoints.clone()) {
                    Err(message) => return Err(format!("关系「{}」不符合新约束：{message}", relation.id)),
                    Ok(checked) if checked != endpoints => {
                        return Err(format!("关系「{}」需要先交换两端，才能把该类型改为对称关系", relation.id))
                    }
                    Ok(_) => {}
                }
            }
            if next == current {
                return Ok(current);
            }
            self.execute(tx, r#"
                UPDATE entity_relation_type SET name=?,normalized_name=?,description=?,orientation=?,
                    source_role=?,target_role=?,updated_at=? WHERE id=? AND project_id=?
            "#, vec![text(&next.name), text(&next.normalized_name), text(&next.description), text(&next.orientation),
                text(&next.source_role), text(&next.target_role), text(&context.now_iso), text(id),
                text(&context.project_id)])?;
            self.execute(tx, "DELETE FROM entity_relation_type_endpoint_kind WHERE relation_type_id=?", vec![text(id)])?;
            self.insert_endpoints(tx, id, &normalized)?;
            let incarnation = self.live_incarnation(tx, context, "entity-relation-type", id)?;
            let seed = type_seed(&normalized, &current.system_key, current.locked);
            let mut fields: Vec<(&String, &Value)> = seed.as_object().unwrap().iter().collect();
            fields.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            let mutations: Vec<_> = fields
                .into_iter()
                .map(|(field, value)| journal::Mutation::field("entity-relation-type", id, incarnation, field, value.clone()))
                .collect();
            self.commit_changes(tx, context, &mutations, None)?;
            self.relation_type(tx, context, id)
        })
    }

    /// Deleting an unknown type is a no-op; built-in and used types stay.
    pub fn delete_relation_type(
        &self,
        context: &AuthoredProseContext,
        id: &str,
    ) -> Result<(), String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let Ok(current) = self.relation_type(tx, context, id) else {
                return Ok(());
            };
            if current.locked {
                return Err("内建关系类型不能删除".into());
            }
            let used = self
                .relation_rows(tx, context, "relation_type_id=?", vec![text(id)])?
                .len();
            if used > 0 {
                return Err(format!("关系类型仍被 {used} 条关系使用，不能删除"));
            }
            let incarnation = self.live_incarnation(tx, context, "entity-relation-type", id)?;
            self.execute(
                tx,
                "DELETE FROM entity_relation_type WHERE id=? AND project_id=?",
                vec![text(id), text(&context.project_id)],
            )?;
            self.commit_changes(
                tx,
                context,
                &[journal::Mutation::json(
                    "entity",
                    "entity-relation-type",
                    id,
                    "entity.purge",
                    json!({}),
                )
                .at_incarnation(incarnation)],
                None,
            )?;
            Ok(())
        })
    }

    /// addRelation: validated against its type (symmetric edges canonical);
    /// an identical edge of the same type is returned without writing.
    pub fn add_relation(
        &self,
        context: &AuthoredProseContext,
        id: &str,
        from: (&str, &str),
        to: (&str, &str),
        relation_type_id: &str,
    ) -> Result<WorkspaceRelation, String> {
        validate_context(context)?;
        if !opaque(id) {
            return Err("Invalid relation identity".into());
        }
        if !STRUCTURAL.contains(&to.0) {
            return Err(format!("Cannot create entity relation: toKind '{}' is not a structural kind (memo / material can only appear as fromKind).", to.0));
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let kind = self.relation_type(tx, context, relation_type_id)?;
            let checked = validate(&kind, Endpoints { from_kind: from.0.into(), from_id: from.1.into(),
                to_kind: to.0.into(), to_id: to.1.into() })?;
            refuse_self_edge(&checked)?;
            self.guard_endpoint(tx, context, &checked.from_kind, &checked.from_id)?;
            self.guard_endpoint(tx, context, &checked.to_kind, &checked.to_id)?;
            if let Some(existing) = self.same_edge(tx, context, &checked, relation_type_id, None)? {
                return Ok(existing);
            }
            self.execute(tx, &format!("INSERT INTO entity_relation({RELATION_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?)"),
                vec![text(id), text(&context.project_id), text(&checked.from_kind), text(&checked.from_id),
                    text(&checked.to_kind), text(&checked.to_id), text(relation_type_id), text(&context.now_iso),
                    text(&context.now_iso)])?;
            self.commit_changes(tx, context, &[journal::Mutation::create("entity-relation", id, json!({
                "fromKind": checked.from_kind, "fromId": checked.from_id, "toKind": checked.to_kind,
                "toId": checked.to_id, "relationTypeId": relation_type_id,
            }))], None)?;
            Ok(self.relation_rows(tx, context, "id=?", vec![text(id)])?.remove(0))
        })
    }

    /// removeRelation; an unknown relation is a no-op.
    pub fn remove_relation(&self, context: &AuthoredProseContext, id: &str) -> Result<(), String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            if self
                .relation_rows(tx, context, "id=?", vec![text(id)])?
                .is_empty()
            {
                return Ok(());
            }
            let incarnation = self.live_incarnation(tx, context, "entity-relation", id)?;
            self.execute(
                tx,
                "DELETE FROM entity_relation WHERE id=? AND project_id=?",
                vec![text(id), text(&context.project_id)],
            )?;
            self.commit_changes(
                tx,
                context,
                &[journal::Mutation::json(
                    "entity",
                    "entity-relation",
                    id,
                    "entity.purge",
                    json!({}),
                )
                .at_incarnation(incarnation)],
                None,
            )?;
            Ok(())
        })
    }

    /// updateRelationType on a relation: change its type and optionally swap
    /// its ends; all five endpoint fields are journaled.
    pub fn retype_relation(
        &self,
        context: &AuthoredProseContext,
        id: &str,
        relation_type_id: &str,
        swap: bool,
    ) -> Result<WorkspaceRelation, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let existing = self.relation_rows(tx, context, "id=?", vec![text(id)])?
                .pop()
                .ok_or("关系不存在或不属于当前项目")?;
            let kind = self.relation_type(tx, context, relation_type_id)?;
            let current = endpoints(&existing);
            let candidate = if swap {
                Endpoints { from_kind: current.to_kind.clone(), from_id: current.to_id.clone(),
                    to_kind: current.from_kind.clone(), to_id: current.from_id.clone() }
            } else {
                current.clone()
            };
            if !STRUCTURAL.contains(&candidate.to_kind.as_str()) {
                return Err("交换后目标端不是结构实体，无法保存该方向".into());
            }
            let checked = validate(&kind, candidate)?;
            refuse_self_edge(&checked)?;
            if self.same_edge(tx, context, &checked, relation_type_id, Some(id))?.is_some() {
                return Err("相同类型的关系已存在".into());
            }
            if checked == current && existing.relation_type_id == relation_type_id {
                return Ok(existing);
            }
            self.execute(tx, r#"
                UPDATE entity_relation SET from_kind=?,from_id=?,to_kind=?,to_id=?,relation_type_id=?,updated_at=?
                WHERE id=? AND project_id=?
            "#, vec![text(&checked.from_kind), text(&checked.from_id), text(&checked.to_kind), text(&checked.to_id),
                text(relation_type_id), text(&context.now_iso), text(id), text(&context.project_id)])?;
            let incarnation = self.live_incarnation(tx, context, "entity-relation", id)?;
            let mutations: Vec<_> = [
                ("fromId", &checked.from_id), ("fromKind", &checked.from_kind),
                ("relationTypeId", &relation_type_id.to_string()), ("toId", &checked.to_id), ("toKind", &checked.to_kind),
            ]
            .into_iter()
            .map(|(field, value)| journal::Mutation::field("entity-relation", id, incarnation, field, json!(value)))
            .collect();
            self.commit_changes(tx, context, &mutations, None)?;
            Ok(self.relation_rows(tx, context, "id=?", vec![text(id)])?.remove(0))
        })
    }

    /// deleteEntityRelationsInTransaction: every curated relation touching an
    /// entity is removed with its purge original, ahead of the entity's own
    /// trash mutation; restore does not bring relations back.
    pub(super) fn purge_relations(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        kind: &str,
        id: &str,
    ) -> Result<Vec<journal::Mutation>, String> {
        // The renderer's query shape, so both select rows in the same order.
        let condition = r#"("entity_relation"."project_id" = ? and (("entity_relation"."from_kind" = ? and "entity_relation"."from_id" = ?) or ("entity_relation"."to_kind" = ? and "entity_relation"."to_id" = ?)))"#;
        let values = || {
            vec![
                text(&context.project_id),
                text(kind),
                text(id),
                text(kind),
                text(id),
            ]
        };
        let ids: Vec<String> = self
            .query(
                Some(tx),
                &format!(r#"select "id" from "entity_relation" where {condition}"#),
                values(),
            )?
            .iter()
            .map(|row| string(row, 0))
            .collect::<Result<_, _>>()?;
        let mut mutations = Vec::new();
        for relation in &ids {
            let incarnation = self.live_incarnation(tx, context, "entity-relation", relation)?;
            mutations.push(
                journal::Mutation::json(
                    "entity",
                    "entity-relation",
                    relation,
                    "entity.purge",
                    json!({}),
                )
                .at_incarnation(incarnation),
            );
        }
        if !ids.is_empty() {
            self.execute(
                tx,
                &format!(r#"delete from "entity_relation" where {condition}"#),
                values(),
            )?;
        }
        Ok(mutations)
    }

    fn relation_type(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        id: &str,
    ) -> Result<WorkspaceRelationType, String> {
        self.relation_type_rows(Some(tx), &context.project_id, Some(id))?
            .pop()
            .ok_or_else(|| "关系类型不存在或不属于当前项目".into())
    }

    fn relation_type_rows(
        &self,
        tx: Option<u64>,
        project_id: &str,
        id: Option<&str>,
    ) -> Result<Vec<WorkspaceRelationType>, String> {
        let mut values = vec![text(project_id)];
        if let Some(id) = id {
            values.push(text(id));
        }
        let rows = self.query(tx, &format!(r#"
            SELECT id,project_id,name,normalized_name,description,orientation,system_key,locked,source_role,
                target_role,created_at,updated_at FROM entity_relation_type WHERE project_id=?{} ORDER BY name,id
        "#, if id.is_some() { " AND id=?" } else { "" }), values)?;
        let endpoints = self.query(
            tx,
            r#"
            SELECT e.relation_type_id,e.side,e.entity_kind FROM entity_relation_type_endpoint_kind e
            JOIN entity_relation_type t ON t.id=e.relation_type_id WHERE t.project_id=?
        "#,
            vec![text(project_id)],
        )?;
        rows.iter()
            .map(|row| {
                let id = string(row, 0)?;
                let kinds = |side: &str, canonical: &[&str]| -> Result<Vec<String>, String> {
                    let mut present = Vec::new();
                    for endpoint in &endpoints {
                        if string(endpoint, 0)? == id && string(endpoint, 1)? == side {
                            present.push(string(endpoint, 2)?);
                        }
                    }
                    Ok(ordered(canonical, &present))
                };
                Ok(WorkspaceRelationType {
                    source_kinds: kinds("source", &ALL_KINDS)?,
                    target_kinds: kinds("target", &STRUCTURAL)?,
                    project_id: string(row, 1)?,
                    name: string(row, 2)?,
                    normalized_name: string(row, 3)?,
                    description: string(row, 4)?,
                    orientation: string(row, 5)?,
                    system_key: match &row[6] {
                        V::Null => None,
                        _ => Some(string(row, 6)?),
                    },
                    locked: match &row[7] {
                        V::Integer(value) => value != "0",
                        _ => return Err("Invalid relation type lock".into()),
                    },
                    source_role: string(row, 8)?,
                    target_role: string(row, 9)?,
                    created_at: string(row, 10)?,
                    updated_at: string(row, 11)?,
                    id,
                })
            })
            .collect()
    }

    fn relation_rows(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        filter: &str,
        mut values: Vec<V>,
    ) -> Result<Vec<WorkspaceRelation>, String> {
        values.insert(0, text(&context.project_id));
        self.query(Some(tx), &format!("SELECT {RELATION_COLUMNS} FROM entity_relation WHERE project_id=? AND {filter} ORDER BY rowid"), values)?
            .iter()
            .map(|row| relation_from_row(row))
            .collect()
    }

    fn same_edge(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        edge: &Endpoints,
        relation_type_id: &str,
        except: Option<&str>,
    ) -> Result<Option<WorkspaceRelation>, String> {
        Ok(self
            .relation_rows(
                tx,
                context,
                "from_kind=? AND from_id=? AND to_kind=? AND to_id=? AND relation_type_id=?",
                vec![
                    text(&edge.from_kind),
                    text(&edge.from_id),
                    text(&edge.to_kind),
                    text(&edge.to_id),
                    text(relation_type_id),
                ],
            )?
            .into_iter()
            .find(|relation| Some(relation.id.as_str()) != except))
    }

    fn guard_type_name(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        normalized: &Normalized,
        except: Option<&str>,
    ) -> Result<(), String> {
        let rows = self.query(
            Some(tx),
            "SELECT id FROM entity_relation_type WHERE project_id=? AND normalized_name=?",
            vec![text(&context.project_id), text(&normalized.normalized_name)],
        )?;
        for row in &rows {
            if Some(string(row, 0)?.as_str()) != except {
                return Err(format!("关系类型「{}」已存在", normalized.name));
            }
        }
        Ok(())
    }

    /// The native client links only live chapters, drifts, elements,
    /// categories and storylines of this project.
    fn guard_endpoint(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        kind: &str,
        id: &str,
    ) -> Result<(), String> {
        let table = NATIVE_ENDPOINTS
            .iter()
            .find(|(endpoint, _)| *endpoint == kind)
            .map(|(_, table)| *table)
            .ok_or_else(|| format!("Relations to {kind} are not supported natively"))?;
        let live = self.query(
            Some(tx),
            &format!("SELECT 1 FROM {table} WHERE id=? AND project_id=? AND deleted_at IS NULL"),
            vec![text(id), text(&context.project_id)],
        )?;
        if live.is_empty() {
            return Err(format!("关系端点 {kind}:{id} 不存在或已在回收站"));
        }
        Ok(())
    }

    fn insert_endpoints(&self, tx: u64, id: &str, kind: &Normalized) -> Result<(), String> {
        for (side, kinds) in [
            ("source", &kind.source_kinds),
            ("target", &kind.target_kinds),
        ] {
            for entity_kind in kinds {
                self.execute(tx, "INSERT INTO entity_relation_type_endpoint_kind(relation_type_id,side,entity_kind) VALUES (?,?,?)",
                    vec![text(id), text(side), text(entity_kind)])?;
            }
        }
        Ok(())
    }

    /// The live lifecycle incarnation; product purge and field paths fail
    /// closed without one, as the renderer's resolver does.
    fn live_incarnation(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        kind: &str,
        id: &str,
    ) -> Result<u64, String> {
        let rows = self.query(Some(tx), "SELECT incarnation,state FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind=? AND entity_id=?",
            vec![text(&context.sync_generation_id), text(kind), text(id)])?;
        let row = rows
            .first()
            .ok_or_else(|| format!("{kind}:{id} has no lifecycle"))?;
        if string(row, 1)? != "live" {
            return Err(format!("{kind}:{id} is not live"));
        }
        match &row[0] {
            V::Integer(value) => value
                .parse::<u64>()
                .ok()
                .filter(|n| *n <= MAX_SAFE)
                .ok_or_else(|| "Invalid incarnation".into()),
            _ => Err("Invalid incarnation".into()),
        }
    }
}

/// The reducer's `relation.self-edge` invariant: both ends never coincide.
fn refuse_self_edge(edge: &Endpoints) -> Result<(), String> {
    if edge.from_kind == edge.to_kind && edge.from_id == edge.to_id {
        return Err("关系的两端不能是同一个实体".into());
    }
    Ok(())
}

fn endpoints(relation: &WorkspaceRelation) -> Endpoints {
    Endpoints {
        from_kind: relation.from_kind.clone(),
        from_id: relation.from_id.clone(),
        to_kind: relation.to_kind.clone(),
        to_id: relation.to_id.clone(),
    }
}

fn relation_from_row(row: &[V]) -> Result<WorkspaceRelation, String> {
    Ok(WorkspaceRelation {
        id: string(row, 0)?,
        project_id: string(row, 1)?,
        from_kind: string(row, 2)?,
        from_id: string(row, 3)?,
        to_kind: string(row, 4)?,
        to_id: string(row, 5)?,
        relation_type_id: string(row, 6)?,
        created_at: string(row, 7)?,
        updated_at: string(row, 8)?,
    })
}
