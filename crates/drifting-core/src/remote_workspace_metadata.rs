//! Native workspace metadata receiver. The envelope is immutable protocol input;
//! lifecycle and field tables are indexes into it, never trusted payload stores.
//! This bounded reducer accepts chapter creation, title/order and primary-clear
//! registers. It does not synthesize local authored changes or lifecycle repair.
use crate::database::{DatabaseGateway, DatabaseValue as V};
use crate::original_operation::{ChangeSetRef, VerifiedChangeSet, VerifiedMutation};
use crate::original_operation_store::OriginalOperationStore;
use crate::prose_journal::AuthoredProseContext;
use crate::remote_workspace::utc_iso;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

#[cfg(test)]
mod tests;

fn fail(message: &str) -> String {
    format!("Remote workspace metadata: {message}")
}
fn require(value: bool, message: &str) -> Result<(), String> {
    if value {
        Ok(())
    } else {
        Err(fail(message))
    }
}
fn text(value: &str) -> V {
    V::Text(value.into())
}
fn integer(value: u64) -> V {
    V::Integer(value.to_string())
}
fn str_at(row: &[V], index: usize) -> Result<&str, String> {
    match row.get(index) {
        Some(V::Text(value)) => Ok(value),
        _ => Err(fail("invalid stored text")),
    }
}
fn uint_at(row: &[V], index: usize) -> Result<u64, String> {
    match row.get(index) {
        Some(V::Integer(value)) => value
            .parse::<u64>()
            .ok()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or_else(|| fail("invalid stored clock")),
        _ => Err(fail("invalid stored clock")),
    }
}
fn nonblank(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.chars().any(|c| {
            !matches!(c,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' |
        '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
        })
    })
}
fn finite(value: &Value) -> bool {
    value.as_f64().is_some_and(f64::is_finite)
}
fn object(value: &Value) -> Result<&Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| fail("expected metadata object"))
}
#[derive(Clone, Debug)]
enum Metadata {
    Create(Map<String, Value>),
    Field { field: String, value: Value },
}
fn parse(mutation: &VerifiedMutation) -> Result<Option<Metadata>, String> {
    let target = mutation.target();
    if mutation.action() == "yjs.update" {
        require(
            target.family == "yjs" && target.kind == "prose-document",
            "unsupported prose target",
        )?;
        mutation.original_yjs_update()?;
        return Ok(None);
    }
    require(target.family == "entity", "unsupported metadata family")?;
    let payload = mutation.payload_json()?;
    let payload = object(&payload)?;
    match (mutation.action(), target.kind.as_str()) {
        ("entity.create", "node") => {
            require(
                target.incarnation == 0,
                "chapter creation must use incarnation zero",
            )?;
            require(payload.len() == 1, "unsupported create payload field")?;
            let seed = object(payload.get("seed").ok_or_else(|| fail("missing seed"))?)?;
            require(
                seed.get("title").is_some_and(nonblank),
                "invalid chapter title",
            )?;
            require(
                seed.get("kind").and_then(Value::as_str) == Some("chapter"),
                "only chapter seeds are supported",
            )?;
            require(
                seed.get("bookOrder").is_some_and(finite),
                "chapter seed needs finite bookOrder",
            )?;
            for (key, value) in seed {
                let valid = match key.as_str() {
                    "title" => nonblank(value),
                    "kind" => value.as_str() == Some("chapter"),
                    "summary" => value.is_string(),
                    "bookOrder" | "positionX" | "positionY" | "wordCount" => finite(value),
                    "narrativeOrder" | "wordCountBasisRevision" | "wordCountBasisServerSeq" => {
                        value.is_null() || finite(value)
                    }
                    "driftGroupId" | "deletedAt" => value.is_null(),
                    "writingStatus" => value.as_str().is_some_and(|s| {
                        matches!(s, "draft" | "revising" | "done" | "drifting" | "sorted")
                    }),
                    "wordCountBasisKind" | "wordCountBasisHash" => {
                        value.is_null() || value.is_string()
                    }
                    // The production materializer replaces these with canonical scope/clock.
                    "id" | "projectId" | "createdAt" | "updatedAt" => true,
                    _ => false,
                };
                require(valid, "unsupported or invalid chapter seed field")?;
            }
            Ok(Some(Metadata::Create(seed.clone())))
        }
        ("field.set", "node" | "node-storyline-primary" | "project") => {
            require(payload.len() == 2, "unsupported field payload key")?;
            let field = payload
                .get("field")
                .and_then(Value::as_str)
                .ok_or_else(|| fail("missing field name"))?;
            let value = payload
                .get("value")
                .ok_or_else(|| fail("missing field value"))?;
            let valid = match (target.kind.as_str(), field) {
                ("node", "title") | ("project", "name") => nonblank(value),
                ("node", "bookOrder") => finite(value),
                ("node-storyline-primary", "storylineId") => value.is_null(),
                _ => false,
            };
            require(valid, "unsupported or invalid authored field")?;
            Ok(Some(Metadata::Field {
                field: field.into(),
                value: value.clone(),
            }))
        }
        _ => Err(fail("unsupported metadata action or target")),
    }
}

