//! The 0.1 snapshot history's metadata, replayed into the book document
//! (`m10-import.md` "快照历史的元数据").
//!
//! Every 0.1 history row kept, beside the body, a JSON bag of the entity's
//! restorable fields at that moment (`snapshot-history.service.ts`
//! `entityMeta`): a chapter's title, summary and writing status; an
//! element's name, aliases, summary, group and facts; a storyline's name,
//! summary and facts; a category's name and template fields; a material
//! note's title. 0.2 restores an object from a history point by reading
//! these fields from the book document at the point's `book_frontiers`
//! (dr-doc `metadata_fields`, `BookTxn::restore_fields`), so the import
//! writes them into the book document's history: one small commit per row,
//! at the row's time, and the history point is labelled while that version
//! is the book document's stored head.
//!
//! - The book document starts with every entity as it is now, except that
//!   an entity with history starts with its earliest row's fields; each
//!   row then sets its own fields; a last commit puts the current fields
//!   back. The final book document is the one an import without history
//!   writes (tested).
//! - A field a row does not carry (older 0.1 builds stored fewer) stays as
//!   it was, as the 0.1 restore did (`meta.x !== undefined`).
//! - Facts carry ids in 0.2 but not in `kvJson`: a row's entries take the
//!   id of the current entry with the same key and value, then the same
//!   key; the rest get an id derived from the entity, key and occurrence,
//!   so the same entry keeps one id across rows.

use std::collections::{BTreeSet, HashMap, HashSet};

use dr_doc::book::{BookTxn, BookView};
use dr_model::book::KvEntry;
use dr_model::id::*;
use dr_model::kind::NodeStatus;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::book::{kv_list, ranks};
use crate::legacy::{BookRows, ProseKind};

/// The fields one 0.1 history row carried (`SnapshotMeta`); `None` = the
/// row did not carry it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Meta {
    pub title: Option<String>,
    pub summary: Option<String>,
    pub writing_status: Option<String>,
    pub name: Option<String>,
    pub aliases: Option<Vec<String>>,
    /// Present as a string or `null`.
    pub group_name: Option<Option<String>>,
    pub kv: Option<Vec<(String, String)>>,
    pub template_kv: Option<Vec<(String, String)>>,
}

fn kv_pairs(v: Option<&Value>) -> Option<Vec<(String, String)>> {
    // `kvJson` is itself a JSON string of `[{ key, value }]`.
    let text = v?.as_str()?;
    let list: Value = serde_json::from_str(text).ok()?;
    Some(
        list.as_array()?
            .iter()
            .filter_map(|e| {
                Some((
                    e.get("key")?.as_str()?.to_string(),
                    e.get("value")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                ))
            })
            .collect(),
    )
}

/// Read a row's `meta_json`; `None` when it is not a JSON object.
pub fn parse(json: &str) -> Option<Meta> {
    let v: Value = serde_json::from_str(json).ok()?;
    let o = v.as_object()?;
    let s = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_string);
    Some(Meta {
        title: s("title"),
        summary: s("summary"),
        writing_status: s("writingStatus"),
        name: s("name"),
        aliases: o.get("aliases").and_then(Value::as_array).map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        }),
        group_name: match o.get("groupName") {
            Some(Value::String(g)) => Some(Some(g.clone())),
            Some(Value::Null) => Some(None),
            _ => None,
        },
        kv: kv_pairs(o.get("kvJson")),
        template_kv: kv_pairs(o.get("elementTemplateKvJson")),
    })
}

/// The entity a history row belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Owner {
    Node(NodeId),
    Element(ElementId),
    Storyline(StorylineId),
    Category(CategoryId),
    Material(MaterialId),
}

