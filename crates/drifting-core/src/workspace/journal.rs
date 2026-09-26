//! Fixed workspace commands use the existing writer reservation and CBOR
//! primitives. These metadata inserts are the create/order/field subset of the
//! local reducer; they do not implement remote conflict resolution.
use super::*;
use crate::original_operation::{verify_change_set, ChangeSetRef};
use crate::prose::AppendedUpdate;
use crate::prose_journal::encoding::{hash, Cbor};

pub(super) struct Mutation {
    family: &'static str,
    kind: &'static str,
    id: String,
    incarnation: u64,
    action: &'static str,
    payload: Value,
    update: Option<Vec<u8>>,
}
impl Mutation {
    pub(super) fn at_incarnation(mut self, incarnation: u64) -> Self {
        self.incarnation = incarnation;
        self
    }
    pub(super) fn create(kind: &'static str, id: &str, seed: Value) -> Self {
        Self::json("entity", kind, id, "entity.create", json!({"seed":seed}))
    }
    pub(super) fn json(
        family: &'static str,
        kind: &'static str,
        id: &str,
        action: &'static str,
        payload: Value,
    ) -> Self {
        Self {
            family,
            kind,
            id: id.into(),
            incarnation: 0,
            action,
            payload,
            update: None,
        }
    }
    pub(super) fn field(
        kind: &'static str,
        id: &str,
        incarnation: u64,
        field: &str,
        value: Value,
    ) -> Self {
        Self {
            family: "entity",
            kind,
            id: id.into(),
            incarnation,
            action: "field.set",
            payload: json!({"field": field, "value": value}),
            update: None,
        }
    }
    pub(super) fn yjs(id: &str, update: &[u8]) -> Self {
        Self {
            family: "yjs",
            kind: "prose-document",
            id: id.into(),
            incarnation: 0,
            action: "yjs.update",
            payload: Value::Null,
            update: Some(update.to_vec()),
        }
    }
    fn payload(&self) -> Cbor<'_> {
        if let Some(update) = &self.update {
            Cbor::Map(vec![("update", Cbor::Bytes(update))])
        } else {
            cbor(&self.payload)
        }
    }
    fn wire<'a>(&'a self, index: usize, payload_hash: &'a str) -> Cbor<'a> {
        use Cbor::*;
        Map(vec![
            ("index", Uint(index as u64)),
            (
                "target",
                Map(vec![
                    ("family", Text(self.family)),
                    ("kind", Text(self.kind)),
                    ("id", Text(&self.id)),
                    ("incarnation", Uint(self.incarnation)),
                ]),
            ),
            ("action", Text(self.action)),
            ("payloadVersion", Uint(1)),
            ("payload", self.payload()),
            ("payloadSha256", Text(payload_hash)),
        ])
    }
}
fn cbor(value: &Value) -> Cbor<'_> {
    match value {
        Value::Null => Cbor::Null,
        Value::Bool(v) => Cbor::Bool(*v),
        Value::Number(v) => Cbor::Number(
            v.as_f64()
                .expect("workspace only emits finite JSON numbers"),
        ),
        Value::String(v) => Cbor::Text(v),
        Value::Array(v) => Cbor::Array(v.iter().map(cbor).collect()),
        Value::Object(v) => Cbor::Map(v.iter().map(|(k, v)| (k.as_str(), cbor(v))).collect()),
    }
}
impl WorkspaceStore<'_> {
    pub(super) fn commit_changes(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        mutations: &[Mutation],
        seed: Option<(usize, &AppendedUpdate, &[u8])>,
    ) -> Result<(), String> {
        let (writer, epoch, seq, wall, counter) =
            AuthoredProseJournal::new(self.gateway, self.client).reserve_writer(tx, context)?;
        let change_id = format!("{writer}:{epoch}:{seq}");
        let payloads: Vec<Vec<u8>> = mutations.iter().map(|m| m.payload().bytes()).collect();
        let hashes: Vec<String> = payloads.iter().map(|p| hash(p)).collect();
        let wire_hashes: Vec<String> = hashes.iter().map(|h| format!("sha256:{h}")).collect();
        use Cbor::*;
        let bytes = Map(vec![
            ("protocol", Text("drifting.sync.changeset")),
            ("protocolVersion", Uint(1)),
            ("payloadVersion", Uint(1)),
            ("projectId", Text(&context.project_id)),
            ("projectSyncId", Text(&context.project_sync_id)),
            ("syncGenerationId", Text(&context.sync_generation_id)),
            ("changeSetId", Text(&change_id)),
            ("writerId", Text(&writer)),
            ("writerEpoch", Text(&epoch)),
            ("deviceSeq", Uint(seq)),
            (
                "hlc",
                Map(vec![("wallMs", Uint(wall)), ("counter", Uint(counter))]),
            ),
            (
                "mutations",
                Array(
                    mutations
                        .iter()
                        .enumerate()
                        .map(|(i, m)| m.wire(i, &wire_hashes[i]))
                        .collect(),
                ),
            ),
        ])
        .bytes();
        let envelope_hash = hash(&bytes);
        // Use the same bounded original verifier as native cold readers before
        // any immutable journal rows are written.
        verify_change_set(
            &bytes,
            &ChangeSetRef {
                project_id: context.project_id.clone(),
                project_sync_id: context.project_sync_id.clone(),
                sync_generation_id: context.sync_generation_id.clone(),
                change_set_id: change_id.clone(),
                original_envelope_sha256: envelope_hash.clone(),
            },
        )?;
        self.execute(tx,r#"
            INSERT INTO sync_change_set(change_set_id,sync_generation_id,project_id,project_sync_id,
                writer_id,writer_epoch,device_seq,hlc_wall_ms,hlc_counter,protocol_version,payload_version,
                mutation_count,encoded_bytes,payload_sha256,origin,apply_state,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?,?,'local','applying',?)
        "#,vec![text(&change_id),text(&context.sync_generation_id),text(&context.project_id),text(&context.project_sync_id),
            text(&writer),text(&epoch),integer(seq),integer(wall),integer(counter),integer(mutations.len() as u64),
            V::Blob(bytes),text(&envelope_hash),text(&context.now_iso)])?;
        for (index, mutation) in mutations.iter().enumerate() {
            self.execute(tx,r#"
                INSERT INTO sync_mutation(change_set_id,mutation_index,target_family,target_kind,target_id,
                    incarnation,action,payload_version,payload_cbor,payload_sha256)
                VALUES (?,?,?,?,?,?,?,1,?,?)
            "#,vec![text(&change_id),integer(index as u64),text(mutation.family),text(mutation.kind),text(&mutation.id),integer(mutation.incarnation),
                text(mutation.action),V::Blob(payloads[index].clone()),text(&hashes[index])])?;
            let clock = vec![
                integer(wall),
                integer(counter),
                text(&writer),
                text(&epoch),
                integer(seq),
                text(&change_id),
                integer(index as u64),
            ];
            match mutation.action {
                "entity.create" => {
                    let mut values = vec![
                        text(&context.sync_generation_id),
                        text(mutation.kind),
                        text(&mutation.id),
                        integer(mutation.incarnation),
                    ];
                    values.extend(clock);
                    self.execute(tx,r#"
                        INSERT INTO sync_entity_lifecycle(sync_generation_id,entity_kind,entity_id,incarnation,state,
                            hlc_wall_ms,hlc_counter,writer_id,writer_epoch,device_seq,change_set_id,mutation_index)
                        VALUES (?,?,?,?,'live',?,?,?,?,?,?,?)
                    "#,values)?;
                }
                "entity.trash" | "entity.restore" | "entity.purge" => {
                    let (previous_state, state, previous_incarnation) =
                        if mutation.action == "entity.restore" {
                            (
                                "trashed",
                                "live",
                                mutation
                                    .incarnation
                                    .checked_sub(1)
                                    .ok_or("Restored incarnation must advance")?,
                            )
                        } else if mutation.action == "entity.purge" {
                            // Only removing a book-axis separator is exposed.
                            // This must not become a chapter/content purge path.
                            if mutation.family != "entity" || mutation.kind != "book-act" {
                                return Err("Unsupported workspace purge target".into());
                            }
                            ("live", "purged", mutation.incarnation)
                        } else {
                            ("live", "trashed", mutation.incarnation)
                        };
                    let mut values = vec![integer(mutation.incarnation), text(state)];
                    values.extend(clock);
                    values.extend([
                        text(&context.sync_generation_id),
                        text(mutation.kind),
                        text(&mutation.id),
                        integer(previous_incarnation),
                        text(previous_state),
                    ]);
                    let changed = self.gateway.execute(
                        r#"
                        UPDATE sync_entity_lifecycle SET incarnation=?,state=?,
                            hlc_wall_ms=?,hlc_counter=?,writer_id=?,writer_epoch=?,device_seq=?,
                            change_set_id=?,mutation_index=?
                        WHERE sync_generation_id=? AND entity_kind=? AND entity_id=?
                            AND incarnation=? AND state=?
                    "#
                        .into(),
                        values,
                        Some(tx),
                        self.client.into(),
                    )?;
                    if changed.changes != 1 {
                        return Err("Entity lifecycle changed during workspace command".into());
                    }
                }
                "order.move" => {
                    let scope = mutation.payload["scope"]
                        .as_str()
                        .ok_or("Missing workspace order scope")?;
                    let position = mutation.payload["positionKey"]
                        .as_str()
                        .ok_or("Missing workspace order key")?;
                    let mut values = vec![
                        text(&context.sync_generation_id),
                        text(mutation.kind),
                        text(scope),
                        text(&mutation.id),
                        integer(mutation.incarnation),
                        text(position),
                    ];
                    values.extend(clock);
                    self.execute(tx,r#"
                        INSERT INTO sync_order_register(sync_generation_id,list_kind,owner_id,entity_id,incarnation,
                            position_key,hlc_wall_ms,hlc_counter,writer_id,writer_epoch,device_seq,change_set_id,mutation_index)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    "#,values)?;
                }
                "field.set" | "tuple.set" => {
                    let key = if mutation.action == "tuple.set" {
                        "tuple"
                    } else {
                        "field"
                    };
                    let field = mutation.payload[key]
                        .as_str()
                        .ok_or("Missing workspace field key")?;
                    let mut values = vec![
                        text(&context.sync_generation_id),
                        text(mutation.kind),
                        text(&mutation.id),
                        integer(mutation.incarnation),
                        text(&format!("{key}:{field}")),
                    ];
                    values.extend(clock);
                    self.execute(tx,r#"
                        INSERT INTO sync_field_clock(sync_generation_id,target_kind,target_id,incarnation,field_key,
                            hlc_wall_ms,hlc_counter,writer_id,writer_epoch,device_seq,change_set_id,mutation_index)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(sync_generation_id,target_kind,target_id,incarnation,field_key)
                        DO UPDATE SET hlc_wall_ms=excluded.hlc_wall_ms, hlc_counter=excluded.hlc_counter,
                            writer_id=excluded.writer_id, writer_epoch=excluded.writer_epoch,
                            device_seq=excluded.device_seq, change_set_id=excluded.change_set_id,
                            mutation_index=excluded.mutation_index
                    "#,values)?;
                }
                "yjs.update" => {}
                _ => return Err("Unsupported workspace mutation".into()),
            }
        }
        if let Some((index, appended, update)) = seed {
            let mutation = &mutations[index];
            if mutation.update.as_deref() != Some(update) {
                return Err("Workspace seed binding mismatch".into());
            }
            self.execute(
                tx,
                r#"
                INSERT INTO sync_yjs_materialization_receipt (
                    change_set_id, mutation_index, admission_version, original_envelope_sha256,
                    document_id, incarnation, event_sha256, update_row_id, document_revision, created_at
                 ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
                "#,
                vec![
                    text(&change_id), integer(index as u64), text(&envelope_hash), text(&mutation.id), integer(mutation.incarnation),
                    text(&crate::materialization_admission::event_hash(update)),
                    integer(appended.update_id), integer(appended.revision), text(&context.now_iso),
                ],
            )?;
        }
        self.execute(
            tx,
            r#"
            INSERT INTO sync_apply_receipt (change_set_id, sync_generation_id, mutation_count, applied_at)
            VALUES (?, ?, ?, ?)
            "#,
            vec![text(&change_id), text(&context.sync_generation_id), integer(mutations.len() as u64), text(&context.now_iso)],
        )?;
        self.execute(
            tx,
            "UPDATE sync_change_set SET apply_state='applied',applied_at=? WHERE change_set_id=?",
            vec![text(&context.now_iso), text(&change_id)],
        )?;
        Ok(())
    }
}