/// Whole-envelope preflight. No SQLite writes occur on unsupported mutations.
pub(crate) fn validate(original: &VerifiedChangeSet) -> Result<(), String> {
    for mutation in original.mutations() {
        if let Some(Metadata::Create(_)) = parse(mutation)? {
            let doc_id = format!("node-content:{}", mutation.target().id);
            require(
                original
                    .mutations()
                    .iter()
                    .filter(|m| {
                        m.action() == "yjs.update"
                            && m.target().kind == "prose-document"
                            && m.target().id == doc_id
                            && m.target().incarnation == 0
                    })
                    .count()
                    == 1,
                "chapter create requires exactly one same-original prose seed",
            )?;
        }
    }
    Ok(())
}

/// The TypeScript SyncTotalOrderV1 tuple: numeric HLC then UTF-8 writer/epoch,
/// numeric sequence and mutation index. No arrival order participates.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct Order(u64, u64, String, String, u64, u64);
impl Order {
    fn incoming(original: &VerifiedChangeSet, mutation: &VerifiedMutation) -> Self {
        Self(
            original.hlc_wall_ms(),
            original.hlc_counter(),
            original.writer_id().into(),
            original.writer_epoch().into(),
            original.device_seq(),
            mutation.index(),
        )
    }
    fn row(row: &[V]) -> Result<Self, String> {
        Ok(Self(
            uint_at(row, 0)?,
            uint_at(row, 1)?,
            str_at(row, 2)?.into(),
            str_at(row, 3)?.into(),
            uint_at(row, 4)?,
            uint_at(row, 6)?,
        ))
    }
    fn values(&self, source: &str) -> Vec<V> {
        vec![
            integer(self.0),
            integer(self.1),
            text(&self.2),
            text(&self.3),
            integer(self.4),
            text(source),
            integer(self.5),
        ]
    }
}
const CLOCK: &str =
    "hlc_wall_ms,hlc_counter,writer_id,writer_epoch,device_seq,change_set_id,mutation_index";
