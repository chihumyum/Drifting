//! Normalized key/value facts (`entity_kv_entry`) with the renderer's
//! authority: stable entry IDs, lifecycle/field originals and fractional
//! order registers, then the legacy JSON projection on the owner row.
use super::*;
use crate::fractional::keys_between;
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fact {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Copy)]
pub(super) struct FactOwner<'a> {
    pub kind: &'static str,
    pub id: &'a str,
    pub namespace: &'static str,
}

impl FactOwner<'_> {
    /// `JSON.stringify([ownerKind, ownerId, namespace])`.
    fn scope(&self) -> String {
        json!([self.kind, self.id, self.namespace]).to_string()
    }
}

struct Entry {
    id: String,
    fact: Fact,
}

/// `stringifyKv` keeps rows whose key or value is non-blank; nothing is trimmed.
pub(super) fn cleaned(facts: &[Fact]) -> Vec<Fact> {
    facts
        .iter()
        .filter(|fact| !js_trim(&fact.key).is_empty() || !js_trim(&fact.value).is_empty())
        .cloned()
        .collect()
}

/// The projection written to `kv_json` / `element_template_kv_json`.
pub(super) fn facts_json(facts: &[Fact]) -> String {
    json!(facts).to_string()
}

impl WorkspaceStore<'_> {
    fn ordered_facts(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        owner: FactOwner<'_>,
    ) -> Result<(Vec<Entry>, HashMap<String, String>), String> {
        let rows = self.query(
            Some(tx),
            r#"
            SELECT id,key,value FROM entity_kv_entry
            WHERE project_id=? AND owner_kind=? AND owner_id=? AND namespace=?
        "#,
            vec![
                text(&context.project_id),
                text(owner.kind),
                text(owner.id),
                text(owner.namespace),
            ],
        )?;
        let positions: HashMap<String, String> = self
            .query(
                Some(tx),
                r#"
            SELECT entity_id,position_key FROM sync_order_register
            WHERE sync_generation_id=? AND list_kind='kv-entry' AND owner_id=? AND incarnation=0
        "#,
                vec![text(&context.sync_generation_id), text(&owner.scope())],
            )?
            .iter()
            .map(|row| Ok((string(row, 0)?, string(row, 1)?)))
            .collect::<Result<_, String>>()?;
        let mut entries = rows
            .iter()
            .map(|row| {
                Ok(Entry {
                    id: string(row, 0)?,
                    fact: Fact {
                        key: string(row, 1)?,
                        value: string(row, 2)?,
                    },
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        if entries
            .iter()
            .any(|entry| !positions.contains_key(&entry.id))
        {
            return Err("Facts have rows without order registers".into());
        }
        entries.sort_by(|a, b| {
            positions[&a.id]
                .as_bytes()
                .cmp(positions[&b.id].as_bytes())
                .then(a.id.cmp(&b.id))
        });
        Ok((entries, positions))
    }

    /// Replace one owner's facts, appending the renderer's mutations in its
    /// order: purges, creates/field sets in desired order, then order moves for
    /// inserted runs or one rebalance per entry after a reorder. Returns the
    /// new projection JSON; the caller writes it to the owner row.
    pub(super) fn replace_facts(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        owner: FactOwner<'_>,
        desired: &[Fact],
        new_id: &mut dyn FnMut() -> Result<String, String>,
        mutations: &mut Vec<journal::Mutation>,
    ) -> Result<String, String> {
        let (existing, positions) = self.ordered_facts(tx, context, owner)?;
        let desired = cleaned(desired);
        // Renderer reconcileKvEntryIds: exact rows, then equal keys, then the
        // same slot only when the cardinality is unchanged.
        let mut unused: Vec<bool> = vec![true; existing.len()];
        let mut matches: Vec<Option<usize>> = vec![None; desired.len()];
        for pass in 0..2 {
            for (index, fact) in desired.iter().enumerate() {
                if matches[index].is_some() {
                    continue;
                }
                let found = existing.iter().enumerate().position(|(i, entry)| {
                    unused[i]
                        && entry.fact.key == fact.key
                        && (pass == 1 || entry.fact.value == fact.value)
                });
                if let Some(found) = found {
                    matches[index] = Some(found);
                    unused[found] = false;
                }
            }
        }
        if existing.len() == desired.len() {
            for index in 0..desired.len() {
                if matches[index].is_none() && unused[index] {
                    matches[index] = Some(index);
                    unused[index] = false;
                }
            }
        }
        let mut ids = Vec::with_capacity(desired.len());
        for found in &matches {
            ids.push(match found {
                Some(found) => existing[*found].id.clone(),
                None => {
                    let id = new_id()?;
                    if !opaque(&id) {
                        return Err("Invalid new fact identity".into());
                    }
                    id
                }
            });
        }
        for (index, entry) in existing.iter().enumerate() {
            if !unused[index] {
                continue;
            }
            self.execute(
                tx,
                "DELETE FROM entity_kv_entry WHERE id=? AND project_id=?",
                vec![text(&entry.id), text(&context.project_id)],
            )?;
            mutations.push(journal::Mutation::json(
                "entity",
                "kv-entry",
                &entry.id,
                "entity.purge",
                json!({}),
            ));
        }
        for (index, fact) in desired.iter().enumerate() {
            let id = &ids[index];
            match matches[index].map(|found| &existing[found]) {
                None => {
                    self.execute(tx, r#"
                        INSERT INTO entity_kv_entry(id,project_id,owner_kind,owner_id,namespace,key,value)
                        VALUES (?,?,?,?,?,?,?)
                    "#, vec![text(id), text(&context.project_id), text(owner.kind), text(owner.id),
                        text(owner.namespace), text(&fact.key), text(&fact.value)])?;
                    mutations.push(journal::Mutation::create("kv-entry", id, json!({
                        "projectId": context.project_id, "ownerKind": owner.kind, "ownerId": owner.id,
                        "namespace": owner.namespace, "key": fact.key, "value": fact.value,
                    })));
                }
                Some(current) if current.fact != *fact => {
                    self.execute(
                        tx,
                        "UPDATE entity_kv_entry SET key=?,value=? WHERE id=? AND project_id=?",
                        vec![
                            text(&fact.key),
                            text(&fact.value),
                            text(id),
                            text(&context.project_id),
                        ],
                    )?;
                    if current.fact.key != fact.key {
                        mutations.push(journal::Mutation::field(
                            "kv-entry",
                            id,
                            0,
                            "key",
                            json!(fact.key),
                        ));
                    }
                    if current.fact.value != fact.value {
                        mutations.push(journal::Mutation::field(
                            "kv-entry",
                            id,
                            0,
                            "value",
                            json!(fact.value),
                        ));
                    }
                }
                Some(_) => {}
            }
        }
        push_order(
            "kv-entry",
            &owner.scope(),
            &positions,
            &ids,
            &|_| 0,
            mutations,
        )?;
        Ok(facts_json(&desired))
    }

    /// The facts of an owner in authority order, for cloning templates.
    pub(super) fn facts(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        owner: FactOwner<'_>,
    ) -> Result<Vec<Fact>, String> {
        Ok(self
            .ordered_facts(tx, context, owner)?
            .0
            .into_iter()
            .map(|entry| entry.fact)
            .collect())
    }
}

/// Append the renderer's planned order originals for one scope:
/// `order.move` for inserted runs, or one `order.rebalance` per entry after a
/// reorder. `incarnation` gives each ordered entity's current incarnation.
pub(super) fn push_order(
    list_kind: &'static str,
    scope: &str,
    positions: &HashMap<String, String>,
    desired: &[String],
    incarnation: &dyn Fn(&str) -> u64,
    mutations: &mut Vec<journal::Mutation>,
) -> Result<(), String> {
    match order_plan(positions, desired)? {
        OrderPlan::Moves(entries) => {
            for (id, key) in entries {
                mutations.push(
                    journal::Mutation::json(
                        "order",
                        list_kind,
                        &id,
                        "order.move",
                        json!({"scope": scope, "positionKey": key}),
                    )
                    .at_incarnation(incarnation(&id)),
                );
            }
        }
        OrderPlan::Rebalance(entries) => {
            for (id, key) in entries {
                mutations.push(
                    journal::Mutation::json(
                        "order",
                        list_kind,
                        &id,
                        "order.rebalance",
                        json!({"scope": scope, "entries": [{"entityId": id, "positionKey": key}]}),
                    )
                    .at_incarnation(incarnation(&id)),
                );
            }
        }
    }
    Ok(())
}

enum OrderPlan {
    Moves(Vec<(String, String)>),
    Rebalance(Vec<(String, String)>),
}

/// Renderer `planAuthoredOrderMutation`: keep surviving keys; give inserted
/// runs keys between their surviving neighbours; any reorder rebalances all.
fn order_plan(
    positions: &HashMap<String, String>,
    desired: &[String],
) -> Result<OrderPlan, String> {
    let rebalance = || -> Result<OrderPlan, String> {
        let keys = keys_between(None, None, desired.len())?;
        Ok(OrderPlan::Rebalance(
            desired.iter().cloned().zip(keys).collect(),
        ))
    };
    let mut current: Vec<(&String, &String)> = desired
        .iter()
        .filter_map(|id| positions.get(id).map(|key| (key, id)))
        .collect();
    current.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()).then(a.1.cmp(b.1)));
    let survivors: Vec<&String> = desired
        .iter()
        .filter(|id| positions.contains_key(*id))
        .collect();
    if survivors
        .iter()
        .zip(&current)
        .any(|(id, (_, current))| id != current)
    {
        return rebalance();
    }
    let mut entries = Vec::new();
    let mut cursor = 0;
    while cursor < desired.len() {
        if positions.contains_key(&desired[cursor]) {
            cursor += 1;
            continue;
        }
        let start = cursor;
        while cursor < desired.len() && !positions.contains_key(&desired[cursor]) {
            cursor += 1;
        }
        let left = start
            .checked_sub(1)
            .and_then(|i| positions.get(&desired[i]))
            .map(String::as_str);
        let right = desired
            .get(cursor)
            .and_then(|id| positions.get(id))
            .map(String::as_str);
        if let (Some(left), Some(right)) = (left, right) {
            if left.as_bytes() >= right.as_bytes() {
                return rebalance();
            }
        }
        let keys = keys_between(left, right, cursor - start)?;
        entries.extend(desired[start..cursor].iter().cloned().zip(keys));
    }
    Ok(OrderPlan::Moves(entries))
}
