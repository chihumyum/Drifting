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
pub const ASSOCIATION_NOTE_CHAPTER: &str = "01900000-0000-7000-8000-0000000000f3";
pub const ASSOCIATION_NOTE_ELEMENT: &str = "01900000-0000-7000-8000-0000000000f4";
pub const ASSOCIATION_AUTHOR_TYPE: &str = "01900000-0000-7000-8000-000000000074";
pub const ASSOCIATION_FIRST: &str = "rel-material";
pub const ASSOCIATION_SECOND: &str = "rel-association-chapter";
pub const ASSOCIATION_THIRD: &str = "rel-association-element";
pub const ASSOCIATION_SECOND_TIME: &str = "2026-10-01T08:00:00.250Z";

/// The existing note association plus two more. The first and second
/// chapter pairs' ids sort opposite to their creation order in 0.1.
pub fn build_associations(same_name: bool) -> Old {
    let old = build();
    let c = Connection::open(&old.db).unwrap();
    c.pragma_update(None, "foreign_keys", false).unwrap();
    for (note, title, order) in [
        (ASSOCIATION_NOTE_CHAPTER, "章的第二条笔记", 2),
        (ASSOCIATION_NOTE_ELEMENT, "要素的笔记", 3),
    ] {
        exec(
            &c,
            "INSERT INTO library_item (id, project_id, title, kind, body_json, order_key, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'text', '{\"type\":\"doc\",\"content\":[]}', ?4, ?5, ?5)",
            params![note, BOOK, title, order, T0],
        );
    }
    let generic = format!("system:generic-association:{BOOK}");
    // Cover both recognition paths independently. Each spelling is valid
    // even when the other identifier is absent.
    let alternate = if same_name {
        exec(
            &c,
            "INSERT INTO entity_relation_type
             (id, project_id, name, normalized_name, description, orientation, created_at, updated_at)
             VALUES (?1, ?2, '  关联  ', '关联', '作者写的描述', 'symmetric', ?3, ?3)",
            params![ASSOCIATION_AUTHOR_TYPE, BOOK, T0],
        );
        let alternate = "legacy-association-by-key";
        exec(
            &c,
            "UPDATE entity_relation_type SET id = ?1 WHERE id = ?2",
            params![alternate, generic],
        );
        exec(
            &c,
            "UPDATE entity_relation SET relation_type_id = ?1 WHERE relation_type_id = ?2",
            params![alternate, generic],
        );
        alternate.to_owned()
    } else {
        exec(
            &c,
            "UPDATE entity_relation_type SET system_key = NULL, locked = 0 WHERE id = ?1",
            [&generic],
        );
        generic
    };
    for (id, note, kind, target, ty, time) in [
        (
            ASSOCIATION_SECOND,
            ASSOCIATION_NOTE_CHAPTER,
            "node",
            CHAPTER,
            alternate.as_str(),
            ASSOCIATION_SECOND_TIME,
        ),
        (
            ASSOCIATION_THIRD,
            ASSOCIATION_NOTE_ELEMENT,
            "element",
            ELEMENT_OTHER,
            alternate.as_str(),
            T1,
        ),
    ] {
        exec(
            &c,
            "INSERT INTO entity_relation (id, project_id, from_kind, from_id, to_kind, to_id, relation_type_id, created_at, updated_at)
             VALUES (?1, ?2, 'library_item', ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id, BOOK, note, kind, target, ty, time],
        );
    }
    if same_name {
        // The pair already authored under 「关联」 is the first pair in the
        // chapter row. The built-in occurrence should add no pair of its own.
        exec(
            &c,
            "INSERT INTO entity_relation (id, project_id, from_kind, from_id, to_kind, to_id, relation_type_id, created_at, updated_at)
             SELECT 'rel-association-authored', project_id, from_kind, from_id, to_kind, to_id, ?2, created_at, updated_at
             FROM entity_relation WHERE id = ?1",
            params![ASSOCIATION_FIRST, ASSOCIATION_AUTHOR_TYPE],
        );
    }
    drop(c);
    old
}

/// A chapter in Recently Deleted with 0.1 history of its own.
pub const CHAPTER_DELETED: &str = "01900000-0000-7000-8000-0000000000c5";
pub const T3: &str = "2026-10-04T11:00:00.000Z";

/// `body` as editor JSON: one paragraph with id `id`.
pub fn one_paragraph(id: &str, text: &str) -> String {
    format!(
        r#"{{"type":"doc","content":[{{"type":"paragraph","attrs":{{"id":"{id}"}},"content":[{{"type":"text","text":"{text}"}}]}}]}}"#
    )
}

/// One `entity_snapshot_history` row: `(id, time, entity kind, entity,
/// preview, metadata)`.
pub type HistoryRow = (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    Option<String>,
    Option<String>,
);

