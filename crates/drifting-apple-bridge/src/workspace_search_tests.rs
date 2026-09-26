use super::*;
use drifting_document::{Edit, NativeRange};
use std::collections::BTreeMap;

fn search(fixture: &Fixture, query: &str) -> Value {
    success(
        json!({"operation":"workspaceSearch","handle":fixture.workspace,
        "projectId":fixture.project,"query":query}),
    )
}

fn resolve_request(fixture: &Fixture, hit: &Value) -> Value {
    json!({"operation":"workspaceResolveSearchHit","handle":fixture.workspace,"hit":hit})
}

fn tables(database: &DatabaseGateway) -> BTreeMap<String, Vec<Vec<DatabaseValue>>> {
    database.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name".into(),
        vec![], None, CLIENT.into()).unwrap().rows.into_iter().map(|row| {
            let DatabaseValue::Text(name) = &row[0] else { panic!("table name") };
            let mut rows = database.query(format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")),
                vec![], None, CLIENT.into()).unwrap().rows;
            rows.sort_by_key(|row| serde_json::to_string(row).unwrap());
            (name.clone(), rows)
        }).collect()
}

#[test]
fn workspace_search_reads_live_and_cold_prose_without_writes_or_owner_changes() {
    let fixture = Fixture::new();
    let cold = fixture.open(0)["handle"].as_u64().unwrap();
    insert(cold, "冷藏航🙂");
    success(fixture.chapter_request("workspaceCloseChapter", 0));
    let live = fixture.open(1)["handle"].as_u64().unwrap();
    insert(live, "现稿");
    let database = gateway(live);
    execute(&database, "UPDATE node_content SET content_json='{}'");
    {
        let mut sessions = SESSIONS.get().unwrap().lock().unwrap();
        let owner = sessions.get_mut(&live).unwrap();
        let revision = owner.document.native_projection().unwrap().revision;
        owner
            .document
            .replace_native(NativeReplacement {
                revision,
                range: NativeRange {
                    location: 2,
                    length: 0,
                },
                text: "航🙂".into(),
            })
            .unwrap();
    }
    let before = tables(&database);
    let live_state = state(live);
    let result = search(&fixture, "航");
    assert_eq!(result["unavailable"], json!([]));
    assert_eq!(result["truncated"], false);
    let hits = result["hits"].as_array().unwrap();
    assert_eq!(
        hits.iter()
            .map(|hit| hit["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["title", "prose", "title", "prose"]
    );
    assert_eq!(hits[1]["match"]["matchedText"], "航");
    assert_eq!(hits[3]["preview"], "现稿航🙂");
    assert!(rejected(resolve_request(&fixture, &hits[1])).contains("先打开"));
    assert_eq!(
        success(resolve_request(&fixture, &hits[2]))["range"],
        Value::Null
    );
    assert_eq!(tables(&database), before);
    assert_eq!(state(live), live_state);
    assert_eq!(
        rejected(json!({"operation":"documentRead","handle":cold})),
        "Unknown or closed session"
    );
    let other = success(
        json!({"operation":"workspaceCreateProject","handle":fixture.workspace,"name":"另航"}),
    );
    assert_eq!(
        success(
            json!({"operation":"workspaceSearch","handle":fixture.workspace,
        "projectId":other["id"],"query":"航"})
        )["hits"],
        json!([])
    );
    assert!(rejected(
        json!({"operation":"workspaceSearch","handle":fixture.workspace,
        "projectId":"outside","query":"航"})
    )
    .contains("does not belong"));
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":live}))["projection"]["text"],
        "现稿"
    );
    fixture.close();
}

#[test]
fn workspace_search_resolves_cold_unicode_hits_in_live_owner_and_rejects_stale_hits() {
    let fixture = Fixture::new();
    let old = fixture.open(0)["handle"].as_u64().unwrap();
    insert(old, "甲İ🙂目标");
    success(fixture.chapter_request("workspaceCloseChapter", 0));
    let hit = search(&fixture, "i\u{307}🙂")["hits"][0].clone();
    assert_eq!(hit["match"]["matchedText"], "İ🙂");
    let live = fixture.open(0)["handle"].as_u64().unwrap();
    insert(live, "前🙂");
    let result = success(resolve_request(&fixture, &hit));
    assert_eq!(result["range"], json!({"location":4,"length":3}));
    assert_eq!(result["revision"], state(live)["projection"]["revision"]);
    let mut wrong_scope = hit.clone();
    wrong_scope["scope"]["incarnation"] = json!(99);
    assert!(rejected(resolve_request(&fixture, &wrong_scope)).contains("重新搜索"));
    let title = search(&fixture, "初航")["hits"][0].clone();
    success(
        json!({"operation":"workspaceRenameChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[0],"title":"改名"}),
    );
    assert!(rejected(resolve_request(&fixture, &title)).contains("标题已更改"));
    let before = state(live);
    success(json!({"operation":"documentReplace","handle":live,"edit":{
        "revision":before["projection"]["revision"],"range":{"location":4,"length":1},"text":"新"}}));
    assert!(rejected(resolve_request(&fixture, &hit)).contains("原文已更改"));
    let current = search(&fixture, "新🙂")["hits"][0].clone();
    let before_draft = state(live);
    success(
        json!({"operation":"documentBeginDraft","handle":live,"start":{
        "key":"search-pending","revision":before_draft["projection"]["revision"],
        "range":{"location":4,"length":0}}}),
    );
    assert!(rejected(resolve_request(&fixture, &current)).contains("完成或恢复"));
    success(json!({"operation":"documentCancelDraft","handle":live,"key":"search-pending"}));
    assert!(success(resolve_request(&fixture, &current))["range"].is_object());
    fixture.close();
}

#[test]
fn workspace_search_distinguishes_unavailable_prose_from_no_match() {
    let fixture = Fixture::new();
    let live = fixture.open(1)["handle"].as_u64().unwrap();
    insert(live, "当前正文");
    let database = gateway(live);
    let mut original = DocumentSession::new();
    original
        .edit(Edit::AppendParagraph {
            id: "p".into(),
            text: "旧段落".into(),
        })
        .unwrap();
    let mut checkpoint = DocumentSession::new();
    checkpoint
        .apply_remote(&original.update(None, 1).unwrap(), 1)
        .unwrap();
    checkpoint
        .format_native(NativeFormatting {
            revision: checkpoint.native_projection().unwrap().revision,
            range: NativeRange {
                location: 0,
                length: 0,
            },
            action: drifting_document::NativeFormatAction::Heading1,
        })
        .unwrap();
    let vector = original.state_vector();
    original
        .edit(Edit::Insert {
            block: "p".into(),
            offset: 0,
            text: "远".into(),
        })
        .unwrap();
    let document_id = format!("node-content:{}", fixture.chapters[0]);
    let repo = ProseRepository::new(&database, CLIENT);
    repo.save_snapshot(
        &document_id,
        &checkpoint.update(None, 1).unwrap(),
        "2026-09-26T00:00:00Z",
        None,
    )
    .unwrap();
    repo.append_update(
        &document_id,
        &original.update(Some(&vector), 1).unwrap(),
        &RevisionSource::Remote,
        "2026-09-26T00:00:00Z",
        None,
        None,
    )
    .unwrap();
    let before = tables(&database);
    let owner = state(live);
    let result = search(&fixture, "不会命中");
    assert_eq!(result["hits"], json!([]));
    assert_eq!(result["unavailable"].as_array().unwrap().len(), 1);
    assert_eq!(result["unavailable"][0]["chapterId"], fixture.chapters[0]);
    assert_eq!(
        search(&fixture, "  "),
        json!({"hits":[],"unavailable":[],"truncated":false})
    );
    assert_eq!(tables(&database), before);
    assert_eq!(state(live), owner);
    fixture.close();
}

#[test]
fn workspace_search_caps_results_and_reports_actual_truncation() {
    let fixture = Fixture::new();
    let live = fixture.open(0)["handle"].as_u64().unwrap();
    insert(live, &"针 ".repeat(100));
    let exact = search(&fixture, "针");
    assert_eq!(exact["hits"].as_array().unwrap().len(), 100);
    assert_eq!(exact["truncated"], false);
    insert(live, "针 ");
    let limited = search(&fixture, "针");
    assert_eq!(limited["hits"].as_array().unwrap().len(), 100);
    assert_eq!(limited["truncated"], true);
    assert_eq!(limited["unavailable"], json!([]));
    assert_eq!(search(&fixture, "无结果")["hits"], json!([]));
    fixture.close();
}
