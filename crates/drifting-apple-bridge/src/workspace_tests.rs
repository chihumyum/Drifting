//! Synthetic file-backed workspace acceptance through the public C ABI.
use super::*;

fn call(request: Value) -> Value {
    let input = CString::new(request.to_string()).unwrap();
    let result = unsafe { drifting_lab_call(input.as_ptr()) };
    let output = serde_json::from_slice(unsafe { CStr::from_ptr(result) }.to_bytes()).unwrap();
    unsafe { drifting_lab_free(result) };
    output
}

fn success(request: Value) -> Value {
    let response = call(request);
    assert_eq!(response["ok"], true, "{response}");
    response["value"].clone()
}

fn rejected(request: Value) -> String {
    let response = call(request);
    assert_eq!(response["ok"], false, "{response}");
    response["error"].as_str().unwrap().into()
}

struct Fixture {
    _temporary: tempfile::TempDir,
    directory: PathBuf,
    workspace: u64,
    project: String,
    chapters: [String; 2],
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join(CLIENT);
        let opened = success(json!({"operation":"workspaceOpen","directory":directory}));
        assert_eq!(opened["projects"], json!([]));
        let workspace = opened["handle"].as_u64().unwrap();
        let project = success(json!({
            "operation":"workspaceCreateProject","handle":workspace,"name":"合成写作项目"
        }))["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let chapters = ["初航", "归航"].map(|title| {
            success(
                json!({"operation":"workspaceCreateChapter","handle":workspace,
                "projectId":project,"title":title}),
            )["id"]
                .as_str()
                .unwrap()
                .to_owned()
        });
        Self {
            _temporary: temporary,
            directory,
            workspace,
            project,
            chapters,
        }
    }

    fn open(&self, index: usize) -> Value {
        success(
            json!({"operation":"workspaceOpenChapter","handle":self.workspace,
            "projectId":self.project,"chapterId":self.chapters[index]}),
        )
    }

    fn close(&self) {
        success(json!({"operation":"workspaceClose","handle":self.workspace}));
    }
}

fn state(handle: u64) -> Value {
    success(json!({"operation":"documentRead","handle":handle}))
}

fn insert(handle: u64, value: &str) -> Value {
    let current = state(handle);
    success(
        json!({"operation":"documentReplace","handle":handle,"edit":{
            "revision":current["projection"]["revision"],
            "range":{"location":0,"length":0},"text":value
        }}),
    )
}

fn gateway(handle: u64) -> DatabaseGateway {
    SESSIONS.get().unwrap().lock().unwrap()[&handle]
        .gateway
        .clone()
}

fn execute(gateway: &DatabaseGateway, sql: &str) {
    gateway
        .execute(sql.into(), vec![], None, CLIENT.into())
        .unwrap();
}

