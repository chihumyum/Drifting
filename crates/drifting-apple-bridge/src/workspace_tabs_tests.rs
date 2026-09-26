use super::*;
use drifting_document::NativeRange;

fn chapter_outline(fixture: &Fixture, index: usize) -> Value {
    success(fixture.chapter_request("workspaceChapterOutline", index))
}

#[test]
fn workspace_tabs_reuse_each_chapter_owner_and_independent_history() {
    let fixture = Fixture::new();
    let a = fixture.open(0)["handle"].as_u64().unwrap();
    insert(a, "甲🙂");
    let b = fixture.open(1)["handle"].as_u64().unwrap();
    insert(b, "乙章");
    let a_before = state(a);
    let b_before = state(b);
    assert_eq!(fixture.open(0)["handle"], a);
    assert_eq!(fixture.open(1)["handle"], b);
    assert_eq!(state(a), a_before);
    assert_eq!(state(b), b_before);
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":a}))["projection"]["text"],
        ""
    );
    assert_eq!(state(b), b_before);
    assert_eq!(fixture.open(0)["handle"], a);
    assert_eq!(
        success(json!({"operation":"documentRedo","handle":a}))["projection"]["text"],
        "甲🙂"
    );
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":b}))["projection"]["text"],
        ""
    );
    assert_eq!(state(a)["projection"]["text"], "甲🙂");
    success(json!({"operation":"documentRedo","handle":b}));

    // A cached owner cannot bypass a later lifecycle/scope change.
    let database = gateway(a);
    let before = state(a);
    database.execute(
        "UPDATE sync_entity_lifecycle SET incarnation=incarnation+1 WHERE entity_kind='node' AND entity_id=?".into(),
        vec![text(&fixture.chapters[0])], None, CLIENT.into(),
    ).unwrap();
    assert!(rejected(fixture.chapter_request("workspaceOpenChapter", 0)).contains("scope changed"));
    assert_eq!(state(a), before);
    assert_eq!(state(b)["projection"]["text"], "乙章");
    database.execute(
        "UPDATE sync_entity_lifecycle SET incarnation=incarnation-1 WHERE entity_kind='node' AND entity_id=?".into(),
        vec![text(&fixture.chapters[0])], None, CLIENT.into(),
    ).unwrap();
    fixture.close();
}

#[test]
fn workspace_tabs_close_one_owner_preserves_other_live_outline_and_writes() {
    let fixture = Fixture::new();
    let a = fixture.open(0)["handle"].as_u64().unwrap();
    insert(a, "甲章");
    format_document(a, "heading1", json!({"location":0,"length":0}));
    let b = fixture.open(1)["handle"].as_u64().unwrap();
    insert(b, "乙章");
    format_document(b, "heading2", json!({"location":0,"length":0}));
    // Both non-selected and selected live owners must supply their live outline,
    // including an actual captured edit not yet passed to the persistence seam.
    {
        let mut sessions = SESSIONS.get().unwrap().lock().unwrap();
        let owner = sessions.get_mut(&a).unwrap();
        let revision = owner.document.native_projection().unwrap().revision;
        owner
            .document
            .replace_native(NativeReplacement {
                revision,
                range: NativeRange {
                    location: 2,
                    length: 0,
                },
                text: "尚未保存".into(),
            })
            .unwrap();
    }
    assert_eq!(chapter_outline(&fixture, 0)[0]["text"], "甲章尚未保存");
    assert_eq!(chapter_outline(&fixture, 1)[0]["text"], "乙章");
    let b_before = state(b);
    let mut wrong = fixture.chapter_request("workspaceCloseChapter", 0);
    wrong["projectId"] = json!("foreign-project");
    rejected(wrong);
    assert_eq!(state(b), b_before);
    success(fixture.chapter_request("workspaceCloseChapter", 0));
    rejected(json!({"operation":"documentRead","handle":a}));
    assert_eq!(state(b), b_before);
    assert_eq!(insert(b, "继续")["saved"], true);
    assert_eq!(chapter_outline(&fixture, 1)[0]["text"], "继续乙章");
    let reopened = fixture.open(0);
    let next_a = reopened["handle"].as_u64().unwrap();
    assert_ne!(next_a, a);
    assert_eq!(reopened["document"]["projection"]["text"], "甲章尚未保存");
    // Direct document close removes exactly its registry key and keeps the
    // workspace's shared gateway and every other chapter usable.
    success(json!({"operation":"close","handle":next_a}));
    rejected(fixture.chapter_request("workspaceCloseChapter", 0));
    assert_eq!(insert(b, "再")["saved"], true);
    assert_ne!(fixture.open(0)["handle"], next_a);
    fixture.close();
}