impl Owner {
    pub fn of(kind: ProseKind, id: &str) -> Option<Self> {
        Some(match kind {
            ProseKind::NodeContent => Self::Node(NodeId::parse(id).ok()?),
            ProseKind::Element => Self::Element(ElementId::parse(id).ok()?),
            ProseKind::Storyline => Self::Storyline(StorylineId::parse(id).ok()?),
            ProseKind::Category => Self::Category(CategoryId::parse(id).ok()?),
            ProseKind::LibraryItem => Self::Material(MaterialId::parse(id).ok()?),
        })
    }

    fn key(&self) -> String {
        match self {
            Self::Node(i) => format!("node:{i}"),
            Self::Element(i) => format!("element:{i}"),
            Self::Storyline(i) => format!("storyline:{i}"),
            Self::Category(i) => format!("category:{i}"),
            Self::Material(i) => format!("material:{i}"),
        }
    }
}

/// The restorable fields of one entity (dr-doc `metadata_fields`); `None`
/// = not set by this step.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Fields {
    pub title: Option<String>,
    pub summary: Option<String>,
    pub status: Option<NodeStatus>,
    pub name: Option<String>,
    pub aliases: Option<BTreeSet<String>>,
    pub group_name: Option<Option<String>>,
    pub facts: Option<Vec<KvEntry>>,
    pub template_fields: Option<Vec<KvEntry>>,
}

impl Fields {
    /// `self` with every field `later` sets replaced.
    pub fn then(&self, later: &Fields) -> Fields {
        Fields {
            title: later.title.clone().or_else(|| self.title.clone()),
            summary: later.summary.clone().or_else(|| self.summary.clone()),
            status: later.status.clone().or_else(|| self.status.clone()),
            name: later.name.clone().or_else(|| self.name.clone()),
            aliases: later.aliases.clone().or_else(|| self.aliases.clone()),
            group_name: later.group_name.clone().or_else(|| self.group_name.clone()),
            facts: later.facts.clone().or_else(|| self.facts.clone()),
            template_fields: later
                .template_fields
                .clone()
                .or_else(|| self.template_fields.clone()),
        }
    }
}

fn alias_set(aliases: &[String]) -> BTreeSet<String> {
    aliases
        .iter()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .collect()
}

/// The entity's current fields, exactly as `book::write` writes them; `None`
/// when the entity is not in the book's rows.
pub fn current(owner: &Owner, rows: &BookRows) -> Option<Fields> {
    Some(match owner {
        Owner::Node(id) => {
            let n = rows.nodes.iter().find(|n| n.id == id.as_str())?;
            Fields {
                title: Some(n.title.clone()),
                summary: Some(n.summary.clone()),
                status: Some(NodeStatus::parse(&n.status)),
                ..Fields::default()
            }
        }
        Owner::Element(id) => {
            let e = rows.elements.iter().find(|e| e.id == id.as_str())?;
            let aliases: Vec<String> = serde_json::from_str(&e.aliases_json).unwrap_or_default();
            Fields {
                name: Some(e.name.clone()),
                summary: Some(e.summary.clone()),
                aliases: Some(alias_set(&aliases)),
                group_name: Some(e.group_name.clone()),
                facts: Some(kv_list(rows, "element", &e.id, "facts", &e.kv_json)),
                ..Fields::default()
            }
        }
        Owner::Storyline(id) => {
            let s = rows.storylines.iter().find(|s| s.id == id.as_str())?;
            let projection = rows
                .storyline_kv_json
                .get(&s.id)
                .map(String::as_str)
                .unwrap_or("[]");
            Fields {
                name: Some(s.name.clone()),
                summary: Some(s.summary.clone()),
                facts: Some(kv_list(rows, "storyline", &s.id, "facts", projection)),
                ..Fields::default()
            }
        }
        Owner::Category(id) => {
            let c = rows.categories.iter().find(|c| c.id == id.as_str())?;
            Fields {
                name: Some(c.name.clone()),
                template_fields: Some(kv_list(
                    rows,
                    "element-category",
                    &c.id,
                    "element-template",
                    &c.template_kv_json,
                )),
                ..Fields::default()
            }
        }
        Owner::Material(id) => {
            let m = rows.materials.iter().find(|m| m.id == id.as_str())?;
            Fields {
                title: Some(m.title.clone()),
                ..Fields::default()
            }
        }
    })
}