struct Reducer<'a> {
    gateway: &'a DatabaseGateway,
    client: &'a str,
    tx: u64,
    original: &'a VerifiedChangeSet,
}
impl Reducer<'_> {
    fn query(&self, sql: &str, params: Vec<V>) -> Result<Vec<Vec<V>>, String> {
        Ok(self
            .gateway
            .query(sql.into(), params, Some(self.tx), self.client.into())?
            .rows)
    }
    fn execute(&self, sql: &str, params: Vec<V>) -> Result<(), String> {
        self.gateway
            .execute(sql.into(), params, Some(self.tx), self.client.into())?;
        Ok(())
    }
    fn scope(&self) -> &ChangeSetRef {
        self.original.source()
    }
    fn guard(&self, kind: &str, id: &str, incarnation: u64) -> Result<(), String> {
        let owner_kind = if kind == "node-storyline-primary" {
            "node"
        } else {
            kind
        };
        if kind == "project" {
            require(
                id == self.scope().project_id,
                "project target is outside the current project",
            )?;
        } else {
            let rows = self.query(
                "SELECT project_id,kind,deleted_at FROM book_node WHERE id=?",
                vec![text(id)],
            )?;
            if let Some(row) = rows.first() {
                require(
                    str_at(row, 0)? == self.scope().project_id
                        && str_at(row, 1)? == "chapter"
                        && row[2] == V::Null,
                    "chapter owner is foreign, deleted or unsupported",
                )?;
            }
        }
        let rows = self.query("SELECT incarnation,state FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind=? AND entity_id=?",
            vec![text(&self.scope().sync_generation_id),text(owner_kind),text(id)])?;
        match rows.first() {
            Some(row) => require(
                uint_at(row, 0)? == incarnation && str_at(row, 1)? == "live",
                "target lifecycle is not current and live",
            ),
            None => require(incarnation == 0, "missing current incarnation"),
        }
    }
    fn lifecycle(&self, id: &str) -> Result<Option<Vec<V>>, String> {
        Ok(self.query(&format!("SELECT {CLOCK} FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind='node' AND entity_id=?"),
            vec![text(&self.scope().sync_generation_id),text(id)])?.into_iter().next())
    }
    fn field_rows(&self, kind: &str, id: &str, incarnation: u64) -> Result<Vec<Vec<V>>, String> {
        self.query(&format!("SELECT {CLOCK},field_key FROM sync_field_clock WHERE sync_generation_id=? AND target_kind=? AND target_id=? AND incarnation=? ORDER BY field_key COLLATE BINARY"),
            vec![text(&self.scope().sync_generation_id),text(kind),text(id),integer(incarnation)])
    }
    /// A clock row is only a selector. Re-read its immutable envelope, ALL
    /// mutation rows and applied receipt; match the complete indexed order.
    fn indexed(
        &self,
        row: &[V],
        kind: &str,
        id: &str,
        incarnation: u64,
    ) -> Result<Metadata, String> {
        let order = Order::row(row)?;
        let source_id = str_at(row, 5)?;
        let stored;
        let source = if source_id == self.scope().change_set_id {
            self.original
        } else {
            let rows = self.query("SELECT CASE WHEN typeof(payload_sha256)='text' AND length(CAST(payload_sha256 AS BLOB))=64 THEN payload_sha256 ELSE NULL END FROM sync_change_set WHERE change_set_id=?",vec![text(source_id)])?;
            let row = rows
                .first()
                .ok_or_else(|| fail("missing indexed original"))?;
            let reference = ChangeSetRef {
                change_set_id: source_id.into(),
                original_envelope_sha256: str_at(row, 0)?.into(),
                ..self.scope().clone()
            };
            stored = OriginalOperationStore::new(self.gateway, self.client)
                .load_change_set_in_transaction(&reference, self.tx)?;
            &stored
        };
        let mutation = source
            .mutations()
            .get(order.5 as usize)
            .ok_or_else(|| fail("missing indexed mutation"))?;
        let target = mutation.target();
        require(
            target.family == "entity"
                && target.kind == kind
                && target.id == id
                && target.incarnation == incarnation
                && Order::incoming(source, mutation) == order,
            "indexed mutation disagrees with immutable original",
        )?;
        let parsed = parse(mutation)?.ok_or_else(|| fail("indexed mutation is not metadata"))?;
        match &parsed {
            Metadata::Create(_) => require(row.len() == 7, "lifecycle selected as a field")?,
            Metadata::Field { field, .. } => require(
                row.len() == 8 && str_at(row, 7)? == format!("field:{field}"),
                "field index disagrees with original",
            )?,
        }
        Ok(parsed)
    }
    fn write_register(
        &self,
        mutation: &VerifiedMutation,
        metadata: &Metadata,
    ) -> Result<(), String> {
        let target = mutation.target();
        self.guard(&target.kind, &target.id, target.incarnation)?;
        let incoming = Order::incoming(self.original, mutation);
        let current = match metadata {
            Metadata::Create(_) => self.lifecycle(&target.id)?,
            Metadata::Field { field, .. } => self
                .field_rows(&target.kind, &target.id, target.incarnation)?
                .into_iter()
                .find(|row| str_at(row, 7).ok() == Some(format!("field:{field}").as_str())),
        };
        if let Some(row) = current {
            self.indexed(&row, &target.kind, &target.id, target.incarnation)?;
            if incoming <= Order::row(&row)? {
                return Ok(());
            }
        }
        let mut params = vec![
            text(&self.scope().sync_generation_id),
            text(&target.kind),
            text(&target.id),
            integer(target.incarnation),
        ];
        match metadata {
            Metadata::Create(_) => {
                params.extend(incoming.values(&self.scope().change_set_id));
                self.execute("INSERT INTO sync_entity_lifecycle(sync_generation_id,entity_kind,entity_id,incarnation,state,hlc_wall_ms,hlc_counter,writer_id,writer_epoch,device_seq,change_set_id,mutation_index) VALUES (?,?,?,?,'live',?,?,?,?,?,?,?) ON CONFLICT(sync_generation_id,entity_kind,entity_id) DO UPDATE SET incarnation=excluded.incarnation,state=excluded.state,hlc_wall_ms=excluded.hlc_wall_ms,hlc_counter=excluded.hlc_counter,writer_id=excluded.writer_id,writer_epoch=excluded.writer_epoch,device_seq=excluded.device_seq,change_set_id=excluded.change_set_id,mutation_index=excluded.mutation_index",params)
            }
            Metadata::Field { field, .. } => {
                params.push(text(&format!("field:{field}")));
                params.extend(incoming.values(&self.scope().change_set_id));
                self.execute("INSERT INTO sync_field_clock(sync_generation_id,target_kind,target_id,incarnation,field_key,hlc_wall_ms,hlc_counter,writer_id,writer_epoch,device_seq,change_set_id,mutation_index) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sync_generation_id,target_kind,target_id,incarnation,field_key) DO UPDATE SET hlc_wall_ms=excluded.hlc_wall_ms,hlc_counter=excluded.hlc_counter,writer_id=excluded.writer_id,writer_epoch=excluded.writer_epoch,device_seq=excluded.device_seq,change_set_id=excluded.change_set_id,mutation_index=excluded.mutation_index",params)
            }
        }
    }
    fn project_node(&self, id: &str, incarnation: u64) -> Result<(), String> {
        self.guard("node", id, incarnation)?;
        if let Some(row) = self.lifecycle(id)? {
            let Metadata::Create(seed) = self.indexed(&row, "node", id, incarnation)? else {
                return Err(fail("unsupported lifecycle source"));
            };
            let iso = utc_iso(Order::row(&row)?.0);
            let number = |name: &str, default: V| {
                seed.get(name)
                    .filter(|value| !value.is_null())
                    .and_then(Value::as_f64)
                    .map(V::Real)
                    .unwrap_or(default)
            };
            self.execute("INSERT INTO book_node(id,title,summary,book_order,narrative_order,project_id,writing_status,kind,drift_group_id,position_x,position_y,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,'chapter',NULL,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET title=excluded.title,summary=excluded.summary,book_order=excluded.book_order,narrative_order=excluded.narrative_order,project_id=excluded.project_id,writing_status=excluded.writing_status,kind=excluded.kind,drift_group_id=excluded.drift_group_id,position_x=excluded.position_x,position_y=excluded.position_y,updated_at=excluded.updated_at,deleted_at=NULL",
                vec![text(id),text(seed["title"].as_str().unwrap()),text(seed.get("summary").and_then(Value::as_str).unwrap_or("")),
                    number("bookOrder",V::Real(0.0)),number("narrativeOrder",V::Null),text(&self.scope().project_id),
                    text(seed.get("writingStatus").and_then(Value::as_str).unwrap_or("draft")),number("positionX",V::Real(0.0)),number("positionY",V::Real(0.0)),text(&iso),text(&iso)])?;
            self.execute("INSERT INTO node_content(node_id,content_json,created_at,updated_at) VALUES (?,'{}',?,?) ON CONFLICT(node_id) DO NOTHING",vec![text(id),text(&iso),text(&iso)])?;
        }
        // SQL UPDATE with no owner intentionally does nothing; its immutable
        // winning register remains available when a late create seed arrives.
        self.project_fields("node", id, incarnation)?;
        self.project_fields("node-storyline-primary", id, incarnation)
    }
    fn project_fields(&self, kind: &str, id: &str, incarnation: u64) -> Result<(), String> {
        for row in self.field_rows(kind, id, incarnation)? {
            let Metadata::Field { field, value } = self.indexed(&row, kind, id, incarnation)?
            else {
                return Err(fail("invalid field source"));
            };
            let iso = utc_iso(Order::row(&row)?.0);
            match (kind, field.as_str()) {
                ("node", "title") => self.execute(
                    "UPDATE book_node SET title=?,updated_at=? WHERE id=? AND project_id=?",
                    vec![
                        text(value.as_str().unwrap()),
                        text(&iso),
                        text(id),
                        text(&self.scope().project_id),
                    ],
                )?,
                ("node", "bookOrder") => self.execute(
                    "UPDATE book_node SET book_order=?,updated_at=? WHERE id=? AND project_id=?",
                    vec![
                        V::Real(value.as_f64().unwrap()),
                        text(&iso),
                        text(id),
                        text(&self.scope().project_id),
                    ],
                )?,
                ("node-storyline-primary", "storylineId") => self.execute(
                    "UPDATE node_storyline_link SET is_primary=0 WHERE node_id=?",
                    vec![text(id)],
                )?,
                ("project", "name") => self.execute(
                    "UPDATE project SET name=?,updated_at=? WHERE id=?",
                    vec![text(value.as_str().unwrap()), text(&iso), text(id)],
                )?,
                _ => return Err(fail("unsupported winning field")),
            }
        }
        Ok(())
    }
}

