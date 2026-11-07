//! Where every table of a 0.1.x library goes. A 0.1.x library at migration
//! `0018_retire_review_mode` has exactly these 100 tables; the test applies the
//! published migrations to an empty database and compares, so a table nobody
//! decided about fails the build. `cargo run -p dr-import-v1 -- mapping-md`
//! prints the table for `docs/rust-rewrite/modules/m10-import.md`.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Fate {
    /// Authored rows: become entries of the book document (F1 书目文档).
    BookDoc,
    /// Prose bodies: one prose document each (F1 正文文档).
    ProseDoc,
    /// Read to decide how fresh the `contentJson` cache is; not imported.
    ProseEvidence,
    /// Asset metadata and bytes: `dr-store` asset table and files.
    Assets,
    /// Snapshot history: replayed into the prose document's history labels,
    /// its metadata into the book document's history.
    History,
    /// Device-local state. This milestone keeps it in the import's own
    /// receipt database beside the new library (`import-v1/receipt.sqlite`)
    /// until its module (F6, M30, M32, M40) takes it over.
    Local,
    /// Agent conversations: imported read-only, to read and search, not to
    /// continue (decided 2026-11-07), into the receipt database. The rest of
    /// the run records stay in the old library, which the import never
    /// changes or deletes.
    AgentArchive,
    /// Rebuilt by the new version from imported data (indexes, projections).
    Rebuild,
    /// Not imported: old machinery, or records left in the old library.
    Drop,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct TableFate {
    pub table: &'static str,
    pub fate: Fate,
    /// Where it lands (F1 names) or why it is dropped, in the conclusion's language.
    pub target: &'static str,
}

const fn t(table: &'static str, fate: Fate, target: &'static str) -> TableFate {
    TableFate {
        table,
        fate,
        target,
    }
}

use Fate::*;

