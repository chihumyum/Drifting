//! A synthetic 0.1 library, built from the published migrations and plain
//! SQL (no Yjs, no TypeScript): one book with a chapter, an idea, an
//! element, a category, a storyline, a material note with tasks, an image
//! with its bytes, comments, a patch, relations, a plot grid, history and a
//! handoff stamp. The rows are what the 0.1 client writes; the Yjs columns
//! hold placeholder bytes (the importer never reads Yjs). 0.1's triggers are
//! dropped first: the builder writes rows directly, not through its journal.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use dr_import_v1::handoff::sha256_hex;
use dr_import_v1::schema;
use rusqlite::{Connection, params};

pub const BOOK: &str = "01900000-0000-7000-8000-000000000001";
pub const CHAPTER: &str = "01900000-0000-7000-8000-0000000000c1";
pub const IDEA: &str = "01900000-0000-7000-8000-0000000000d1";
pub const ELEMENT: &str = "01900000-0000-7000-8000-0000000000e1";
pub const CATEGORY: &str = "01900000-0000-7000-8000-0000000000a1";
pub const STORYLINE: &str = "01900000-0000-7000-8000-0000000000b1";
pub const NOTE: &str = "01900000-0000-7000-8000-0000000000f1";
pub const IMAGE: &str = "01900000-0000-7000-8000-0000000000f2";
pub const ASSET: &str = "01900000-0000-7000-8000-0000000000aa";
pub const GROUP: &str = "01900000-0000-7000-8000-000000000091";
pub const SUBGROUP: &str = "01900000-0000-7000-8000-000000000092";
pub const FOLDER: &str = "01900000-0000-7000-8000-000000000081";
pub const REL_TYPE: &str = "01900000-0000-7000-8000-000000000071";
pub const COMMENT: &str = "01900000-0000-7000-8000-000000000061";
pub const NOTE_TODO: &str = "01900000-0000-7000-8000-000000000062";
pub const MARKER_TODO: &str = "01900000-0000-7000-8000-000000000063";
pub const BLOCK_COMMENT: &str = "01900000-0000-7000-8000-000000000064";
pub const PATCH: &str = "01900000-0000-7000-8000-000000000051";
pub const DEVICE_KEY: &str = "device-0123456789abcdef01234567";

pub const T0: &str = "2026-10-01T08:00:00.000Z";
pub const T1: &str = "2026-10-02T09:30:00.000Z";
pub const T2: &str = "2026-10-03T10:00:00.000Z";

/// The chapter body. Block `q` is a quote container whose paragraphs have
/// their own ids; `p2` holds a TODO marker.
pub const CHAPTER_JSON: &str = r#"{"type":"doc","content":[{"type":"heading","attrs":{"id":"h1","level":1,"indent":0},"content":[{"type":"text","text":"第一章 序"}]},{"type":"paragraph","attrs":{"id":"p1","indent":0,"textAlign":"left"},"content":[{"type":"text","text":"我要给"},{"type":"text","text":"阿Q","marks":[{"type":"entityLink","attrs":{"targetKind":"element","targetId":"01900000-0000-7000-8000-0000000000e1","targetBlockId":null}}]},{"type":"text","text":"做正传，"},{"type":"text","text":"已经不止一两年了。","marks":[{"type":"italic"}]}]},{"type":"blockquote","attrs":{"id":"q","indent":0},"content":[{"type":"paragraph","attrs":{"id":"q1","indent":0},"content":[{"type":"text","text":"引文第一段"}]},{"type":"paragraph","attrs":{"id":"q2","indent":0},"content":[{"type":"text","text":"引文第二段"}]}]},{"type":"paragraph","attrs":{"id":"p2","indent":0},"content":[{"type":"text","text":"TODO: 查一查赵太爷的年纪"}]}]}"#;

/// An earlier version of the chapter (snapshot history).
pub const CHAPTER_V1: &str = r#"{"type":"doc","content":[{"type":"heading","attrs":{"id":"h1","level":1},"content":[{"type":"text","text":"第一章"}]},{"type":"paragraph","attrs":{"id":"p1"},"content":[{"type":"text","text":"我要给阿Q做正传。"}]}]}"#;
pub const CHAPTER_V2: &str = r#"{"type":"doc","content":[{"type":"heading","attrs":{"id":"h1","level":1},"content":[{"type":"text","text":"第一章 序"}]},{"type":"paragraph","attrs":{"id":"p1"},"content":[{"type":"text","text":"我要给阿Q做正传，已经不止一两年了。"}]}]}"#;