/// A history list of facts with ids: matched to `now` by key and value,
/// then by key; the rest get stable derived ids.
fn kv_entries(
    owner: &Owner,
    ns: &str,
    pairs: &[(String, String)],
    now: &[KvEntry],
) -> Vec<KvEntry> {
    let mut used: HashSet<usize> = HashSet::new();
    let mut assigned: Vec<Option<KvEntryId>> = vec![None; pairs.len()];
    for (i, (k, v)) in pairs.iter().enumerate() {
        if let Some(j) =
            (0..now.len()).find(|j| !used.contains(j) && now[*j].key == *k && now[*j].value == *v)
        {
            used.insert(j);
            assigned[i] = Some(now[j].id.clone());
        }
    }
    for (i, (k, _)) in pairs.iter().enumerate() {
        if assigned[i].is_some() {
            continue;
        }
        if let Some(j) = (0..now.len()).find(|j| !used.contains(j) && now[*j].key == *k) {
            used.insert(j);
            assigned[i] = Some(now[j].id.clone());
        }
    }
    let mut seen: HashMap<&str, usize> = HashMap::new();
    let pos = ranks(pairs.len());
    pairs
        .iter()
        .enumerate()
        .filter_map(|(i, (k, v))| {
            let id = match assigned[i].clone() {
                Some(id) => id,
                None => {
                    let n = seen.entry(k.as_str()).or_default();
                    *n += 1;
                    let h = Sha256::digest(
                        format!("drifting.import.v1.kv\n{}\n{ns}\n{k}\n{n}", owner.key())
                            .as_bytes(),
                    );
                    let hex: String = h[..16].iter().map(|b| format!("{b:02x}")).collect();
                    KvEntryId::parse(&format!("kv-{hex}")).ok()?
                }
            };
            Some(KvEntry {
                id,
                key: k.clone(),
                value: v.clone(),
                pos: pos.get(i).cloned(),
            })
        })
        .collect()
}

/// The fields a history row sets on `owner`, given the entity's current
/// fields (for the facts' ids). Fields the kind does not restore are left
/// out (a chapter row's `name`, say).
pub fn historical(owner: &Owner, meta: &Meta, current: &Fields) -> Fields {
    let none: Vec<KvEntry> = Vec::new();
    match owner {
        Owner::Node(_) => Fields {
            title: meta.title.clone(),
            summary: meta.summary.clone(),
            status: meta.writing_status.as_deref().map(NodeStatus::parse),
            ..Fields::default()
        },
        Owner::Element(_) => Fields {
            name: meta.name.clone(),
            summary: meta.summary.clone(),
            aliases: meta.aliases.as_deref().map(alias_set),
            group_name: meta.group_name.clone(),
            facts: meta
                .kv
                .as_deref()
                .map(|p| kv_entries(owner, "facts", p, current.facts.as_deref().unwrap_or(&none))),
            ..Fields::default()
        },
        Owner::Storyline(_) => Fields {
            name: meta.name.clone(),
            summary: meta.summary.clone(),
            facts: meta
                .kv
                .as_deref()
                .map(|p| kv_entries(owner, "facts", p, current.facts.as_deref().unwrap_or(&none))),
            ..Fields::default()
        },
        Owner::Category(_) => Fields {
            name: meta.name.clone(),
            template_fields: meta.template_kv.as_deref().map(|p| {
                kv_entries(
                    owner,
                    "element-template",
                    p,
                    current.template_fields.as_deref().unwrap_or(&none),
                )
            }),
            ..Fields::default()
        },
        Owner::Material(_) => Fields {
            title: meta.title.clone(),
            ..Fields::default()
        },
    }
}