/// Sorted by table name.
pub const TABLES: &[TableFate] = &[
    t(
        "agent_chat_binding",
        Drop,
        "帮手对话扩展的投递状态，留在旧库",
    ),
    t(
        "agent_chat_branch",
        Drop,
        "帮手对话扩展的投递状态，留在旧库",
    ),
    t(
        "agent_chat_cursor",
        Drop,
        "帮手对话扩展的投递状态，留在旧库",
    ),
    t(
        "agent_chat_delivery",
        Drop,
        "帮手对话扩展的投递状态，留在旧库",
    ),
    t(
        "agent_chat_object",
        Drop,
        "帮手对话扩展的投递状态，留在旧库",
    ),
    t("agent_chat_queue", Drop, "帮手对话扩展的投递状态，留在旧库"),
    t(
        "agent_conversation",
        AgentArchive,
        "帮手对话的标题，只读搬过去",
    ),
    t(
        "agent_mcp_server",
        Local,
        "MCP 扩展配置；secret_* 只是钥匙串引用",
    ),
    t("agent_memory", BookDoc, "书目文档：Project Memory"),
    t(
        "agent_permission_grant",
        Drop,
        "授权绑定旧工具版本，作者在新版重新授权",
    ),
    t(
        "agent_runtime_checkpoint",
        Drop,
        "模型上下文检查点，可由消息重建，留在旧库",
    ),
    t(
        "agent_runtime_element_patch_receipt",
        Drop,
        "结算记录（含 Yjs 状态向量），留在旧库",
    ),
    t(
        "agent_runtime_entity_write_receipt",
        Drop,
        "结算记录，留在旧库",
    ),
    t("agent_runtime_event", Drop, "运行事件流，留在旧库"),
    t(
        "agent_runtime_message",
        AgentArchive,
        "对话消息，只读搬过去",
    ),
    t(
        "agent_runtime_read_observation",
        Drop,
        "读取回执（含 Yjs 状态向量），留在旧库",
    ),
    t("agent_runtime_read_receipt", Drop, "读取回执，留在旧库"),
    t(
        "agent_runtime_result_artifact",
        AgentArchive,
        "工具结果，随对话只读搬过去",
    ),
    t(
        "agent_runtime_result_blob",
        AgentArchive,
        "工具结果，随对话只读搬过去",
    ),
    t(
        "agent_runtime_session",
        AgentArchive,
        "对话的运行会话，只读搬过去",
    ),
    t("agent_runtime_task", Drop, "长任务状态，留在旧库"),
    t(
        "agent_runtime_task_chapter_manifest",
        Drop,
        "长任务状态，留在旧库",
    ),
    t("agent_runtime_task_command", Drop, "长任务状态，留在旧库"),
    t(
        "agent_runtime_task_constraint",
        Drop,
        "长任务状态，留在旧库",
    ),
    t("agent_runtime_task_step", Drop, "长任务状态，留在旧库"),
    t(
        "agent_runtime_tool_call",
        AgentArchive,
        "工具调用，随对话只读搬过去",
    ),
    t("agent_runtime_turn", AgentArchive, "对话轮次，只读搬过去"),
    t("agent_runtime_write_effect", Drop, "结算记录，留在旧库"),
    t(
        "agent_runtime_write_expectation",
        Drop,
        "结算记录，留在旧库",
    ),
    t("agent_runtime_write_review", Drop, "结算记录，留在旧库"),
    t(
        "agent_runtime_write_review_block",
        Drop,
        "结算记录，留在旧库",
    ),
    t("agent_working_memory", Local, "每本书的工作记忆文本"),
    t("block_section", Drop, "已退役 Copilot 的滚动摘要"),
    t("book_act", BookDoc, "书目文档：幕，书序上的分界"),
    t(
        "book_node",
        BookDoc,
        "书目文档：章节和构想；书序、叙事序是实数坐标，原样搬",
    ),
    t("comment", BookDoc, "书目文档：批注和待办；锚点变成一对光标"),
    t(
        "comment_action",
        BookDoc,
        "书目文档：只留「开 Agent 任务」，成为待办的 agent_conversation；Copilot 的采纳与拒绝不导",
    ),
    t("drift_group", BookDoc, "书目文档：构想分组树"),
    t(
        "element",
        BookDoc,
        "书目文档：要素；content_json 成为正文文档",
    ),
    t(
        "element_category",
        BookDoc,
        "书目文档：分类；content_json 成为正文文档",
    ),
    t(
        "element_patch",
        BookDoc,
        "书目文档：补丁；text_anchor_json 变成一对光标",
    ),
    t(
        "entity_kv_entry",
        BookDoc,
        "书目文档：事实和字段模板，挂在所属对象下",
    ),
    t("entity_relation", BookDoc, "书目文档：关系"),
    t("entity_relation_type", BookDoc, "书目文档：关系类型"),
    t(
        "entity_relation_type_endpoint_kind",
        BookDoc,
        "书目文档：端点种类，并入所属关系类型",
    ),
    t(
        "entity_snapshot_history",
        History,
        "快照历史：按渲染好的预览回放成可检出的版本和历史点，当时的标题等元数据回放进书目文档",
    ),
    t(
        "inline_mention",
        Rebuild,
        "引用索引：导入后由 dr-index 按人物链接标记重建",
    ),
    t(
        "library_item",
        BookDoc,
        "书目文档：素材；笔记正文成为正文文档",
    ),
    t("library_state", Local, "库级标记：内置样书标记、交接清单"),
    t(
        "markdown_mirror_file",
        Local,
        "Markdown 文件夹绑定；file_sha256 分辨文件是否被外部改过",
    ),
    t("material_folder", BookDoc, "书目文档：素材夹树"),
    t(
        "node_content",
        ProseDoc,
        "正文文档：章节和构想正文；大纲、情节规划 JSON 是投影",
    ),
    t(
        "node_storyline_link",
        BookDoc,
        "书目文档：故事线成员和主故事线",
    ),
    t("plot_grid_cell", BookDoc, "书目文档：情节规划格子"),
    t("plot_grid_column", BookDoc, "书目文档：情节规划列"),
    t("plot_grid_document", BookDoc, "书目文档：每章一张情节规划"),
    t("plot_grid_row", BookDoc, "书目文档：情节规划行"),
    t(
        "project",
        BookDoc,
        "书目文档：书本身（书名、简介、最近删除）",
    ),
    t(
        "project_asset",
        Assets,
        "书目文档的资源记录；source.* 按 SHA-256 校验后经 dr-store 复制",
    ),
    t(
        "storylines",
        BookDoc,
        "书目文档：故事线；content_json 成为正文文档",
    ),
    t("sync_app_authority", Drop, "同步 v1 引擎"),
    t("sync_apply_receipt", Drop, "同步 v1 引擎"),
    t("sync_blob_state", Drop, "同步 v1 引擎"),
    t("sync_change_set", Drop, "同步 v1 引擎"),
    t("sync_checkpoint", Drop, "同步 v1 引擎"),
    t(
        "sync_conflict",
        Drop,
        "同步 v1 引擎；有未解决冲突时导入前报告",
    ),
    t("sync_connect_attempt", Drop, "同步 v1 引擎"),
    t("sync_connect_generation_attempt", Drop, "同步 v1 引擎"),
    t("sync_cursor", Drop, "同步 v1 引擎"),
    t("sync_entity_lifecycle", Drop, "同步 v1 引擎"),
    t("sync_field_clock", Drop, "同步 v1 引擎"),
    t("sync_frontier", Drop, "同步 v1 引擎"),
    t(
        "sync_frontier_gap",
        Drop,
        "同步 v1 引擎；有缺口时导入前报告",
    ),
    t("sync_generation", Drop, "同步 v1 引擎"),
    t("sync_generation_purge", Drop, "同步 v1 引擎"),
    t("sync_generation_writer_state", Drop, "同步 v1 引擎"),
    t("sync_journal_truncation", Drop, "同步 v1 引擎"),
    t("sync_local_object", Drop, "同步 v1 引擎"),
    t("sync_mutation", Drop, "同步 v1 引擎"),
    t(
        "sync_order_register",
        Drop,
        "同步 v1 的排序键；派生的排序列给出同样的顺序",
    ),
    t(
        "sync_provider_account",
        Drop,
        "同步 v1 引擎；账号归属由库文件本身决定",
    ),
    t("sync_provider_binding", Drop, "同步 v1 引擎"),
    t(
        "sync_quarantined_object",
        Drop,
        "同步 v1 引擎；有隔离对象时导入前报告",
    ),
    t("sync_reducer_base", Drop, "同步 v1 引擎"),
    t("sync_reducer_snapshot", Drop, "同步 v1 引擎"),
    t("sync_remote_object", Drop, "同步 v1 引擎"),
    t("sync_restore_attempt", Drop, "同步 v1 引擎"),
    t("sync_segment", Drop, "同步 v1 引擎"),
    t(
        "sync_set_tag",
        Drop,
        "同步 v1 的 OR-set 标签；aliases_json 已有成员",
    ),
    t("sync_transfer", Drop, "同步 v1 引擎"),
    t("sync_yjs_materialization_receipt", Drop, "同步 v1 引擎"),
    t("timeline_marker", BookDoc, "书目文档：时间钉"),
    t("workspace_projection_change", Drop, "界面失效提示"),
    t("workspace_projection_clock", Drop, "界面失效提示"),
    t("writing_day", BookDoc, "书目文档：写作日，按（设备，日期）"),
    t(
        "yjs_document_revision",
        ProseEvidence,
        "每篇的版本号：判断缓存是否最新",
    ),
    t(
        "yjs_document_revision_provenance",
        Drop,
        "每个版本由谁写的本机审计",
    ),
    t("yjs_prose_command_receipt", Drop, "Agent 幂等回执"),
    t(
        "yjs_snapshots",
        ProseEvidence,
        "Yjs 状态：说明文档存在、被压缩过",
    ),
    t(
        "yjs_updates",
        ProseEvidence,
        "Yjs 更新：说明文档存在、改过几次",
    ),
];

pub fn fate(table: &str) -> Option<&'static TableFate> {
    TABLES
        .binary_search_by(|entry| entry.table.cmp(table))
        .ok()
        .map(|i| &TABLES[i])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn one_hundred_sorted_tables() {
        assert_eq!(TABLES.len(), 100);
        assert!(TABLES.windows(2).all(|w| w[0].table < w[1].table));
        assert_eq!(fate("comment").map(|f| f.fate), Some(Fate::BookDoc));
        assert!(fate("nonexistent").is_none());
    }

    /// The list equals the tables the published migrations leave behind.
    #[test]
    fn matches_the_published_migrations() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::schema::create_at(&conn, crate::schema::LATEST).unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'")
            .unwrap();
        let tables: BTreeSet<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let listed: BTreeSet<String> = TABLES.iter().map(|t| t.table.to_string()).collect();
        assert_eq!(tables, listed);
    }
}