/// The metadata of the history rows (`SnapshotMeta`).
pub const CHAPTER_META_V1: &str =
    r#"{"title":"第一章","summary":"初稿梗概","writingStatus":"draft"}"#;
pub const CHAPTER_META_V2: &str = r#"{"title":"第一章 序"}"#;
pub const ELEMENT_META_V1: &str = r#"{"name":"阿Q","summary":"","aliases":["阿贵"],"groupName":"未庄","kvJson":"[{\"key\":\"住处\",\"value\":\"破庙\"},{\"key\":\"绰号\",\"value\":\"阿Q\"}]"}"#;
/// An earlier version of the element's body.
pub const ELEMENT_V1: &str = r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"e-p1"},"content":[{"type":"text","text":"未庄的人。"}]}]}"#;

/// A storyline's chapter template: an H2 and a paragraph with a bold run.
pub const STORYLINE_TEMPLATE: &str = r#"{"type":"doc","content":[{"type":"heading","attrs":{"id":"t-h","level":2},"content":[{"type":"text","text":"开端"}]},{"type":"paragraph","attrs":{"id":"t-p"},"content":[{"type":"text","text":"冲突：","marks":[{"type":"bold"}]},{"type":"text","text":"写在这里"}]}]}"#;
/// A category's element template: an H1 and a paragraph linking an element.
pub const CATEGORY_TEMPLATE: &str = r#"{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"外貌"}]},{"type":"paragraph","content":[{"type":"text","text":"像"},{"type":"text","text":"阿Q","marks":[{"type":"entityLink","attrs":{"targetKind":"element","targetId":"01900000-0000-7000-8000-0000000000e1"}}]},{"type":"text","text":"那样"}]}]}"#;
pub const ELEMENT_JSON: &str = r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"e-p1"},"content":[{"type":"text","text":"未庄的闲人。","marks":[{"type":"bold"}]}]}]}"#;
pub const NOTE_JSON: &str = r#"{"type":"doc","content":[{"type":"taskList","attrs":{"id":"tl"},"content":[{"type":"taskItem","attrs":{"id":"ti1","checked":false,"todoId":"01900000-0000-7000-8000-000000000062"},"content":[{"type":"paragraph","attrs":{"id":"tp1"},"content":[{"type":"text","text":"核对称呼"}]}]},{"type":"taskItem","attrs":{"id":"ti2","checked":true},"content":[{"type":"paragraph","attrs":{"id":"tp2"},"content":[{"type":"text","text":"抄录告示"}]}]}]},{"type":"materialEmbed","attrs":{"id":"me","libraryItemId":"01900000-0000-7000-8000-0000000000f2"}}]}"#;
pub const STORYLINE_JSON: &str = r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"s-p1"},"content":[{"type":"text","text":"阿Q 的一生。"}]}]}"#;

/// PNG bytes of the image asset (any bytes do: the importer checks the hash).
pub const IMAGE_BYTES: &[u8] = b"\x89PNG\r\n\x1a\nsynthetic image for the M10 test";

pub struct Old {
    pub dir: tempfile::TempDir,
    pub db: PathBuf,
    pub root: PathBuf,
}

fn exec(conn: &Connection, sql: &str, p: impl rusqlite::Params) {
    conn.execute(sql, p)
        .unwrap_or_else(|e| panic!("{e}: {sql}"));
}

