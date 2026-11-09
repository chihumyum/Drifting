//! Additive coverage of every row of kernel-v3.md's import mapping.
//! Keep `common::build` unchanged: the existing v2 import/UI tests use its
//! exact counts. All prose and media here reuse that synthetic fixture.

use rusqlite::{Connection, params};

use super::*;

pub const CHAPTER_BEFORE: &str = "01900000-0000-7000-8000-0000000000c2";
pub const CHAPTER_UNAFFILIATED: &str = "01900000-0000-7000-8000-0000000000c3";
pub const CHAPTER_UNPLACED: &str = "01900000-0000-7000-8000-0000000000c4";
pub const IDEA_LINKED: &str = "01900000-0000-7000-8000-0000000000d2";
pub const CATEGORY_OTHER: &str = "01900000-0000-7000-8000-0000000000a2";
pub const ELEMENT_OTHER: &str = "01900000-0000-7000-8000-0000000000e2";
pub const STORYLINE_OTHER: &str = "01900000-0000-7000-8000-0000000000b2";
pub const PATCH_RELATION: &str = "import-fixture-patch-relation";

pub fn build() -> Old {
    let old = super::build(true);
    let c = Connection::open(&old.db).unwrap();
    c.pragma_update(None, "foreign_keys", false).unwrap();
    exec(
        &c,
        "UPDATE book_act SET drift_node_id = ?1, color = '#aa0000' WHERE id = 'act-1'",
        [IDEA],
    );
    exec(
        &c,
        "INSERT INTO book_act (id, project_id, name, color, start_order, created_at, updated_at) VALUES ('act-2', ?1, '第二幕', '#aa7744', 20, ?2, ?2)",
        params![BOOK, T0],
    );
    // Before the first act; in the second act with a narrative coordinate
    // but no lane; and in the first act with a lane but no coordinate.
    for (id, title, book_order, narrative_order, kind, group) in [
        (CHAPTER_BEFORE, "幕前章节", Some(-5.), None, "chapter", None),
        (
            CHAPTER_UNAFFILIATED,
            "未归属章节",
            Some(25.),
            Some(18.25),
            "chapter",
            None,
        ),
        (
            CHAPTER_UNPLACED,
            "未摆放章节",
            Some(12.),
            None,
            "chapter",
            None,
        ),
        (
            IDEA_LINKED,
            "归线构想",
            None,
            Some(21.75),
            "drift",
            Some(GROUP),
        ),
    ] {
        exec(
            &c,
            "INSERT INTO book_node (id, project_id, title, summary, book_order, narrative_order, writing_status, kind, drift_group_id, position_x, position_y, created_at, updated_at) VALUES (?1, ?2, ?3, '', ?4, ?5, ?9, ?6, ?7, 40.5, -20.25, ?8, ?8)",
            params![
                id,
                BOOK,
                title,
                book_order,
                narrative_order,
                kind,
                group,
                T0,
                if kind == "drift" { "drifting" } else { "draft" }
            ],
        );
        exec(
            &c,
            "INSERT INTO node_content (node_id, content_json, created_at, updated_at) VALUES (?1, '{}', ?2, ?2)",
            params![id, T0],
        );
    }
    // Insertion/id order differs from lane order. Empty templates must not
    // create a custom leaf template, but the lane itself must survive.
    exec(
        &c,
        "INSERT INTO storylines (id, project_id, name, color, summary, order_key, content_json, kv_json, node_content_template_json, created_at, updated_at) VALUES (?1, ?2, '辅助线', '#663399', '', -10, '{}', '[]', '{}', ?3, ?3)",
        params![STORYLINE_OTHER, BOOK, T0],
    );
    for (node, storyline, primary) in [
        (CHAPTER, STORYLINE_OTHER, false),
        (CHAPTER_UNPLACED, STORYLINE, true),
        (IDEA_LINKED, STORYLINE_OTHER, true),
    ] {
        exec(
            &c,
            "INSERT INTO node_storyline_link (node_id, storyline_id, is_primary) VALUES (?1, ?2, ?3)",
            params![node, storyline, primary],
        );
    }
    exec(
        &c,
        "UPDATE element_category SET content_json = ?1, layout_mode = 'pinned', grid_x = 4, grid_y = -2 WHERE id = ?2",
        params![STORYLINE_JSON, CATEGORY],
    );
    exec(
        &c,
        "INSERT INTO element_category (id, project_id, name, color, content_json, element_template_json, element_template_kv_json, created_at, updated_at) VALUES (?1, ?2, '地点', '#228844', '{}', '{}', '[]', ?3, ?3)",
        params![CATEGORY_OTHER, BOOK, T0],
    );
    exec(
        &c,
        "UPDATE element SET group_name = '同行', portrait_asset_id = ?1, kv_json = ?2 WHERE id = ?3",
        params![
            ASSET,
            r#"[{"key":"住处","value":"土谷祠"},{"key":"职业","value":"短工"},{"key":"年龄","value":"35"}]"#,
            ELEMENT
        ],
    );
    exec(
        &c,
        "INSERT INTO entity_kv_entry (id, project_id, owner_kind, owner_id, namespace, key, value) VALUES ('kv-8', ?1, 'element', ?2, 'facts', '年龄', '35')",
        params![BOOK, ELEMENT],
    );
    // Same group label in two categories: two distinct homes, not one.
    exec(
        &c,
        "INSERT INTO element (id, project_id, category_id, name, summary, content_json, kv_json, aliases_json, group_name, created_at, updated_at) VALUES (?1, ?2, ?3, '未庄', '', '{}', '[]', '[]', '同行', ?4, ?4)",
        params![ELEMENT_OTHER, BOOK, CATEGORY_OTHER, T0],
    );
    exec(
        &c,
        "UPDATE entity_relation SET from_id = ?1 WHERE id = 'rel-1'",
        [ELEMENT_OTHER],
    );
    let generic = format!("system:generic-association:{BOOK}");
    // A patch source needs its own type. The locked generic association
    // only permits comments/materials as sources, in both old and v3 books.
    exec(
        &c,
        "INSERT INTO entity_relation_type (id, project_id, name, normalized_name, description, orientation, system_key, locked, source_role, target_role, created_at, updated_at) VALUES (?1, ?2, '补丁关联', '补丁关联', '', 'directed', NULL, 0, '', '', ?3, ?3)",
        params![PATCH_RELATION, BOOK, T0],
    );
    exec(
        &c,
        "INSERT INTO entity_relation_type_endpoint_kind (relation_type_id, side, entity_kind) VALUES (?1, 'source', 'patch'), (?1, 'target', 'storyline')",
        [PATCH_RELATION],
    );
    for (id, from_kind, from_id, to_kind, to_id, relation) in [
        (
            "rel-material",
            "library_item",
            NOTE,
            "node",
            CHAPTER,
            generic.as_str(),
        ),
        (
            "rel-patch",
            "patch",
            PATCH,
            "storyline",
            STORYLINE,
            PATCH_RELATION,
        ),
    ] {
        exec(
            &c,
            "INSERT INTO entity_relation (id, project_id, from_kind, from_id, to_kind, to_id, relation_type_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![id, BOOK, from_kind, from_id, to_kind, to_id, relation, T0],
        );
    }
    exec(
        &c,
        "INSERT INTO timeline_marker (id, project_id, narrative_order, label, drift_node_id, created_at, updated_at) VALUES ('pin-2', ?1, 6.25, '另一时间钉', NULL, ?2, ?2)",
        params![BOOK, T0],
    );
    // This retired view preference is in the real handoff capture list.
    let stamp: String = c
        .query_row(
            "SELECT value_json FROM library_state WHERE key = 'v2-handoff'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let mut stamp: serde_json::Value = serde_json::from_str(&stamp).unwrap();
    stamp["settings"]["entries"]["timeline-view"] = "book".into();
    exec(
        &c,
        "UPDATE library_state SET value_json = ?1 WHERE key = 'v2-handoff'",
        [stamp.to_string()],
    );
    old
}
