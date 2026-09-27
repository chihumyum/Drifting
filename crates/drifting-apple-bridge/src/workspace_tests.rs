//! Synthetic file-backed workspace acceptance through the public C ABI.
use super::*;
#[path = "workspace_act_tests.rs"]
mod acts;
#[path = "workspace_agent_tests.rs"]
mod agent_tests;
#[path = "workspace_category_tests.rs"]
mod category_tests;
#[path = "workspace_comment_tests.rs"]
mod comments;
#[path = "workspace_diagnostics_tests.rs"]
mod diagnostics_tests;
#[path = "workspace_drift_tests.rs"]
mod drifts;
#[path = "workspace_element_tests.rs"]
mod elements;
#[path = "workspace_history_tests.rs"]
mod history_tests;
#[path = "workspace_library_tests.rs"]
mod library_tests;
#[path = "workspace_link_tests.rs"]
mod links;
#[path = "workspace_metadata_tests.rs"]
mod metadata;
#[path = "workspace_metrics_tests.rs"]
mod metrics;
#[path = "workspace_outline_tests.rs"]
mod outline;
#[path = "workspace_patch_tests.rs"]
mod patch_tests;
#[path = "workspace_project_tests.rs"]
mod project_tests;
#[path = "workspace_purge_tests.rs"]
mod purge_tests;
#[path = "workspace_relation_tests.rs"]
mod relation_tests;
#[path = "workspace_remote_changes_tests.rs"]
mod remote_changes;
#[path = "workspace_remote_prose_tests.rs"]
mod remote_prose;
#[path = "workspace_search_tests.rs"]
mod search;
#[path = "workspace_search_entities_tests.rs"]
mod search_entities;
#[path = "workspace_storyline_tests.rs"]
mod storylines;
#[path = "workspace_tabs_tests.rs"]
mod tabs;
#[path = "workspace_timeline_tests.rs"]
mod timeline_tests;
#[path = "workspace_todo_tests.rs"]
mod todo_tests;
#[path = "workspace_transfer_tests.rs"]
mod transfer_tests;
#[path = "workspace_trash_tests.rs"]
mod trash;

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
        success(self.chapter_request("workspaceOpenChapter", index))
    }

    fn chapter_request(&self, operation: &str, index: usize) -> Value {
        json!({"operation":operation,"handle":self.workspace,
            "projectId":self.project,"chapterId":self.chapters[index]})
    }

    fn reopen(&self, index: usize) -> Value {
        success(self.chapter_request("workspaceReopenChapter", index))
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
    assert_eq!(state(first_handle)["projection"]["text"], "初航🙂");
    assert_eq!(insert(second_handle, "归航👩🏽‍🚀")["saved"], true);
    let reopened = fixture.reopen(1);
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
        fixture.chapter_request("workspaceReopenChapter", 0),
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
    success(fixture.chapter_request("workspaceCloseChapter", 1));
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
        load_comments_for(&database, &fixture.project, "node", &fixture.chapters[1]).unwrap();
    let first = fixture.reopen(0);
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
        load_comments_for(&database, &fixture.project, "node", &fixture.chapters[1]).unwrap(),
        second_before
    );
    let persisted =
        load_comments_for(&database, &fixture.project, "node", &fixture.chapters[0]).unwrap();
    let payload: Value = serde_json::from_str(&persisted[0].anchor_json).unwrap();
    assert_eq!(payload["syntheticMetadata"]["preserve"], true);
    let second = fixture.reopen(1);
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