/// The history rows [`build_history`] adds to [`build`]'s three (`h-1`,
/// `h-2` on the chapter, `h-3` on the element), with the metadata 0.1's
/// snapshot service keeps for each kind (`snapshot-history.service.ts`
/// `entityMeta`).
pub fn history_rows() -> Vec<HistoryRow> {
    vec![
        // The element in the group it is in now (`h-3` has it in 0.1's
        // 「未庄」, which no element keeps).
        (
            "h-element-2",
            T3,
            "element",
            ELEMENT,
            Some(one_paragraph("e-p1", "未庄的一个闲人。")),
            Some(
                r#"{"name":"阿Q","summary":"旧的主人公","aliases":["阿贵"],"groupName":"同行","kvJson":"[{\"key\":\"住处\",\"value\":\"破庙\"},{\"key\":\"职业\",\"value\":\"短工\"},{\"key\":\"年龄\",\"value\":\"30\"}]"}"#
                    .into(),
            ),
        ),
        (
            "h-idea-1",
            T1,
            "node",
            IDEA,
            Some(one_paragraph("i-p1", "构想的旧稿。")),
            Some(r#"{"title":"旧构想","summary":"构想旧梗概","writingStatus":"drifting"}"#.into()),
        ),
        (
            "h-storyline-1",
            T0,
            "storyline",
            STORYLINE,
            Some(one_paragraph("s-p1", "阿Q 的半生。")),
            Some(
                r#"{"name":"旧主线","summary":"主线旧梗概","kvJson":"[{\"key\":\"起点\",\"value\":\"县城\"}]"}"#
                    .into(),
            ),
        ),
        // The storyline as it is now: its latest row holds what the import
        // writes as current.
        (
            "h-storyline-2",
            T2,
            "storyline",
            STORYLINE,
            Some(STORYLINE_JSON.into()),
            Some(
                r#"{"name":"主线","summary":"","kvJson":"[{\"key\":\"起点\",\"value\":\"未庄\"}]"}"#
                    .into(),
            ),
        ),
        (
            "h-category-1",
            T1,
            "category",
            CATEGORY,
            Some(one_paragraph("c-p1", "人物分类的旧说明。")),
            Some(
                r#"{"name":"人物旧名","elementTemplateKvJson":"[{\"key\":\"年龄\",\"value\":\"\"},{\"key\":\"籍贯\",\"value\":\"\"}]"}"#
                    .into(),
            ),
        ),
        (
            "h-note-1",
            T1,
            "library_item",
            NOTE,
            Some(one_paragraph("n-p1", "待查的旧笔记。")),
            Some(r#"{"title":"旧的待查"}"#.into()),
        ),
        (
            "h-deleted-1",
            T1,
            "node",
            CHAPTER_DELETED,
            Some(one_paragraph("x-p1", "删掉那章的旧稿。")),
            Some(r#"{"title":"删掉那章旧名","summary":"","writingStatus":"draft"}"#.into()),
        ),
        // 0.1 lists it with no excerpt; there is no version to check out.
        ("h-empty", T3, "node", CHAPTER, None, None),
    ]
}

/// [`build`] with snapshot history on every kind 0.1 kept it for: the
/// chapter (two rows, and one without a preview), the element (two rows),
/// an idea,
/// the storyline (an old row and one equal to its current state), the
/// category, the note, and a chapter in Recently Deleted.
pub fn build_history() -> Old {
    let old = build();
    let c = Connection::open(&old.db).unwrap();
    c.pragma_update(None, "foreign_keys", false).unwrap();
    exec(
        &c,
        "INSERT INTO book_node (id, project_id, title, summary, book_order, narrative_order, writing_status, kind, drift_group_id, position_x, position_y, deleted_at, created_at, updated_at) VALUES (?1, ?2, '删掉那章', '', 30, NULL, 'draft', 'chapter', NULL, 0, 0, ?3, ?4, ?3)",
        params![CHAPTER_DELETED, BOOK, T2, T0],
    );
    exec(
        &c,
        "INSERT INTO node_content (node_id, content_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params![
            CHAPTER_DELETED,
            one_paragraph("x-p1", "删掉那章的定稿。"),
            T0
        ],
    );
    for (id, at, kind, entity, json, meta) in history_rows() {
        exec(
            &c,
            "INSERT INTO entity_snapshot_history (id, project_id, entity_kind, entity_id, state_blob, content_json, meta_json, created_at) VALUES (?1, ?2, ?3, ?4, X'00', ?5, ?6, ?7)",
            params![id, BOOK, kind, entity, json, meta, at],
        );
    }
    drop(c);
    old
}

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
    exec(
        &c,
        "UPDATE library_item SET provenance_json = ?1 WHERE id = ?2",
        params![
            format!(
                r#"{{"v":1,"origin":"generated","generation":{{"provider":"chatgpt-subscription","model":"gpt-image-1","prompt":"未庄的土谷祠\n\n画风：水墨淡彩","subjectPrompt":"未庄的土谷祠","styleText":"水墨淡彩","extraPrompt":"不要现代器物","target":{{"kind":"element","id":"{ELEMENT}"}},"generationId":"gen-1","conversationId":"conv-1","sourceItemIds":[],"generatedAt":"2025-01-02T03:04:05.000Z"}}}}"#
            ),
            IMAGE
        ],
    );
    exec(
        &c,
        "UPDATE library_item SET notes_json = ?1 WHERE id = ?2",
        params![
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"王胡与小D的记事"}]}]}"#,
            NOTE
        ],
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
