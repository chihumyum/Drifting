//! What a 0.1 library keeps for its device beside the books, added to a
//! built library: the WebView storage values the hand-over captures into
//! the stamp (`settings-storage`, `shortcuts-storage`, `project-checkin`,
//! in zustand's persisted shape) and a book's Agent working memory. Every
//! value is synthetic.

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::{BOOK, Old, T1, T2};

/// A working memory as 0.1 keeps it: normalised, one trailing newline.
pub const WORKING_MEMORY: &str = "# Working Memory\n\n## Current\n\n- 第三章：阿Q进城以后的口气要变\n\n## Recent\n\n- 赵太爷的年纪已核对\n";

/// The persisted settings store: every field 0.1 writes, chosen values
/// where the author changed something, 0.1's defaults elsewhere.
pub fn settings() -> Value {
    json!({
        "autoElementLinkEnabled": false,
        "recentEntitiesLimit": 10,
        "editorUndoDepth": 100,
        "themeMode": "dark",
        "interfaceTextSize": "large",
        "accentColor": "#aa5500",
        "agentEditRevealAnimation": true,
        "editorFontSource": "system-serif",
        "editorSystemFontFamily": "",
        "bodyFontSize": 20,
        "lineHeight": 1.8,
        "paragraphIndent": "two",
        "editorIndentStep": 2,
        "paragraphSpacing": 3,
        "maxLineWidth": 880,
        "editorTextWrap": "stable",
        "autoImmersiveWriting": true,
        "typewriterMode": true,
        "typewriterPosition": 40,
        "caretColor": "#6b7fa6",
        "outlineRailMode": "visible",
        "entityLinkInteractive": true,
        "commentMarksVisible": true,
        "entityLinkColorMode": "contextual",
        "entityLinkHighlightMode": "both",
        "entityLinkBandStyle": "wash",
        "entityLinkKindColors": {"element":"#8b72c6","chapter":"#5b93c7","drift":"#9b6baa",
            "patch":"#c28b43","category":"#5f9b73","storyline":"#4f9497"},
        "uiLocale": "en",
        "agentAuth": "apikey",
        "agentProvider": "anthropic",
        "agentModel": "claude-sonnet-5-5",
        "agentEffort": "high",
        "agentThinking": "off",
        "agentToolSearch": "auto",
        "agentTurnIterationLimit": null,
        "lastAgentConvByProject": {BOOK: "conv-1"},
        "agentOnboardingStep": "done",
        "guidesSeen": ["workspace-tour"],
        "autoSnapshot": true,
        "sendCrashLogs": false
    })
}

/// The persisted shortcuts store: 0.1 keeps every binding.
pub fn shortcuts() -> Value {
    json!({
        "closeActiveTab": "Mod+W", "findInEditor": "Mod+,", "globalSearch": "Mod+Shift+F",
        "saveCurrentEditor": "Mod+Shift+S", "goBack": "Mod+]", "goForward": "Mod+[",
        "prevTab": "Mod+Alt+ArrowLeft", "nextTab": "Mod+Alt+ArrowRight",
        "toggleBottomTimeline": "Mod+Shift+J", "toggleImmersiveWriting": "Mod+Shift+Enter",
        "newEntity": "Mod+N", "closeProject": "Mod+Shift+W"
    })
}

/// Replaces the stamp's captured settings with `settings`, `shortcuts` and
/// the check-in switch (the stamp must exist: `build(true)`), and gives the
/// book `memory` as its working memory.
pub fn add(old: &Old, settings: &Value, shortcuts: &Value, checkin: bool, memory: Option<&str>) {
    let c = Connection::open(&old.db).unwrap();
    let raw: String = c
        .query_row(
            "SELECT value_json FROM library_state WHERE key = 'v2-handoff'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let mut stamp: Value = serde_json::from_str(&raw).unwrap();
    stamp["settings"]["entries"] = json!({
        "settings-storage": json!({"state": settings, "version": 37}).to_string(),
        "shortcuts-storage": json!({"state": {"bindings": shortcuts}, "version": 0}).to_string(),
        "project-checkin": json!({"state": {"enabled": checkin, "projects": {}}, "version": 2}).to_string(),
    });
    c.execute(
        "UPDATE library_state SET value_json = ?1 WHERE key = 'v2-handoff'",
        [stamp.to_string()],
    )
    .unwrap();
    if let Some(memory) = memory {
        c.execute(
            "INSERT INTO agent_working_memory (project_id, content_md, revision, approx_tokens, updated_by, last_compacted_at, deleted_at, created_at, updated_at) VALUES (?1, ?2, 4, 40, 'author', NULL, NULL, ?3, ?4)",
            params![BOOK, memory, T1, T2],
        )
        .unwrap();
    }
}