/// Apply metadata inside the receiver's transaction, after its original/rows
/// have been staged and before any prose projector or published apply receipt.
pub(crate) fn apply(
    gateway: &DatabaseGateway,
    client: &str,
    tx: u64,
    context: &AuthoredProseContext,
    original: &VerifiedChangeSet,
) -> Result<(), String> {
    validate(original)?;
    let source = original.source();
    require(
        context.project_id == source.project_id
            && context.project_sync_id == source.project_sync_id
            && context.sync_generation_id == source.sync_generation_id,
        "context and original scope differ",
    )?;
    let reducer = Reducer {
        gateway,
        client,
        tx,
        original,
    };
    require(reducer.query("SELECT 1 FROM sync_generation g JOIN project p ON p.id=g.project_id WHERE g.sync_generation_id=? AND g.project_id=? AND g.project_sync_id=? AND g.status='active' AND NOT EXISTS(SELECT 1 FROM sync_entity_lifecycle l WHERE l.sync_generation_id=g.sync_generation_id AND l.entity_kind='project' AND l.entity_id=p.id AND l.state!='live') AND NOT EXISTS(SELECT 1 FROM sync_generation_purge x WHERE x.sync_generation_id=g.sync_generation_id)",
        vec![text(&source.sync_generation_id),text(&source.project_id),text(&source.project_sync_id)])?.len()==1,"project generation is not current")?;
    let mut nodes = BTreeMap::new();
    let mut projects = BTreeSet::new();
    for mutation in original.mutations() {
        let Some(metadata) = parse(mutation)? else {
            continue;
        };
        reducer.write_register(mutation, &metadata)?;
        let target = mutation.target();
        if target.kind == "project" {
            projects.insert((target.id.clone(), target.incarnation));
        } else {
            nodes.insert(target.id.clone(), target.incarnation);
        }
    }
    for (id, incarnation) in nodes {
        reducer.project_node(&id, incarnation)?;
    }
    for (id, incarnation) in projects {
        reducer.project_fields("project", &id, incarnation)?;
    }
    Ok(())
}