#[test]
fn workspace_rename_preserves_selected_document_history_and_cold_metadata() {
    let mut fixture = Fixture::new();
    let opened = fixture.open(0);
    let handle = opened["handle"].as_u64().unwrap();
    let edited = insert(handle, "已有正文🙂");
    success(
        json!({"operation":"documentSelect","handle":handle,"selection":{
            "viewId":"selected-editor","epoch":1,"revision":edited["projection"]["revision"],
            "range":{"location":4,"length":2}
        }}),
    );
    let before = state(handle);
    let exported = success(json!({"operation":"documentExport","handle":handle}));
    let renamed_project = success(json!({
        "operation":"workspaceRenameProject","handle":fixture.workspace,
        "projectId":fixture.project,"name":"潮汐写作🙂"
    }));
    assert_eq!(renamed_project["id"], fixture.project);
    assert_eq!(renamed_project["name"], "潮汐写作🙂");
    let renamed_chapter = success(json!({
        "operation":"workspaceRenameChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[0],"title":"启航👩🏽‍🚀"
    }));
    assert_eq!(renamed_chapter["id"], fixture.chapters[0]);
    assert_eq!(renamed_chapter["title"], "启航👩🏽‍🚀");
    // Metadata commands must leave the same handle, projection, selection and
    // CRDT bytes intact, including the existing local undo stack.
    assert_eq!(state(handle), before);
    assert_eq!(
        success(json!({"operation":"documentExport","handle":handle})),
        exported
    );
    assert_eq!(
        insert(handle, "续写")["projection"]["text"],
        "续写已有正文🙂"
    );
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":handle}))["projection"]["text"],
        "已有正文🙂"
    );
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":handle}))["projection"]["text"],
        ""
    );
    success(json!({"operation":"documentRedo","handle":handle}));
    assert_eq!(
        success(json!({"operation":"documentRedo","handle":handle}))["projection"]["text"],
        "续写已有正文🙂"
    );
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let projects = success(json!({"operation":"workspaceProjects","handle":fixture.workspace}));
    assert_eq!(projects[0]["name"], "潮汐写作🙂");
    let chapters = success(
        json!({"operation":"workspaceChapters","handle":fixture.workspace,"projectId":fixture.project}),
    );
    assert_eq!(chapters[0]["title"], "启航👩🏽‍🚀");
    assert_eq!(chapters[1]["title"], "归航");
    let reopened = fixture.open(0);
    assert_eq!(reopened["document"]["projection"]["text"], "续写已有正文🙂");
    assert_eq!(
        reopened["document"]["projection"]["blocks"][0]["id"],
        opened["document"]["projection"]["blocks"][0]["id"]
    );
    fixture.close();
}

