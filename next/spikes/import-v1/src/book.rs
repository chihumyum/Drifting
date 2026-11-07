//! The authored rows of one book as a Loro book document, in the shape of
//! `foundation.md` F1: order lists, trees for nested groups, and one map per
//! entity kind keyed by id. Column-for-column, so nothing authored is lost;
//! P0-C's schema decides the final field names.

use std::collections::{BTreeMap, HashMap};

use anyhow::Result;
use loro::{ExportMode, LoroDoc, LoroMap, LoroValue, TreeID, TreeParentId};
use rusqlite::types::ValueRef;
use serde::Serialize;
use serde_json::Value;

use crate::legacy::Library;

/// Rows of a book-document table that belong to one project.
struct Source {
    table: &'static str,
    /// Map in the book document.
    container: &'static str,
    sql: &'static str,
    /// Key columns (joined with `/` when there is no id).
    key: &'static [&'static str],
    /// Columns that are not copied: prose bodies (they become prose documents)
    /// and projections the new version derives again.
    skip: &'static [&'static str],
}

const SOURCES: &[Source] = &[
    Source {
        table: "project",
        container: "book",
        sql: "SELECT * FROM project WHERE id = ?1",
        key: &["id"],
        skip: &["user_id", "kv_json", "storyline_template_kv_json"],
    },
    Source {
        table: "book_node",
        container: "nodes",
        sql: "SELECT * FROM book_node WHERE project_id = ?1",
        key: &["id"],
        skip: &[
            "word_count",
            "word_count_basis_kind",
            "word_count_basis_hash",
            "word_count_basis_revision",
            "word_count_basis_server_seq",
        ],
    },
    Source {
        table: "book_act",
        container: "acts",
        sql: "SELECT * FROM book_act WHERE project_id = ?1",
        key: &["id"],
        skip: &[],
    },
    Source {
        table: "storylines",
        container: "storylines",
        sql: "SELECT * FROM storylines WHERE project_id = ?1",
        key: &["id"],
        skip: &["content_json", "kv_json"],
    },
    Source {
        table: "node_storyline_link",
        container: "storyline_membership",
        sql: "SELECT l.* FROM node_storyline_link l JOIN book_node n ON n.id = l.node_id WHERE n.project_id = ?1",
        key: &["node_id", "storyline_id"],
        skip: &[],
    },
    Source {
        table: "element",
        container: "elements",
        sql: "SELECT * FROM element WHERE project_id = ?1",
        key: &["id"],
        skip: &["content_json", "kv_json"],
    },
    Source {
        table: "element_category",
        container: "categories",
        sql: "SELECT * FROM element_category WHERE project_id = ?1",
        key: &["id"],
        skip: &["content_json", "element_template_kv_json"],
    },
    Source {
        table: "entity_kv_entry",
        container: "kv_entries",
        sql: "SELECT * FROM entity_kv_entry WHERE project_id = ?1",
        key: &["id"],
        skip: &[],
    },
    Source {
        table: "entity_relation",
        container: "relations",
        sql: "SELECT * FROM entity_relation WHERE project_id = ?1",
        key: &["id"],
        skip: &[],
    },
    Source {
        table: "entity_relation_type",
        container: "relation_types",
        sql: "SELECT * FROM entity_relation_type WHERE project_id = ?1",
        key: &["id"],
        skip: &[],
    },
    Source {
        table: "entity_relation_type_endpoint_kind",
        container: "relation_type_endpoints",
        sql: "SELECT k.* FROM entity_relation_type_endpoint_kind k JOIN entity_relation_type t ON t.id = k.relation_type_id WHERE t.project_id = ?1",
        key: &["relation_type_id", "side", "entity_kind"],
        skip: &[],
    },
    Source {
        table: "timeline_marker",
        container: "time_pins",
        sql: "SELECT * FROM timeline_marker WHERE project_id = ?1",
        key: &["id"],
        skip: &[],
    },
    Source {
        table: "drift_group",
        container: "idea_groups",
        sql: "SELECT * FROM drift_group WHERE project_id = ?1",
        key: &["id"],
        skip: &[],
    },
    Source {
        table: "material_folder",
        container: "material_folders",
        sql: "SELECT * FROM material_folder WHERE project_id = ?1",
        key: &["id"],
        skip: &[],
    },
    Source {
        table: "plot_grid_document",
        container: "plot_plans",
        sql: "SELECT d.* FROM plot_grid_document d JOIN book_node n ON n.id = d.node_id WHERE n.project_id = ?1",
        key: &["id"],
        skip: &[],
    },
    Source {
        table: "plot_grid_row",
        container: "plot_rows",
        sql: "SELECT r.* FROM plot_grid_row r JOIN plot_grid_document d ON d.id = r.document_id JOIN book_node n ON n.id = d.node_id WHERE n.project_id = ?1",
        key: &["id"],
        skip: &[],
    },
    Source {
        table: "plot_grid_column",
        container: "plot_columns",
        sql: "SELECT c.* FROM plot_grid_column c JOIN plot_grid_document d ON d.id = c.document_id JOIN book_node n ON n.id = d.node_id WHERE n.project_id = ?1",
        key: &["id"],
        skip: &[],
    },
    Source {
        table: "plot_grid_cell",
        container: "plot_cells",
        sql: "SELECT c.* FROM plot_grid_cell c JOIN plot_grid_document d ON d.id = c.document_id JOIN book_node n ON n.id = d.node_id WHERE n.project_id = ?1",
        key: &["id"],
        skip: &[],
    },
    Source {
        table: "comment",
        container: "comments",
        sql: "SELECT * FROM comment WHERE project_id = ?1",
        key: &["id"],
        skip: &[],
    },
    Source {
        table: "comment_action",
        container: "comment_actions",
        sql: "SELECT * FROM comment_action WHERE project_id = ?1",
        key: &["id"],
        skip: &[],
    },
    Source {
        table: "element_patch",
        container: "patches",
        sql: "SELECT * FROM element_patch WHERE project_id = ?1",
        key: &["id"],
        skip: &[],
    },
    Source {
        table: "agent_memory",
        container: "project_memory",
        sql: "SELECT * FROM agent_memory WHERE project_id = ?1",
        key: &["id"],
        skip: &[],
    },
    Source {
        table: "library_item",
        container: "materials",
        sql: "SELECT * FROM library_item WHERE project_id = ?1",
        key: &["id"],
        skip: &["body_json", "external_url", "preview_image_url"],
    },
    Source {
        table: "project_asset",
        container: "assets",
        sql: "SELECT * FROM project_asset WHERE project_id = ?1",
        key: &["id"],
        skip: &[],
    },
    Source {
        table: "writing_day",
        container: "writing_days",
        sql: "SELECT * FROM writing_day WHERE project_id = ?1",
        key: &["device_key", "day"],
        skip: &[],
    },
];