#[test]
fn workspace_two_chapters_edit_history_switch_and_cold_reopen() {
    let mut fixture = Fixture::new();
    let projects = success(json!({"operation":"workspaceProjects","handle":fixture.workspace}));
    assert_eq!(projects.as_array().unwrap().len(), 1);
    let chapters = success(
        json!({"operation":"workspaceChapters","handle":fixture.workspace,
        "projectId":fixture.project}),
    );
    assert_eq!(chapters.as_array().unwrap().len(), 2);
    assert_eq!(chapters[0]["title"], "初航");
    assert_eq!(chapters[1]["title"], "归航");
    assert_ne!(fixture.chapters[0], fixture.chapters[1]);
    let first = fixture.open(0);
    let first_handle = first["handle"].as_u64().unwrap();
    let first_block = first["document"]["projection"]["blocks"][0]["id"].clone();
    assert_eq!(first["document"]["projection"]["text"], "");
    assert_eq!(first["document"]["projection"]["canUndo"], false);
    assert_eq!(insert(first_handle, "初航🙂")["saved"], true);
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":first_handle}))["projection"]["text"],
        ""
    );
    assert_eq!(
        success(json!({"operation":"documentRedo","handle":first_handle}))["projection"]["text"],
        "初航🙂"
    );
    let second = fixture.open(1);
    let second_handle = second["handle"].as_u64().unwrap();
    assert_ne!(first_handle, second_handle);
    assert_ne!(
        first_block,
        second["document"]["projection"]["blocks"][0]["id"]
    );
    assert_eq!(second["document"]["projection"]["text"], "");
    rejected(json!({"operation":"documentRead","handle":first_handle}));
    assert_eq!(insert(second_handle, "归航👩🏽‍🚀")["saved"], true);
    let reopened =
        success(json!({"operation":"workspaceReopenChapter","handle":fixture.workspace}));
    assert_ne!(reopened["handle"], second_handle);
    assert_eq!(reopened["document"]["projection"]["text"], "归航👩🏽‍🚀");
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let first = fixture.open(0);
    assert_eq!(first["document"]["projection"]["text"], "初航🙂");
    assert_eq!(
        first["document"]["projection"]["blocks"][0]["id"],
        first_block
    );
    let second = fixture.open(1);
    assert_eq!(second["document"]["projection"]["text"], "归航👩🏽‍🚀");
    // Closing a borrowed document cannot close the workspace's shared gateway.
    success(json!({"operation":"close","handle":second["handle"]}));
    assert_eq!(
        success(json!({"operation":"workspaceProjects","handle":fixture.workspace}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    fixture.open(0);
    fixture.close();
}

#[test]
fn workspace_switch_and_close_preserve_active_draft_and_composition() {
    let fixture = Fixture::new();
    let handle = fixture.open(0)["handle"].as_u64().unwrap();
    insert(handle, "原稿");
    let before = state(handle);
    success(
        json!({"operation":"documentBeginDraft","handle":handle,"start":{
            "key":"composition","revision":before["projection"]["revision"],
            "range":{"location":0,"length":2}
        }}),
    );
    for request in [
        json!({"operation":"workspaceOpenChapter","handle":fixture.workspace,"projectId":fixture.project,"chapterId":fixture.chapters[1]}),
        json!({"operation":"workspaceReopenChapter","handle":fixture.workspace}),
        json!({"operation":"workspaceClose","handle":fixture.workspace}),
    ] {
        assert!(rejected(request).contains("draft"));
        assert_eq!(state(handle), before);
    }
    success(json!({"operation":"documentCommitDraft","handle":handle,
        "commit":{"key":"composition","text":"已提交🙂"}}));
    assert_eq!(state(handle)["projection"]["text"], "已提交🙂");
    success(json!({"operation":"documentInputFork","handle":handle,"key":"queue"}));
    success(json!({"operation":"documentInputFork","handle":handle,"key":"ime","source":"queue"}));
    assert!(rejected(
        json!({"operation":"workspaceOpenChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[1]})
    )
    .contains("draft"));
    success(json!({"operation":"documentInputDrop","handle":handle,"key":"ime"}));
    success(json!({"operation":"documentInputDrop","handle":handle,"key":"queue"}));
    fixture.open(1);
    assert_eq!(
        fixture.open(0)["document"]["projection"]["text"],
        "已提交🙂"
    );
    fixture.close();
}

#[test]
fn workspace_failed_save_and_target_load_keep_current_owner() {
    let fixture = Fixture::new();
    fixture.open(1);
    let handle = fixture.open(0)["handle"].as_u64().unwrap();
    let database = gateway(handle);
    execute(&database, "CREATE TRIGGER fail_workspace_save BEFORE INSERT ON sync_yjs_materialization_receipt BEGIN SELECT RAISE(ABORT, 'synthetic workspace save failure'); END");
    let pending = insert(handle, "未落库🙂");
    assert_eq!(pending["saved"], false);
    assert!(pending["saveError"]
        .as_str()
        .unwrap()
        .contains("synthetic workspace save failure"));
    rejected(
        json!({"operation":"workspaceOpenChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[1]}),
    );
    rejected(json!({"operation":"workspaceClose","handle":fixture.workspace}));
    assert_eq!(state(handle), pending);
    execute(&database, "DROP TRIGGER fail_workspace_save");
    assert_eq!(
        success(json!({"operation":"documentSave","handle":handle}))["saved"],
        true
    );
    // Inject an invalid target checkpoint in this synthetic DB. Opening it must
    // fail after the current chapter has safely saved, without dropping history.
    let document_id = format!("node-content:{}", fixture.chapters[1]);
    database
        .execute(
            "UPDATE yjs_snapshots SET state_blob = ? WHERE document_id = ?".into(),
            vec![DatabaseValue::Blob(vec![255]), text(&document_id)],
            None,
            CLIENT.into(),
        )
        .unwrap();
    let before = state(handle);
    rejected(
        json!({"operation":"workspaceOpenChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[1]}),
    );
    assert_eq!(state(handle), before);
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":handle}))["projection"]["text"],
        ""
    );
    assert_eq!(
        success(json!({"operation":"documentRedo","handle":handle}))["projection"]["text"],
        "未落库🙂"
    );
    fixture.close();
}

#[test]
fn workspace_fixture_database_and_workspace_owners_remain_separate() {
    let fixture = Fixture::new();
    let fixture_handle = success(json!({"operation":"open","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let workspace_handle = fixture.open(0)["handle"].as_u64().unwrap();
    insert(workspace_handle, "独立章节");
    assert!(state(fixture_handle)["projection"]["text"]
        .as_str()
        .unwrap()
        .contains("夜航"));
    assert_eq!(state(workspace_handle)["projection"]["text"], "独立章节");
    assert!(fixture.directory.join("native-lab.db").is_file());
    assert!(fixture
        .directory
        .join("apple-native-workspace.db")
        .is_file());
    assert!(
        rejected(json!({"operation":"workspaceOpen","directory":fixture.directory}))
            .contains("live owner")
    );
    success(json!({"operation":"close","handle":fixture_handle}));
    fixture.close();
}

fn seed_comment(database: &DatabaseGateway, project: &str, chapter: &str, block: &str, id: &str) {
    let anchor = json!({
        "textAnchor": {"startBlockId":block,"startOffset":0,
            "endBlockId":block,"endOffset":2,"text":"正文"},
        "selectedText":"正文", "syntheticMetadata":{"preserve":true}
    });
    database.execute(
        "INSERT INTO comment (id, project_id, target_kind, target_id, target_block_id, target_block_ids_json, anchor_json, body_json, created_at, updated_at) VALUES (?, ?, 'node', ?, ?, ?, ?, '{}', 'synthetic', 'synthetic')".into(),
        vec![text(id),text(project),text(chapter),text(block),text(&json!([block]).to_string()),text(&anchor.to_string())],
        None, CLIENT.into(),
    ).unwrap();
}

#[test]
fn workspace_comment_anchors_use_selected_project_and_chapter_scope() {
    let fixture = Fixture::new();
    let first = fixture.open(0);
    let first_handle = first["handle"].as_u64().unwrap();
    let first_block = first["document"]["projection"]["blocks"][0]["id"]
        .as_str()
        .unwrap();
    insert(first_handle, "正文甲");
    let database = gateway(first_handle);
    seed_comment(
        &database,
        &fixture.project,
        &fixture.chapters[0],
        first_block,
        "synthetic-comment-a",
    );
    let second = fixture.open(1);
    let second_handle = second["handle"].as_u64().unwrap();
    let second_block = second["document"]["projection"]["blocks"][0]["id"]
        .as_str()
        .unwrap();
    insert(second_handle, "正文乙");
    seed_comment(
        &database,
        &fixture.project,
        &fixture.chapters[1],
        second_block,
        "synthetic-comment-b",
    );
    let second_before =
        load_comments_for(&database, &fixture.project, &fixture.chapters[1]).unwrap();
    let first = fixture.open(0);
    let first_handle = first["handle"].as_u64().unwrap();
    let comments = first["document"]["projection"]["comments"]
        .as_array()
        .unwrap();
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0]["id"], "synthetic-comment-a");
    assert_eq!(comments[0]["ranges"], json!([{"location":0,"length":2}]));
    let edited = insert(first_handle, "前");
    assert_eq!(edited["saved"], true);
    assert_eq!(
        edited["projection"]["comments"][0]["ranges"],
        json!([{"location":1,"length":2}])
    );
    assert_eq!(
        load_comments_for(&database, &fixture.project, &fixture.chapters[1]).unwrap(),
        second_before
    );
    let persisted = load_comments_for(&database, &fixture.project, &fixture.chapters[0]).unwrap();
    let payload: Value = serde_json::from_str(&persisted[0].anchor_json).unwrap();
    assert_eq!(payload["syntheticMetadata"]["preserve"], true);
    let second = fixture.open(1);
    assert_eq!(
        second["document"]["projection"]["comments"][0]["id"],
        "synthetic-comment-b"
    );
    assert_eq!(
        second["document"]["projection"]["comments"][0]["ranges"],
        json!([{"location":0,"length":2}])
    );
    fixture.close();
}
