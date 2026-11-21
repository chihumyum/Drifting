//! 0.1 Agent conversations added to a built library, in the shapes the 0.1
//! client writes them (`src/renderer/domain/agent-conversation.ts`,
//! `sqlite-repo/agent-conversation-repo.ts`, `sync/agent-chat/repository.ts`):
//! the rendered transcript in `messages_json`, a chat continued from another
//! device as a branch of its own, a conversation whose transcript is only in
//! the runtime journal, one deleted, one of an external MCP client, one of a
//! book this library does not have. M31 reads them from the import's archive
//! (`m31-agent-panel.md` 「0.1 的旧对话」). Every word is synthetic.

use rusqlite::{Connection, params};
use serde_json::json;

use super::{BOOK, CHAPTER, Old};

/// A book of the 0.1 library that is not in it any more (its rows are
/// gone; the conversation stayed): nothing of it is imported.
pub const OTHER_BOOK: &str = "01900000-0000-7000-8000-0000000000ff";

pub const TITLED: &str = "01900000-0000-7000-8000-00000000c001";
pub const UNTITLED: &str = "01900000-0000-7000-8000-00000000c002";
pub const DELETED: &str = "01900000-0000-7000-8000-00000000c003";
pub const TOOLS: &str = "01900000-0000-7000-8000-00000000c004";
/// Continued on this device from another device's conversation: 0.1 forks
/// it ([`FORK`]) and lists only the fork.
pub const ROOT: &str = "01900000-0000-7000-8000-00000000c005";
pub const FORK: &str = "01900000-0000-7000-8000-00000000c006";
/// A transcript 0.1 never cached in `messages_json`: only the runtime rows.
pub const RUNTIME: &str = "01900000-0000-7000-8000-00000000c007";
pub const MCP: &str = "01900000-0000-7000-8000-00000000c008";
pub const OTHER: &str = "01900000-0000-7000-8000-00000000c009";
/// Long: [`LONG_TURNS`] turns, 「王胡」 only in the last one.
pub const LONG: &str = "01900000-0000-7000-8000-00000000c010";
pub const LONG_TURNS: usize = 120;

pub const TITLED_TITLE: &str = "精神胜利法怎么写得不重复";
pub const TOOLS_TITLE: &str = "第一章节奏太慢";
pub const FORK_TITLE: &str = "赵太爷的年纪";
pub const RUNTIME_TITLE: &str = "称呼核对";

/// The listed ones, newest first, as 0.1 lists them.
pub const LISTED: [&str; 6] = [TITLED, UNTITLED, LONG, TOOLS, RUNTIME, FORK];

fn usage(at: &str) -> serde_json::Value {
    json!({"kind": "usage", "inputTokens": 1200, "outputTokens": 80, "cacheReadTokens": 0,
           "cacheCreationTokens": 0, "costUsd": 0.0012, "turns": 1, "at": at})
}

#[allow(clippy::too_many_arguments)]
fn conversation(
    c: &Connection,
    id: &str,
    book: &str,
    title: &str,
    messages: &serde_json::Value,
    updated: &str,
    deleted: Option<&str>,
    source: &str,
    session: Option<&str>,
) {
    c.execute(
        "INSERT INTO agent_conversation (id, project_id, title, runtime_session_id, mode, messages_json, deleted_at, created_at, updated_at, source) VALUES (?1, ?2, ?3, ?4, 'byok', ?5, ?6, '2026-09-01T08:00:00.000Z', ?7, ?8)",
        params![id, book, title, session, messages.to_string(), deleted, updated, source],
    )
    .unwrap();
}