#[test]
fn workspace_tabs_failed_close_and_reopen_retain_all_owners_for_retry() {
    let mut fixture = Fixture::new();
    let a = fixture.open(0)["handle"].as_u64().unwrap();
    insert(a, "甲");
    let b = fixture.open(1)["handle"].as_u64().unwrap();
    insert(b, "乙");
    let requests = [
        fixture.chapter_request("workspaceCloseChapter", 1),
        fixture.chapter_request("workspaceReopenChapter", 1),
        fixture.chapter_request("workspaceOpenChapter", 0),
        json!({"operation":"workspaceClose","handle":fixture.workspace}),
    ];
    let a_before = state(a);
    let b_before = state(b);
    success(json!({"operation":"documentBeginDraft","handle":b,"start":{
        "key":"tab-draft","revision":b_before["projection"]["revision"],
        "range":{"location":0,"length":1}
    }}));
    for request in &requests {
        assert!(rejected(request.clone()).contains("draft"));
        assert_eq!(state(a), a_before);
        assert_eq!(state(b), b_before);
    }
    success(json!({"operation":"documentCancelDraft","handle":b,"key":"tab-draft"}));
    success(json!({"operation":"documentInputFork","handle":b,"key":"tab-input"}));
    success(
        json!({"operation":"documentInputFork","handle":b,"key":"tab-ime","source":"tab-input"}),
    );
    for request in &requests {
        assert!(rejected(request.clone()).contains("draft"));
    }
    success(json!({"operation":"documentInputDrop","handle":b,"key":"tab-ime"}));
    success(json!({"operation":"documentInputDrop","handle":b,"key":"tab-input"}));

    let database = gateway(a);
    let counts = || {
        database.query(
        "SELECT (SELECT count(*) FROM sync_change_set),(SELECT count(*) FROM sync_yjs_materialization_receipt)".into(),
        vec![], None, CLIENT.into(),
    ).unwrap().rows
    };
    let counts_before = counts();
    execute(&database, "CREATE TRIGGER fail_tab_receipt BEFORE INSERT ON sync_yjs_materialization_receipt BEGIN SELECT RAISE(ABORT, 'synthetic tab receipt failure'); END");
    let pending = insert(b, "待保存🙂");
    assert_eq!(pending["saved"], false);
    assert_eq!(counts(), counts_before);
    for request in &requests {
        assert!(rejected(request.clone()).contains("Unsaved"));
        assert_eq!(state(a), a_before);
        assert_eq!(state(b), pending);
        assert_eq!(counts(), counts_before);
    }
    execute(&database, "DROP TRIGGER fail_tab_receipt");
    assert_eq!(
        success(json!({"operation":"documentSave","handle":b}))["saved"],
        true
    );
    let counts_after = counts();
    for column in 0..2 {
        let count = |rows: &[Vec<DatabaseValue>]| match &rows[0][column] {
            DatabaseValue::Integer(value) => value.parse::<u64>().unwrap(),
            _ => panic!("integer count"),
        };
        assert_eq!(count(&counts_after), count(&counts_before) + 1);
    }
    success(json!({"operation":"documentSave","handle":b}));
    assert_eq!(counts(), counts_after);
    assert_eq!(fixture.open(0)["handle"], a);
    assert_eq!(fixture.open(1)["handle"], b);
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":b}))["projection"]["text"],
        "乙"
    );
    success(json!({"operation":"documentRedo","handle":b}));
    insert(a, "继续");
    let a_after = state(a);
    let reopened = fixture.reopen(1);
    assert_ne!(reopened["handle"], b);
    rejected(json!({"operation":"documentRead","handle":b}));
    assert_eq!(state(a), a_after);
    assert_eq!(reopened["document"]["projection"]["text"], "待保存🙂乙");
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    assert_eq!(fixture.open(0)["document"]["projection"]["text"], "继续甲");
    assert_eq!(
        fixture.open(1)["document"]["projection"]["text"],
        "待保存🙂乙"
    );
    fixture.close();
}