/// Build the library at the last 0.1 schema. `stamped`: write a handoff
/// stamp covering every body that has Yjs state.
pub fn build(stamped: bool) -> Old {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app-local-data");
    let db = root.join("databases").join("drifting-library.db");
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    let conn = Connection::open(&db).unwrap();
    schema::create_at(&conn, schema::LATEST).unwrap();
    let triggers: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for t in triggers {
        conn.execute_batch(&format!("DROP TRIGGER \"{t}\""))
            .unwrap();
    }
    conn.pragma_update(None, "foreign_keys", false).unwrap();
    rows(&conn, stamped);
    drop(conn);
    // The asset bytes, where the 0.1 native store keeps them.
    let asset_dir = root.join("assets").join(BOOK).join(ASSET);
    std::fs::create_dir_all(&asset_dir).unwrap();
    std::fs::write(asset_dir.join("source.png"), IMAGE_BYTES).unwrap();
    std::fs::write(
        root.join("sync-installation-v2.json"),
        format!(
            r#"{{"version":2,"installation_id":"install-{}"}}"#,
            "ab".repeat(32)
        ),
    )
    .unwrap();
    Old { dir, db, root }
}

fn yjs(conn: &Connection, doc: &str, updates: usize, revision: i64) {
    for i in 0..updates {
        exec(
            conn,
            "INSERT INTO yjs_updates (document_id, update_blob, created_at) VALUES (?1, ?2, ?3)",
            params![doc, vec![i as u8; 4], T0],
        );
    }
    exec(
        conn,
        "INSERT INTO yjs_document_revision (document_id, revision, updated_at) VALUES (?1, ?2, ?3)",
        params![doc, revision, T1],
    );
}