/// What changed in a list of facts: (ids to remove, entries to put).
fn kv_diff<'a>(target: &'a [KvEntry], before: &[KvEntry]) -> (Vec<KvEntryId>, Vec<&'a KvEntry>) {
    let keep: HashSet<&KvEntryId> = target.iter().map(|e| &e.id).collect();
    let remove = before
        .iter()
        .filter(|e| !keep.contains(&e.id))
        .map(|e| e.id.clone())
        .collect();
    let put = target.iter().filter(|e| !before.contains(e)).collect();
    (remove, put)
}

/// Write the fields `step` sets on `owner`, where the entity now has
/// `before` (every field set). Only what differs is written.
pub fn apply(
    txn: &mut BookTxn<'_>,
    owner: &Owner,
    step: &Fields,
    before: &Fields,
) -> dr_doc::Result<()> {
    let changed = |a: &Option<String>, b: &Option<String>| a.is_some() && a != b;
    let empty: Vec<KvEntry> = Vec::new();
    match owner {
        Owner::Node(id) => {
            let w = txn.node(id)?;
            if changed(&step.title, &before.title) {
                w.title(step.title.as_deref().unwrap_or(""))?;
            }
            if changed(&step.summary, &before.summary) {
                w.summary(step.summary.as_deref().unwrap_or(""))?;
            }
            if let Some(s) = &step.status
                && Some(s) != before.status.as_ref()
            {
                w.status(s)?;
            }
        }
        Owner::Element(id) => {
            let w = txn.element(id)?;
            if changed(&step.name, &before.name) {
                w.name(step.name.as_deref().unwrap_or(""))?;
            }
            if changed(&step.summary, &before.summary) {
                w.summary(step.summary.as_deref().unwrap_or(""))?;
            }
            if let Some(g) = &step.group_name
                && Some(g) != before.group_name.as_ref()
            {
                w.group_name(g.as_deref())?;
            }
            if let Some(target) = &step.aliases {
                let was = before.aliases.clone().unwrap_or_default();
                for a in was.difference(target) {
                    w.remove_alias(a)?;
                }
                for a in target.difference(&was) {
                    w.add_alias(a)?;
                }
            }
            if let Some(target) = &step.facts {
                let (remove, put) = kv_diff(target, before.facts.as_deref().unwrap_or(&empty));
                for id in &remove {
                    w.remove_fact(id)?;
                }
                for e in put {
                    w.put_fact(e)?;
                }
            }
        }
        Owner::Storyline(id) => {
            let w = txn.storyline(id)?;
            if changed(&step.name, &before.name) {
                w.name(step.name.as_deref().unwrap_or(""))?;
            }
            if changed(&step.summary, &before.summary) {
                w.summary(step.summary.as_deref().unwrap_or(""))?;
            }
            if let Some(target) = &step.facts {
                let (remove, put) = kv_diff(target, before.facts.as_deref().unwrap_or(&empty));
                for id in &remove {
                    w.remove_fact(id)?;
                }
                for e in put {
                    w.put_fact(e)?;
                }
            }
        }
        Owner::Category(id) => {
            let w = txn.category(id)?;
            if changed(&step.name, &before.name) {
                w.name(step.name.as_deref().unwrap_or(""))?;
            }
            if let Some(target) = &step.template_fields {
                let (remove, put) =
                    kv_diff(target, before.template_fields.as_deref().unwrap_or(&empty));
                for id in &remove {
                    w.remove_template_field(id)?;
                }
                for e in put {
                    w.put_template_field(e)?;
                }
            }
        }
        Owner::Material(id) => {
            let w = txn.material(id)?;
            if changed(&step.title, &before.title) {
                w.title(step.title.as_deref().unwrap_or(""))?;
            }
        }
    }
    Ok(())
}