#[test]
fn workspace_rename_failure_rolls_back_metadata_and_preserves_live_owner() {
    let fixture = Fixture::new();
    let handle = fixture.open(0)["handle"].as_u64().unwrap();
    insert(handle, "保留草稿🙂");
    let other_project = success(json!({"operation":"workspaceCreateProject",
        "handle":fixture.workspace,"name":"另一个合成项目"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let before = state(handle);
    let projects_before =
        success(json!({"operation":"workspaceProjects","handle":fixture.workspace}));
    let chapters_before = success(
        json!({"operation":"workspaceChapters","handle":fixture.workspace,"projectId":fixture.project}),
    );
    let database = gateway(handle);
    let read_journal =
        || {
            database.query(
        "SELECT change_set_id, encoded_bytes FROM sync_change_set ORDER BY change_set_id".into(),
        vec![], None, CLIENT.into(),
    ).unwrap().rows
        };
    let read_clock =
        || {
            database.query(
        "SELECT * FROM sync_generation_writer_state ORDER BY sync_generation_id, writer_id".into(),
        vec![], None, CLIENT.into(),
    ).unwrap().rows
        };
    let journal_before = read_journal();
    let clock_before = read_clock();
    execute(&database, "CREATE TRIGGER fail_workspace_rename BEFORE INSERT ON sync_change_set BEGIN SELECT RAISE(ABORT, 'synthetic rename journal failure'); END");
    for request in [
        json!({"operation":"workspaceRenameProject","handle":fixture.workspace,"projectId":fixture.project,"name":"不应提交项目"}),
        json!({"operation":"workspaceRenameChapter","handle":fixture.workspace,"projectId":fixture.project,"chapterId":fixture.chapters[0],"title":"不应提交章节"}),
    ] {
        assert!(rejected(request).contains("synthetic rename journal failure"));
        assert_eq!(state(handle), before);
        assert_eq!(
            success(json!({"operation":"workspaceProjects","handle":fixture.workspace})),
            projects_before
        );
        assert_eq!(
            success(
                json!({"operation":"workspaceChapters","handle":fixture.workspace,"projectId":fixture.project})
            ),
            chapters_before
        );
        assert_eq!(read_journal(), journal_before);
        assert_eq!(read_clock(), clock_before);
    }
    execute(&database, "DROP TRIGGER fail_workspace_rename");
    rejected(
        json!({"operation":"workspaceRenameChapter","handle":fixture.workspace,
        "projectId":other_project,"chapterId":fixture.chapters[0],"title":"错误项目作用域"}),
    );
    rejected(
        json!({"operation":"workspaceRenameProject","handle":fixture.workspace,
        "projectId":"missing-project","name":"不存在的项目"}),
    );
    assert_eq!(read_journal(), journal_before);
    assert_eq!(read_clock(), clock_before);
    assert_eq!(state(handle), before);
    assert_eq!(
        success(json!({"operation":"workspaceProjects","handle":fixture.workspace})),
        projects_before
    );
    assert_eq!(
        success(
            json!({"operation":"workspaceChapters","handle":fixture.workspace,"projectId":fixture.project})
        ),
        chapters_before
    );
    success(
        json!({"operation":"workspaceRenameChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[0],"title":"恢复后重命名"}),
    );
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":handle}))["projection"]["text"],
        ""
    );
    assert_eq!(
        success(json!({"operation":"documentRedo","handle":handle}))["projection"]["text"],
        "保留草稿🙂"
    );
    fixture.close();
}

fn chapter_ids(chapters: &Value) -> Vec<&str> {
    chapters
        .as_array()
        .unwrap()
        .iter()
        .map(|chapter| chapter["id"].as_str().unwrap())
        .collect()
}

#[test]
fn workspace_move_preserves_selected_document_history_and_cold_order() {
    let mut fixture = Fixture::new();
    let opened = fixture.open(0);
    let handle = opened["handle"].as_u64().unwrap();
    let edited = insert(handle, "移动中的正文🙂");
    success(
        json!({"operation":"documentSelect","handle":handle,"selection":{
            "viewId":"moving-editor","epoch":1,"revision":edited["projection"]["revision"],
            "range":{"location":6,"length":2}
        }}),
    );
    let before = state(handle);
    let exported = success(json!({"operation":"documentExport","handle":handle}));
    for anchor in [None, Some(fixture.chapters[1].as_str()), None] {
        let moved = success(
            json!({"operation":"workspaceMoveChapter","handle":fixture.workspace,
            "projectId":fixture.project,"chapterId":fixture.chapters[0],"beforeChapterId":anchor}),
        );
        let expected = if anchor.is_none() {
            vec![fixture.chapters[1].as_str(), fixture.chapters[0].as_str()]
        } else {
            vec![fixture.chapters[0].as_str(), fixture.chapters[1].as_str()]
        };
        assert_eq!(chapter_ids(&moved), expected);
        assert_eq!(state(handle), before);
        assert_eq!(
            success(json!({"operation":"documentExport","handle":handle})),
            exported
        );
    }
    assert_eq!(
        insert(handle, "续写")["projection"]["text"],
        "续写移动中的正文🙂"
    );
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":handle}))["projection"]["text"],
        "移动中的正文🙂"
    );
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":handle}))["projection"]["text"],
        ""
    );
    success(json!({"operation":"documentRedo","handle":handle}));
    assert_eq!(
        success(json!({"operation":"documentRedo","handle":handle}))["projection"]["text"],
        "续写移动中的正文🙂"
    );
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let chapters = success(
        json!({"operation":"workspaceChapters","handle":fixture.workspace,"projectId":fixture.project}),
    );
    assert_eq!(
        chapter_ids(&chapters),
        vec![fixture.chapters[1].as_str(), fixture.chapters[0].as_str()]
    );
    let reopened = fixture.open(0);
    assert_eq!(
        reopened["document"]["projection"]["text"],
        "续写移动中的正文🙂"
    );
    assert_eq!(
        reopened["document"]["projection"]["blocks"][0]["id"],
        opened["document"]["projection"]["blocks"][0]["id"]
    );
    fixture.close();
}

#[test]
fn workspace_move_failure_and_invalid_anchor_preserve_order_and_live_owner() {
    let fixture = Fixture::new();
    let handle = fixture.open(0)["handle"].as_u64().unwrap();
    insert(handle, "不可丢失🙂");
    let other_project = success(
        json!({"operation":"workspaceCreateProject","handle":fixture.workspace,
        "name":"合成的其他项目"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let other_chapter = success(
        json!({"operation":"workspaceCreateChapter","handle":fixture.workspace,
        "projectId":other_project,"title":"其他项目章节"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let before = state(handle);
    let before_chapters = success(
        json!({"operation":"workspaceChapters","handle":fixture.workspace,
        "projectId":fixture.project}),
    );
    let database = gateway(handle);
    let sql = [
        "SELECT * FROM sync_order_register ORDER BY sync_generation_id,list_kind,owner_id,entity_id",
        "SELECT * FROM sync_field_clock ORDER BY sync_generation_id,target_kind,target_id,incarnation,field_key",
        "SELECT * FROM sync_generation_writer_state ORDER BY sync_generation_id,writer_id",
        "SELECT change_set_id,encoded_bytes FROM sync_change_set ORDER BY change_set_id",
        "SELECT id,book_order,updated_at FROM book_node ORDER BY id",
    ];
    let read_metadata = || {
        sql.iter()
            .map(|query| {
                database
                    .query((*query).into(), vec![], None, CLIENT.into())
                    .unwrap()
                    .rows
            })
            .collect::<Vec<_>>()
    };
    let metadata = read_metadata();
    execute(&database, "CREATE TRIGGER fail_workspace_move BEFORE INSERT ON sync_change_set BEGIN SELECT RAISE(ABORT, 'synthetic move journal failure'); END");
    assert!(rejected(
        json!({"operation":"workspaceMoveChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[0],"beforeChapterId":null})
    )
    .contains("synthetic move journal failure"));
    execute(&database, "DROP TRIGGER fail_workspace_move");
    assert_eq!(read_metadata(), metadata);
    assert_eq!(state(handle), before);
    for request in [
        json!({"operation":"workspaceMoveChapter","handle":fixture.workspace,
            "projectId":fixture.project,"chapterId":fixture.chapters[0],"beforeChapterId":"missing-chapter"}),
        json!({"operation":"workspaceMoveChapter","handle":fixture.workspace,
            "projectId":fixture.project,"chapterId":fixture.chapters[0],"beforeChapterId":other_chapter}),
        json!({"operation":"workspaceMoveChapter","handle":fixture.workspace,
            "projectId":other_project,"chapterId":fixture.chapters[0],"beforeChapterId":null}),
    ] {
        rejected(request);
        assert_eq!(read_metadata(), metadata);
        assert_eq!(state(handle), before);
        assert_eq!(
            success(
                json!({"operation":"workspaceChapters","handle":fixture.workspace,
            "projectId":fixture.project})
            ),
            before_chapters
        );
    }
    let moved = success(
        json!({"operation":"workspaceMoveChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[0],"beforeChapterId":null}),
    );
    assert_eq!(
        chapter_ids(&moved),
        vec![fixture.chapters[1].as_str(), fixture.chapters[0].as_str()]
    );
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":handle}))["projection"]["text"],
        ""
    );
    assert_eq!(
        success(json!({"operation":"documentRedo","handle":handle}))["projection"]["text"],
        "不可丢失🙂"
    );
    fixture.close();
}

fn format_document(handle: u64, action: &str, range: Value) -> Value {
    let current = state(handle);
    success(json!({"operation":"documentFormat","handle":handle,"edit":{
        "revision":current["projection"]["revision"],"range":range,"action":action
    }}))
}

fn all_runs_have_mark(projection: &Value, mark: &str) -> bool {
    projection["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|block| {
            block["runs"]
                .as_array()
                .unwrap()
                .iter()
                .all(|run| run["attributes"].as_object().unwrap().contains_key(mark))
        })
}

#[test]
fn workspace_formatting_preserves_multiblock_text_history_and_cold_marks() {
    let mut fixture = Fixture::new();
    let handle = fixture.open(0)["handle"].as_u64().unwrap();
    let text = "正文甲🙂\n正文乙👩🏽‍🚀";
    let initial = insert(handle, text);
    assert_eq!(initial["projection"]["blocks"].as_array().unwrap().len(), 2);
    let range = json!({"location":0,"length":text.encode_utf16().count()});
    let bold = format_document(handle, "bold", range.clone());
    assert_eq!(bold["saved"], true);
    assert_eq!(bold["projection"]["text"], text);
    assert!(all_runs_have_mark(&bold["projection"], "bold"));
    let undone = success(json!({"operation":"documentUndo","handle":handle}));
    assert_eq!(
        undone["projection"]["blocks"],
        initial["projection"]["blocks"]
    );
    let redone = success(json!({"operation":"documentRedo","handle":handle}));
    assert_eq!(redone["projection"]["blocks"], bold["projection"]["blocks"]);
    let heading = format_document(handle, "heading2", range);
    assert_eq!(heading["saved"], true);
    assert_eq!(heading["projection"]["text"], text);
    for block in heading["projection"]["blocks"].as_array().unwrap() {
        assert_eq!(block["kind"], "heading");
        assert_eq!(block["attributes"]["level"], 2);
    }
    assert!(all_runs_have_mark(&heading["projection"], "bold"));
    let undone = success(json!({"operation":"documentUndo","handle":handle}));
    assert_eq!(undone["projection"]["blocks"], bold["projection"]["blocks"]);
    let redone = success(json!({"operation":"documentRedo","handle":handle}));
    assert_eq!(
        redone["projection"]["blocks"],
        heading["projection"]["blocks"]
    );
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let chapters = success(
        json!({"operation":"workspaceChapters","handle":fixture.workspace,
        "projectId":fixture.project}),
    );
    assert_eq!(chapters[0]["title"], "初航");
    let reopened = fixture.open(0);
    assert_eq!(reopened["document"]["projection"]["text"], text);
    assert_eq!(
        reopened["document"]["projection"]["blocks"],
        heading["projection"]["blocks"]
    );
    fixture.close();
}

#[test]
fn workspace_formatting_rejection_preserves_input_and_save_failure_retries_once() {
    let fixture = Fixture::new();
    let handle = fixture.open(0)["handle"].as_u64().unwrap();
    insert(handle, "原稿🙂");
    success(json!({"operation":"documentInputFork","handle":handle,"key":"format-queue"}));
    let before = state(handle);
    for edit in [
        json!({"revision":before["projection"]["revision"].as_u64().unwrap()+1,
            "range":{"location":0,"length":2},"action":"bold"}),
        json!({"revision":before["projection"]["revision"],
            "range":{"location":0,"length":2},"action":"unsupported-format"}),
        json!({"revision":before["projection"]["revision"],
            "range":{"location":0,"length":0},"action":"italic"}),
    ] {
        assert!(
            rejected(json!({"operation":"documentFormat","handle":handle,"edit":edit}))
                .starts_with("NATIVE_FORMATTING_UNAVAILABLE:")
        );
        assert_eq!(state(handle), before);
    }
    // The same already-forked input base remains usable after each rejection.
    let queued = success(
        json!({"operation":"documentInputReplace","handle":handle,"edit":{
            "key":"format-queue","sequence":0,"range":{"location":0,"length":0},"text":"续"
        }}),
    );
    assert_eq!(queued["state"]["projection"]["text"], "续原稿🙂");
    success(
        json!({"operation":"documentInputFork","handle":handle,"key":"format-ime","source":"format-queue"}),
    );
    let before = state(handle);
    assert!(rejected(json!({"operation":"documentFormat","handle":handle,"edit":{
        "revision":before["projection"]["revision"],"range":{"location":0,"length":2},"action":"bold"
    }})).starts_with("NATIVE_FORMATTING_UNAVAILABLE:"));
    assert_eq!(state(handle), before);
    success(json!({"operation":"documentInputDrop","handle":handle,"key":"format-ime"}));
    success(json!({"operation":"documentInputDrop","handle":handle,"key":"format-queue"}));
    success(
        json!({"operation":"documentBeginDraft","handle":handle,"start":{
            "key":"format-draft","revision":before["projection"]["revision"],"range":{"location":0,"length":1}
        }}),
    );
    assert!(rejected(json!({"operation":"documentFormat","handle":handle,"edit":{
        "revision":before["projection"]["revision"],"range":{"location":0,"length":2},"action":"bold"
    }})).starts_with("NATIVE_FORMATTING_UNAVAILABLE:"));
    success(json!({"operation":"documentCancelDraft","handle":handle,"key":"format-draft"}));
    let database = gateway(handle);
    let counts = || {
        database.query(
        "SELECT (SELECT count(*) FROM sync_change_set),(SELECT count(*) FROM sync_yjs_materialization_receipt)".into(),
        vec![], None, CLIENT.into(),
    ).unwrap().rows
    };
    let counts_before = counts();
    execute(&database, "CREATE TRIGGER fail_format_receipt BEFORE INSERT ON sync_yjs_materialization_receipt BEGIN SELECT RAISE(ABORT, 'synthetic format receipt failure'); END");
    let pending = format_document(handle, "bold", json!({"location":0,"length":3}));
    assert_eq!(pending["saved"], false);
    assert!(pending["saveError"]
        .as_str()
        .unwrap()
        .contains("synthetic format receipt failure"));
    assert_eq!(pending["projection"]["text"], "续原稿🙂");
    assert_eq!(counts(), counts_before);
    assert!(rejected(json!({"operation":"documentFormat","handle":handle,"edit":{
        "revision":pending["projection"]["revision"],"range":{"location":0,"length":3},"action":"bold"
    }})).starts_with("NATIVE_FORMATTING_UNAVAILABLE:"));
    assert_eq!(state(handle), pending);
    execute(&database, "DROP TRIGGER fail_format_receipt");
    let saved = success(json!({"operation":"documentSave","handle":handle}));
    assert_eq!(saved["saved"], true);
    // Publishing the committed event through replay may advance the session
    // revision. The complete display/history/selection projection stays exact.
    assert!(
        saved["projection"]["revision"].as_u64().unwrap()
            >= pending["projection"]["revision"].as_u64().unwrap()
    );
    let mut expected_projection = pending["projection"].clone();
    expected_projection["revision"] = saved["projection"]["revision"].clone();
    assert_eq!(saved["projection"], expected_projection);
    let counts_after = counts();
    for index in 0..2 {
        let number = |rows: &Vec<Vec<DatabaseValue>>| match &rows[0][index] {
            DatabaseValue::Integer(value) => value.parse::<u64>().unwrap(),
            _ => panic!("Expected an integer count"),
        };
        assert_eq!(number(&counts_after), number(&counts_before) + 1);
    }
    success(json!({"operation":"documentSave","handle":handle}));
    assert_eq!(counts(), counts_after);
    let reopened = fixture.reopen(0);
    assert_eq!(
        reopened["document"]["projection"]["text"],
        saved["projection"]["text"]
    );
    assert_eq!(
        reopened["document"]["projection"]["blocks"],
        saved["projection"]["blocks"]
    );
    fixture.close();
}