/// Every table [`crate::tables`] sends to the book document.
pub fn source_tables() -> Vec<&'static str> {
    SOURCES.iter().map(|s| s.table).collect()
}

pub fn json_to_loro(value: &Value) -> LoroValue {
    match value {
        Value::Null => LoroValue::Null,
        Value::Bool(b) => LoroValue::from(*b),
        Value::Number(n) => n
            .as_i64()
            .map(LoroValue::from)
            .unwrap_or_else(|| LoroValue::from(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => LoroValue::from(s.as_str()),
        Value::Array(items) => LoroValue::from(items.iter().map(json_to_loro).collect::<Vec<_>>()),
        Value::Object(map) => LoroValue::from(
            map.iter()
                .map(|(k, v)| (k.clone(), json_to_loro(v)))
                .collect::<HashMap<String, LoroValue>>(),
        ),
    }
}

fn cell(name: &str, value: ValueRef<'_>) -> LoroValue {
    match value {
        ValueRef::Null => LoroValue::Null,
        ValueRef::Integer(i) => LoroValue::from(i),
        ValueRef::Real(f) => LoroValue::from(f),
        ValueRef::Text(bytes) => {
            let text = String::from_utf8_lossy(bytes);
            if name.ends_with("_json")
                && let Ok(parsed) = serde_json::from_str::<Value>(&text)
            {
                return json_to_loro(&parsed);
            }
            LoroValue::from(text.as_ref())
        }
        ValueRef::Blob(bytes) => LoroValue::from(bytes.to_vec()),
    }
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct BookStats {
    /// Entries per book-document map.
    pub entries: BTreeMap<&'static str, usize>,
    pub book_order: usize,
    pub narrative_order: usize,
    pub tree_nodes: usize,
    pub snapshot_bytes: usize,
}

/// Build the book document of one project.
pub fn build(library: &Library, project_id: &str, peer: u64) -> Result<(LoroDoc, BookStats)> {
    let doc = LoroDoc::new();
    doc.set_peer_id(peer)?;
    let mut stats = BookStats::default();
    let mut groups: Vec<(String, Option<String>, String)> = Vec::new();
    let mut folders: Vec<(String, Option<String>, String)> = Vec::new();
    let mut book_order: Vec<(i64, String)> = Vec::new();
    let mut narrative_order: Vec<(i64, String)> = Vec::new();
    for source in SOURCES {
        let map = doc.get_map(source.container);
        let mut statement = library.conn.prepare(source.sql)?;
        let names: Vec<String> = statement.column_names().map(str::to_string).collect();
        let mut rows = statement.query([project_id])?;
        let mut count = 0;
        while let Some(row) = rows.next()? {
            let text = |name: &str| -> Option<String> {
                let index = names.iter().position(|n| n == name)?;
                row.get::<_, Option<String>>(index).ok().flatten()
            };
            let key: Vec<String> = source
                .key
                .iter()
                .map(|k| text(k).unwrap_or_default())
                .collect();
            let entry: LoroMap = map.ensure_mergeable_map(&key.join("/"))?;
            for (index, name) in names.iter().enumerate() {
                if source.skip.contains(&name.as_str()) {
                    continue;
                }
                entry.insert(name, cell(name, row.get_ref(index)?))?;
            }
            match source.table {
                "book_node" => {
                    let id = text("id").unwrap_or_default();
                    let order = |column: &str| -> Option<i64> {
                        let index = names.iter().position(|n| n == column)?;
                        row.get::<_, Option<i64>>(index).ok().flatten()
                    };
                    if let Some(order) = order("book_order") {
                        book_order.push((order, id.clone()));
                    }
                    if let Some(order) = order("narrative_order") {
                        narrative_order.push((order, id));
                    }
                }
                "drift_group" => groups.push((
                    text("id").unwrap_or_default(),
                    text("parent_group_id"),
                    text("name").unwrap_or_default(),
                )),
                "material_folder" => folders.push((
                    text("id").unwrap_or_default(),
                    text("parent_folder_id"),
                    text("name").unwrap_or_default(),
                )),
                _ => {}
            }
            count += 1;
        }
        stats.entries.insert(source.container, count);
    }
    for (name, mut order) in [
        ("book_order", book_order),
        ("narrative_order", narrative_order),
    ] {
        order.sort();
        let list = doc.get_movable_list(name);
        for (index, (_, id)) in order.iter().enumerate() {
            list.insert(index, id.as_str())?;
        }
        if name == "book_order" {
            stats.book_order = order.len();
        } else {
            stats.narrative_order = order.len();
        }
    }
    for (name, nodes) in [
        ("idea_group_tree", groups),
        ("material_folder_tree", folders),
    ] {
        stats.tree_nodes += build_tree(&doc, name, &nodes)?;
    }
    doc.commit();
    stats.snapshot_bytes = doc.export(ExportMode::Snapshot)?.len();
    Ok((doc, stats))
}

/// Parents first; a node whose parent is missing goes to the root rather than vanishing.
fn build_tree(
    doc: &LoroDoc,
    name: &str,
    nodes: &[(String, Option<String>, String)],
) -> Result<usize> {
    let tree = doc.get_tree(name);
    let mut created: HashMap<String, TreeID> = HashMap::new();
    let mut pending: Vec<&(String, Option<String>, String)> = nodes.iter().collect();
    while !pending.is_empty() {
        let before = pending.len();
        let mut rest = Vec::new();
        for node in pending {
            let parent = match &node.1 {
                None => Some(TreeParentId::Root),
                Some(p) if created.contains_key(p) => Some(TreeParentId::Node(created[p])),
                Some(p) if !nodes.iter().any(|n| &n.0 == p) => Some(TreeParentId::Root),
                Some(_) => None,
            };
            match parent {
                Some(parent) => {
                    let id = tree.create(parent)?;
                    let meta = tree.get_meta(id)?;
                    meta.insert("id", node.0.as_str())?;
                    meta.insert("name", node.2.as_str())?;
                    created.insert(node.0.clone(), id);
                }
                None => rest.push(node),
            }
        }
        if rest.len() == before {
            // A cycle: attach the rest to the root.
            for node in rest.drain(..) {
                let id = tree.create(TreeParentId::Root)?;
                tree.get_meta(id)?.insert("id", node.0.as_str())?;
                created.insert(node.0.clone(), id);
            }
        }
        pending = rest;
    }
    Ok(created.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tables::{Fate, TABLES};

    #[test]
    fn every_book_table_has_a_source() {
        let mut expected: Vec<&str> = TABLES
            .iter()
            .filter(|t| t.fate == Fate::BookDoc || t.fate == Fate::Assets)
            .map(|t| t.table)
            .collect();
        let mut actual = source_tables();
        expected.sort();
        actual.sort();
        assert_eq!(actual, expected);
    }

    #[test]
    fn json_values_convert() {
        let value: Value = serde_json::from_str(r#"{"a":[1,2.5,"x",null,true]}"#).unwrap();
        let loro = json_to_loro(&value);
        let map = loro.as_map().unwrap();
        assert_eq!(map.get("a").unwrap().as_list().unwrap().len(), 5);
    }
}