fn rows(c: &Connection, stamped: bool) {
    exec(
        c,
        "INSERT INTO project (id, name, summary, kv_json, storyline_template_kv_json, user_id, created_at, updated_at, deleted_at) VALUES (?1, '阿Q正传', '一部小说', ?2, ?3, 'local', ?4, ?5, NULL)",
        params![
            BOOK,
            r#"[{"key":"类型","value":"讽刺"},{"key":"视角","value":"第一人称"}]"#,
            r#"[{"key":"目标","value":""}]"#,
            T0,
            T2
        ],
    );
    // Chapter (basis current) and idea (seed only).
    exec(
        c,
        "INSERT INTO book_node (id, title, summary, book_order, narrative_order, project_id, word_count, word_count_basis_kind, word_count_basis_hash, word_count_basis_revision, word_count_basis_server_seq, writing_status, kind, drift_group_id, deleted_at, created_at, updated_at, position_x, position_y) VALUES (?1, '第一章 序', '梗概', 5, 10, ?2, 42, 'yjs', 'h', 3, NULL, 'draft', 'chapter', NULL, NULL, ?3, ?4, 0, 0)",
        params![CHAPTER, BOOK, T0, T2],
    );
    exec(
        c,
        "INSERT INTO node_content (node_id, content_json, outline_json, plot_grid_json, created_at, updated_at) VALUES (?1, ?2, NULL, NULL, ?3, ?4)",
        params![CHAPTER, CHAPTER_JSON, T0, T2],
    );
    yjs(c, &format!("node-content:{CHAPTER}"), 3, 3);
    exec(
        c,
        "INSERT INTO book_node (id, title, summary, book_order, narrative_order, project_id, word_count, writing_status, kind, drift_group_id, deleted_at, created_at, updated_at, position_x, position_y) VALUES (?1, '一个构想', '', NULL, 12, ?2, 0, 'drifting', 'drift', ?3, NULL, ?4, ?4, 120.5, -40)",
        params![IDEA, BOOK, SUBGROUP, T0],
    );
    exec(
        c,
        "INSERT INTO node_content (node_id, content_json, created_at, updated_at) VALUES (?1, '{}', ?2, ?2)",
        params![IDEA, T0],
    );
    exec(
        c,
        "INSERT INTO drift_group (id, project_id, name, parent_group_id, color, sort_order, created_at, updated_at) VALUES (?1, ?2, '分组', NULL, '#aa0000', 1, ?3, ?3)",
        params![GROUP, BOOK, T0],
    );
    exec(
        c,
        "INSERT INTO drift_group (id, project_id, name, parent_group_id, color, sort_order, created_at, updated_at) VALUES (?1, ?2, '子分组', ?3, NULL, 2, ?4, ?4)",
        params![SUBGROUP, BOOK, GROUP, T0],
    );
    // Storyline.
    exec(
        c,
        "INSERT INTO storylines (id, project_id, name, color, summary, order_key, content_json, kv_json, node_content_template_json, deleted_at, created_at, updated_at) VALUES (?1, ?2, '主线', '#336699', '', 0, ?3, ?4, ?5, NULL, ?6, ?6)",
        params![
            STORYLINE,
            BOOK,
            STORYLINE_JSON,
            r#"[{"key":"起点","value":"未庄"}]"#,
            STORYLINE_TEMPLATE,
            T0
        ],
    );
    yjs(c, &format!("storyline:{STORYLINE}"), 2, 2);
    exec(
        c,
        "INSERT INTO node_storyline_link (node_id, storyline_id, is_primary) VALUES (?1, ?2, 1)",
        params![CHAPTER, STORYLINE],
    );
    // Category and element.
    exec(
        c,
        "INSERT INTO element_category (id, name, content_json, element_template_json, element_template_kv_json, color, project_id, layout_mode, grid_x, grid_y, deleted_at, created_at, updated_at) VALUES (?1, '人物', '{}', ?2, ?3, '#8B7355', ?4, 'auto', NULL, NULL, NULL, ?5, ?5)",
        params![
            CATEGORY,
            CATEGORY_TEMPLATE,
            r#"[{"key":"年龄","value":""}]"#,
            BOOK,
            T0
        ],
    );
    exec(
        c,
        "INSERT INTO element (id, project_id, category_id, name, summary, content_json, kv_json, aliases_json, group_name, portrait_asset_id, deleted_at, created_at, updated_at) VALUES (?1, ?2, ?3, '阿Q', '主人公', ?4, ?5, '[\"阿贵\",\"阿桂\"]', NULL, NULL, NULL, ?6, ?7)",
        params![
            ELEMENT,
            BOOK,
            CATEGORY,
            ELEMENT_JSON,
            r#"[{"key":"住处","value":"土谷祠"},{"key":"职业","value":"短工"}]"#,
            T0,
            T1
        ],
    );
    yjs(c, &format!("element:{ELEMENT}"), 2, 2);
    for (id, owner_kind, owner, ns, k, v) in [
        ("kv-1", "project", BOOK, "facts", "视角", "第一人称"),
        ("kv-2", "project", BOOK, "facts", "类型", "讽刺"),
        ("kv-3", "project", BOOK, "storyline-template", "目标", ""),
        ("kv-4", "storyline", STORYLINE, "facts", "起点", "未庄"),
        ("kv-5", "element", ELEMENT, "facts", "职业", "短工"),
        ("kv-6", "element", ELEMENT, "facts", "住处", "土谷祠"),
        (
            "kv-7",
            "element-category",
            CATEGORY,
            "element-template",
            "年龄",
            "",
        ),
    ] {
        exec(
            c,
            "INSERT INTO entity_kv_entry (id, project_id, owner_kind, owner_id, namespace, key, value) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, BOOK, owner_kind, owner, ns, k, v],
        );
    }
    // Relation types: the built-in one and a symmetric one.
    let generic = format!("system:generic-association:{BOOK}");
    exec(
        c,
        "INSERT INTO entity_relation_type (id, project_id, name, normalized_name, description, orientation, system_key, locked, source_role, target_role, created_at, updated_at) VALUES (?1, ?2, 'Generic association', 'generic association', 'Built-in association for TODO and library item links.', 'directed', 'generic-association', 1, 'Source', 'Target', ?3, ?3)",
        params![generic, BOOK, T0],
    );
    exec(
        c,
        "INSERT INTO entity_relation_type (id, project_id, name, normalized_name, description, orientation, system_key, locked, source_role, target_role, created_at, updated_at) VALUES (?1, ?2, '同乡', '同乡', '', 'symmetric', NULL, 0, '', '', ?3, ?3)",
        params![REL_TYPE, BOOK, T0],
    );
    exec(
        c,
        "INSERT INTO entity_relation_type_endpoint_kind (relation_type_id, side, entity_kind) VALUES (?1, 'source', 'element'), (?1, 'target', 'element')",
        params![REL_TYPE],
    );
    exec(
        c,
        "INSERT INTO entity_relation (id, project_id, from_kind, from_id, to_kind, to_id, relation_type_id, created_at, updated_at) VALUES ('rel-1', ?1, 'element', 'zz-other', 'element', ?2, ?3, ?4, ?4)",
        params![BOOK, ELEMENT, REL_TYPE, T0],
    );
    exec(
        c,
        "INSERT INTO entity_relation (id, project_id, from_kind, from_id, to_kind, to_id, relation_type_id, created_at, updated_at) VALUES ('rel-2', ?1, 'comment', ?2, 'element', ?3, ?4, ?5, ?5)",
        params![BOOK, NOTE_TODO, ELEMENT, generic, T0],
    );
    // Time pin, act, plot grid.
    exec(
        c,
        "INSERT INTO timeline_marker (id, project_id, narrative_order, label, drift_node_id, created_at, updated_at) VALUES ('pin-1', ?1, 11.5, '那年秋天', ?2, ?3, ?3)",
        params![BOOK, IDEA, T0],
    );
    exec(
        c,
        "INSERT INTO book_act (id, project_id, name, color, start_order, drift_node_id, created_at, updated_at) VALUES ('act-1', ?1, '第一幕', NULL, 0, NULL, ?2, ?2)",
        params![BOOK, T0],
    );
    exec(
        c,
        "INSERT INTO plot_grid_document (id, node_id, cell_width, cell_height) VALUES ('pg', ?1, 200, 120)",
        params![CHAPTER],
    );
    exec(
        c,
        "INSERT INTO plot_grid_row (id, document_id, position_key, label) VALUES ('r1', 'pg', 'a0', '行一'), ('r2', 'pg', 'a1', '行二')",
        [],
    );
    exec(
        c,
        "INSERT INTO plot_grid_column (id, document_id, position_key, label) VALUES ('c1', 'pg', 'a0', '列一')",
        [],
    );
    exec(
        c,
        "INSERT INTO plot_grid_cell (id, document_id, row_id, column_id, value) VALUES ('cell', 'pg', 'r2', 'c1', '一张纸条')",
        [],
    );
    // Materials: a note with tasks (seed only) and an image with its asset.
    exec(
        c,
        "INSERT INTO material_folder (id, project_id, name, parent_folder_id, created_at, updated_at) VALUES (?1, ?2, '资料', NULL, ?3, ?3)",
        params![FOLDER, BOOK, T0],
    );
    exec(
        c,
        "INSERT INTO library_item (id, project_id, title, kind, asset_id, external_url, body_json, notes_json, preview_image_url, order_key, created_at, updated_at, provenance_json, folder_id, task_todos) VALUES (?1, ?2, '待查', 'text', NULL, NULL, ?3, NULL, NULL, 1, ?4, ?4, NULL, ?5, 1)",
        params![NOTE, BOOK, NOTE_JSON, T0, FOLDER],
    );
    exec(
        c,
        "INSERT INTO project_asset (id, project_id, kind, source_mime, source_size_bytes, source_sha256, width, height, created_at) VALUES (?1, ?2, 'image', 'image/png', ?3, ?4, 4, 3, ?5)",
        params![
            ASSET,
            BOOK,
            IMAGE_BYTES.len() as i64,
            sha256_bytes(IMAGE_BYTES),
            T0
        ],
    );
    exec(
        c,
        "INSERT INTO library_item (id, project_id, title, kind, asset_id, external_url, body_json, notes_json, preview_image_url, order_key, created_at, updated_at, provenance_json, folder_id, task_todos) VALUES (?1, ?2, '插图', 'image', ?3, NULL, NULL, ?4, NULL, 0, ?5, ?5, NULL, NULL, 0)",
        params![
            IMAGE,
            BOOK,
            ASSET,
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"未庄的土谷祠"}]}]}"#,
            T0
        ],
    );
    // Comments: a v4 text anchor, a whole-block one on a container, a
    // note-task TODO, a TODO marker projection; a region comment on the image.
    let v4 = r#"{"selectedText":"阿Q做正传","blockText":"我要给阿Q做正传，已经不止一两年了。","blockSnapshots":[{"blockId":"p1","blockText":"我要给阿Q做正传，已经不止一两年了。"}],"textAnchor":{"startBlockId":"p1","startOffset":3,"endBlockId":"p1","endOffset":8,"text":"阿Q做正传"}}"#;
    let body = |t: &str| {
        format!(
            r#"{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":"{t}"}}]}}]}}"#
        )
    };
    exec(
        c,
        "INSERT INTO comment (id, project_id, kind, target_kind, target_id, target_block_id, anchor_json, author_kind, author_id, author_name, body_json, status, priority, source, metadata_json, target_block_ids_json, resolved_at, created_at, updated_at) VALUES (?1, ?2, 'note', 'node', ?3, 'p1', ?4, 'copilot', NULL, NULL, ?5, 'converted', NULL, 'copilot', NULL, '[\"p1\"]', NULL, ?6, ?6)",
        params![COMMENT, BOOK, CHAPTER, v4, body("这句好"), T1],
    );
    exec(
        c,
        "INSERT INTO comment (id, project_id, kind, target_kind, target_id, target_block_id, anchor_json, author_kind, author_id, author_name, body_json, status, priority, source, metadata_json, target_block_ids_json, resolved_at, created_at, updated_at) VALUES (?1, ?2, 'note', 'node', ?3, 'q', '{}', 'user', NULL, '作者', ?4, 'open', 'high', 'manual', NULL, '[\"q\"]', NULL, ?5, ?5)",
        params![BLOCK_COMMENT, BOOK, CHAPTER, body("引文要核对"), T1],
    );
    exec(
        c,
        "INSERT INTO comment (id, project_id, kind, target_kind, target_id, target_block_id, anchor_json, author_kind, author_id, author_name, body_json, status, priority, source, metadata_json, target_block_ids_json, resolved_at, created_at, updated_at) VALUES (?1, ?2, 'todo', 'library_item', ?3, 'ti1', '{}', 'user', NULL, NULL, ?4, 'open', NULL, 'manual', '{\"kind\":\"note-task\"}', '[\"ti1\"]', NULL, ?5, ?5)",
        params![NOTE_TODO, BOOK, NOTE, body("核对称呼"), T1],
    );
    exec(
        c,
        "INSERT INTO comment (id, project_id, kind, target_kind, target_id, target_block_id, anchor_json, author_kind, author_id, author_name, body_json, status, priority, source, metadata_json, target_block_ids_json, resolved_at, created_at, updated_at) VALUES (?1, ?2, 'todo', 'node', ?3, 'p2', '{}', 'user', NULL, NULL, ?4, 'resolved', NULL, 'manual', '{\"kind\":\"todo-autoparse\",\"blockId\":\"p2\",\"text\":\"查一查赵太爷的年纪\"}', '[\"p2\"]', ?5, ?5, ?5)",
        params![MARKER_TODO, BOOK, CHAPTER, body("查一查赵太爷的年纪"), T1],
    );
    exec(
        c,
        "INSERT INTO comment (id, project_id, kind, target_kind, target_id, target_block_id, anchor_json, author_kind, author_id, author_name, body_json, status, priority, source, metadata_json, target_block_ids_json, resolved_at, created_at, updated_at) VALUES ('region-1', ?1, 'note', 'library_item', ?2, NULL, '{\"region\":{\"v\":1,\"x\":0.1,\"y\":0.2,\"w\":0.3,\"h\":0.4}}', 'user', NULL, NULL, ?3, 'open', NULL, 'manual', NULL, '[]', NULL, ?4, ?4)",
        params![BOOK, IMAGE, body("这里"), T1],
    );
    exec(
        c,
        "INSERT INTO comment_action (id, project_id, comment_id, kind, label, payload_json, status, result_json, created_by_kind, created_by_id, created_at, updated_at, applied_at) VALUES ('ca-1', ?1, ?2, 'start_agent_task', NULL, '{\"conversationId\":\"conv-1\"}', 'applied', NULL, 'user', NULL, ?3, ?3, ?3)",
        params![BOOK, MARKER_TODO, T1],
    );
    exec(
        c,
        "INSERT INTO comment_action (id, project_id, comment_id, kind, label, payload_json, status, result_json, created_by_kind, created_by_id, created_at, updated_at, applied_at) VALUES ('ca-2', ?1, ?2, 'accept_suggestion', NULL, '{}', 'applied', NULL, 'user', NULL, ?3, ?3, ?3)",
        params![BOOK, COMMENT, T1],
    );
    // A patch on the chapter.
    exec(
        c,
        "INSERT INTO element_patch (id, project_id, element_id, source_node_id, source_block_id, source_block_text, text_anchor_json, invalidated_at, title, content_json, order_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'q2', '引文第二段', '{\"startBlockId\":\"q2\",\"startOffset\":0,\"endBlockId\":\"q2\",\"endOffset\":2,\"text\":\"引文\"}', NULL, '出处', ?5, 0, ?6, ?6)",
        params![PATCH, BOOK, ELEMENT, CHAPTER, body("见《新青年》"), T1],
    );
    // Project Memory and a writing day.
    exec(
        c,
        "INSERT INTO agent_memory (id, project_id, kind, body, target_kind, target_id, target_block_id, source, origin_ref, status, supersedes_id, deleted_at, created_at, updated_at) VALUES ('mem-1', ?1, 'preference', '少用感叹号', 'node', ?2, 'q', 'author', NULL, 'active', NULL, NULL, ?3, ?3)",
        params![BOOK, CHAPTER, T1],
    );
    exec(
        c,
        "INSERT INTO writing_day (id, project_id, day, device_key, words, created_at, updated_at) VALUES ('wd-1', ?1, '2026-10-02', ?2, 1234, ?3, ?3)",
        params![BOOK, DEVICE_KEY, T1],
    );
    // Snapshot history: two earlier versions of the chapter, one of the
    // element, each with the metadata 0.1 kept beside it. The second
    // chapter row carries only a title (older 0.1 builds stored fewer
    // fields): its summary stays as the first row had it.
    for (id, at, kind, entity, json, meta) in [
        ("h-1", T0, "node", CHAPTER, CHAPTER_V1, CHAPTER_META_V1),
        ("h-2", T1, "node", CHAPTER, CHAPTER_V2, CHAPTER_META_V2),
        ("h-3", T2, "element", ELEMENT, ELEMENT_V1, ELEMENT_META_V1),
    ] {
        exec(
            c,
            "INSERT INTO entity_snapshot_history (id, project_id, entity_kind, entity_id, state_blob, content_json, meta_json, created_at) VALUES (?1, ?2, ?3, ?4, X'00', ?5, ?6, ?7)",
            params![id, BOOK, kind, entity, json, meta, at],
        );
    }
    // An Agent conversation (archived read-only).
    exec(
        c,
        "INSERT INTO agent_conversation (id, project_id, title, runtime_session_id, mode, messages_json, deleted_at, created_at, updated_at, source) VALUES ('conv-1', ?1, '查年纪', NULL, 'agent', '[]', NULL, ?2, ?2, 'todo')",
        params![BOOK, T1],
    );
    if stamped {
        let docs = [
            (format!("node-content:{CHAPTER}"), 3, CHAPTER_JSON),
            (format!("storyline:{STORYLINE}"), 2, STORYLINE_JSON),
            (format!("element:{ELEMENT}"), 2, ELEMENT_JSON),
        ];
        let documents: serde_json::Map<String, serde_json::Value> = docs
            .iter()
            .map(|(d, r, j)| {
                (
                    d.clone(),
                    serde_json::json!({"revision": r, "sha256": sha256_hex(j)}),
                )
            })
            .collect();
        let stamp = serde_json::json!({
            "version": 1,
            "appVersion": "0.1.0-alpha.11",
            "updatedAt": T2,
            "documents": documents,
            "settings": {"capturedAt": T2, "entries": {"settings-storage": "{\"state\":{\"themeMode\":\"dark\"}}"}},
            "books": {BOOK: {
                "wordTarget": 80000,
                "dailyWordTarget": 0,
                "relationTypeColors": {REL_TYPE: "#aa5500"},
                "elementPins": {ELEMENT: [12.5, -40.0]},
            }},
        });
        exec(
            c,
            "INSERT INTO library_state (key, value_json, updated_at) VALUES ('v2-handoff', ?1, ?2)",
            params![stamp.to_string(), T2],
        );
    }
}

pub fn sha256_bytes(b: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

pub fn path_of(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