fn sorted(mut v: Vec<KvEntry>) -> Vec<KvEntry> {
    v.sort_by(|a, b| a.id.cmp(&b.id));
    v
}

/// Whether the entity in `view` has the fields `want` sets (a history
/// point's check). Lists are compared as sets of entries.
pub fn holds(view: &BookView<'_>, owner: &Owner, want: &Fields) -> bool {
    let eq = |w: &Option<String>, have: &str| w.as_deref().is_none_or(|w| w == have);
    let kv_eq = |w: &Option<Vec<KvEntry>>, have: &[KvEntry]| {
        w.as_ref()
            .is_none_or(|w| sorted(w.clone()) == sorted(have.to_vec()))
    };
    match owner {
        Owner::Node(id) => view.node(id).is_some_and(|n| {
            eq(&want.title, &n.title)
                && eq(&want.summary, &n.summary)
                && want.status.as_ref().is_none_or(|s| *s == n.status)
        }),
        Owner::Element(id) => view.element(id).is_some_and(|e| {
            eq(&want.name, &e.name)
                && eq(&want.summary, &e.summary)
                && want.aliases.as_ref().is_none_or(|a| *a == e.aliases)
                && want.group_name.as_ref().is_none_or(|g| *g == e.group_name)
                && kv_eq(&want.facts, &e.facts)
        }),
        Owner::Storyline(id) => view
            .storylines()
            .into_iter()
            .find(|s| &s.id == id)
            .is_some_and(|s| {
                eq(&want.name, &s.name)
                    && eq(&want.summary, &s.summary)
                    && kv_eq(&want.facts, &s.facts)
            }),
        Owner::Category(id) => view
            .categories()
            .into_iter()
            .find(|c| &c.id == id)
            .is_some_and(|c| {
                eq(&want.name, &c.name) && kv_eq(&want.template_fields, &c.template_fields)
            }),
        Owner::Material(id) => view
            .materials()
            .into_iter()
            .find(|m| &m.id == id)
            .is_some_and(|m| eq(&want.title, &m.title)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rows_meta_reads_like_the_0_1_restore() {
        let m = parse(
            r#"{"name":"阿Q","summary":"","aliases":[" Q ","",  "阿桂"],"groupName":null,"kvJson":"[{\"key\":\"年纪\",\"value\":\"三十\"}]"}"#,
        )
        .unwrap();
        assert_eq!(m.name.as_deref(), Some("阿Q"));
        assert_eq!(m.group_name, Some(None));
        assert_eq!(m.kv, Some(vec![("年纪".into(), "三十".into())]));
        assert_eq!(m.title, None);
        assert!(parse("[]").is_none());
        assert!(parse("not json").is_none());
        // A field the row does not carry stays unset.
        assert_eq!(parse("{}").unwrap(), Meta::default());
    }

    #[test]
    fn facts_keep_their_ids_across_rows() {
        let owner = Owner::Element(ElementId::parse("e1").unwrap());
        let now = vec![KvEntry {
            id: KvEntryId::parse("kv-now").unwrap(),
            key: "年纪".into(),
            value: "三十".into(),
            pos: None,
        }];
        let a = kv_entries(
            &owner,
            "facts",
            &[
                ("年纪".into(), "二十".into()),
                ("籍贯".into(), "未庄".into()),
            ],
            &now,
        );
        let b = kv_entries(&owner, "facts", &[("籍贯".into(), "未庄".into())], &now);
        // Same key: the current entry, whose value changed.
        assert_eq!(a[0].id.as_str(), "kv-now");
        // An entry only the history has: one id in both rows.
        assert_eq!(a[1].id, b[0].id);
        assert!(a[1].id.as_str().starts_with("kv-"));
        let (remove, put) = kv_diff(&b, &a);
        assert_eq!(remove, vec![KvEntryId::parse("kv-now").unwrap()]);
        assert_eq!(put.len(), 1, "籍贯 moved to the first position");
    }
}