/// Adds the conversations to the 0.1 library of `old`.
pub fn add(old: &Old) {
    let c = Connection::open(&old.db).unwrap();
    // The other book's rows are gone; its conversation stayed.
    c.pragma_update(None, "foreign_keys", false).unwrap();
    let titled = json!([
        {"kind": "user", "text": "精神胜利法写了好几次，怎么写得不重复？", "at": "2026-10-12T08:59:00.000Z"},
        {"kind": "assistant", "text": "每次让他赢的东西换一样：先是辈分，再是钱，最后是自己打自己。"},
        usage("2026-10-12T09:00:00.000Z"),
    ]);
    conversation(
        &c,
        TITLED,
        BOOK,
        TITLED_TITLE,
        &titled,
        "2026-10-12T09:00:00.000Z",
        None,
        "chat",
        None,
    );
    let untitled = json!([
        {"kind": "user", "text": "未庄的告示要不要抄进素材？"},
        {"kind": "assistant", "text": "抄进去。正文里的 TODO 标记会变成待办，抄完再划掉。"},
    ]);
    conversation(
        &c,
        UNTITLED,
        BOOK,
        "",
        &untitled,
        "2026-10-10T09:00:00.000Z",
        None,
        "chat",
        None,
    );
    let long: Vec<serde_json::Value> = (0..LONG_TURNS)
        .map(|i| match (i % 2, i + 1 == LONG_TURNS) {
            (0, _) => json!({"kind": "user", "text": format!("第二章第{}段要不要留？", i / 2 + 1)}),
            (_, false) => json!({"kind": "assistant",
                "text": "留着。这一段写阿Q在土谷祠里过夜，是后面进城的铺垫，删了以后进城就显得突然。"}),
            (_, true) => json!({"kind": "assistant", "text": "最后一段写王胡捉虱子，可以留。"}),
        })
        .collect();
    conversation(
        &c,
        LONG,
        BOOK,
        "第二章逐段过一遍",
        &json!(long),
        "2026-10-09T09:00:00.000Z",
        None,
        "chat",
        None,
    );
    let deleted = json!([
        {"kind": "user", "text": "精神胜利法这段不要了。"},
        {"kind": "assistant", "text": "好。"},
    ]);
    conversation(
        &c,
        DELETED,
        BOOK,
        "删掉的对话",
        &deleted,
        "2026-10-11T09:00:00.000Z",
        Some("2026-10-11T09:00:00.000Z"),
        "chat",
        None,
    );
    let tools = json!([
        {"kind": "user", "text": "第一章节奏太慢，帮我看看哪里可以删。"},
        {"kind": "thinking", "text": "先读第一章，再看序和正文的比例。"},
        {"kind": "tool", "id": "call-read", "name": "read_chapter", "input": {"chapterId": CHAPTER},
         "status": "ok", "result": "第一章 序……"},
        {"kind": "todos", "items": [{"content": "读第一章", "status": "completed"}]},
        {"kind": "tool", "id": "call-note", "name": "create_material_note",
         "input": {"title": "删改建议"}, "status": "ok", "result": "{\"ok\":true}",
         "review": {"id": "review-1", "status": "committed"}},
        {"kind": "assistant", "text": "开头的序可以短一半：「我要给阿Q做正传」之后直接写赵太爷。"},
        {"kind": "error", "text": "模型连接中断。"},
        usage("2026-10-08T09:00:00.000Z"),
    ]);
    conversation(
        &c,
        TOOLS,
        BOOK,
        TOOLS_TITLE,
        &tools,
        "2026-10-08T09:00:00.000Z",
        None,
        "chat",
        None,
    );
    // Continued here from another device: the remote branch keeps its two
    // turns, the fork (all of it, the remote turns first) is the current one.
    let first = [
        json!({"kind": "user", "text": "赵太爷多大年纪？"}),
        json!({"kind": "assistant", "text": "书里没写。按秀才的辈分推，五十上下。"}),
    ];
    conversation(
        &c,
        ROOT,
        BOOK,
        FORK_TITLE,
        &json!(first),
        "2026-10-05T09:00:00.000Z",
        None,
        "chat",
        None,
    );
    let mut fork = first.to_vec();
    fork.push(json!({"kind": "user", "text": "那秀才呢？"}));
    fork.push(json!({"kind": "assistant", "text": "二十出头，比赵太爷小一辈。"}));
    conversation(
        &c,
        FORK,
        BOOK,
        FORK_TITLE,
        &json!(fork),
        "2026-10-06T09:00:00.000Z",
        None,
        "chat",
        None,
    );
    for (id, parent, fork_turn, head) in [
        (ROOT, None, None, "turn-root-1"),
        (FORK, Some(ROOT), Some("turn-root-1"), "turn-fork-1"),
    ] {
        c.execute(
            "INSERT INTO agent_chat_branch (id, project_id, root_id, parent_branch_id, fork_turn_id, head_turn_id, title, title_clock, deleted_at, created_at, updated_at, readiness) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '0000000000000001:clock', NULL, '2026-10-05T09:00:00.000Z', '2026-10-06T09:00:00.000Z', 'ready')",
            params![id, BOOK, ROOT, parent, fork_turn, head, FORK_TITLE],
        )
        .unwrap();
    }
    // Only in the runtime journal.
    conversation(
        &c,
        RUNTIME,
        BOOK,
        RUNTIME_TITLE,
        &json!([]),
        "2026-10-07T09:00:00.000Z",
        None,
        "chat",
        Some("session-7"),
    );
    c.execute(
        "INSERT INTO agent_runtime_session (id, project_id, route_kind, conversation_id, provider, model, provider_epoch, status, created_at, updated_at, ended_at) VALUES ('session-7', ?1, 'chat', ?2, 'deepseek', 'deepseek-chat', 0, 'completed', '2026-10-07T08:00:00.000Z', '2026-10-07T09:00:00.000Z', '2026-10-07T09:00:00.000Z')",
        params![BOOK, RUNTIME],
    )
    .unwrap();
    c.execute(
        "INSERT INTO agent_runtime_turn (id, session_id, ordinal, status, prompt_message_id, accepted_at, started_at, ended_at, error_code, error_message, updated_at) VALUES ('turn-7', 'session-7', 0, 'completed', 'message-7-0', '2026-10-07T08:00:00.000Z', '2026-10-07T08:00:00.000Z', '2026-10-07T09:00:00.000Z', NULL, NULL, '2026-10-07T09:00:00.000Z')",
        [],
    )
    .unwrap();
    let messages = [
        ("user", json!("阿Q该叫阿桂还是阿贵？")),
        (
            "assistant",
            json!([
                {"type": "thinking", "text": "查一下别名。"},
                {"type": "tool_call", "callId": "c-7", "name": "search_prose",
                 "arguments": {"query": "阿贵"}, "rawArguments": "{\"query\":\"阿贵\"}"},
            ]),
        ),
        (
            "tool",
            json!([{"callId": "c-7", "name": "search_prose", "ok": true, "content": "阿贵：1 处"}]),
        ),
        (
            "assistant",
            json!([{"type": "text", "text": "按序里的说法，写阿贵。"}]),
        ),
    ];
    for (ordinal, (role, content)) in messages.iter().enumerate() {
        c.execute(
            "INSERT INTO agent_runtime_message (id, session_id, turn_id, ordinal, role, status, content_json, created_at, completed_at) VALUES (?1, 'session-7', 'turn-7', ?2, ?3, 'completed', ?4, '2026-10-07T08:30:00.000Z', '2026-10-07T08:30:00.000Z')",
            params![format!("message-7-{ordinal}"), ordinal as i64, role, content.to_string()],
        )
        .unwrap();
    }
    c.execute(
        "INSERT INTO agent_runtime_tool_call (id, session_id, turn_id, call_id, name, access, status, idempotency_key, arguments_json, result_json, error_code, created_at, started_at, completed_at) VALUES ('tool-7', 'session-7', 'turn-7', 'c-7', 'search_prose', 'read', 'completed', 'idem-7', '{\"query\":\"阿贵\"}', '{\"content\":\"阿贵：1 处\"}', NULL, '2026-10-07T08:30:00.000Z', '2026-10-07T08:30:00.000Z', '2026-10-07T08:30:00.000Z')",
        [],
    )
    .unwrap();
    conversation(
        &c,
        MCP,
        BOOK,
        "外部会话",
        &json!([{"kind": "user", "text": "精神胜利法"}]),
        "2026-10-13T09:00:00.000Z",
        None,
        "external_mcp",
        None,
    );
    conversation(
        &c,
        OTHER,
        OTHER_BOOK,
        "精神胜利法在别的书里",
        &json!([{"kind": "user", "text": "精神胜利法"}, {"kind": "assistant", "text": "另一本书。"}]),
        "2026-10-14T09:00:00.000Z",
        None,
        "chat",
        None,
    );
}

/// The canonical v3 fixture ([`super::build_v3`]) with the conversations.
pub fn build_v3(stamped: bool) -> Old {
    let old = super::build_v3(stamped);
    add(&old);
    old
}
